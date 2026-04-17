"""File discovery and filtering for workspace indexing.

Iterates workspace roots, applies .hermesignore patterns (via pathspec),
skips binary files and files over the size limit.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterator

from workspace.constants import BINARY_SUFFIXES, HERMESIGNORE_NAME
from workspace.config import WorkspaceConfig
from workspace.types import WorkspaceRoot

log = logging.getLogger(__name__)


def iter_workspace_files(
    config: WorkspaceConfig,
) -> Iterator[tuple[str, Path]]:
    """Yield (root_path, file_path) for every indexable file across all roots.

    The primary workspace root is always included.  Additional roots come
    from config.knowledgebase.roots.
    """
    max_bytes = config.knowledgebase.indexing.max_file_mb * 1024 * 1024

    all_roots = [
        WorkspaceRoot(path=str(config.workspace_root), recursive=True),
        *config.knowledgebase.roots,
    ]

    for root_spec in all_roots:
        root = Path(root_spec.path).expanduser().resolve()
        if not root.is_dir():
            log.warning("Workspace root does not exist: %s", root)
            continue

        ignore_spec = _load_hermesignore(root)

        if root_spec.recursive:
            it = root.rglob("*")
        else:
            it = root.iterdir()

        for p in sorted(it):
            if not p.is_file():
                continue
            if _is_hidden(p, root):
                continue
            if p.suffix.lower() in BINARY_SUFFIXES:
                continue
            if p.stat().st_size > max_bytes:
                log.debug("Skipping oversized file: %s", p)
                continue
            if p.stat().st_size == 0:
                continue
            if ignore_spec is not None and _is_ignored(p, root, ignore_spec):
                continue
            yield str(root), p


def _load_hermesignore(root: Path):
    """Load .hermesignore from a root directory, returning a pathspec or None."""
    ignore_file = root / HERMESIGNORE_NAME
    if not ignore_file.is_file():
        return None
    try:
        import pathspec
        text = ignore_file.read_text(encoding="utf-8", errors="replace")
        return pathspec.PathSpec.from_lines("gitwildmatch", text.splitlines())
    except ImportError:
        log.warning("pathspec not installed — .hermesignore will be ignored")
        return None
    except Exception:
        log.warning("Failed to parse %s", ignore_file, exc_info=True)
        return None


def _is_ignored(path: Path, root: Path, spec) -> bool:
    rel = path.relative_to(root).as_posix()
    return spec.match_file(rel)


def _is_hidden(path: Path, root: Path) -> bool:
    """Check if any path component between root and path starts with '.'."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return False
    return any(part.startswith(".") for part in rel.parts)
