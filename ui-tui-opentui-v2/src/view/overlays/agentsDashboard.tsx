/**
 * AgentsDashboard — the delegation/subagents view (spec §2b; Ink `agentsOverlay`).
 * Full-height overlay (replaces transcript+composer) listing the subagents tracked
 * from the `subagent.*` event stream, indented by `depth` (a flat tree). Scroll via
 * useKeyboard→scrollBy/scrollTo; Esc/q close. §8 #2 scrollbox gotchas.
 */
import { type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { For, Show } from 'solid-js'

import type { SubagentInfo } from '../../logic/store.ts'
import { useTheme } from '../theme.tsx'

const PAGE = 10

function statusColor(status: string, theme: ReturnType<typeof useTheme>): string {
  const c = theme().color
  if (status === 'complete') return c.ok
  if (status === 'tool' || status === 'working') return c.accent
  if (status.includes('error') || status === 'failed') return c.error
  return c.warn
}

export function AgentsDashboard(props: { subagents: SubagentInfo[]; onClose: () => void }) {
  const theme = useTheme()
  let box: ScrollBoxRenderable | undefined

  useKeyboard(key => {
    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
      props.onClose()
      return
    }
    if (!box) return
    if (key.name === 'up') box.scrollBy(-1)
    else if (key.name === 'down') box.scrollBy(1)
    else if (key.name === 'pageup') box.scrollBy(-PAGE)
    else if (key.name === 'pagedown') box.scrollBy(PAGE)
    else if (key.name === 'home') box.scrollTo(0)
    else if (key.name === 'end') box.scrollTo({ x: 0, y: box.scrollHeight })
  })

  return (
    <box style={{ borderColor: theme().color.accent, flexDirection: 'column', flexGrow: 1, minHeight: 0 }} border>
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.accent}>
          <b>
            ⛓ Agents · {props.subagents.length} subagent{props.subagents.length === 1 ? '' : 's'}
          </b>
        </text>
      </box>
      <box style={{ flexGrow: 1, minHeight: 0 }}>
        <scrollbox ref={el => (box = el)} style={{ flexGrow: 1, minHeight: 0 }}>
          <Show
            when={props.subagents.length > 0}
            fallback={<text fg={theme().color.muted}>No subagents yet — delegate a task to spawn one.</text>}
          >
            <For each={props.subagents}>
              {sa => (
                <text>
                  <span style={{ fg: theme().color.muted }}>{'  '.repeat(Math.max(0, sa.depth))}</span>
                  <span style={{ fg: statusColor(sa.status, theme) }}>{`● ${sa.status}`}</span>
                  <span style={{ fg: theme().color.label }}>{`  ${sa.goal || sa.id}`}</span>
                  <span style={{ fg: theme().color.muted }}>
                    {sa.model ? `  (${sa.model})` : ''}
                    {sa.lastTool ? `  ⚡${sa.lastTool}` : ''}
                  </span>
                </text>
              )}
            </For>
          </Show>
        </scrollbox>
      </box>
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.muted}>Esc/q close · ↑↓/PgUp/PgDn scroll</text>
      </box>
    </box>
  )
}
