import { describe, expect, it } from 'vitest'

import {
  CellWidth,
  CharPool,
  CopySourcePool,
  createScreen,
  HyperlinkPool,
  markCopySourceRegion,
  setCellAt,
  StylePool
} from './screen.js'
import { createSelectionState, getSelectedText, startSelection, updateSelection } from './selection.js'

// Set up a screen rendered with **bold** stripped to "bold" + a copy-source
// region covering those cells. The on-screen render is `bold` (4 cells); the
// copy-source pool entry is the raw markdown `**bold**` (8 chars).
function screenWithCopySource(rendered: string, source: string, atCol = 0, atRow = 0) {
  const styles = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const copySourcePool = new CopySourcePool()
  const screen = createScreen(20, 4, styles, charPool, hyperlinkPool, copySourcePool)

  for (let i = 0; i < rendered.length; i++) {
    setCellAt(screen, atCol + i, atRow, {
      char: rendered[i]!,
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })
  }

  const id = copySourcePool.intern(source)
  markCopySourceRegion(screen, atCol, atRow, rendered.length, 1, id)

  return { screen, source, rendered, copySourcePool }
}

describe('getSelectedText copy-source override', () => {
  it('falls back to rendered text when no copy source is set', () => {
    const styles = new StylePool()
    const screen = createScreen(10, 1, styles, new CharPool(), new HyperlinkPool())

    setCellAt(screen, 0, 0, {
      char: 'a',
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })
    setCellAt(screen, 1, 0, {
      char: 'b',
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 9, 0)

    expect(getSelectedText(sel, screen)).toBe('ab')
  })

  it('substitutes the source string when the selection fully covers the region', () => {
    // rendered "bold" at cols 0..3, source "**bold**"
    const { screen } = screenWithCopySource('bold', '**bold**')

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 3, 0)

    expect(getSelectedText(sel, screen)).toBe('**bold**')
  })

  it('substitutes when the selection rect is wider than the region (still fully covers it)', () => {
    const { screen } = screenWithCopySource('bold', '**bold**', 2)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 0)

    // Selection covers cols 0..19 of row 0; region lives at cols 2..5.
    // All region cells inside selection → substitute.
    expect(getSelectedText(sel, screen)).toBe('**bold**')
  })

  it('falls back to rendered text when only part of the region is selected', () => {
    // Source `**hello**` rendered as `hello` at cols 0..4.
    // Select only cols 1..3 (the inside of the rendered word).
    const { screen } = screenWithCopySource('hello', '**hello**')

    const sel = createSelectionState()
    startSelection(sel, 1, 0)
    updateSelection(sel, 3, 0)

    // Region's leftmost cell (col 0) is OUTSIDE the selection → partial,
    // fall back to rendered cells. Behavior intentional in v1: there's no
    // safe sub-mapping from rendered "ell" back to the markdown source.
    expect(getSelectedText(sel, screen)).toBe('ell')
  })

  it('concatenates multiple fully-covered regions on different rows', () => {
    const styles = new StylePool()
    const charPool = new CharPool()
    const copySourcePool = new CopySourcePool()
    const screen = createScreen(20, 4, styles, charPool, new HyperlinkPool(), copySourcePool)

    // Row 0: rendered "bold" / source "**bold**"
    for (let i = 0; i < 4; i++) {
      setCellAt(screen, i, 0, {
        char: 'bold'[i]!,
        hyperlink: undefined,
        styleId: screen.emptyStyleId,
        width: CellWidth.Narrow
      })
    }

    const id1 = copySourcePool.intern('**bold**')
    markCopySourceRegion(screen, 0, 0, 4, 1, id1)

    // Row 1: rendered "italic" / source "*italic*"
    for (let i = 0; i < 6; i++) {
      setCellAt(screen, i, 1, {
        char: 'italic'[i]!,
        hyperlink: undefined,
        styleId: screen.emptyStyleId,
        width: CellWidth.Narrow
      })
    }

    const id2 = copySourcePool.intern('*italic*')
    markCopySourceRegion(screen, 0, 1, 6, 1, id2)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 1)

    expect(getSelectedText(sel, screen)).toBe('**bold**\n*italic*')
  })

  it('emits each region exactly once even though it spans multiple rows', () => {
    const styles = new StylePool()
    const charPool = new CharPool()
    const copySourcePool = new CopySourcePool()
    const screen = createScreen(20, 4, styles, charPool, new HyperlinkPool(), copySourcePool)

    // Multi-row region: source spans rows 0..2, rendered as "abc" on each
    // row. Source string is the original markdown block, e.g. a code fence.
    const source = '```js\nconst x = 1\n```'
    const id = copySourcePool.intern(source)

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        setCellAt(screen, col, row, {
          char: 'abc'[col]!,
          hyperlink: undefined,
          styleId: screen.emptyStyleId,
          width: CellWidth.Narrow
        })
      }
    }

    markCopySourceRegion(screen, 0, 0, 3, 3, id)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 2)

    // Source emitted ONCE — not three times despite spanning 3 rows.
    expect(getSelectedText(sel, screen)).toBe(source)
  })

  it('mixes regions and unmarked cells in the same selection', () => {
    const styles = new StylePool()
    const charPool = new CharPool()
    const copySourcePool = new CopySourcePool()
    const screen = createScreen(20, 4, styles, charPool, new HyperlinkPool(), copySourcePool)

    // Row 0: plain text "hi" at cols 0..1 (no copy source)
    setCellAt(screen, 0, 0, {
      char: 'h',
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })
    setCellAt(screen, 1, 0, {
      char: 'i',
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })

    // Row 1: rendered "bold" / source "**bold**"
    for (let i = 0; i < 4; i++) {
      setCellAt(screen, i, 1, {
        char: 'bold'[i]!,
        hyperlink: undefined,
        styleId: screen.emptyStyleId,
        width: CellWidth.Narrow
      })
    }

    const id = copySourcePool.intern('**bold**')
    markCopySourceRegion(screen, 0, 1, 4, 1, id)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 1)

    expect(getSelectedText(sel, screen)).toBe('hi\n**bold**')
  })

  it('treats mixed copy-source IDs in a single row as fall-back to rendered', () => {
    const styles = new StylePool()
    const charPool = new CharPool()
    const copySourcePool = new CopySourcePool()
    const screen = createScreen(20, 4, styles, charPool, new HyperlinkPool(), copySourcePool)

    // Two different regions on the same row, side by side.
    for (let i = 0; i < 4; i++) {
      setCellAt(screen, i, 0, {
        char: 'abcd'[i]!,
        hyperlink: undefined,
        styleId: screen.emptyStyleId,
        width: CellWidth.Narrow
      })
    }

    const idA = copySourcePool.intern('**ab**')
    const idB = copySourcePool.intern('**cd**')
    markCopySourceRegion(screen, 0, 0, 2, 1, idA)
    markCopySourceRegion(screen, 2, 0, 2, 1, idB)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 3, 0)

    // Both regions fully covered → both substitute, joined with newline
    // (each region starts a new logical line in copy output).
    expect(getSelectedText(sel, screen)).toBe('**ab**\n**cd**')
  })

  it('skips substitution when a region extends outside the selection rect', () => {
    const styles = new StylePool()
    const charPool = new CharPool()
    const copySourcePool = new CopySourcePool()
    const screen = createScreen(20, 4, styles, charPool, new HyperlinkPool(), copySourcePool)

    // Region spans rows 0..1, but the user selects only row 0.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        setCellAt(screen, col, row, {
          char: 'abc'[col]!,
          hyperlink: undefined,
          styleId: screen.emptyStyleId,
          width: CellWidth.Narrow
        })
      }
    }

    const id = copySourcePool.intern('source-spans-2-rows')
    markCopySourceRegion(screen, 0, 0, 3, 2, id)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 0)

    // Region's row 1 is outside selection → partial → fall back to cells.
    expect(getSelectedText(sel, screen)).toBe('abc')
  })
})
