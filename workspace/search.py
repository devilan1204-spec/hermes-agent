"""Workspace search API.

Thin wrapper around SQLiteFTS5Store.search() that handles config loading
and store lifecycle.
"""

from __future__ import annotations

from workspace.config import WorkspaceConfig
from workspace.store import SQLiteFTS5Store
from workspace.types import SearchResult


def search_workspace(
    query: str,
    config: WorkspaceConfig,
    *,
    limit: int | None = None,
    path_prefix: str | None = None,
    file_glob: str | None = None,
) -> list[SearchResult]:
    if limit is None:
        limit = config.knowledgebase.search.default_limit

    with SQLiteFTS5Store(config.workspace_root) as store:
        return store.search(
            query,
            limit=limit,
            path_prefix=path_prefix,
            file_glob=file_glob,
        )
