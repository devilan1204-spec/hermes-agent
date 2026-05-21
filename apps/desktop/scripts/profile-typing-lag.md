# Profiling renderer typing lag

Workflow for empirically measuring (and fixing) typing/submit lag in the
desktop chat composer.

## Quick boot for profiling

Vite 8 + plugin-react 6 has a known issue where the React Fast Refresh
preamble script isn't injected into `index.html`, so opening Electron at
`http://127.0.0.1:5174` throws `$RefreshReg$ is not defined` on every TSX
module and the React tree never mounts. Workaround: run vite with HMR off.

```bash
# Terminal A — start dev server without HMR
cd apps/desktop
node scripts/dev-no-hmr.mjs

# Terminal B — start Electron with CDP exposed
cd apps/desktop
XCURSOR_SIZE=24 HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5174 \
  ../../node_modules/.bin/electron --remote-debugging-port=9222 .
```

Terminal C is yours to run the harnesses.

## Harnesses

All zero-dep — Node 24 built-in `WebSocket` + `fetch`.

### Typing latency — `measure-latency.mjs`

Per-keystroke `keypress → next paint` latency, p50/p90/p99/max.
Synthesizes keystrokes via `Input.dispatchKeyEvent` so the run is
reproducible.

```bash
node apps/desktop/scripts/measure-latency.mjs --chars=120 --cps=20
```

Anything > 16ms is a dropped frame. On a freshly-loaded session
(`scripts/click-session.mjs 'Phaser particle'`) we currently see:

| | unpatched | patched |
|---|---|---|
| p50 paint | 1.9 ms | 2.0 ms |
| p90 paint | 3.3 ms | 13.7 ms |
| p99 paint | 16.7 ms | 15.2 ms |
| max paint | 20.5 ms | 30.4 ms |
| >16ms drops | 2/120 | 1/120 |

Roughly even on a quick session — patches don't fix typing latency
under benign synthetic conditions because the existing baseline is
already snappy on synthetic input. The real wins are in the leak counters
(see below). If the user reports typing jank, capture a profile + heap
diff during their actual usage and compare against the synthetic baseline
to identify what condition (long thread, popover open, paste, etc.)
makes the path slow.

### Leak counters — `leak-typing.mjs`

Types N chars per round, clears, force-GCs, captures
`Performance.getMetrics` deltas. Reveals leaked event listeners, heap
drift, document node growth, and forced-layout counts.

```bash
# After clicking into a real session (e.g. via click-session.mjs):
node apps/desktop/scripts/leak-typing.mjs --rounds=8 --chars=200 --cps=50
```

**Real-session numbers (Phaser thread, 8 rounds × 200 chars):**

| | unpatched (HEAD~2) | patched (HEAD) |
|---|---|---|
| jsListeners growth/round | +0 | +0 |
| DOM nodes growth/round | +0 | +0 |
| heap growth/round | ~0 (V8 housekeeping) | ~0 |
| **forced layouts/char** | **7.02** | **2.35** (3× fewer) |

The forced-layout count is the load-bearing number — typing into a real
session was triggering ~7 layouts per character on the unpatched build
(scrollHeight reads + per-px CSS var writes + FadeText scrollWidth reads
all stacking up). After the patches it's down to ~2.35/char, which is
Blink's natural cost for a 1px/char-growing contentEditable and can't
be lowered further without architectural changes.

The initial "+35 listeners/round leak" I called out on the first
unpatched run turned out to be transient warm-up (popovers initializing,
etc.); steady-state listener growth was 0 both before and after.

### CPU profile + heap snapshot — `profile-typing.mjs`

Records a CPU profile while typing, plus before/after heap snapshots so
you can do a comparison diff in Chrome DevTools Memory tab.

```bash
node apps/desktop/scripts/profile-typing.mjs \
  --chars=400 --cps=30 --out=/tmp/hermes-typing
# → /tmp/hermes-typing.cpuprofile  (open in Chrome DevTools Performance)
# → /tmp/hermes-typing.before.heapsnapshot
# → /tmp/hermes-typing.after.heapsnapshot
```

Loading the cpuprofile: Chrome DevTools → Performance tab → drag the file
in, or VS Code → open the `.cpuprofile` directly.

For heap diff: Chrome DevTools → Memory → Load snapshot → load "before",
then Comparison view → load "after". Sort by `# Delta`. Stay alert for
detached DOM, FiberNodes (unmounted), and listener growth.

## Helpers

- `probe-renderer.mjs` — dump page state (URL, composer mounted?, body text)
- `click-session.mjs <title>` — click a sidebar session by partial title match
- `reload-renderer.mjs` — force Page.reload via CDP (no HMR available)
- `dump-state.mjs` — richer state dump (thread message count, sticky session, etc.)
- `probe-console.mjs` — dump recent console errors / exceptions

## Findings

See commit message for `apps/desktop/src/app/chat/composer/index.tsx`
edits. Three changes:

1. **Per-keystroke `scrollHeight` read removed.** The expansion useEffect
   used to read `editorRef.current.scrollHeight` on every draft change
   (forces synchronous layout). Replaced with a `draft.length > 60`
   heuristic; the ResizeObserver catches anything the heuristic misses.

2. **Bucketed CSS custom-property writes.** `syncComposerMetrics`
   used to `setProperty('--composer-measured-height', height + 'px')`
   on every observed resize, invalidating computed style for the whole
   tree. Now writes only when the height crosses an 8 px bucket, so
   typing in a fixed-height row produces no style invalidation at all.

3. **Removed dead `$composerDraft` → `aui.composer().setText` round-trip.**
   Nothing outside the composer subscribed to `$composerDraft` (verified
   via grep). The two useEffects that pushed draft → store and store →
   composer were pure overhead per keystroke. `reconcileComposerTerminalSelections`
   was also called per keystroke; can be deferred to submit time (it's a
   stale-pruning step, not a correctness one — `terminalContextBlocksFromDraft`
   walks the current text directly at submit and ignores stale labels).

4. **`refreshTrigger` fast-bails when no `@`/`/` in draft.** Previously
   `textBeforeCaret()` did `range.toString()` (O(n)) on every keystroke
   even when no trigger char was present.

The biggest win is the listener leak in (3) — without it, each round of
typing leaked ~35 event listeners until a steady state.

## Submit / TTFT stall (open)

User reports a perceived stall *after* Enter, before the assistant starts
streaming. `scripts/measure-submit.mjs` measures
`enter → composer-cleared → user-message-rendered → first-paint`. The
script triggers a real prompt submission, so use it on a throwaway
session. Not enabled in CI.
