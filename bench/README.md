# TUI benchmark suite — Ink (`ui-tui`) vs OpenTUI (`ui-opentui`)

Methodology (settled, binding): `docs/plans/opentui-bench-suite.md`. This
directory is the implementation: real binaries over a real node-pty PTY
(120×40, xterm-256color), a fake gateway substituted via `HERMES_PYTHON`
(ZERO changes to either UI), external `/proc` sampling, cgroup-v2 memory caps.
No tmux anywhere in measurement.

## Pieces

| file | role |
|---|---|
| `fake-gateway.mjs` | NDJSON JSON-RPC gateway stand-in. Both UIs spawn it as `$HERMES_PYTHON -m tui_gateway.entry`. Answers every startup RPC with canned results, then streams the fixture (burst / paced / load-then-idle). Never writes stderr (the UIs render gateway stderr). |
| `fixture-stream.mjs` | Serializes the deterministic lumpy-turn fixture (`ui-opentui/scripts/fixture.ts`, imported directly via Node ≥26 type stripping — no port) to NDJSON. Cached under `.cache/`, sha256-stamped. |
| `harness.mjs` | One scenario = one UI boot: node-pty PTY, tight drain loop (event-loop starvation probe, 10ms budget asserted), `/proc/PID/{smaps_rollup,status,stat}` samples on 100-msg boundaries (UI PID only), `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` caps, SGR wheel injection, resize-jiggle digest capture. |
| `run.mjs` | The matrix runner (protocol: determinism gate first, sequential SUTs, randomized per-rep config order, 10s cooldowns, load gate). |
| `render.mjs` | `results/*.json` → self-contained `report.html` (inline SVG, no CDN) + PNGs in `report-assets/`. |

## Running cells

Node 26 is required (`BENCH_NODE_BIN` overrides the default fnm path). Build
both UIs first; results land in `results/<utc>-<sha7>-<cell>-<ui>-<config>-r<rep>.json`.

```sh
cd ui-opentui && node scripts/build.mjs && cd ../ui-tui && node scripts/build.mjs && cd ../bench
npm install                       # node-pty (bench-local devDep)

node run.mjs --cell gate          # determinism gate (digest replay ×2 per UI) — run FIRST
node run.mjs --cell mem3000       # clean memory runs, 3 reps × 3 configs, 2GB cap
node run.mjs --cell slope10k      # one 10k-msg slope run: ink + otui-uncapped (cap-hit IS a datapoint)
node run.mjs --cell nodes         # instrumented node counts (ink fd-3 sampler; opentui headless walk)
node run.mjs --cell cpu           # paced 30 ev/s streaming ×3
node run.mjs --cell scroll        # SGR wheel 30Hz×15s on a 3000-msg transcript ×3
node run.mjs --cell startup       # ×10, fake gateway
node render.mjs                   # report.html + report-assets/*.png
```

Configs: `ink` · `otui-capped` (`HERMES_TUI_MAX_MESSAGES=3000`, the default) ·
`otui-uncapped` (`=100000`). Launch parity with `hermes_cli/main.py`:
Ink = `node --expose-gc ui-tui/dist/entry.js`, OpenTUI =
`node --experimental-ffi --no-warnings ui-opentui/dist/main.js`, both with
`NODE_OPTIONS=--max-old-space-size=<heap>` (8192 on the unconstrained host —
what the launcher picks outside a container).

## E3 (constrained Docker survival)

`E3-lite` runs the same harness inside a generic `node:26` container (NOT the
shipped image) with the worktree bind-mounted read-only and `--memory=1g
--memory-swap=1g`; the whole container (UI + fake gateway + harness) shares the
limit. See `run-e3.sh` if present, or the report's survival table for the exact
invocation used.

## Accounting + known deviations

- **"messages" = fixture rows** (`rowsPerTurn` accounting, identical to
  `ui-opentui/scripts/mem-bench.tsx`), so numbers are comparable with the
  pre-registered expectations. ~46% of fixture rows are user/system rows.
- **User/system rows are not streamed**: they are composer-local in both UIs
  (no wire event exists), so PTY runs mount only the assistant/tool rows —
  the renderable-heavy part that carries the memory claim. Consequence: the
  OpenTUI store cap (3000 rows) binds at ≈6.6k fixture-msgs in PTY runs.
- **Digest gate**: final-screen digest after a resize-forced repaint, ANSI
  stripped, cut at the composer hint, `up: Ns` normalized (the OpenTUI status
  bar has a 1Hz uptime clock; the transcript region itself is deterministic).
- The headless `scripts/mem-bench.tsx` numbers are diagnostic-only and flagged
  `instrumented`/`diagnostic_only` — never headlined.
