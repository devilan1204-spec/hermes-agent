/**
 * window.ts — pure transcript-windowing math (design: docs/plans/
 * opentui-transcript-windowing.md, slice S1). Table-tests the window calc
 * (viewport ± margin intersection over cumulative exact heights), the
 * hysteresis recompute gate, the never-window / bottom-K rules, the
 * null-height estimate fallback, and the correction-legality jank rule.
 */
import { describe, expect, test } from 'vitest'

import type { Message } from '../logic/store.ts'
import {
  computeWindow,
  correctionIsLegal,
  estimateMessageHeight,
  hysteresisFor,
  shouldRecompute,
  type WindowRow
} from '../logic/window.ts'

function row(
  key: number,
  height: number | null,
  opts?: { neverWindow?: boolean; estimate?: number }
): WindowRow<number> {
  const base = { key, height, neverWindow: opts?.neverWindow ?? false }
  return opts?.estimate === undefined ? base : { ...base, estimate: opts.estimate }
}

/** n rows of uniform height h, keyed 0..n-1 (row i spans [i*h, (i+1)*h)). */
function uniform(n: number, h: number): WindowRow<number>[] {
  return Array.from({ length: n }, (_, i) => row(i, h))
}

function mountedKeys(result: { mounted: ReadonlySet<number> }): number[] {
  return [...result.mounted].sort((a, b) => a - b)
}

describe('hysteresisFor', () => {
  test('≥ ¼ viewport, rounded up', () => {
    expect(hysteresisFor(40)).toBe(10)
    expect(hysteresisFor(5)).toBe(2)
    expect(hysteresisFor(4)).toBe(1)
  })

  test('never below 1 row (degenerate viewports)', () => {
    expect(hysteresisFor(0)).toBe(1)
    expect(hysteresisFor(2)).toBe(1)
  })
})

describe('shouldRecompute', () => {
  test('no prior anchor → always recompute', () => {
    expect(shouldRecompute(0, null, 10)).toBe(true)
    expect(shouldRecompute(500, null, 10)).toBe(true)
  })

  test('movement below hysteresis → keep the current window', () => {
    expect(shouldRecompute(108, 100, 10)).toBe(false)
    expect(shouldRecompute(92, 100, 10)).toBe(false)
    expect(shouldRecompute(100, 100, 10)).toBe(false)
  })

  test('movement at/above hysteresis (either direction) → recompute', () => {
    expect(shouldRecompute(110, 100, 10)).toBe(true)
    expect(shouldRecompute(90, 100, 10)).toBe(true)
    expect(shouldRecompute(250, 100, 10)).toBe(true)
  })
})

describe('computeWindow — viewport ± margin intersection', () => {
  // 100 rows × 10 → content height 1000. Viewport 40, margin 40 (1 viewport),
  // scrollTop 480 → window [440, 560). Row i spans [10i, 10i+10).
  const base = { viewportHeight: 40, margin: 40, scrollTop: 480 }

  test('mounts exactly the rows intersecting [scrollTop − margin, scrollTop + viewport + margin)', () => {
    const result = computeWindow({ rows: uniform(100, 10), ...base })
    expect(mountedKeys(result)).toEqual([44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55])
  })

  test('rows merely TOUCHING the window edge are not mounted', () => {
    const result = computeWindow({ rows: uniform(100, 10), ...base })
    // row 43 spans [430, 440) — its bottom touches windowStart 440: out.
    expect(result.mounted.has(43)).toBe(false)
    // row 56 spans [560, 570) — its top touches windowEnd 560: out.
    expect(result.mounted.has(56)).toBe(false)
  })

  test('anchor echoes the scrollTop the window was computed at', () => {
    expect(computeWindow({ rows: uniform(100, 10), ...base }).anchor).toBe(480)
    expect(computeWindow({ rows: [], scrollTop: 7, viewportHeight: 40, margin: 40 }).anchor).toBe(7)
  })

  test('scrolled to the top: window clamps naturally (no negative-row weirdness)', () => {
    const result = computeWindow({ rows: uniform(100, 10), scrollTop: 0, viewportHeight: 40, margin: 40 })
    // window [-40, 80) → rows 0..7
    expect(mountedKeys(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('empty transcript → empty window', () => {
    const result = computeWindow({ rows: [], scrollTop: 0, viewportHeight: 40, margin: 40 })
    expect(result.mounted.size).toBe(0)
  })

  test('everything fits in the window → everything mounted', () => {
    const result = computeWindow({ rows: uniform(5, 2), scrollTop: 0, viewportHeight: 40, margin: 40 })
    expect(mountedKeys(result)).toEqual([0, 1, 2, 3, 4])
  })

  test('works with non-numeric keys (generic)', () => {
    const rows: WindowRow<string>[] = [
      { key: 'a', height: 50, neverWindow: false },
      { key: 'b', height: 50, neverWindow: false },
      { key: 'c', height: 50, neverWindow: false }
    ]
    const result = computeWindow({ rows, scrollTop: 60, viewportHeight: 30, margin: 0 })
    // window [60, 90) → only 'b' ([50, 100)) intersects
    expect([...result.mounted]).toEqual(['b'])
  })
})

describe('computeWindow — never-window and bottom-K rules', () => {
  test('neverWindow rows stay mounted however far outside the window', () => {
    const rows = uniform(100, 10)
    rows[90] = row(90, 10, { neverWindow: true })
    const result = computeWindow({ rows, scrollTop: 0, viewportHeight: 40, margin: 40 })
    expect(result.mounted.has(90)).toBe(true)
    expect(result.mounted.has(89)).toBe(false)
  })

  test('the bottom K rows are always mounted (sticky-bottom region)', () => {
    const result = computeWindow({ rows: uniform(100, 10), scrollTop: 0, viewportHeight: 40, margin: 40, bottomK: 5 })
    expect(mountedKeys(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 95, 96, 97, 98, 99])
  })

  test('bottomK larger than the transcript mounts everything', () => {
    const result = computeWindow({ rows: uniform(10, 10), scrollTop: 0, viewportHeight: 4, margin: 0, bottomK: 50 })
    expect(result.mounted.size).toBe(10)
  })
})

describe('computeWindow — null heights use the estimate', () => {
  test('a per-row estimate stands in for a never-measured height (and shifts later offsets)', () => {
    // row 0 estimated at 100 → row 1 starts at 100; window [100, 110) hits only row 1.
    const rows = [row(0, null, { estimate: 100 }), row(1, 10)]
    const result = computeWindow({ rows, scrollTop: 100, viewportHeight: 10, margin: 0 })
    expect(mountedKeys(result)).toEqual([1])
  })

  test('a recorded height wins over the estimate', () => {
    const rows = [row(0, 10, { estimate: 100 }), row(1, 10)]
    const result = computeWindow({ rows, scrollTop: 100, viewportHeight: 10, margin: 0 })
    // row 0 is REALLY 10 tall → row 1 spans [10, 20): nothing in [100, 110).
    expect(result.mounted.size).toBe(0)
  })

  test('null height with no estimate falls back to fallbackHeight', () => {
    const rows = [row(0, null), row(1, 10)]
    const result = computeWindow({ rows, scrollTop: 0, viewportHeight: 10, margin: 0, fallbackHeight: 100 })
    // row 0 assumed [0, 100) → mounted; row 1 [100, 110) → out of [0, 10).
    expect(mountedKeys(result)).toEqual([0])
  })
})

describe('correctionIsLegal — the jank rule', () => {
  // viewport shows [100, 140)
  const scrollTop = 100
  const viewportHeight = 40

  test.each([true, false])('fully ABOVE the viewport is legal (compensation applies) — atBottom=%s', atBottom => {
    expect(correctionIsLegal(20, 60, scrollTop, viewportHeight, atBottom)).toBe(true)
    // boundary: row bottom touching the viewport top is still fully above
    expect(correctionIsLegal(50, 100, scrollTop, viewportHeight, atBottom)).toBe(true)
  })

  test.each([true, false])('fully BELOW the viewport is legal (invisible) — atBottom=%s', atBottom => {
    expect(correctionIsLegal(150, 170, scrollTop, viewportHeight, atBottom)).toBe(true)
    // boundary: row top touching the viewport bottom is still fully below
    expect(correctionIsLegal(140, 160, scrollTop, viewportHeight, atBottom)).toBe(true)
  })

  test.each([true, false])('any intersection with the viewport is FORBIDDEN — atBottom=%s', atBottom => {
    expect(correctionIsLegal(90, 110, scrollTop, viewportHeight, atBottom)).toBe(false) // clips the top edge
    expect(correctionIsLegal(130, 150, scrollTop, viewportHeight, atBottom)).toBe(false) // clips the bottom edge
    expect(correctionIsLegal(110, 120, scrollTop, viewportHeight, atBottom)).toBe(false) // inside
    expect(correctionIsLegal(90, 150, scrollTop, viewportHeight, atBottom)).toBe(false) // spans the whole viewport
  })
})

describe('estimateMessageHeight — line-count estimate for never-mounted rows', () => {
  const spacing = { top: 2, bottom: 1 }

  test('flat row: newline count + turn spacing', () => {
    expect(estimateMessageHeight({ text: 'hello' }, spacing, 1)).toBe(1 + 3)
    expect(estimateMessageHeight({ text: 'a\nb\nc' }, spacing, 1)).toBe(3 + 3)
  })

  test('empty text still occupies at least one row', () => {
    expect(estimateMessageHeight({ text: '' }, { top: 0, bottom: 0 }, 0)).toBe(1)
  })

  test('parts row: text lines + 1 per collapsed tool/reasoning + inter-part gaps', () => {
    const message: Pick<Message, 'text' | 'parts'> = {
      text: '',
      parts: [
        { type: 'text', id: 'p1', text: 'line1\nline2' },
        { type: 'tool', id: 't1', name: 'terminal', state: 'complete' },
        { type: 'reasoning', id: 'p2', text: 'thought\nover\nlines' }
      ]
    }
    // 2 (text) + 1 (tool header) + 1 (collapsed reasoning) + 2 gaps + 3 spacing
    expect(estimateMessageHeight(message, spacing, 1)).toBe(2 + 1 + 1 + 2 + 3)
  })

  test('text parts strip leading/trailing blank lines (the view does the same)', () => {
    const message: Pick<Message, 'text' | 'parts'> = {
      text: '',
      parts: [{ type: 'text', id: 'p1', text: '\n\nhello\n' }]
    }
    expect(estimateMessageHeight(message, { top: 0, bottom: 0 }, 1)).toBe(1)
  })

  test('compact mode (gap 0, no margins) collapses the chrome', () => {
    const message: Pick<Message, 'text' | 'parts'> = {
      text: '',
      parts: [
        { type: 'text', id: 'p1', text: 'one' },
        { type: 'tool', id: 't1', name: 'terminal', state: 'complete' }
      ]
    }
    expect(estimateMessageHeight(message, { top: 0, bottom: 0 }, 0)).toBe(2)
  })

  test('a pathological wall of text is clamped', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `l${i}`).join('\n')
    expect(estimateMessageHeight({ text }, { top: 0, bottom: 0 }, 0)).toBeLessThanOrEqual(500)
  })
})
