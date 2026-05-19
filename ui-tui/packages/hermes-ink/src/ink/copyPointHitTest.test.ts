import { describe, expect, it } from 'vitest'

import { copyPointAt } from './copyPointHitTest.js'
import { appendChildNode, createNode, type DOMElement } from './dom.js'
import { nodeCache } from './node-cache.js'

/**
 * Unit tests for `copyPointAt` — specifically the gap-adjacency
 * resolution path (`findAdjacentRanges`).
 *
 * Bug fixed here: `findAdjacentRanges` had `afterRangeId` and
 * `beforeRangeId` swapped — when a click landed in a blank row
 * between two ranges, the resulting SelectionPoint reported the
 * range ABOVE as `beforeRangeId` and the range BELOW as
 * `afterRangeId`, which is the opposite of the convention used
 * everywhere else in the copy-source pipeline:
 *
 *   - `afterRangeId` = the range the gap comes AFTER (above)
 *   - `beforeRangeId` = the range the gap comes BEFORE (below)
 *
 * Symptom: selecting from the blank line above a table to the blank
 * line below it would copy the entire message instead of just the
 * table (because reducePoint resolved both gap endpoints to the
 * wrong side and the resulting slice window grew unbounded).
 */
describe('copyPointAt gap adjacency', () => {
  /**
   * Build a minimal Ink-style DOM with N range-tagged boxes stacked
   * vertically, each at a specified y/height. Returns the root so
   * `copyPointAt(root, col, row)` can probe it.
   */
  function buildRangeStack(
    ranges: ReadonlyArray<{ id: number; y: number; height: number }>
  ): DOMElement {
    const root = createNode('ink-root')

    // Root rect must cover everything so hitDeepest descends.
    const totalHeight = ranges.reduce(
      (acc, r) => Math.max(acc, r.y + r.height),
      0
    )

    nodeCache.set(root, { x: 0, y: 0, width: 100, height: totalHeight })

    for (const range of ranges) {
      const box = createNode('ink-box')
      box.style = { copyRangeId: range.id } as DOMElement['style']
      nodeCache.set(box, { x: 0, y: range.y, width: 100, height: range.height })
      appendChildNode(root, box)
    }

    return root
  }

  it('click in blank gap between two ranges: afterRangeId=above, beforeRangeId=below', () => {
    // Range 1 occupies rows 0-1. Gap at row 2. Range 2 occupies rows 3-4.
    const root = buildRangeStack([
      { id: 1, y: 0, height: 2 },
      { id: 2, y: 3, height: 2 }
    ])

    // Click at row 2, col 0 — but col 0 IS inside the root rect, so
    // hitDeepest will find the root and walk back without entering
    // either range box (their rects don't cover row 2). The walk-up
    // loop in copyPointAt finds no tagged ancestor → falls through
    // to findAdjacentRanges.
    const result = copyPointAt(root, 50, 2)
    expect(result.kind).toBe('gap')

    if (result.kind === 'gap') {
      // The gap is AFTER range 1 (above) and BEFORE range 2 (below).
      expect(result.afterRangeId).toBe(1)
      expect(result.beforeRangeId).toBe(2)
    }
  })

  it('click below all ranges: only afterRangeId set (to the last range above)', () => {
    const root = buildRangeStack([
      { id: 1, y: 0, height: 2 },
      { id: 2, y: 3, height: 2 }
    ])

    // Make root span further down so hitDeepest succeeds.
    nodeCache.set(root, { x: 0, y: 0, width: 100, height: 10 })

    const result = copyPointAt(root, 50, 8)
    expect(result.kind).toBe('gap')

    if (result.kind === 'gap') {
      expect(result.afterRangeId).toBe(2) // last range above
      expect(result.beforeRangeId).toBeNull()
    }
  })

  it('click above all ranges: only beforeRangeId set (to the first range below)', () => {
    const root = buildRangeStack([
      { id: 1, y: 2, height: 2 },
      { id: 2, y: 5, height: 2 }
    ])

    const result = copyPointAt(root, 50, 0)
    expect(result.kind).toBe('gap')

    if (result.kind === 'gap') {
      expect(result.afterRangeId).toBeNull()
      expect(result.beforeRangeId).toBe(1) // first range below
    }
  })

  it('ties broken by smaller rangeId (document order proxy)', () => {
    // Two ranges, both 2 rows above the click. The one with the
    // smaller id (= earlier mount order) wins.
    const root = buildRangeStack([
      { id: 5, y: 0, height: 1 },
      { id: 3, y: 0, height: 1 }
    ])

    nodeCache.set(root, { x: 0, y: 0, width: 100, height: 10 })

    const result = copyPointAt(root, 50, 3)
    expect(result.kind).toBe('gap')

    if (result.kind === 'gap') {
      expect(result.afterRangeId).toBe(3) // smaller id wins tie
    }
  })

  it('click inside a tagged range: returns in-range, not gap', () => {
    const root = buildRangeStack([
      { id: 1, y: 0, height: 3 }
    ])

    const result = copyPointAt(root, 50, 1)
    expect(result.kind).toBe('in-range')

    if (result.kind === 'in-range') {
      expect(result.rangeId).toBe(1)
    }
  })

  it('wrap-continuation row: per-row fragment gives byte-exact sourceOffset, not whole-line', () => {
    // Regression for: dragging from mid-row 0 to col 0 of row 1 (a
    // wrap-continuation row of a single source line) was copying the
    // WHOLE source line because the block's visualLineCount was the
    // SOURCE-line count (1), not the WRAPPED count (2). visualLine=1
    // therefore clamped pointToOffset to outerSource.length.
    //
    // The fix: per-row fragments on the ink-text node carry the
    // source-byte slice for each wrapped row, so the hit-test on
    // continuation rows returns `sourceOffset` and toCopyText skips
    // the buggy pointToOffset path entirely.
    const root = createNode('ink-root')
    nodeCache.set(root, { x: 0, y: 0, width: 15, height: 2 })

    const box = createNode('ink-box')
    box.style = { copyRangeId: 7 } as DOMElement['style']
    nodeCache.set(box, { x: 0, y: 0, width: 15, height: 2 })
    appendChildNode(root, box)

    const text = createNode('ink-text')
    nodeCache.set(text, {
      x: 0,
      y: 0,
      width: 15,
      height: 2,
      // "the quick brown" on row 0 [source 0..15) +
      // "fox jumps over"  on row 1 [source 16..30) (the space at byte
      // 15 is wrap-trimmed away).
      fragments: [
        { row: 0, colStart: 0, colEnd: 15, start: 0, end: 15, verbatim: true },
        { row: 1, colStart: 0, colEnd: 14, start: 16, end: 30, verbatim: true }
      ]
    })
    appendChildNode(box, text)

    // Click at col 0 of the wrap-continuation row.
    const result = copyPointAt(root, 0, 1)
    expect(result.kind).toBe('in-range')

    if (result.kind === 'in-range') {
      expect(result.rangeId).toBe(7)
      // Critical: sourceOffset is set so toCopyText bypasses pointToOffset.
      // Without per-row fragments this was undefined and pointToOffset
      // returned outerSource.length, leaking the whole line.
      expect(result.sourceOffset).toBe(16)
    }
  })

  it('triple-click sets focus at col=width-1 OUTSIDE content rect → falls back to same-row in-range', () => {
    // Reproduces the user-reported triple-click bug. selectLineAt sets
    // anchor=(0, row) focus=(width-1, row) using the SCREEN width, not
    // the content rect. When the message body is narrower than the
    // screen (typical: gutter on left, padding on right), focus lands
    // OUTSIDE the CopySource Box rect.
    //
    // hitDeepest returns null for col=119 if the box only spans col
    // 4..80. Without the same-row fallback, copyPointAt would return
    // a gap with no adjacency (the only range is on the same row, and
    // findAdjacentRanges only finds STRICTLY above/below ranges).
    // resolvePoint would then return null and toCopyText would emit
    // empty text.
    //
    // Fix: same-row fallback returns in-range with col clamped to the
    // box's right edge (or left edge if click was to the box's left).
    const root = createNode('ink-root')
    nodeCache.set(root, { x: 0, y: 0, width: 120, height: 5 })

    // Message body box: not full width. Starts at col 4 (gutter), ends
    // at col 80. So col=119 (the triple-click focus) is OUTSIDE.
    const body = createNode('ink-box')
    body.style = { copyRangeId: 42 } as DOMElement['style']
    nodeCache.set(body, { x: 4, y: 1, width: 76, height: 1 })
    appendChildNode(root, body)

    const text = createNode('ink-text')
    nodeCache.set(text, { x: 4, y: 1, width: 76, height: 1 })
    appendChildNode(body, text)

    // Anchor click at col=0 row=1 — LEFT of the body box (in the gutter).
    // Without fix: gap with no adjacency. With fix: in-range, col=0
    // (clamped to body box's left edge, since col=0 - rect.x=4 < 0).
    const anchor = copyPointAt(root, 0, 1)
    expect(anchor.kind).toBe('in-range')

    if (anchor.kind === 'in-range') {
      expect(anchor.rangeId).toBe(42)
      expect(anchor.visualLine).toBe(0)
      expect(anchor.col).toBe(0)
    }

    // Focus click at col=119 row=1 — right edge of the screen, way past
    // body box's x+width=80. Without fix: empty gap. With fix:
    // in-range, col=75 (clamped to box.width - 1).
    const focus = copyPointAt(root, 119, 1)
    expect(focus.kind).toBe('in-range')

    if (focus.kind === 'in-range') {
      expect(focus.rangeId).toBe(42)
      expect(focus.visualLine).toBe(0)
      // col clamped to box.width - 1 = 76 - 1 = 75.
      expect(focus.col).toBe(75)
    }
  })

  it('same-row fallback picks the SMALLEST tagged box when ranges are nested', () => {
    // When multiple tagged boxes straddle the click row (e.g. a msg
    // box containing a fence block), the fallback should pick the
    // INNERMOST (smallest-area) one — that's what the user clicked.
    const root = createNode('ink-root')
    nodeCache.set(root, { x: 0, y: 0, width: 120, height: 10 })

    // Outer msg box (large area).
    const msgBox = createNode('ink-box')
    msgBox.style = { copyRangeId: 100 } as DOMElement['style']
    nodeCache.set(msgBox, { x: 4, y: 1, width: 76, height: 5 })
    appendChildNode(root, msgBox)

    // Inner fence block (smaller area, nested inside msg).
    const fenceBox = createNode('ink-box')
    fenceBox.style = { copyRangeId: 101 } as DOMElement['style']
    nodeCache.set(fenceBox, { x: 6, y: 2, width: 70, height: 3 })
    appendChildNode(msgBox, fenceBox)

    // Click in the gutter on a row inside the fence.
    const result = copyPointAt(root, 0, 3)
    expect(result.kind).toBe('in-range')

    if (result.kind === 'in-range') {
      // Should pick the smaller fence box, not the outer msg box.
      expect(result.rangeId).toBe(101)
    }
  })

  it('wrap-continuation row with NO fragments: degrades to in-range with bad visualLine (documents the regression)', () => {
    // What happens when the renderer didn't emit fragments for the
    // wrap (e.g. paragraph rendered without the MdInline wrap()
    // wrapper, or fragments were stale-evicted). The hit-test still
    // returns in-range, but with `visualLine = row - rect.y` = the
    // visual row index relative to the ink-text rect.
    //
    // For a wrapped block whose CopySource was registered with
    // visualLineCount = source-line-count (1, not the wrapped count
    // 2), pointToOffset(visualLine=1, ...) clamps to outerSource.length
    // and toCopyText emits the whole source line. This test pins down
    // exactly what the host receives in that scenario so we can spot
    // it from logs.
    const root = createNode('ink-root')
    nodeCache.set(root, { x: 0, y: 0, width: 15, height: 2 })

    const box = createNode('ink-box')
    box.style = { copyRangeId: 11 } as DOMElement['style']
    nodeCache.set(box, { x: 0, y: 0, width: 15, height: 2 })
    appendChildNode(root, box)

    const text = createNode('ink-text')
    // NOTE: no `fragments` set — simulating the broken state.
    nodeCache.set(text, { x: 0, y: 0, width: 15, height: 2 })
    appendChildNode(box, text)

    const result = copyPointAt(root, 0, 1)
    expect(result.kind).toBe('in-range')

    if (result.kind === 'in-range') {
      expect(result.rangeId).toBe(11)
      expect(result.visualLine).toBe(1)
      expect(result.col).toBe(0)
      // sourceOffset is undefined → falls through to the
      // pointToOffset(visualLine=1, col=0) path in toCopyText, which
      // clamps to outerSource.length when visualLineCount=1.
      expect(result.sourceOffset).toBeUndefined()
    }
  })

  it('wrap-continuation row mid-fragment: sourceOffset uses verbatim cell→byte math', () => {
    // Same wrapped paragraph, click at col 5 of row 1 → should give
    // source byte 21 (16 + 5), not the whole-line clamp.
    const root = createNode('ink-root')
    nodeCache.set(root, { x: 0, y: 0, width: 15, height: 2 })

    const box = createNode('ink-box')
    box.style = { copyRangeId: 9 } as DOMElement['style']
    nodeCache.set(box, { x: 0, y: 0, width: 15, height: 2 })
    appendChildNode(root, box)

    const text = createNode('ink-text')
    nodeCache.set(text, {
      x: 0,
      y: 0,
      width: 15,
      height: 2,
      fragments: [
        { row: 0, colStart: 0, colEnd: 15, start: 0, end: 15, verbatim: true },
        { row: 1, colStart: 0, colEnd: 14, start: 16, end: 30, verbatim: true }
      ]
    })
    appendChildNode(box, text)

    const result = copyPointAt(root, 5, 1)
    expect(result.kind).toBe('in-range')

    if (result.kind === 'in-range') {
      expect(result.sourceOffset).toBe(21)
    }
  })
})
