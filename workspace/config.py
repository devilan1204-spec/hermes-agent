"""Workspace configuration loading.

Builds WorkspaceConfig and KnowledgebaseConfig from the main hermes
config.yaml.  Defaults come from workspace.constants so that
hermes_cli/config.py can also import them without circular deps.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from workspace.constants import (
    KNOWLEDGEBASE_CONFIG_DEFAULTS,
    STRATEGY_DEFAULTS,
    VALID_STRATEGIES,
    WORKSPACE_CONFIG_DEFAULTS,
    get_workspace_root,
)
from workspace.types import WorkspaceRoot


@dataclass(frozen=True)
class ChunkingConfig:
    strategy: str = "standard"
    chunk_size: int = 512
    overlap: int = 32
    threshold: int = 16_000


@dataclass(frozen=True)
class IndexingConfig:
    max_file_mb: int = 10


@dataclass(frozen=True)
class SearchConfig:
    default_limit: int = 20


@dataclass(frozen=True)
class KnowledgebaseConfig:
    roots: list[WorkspaceRoot] = field(default_factory=list)
    chunking: ChunkingConfig = field(default_factory=ChunkingConfig)
    indexing: IndexingConfig = field(default_factory=IndexingConfig)
    search: SearchConfig = field(default_factory=SearchConfig)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> KnowledgebaseConfig:
        merged = _deep_merge(copy.deepcopy(KNOWLEDGEBASE_CONFIG_DEFAULTS), d)
        roots = [
            WorkspaceRoot(path=r["path"], recursive=r.get("recursive", False))
            for r in merged.get("roots", [])
            if isinstance(r, dict) and "path" in r
        ]
        ch = merged.get("chunking", {})
        ix = merged.get("indexing", {})
        sr = merged.get("search", {})

        strategy = ch.get("strategy", "standard")
        if strategy not in VALID_STRATEGIES:
            raise ValueError(
                f"Unknown chunking strategy '{strategy}'. "
                f"Valid: {', '.join(sorted(VALID_STRATEGIES))}"
            )

        strat_defaults = STRATEGY_DEFAULTS[strategy]
        chunk_size = ch.get("chunk_size", 512)
        raw_overlap = ch.get("overlap")
        raw_threshold = ch.get("threshold")
        if raw_overlap is None:
            # Strategy defaults should remain valid even when users lower chunk_size.
            # Clamp the default overlap to stay strictly below chunk_size.
            overlap = min(strat_defaults["overlap"], max(0, chunk_size - 1))
        else:
            overlap = raw_overlap
        if raw_threshold is not None:
            threshold = raw_threshold
        else:
            threshold = strat_defaults["threshold"]
        max_file_mb = ix.get("max_file_mb", 10)
        default_limit = sr.get("default_limit", 20)

        if chunk_size <= 0:
            msg = f"chunk_size must be > 0, got {chunk_size}"
            raise ValueError(msg)
        if overlap < 0 or overlap >= chunk_size:
            msg = f"overlap must be >= 0 and < chunk_size ({chunk_size}), got {overlap}"
            raise ValueError(msg)
        if threshold < 0:
            msg = f"threshold must be >= 0, got {threshold}"
            raise ValueError(msg)
        if max_file_mb <= 0:
            msg = f"max_file_mb must be > 0, got {max_file_mb}"
            raise ValueError(msg)
        if default_limit < 1:
            msg = f"default_limit must be >= 1, got {default_limit}"
            raise ValueError(msg)

        return cls(
            roots=roots,
            chunking=ChunkingConfig(
                strategy=strategy,
                chunk_size=chunk_size,
                overlap=overlap,
                threshold=threshold,
            ),
            indexing=IndexingConfig(max_file_mb=max_file_mb),
            search=SearchConfig(default_limit=default_limit),
        )


@dataclass(frozen=True)
class WorkspaceConfig:
    enabled: bool = True
    workspace_root: Path = field(
        default_factory=lambda: Path.home() / ".hermes" / "workspace",
    )
    knowledgebase: KnowledgebaseConfig = field(default_factory=KnowledgebaseConfig)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], hermes_home: Path) -> WorkspaceConfig:
        ws_raw = raw.get("workspace", {})
        ws = _deep_merge(copy.deepcopy(WORKSPACE_CONFIG_DEFAULTS), ws_raw)
        kb = raw.get("knowledgebase", {})
        return cls(
            enabled=ws.get("enabled", True),
            workspace_root=get_workspace_root(hermes_home, ws.get("path", "")),
            knowledgebase=KnowledgebaseConfig.from_dict(kb),
        )


def load_workspace_config() -> WorkspaceConfig:
    from hermes_constants import get_config_path, get_hermes_home

    config_path = get_config_path()
    if not config_path.exists():
        return WorkspaceConfig(workspace_root=get_workspace_root(get_hermes_home()))

    import yaml

    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return WorkspaceConfig.from_dict(raw, get_hermes_home())


def _deep_merge(base: dict, override: dict) -> dict:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = _deep_merge(base[k], v)
        else:
            base[k] = v
    return base
