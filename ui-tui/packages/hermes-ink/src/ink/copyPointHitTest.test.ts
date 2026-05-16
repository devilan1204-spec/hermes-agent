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
})
