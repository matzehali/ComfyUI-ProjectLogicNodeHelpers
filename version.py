"""Tag-based version string for the Project Logic nodes.

Reads the latest git tag directly from the repo's ``.git`` directory without
spawning a subprocess, mirroring the versioning approach used by the LTX
Custom MLX nodes. Falls back to ``FALLBACK_VERSION`` when no tag is found.
"""

from __future__ import annotations

from pathlib import Path
import re
import zlib


FALLBACK_VERSION = "v0.1.0"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _repo_git_dir(repo_root: Path) -> Path | None:
    git_path = repo_root / ".git"
    if git_path.is_dir():
        return git_path
    if not git_path.is_file():
        return None
    try:
        content = _read_text(git_path)
    except OSError:
        return None
    prefix = "gitdir:"
    if not content.lower().startswith(prefix):
        return None
    path = Path(content[len(prefix):].strip())
    if not path.is_absolute():
        path = repo_root / path
    return path


def _head_commit(git_dir: Path) -> str | None:
    try:
        head = _read_text(git_dir / "HEAD")
    except OSError:
        return None
    ref_prefix = "ref:"
    if not head.startswith(ref_prefix):
        return head
    ref_path = git_dir / head[len(ref_prefix):].strip()
    try:
        return _read_text(ref_path)
    except OSError:
        return None


def _deref_tag_object(git_dir: Path, sha: str) -> str:
    """Resolve an annotated-tag object SHA to the commit it points at."""
    obj_path = git_dir / "objects" / sha[:2] / sha[2:]
    try:
        raw = zlib.decompress(obj_path.read_bytes())
    except (OSError, zlib.error):
        return sha
    null_pos = raw.find(b"\0")
    if null_pos < 0:
        return sha
    if not raw[:null_pos].startswith(b"tag "):
        return sha  # already a commit object (lightweight tag)
    for line in raw[null_pos + 1:].split(b"\n"):
        if line.startswith(b"object "):
            return line[7:].decode("ascii").strip()
    return sha


def _tag_commits(git_dir: Path) -> dict[str, str]:
    tags: dict[str, str] = {}

    refs_dir = git_dir / "refs" / "tags"
    if refs_dir.is_dir():
        for path in refs_dir.rglob("*"):
            if path.is_file():
                try:
                    sha = _read_text(path)
                    tags[path.relative_to(refs_dir).as_posix()] = _deref_tag_object(git_dir, sha)
                except OSError:
                    continue

    packed_refs = git_dir / "packed-refs"
    if packed_refs.is_file():
        try:
            lines = _read_text(packed_refs).splitlines()
        except OSError:
            lines = []
        last_tag: str | None = None
        for line in lines:
            if not line or line.startswith("#"):
                continue
            if line.startswith("^"):
                if last_tag is not None:
                    tags[last_tag] = line[1:].strip()
                last_tag = None
                continue
            last_tag = None
            try:
                sha, ref = line.split(" ", 1)
            except ValueError:
                continue
            prefix = "refs/tags/"
            if ref.startswith(prefix):
                tag_name = ref[len(prefix):]
                tags.setdefault(tag_name, _deref_tag_object(git_dir, sha))
                last_tag = tag_name
    return tags


def _tag_sort_key(tag: str) -> tuple[int, tuple[int, ...], str]:
    match = re.fullmatch(r"v?(\d+(?:\.\d+)*)", tag)
    if match:
        return (1, tuple(int(part) for part in match.group(1).split(".")), tag)
    return (0, (), tag)


def _git_node_version() -> str:
    repo_root = Path(__file__).resolve().parent
    git_dir = _repo_git_dir(repo_root)
    if git_dir is None:
        return FALLBACK_VERSION
    tags = _tag_commits(git_dir)
    if not tags:
        return FALLBACK_VERSION
    tag = max(tags, key=_tag_sort_key)
    if _head_commit(git_dir) == tags[tag]:
        return tag
    return f"{tag}-dirty"


NODE_VERSION = _git_node_version()


def versioned_display_name(name: str) -> str:
    """Append the resolved git tag version to a display name."""
    return f"{name} {NODE_VERSION}"
