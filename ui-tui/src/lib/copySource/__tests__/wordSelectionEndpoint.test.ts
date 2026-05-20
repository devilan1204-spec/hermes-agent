/**
 * Regression test for ethie's report: double-click "might" in a callout
 * (`> [!WARNING]\n> things might break if u skip this`) copied "migh" —
 * one char short. Same on drag-select.
 *
 * Root cause: cell-INCLUSIVE selection bounds (anchor/focus point AT
 * the cell, not past it) crossed with EXCLUSIVE slice semantics in
 * toCopyText. The hit-test for verbatim fragments returned
 * `f.start + (localCol - f.colStart)` — the START byte of the clicked
 * cell — for both endpoints, dropping one char off the right edge of
 * every selection.
 *
 * Fix: `copyPointAt` now takes an `endpoint: 'start' | 'end'` arg.
 * The buildCopyTextFromDom bridge passes `'end'` for the focus, and the
 * verbatim cell→byte math bumps by 1 (clamped to fragment end) so the
 * end-byte points PAST the last selected cell. Slice semantics then
 * work out exactly.
 */
import { describe, expect, it, beforeEach } from 'vitest'

import { simpleOffsetFor } from '../offsetMaps.js'
import { registerRange, resetRegistry } from '../registry.js'
import { toCopyText } from '../toCopyText.js'

describe('word selection endpoint off-by-one (regression)', () => {
  beforeEach(() => {
    resetRegistry()
  })

  it('focus on last cell of "might" with endpoint="end" math yields "might"', () => {
    // Source layout:
    //   "things might break"
    //    0      7    13
    //    t h i n g s _ m i g h t _ b r e a k
    //    0 1 2 3 4 5 6 7 8 9 ...
    const SOURCE = 'things might break'
    const MIGHT_START = 7
    const MIGHT_END = 12

    const rangeId = registerRange({
      msgId: 'm1',
      blockIndex: 1,
      outerSource: SOURCE,
      visualLineCount: 1,
      getOffset: simpleOffsetFor(SOURCE, new Uint32Array([0]))
    })

    // Simulate the post-fix verbatim cell→byte math from
    // copyPointHitTest.ts. The fragment spans cells [0, SOURCE.length)
    // and source bytes [0, SOURCE.length).
    //   anchor (endpoint='start'): bump=0 → f.start + cellsIn
    //   focus  (endpoint='end'):   bump=1 → f.start + cellsIn + 1, clamped
    const cellToByte = (col: number, endpoint: 'start' | 'end'): number => {
      const cellsIn = col - 0
      const bump = endpoint === 'end' ? 1 : 0
      const len = SOURCE.length

      return 0 + Math.min(cellsIn + bump, len)
    }

    // anchor: cell 7 ('m'), endpoint='start' → 7
    const anchorOffset = cellToByte(7, 'start')
    // focus: cell 11 ('t' — last cell of 'might'), endpoint='end' → 12
    const focusOffset = cellToByte(11, 'end')

    expect(anchorOffset).toBe(MIGHT_START)
    expect(focusOffset).toBe(MIGHT_END)

    const copied = toCopyText({
      anchor: { kind: 'in-range', rangeId, visualLine: 0, col: 7, sourceOffset: anchorOffset },
      focus: { kind: 'in-range', rangeId, visualLine: 0, col: 11, sourceOffset: focusOffset },
      transcript: [{ id: 'm1', order: 0 }]
    })

    expect(copied).toBe('might')
  })

  it('focus past last cell of fragment clamps to fragment end (no over-read)', () => {
    // Click on the very last cell with endpoint='end' should land
    // EXACTLY on fragment end (not over).
    const SOURCE = 'might'
    const rangeId = registerRange({
      msgId: 'm2',
      blockIndex: 1,
      outerSource: SOURCE,
      visualLineCount: 1,
      getOffset: simpleOffsetFor(SOURCE, new Uint32Array([0]))
    })

    const cellToByte = (col: number, endpoint: 'start' | 'end'): number => {
      const cellsIn = col - 0
      const bump = endpoint === 'end' ? 1 : 0
      const len = SOURCE.length

      return 0 + Math.min(cellsIn + bump, len)
    }

    // Even with bump, clamped at fragment end — no over-read.
    expect(cellToByte(4, 'end')).toBe(5)
    expect(cellToByte(4, 'start')).toBe(4)

    const copied = toCopyText({
      anchor: { kind: 'in-range', rangeId, visualLine: 0, col: 0, sourceOffset: 0 },
      focus: { kind: 'in-range', rangeId, visualLine: 0, col: 4, sourceOffset: 5 },
      transcript: [{ id: 'm2', order: 0 }]
    })

    expect(copied).toBe('might')
  })

  it('anchor unchanged: endpoint="start" still gives cell-start byte', () => {
    // Sanity: the fix must NOT shift anchor-side semantics.
    const SOURCE = 'things might break'
    const cellToByte = (col: number, endpoint: 'start' | 'end'): number => {
      const cellsIn = col - 0
      const bump = endpoint === 'end' ? 1 : 0
      const len = SOURCE.length

      return 0 + Math.min(cellsIn + bump, len)
    }

    // Anchor on 'm' of "might" → cell 7 → byte 7
    expect(cellToByte(7, 'start')).toBe(7)
    // (Same call with endpoint='end' would give 8 — the boundary clarifies
    // why threading endpoint explicitly matters.)
    expect(cellToByte(7, 'end')).toBe(8)
  })
})

