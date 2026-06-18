"""ComfyUI-projectlogic node definitions.

Three nodes:

* ``ProjectLogic``         – the hub: project folder + shot + plate clip + seed +
                             configurable pass lines -> one ``PROJECT_LOGIC`` bundle.
* ``ProjectLogicExtract``  – takes the bundle, selects a pass via dropdown, and
                             emits ready-to-wire directory / filename / sequence
                             path / ext / frame count (one noodle in).
* ``ProjectLogicPathSplit``– generic helper: any path string -> dir/filename/ext.

The heavy/dynamic UI (folder-scan dropdowns, add/remove pass rows) lives in
``web/js/projectlogic.js``; the Python side stays usable with plain text fields.
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


NODE_CLASS_MAPPINGS = {
    "ProjectLogic": ProjectLogic,
    "ProjectLogicExtract": ProjectLogicExtract,
    "ProjectLogicPathSplit": ProjectLogicPathSplit,
}
