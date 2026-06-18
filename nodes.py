"""ComfyUI-projectlogic node definitions.

Nodes:

* ``ProjectLogic``            – the hub: project folder + shot + plate clip + seed +
                               configurable pass lines -> one ``PROJECT_LOGIC`` bundle.
                               Also broadcasts its config so consumers can rebuild the
                               bundle without a wire (only one hub per workflow).
* ``ProjectLogicExtract``     – selects a configured pass (dropdown auto-filled from
                               the project) and emits full_path / pathtofile / file /
                               framecount / seed.
* ``ProjectLogicRouterMaster``– broadcast selector: sets the active pass type for a
                               ``router_id`` (no output noodles).
* ``ProjectLogicRouterSlave`` – follower mux: routes the labelled input matching the
                               master's active type to its output.
* ``ProjectLogicPreview``     – shows the resolved bundle inline on the node.

Consumers accept either a wired ``PROJECT_LOGIC`` input or the broadcast config the
JS layer mirrors in from the single hub, which they rebuild locally.

The dynamic UI lives in ``web/js/``; the Python side stays usable with plain fields.
"""

from __future__ import annotations

import json
import os

from .paths import (
    DEFAULT_TEMPLATE,
    OUTPUT_TEMPLATE,
    count_sequence,
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
                "global_seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "tooltip": "Global seed embedded into final output filenames ({seed} token)."}),
                "default_template": ("STRING", {"default": DEFAULT_TEMPLATE, "tooltip": "Default path layout. Tokens: {root} {shot} {type} {ext} {seed}; #### = frame padding."}),
                "output_template": ("STRING", {"default": OUTPUT_TEMPLATE, "tooltip": "Final-output layout (own subfolder, includes {seed})."}),
            },
            "optional": {
                "plate_clip": ("STRING", {"default": "", "tooltip": "Main base clip inside the shot folder (sequence pattern or movie). Relative to the shot folder unless absolute."}),
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
        fc = entry.get("frame_count")
        if fc is None:
            _, fc = count_sequence(seq)

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
    """Master selector. Picks the active pass type for a given ``router_id``.

    Has no outputs: it drives followers (ProjectLogicRouterSlave) sharing the same
    ``router_id`` purely through the frontend broadcast layer. Use different
    ``router_id`` values to run independent router groups in one graph.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "router_id": ("STRING", {"default": "main", "tooltip": "Followers with the same router_id track this selection."}),
                "active": ("STRING", {"default": "base", "tooltip": "Active pass type (dropdown from the project's passes)."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def noop(self, router_id="main", active="base"):
        return {"ui": {"active": [active], "router_id": [router_id]}}


# --------------------------------------------------------------------------- #
# Node 4 — Router Slave (follower mux: many ANY inputs -> the active one)
# --------------------------------------------------------------------------- #

class ProjectLogicRouterSlave:
    """Routes one of its labelled inputs to the output based on the active pass.

    The JS layer renames each input slot to a project pass type, so an input
    connected to the active pass arrives in ``kwargs`` keyed by that type name.
    ``active_type`` is kept in sync with the ProjectLogicRouterMaster sharing
    this node's ``router_id``.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_SWITCH_INPUTS + 1):
            optional[f"input_{i}"] = (ANY,)
        return {
            "required": {
                # Fresh slaves start unconnected ("NaN") so they never accidentally
                # share a default id with a newly created master.
                "router_id": ("STRING", {"default": "NaN"}),
                "active_type": ("STRING", {"default": ""}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("out",)
    FUNCTION = "route"
    CATEGORY = CATEGORY

    def route(self, router_id="main", active_type="", **kwargs):
        # Slots are renamed to pass types, so the active input arrives by name.
        if active_type and kwargs.get(active_type) is not None:
            return (kwargs[active_type],)
        for v in kwargs.values():  # fall back to the first connected input
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

        lines = [
            f"root: {bundle.get('root', '')}",
            f"shot: {bundle.get('shot', '')}   seed: {bundle.get('seed', '')}",
            "",
        ]
        for name, p in bundle.get("passes", {}).items():
            extra = f"   frames={p['frame_count']}" if "frame_count" in p else ""
            lines.append(f"[{name}]{extra}")
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


NODE_CLASS_MAPPINGS = {
    "ProjectLogic": ProjectLogic,
    "ProjectLogicExtract": ProjectLogicExtract,
    "ProjectLogicRouterMaster": ProjectLogicRouterMaster,
    "ProjectLogicRouterSlave": ProjectLogicRouterSlave,
    "ProjectLogicPreview": ProjectLogicPreview,
    "PackNoodles": PackNoodles,
    "UnpackNoodles": UnpackNoodles,
}
