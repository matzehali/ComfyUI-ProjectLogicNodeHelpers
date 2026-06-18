"""Pure path / sequence helpers for ComfyUI-projectlogic.

Deliberately free of any ComfyUI / torch imports so the logic can be unit
tested with a plain ``python`` interpreter. Everything here is string and
filesystem manipulation.

The canonical render convention (default template) is::

    {root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}

Tokens understood by :func:`render_template`:
    {root} {shot} {type} {ext} {seed}
The literal ``####`` (any run of ``#``) is kept as the frame-number padding
placeholder for image sequences and removed for movie outputs.
"""

from __future__ import annotations

import glob
import os
import re

# --------------------------------------------------------------------------- #
# Templates / vocab shared with the node layer
# --------------------------------------------------------------------------- #

DEFAULT_TEMPLATE = "{root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}"
# Final output always lives in its own subfolder and carries the seed.
OUTPUT_TEMPLATE = "{root}/{shot}/{shot}_output/{shot}_output.{seed}.####.{ext}"

COMMON_TYPES = [
    "base", "mask", "depthmap", "normals", "motion",
    "matte", "beauty", "cryptomatte",
    "PlateA", "PlateB", "PlateC",
    "custom", "none",
]
COMMON_EXTS = ["exr", "png", "jpg", "tiff", "webp", "mov", "mp4"]
KINDS = ["sequence", "movie"]

MOVIE_EXTS = {".mov", ".mp4", ".mkv", ".avi", ".mxf"}
_FRAME_RE = re.compile(r"#+")
_SEQ_FILE_RE = re.compile(r"^(.*?)(\d+)(\.[^.]+)$")


# --------------------------------------------------------------------------- #
# Template rendering
# --------------------------------------------------------------------------- #

def _collapse_slashes(path: str) -> str:
    """Collapse accidental double slashes without touching a ``scheme://``."""
    return re.sub(r"(?<!:)//+", "/", path)


def render_template(
    template: str,
    *,
    root: str,
    shot: str,
    type: str,
    ext: str = "exr",
    seed: int = 0,
    kind: str = "sequence",
) -> str:
    """Resolve ``template`` into a concrete path string.

    For ``kind == "movie"`` the ``####`` frame placeholder (and any single
    adjacent ``.``/``_`` separator) is stripped, yielding a single-file path.
    """
    root = (root or "").rstrip("/\\")
    out = (
        (template or DEFAULT_TEMPLATE)
        .replace("{root}", root)
        .replace("{shot}", shot or "")
        .replace("{type}", type or "")
        .replace("{ext}", ext or "")
        .replace("{seed}", str(seed))
    )
    if kind == "movie":
        out = re.sub(r"[._]?#+", "", out)
    return _collapse_slashes(out)


# --------------------------------------------------------------------------- #
# Path splitting
# --------------------------------------------------------------------------- #

def split_path(full_path: str):
    """Return ``(directory, filename_ext, stem, ext)``.

    * ``directory``    – folder containing the file.
    * ``filename_ext`` – full basename incl. extension (e.g. ``shot_base.####.exr``).
    * ``stem``         – basename without the extension (e.g. ``shot_base.####``);
                         this is what the CoCo SaverNode wants for ``filename``
                         since it appends the extension itself via ``file_type``.
    * ``ext``          – extension without the leading dot (e.g. ``exr``).
    """
    if not full_path:
        return "", "", "", ""
    directory = os.path.dirname(full_path)
    filename_ext = os.path.basename(full_path)
    stem, ext = os.path.splitext(filename_ext)
    return directory, filename_ext, stem, ext.lstrip(".")


# --------------------------------------------------------------------------- #
# Sequence counting (count only — no start/end range, per spec)
# --------------------------------------------------------------------------- #

def count_sequence(seq_path: str):
    """Count files matching a ``####`` pattern on disk.

    Returns ``(seq_path, count)``. If the path has no ``#`` it is treated as a
    single file (count 1 if it exists, else 0).
    """
    if not seq_path:
        return "", 0
    if "#" not in seq_path:
        return seq_path, (1 if os.path.isfile(seq_path) else 0)

    glob_pat = _FRAME_RE.sub("*", seq_path)
    # Validation regex: each '#' run becomes one-or-more digits, rest literal.
    # (Escape the literal segments first — re.escape also escapes '#', so we
    # split on the frame runs *before* escaping.)
    validate = re.compile(
        "^" + r"\d+".join(re.escape(part) for part in _FRAME_RE.split(seq_path)) + "$"
    )
    matches = [m for m in glob.glob(glob_pat) if validate.match(m)]
    return seq_path, len(matches)


# --------------------------------------------------------------------------- #
# Folder / sequence scanning (used by the JS dropdowns via server routes)
# --------------------------------------------------------------------------- #

def scan_subfolders(path: str):
    """Immediate visible subdirectory names of ``path`` (sorted)."""
    if not path or not os.path.isdir(path):
        return []
    return sorted(
        d for d in os.listdir(path)
        if not d.startswith(".") and os.path.isdir(os.path.join(path, d))
    )


def scan_sequences(folder: str, recursive: bool = True):
    """Detect image sequences and movie files under ``folder``.

    Image sequences are collapsed to a ``####`` pattern (padding inferred from
    the digit run). Movies are listed as-is. Paths are returned relative to
    ``folder`` so they can be joined onto a shot directory later.
    """
    if not folder or not os.path.isdir(folder):
        return []

    results: set[str] = set()
    walker = os.walk(folder) if recursive else [(folder, [], os.listdir(folder))]
    for root_dir, _dirs, files in walker:
        rel_dir = os.path.relpath(root_dir, folder)
        for f in files:
            if f.startswith("."):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext in MOVIE_EXTS:
                rel = f if rel_dir == "." else os.path.join(rel_dir, f)
                results.add(rel)
                continue
            m = _SEQ_FILE_RE.match(f)
            if m:
                prefix, digits, e = m.groups()
                pattern = f"{prefix}{'#' * len(digits)}{e}"
                rel = pattern if rel_dir == "." else os.path.join(rel_dir, pattern)
                results.add(rel)
    return sorted(results)
