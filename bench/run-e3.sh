#!/usr/bin/env bash
# E3-lite — survival-to-OOM runs in a memory-constrained generic node:26
# container (NOT the shipped image; labeled honestly in the report). The
# worktree is bind-mounted read-only; results land in bench/results/ via a
# writable mount. The whole container (UI + fake gateway + harness) shares the
# --memory limit, mirroring how the shipped container would be capped.
#
# Usage: bash run-e3.sh [memory] [msgs]     (defaults: 1g, 10000)
set -euo pipefail

MEM="${1:-1g}"
MSGS="${2:-10000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
CELL="e3lite-${MEM}"

# Fixture is generated on the HOST (the .cache mount below is read-only).
FIX_INFO=$(node "$HERE/fixture-stream.mjs" --msgs "$MSGS")
FIX_PATH=$(echo "$FIX_INFO" | sed -E 's/.*"path":"([^"]+)".*/\1/')
FIX_SHA=$(echo "$FIX_INFO" | sed -E 's/.*"sha256":"([^"]+)".*/\1/')
echo "fixture: $FIX_PATH ($FIX_SHA)"

docker run --rm \
  --memory="$MEM" --memory-swap="$MEM" \
  -v "$REPO":/repo:ro \
  -v "$HERE/results":/results \
  -e BENCH_NODE_BIN=/usr/local/bin/node \
  -e E3_RESULTS_DIR=/results \
  -e E3_MSGS="$MSGS" \
  -e E3_FIXTURE="/repo/bench/.cache/$(basename "$FIX_PATH")" \
  -e E3_FIXTURE_SHA="$FIX_SHA" \
  -e E3_CELL="$CELL" \
  node:26 node /repo/bench/run-e3-inner.mjs
