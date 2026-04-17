"""Workspace indexing pipeline.

Discovers files → checks content hash + config signature → dispatches to
appropriate Chonkie chunker (strategy-dependent) → applies OverlapRefinery →
computes line numbers → stores in SQLite FTS5.

Strategy tiers:
  standard: RecursiveChunker (prose) + CodeChunker (code)
  semantic: SemanticChunker (prose) + CodeChunker (code)
  neural:   NeuralChunker + size enforcement (prose) + CodeChunker (code)

All markdown files go through MarkdownChef first regardless of strategy.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from workspace.config import WorkspaceConfig
from workspace.constants import (
    CHUNKING_PLAN_VERSION,
    CODE_SUFFIXES,
    MARKDOWN_SUFFIXES,
    PINNED_NEURAL_MODEL,
    PINNED_SEMANTIC_MODEL,
    WORKSPACE_SUBDIRS,
    get_index_dir,
)
from workspace.files import discover_workspace_files, seed_hermesignore
from workspace.store import SQLiteFTS5Store
from workspace.types import ChunkRecord, FileRecord, IndexError, IndexSummary

log = logging.getLogger(__name__)

ProgressCallback = Callable[[int, int, str], None]

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)

_MAX_ERRORS = 50

_STRATEGY_DEPS: dict[str, list[tuple[str, str]]] = {
    "standard": [],
    "semantic": [("chonkie.chunker.semantic", "chonkie[semantic]")],
    "neural": [("chonkie.chunker.neural", "chonkie[neural]")],
}


def _require_chonkie() -> None:
    try:
        import chonkie  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "Chonkie is required for workspace indexing. "
            "Install it with: pip install hermes-agent[workspace]"
        )


def _validate_strategy_deps(strategy: str) -> None:
    for module, package in _STRATEGY_DEPS.get(strategy, []):
        try:
            importlib.import_module(module)
        except ImportError as exc:
            raise RuntimeError(
                f"Strategy '{strategy}' requires {package}. "
                f"Install it with: pip install {package}"
            ) from exc


def index_workspace(
    config: WorkspaceConfig,
    *,
    progress: ProgressCallback | None = None,
) -> IndexSummary:
    _require_chonkie()
    strategy = config.knowledgebase.chunking.strategy
    _validate_strategy_deps(strategy)

    start = time.monotonic()
    ensure_workspace_dirs(config)
    config_sig = _config_signature(config)

    files_indexed = 0
    files_skipped = 0
    files_errored = 0
    chunks_created = 0
    errors: list[IndexError] = []

    discovery = discover_workspace_files(config)
    all_files = discovery.files
    total = len(all_files)
    disk_paths: set[str] = set()

    chunkers = _ChunkerCache(config)

    with SQLiteFTS5Store(config.workspace_root) as store:
        for i, (root_path, file_path) in enumerate(all_files):
            abs_path = str(file_path.resolve())
            disk_paths.add(abs_path)
            write_started = False

            if progress:
                progress(i + 1, total, abs_path)

            try:
                content_hash = _file_hash(file_path)
                existing = store.get_file_record(abs_path)
                if (
                    existing
                    and existing.content_hash == content_hash
                    and existing.config_signature == config_sig
                ):
                    files_skipped += 1
                    continue

                text = _read_file_text(file_path)
                if text is None:
                    files_errored += 1
                    _append_error(errors, IndexError(
                        path=abs_path, stage="read",
                        error_type="EncodingError",
                        message="Could not decode file with sufficient confidence",
                    ))
                    continue

                if not text.strip():
                    files_skipped += 1
                    continue

                suffix = file_path.suffix.lower()
                chunk_records = _process_file(abs_path, text, suffix, config, chunkers)

                stat = file_path.stat()
                record = FileRecord(
                    abs_path=abs_path,
                    root_path=root_path,
                    content_hash=content_hash,
                    config_signature=config_sig,
                    size_bytes=stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    indexed_at=datetime.now(tz=timezone.utc).isoformat(),
                    chunk_count=len(chunk_records),
                )

                # Replace a file's rows atomically so a failed rebuild never
                # destroys the previously indexed version of that file.
                store.conn.execute("SAVEPOINT workspace_file_update")
                write_started = True
                store.delete_chunks_for_file(abs_path)
                store.upsert_file(record)
                if chunk_records:
                    store.insert_chunks(chunk_records)
                store.conn.execute("RELEASE SAVEPOINT workspace_file_update")
                store.commit()
                write_started = False

                files_indexed += 1
                chunks_created += len(chunk_records)

            except Exception as exc:
                if write_started:
                    try:
                        store.conn.execute("ROLLBACK TO SAVEPOINT workspace_file_update")
                        store.conn.execute("RELEASE SAVEPOINT workspace_file_update")
                    except Exception:
                        log.warning("Failed to roll back workspace update for %s", abs_path, exc_info=True)
                files_errored += 1
                stage = "discover" if isinstance(exc, FileNotFoundError) else "store"
                _append_error(errors, IndexError(
                    path=abs_path, stage=stage,
                    error_type=type(exc).__name__,
                    message=str(exc),
                ))
                log.warning("Failed to index %s: %s", abs_path, exc, exc_info=True)
                continue

        if discovery.complete:
            pruned = _prune_stale(store, disk_paths)
        else:
            pruned = 0
            log.warning("Workspace discovery was incomplete; skipping stale prune for this run")
        store.commit()

    elapsed = time.monotonic() - start
    return IndexSummary(
        files_indexed=files_indexed,
        files_skipped=files_skipped,
        files_pruned=pruned,
        files_errored=files_errored,
        chunks_created=chunks_created,
        duration_seconds=elapsed,
        errors=errors,
        errors_truncated=files_errored > _MAX_ERRORS,
    )


def _append_error(errors: list[IndexError], error: IndexError) -> None:
    if len(errors) < _MAX_ERRORS:
        errors.append(error)


def _read_file_text(path: Path) -> str | None:
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes
        result = from_bytes(raw).best()
        if result is None or result.encoding is None:
            return None
        if result.coherence < 0.5:
            return None
        return str(result)
    except ImportError:
        log.debug("charset-normalizer not installed, skipping non-UTF8 file: %s", path)
        return None


def ensure_workspace_dirs(config: WorkspaceConfig) -> None:
    root = config.workspace_root
    root.mkdir(parents=True, exist_ok=True)
    for sub in WORKSPACE_SUBDIRS:
        (root / sub).mkdir(exist_ok=True)
    get_index_dir(root).mkdir(parents=True, exist_ok=True)
    seed_hermesignore(root)


# ---------------------------------------------------------------------------
# Chunker cache — lazy-init, one per index run
# ---------------------------------------------------------------------------

class _ChunkerCache:
    def __init__(self, config: WorkspaceConfig) -> None:
        self._config = config
        self._prose: Any = None
        self._code: Any = None
        self._default: Any = None
        self._markdown_recipe: Any = None
        self._overlap_refinery: Any = None
        self._chef: Any = None

    @property
    def strategy(self) -> str:
        return self._config.knowledgebase.chunking.strategy

    @property
    def chef(self):
        if self._chef is None:
            from chonkie import MarkdownChef
            self._chef = MarkdownChef(tokenizer="word")
        return self._chef

    @property
    def prose(self):
        if self._prose is None:
            ch = self._config.knowledgebase.chunking
            if ch.strategy == "semantic":
                from chonkie import SemanticChunker
                self._prose = SemanticChunker(
                    embedding_model=PINNED_SEMANTIC_MODEL,
                    threshold=0.8,
                    chunk_size=ch.chunk_size,
                    similarity_window=3,
                    min_sentences_per_chunk=1,
                    min_characters_per_sentence=24,
                    delim=[". ", "! ", "? ", "\n"],
                    include_delim="prev",
                )
            elif ch.strategy == "neural":
                from chonkie import NeuralChunker
                self._prose = NeuralChunker(
                    model=PINNED_NEURAL_MODEL,
                    min_characters_per_chunk=10,
                )
            else:
                from chonkie import RecursiveChunker
                self._prose = RecursiveChunker(
                    tokenizer="word",
                    chunk_size=ch.chunk_size,
                )
        return self._prose

    @property
    def markdown_recipe(self):
        if self._markdown_recipe is None:
            from chonkie import RecursiveChunker
            ch = self._config.knowledgebase.chunking
            self._markdown_recipe = RecursiveChunker.from_recipe(
                "markdown",
                tokenizer="word",
                chunk_size=ch.chunk_size,
            )
        return self._markdown_recipe

    @property
    def code(self):
        if self._code is None:
            from chonkie import CodeChunker
            ch = self._config.knowledgebase.chunking
            self._code = CodeChunker(
                tokenizer="word",
                chunk_size=ch.chunk_size,
                language="auto",
            )
        return self._code

    @property
    def default(self):
        if self._default is None:
            from chonkie import RecursiveChunker
            ch = self._config.knowledgebase.chunking
            self._default = RecursiveChunker(
                tokenizer="word",
                chunk_size=ch.chunk_size,
            )
        return self._default

    @property
    def overlap_refinery(self):
        if self._overlap_refinery is None:
            from chonkie import OverlapRefinery
            ch = self._config.knowledgebase.chunking
            self._overlap_refinery = OverlapRefinery(
                tokenizer="word",
                context_size=ch.overlap,
                mode="token",
                method="suffix",
                merge=False,
            )
        return self._overlap_refinery


# ---------------------------------------------------------------------------
# File processing pipeline
# ---------------------------------------------------------------------------

def _process_file(
    abs_path: str, text: str, suffix: str,
    config: WorkspaceConfig, chunkers: _ChunkerCache,
) -> list[ChunkRecord]:
    ch = config.knowledgebase.chunking
    word_count = len(text.split())

    if word_count <= ch.threshold:
        return _single_chunk(abs_path, text, suffix)

    if suffix in MARKDOWN_SUFFIXES:
        return _process_markdown(abs_path, text, config, chunkers)
    elif suffix in CODE_SUFFIXES:
        return _process_code(abs_path, text, suffix, config, chunkers)
    else:
        return _process_plain(abs_path, text, suffix, config, chunkers)


def _single_chunk(abs_path: str, text: str, suffix: str) -> list[ChunkRecord]:
    total_lines = len(text.splitlines())
    word_count = len(text.split())
    section = _extract_first_heading(text) if suffix in MARKDOWN_SUFFIXES else None
    kind = _kind_from_suffix(suffix)
    return [
        ChunkRecord(
            chunk_id=_make_id(),
            abs_path=abs_path,
            chunk_index=0,
            content=text,
            token_count=word_count,
            start_line=1,
            end_line=total_lines,
            start_char=0,
            end_char=len(text),
            section=section,
            kind=kind,
        )
    ]


# ---------------------------------------------------------------------------
# Markdown pipeline via MarkdownChef
# ---------------------------------------------------------------------------

def _process_markdown(
    abs_path: str, text: str,
    config: WorkspaceConfig, chunkers: _ChunkerCache,
) -> list[ChunkRecord]:
    try:
        doc = chunkers.chef.parse(text)
    except Exception:
        log.debug("MarkdownChef failed for %s, falling back to prose chunker", abs_path)
        return _process_plain(abs_path, text, ".md", config, chunkers)

    headings = _scan_headings(text)
    line_offsets = _build_line_offsets(text)
    ch = config.knowledgebase.chunking
    candidates: list[ChunkRecord] = []
    idx = 0

    for segment in doc.chunks:
        seg_text = segment.text
        if not seg_text.strip():
            continue
        try:
            if ch.strategy == "standard":
                raw_chunks = chunkers.markdown_recipe(seg_text)
            else:
                raw_chunks = chunkers.prose(seg_text)
                if ch.strategy == "neural":
                    raw_chunks = _neural_enforce_size(raw_chunks, ch.chunk_size, chunkers)
        except Exception:
            log.debug("Prose chunker failed for segment in %s, using default", abs_path)
            raw_chunks = chunkers.default(seg_text)

        for rc in raw_chunks:
            sc = segment.start_index + rc.start_index
            ec = segment.start_index + rc.end_index
            section = _nearest_heading(headings, sc)
            candidates.append(ChunkRecord(
                chunk_id=_make_id(), abs_path=abs_path, chunk_index=idx,
                content=rc.text, token_count=rc.token_count,
                start_line=_offset_to_line(line_offsets, sc),
                end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
                start_char=sc, end_char=ec,
                section=section, kind="markdown_text",
            ))
            idx += 1

    for block_idx, block in enumerate(getattr(doc, "code", [])):
        block_text = getattr(block, "content", None) or getattr(block, "text", "")
        if not block_text.strip():
            continue
        lang = getattr(block, "language", None) or "auto"
        # Chonkie's markdown block types expose offsets but not a stable index.
        # Derive a deterministic per-modality index during iteration.
        metadata = json.dumps({"block_index": block_idx, "language": lang})
        try:
            from chonkie import CodeChunker
            code_chunker = CodeChunker(
                tokenizer="word", chunk_size=ch.chunk_size,
                language=lang if lang != "auto" else "auto",
            )
            raw_chunks = code_chunker(block_text)
        except Exception:
            raw_chunks = chunkers.default(block_text)

        for rc in raw_chunks:
            sc = block.start_index + rc.start_index
            ec = block.start_index + rc.end_index
            section = _nearest_heading(headings, sc)
            candidates.append(ChunkRecord(
                chunk_id=_make_id(), abs_path=abs_path, chunk_index=idx,
                content=rc.text, token_count=rc.token_count,
                start_line=_offset_to_line(line_offsets, sc),
                end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
                start_char=sc, end_char=ec,
                section=section, kind="markdown_code",
                chunk_metadata=metadata,
            ))
            idx += 1

    for block_idx, table in enumerate(getattr(doc, "tables", [])):
        table_text = getattr(table, "content", None) or getattr(table, "text", "")
        if not table_text.strip():
            continue
        rows = table_text.strip().count("\n") + 1
        cols = len(table_text.split("\n")[0].split("|")) - 2 if "|" in table_text else 0
        cols = max(cols, 0)
        metadata = json.dumps({"block_index": block_idx, "row_count": rows, "column_count": cols})
        sc = table.start_index
        ec = table.end_index
        section = _nearest_heading(headings, sc)
        candidates.append(ChunkRecord(
            chunk_id=_make_id(), abs_path=abs_path, chunk_index=idx,
            content=table_text, token_count=len(table_text.split()),
            start_line=_offset_to_line(line_offsets, sc),
            end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
            start_char=sc, end_char=ec,
            section=section, kind="markdown_table",
            chunk_metadata=metadata,
        ))
        idx += 1

    for block_idx, image in enumerate(getattr(doc, "images", [])):
        alias = getattr(image, "alias", None) or getattr(image, "alt", None)
        if not alias:
            continue
        src = (
            getattr(image, "src", None)
            or getattr(image, "url", None)
            or getattr(image, "content", None)
            or ""
        )
        link = getattr(image, "link", None)
        metadata = json.dumps({"block_index": block_idx, "alias": alias, "src": src, "link": link})
        sc = image.start_index
        ec = image.end_index
        section = _nearest_heading(headings, sc)
        candidates.append(ChunkRecord(
            chunk_id=_make_id(), abs_path=abs_path, chunk_index=idx,
            content=alias, token_count=len(alias.split()),
            start_line=_offset_to_line(line_offsets, sc),
            end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
            start_char=sc, end_char=ec,
            section=section, kind="markdown_image",
            chunk_metadata=metadata,
        ))
        idx += 1

    candidates.sort(key=lambda c: c.start_char)
    for i, c in enumerate(candidates):
        if c.chunk_index != i:
            candidates[i] = ChunkRecord(
                chunk_id=c.chunk_id, abs_path=c.abs_path, chunk_index=i,
                content=c.content, token_count=c.token_count,
                start_line=c.start_line, end_line=c.end_line,
                start_char=c.start_char, end_char=c.end_char,
                section=c.section, kind=c.kind,
                context=c.context, chunk_metadata=c.chunk_metadata,
            )

    return _apply_overlap(candidates, chunkers)


# ---------------------------------------------------------------------------
# Code file pipeline
# ---------------------------------------------------------------------------

def _process_code(
    abs_path: str, text: str, suffix: str,
    config: WorkspaceConfig, chunkers: _ChunkerCache,
) -> list[ChunkRecord]:
    try:
        raw_chunks = chunkers.code(text)
    except Exception:
        log.debug("CodeChunker failed for %s, falling back to default", abs_path)
        raw_chunks = chunkers.default(text)

    line_offsets = _build_line_offsets(text)
    records = []
    for i, chunk in enumerate(raw_chunks):
        sc = chunk.start_index
        ec = chunk.end_index
        lang = getattr(chunk, "language", None)
        metadata = json.dumps({"language": lang}) if lang else None
        records.append(ChunkRecord(
            chunk_id=_make_id(), abs_path=abs_path, chunk_index=i,
            content=chunk.text, token_count=chunk.token_count,
            start_line=_offset_to_line(line_offsets, sc),
            end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
            start_char=sc, end_char=ec,
            section=None, kind="code",
            chunk_metadata=metadata,
        ))

    return _apply_overlap(records, chunkers)


# ---------------------------------------------------------------------------
# Plain text pipeline
# ---------------------------------------------------------------------------

def _process_plain(
    abs_path: str, text: str, suffix: str,
    config: WorkspaceConfig, chunkers: _ChunkerCache,
) -> list[ChunkRecord]:
    ch = config.knowledgebase.chunking
    try:
        if ch.strategy == "standard":
            raw_chunks = chunkers.prose(text)
        elif ch.strategy == "semantic":
            raw_chunks = chunkers.prose(text)
        else:
            raw_chunks = chunkers.prose(text)
            raw_chunks = _neural_enforce_size(raw_chunks, ch.chunk_size, chunkers)
    except Exception:
        log.debug("Prose chunker failed for %s, falling back to default", abs_path)
        raw_chunks = chunkers.default(text)

    line_offsets = _build_line_offsets(text)
    records = []
    for i, chunk in enumerate(raw_chunks):
        sc = chunk.start_index
        ec = chunk.end_index
        records.append(ChunkRecord(
            chunk_id=_make_id(), abs_path=abs_path, chunk_index=i,
            content=chunk.text, token_count=chunk.token_count,
            start_line=_offset_to_line(line_offsets, sc),
            end_line=_offset_to_line(line_offsets, max(0, ec - 1)),
            start_char=sc, end_char=ec,
            section=None, kind="text",
        ))

    return _apply_overlap(records, chunkers)


# ---------------------------------------------------------------------------
# Neural size enforcement
# ---------------------------------------------------------------------------

def _neural_enforce_size(
    chunks: list[Any], chunk_size: int, chunkers: _ChunkerCache,
) -> list[Any]:
    result = []
    for chunk in chunks:
        if chunk.token_count <= chunk_size:
            result.append(chunk)
        else:
            try:
                sub_chunks = chunkers.default(chunk.text)
                for sc in sub_chunks:
                    sc.start_index = chunk.start_index + sc.start_index
                    sc.end_index = chunk.start_index + sc.end_index
                result.extend(sub_chunks)
            except Exception:
                result.append(chunk)
    return result


# ---------------------------------------------------------------------------
# OverlapRefinery — modality-aware
# ---------------------------------------------------------------------------

_OVERLAP_COMPATIBLE = {"markdown_text", "markdown_code", "code", "text"}


def _apply_overlap(records: list[ChunkRecord], chunkers: _ChunkerCache) -> list[ChunkRecord]:
    if not records or chunkers._config.knowledgebase.chunking.overlap <= 0:
        return records

    runs = _group_overlap_runs(records)
    result: list[ChunkRecord] = []

    for run in runs:
        if len(run) <= 1 or run[0].kind not in _OVERLAP_COMPATIBLE:
            result.extend(run)
            continue

        try:
            from chonkie import Chunk
            mock_chunks = [
                Chunk(text=r.content, start_index=r.start_char, end_index=r.end_char,
                      token_count=r.token_count)
                for r in run
            ]
            refined = chunkers.overlap_refinery(mock_chunks)

            for orig, ref in zip(run, refined):
                ctx = getattr(ref, "context", None)
                if ctx:
                    result.append(ChunkRecord(
                        chunk_id=orig.chunk_id, abs_path=orig.abs_path,
                        chunk_index=orig.chunk_index,
                        content=orig.content, token_count=orig.token_count,
                        start_line=orig.start_line, end_line=orig.end_line,
                        start_char=orig.start_char, end_char=orig.end_char,
                        section=orig.section, kind=orig.kind,
                        context=ctx, chunk_metadata=orig.chunk_metadata,
                    ))
                else:
                    result.append(orig)
        except Exception:
            log.debug("OverlapRefinery failed, returning chunks without overlap context")
            result.extend(run)

    return result


def _group_overlap_runs(records: list[ChunkRecord]) -> list[list[ChunkRecord]]:
    if not records:
        return []
    runs: list[list[ChunkRecord]] = [[records[0]]]
    for r in records[1:]:
        prev = runs[-1][-1]
        if (r.kind == prev.kind
                and r.kind in _OVERLAP_COMPATIBLE
                and r.abs_path == prev.abs_path):
            if r.kind == "markdown_code":
                prev_meta = json.loads(prev.chunk_metadata) if prev.chunk_metadata else {}
                curr_meta = json.loads(r.chunk_metadata) if r.chunk_metadata else {}
                if prev_meta.get("block_index") != curr_meta.get("block_index"):
                    runs.append([r])
                    continue
            runs[-1].append(r)
        else:
            runs.append([r])
    return runs


# ---------------------------------------------------------------------------
# Heading scanning and section assignment
# ---------------------------------------------------------------------------

def _scan_headings(text: str) -> list[tuple[int, str]]:
    return [(m.start(), m.group(0).strip()) for m in _HEADING_RE.finditer(text)]


def _nearest_heading(headings: list[tuple[int, str]], char_offset: int) -> str | None:
    best = None
    for offset, heading in headings:
        if offset <= char_offset:
            best = heading
        else:
            break
    return best


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def _extract_first_heading(text: str) -> str | None:
    m = _HEADING_RE.search(text)
    return m.group(0).strip() if m else None


def _kind_from_suffix(suffix: str) -> str:
    if suffix in MARKDOWN_SUFFIXES:
        return "markdown_text"
    if suffix in CODE_SUFFIXES:
        return "code"
    return "text"


def _build_line_offsets(text: str) -> list[int]:
    offsets = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            offsets.append(i + 1)
    return offsets


def _offset_to_line(offsets: list[int], char_offset: int) -> int:
    lo, hi = 0, len(offsets) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if offsets[mid] <= char_offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _config_signature(config: WorkspaceConfig) -> str:
    ch = config.knowledgebase.chunking
    blob = json.dumps({
        "strategy": ch.strategy,
        "chunk_size": ch.chunk_size,
        "overlap": ch.overlap,
        "threshold": ch.threshold,
        "overlap_mode": "token",
        "overlap_method": "suffix",
        "code_chunker": "production_v1",
        "semantic_model": PINNED_SEMANTIC_MODEL,
        "neural_model": PINNED_NEURAL_MODEL,
        "chunking_plan_version": CHUNKING_PLAN_VERSION,
    }, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _make_id() -> str:
    return f"chnk_{uuid.uuid4().hex[:12]}"


def _prune_stale(store: SQLiteFTS5Store, disk_paths: set[str]) -> int:
    indexed = store.all_indexed_paths()
    stale = indexed - disk_paths
    for path in stale:
        store.delete_file(path)
    return len(stale)
