/**
 * Tool renderer tests (Epic 2.2). Headless frames through the real App tree:
 * the registry's default renderer turns args into LABELED FIELDS — the
 * acceptance gate asserts NO raw JSON syntax (`{"` / `":`) ever reaches the
 * frame for tool parts, collapsed or expanded — and delegate_task carries the
 * Ink-parity "(/agents to monitor)" hint. Expansion goes through the REAL
 * mouse path: mockMouse clicks the header row (found by scanning the frame).
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

/** Seed a settled assistant turn containing exactly the given tool call. */
function seedTool(store: Store, start: Record<string, unknown>, complete: Record<string, unknown>) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ type: 'tool.start', payload: start })
  store.apply({ type: 'tool.complete', payload: complete })
  store.apply({ type: 'message.complete' })
}

async function mountApp(store: Store, width = 80, height = 24): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width, height }
  )
}

/** Click the tool header row (the line containing `name`) to expand/collapse. */
async function clickHeader(probe: RenderProbe, name: string): Promise<void> {
  const frame = await probe.waitForFrame(f => f.includes(name))
  const rows = frame.split('\n')
  const y = rows.findIndex(line => line.includes(name))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = (rows[y] ?? '').indexOf(name)
  await probe.click(x, y)
}

describe('tool renderer registry — labeled-args default (Epic 2.2)', () => {
  test('an unmapped MCP-ish tool with nested args renders labeled fields, never raw JSON', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'm1', name: 'mcp_lookup' },
      {
        tool_id: 'm1',
        name: 'mcp_lookup',
        args: {
          query: 'hermes agent',
          options: { depth: 2, mode: 'fast', cache: true },
          limit: 5
        },
        duration_s: 0.4,
        result_text: 'one result found'
      }
    )

    const probe = await mountApp(store)
    try {
      // collapsed: header only, and already no JSON syntax anywhere
      const collapsed = await probe.waitForFrame(f => f.includes('mcp_lookup'))
      expect(collapsed).not.toContain('{"')
      expect(collapsed).not.toContain('":')

      await clickHeader(probe, 'mcp_lookup')
      const expanded = await probe.waitForFrame(f => f.includes('query'))
      // labeled key → value rows (string verbatim, number via String)
      expect(expanded).toContain('query')
      expect(expanded).toContain('hermes agent')
      expect(expanded).toContain('limit')
      expect(expanded).toContain('5')
      // nested object summarized, not dumped
      expect(expanded).toContain('options')
      expect(expanded).toContain('(3 fields)')
      // the output body still renders (envelope-stripped store text)
      expect(expanded).toContain('one result found')
      // THE acceptance gate: no raw JSON syntax in the tool render
      expect(expanded).not.toContain('{"')
      expect(expanded).not.toContain('":')
      expect(expanded).not.toContain('depth') // nested internals stay summarized
    } finally {
      probe.destroy()
    }
  })

  test('delegate_task gets the default renderer plus the muted "(/agents to monitor)" hint', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'd1', name: 'delegate_task', context: 'research opentui' },
      {
        tool_id: 'd1',
        name: 'delegate_task',
        args: { goal: 'research opentui', model: 'fast' },
        result_text: 'spawned'
      }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('(/agents to monitor)'))
      expect(frame).toContain('delegate_task')
      expect(frame).toContain('research opentui') // primary-arg preview still leads
      expect(frame).not.toContain('{"') // hint or not — still no raw JSON
    } finally {
      probe.destroy()
    }
  })
})
