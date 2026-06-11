/**
 * window — pure transcript-windowing math (slice S1 of docs/plans/
 * opentui-transcript-windowing.md, issue #27). The view (view/transcript.tsx)
 * replaces out-of-window rows with EXACT-HEIGHT empty boxes (1 yoga node, no
 * text buffers / native handles), so the mounted set stays ~3 viewports of
 * rows regardless of transcript length. This module is the testable core:
 *
 *  - `computeWindow` — which row keys must be mounted for a given scrollTop:
 *    rows intersecting [scrollTop − margin, scrollTop + viewport + margin)
 *    over CUMULATIVE row heights (exact recorded heights; a line-count
 *    estimate stands in for never-measured rows), plus the never-window rows
 *    (streaming/live) and the bottom K rows (sticky-bottom region).
 *  - `shouldRecompute` — the hysteresis gate (≥ ¼ viewport via
 *    `hysteresisFor`): a computed window only changes once scrollTop has
 *    moved ≥ hysteresis from the anchor it was computed at, so swaps don't
 *    thrash at window edges.
 *  - `correctionIsLegal` — the jank rule for spacer-height corrections:
 *    a correction may only touch rows fully ABOVE the viewport (the caller
 *    compensates scrollTop in the same frame — automatic when bottom-anchored
 *    via the sticky pin) or fully BELOW it (invisible by definition). Anything
 *    intersecting the viewport would visibly move content: forbidden.
 *  - `estimateMessageHeight` — the cheap line-count estimate for rows that
 *    have never been measured (resume history above the viewport). S1 never
 *    corrects a wrong estimate in place — it is fixed by remount (scrolling
 *    near) or by the S2 lazy measure pass, both governed by the jank rule.
 */
import type { Message, Part } from './store.ts'

/** One transcript row as the window calc sees it. */
export interface WindowRow<K> {
  readonly key: K
  /** Exact recorded height (the row wrapper's last onSizeChange measurement,
   *  margins included) — or null when the row has never been measured. */
  readonly height: number | null
  /** Line-count estimate used while `height` is null (see estimateMessageHeight). */
  readonly estimate?: number
  /** Always mounted regardless of the window (streaming/live rows — a remount
   *  would restart native markdown streaming). */
  readonly neverWindow: boolean
}

export interface WindowParams<K> {
  readonly rows: readonly WindowRow<K>[]
  readonly scrollTop: number
  readonly viewportHeight: number
  /** Mounted band kept above/below the viewport (design: 1 viewport each side). */
  readonly margin: number
  /** Stand-in height for null-height rows without their own estimate. */
  readonly fallbackHeight?: number
  /** The bottom K rows are always mounted (sticky-bottom region). */
  readonly bottomK?: number
}

export interface WindowResult<K> {
  /** Row keys that must be mounted; everything else renders as a spacer. */
  readonly mounted: ReadonlySet<K>
  /** The scrollTop this window was computed at — the next hysteresis anchor. */
  readonly anchor: number
}

/** Default stand-in for a null-height row with no estimate (≈ a short row). */
export const DEFAULT_FALLBACK_HEIGHT = 2

/** Ceiling on a single row's line-count estimate — a pathological wall of text
 *  must not make the never-mounted region look kilometers tall. */
const ESTIMATE_MAX_LINES = 500

/** Hysteresis for the window recompute: ≥ ¼ viewport (design rule), never 0. */
export function hysteresisFor(viewportHeight: number): number {
  return Math.max(1, Math.ceil(viewportHeight / 4))
}

/** Whether scrollTop has moved far enough from the last computation anchor to
 *  justify a new window (no anchor yet → always). */
export function shouldRecompute(scrollTop: number, anchor: number | null, hysteresis: number): boolean {
  if (anchor === null) return true
  return Math.abs(scrollTop - anchor) >= hysteresis
}

/** Compute the set of row keys that must be mounted for this scroll position. */
export function computeWindow<K>(params: WindowParams<K>): WindowResult<K> {
  const fallback = params.fallbackHeight ?? DEFAULT_FALLBACK_HEIGHT
  const bottomK = params.bottomK ?? 0
  const windowStart = params.scrollTop - params.margin
  const windowEnd = params.scrollTop + params.viewportHeight + params.margin
  const total = params.rows.length
  const mounted = new Set<K>()
  let top = 0
  let index = 0
  for (const r of params.rows) {
    const height = r.height ?? r.estimate ?? fallback
    const bottom = top + height
    // half-open intersection: a row merely touching a window edge stays out.
    const intersects = bottom > windowStart && top < windowEnd
    if (intersects || r.neverWindow || index >= total - bottomK) mounted.add(r.key)
    top = bottom
    index++
  }
  return { mounted, anchor: params.scrollTop }
}

/**
 * The jank rule: may a spacer-height correction for the row spanning
 * [rowTop, rowBottom) be applied at this scroll position without visibly
 * moving content?
 *
 *  - Fully BELOW the viewport → legal (invisible by definition).
 *  - Fully ABOVE the viewport → legal, PROVIDED the caller compensates
 *    scrollTop by the height delta in the same frame. When `atBottom`
 *    (sticky-bottom pinned) the pin performs that compensation automatically
 *    (bottom-anchored ⇒ zero visual movement); legality is the same either
 *    way — the flag documents which side owes the compensation.
 *  - Intersecting the viewport → forbidden; defer until the row scrolls out
 *    or is remounted for view.
 */
export function correctionIsLegal(
  rowTop: number,
  rowBottom: number,
  scrollTop: number,
  viewportHeight: number,
  _atBottom: boolean
): boolean {
  if (rowTop >= scrollTop + viewportHeight) return true // fully below the viewport
  if (rowBottom <= scrollTop) return true // fully above — compensate scrollTop in the same frame
  return false
}

/** Rendered line count of a text block (1-based; empty text still occupies a row). */
function lineCount(text: string): number {
  if (!text) return 1
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return lines
}

/** Estimated rendered lines of one part: text → its line count (view strips
 *  leading/trailing blanks — mirror that); tool/reasoning → 1 collapsed
 *  header line (the default render for settled, never-mounted history). */
function partLines(part: Part): number {
  if (part.type === 'text') return lineCount(part.text.replace(/^\n+|\n+$/g, ''))
  return 1 // collapsed tool/reasoning header line
}

/**
 * Cheap line-count height estimate for a row that has never been measured
 * (S1: resume history above the viewport). Deliberately ignores soft wrapping
 * — it is a placeholder until the row is actually mounted/measured, and a
 * wrong value may only be corrected per `correctionIsLegal` (or left until
 * remount). `spacing` is the row's turnSpacing margins; `gap` the inter-part
 * blank line (0 in /compact).
 */
export function estimateMessageHeight(
  message: Pick<Message, 'text' | 'parts'>,
  spacing: { readonly top: number; readonly bottom: number },
  gap: number
): number {
  const parts = message.parts
  let content: number
  if (parts && parts.length > 0) {
    content = gap * (parts.length - 1)
    for (const part of parts) content += partLines(part)
  } else {
    content = lineCount(message.text)
  }
  return Math.min(ESTIMATE_MAX_LINES, Math.max(1, content)) + spacing.top + spacing.bottom
}
