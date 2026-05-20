/**
 * Regression test for ethie's report #2:
 *
 *   ```mermaid
 *   graph LR
 *       user[ethie] -->|asks| packet[packet >w<]
 *   ```
 *
 * Double-click "ethie" → copied "hie]". Selection shifted right by 2
 * at start AND extended past `]` at end.
 *
 * Root cause: code fences render their content inside a `<Box
 * paddingLeft={2}>` nested inside the `<CopySource>` Box. The hit-test
 * reported visualLine/col relative to the OUTER (rangeId) Box, which
 * has rect.x=0 — so the visual col (which includes the +2 padding) was
 * passed through to `simpleOffsetFor`, which adds it to rowStart as if
 * it were a source col. Every char shifted +2 in source space.
 *
 * Fix: `copyPointAt` now reports visualLine/col relative to the
 * INNERMOST non-rangeId rect found during the walk-up. For inline
 * content (no padded wrapper) this equals the rangeId Box's rect, so
 * no behavior change. For code fences / tables / lists / blockquotes
 * (anything wrapped in a padded Box), the col is now relative to the
 * actual rendered content rect — matching `simpleOffsetFor`'s
 * assumption that col=0 maps to start-of-source-line.
 *
 * This test verifies the SLICING is correct end-to-end given the
 * post-fix col reporting. The hit-test-layer test for the col
 * computation lives in copyPointHitTest.test.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest'

import { buildLineStartsFromRows, simpleOffsetFor } from '../offsetMaps.js'
import { registerRange, resetRegistry } from '../registry.js'
import { toCopyText } from '../toCopyText.js'

describe('code fence padding off-by-N (ethie report #2)', () => {
  beforeEach(() => {
    resetRegistry()
  })

  it('selecting "ethie" inside a fence yields exactly "ethie"', () => {
    const blockSource = [
      '```mermaid',
      'graph LR',
      '    user[ethie] -->|asks| packet[packet >w<]',
      '```'
    ].join('\n')

    const lineRows = blockSource.split('\n')
    const rowStarts = buildLineStartsFromRows(lineRows)
    const row2Start = rowStarts[2]!
    // Sanity-check the source layout.
    expect(blockSource[row2Start + 9]).toBe('e')
    expect(blockSource[row2Start + 13]).toBe('e')
    expect(blockSource[row2Start + 14]).toBe(']')

    const rangeId = registerRange({
      msgId: 'm1',
      blockIndex: 1,
      outerSource: blockSource,
      visualLineCount: lineRows.length,
      getOffset: simpleOffsetFor(blockSource, rowStarts)
    })

    // The hit-test gives col=9 (first 'e') for anchor and col=13 (last
    // 'e' — cell-INCLUSIVE) for focus. The BRIDGE in buildCopyTextFromDom
    // does the +1 cell→byte-exclusive bump on the focus before handing
    // to toCopyText (when no sourceOffset is set, which is the case for
    // code fences with no fragments). We simulate that here by passing
    // col=14 as the focus.
    const copied = toCopyText({
      anchor: {
        kind: 'in-range',
        rangeId,
        visualLine: 2,
        col: 9   // first 'e' of ethie, source col 9
      },
      focus: {
        kind: 'in-range',
        rangeId,
        visualLine: 2,
        col: 14  // last 'e' + 1 (bridge bumped from 13 → 14 for end)
      },
      transcript: [{ id: 'm1', order: 0 }]
    })

    expect(copied).toBe('ethie')
  })
})

