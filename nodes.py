"""ComfyUI-projectlogic node definitions.

Nodes:

* ``ProjectLogic``            – the hub: project folder + shot + plate clip + seed +
                               configurable pass lines -> one ``PROJECT_LOGIC`` bundle.
                               Also broadcasts its config so consumers can rebuild the
                               bundle without a wire (only one hub per workflow).
* ``ProjectLogicExtract``     – selects a configured pass (dropdown auto-filled from
                               the project) and emits full_path / pathtofile / file /
                               framecount / seed.
* ``ProjectLogicRouterMaster``– broadcast selector: defines its own ordered list of
                               switch values and sets the active one (no output noodles).
* ``ProjectLogicRouterSlave`` – follower mux: labels/orders its inputs from the master's
                               option list and routes the one matching the active value.
* ``ProjectLogicPreview``     – shows the resolved bundle inline on the node.

Consumers accept either a wired ``PROJECT_LOGIC`` input or the broadcast config the
JS layer mirrors in from the single hub, which they rebuild locally.

The dynamic UI lives in ``web/js/``; the Python side stays usable with plain fields.
"""

from __future__ import annotations

import json
import os

from .paths import (
    _SEQ_FILE_RE,
    DEFAULT_TEMPLATE,
    OUTPUT_TEMPLATE,
    count_sequence,
    frame_count_for,
    render_template,
    split_path,
)

CATEGORY = "projectlogic"

MAX_SWITCH_INPUTS = 16
MAX_GROUP_SLOTS = 16
GROUP_TYPE = "PL_GROUP"

# Hub config keys read from the submitted prompt to rebuild the bundle.
CONFIG_FIELDS = (
    "project_path", "shot", "global_seed",
    "default_template", "output_template", "plate_clip", "passes_json",
)


class _AnyType(str):
    """Type sentinel that compares equal to every other type ("*")."""

    def __eq__(self, other):  # noqa: D401 - matches ComfyUI convention
        return True

    def __ne__(self, other):
        return False

    __hash__ = str.__hash__


ANY = _AnyType("*")

_DEFAULT_PASSES = json.dumps(
    [
        {"type": "base", "ext": "exr", "kind": "sequence", "own_subfolder": True, "template": ""},
        {"type": "mask", "ext": "exr", "kind": "sequence", "own_subfolder": True, "template": ""},
        {"type": "depthmap", "ext": "exr", "kind": "sequence", "own_subfolder": True, "template": ""},
    ]
)


def _pass_entry(template, root, shot, type_, ext, seed, kind):
    """Render one pass and return its split components as a dict."""
    full = render_template(
        template, root=root, shot=shot, type=type_, ext=ext, seed=seed, kind=kind
    )
    directory, filename_ext, stem, real_ext = split_path(full)
    return {
        "type": type_,
        "directory": directory,
        "filename": stem,            # saver-ready: no extension, keeps ####
        "filename_ext": filename_ext,
        "sequence_path": full,       # loader-ready: full path incl. ext
        "ext": real_ext or ext,
        "kind": kind,
    }


def build_bundle(project_path="", shot="", global_seed=0,
                 default_template=DEFAULT_TEMPLATE, output_template=OUTPUT_TEMPLATE,
                 plate_clip="", passes_json=_DEFAULT_PASSES):
    """Build the PROJECT_LOGIC bundle from raw config.

    Shared by the hub node and by consumers rebuilding from a broadcast config.
    """
    seed = int(global_seed or 0)
    root = (project_path or "").rstrip("/\\")
    shot = (shot or "").strip()
    shot_dir = os.path.join(root, shot) if root and shot else (root or shot)

    passes: dict[str, dict] = {}

    try:
        lines = json.loads(passes_json) if passes_json else []
    except (ValueError, TypeError):
        lines = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        type_ = (line.get("type") or "").strip()
        if type_ == "custom":
            type_ = (line.get("custom") or "").strip()
        if not type_ or type_ == "none":
            continue
        ext = (line.get("ext") or "exr").strip()
        kind = (line.get("kind") or "sequence").strip()
        template = (line.get("template") or "").strip() or default_template
        passes[type_] = _pass_entry(template, root, shot, type_, ext, seed, kind)

    passes["output"] = _pass_entry(
        output_template, root, shot, "output", "exr", seed, "sequence"
    )

    plate_clip = (plate_clip or "").strip()
    if plate_clip:
        plate_seq = plate_clip if os.path.isabs(plate_clip) else os.path.join(shot_dir, plate_clip)
    else:
        plate_seq = ""
    _, plate_count = count_sequence(plate_seq)
    p_dir, p_fileext, p_stem, p_ext = split_path(plate_seq)
    passes["plate"] = {
        "type": "plate",
        "directory": p_dir,
        "filename": p_stem,
        "filename_ext": p_fileext,
        "sequence_path": plate_seq,
        "ext": p_ext,
        "kind": "movie" if (p_ext.lower() in ("mov", "mp4", "mkv", "avi", "mxf")) else "sequence",
        "frame_count": plate_count,
    }

    return {
        "root": root,
        "shot": shot,
        "shot_dir": shot_dir,
        "seed": seed,
        "default_template": default_template,
        "output_template": output_template,
        "passes": passes,
    }


def base_frame_count(bundle):
    """The project's single length, read from the base clip (plate, else 'base').

    All passes are created at this length, so it drives every framecount. Any
    model-length padding is done downstream with math nodes.
    """
    passes = bundle.get("passes", {})
    src = passes.get("plate") or {}
    if not src.get("sequence_path"):
        src = passes.get("base") or {}
    return frame_count_for(src.get("sequence_path", ""), src.get("kind", "sequence"))


def _prompt_field(prompt, ins, name):
    """Read a hub field value from the submitted prompt.

    Widget values come through directly; a wired input is a ``[node_id, slot]``
    link, which we resolve by reading the first string value off the upstream
    node (covers string/primitive source nodes).
    """
    v = ins.get(name)
    if isinstance(v, list) and len(v) == 2:
        up = prompt.get(str(v[0])) or prompt.get(v[0])
        if isinstance(up, dict):
            for val in (up.get("inputs") or {}).values():
                if isinstance(val, str):
                    return val
        return None
    return v


def _bundle_from_prompt(prompt):
    """Find the single ProjectLogic node in the prompt and build its bundle."""
    if not isinstance(prompt, dict):
        return None
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == "ProjectLogic":
            ins = node.get("inputs", {}) or {}
            cfg = {}
            for k in CONFIG_FIELDS:
                val = _prompt_field(prompt, ins, k)
                if val is not None:
                    cfg[k] = val
            return build_bundle(**cfg)
    return None


def _pass_for(bundle, name):
    """Look up a pass in the bundle, computing it on the fly if not configured."""
    entry = bundle.get("passes", {}).get(name)
    if entry is None:
        entry = _pass_entry(
            bundle.get("default_template", DEFAULT_TEMPLATE),
            bundle.get("root", ""),
            bundle.get("shot", ""),
            name, "exr", bundle.get("seed", 0), "sequence",
        )
    return entry


# --------------------------------------------------------------------------- #
# Node 1 — the hub
# --------------------------------------------------------------------------- #

class ProjectLogic:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_path": ("STRING", {"default": "", "tooltip": "VFX root folder containing shot subfolders."}),
                "shot": ("STRING", {"default": "", "tooltip": "Shot name / number (subfolder of project_path)."}),
                # ComfyUI hard-codes the INT control widget's value to "fixed"
                # (the node-def request is ignored for INT, and the widget is
                # never serialized), so the JS layer flips it to "randomize" on
                # creation. True here just gives the widget its proper label.
                "global_seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "tooltip": "Global seed embedded into final output filenames ({seed} token)."}),
                "default_template": ("STRING", {"default": DEFAULT_TEMPLATE, "tooltip": "Default path layout. Tokens: {root} {shot} {type} {ext} {seed}; #### = frame padding."}),
                "output_template": ("STRING", {"default": OUTPUT_TEMPLATE, "tooltip": "Final-output layout (own subfolder, includes {seed})."}),
            },
            "optional": {
                "plate_clip": ("STRING", {"default": "", "tooltip": "Main base clip inside the shot folder (sequence pattern or movie). Its length drives every framecount."}),
                # Single-line + JS-hidden; the pass-line editor is the real UI.
                "passes_json": ("STRING", {"default": _DEFAULT_PASSES}),
            },
        }

    # No output noodle: consumers read the config via the JS broadcast.
    RETURN_TYPES = ()
    FUNCTION = "build"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def build(self, project_path, shot, global_seed, default_template,
              output_template, plate_clip="", passes_json=_DEFAULT_PASSES):
        return {"ui": {}}


# --------------------------------------------------------------------------- #
# Node 2 — the extractor (pass dropdown auto-filled from the project)
# --------------------------------------------------------------------------- #

class ProjectLogicExtract:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Populated in JS from the project's configured passes.
                "pass_name": ("STRING", {"default": "base"}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("full_path", "pathtofile", "file", "framecount", "seed")
    FUNCTION = "extract"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def extract(self, pass_name, prompt=None):
        bundle = _bundle_from_prompt(prompt)
        if bundle is None:
            raise ValueError(
                "ProjectLogicExtract: no Project Logic node found in the workflow."
            )

        entry = _pass_for(bundle, pass_name)
        seq = entry.get("sequence_path", "")
        # Length is the project's single base length (drives all passes), padded
        # to the configured model needs.
        fc = base_frame_count(bundle)

        return (
            seq,                          # full_path  (loader-ready, incl. ext)
            entry.get("directory", ""),   # pathtofile (folder)
            entry.get("filename", ""),    # file       (saver-ready stem, no ext, with ####)
            int(fc or 0),                 # framecount
            int(bundle.get("seed", 0)),   # seed
        )


# --------------------------------------------------------------------------- #
# Node 3 — Router Master (broadcast control, no output noodles)
# --------------------------------------------------------------------------- #

class ProjectLogicRouterMaster:
    """Master selector. Picks the active value from its own switch-option list.

    Identity is the node's own id (stable, unique); ``label`` is a free, editable
    title (duplicates allowed). Slaves reference the id, not the label, so renaming
    never breaks the link. The switch values are defined here in ``options_json``
    (an ordered list, edited via the JS options editor) — slaves label and order
    their inputs from it. Drives followers purely via the frontend broadcast layer.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "label": ("STRING", {"default": "", "tooltip": "Editable title for this router (duplicates OK). Slaves link by the node's unique id, not this."}),
                "active": ("STRING", {"default": "", "tooltip": "Active switch value (dropdown from this router's options)."}),
                # JS-managed ordered list of switch values; the options editor is
                # the real UI. Slaves mirror this for their input labels/order.
                "options_json": ("STRING", {"default": "[\"ON\", \"OFF\"]"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def noop(self, label="", active="", options_json="[]"):
        return {"ui": {"active": [active]}}


# --------------------------------------------------------------------------- #
# Node 4 — Router Slave (follower mux: many ANY inputs -> the active one)
# --------------------------------------------------------------------------- #

class ProjectLogicRouterSlave:
    """Routes one of its labelled inputs to the output based on the active pass.

    Input slots keep stable names (``input_1..input_N``, matching INPUT_TYPES so
    links survive save/load) and are *labelled* with the pass type in JS.
    ``slot_types`` carries the slot->type order so Python can route by active type.
    ``master`` shows the chosen master's title; ``router_id`` stores that master's
    unique node id (the real link); ``active_type`` mirrors the master's selection.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_SWITCH_INPUTS + 1):
            optional[f"input_{i}"] = (ANY,)
        return {
            "required": {
                # master: visible title picker (JS combo). The rest are JS-managed
                # and hidden. Fresh slaves start unconnected.
                "master": ("STRING", {"default": ""}),
                "router_id": ("STRING", {"default": ""}),
                "active_type": ("STRING", {"default": ""}),
                "slot_types": ("STRING", {"default": "[]"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("out",)
    FUNCTION = "route"
    CATEGORY = CATEGORY

    def route(self, master="", router_id="", active_type="", slot_types="[]", **kwargs):
        try:
            types = json.loads(slot_types)
            if not isinstance(types, list):
                types = []
        except (ValueError, TypeError):
            types = []

        if active_type and active_type in types:
            v = kwargs.get(f"input_{types.index(active_type) + 1}")
            if v is not None:
                return (v,)
        for i in range(1, MAX_SWITCH_INPUTS + 1):  # fall back to first connected
            v = kwargs.get(f"input_{i}")
            if v is not None:
                return (v,)
        return (None,)


# --------------------------------------------------------------------------- #
# Node 5 — Bundle preview (shown inline on the node by the JS layer)
# --------------------------------------------------------------------------- #

class ProjectLogicPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "preview"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def preview(self, prompt=None):
        bundle = _bundle_from_prompt(prompt)
        if bundle is None:
            text = "(no project — add a Project Logic node)"
            return {"ui": {"text": [text]}, "result": (text,)}

        try:
            length = f"base frames: {base_frame_count(bundle)}"
        except RuntimeError:
            length = "base frames: ? (install ffmpeg)"

        lines = [
            f"root: {bundle.get('root', '')}",
            f"shot: {bundle.get('shot', '')}   seed: {bundle.get('seed', '')}",
            length,
            "",
        ]
        for name, p in bundle.get("passes", {}).items():
            lines.append(f"[{name}]  ({p.get('kind', 'sequence')})")
            lines.append(f"  seq : {p.get('sequence_path', '')}")
            lines.append(f"  dir : {p.get('directory', '')}")
            lines.append(f"  file: {p.get('filename', '')}  (.{p.get('ext', '')})")
        text = "\n".join(lines)
        return {"ui": {"text": [text]}, "result": (text,)}


# --------------------------------------------------------------------------- #
# Node 6 / 7 — Pack / Unpack (carry several labelled noodles on one wire)
# --------------------------------------------------------------------------- #

class PackNoodles:
    """Bundle several labelled ANY inputs into one ``PL_GROUP`` noodle.

    Labels (one per input slot) are managed in JS — typed manually or, with
    ``auto_label``, derived from each connected source's type. The bundle carries
    ``{labels, values}`` so an Unpack node can restore named outputs, even after
    being routed through a Router Slave.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_GROUP_SLOTS + 1):
            optional[f"in_{i}"] = (ANY,)
        return {
            "required": {
                "auto_label": ("BOOLEAN", {"default": True, "tooltip": "Label each input from the connected source's type."}),
                "labels_json": ("STRING", {"default": "[]"}),  # JS-managed
            },
            "optional": optional,
        }

    RETURN_TYPES = (GROUP_TYPE,)
    RETURN_NAMES = ("group",)
    FUNCTION = "pack"
    CATEGORY = CATEGORY

    def pack(self, auto_label=True, labels_json="[]", **kwargs):
        try:
            labels = json.loads(labels_json)
        except (ValueError, TypeError):
            labels = []
        if not isinstance(labels, list):
            labels = []

        values = []
        for i, lbl in enumerate(labels):
            # JS renames slots to labels; fall back to the positional name.
            v = kwargs.get(lbl)
            if v is None:
                v = kwargs.get(f"in_{i + 1}")
            values.append(v)
        return ({"labels": labels, "values": values},)


class UnpackNoodles:
    """Restore the labelled noodles from a ``PL_GROUP`` bundle.

    Output slots are renamed (in JS) to the bundle's labels — read upstream at
    edit time and refreshed from the actual bundle after a run.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"group": (GROUP_TYPE,)}}

    RETURN_TYPES = tuple(ANY for _ in range(MAX_GROUP_SLOTS))
    RETURN_NAMES = tuple(f"out_{i}" for i in range(1, MAX_GROUP_SLOTS + 1))
    FUNCTION = "unpack"
    CATEGORY = CATEGORY

    def unpack(self, group=None):
        labels, values = [], []
        if isinstance(group, dict):
            labels = group.get("labels") or []
            values = group.get("values") or []
        out = list(values)[:MAX_GROUP_SLOTS]
        out += [None] * (MAX_GROUP_SLOTS - len(out))
        return {"ui": {"labels": [labels]}, "result": tuple(out)}


# --------------------------------------------------------------------------- #
# Node 8 — SelectPath (native OS file/folder picker -> string)
# --------------------------------------------------------------------------- #

def _replace_frame_number(path: str, style: str) -> str:
    """Swap a single file's frame number (last digit block before the extension).

    ``style`` is ``"####"`` (same count of ``#``, e.g. ``shot.0042.exr`` ->
    ``shot.####.exr``) or ``"*"`` (a single ``*``, e.g. ``shot.*.exr``). Any
    other value, or a name with no digit block right before the extension, is
    returned unchanged. Reuses the pack's sequence convention (``_SEQ_FILE_RE``)
    so the output stays consistent with scan_sequences / count_sequence.
    """
    if not path or style not in ("####", "*"):
        return path
    directory, base = os.path.split(path)
    m = _SEQ_FILE_RE.match(base)
    if not m:
        return path
    prefix, digits, ext = m.groups()
    token = "#" * len(digits) if style == "####" else "*"
    return os.path.join(directory, f"{prefix}{token}{ext}")


class ProjectLogicSelectPath:
    """Pick a path with the native OS dialog (Browse button) and output it."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {"default": "", "tooltip": "Selected path (set by Browse, or typed)."}),
                "mode": (["folder", "file"], {"default": "folder"}),
                "sequence_pattern": (["off", "####", "*"], {
                    "default": "off",
                    "tooltip": (
                        "File mode only: replace the frame number (last digit block before the "
                        "extension). '####' keeps the padding as # of matching width (e.g. "
                        "shot.0042.exr -> shot.####.exr); '*' uses a single * (e.g. shot.*.exr)."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    FUNCTION = "get_path"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def get_path(self, path, mode="folder", sequence_pattern="off"):
        if mode == "file":
            path = _replace_frame_number(path, sequence_pattern)
        return (path,)


NODE_CLASS_MAPPINGS = {
    "ProjectLogic": ProjectLogic,
    "ProjectLogicExtract": ProjectLogicExtract,
    "ProjectLogicSelectPath": ProjectLogicSelectPath,
    "ProjectLogicRouterMaster": ProjectLogicRouterMaster,
    "ProjectLogicRouterSlave": ProjectLogicRouterSlave,
    "ProjectLogicPreview": ProjectLogicPreview,
    "PackNoodles": PackNoodles,
    "UnpackNoodles": UnpackNoodles,
}
