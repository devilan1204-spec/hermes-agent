/**
 * Transcript windowing S1 — headless integration (view/transcript.tsx +
 * logic/window.ts behind HERMES_TUI_WINDOWING). Proves, against the REAL
 * renderer tree:
 *   - out-of-window rows are actually UNMOUNTED (far fewer live renderables
 *     than the unwindowed tree — the spacer is 1 box, the row was ~3+ texts),
 *   - spacers are EXACT-height (total scrollHeight identical ON vs OFF — the
 *     zero-jank invariant),
 *   - scrolling far away REMOUNTS spaced-out rows (content paints again),
 *   - the flag OFF renders the legacy tree (no wrappers, everything mounted).
 */
import { ScrollBoxRenderable, type Renderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { afterEach, describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { ThemeProvider } from '../view/theme.tsx'
import { Transcript } from '../view/transcript.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

const ENV_KEY = 'HERMES_TUI_WINDOWING'
const envBefore = process.env[ENV_KEY]
afterEach(() => {
  if (envBefore === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = envBefore
})

/** Seed `n` settled one-line system rows (flat text — no async markdown). */
function seedRows(n: number): Store {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  for (let i = 0; i < n; i++) store.pushSystem(`row-${i} marker`)
  return store
}

function walk(node: Renderable, visit: (n: Renderable) => void): void {
  visit(node)
  for (const child of node.getChildren()) walk(child, visit)
}

interface Mounted {
  probe: RenderProbe
  count: () => number
  scrollbox: () => ScrollBoxRenderable
}

async function mountTranscript(store: Store, windowing: '1' | '0'): Promise<Mounted> {
  process.env[ENV_KEY] = windowing
  let root: Renderable | undefined
  function Grab() {
    root = useRenderer().root
    return null
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <Grab />
        <Transcript store={store} />
      </ThemeProvider>
    ),
    { width: 50, height: 12 }
  )
  // several passes: layout (heights recorded) → frame tick (window computed)
  // → swap render — the driver is the renderer frame callback.
  for (let i = 0; i < 6; i++) await probe.settle()
  const count = () => {
    let n = 0
    if (root) walk(root, () => n++)
    return n
  }
  const scrollbox = () => {
    let sb: ScrollBoxRenderable | undefined
    if (root) {
      walk(root, node => {
        if (node instanceof ScrollBoxRenderable) sb ??= node
      })
    }
    if (!sb) throw new Error('no scrollbox in the mounted tree')
    return sb
  }
  return { probe, count, scrollbox }
}

const ROWS = 120

describe('transcript windowing (HERMES_TUI_WINDOWING) — S1 machinery', () => {
  test('out-of-window rows unmount into exact-height spacers; OFF keeps the full tree', async () => {
    const on = await mountTranscript(seedRows(ROWS), '1')
    const off = await mountTranscript(seedRows(ROWS), '0')
    try {
      // sticky-bottom: both variants sit pinned at the bottom showing the tail.
      expect(on.probe.frame()).toContain(`row-${ROWS - 1} marker`)
      expect(off.probe.frame()).toContain(`row-${ROWS - 1} marker`)

      // ZERO-JANK INVARIANT: spacers are exact-height — the windowed content
      // is precisely as tall as the fully-mounted content.
      expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
      expect(on.scrollbox().scrollHeight).toBeGreaterThan(100) // sanity: way past the viewport

      // The window actually sheds renderables: ~viewport±margin + bottom-30
      // stay mounted out of 120 rows; the rest are 1-box spacers. The legacy
      // tree keeps every row's text renderables alive.
      expect(on.count()).toBeLessThan(off.count() * 0.6)
    } finally {
      on.probe.destroy()
      off.probe.destroy()
    }
  })

  test('scrolling far from the bottom remounts spaced-out rows (and the frame paints them)', async () => {
    const on = await mountTranscript(seedRows(ROWS), '1')
    try {
      const sb = on.scrollbox()
      // row-0 is far outside the bottom window: not painted while pinned.
      expect(on.probe.frame()).not.toContain('row-0 marker')
      sb.scrollTo(0)
      for (let i = 0; i < 6; i++) await on.probe.settle()
      expect(sb.scrollTop).toBe(0)
      expect(on.probe.frame()).toContain('row-0 marker')
    } finally {
      on.probe.destroy()
    }
  })
})
