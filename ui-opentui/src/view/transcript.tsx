/**
 * Transcript — the scrolling message pane (spec v4 §2 `view/transcript.tsx`).
 *
 * ONE full-height <scrollbox> with a reactive <For> (opencode's model — the
 * viewport clips growing output so terminal scrollback is never corrupted; no
 * `writeToScrollback`). Carries the §8 #2 gotchas EXACTLY:
 *   - `minHeight:0` on BOTH the wrapper box AND the <scrollbox> (so the flex
 *     child can shrink below content height instead of pushing the composer off),
 *   - NO `flexDirection` on the <scrollbox> ROOT style (it has internal
 *     viewport/content children; setting it there breaks content-height
 *     measurement → phantom scroll offset that clips the top + leaves a gap),
 *   - `stickyScroll` + `stickyStart="bottom"` to pin the latest line.
 *
 * A `ScrollAnchorProvider` gives collapse/expand toggles (tool/thinking) a handle
 * to hold the viewport in place so expanding doesn't yank to the bottom (#4).
 *
 * ── Windowing (S1 of docs/plans/opentui-transcript-windowing.md, #27) ──────
 * Behind `HERMES_TUI_WINDOWING` (unset → ON; 0/false/no/off → OFF), each row is
 * wrapped in a measuring box (`onSizeChange` records its exact laid-out height,
 * margins included) and rows outside [scrollTop − viewport, scrollTop +
 * 2·viewport) swap to an EXACT-HEIGHT empty spacer `<box height={recorded}/>`
 * — 1 yoga node, no text buffers, no native handles — so the mounted set stays
 * ~3 viewports of rows regardless of transcript length (the 671MB→Ink-parity
 * memory fix). The Solid `<Show>` unmount destroys the row's renderables
 * (@opentui/solid `_removeNode` → `destroyRecursively()` once unparented).
 *
 * Driver: a renderer frame callback (`setFrameCallback` — scroll always
 * triggers a render, so every scroll movement is observed; no extra timer)
 * compares `scrollTop` to the last computation anchor with ≥ ¼-viewport
 * hysteresis (logic/window.ts) and publishes the mounted-key set through one
 * signal + `createSelector`, so only rows whose mounted-ness actually flipped
 * re-render. Never windowed: streaming rows, the last row while a turn runs,
 * and the bottom BOTTOM_ALWAYS_MOUNTED rows (see its doc). Rows the window has
 * never adjudicated default to MOUNTED (new live rows must paint instantly).
 * While a mouse selection is live the window FREEZES (no swaps — a swap would
 * destroy highlighted renderables out from under the native selection walk).
 * S1 never corrects a spacer height in place — wrong estimates (possible only
 * for never-measured resume history above the viewport) are fixed by remount;
 * `correctionIsLegal` governs anything smarter (S2).
 */
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { createMemo, createSelector, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { envFlag } from '../logic/env.ts'
import type { Message, SessionStore } from '../logic/store.ts'
import { computeWindow, estimateMessageHeight, hysteresisFor, shouldRecompute } from '../logic/window.ts'
import { DisplayProvider } from './display.tsx'
import { HomeHint } from './homeHint.tsx'
import { MessageLine, turnSpacing } from './messageLine.tsx'
import { ScrollAnchorProvider } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'

/**
 * The bottom K rows are ALWAYS mounted (the sticky-bottom region the user
 * lives in; also the zone where swap turbulence would be most visible). 30 is
 * a fixed, documented pick (the design's alternative — ceil(viewport/avg-row)
 * — buys little: rows under the viewport+margin are mounted by the window calc
 * anyway, so K only backstops sticky re-pins and burst appends).
 */
const BOTTOM_ALWAYS_MOUNTED = 30

/** The published window state: which keys are mounted, and which keys the
 *  computation has SEEN (unseen keys default to mounted — see isMounted). */
interface WinState {
  readonly mounted: ReadonlySet<number>
  readonly known: ReadonlySet<number>
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/** Signal equality for WinState — identical sets must not re-notify selectors. */
function sameWinState(a: WinState | undefined, b: WinState | undefined): boolean {
  if (!a || !b) return a === b
  return sameSet(a.mounted, b.mounted) && sameSet(a.known, b.known)
}

export function Transcript(props: { store: SessionStore }) {
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable | undefined>()
  const theme = useTheme()
  const renderer = useRenderer()
  const dropped = () => props.store.state.dropped
  const sid = () => props.store.state.sessionId
  // The NEWEST assistant answer's index — gold is earned (design pass): only
  // that turn's `⚕` glyph stays primary; older answers demote to grey.
  const latestAssistant = createMemo(() => {
    const messages = props.store.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  })

  // ── windowing state (S1) ───────────────────────────────────────────────
  // Read once per transcript: the flag is an A/B + escape hatch, not live config.
  const windowing = envFlag(process.env.HERMES_TUI_WINDOWING, true)
  // Stable row keys: messages carry no id and the store relies on reference
  // identity (<For> keys by item reference; solid-js/store proxies are cached
  // per underlying object, so the reference is stable across reads/mutations).
  // A WeakMap-assigned monotonic number gives the window math a primitive key
  // without restructuring the store or mutating Message objects.
  const rowKeys = new WeakMap<Message, number>()
  let rowSeq = 0
  const keyOf = (message: Message): number => {
    let key = rowKeys.get(message)
    if (key === undefined) {
      key = ++rowSeq
      rowKeys.set(message, key)
    }
    return key
  }
  // key → last exact height measured while the REAL row was mounted (the
  // wrapper's onSizeChange value; includes the row's margins). Non-reactive:
  // spacers read it once at swap time, the frame driver reads it per compute.
  const heights = new Map<number, number>()
  const [winState, setWinState] = createSignal<WinState | undefined>(undefined, { equals: sameWinState })
  // Non-reactive mirror of the latest winState for event callbacks (onSizeChange
  // must not subscribe; createSelector reads are for tracked scopes).
  let liveWin: WinState | undefined
  // Per-row mounted-ness: only rows whose answer FLIPPED re-run their <Show>.
  // Keys the window has never adjudicated (no state yet / not in `known`, e.g.
  // a message appended since the last compute) default to MOUNTED.
  const isMounted = createSelector(winState, (key: number, s: WinState | undefined) => {
    return !s || !s.known.has(key) || s.mounted.has(key)
  })
  const estimateFor = (message: Message): number => {
    const compact = props.store.state.compact
    return estimateMessageHeight(message, turnSpacing(message.role, compact), compact ? 0 : 1)
  }

  // ── window driver: per-frame scrollTop check (no scroll signal exists; the
  // frame callback fires on every rendered frame, and scrolling always renders).
  let anchor: number | null = null
  let lastCount = -1
  const tick = (): void => {
    const sb = scroll()
    if (!sb) return
    // Selection freeze: the native selection walks the LIVE tree — swapping a
    // row out (destroying its renderables) mid-selection would corrupt the
    // highlight/copy. Frozen ≠ broken: unseen new rows default to mounted.
    if (renderer.getSelection()?.isActive) return
    const viewportHeight = sb.viewport.height
    if (viewportHeight <= 0) return
    const messages = props.store.state.messages
    const scrollTop = sb.scrollTop
    const countChanged = messages.length !== lastCount
    if (!countChanged && !shouldRecompute(scrollTop, anchor, hysteresisFor(viewportHeight))) return
    const running = props.store.state.info.running ?? false
    const rows = messages.map((message, i) => {
      const key = keyOf(message)
      return {
        key,
        height: heights.get(key) ?? null,
        estimate: estimateFor(message),
        // Never window: a streaming row (remount would restart native markdown
        // streaming) and the last row while a turn runs (deltas land there).
        // A row with an expanded tool/reasoning body is NOT detectable from
        // here (the override lives in component-local signals — toolPart.tsx/
        // reasoningPart.tsx); expanded rows far above the viewport may
        // re-collapse on remount. Accepted for S1.
        neverWindow: (message.streaming ?? false) || (running && i === messages.length - 1)
      }
    })
    const result = computeWindow({
      rows,
      scrollTop,
      viewportHeight,
      margin: viewportHeight, // 1 viewport each side (design §Mechanism 1)
      bottomK: BOTTOM_ALWAYS_MOUNTED
    })
    anchor = result.anchor
    lastCount = messages.length
    const known = new Set(rows.map(r => r.key))
    // The store cap splices old rows out — drop their recorded heights too.
    if (countChanged) for (const key of heights.keys()) if (!known.has(key)) heights.delete(key)
    liveWin = { mounted: result.mounted, known }
    setWinState(liveWin)
  }
  onMount(() => {
    if (!windowing) return
    const frame = (_deltaTime: number): Promise<void> => {
      tick()
      return Promise.resolve()
    }
    renderer.setFrameCallback(frame)
    onCleanup(() => renderer.removeFrameCallback(frame))
  })

  /** One windowed row: a measuring wrapper around the real MessageLine or an
   *  exact-height spacer. The wrapper stays mounted either way (1 box), so its
   *  `onSizeChange` keeps the height record fresh while the row is real. */
  const WindowedRow = (rowProps: { message: Message; index: () => number }) => {
    const key = keyOf(rowProps.message)
    let wrapper: BoxRenderable | undefined
    const record = (): void => {
      if (!wrapper) return
      // Only record while the REAL row is mounted — a spacer's (or estimate's)
      // height must never overwrite the exact measurement.
      if (liveWin && liveWin.known.has(key) && !liveWin.mounted.has(key)) return
      const h = wrapper.height
      if (h > 0) heights.set(key, h)
    }
    return (
      <box ref={el => (wrapper = el)} style={{ flexDirection: 'column', flexShrink: 0 }} onSizeChange={record}>
        <Show
          when={isMounted(key)}
          fallback={<box style={{ height: heights.get(key) ?? estimateFor(rowProps.message), flexShrink: 0 }} />}
        >
          <MessageLine message={rowProps.message} latest={rowProps.index() === latestAssistant()} />
        </Show>
      </box>
    )
  }

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <scrollbox ref={setScroll} style={{ flexGrow: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
        <ScrollAnchorProvider scroll={scroll}>
          {/* display flags (/compact, /details — Epic 3) for the rows below */}
          <DisplayProvider flags={() => ({ compact: props.store.state.compact, details: props.store.state.details })}>
            {/* empty-transcript home screen (item 12); replaced by messages on the first turn */}
            <Show when={props.store.state.messages.length === 0}>
              <HomeHint store={props.store} />
            </Show>
            {/* Honest truncation notice: the rolling cap hides the OLDEST rows from the
              DISPLAY (never the model's context — that lives on the gateway). Point to
              the dashboard for the full transcript. selectable=false → it's chrome,
              excluded from copy/selection. */}
            <Show when={dropped() > 0}>
              <text selectable={false} style={{ fg: theme().color.muted }}>
                {`⤒ ${dropped()} earlier message${dropped() === 1 ? '' : 's'} — scroll-back capped; full transcript on the dashboard${sid() ? ` · session ${sid()}` : ''}`}
              </text>
            </Show>
            <For each={props.store.state.messages}>
              {(message, i) =>
                windowing ? (
                  <WindowedRow message={message} index={i} />
                ) : (
                  <MessageLine message={message} latest={i() === latestAssistant()} />
                )
              }
            </For>
          </DisplayProvider>
        </ScrollAnchorProvider>
      </scrollbox>
    </box>
  )
}
