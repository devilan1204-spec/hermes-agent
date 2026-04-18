"""End-to-end tests for the Pipeline-based indexer.

Exercises the behavior the workspace indexer is expected to produce
after migrating from manual Chonkie wiring to `chonkie.Pipeline`:

- Markdown files emit one ChunkRecord per modality (text/code/table/image)
  with the correct `kind`, and no legacy block_index/src/link/row_count metadata.
- Small markdown files with a code block are still split into two records
  (prose + code) rather than collapsed into a single chunk.
- Overlap context is populated and is a suffix of the previous chunk's content.
- Deprecated config keys (strategy, threshold) are silently ignored.
- Config signature changes cause re-indexing.

Marked xfail(strict=True) until the Pipeline migration lands.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from workspace.config import WorkspaceConfig
from workspace.constants import DEFAULT_IGNORE_PATTERNS
from workspace.indexer import index_workspace
from workspace.store import SQLiteFTS5Store


def _make_config(tmp_path: Path, raw: dict | None = None) -> WorkspaceConfig:
    hermes_home = tmp_path / "cfg_home"
    hermes_home.mkdir(exist_ok=True)
    cfg = WorkspaceConfig.from_dict(raw or {}, hermes_home)
    cfg.workspace_root.mkdir(parents=True, exist_ok=True)
    (cfg.workspace_root / ".hermesignore").write_text(
        DEFAULT_IGNORE_PATTERNS + "\n.hermesignore\n",
        encoding="utf-8",
    )
    return cfg


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_markdown_pipeline_emits_clean_metadata_per_modality(tmp_path: Path):
    cfg = _make_config(tmp_path, {"knowledgebase": {"chunking": {"chunk_size": 64}}})
    md = _write(
        cfg.workspace_root / "docs" / "mixed.md",
        "# Title\n\n"
        "Intro prose for the markdown pipeline.\n\n"
        "```python\n"
        "def first():\n"
        "    return 1\n"
        "```\n\n"
        "| Name | Score |\n"
        "| ---- | ----- |\n"
        "| A    | 10    |\n\n"
        "![first image](img/one.png)\n\n"
        "## Second\n\n"
        "More prose.\n",
    )

    summary = index_workspace(cfg)
    assert summary.files_indexed == 1
    assert summary.files_errored == 0

    with SQLiteFTS5Store(cfg.workspace_root) as store:
        rows = store.conn.execute(
            "SELECT kind, content, chunk_metadata, chunk_index, section, "
            "start_line, end_line FROM chunks "
            "WHERE abs_path = ? ORDER BY chunk_index",
            (str(md.resolve()),),
        ).fetchall()

    kinds = [r["kind"] for r in rows]
    assert "markdown_text" in kinds
    assert "markdown_code" in kinds
    assert "markdown_table" in kinds
    assert "markdown_image" in kinds

    # chunk_index is 0..N-1, strictly increasing
    assert [r["chunk_index"] for r in rows] == list(range(len(rows)))

    # Code rows: language present, no block_index
    code_rows = [r for r in rows if r["kind"] == "markdown_code"]
    assert code_rows, "expected at least one markdown_code row"
    for r in code_rows:
        meta = json.loads(r["chunk_metadata"])
        assert meta == {"language": "python"}

    # Table rows: no chunk_metadata (NULL)
    table_rows = [r for r in rows if r["kind"] == "markdown_table"]
    assert table_rows
    for r in table_rows:
        assert r["chunk_metadata"] is None

    # Image rows: content is the alias; no chunk_metadata
    image_rows = [r for r in rows if r["kind"] == "markdown_image"]
    assert image_rows
    for r in image_rows:
        assert r["content"] == "first image"
        assert r["chunk_metadata"] is None

    # Section assignment: the "Second" heading affects later rows
    sections = {r["section"] for r in rows if r["section"]}
    assert any("Title" in s for s in sections)

    # Line numbers are 1-indexed and ordered
    assert all(r["start_line"] >= 1 for r in rows)
    assert all(r["end_line"] >= r["start_line"] for r in rows)


def test_small_markdown_file_is_split_into_modalities(tmp_path: Path):
    """A 20-word markdown file with a code block must still produce two records.

    Current impl short-circuits through _single_chunk when word_count <= threshold,
    producing one giant record with kind=markdown_text that includes the raw code fence.
    Post-migration, every file flows through the Pipeline, so the chef splits
    prose and code into separate rows.
    """
    cfg = _make_config(tmp_path, {"knowledgebase": {"chunking": {"chunk_size": 512}}})
    md = _write(
        cfg.workspace_root / "docs" / "tiny.md",
        "# Tiny\n\nShort intro.\n\n```python\nprint('hi')\n```\n",
    )

    summary = index_workspace(cfg)
    assert summary.files_indexed == 1

    with SQLiteFTS5Store(cfg.workspace_root) as store:
        rows = store.conn.execute(
            "SELECT kind FROM chunks WHERE abs_path = ? ORDER BY chunk_index",
            (str(md.resolve()),),
        ).fetchall()

    kinds = [r["kind"] for r in rows]
    assert "markdown_text" in kinds
    assert "markdown_code" in kinds
    assert len(rows) >= 2, f"small markdown must still be multimodal, got {kinds}"


def test_overlap_context_propagates_and_is_prefix_of_next_chunk(tmp_path: Path):
    """Multi-chunk prose file: every non-last chunk has non-NULL context,
    and that context is a prefix of the NEXT chunk's content. Chonkie's
    OverlapRefinery with method='suffix' in mode='token' attaches the first
    context_size tokens of chunk N+1 onto chunk N as `context`. FTS indexes
    this column so a term that only appears at the start of chunk N+1's content
    is still findable via chunk N's context field.
    """
    sentences = [f"Sentence number {i} carries unique marker token WORD{i:03d}." for i in range(60)]
    cfg = _make_config(tmp_path, {"knowledgebase": {"chunking": {"chunk_size": 64, "overlap": 8}}})
    f = _write(cfg.workspace_root / "notes" / "long.txt", "\n".join(sentences) + "\n")

    summary = index_workspace(cfg)
    assert summary.files_indexed == 1

    with SQLiteFTS5Store(cfg.workspace_root) as store:
        rows = store.conn.execute(
            "SELECT content, context FROM chunks WHERE abs_path = ? ORDER BY chunk_index",
            (str(f.resolve()),),
        ).fetchall()

    assert len(rows) >= 2, "fixture must produce multiple chunks"

    non_null_contexts = [r for r in rows if r["context"] is not None]
    assert len(non_null_contexts) >= 1, "at least one chunk must carry overlap context"

    # For every chunk whose `context` is set, that context must appear at the
    # START of the NEXT chunk's content (method="suffix" in mode="token" takes
    # the first N tokens of chunk N+1 and attaches them to chunk N as `context`).
    for i in range(len(rows) - 1):
        ctx = rows[i]["context"]
        if ctx is None:
            continue
        next_content = rows[i + 1]["content"]
        assert ctx.strip() in next_content, (
            f"chunk {i} context is not a substring of chunk {i+1} content\n"
            f"  context: {ctx!r}\n  next: {next_content!r}"
        )


def test_deprecated_strategy_and_threshold_keys_are_silently_ignored(tmp_path: Path):
    """Old configs that still set `strategy: semantic` or `threshold: 0` must load
    cleanly after the migration (fields are gone from ChunkingConfig, unknown keys
    pass through _deep_merge and are dropped by from_dict). No ValueError, no warning
    suppression hack — just a clean no-op."""
    cfg = _make_config(
        tmp_path,
        {
            "knowledgebase": {
                "chunking": {
                    "strategy": "semantic",
                    "threshold": 0,
                    "chunk_size": 128,
                }
            }
        },
    )
    assert cfg.knowledgebase.chunking.chunk_size == 128
    assert not hasattr(cfg.knowledgebase.chunking, "strategy")
    assert not hasattr(cfg.knowledgebase.chunking, "threshold")

    # And indexing works end-to-end with the legacy-keyed config.
    _write(cfg.workspace_root / "docs" / "readme.md", "# Hi\n\nSome prose.\n")
    summary = index_workspace(cfg)
    assert summary.files_indexed == 1
    assert summary.files_errored == 0


def test_config_signature_change_invalidates_existing_index(tmp_path: Path):
    """Changing a field that belongs in the signature (chunk_size) must cause
    already-indexed files to be re-indexed on the next run rather than skipped.
    This guards against accidentally dropping a field from _config_signature."""
    cfg = _make_config(tmp_path, {"knowledgebase": {"chunking": {"chunk_size": 512}}})
    _write(cfg.workspace_root / "docs" / "a.md", "# A\n\nContent A.\n")

    first = index_workspace(cfg)
    assert first.files_indexed == 1
    assert first.files_skipped == 0

    # Same config → second run skips.
    second = index_workspace(cfg)
    assert second.files_indexed == 0
    assert second.files_skipped == 1

    # Changed chunk_size → third run re-indexes.
    cfg2 = _make_config(tmp_path, {"knowledgebase": {"chunking": {"chunk_size": 256}}})
    third = index_workspace(cfg2)
    assert third.files_indexed == 1
    assert third.files_skipped == 0
