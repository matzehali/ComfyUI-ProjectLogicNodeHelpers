"""ComfyUI-projectlogic node definitions.

Nodes:

* ``ProjectLogic``            – the hub: project folder + shot + plate clip + seed +
                               configurable pass lines -> one ``PROJECT_LOGIC`` bundle.
* ``ProjectLogicExtract``     – takes the bundle, selects a pass via dropdown, and
                               emits ready-to-wire directory / filename / sequence
                               path / ext / frame count (one noodle in).
* ``ProjectLogicPathSplit``   – generic helper: any path string -> dir/filename/ext.
* ``ProjectLogicRouterMaster``– broadcast selector: sets the active pass type for a
                               ``router_id`` (no output noodles).
* ``ProjectLogicRouterSlave`` – follower mux: routes the labelled input matching the
                               master's active type to its output.
* ``ProjectLogicPreview``     – formatted text dump of a bundle for a Display node.

The dynamic UI (folder-scan dropdowns, pass-row editor, router slot labels +
broadcast) lives in ``web/js/``; the Python side stays usable with plain fields.
"""

from __future__ import annotations

import json

from .paths import (
    COMMON_EXTS,
    COMMON_TYPES,
    DEFAULT_TEMPLATE,
    KINDS,
    OUTPUT_TEMPLATE,
    count_sequence,
    render_template,
    split_path,
)

CATEGORY = "projectlogic"

MAX_SWITCH_INPUTS = 16


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
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "tooltip": "Seed embedded into final output filenames."}),
                "default_template": ("STRING", {"default": DEFAULT_TEMPLATE, "tooltip": "Default path layout. Tokens: {root} {shot} {type} {ext} {seed}; #### = frame padding."}),
                "output_template": ("STRING", {"default": OUTPUT_TEMPLATE, "tooltip": "Final-output layout (own subfolder, includes {seed})."}),
            },
            "optional": {
                "plate_clip": ("STRING", {"default": "", "tooltip": "Main base clip inside the shot folder (sequence pattern or movie). Relative to the shot folder unless absolute."}),
                # Managed by the JS pass-line editor; JSON list of pass configs.
                "passes_json": ("STRING", {"default": _DEFAULT_PASSES, "multiline": True}),
            },
        }

    RETURN_TYPES = ("PROJECT_LOGIC",)
    RETURN_NAMES = ("project",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # paths/counts depend on disk; always re-evaluate.

    def build(self, project_path, shot, seed, default_template, output_template,
              plate_clip="", passes_json=_DEFAULT_PASSES):
        import os

        root = (project_path or "").rstrip("/\\")
        shot = (shot or "").strip()
        shot_dir = os.path.join(root, shot) if root and shot else (root or shot)

        passes: dict[str, dict] = {}

        # Configured pass lines ------------------------------------------------
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

        # Always-present final output -----------------------------------------
        passes["output"] = _pass_entry(
            output_template, root, shot, "output", "exr", seed, "sequence"
        )

        # Plate / base clip ----------------------------------------------------
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

        bundle = {
            "root": root,
            "shot": shot,
            "shot_dir": shot_dir,
            "seed": int(seed),
            "default_template": default_template,
            "output_template": output_template,
            "passes": passes,
        }
        return (bundle,)


# --------------------------------------------------------------------------- #
# Node 2 — the extractor / selector ("one noodle in front of the node")
# --------------------------------------------------------------------------- #

class ProjectLogicExtract:
    @classmethod
    def INPUT_TYPES(cls):
        pass_options = COMMON_TYPES[:-1] + ["plate", "output", "custom"]  # drop "none"
        return {
            "required": {
                "project": ("PROJECT_LOGIC",),
                "pass_name": (pass_options, {"default": "base"}),
            },
            "optional": {
                "custom_pass": ("STRING", {"default": "", "tooltip": "Used when pass_name = custom."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "INT")
    RETURN_NAMES = ("directory", "filename", "sequence_path", "ext", "frame_count")
    FUNCTION = "extract"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def extract(self, project, pass_name, custom_pass=""):
        if not isinstance(project, dict):
            raise ValueError("ProjectLogicExtract: 'project' input is not a PROJECT_LOGIC bundle.")

        name = (custom_pass or "").strip() if pass_name == "custom" else pass_name
        passes = project.get("passes", {})
        entry = passes.get(name)

        if entry is None:
            # Unknown pass: compute on the fly from the default template.
            entry = _pass_entry(
                project.get("default_template", DEFAULT_TEMPLATE),
                project.get("root", ""),
                project.get("shot", ""),
                name,
                "exr",
                project.get("seed", 0),
                "sequence",
            )

        seq_path = entry.get("sequence_path", "")
        frame_count = entry.get("frame_count")
        if frame_count is None:
            _, frame_count = count_sequence(seq_path)

        return (
            entry.get("directory", ""),
            entry.get("filename", ""),
            seq_path,
            entry.get("ext", ""),
            int(frame_count or 0),
        )


# --------------------------------------------------------------------------- #
# Node 3 — generic path splitter
# --------------------------------------------------------------------------- #

class ProjectLogicPathSplit:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {"default": "", "tooltip": "Any file path; #### patterns are preserved."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "INT")
    RETURN_NAMES = ("directory", "filename", "filename_ext", "ext", "frame_count")
    FUNCTION = "split"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def split(self, path):
        directory, filename_ext, stem, ext = split_path(path)
        _, frame_count = count_sequence(path)
        return (directory, stem, filename_ext, ext, int(frame_count))


# --------------------------------------------------------------------------- #
# Node 4 — Router Master (broadcast control, no output noodles)
# --------------------------------------------------------------------------- #

class ProjectLogicRouterMaster:
    """Master selector. Picks the active pass type for a given ``router_id``.

    Has no outputs: it drives followers (ProjectLogicRouterSlave) sharing the same
    ``router_id`` purely through the frontend broadcast layer. Use different
    ``router_id`` values to run independent switch groups in one graph.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "router_id": ("STRING", {"default": "main", "tooltip": "Followers with the same router_id track this selection."}),
                "active": ("STRING", {"default": "base", "tooltip": "Active pass type (dropdown populated from a connected Project Logic node)."}),
            },
            "optional": {
                "project": ("PROJECT_LOGIC", {"tooltip": "Optional: populates the dropdown with this bundle's pass types."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def noop(self, router_id="main", active="base", project=None):
        # All routing happens client-side; nothing to compute here.
        return {"ui": {"active": [active], "router_id": [router_id]}}


# --------------------------------------------------------------------------- #
# Node 5 — Router Slave (follower mux: many ANY inputs -> the active one)
# --------------------------------------------------------------------------- #

class ProjectLogicRouterSlave:
    """Routes one of its labelled inputs to the output based on the active pass.

    The labels for ``input_1..input_N`` come from the connected Project Logic
    passes (managed in JS via ``slot_types``); ``active_type`` is kept in sync
    with the ProjectLogicRouterMaster that shares this node's ``router_id``.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {"project": ("PROJECT_LOGIC",)}
        for i in range(1, MAX_SWITCH_INPUTS + 1):
            optional[f"input_{i}"] = (ANY,)
        return {
            "required": {
                "router_id": ("STRING", {"default": "main"}),
                # JS-managed; hidden in the UI.
                "slot_types": ("STRING", {"default": "[]"}),
                "active_type": ("STRING", {"default": ""}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("out",)
    FUNCTION = "route"
    CATEGORY = CATEGORY

    def route(self, router_id="main", slot_types="[]", active_type="", project=None, **kwargs):
        try:
            types = json.loads(slot_types)
            if not isinstance(types, list):
                types = []
        except (ValueError, TypeError):
            types = []

        val = None
        if active_type and active_type in types:
            val = kwargs.get(f"input_{types.index(active_type) + 1}")
        if val is None:  # fall back to the first connected input
            for i in range(1, MAX_SWITCH_INPUTS + 1):
                v = kwargs.get(f"input_{i}")
                if v is not None:
                    val = v
                    break
        return (val,)


# --------------------------------------------------------------------------- #
# Node 6 — Bundle preview (formatted text for a Display node)
# --------------------------------------------------------------------------- #

class ProjectLogicPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("PROJECT_LOGIC",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "preview"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def preview(self, project):
        if not isinstance(project, dict):
            text = "(not a PROJECT_LOGIC bundle)"
            return {"ui": {"text": [text]}, "result": (text,)}

        lines = [
            f"root: {project.get('root', '')}",
            f"shot: {project.get('shot', '')}   seed: {project.get('seed', '')}",
            "",
        ]
        for name, p in project.get("passes", {}).items():
            extra = f"   frames={p['frame_count']}" if "frame_count" in p else ""
            lines.append(f"[{name}]{extra}")
            lines.append(f"  seq : {p.get('sequence_path', '')}")
            lines.append(f"  dir : {p.get('directory', '')}")
            lines.append(f"  file: {p.get('filename', '')}  (.{p.get('ext', '')})")
        text = "\n".join(lines)
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {
    "ProjectLogic": ProjectLogic,
    "ProjectLogicExtract": ProjectLogicExtract,
    "ProjectLogicPathSplit": ProjectLogicPathSplit,
    "ProjectLogicRouterMaster": ProjectLogicRouterMaster,
    "ProjectLogicRouterSlave": ProjectLogicRouterSlave,
    "ProjectLogicPreview": ProjectLogicPreview,
}
