import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'

/**
 * One source-fragment entry attached to an ink-text node's cached layout.
 *
 * After ink-text renders its (possibly multi-segment, possibly wrapped)
 * content, the renderer emits one entry per `<ink-virtual-text>` child
 * with a `copySourceFragment` style. Each entry says "rows[r] cols
 * [colStart, colEnd) on the screen rect render bytes [start, end) of
 * the enclosing copy-source range's outerSource."
 *
 * Multiple entries on the same row are allowed (one per virtual-text
 * child); they're scanned linearly by the copy hit-test for the cell
 * containing (col, row) and `start`/`end` are returned.
 *
 * `verbatim` mirrors the same field on `Styles.copySourceFragment`:
 * verbatim segments map visual col → source byte 1:1 via
 * `start + (col - colStart)`; formatted segments snap to either
 * `start` or `end` based on which half of the segment was clicked.
 */
export type CachedFragment = {
  row: number
  colStart: number
  colEnd: number
  start: number
  end: number
  verbatim: boolean
}

/**
 * Cached layout bounds for each rendered node (used for blit + clearing).
 * `top` is the yoga-local getComputedTop() — stored so ScrollBox viewport
 * culling can skip yoga reads for clean children whose position hasn't
 * shifted (O(dirty) instead of O(mounted) first-pass).
 *
 * `fragments` is set on ink-text nodes whose children carry
 * copySourceFragment styles; it gives the hit-test a per-row, per-col
 * lookup table for byte-exact source mapping. Unset for nodes with no
 * fragment children (the common case).
 */
export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
  fragments?: CachedFragment[]
}

export const nodeCache = new WeakMap<DOMElement, CachedLayout>()

/** Rects of removed children that need clearing on next render */
export const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

/**
 * Set when a pendingClear is added for an absolute-positioned node.
 * Signals renderer to disable blit for the next frame: the removed node
 * may have painted over non-siblings (e.g. an overlay over a ScrollBox
 * earlier in tree order), so their blits from prevScreen would restore
 * the overlay's pixels. Normal-flow removals are already handled by
 * hasRemovedChild at the parent level; only absolute positioning paints
 * cross-subtree. Reset at the start of each render.
 */
let absoluteNodeRemoved = false

export function addPendingClear(parent: DOMElement, rect: Rectangle, isAbsolute: boolean): void {
  const existing = pendingClears.get(parent)

  if (existing) {
    existing.push(rect)
  } else {
    pendingClears.set(parent, [rect])
  }

  if (isAbsolute) {
    absoluteNodeRemoved = true
  }
}

export function consumeAbsoluteRemovedFlag(): boolean {
  const had = absoluteNodeRemoved
  absoluteNodeRemoved = false

  return had
}
