/**
 * ToolPart — one tool call, rendered COLLAPSED by default with a clear expand
 * affordance. This is the SHARED SHELL: the header (glyph + name + subtitle +
 * duration + line count + optional hint) and the expand/collapse mechanics —
 * what's INSIDE varies per tool and is dispatched through the tool renderer
 * registry (`view/tools/registry.tsx`, Epic 2.2):
 *
 *   ▶ terminal  ls -la src  · 0.3s  (12 lines)   ← collapsed (default)
 *   ▼ terminal  ls -la src  · 0.3s               ← expanded header
 *   │ <renderer body>                            ← labeled fields / output / …
 *
 * `▶`/`▼` marks expandable tools; clicking the header toggles it (wrapped in
 * useScrollAnchor so expanding never yanks the viewport). Running tools show
 * `name …`. The header row is chrome (selectable=false) — a free-form drag
 * copies only the expanded body content. Fully themed (no hardcoded styles).
 */
import { type ToolPartState } from '../logic/store.ts'
import { useDimensions } from './dimensions.tsx'
import { createSignal, Show } from 'solid-js'

import { truncate } from '../logic/toolOutput.ts'
import { useScrollAnchor } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'
import { resultLines } from './tools/defaultTool.tsx'
import { rendererFor } from './tools/registry.tsx'

const GUTTER = 2

function fmtDuration(s: number): string {
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m}m ${r}s` : `${m}m`
}

export function ToolPart(props: { part: ToolPartState }) {
  const theme = useTheme()
  const dims = useDimensions()
  const anchor = useScrollAnchor()
  const [expanded, setExpanded] = createSignal(false)
  const toggle = () => anchor(() => setExpanded(e => !e))

  // Per-tool renderer (re-dispatches if the name settles on tool.complete).
  const renderer = () => rendererFor(props.part.name)
  const bodyWidth = () => Math.max(20, dims().width - GUTTER - 4)
  const lines = () => resultLines(props.part)
  const running = () => props.part.state === 'running'
  // Expandable when the renderer says there's a body to reveal beyond the header.
  const collapsible = () => !running() && renderer().expandable(props.part)
  // Header subtitle: errors win; otherwise the renderer's collapsed summary.
  const subtitle = () => (props.part.error ? `✗ ${props.part.error}` : renderer().subtitle(props.part))
  const hint = () => renderer().hint?.(props.part)

  const headGlyph = () => (collapsible() ? (expanded() ? '▼' : '▶') : '⚡')
  // accent glyph MARKS the tool (draws the eye); the rest is muted so tools read
  // as the dim, secondary tier below the bright assistant answer (Ink hierarchy).
  const headColor = () => (props.part.error ? theme().color.error : theme().color.accent)
  const subWidth = () => Math.max(1, bodyWidth() - props.part.name.length - 2)

  return (
    // Spacing between parts is owned by the parts column (gap), not per-part
    // margins — so a tool appearing mid-stream doesn't shift the layout.
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      {/* header — clickable to toggle when there's an expandable body */}
      <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => collapsible() && toggle()}>
        <box style={{ flexShrink: 0, width: GUTTER }}>
          <text selectable={false}>
            <span style={{ fg: headColor() }}>{headGlyph()}</span>
          </text>
        </box>
        <box style={{ flexDirection: 'row', flexGrow: 1, minWidth: 0 }}>
          {/* the whole header row is a collapsed SUMMARY (tool name + subtitle +
              duration + "(N lines)") — chrome, not the copyable body — so a
              free-form drag over a tool yields only the expanded body content,
              never the header label. */}
          <text selectable={false}>
            <span style={{ fg: theme().color.muted }}>{props.part.name}</span>
            <Show when={running()}>
              <span style={{ fg: theme().color.muted }}> …</span>
            </Show>
            <Show when={!running() && subtitle()}>
              <span style={{ fg: props.part.error ? theme().color.error : theme().color.muted }}>
                {`  ${truncate(subtitle(), subWidth())}`}
              </span>
            </Show>
            <Show when={hint()}>
              {/* per-tool muted hint (e.g. delegate_task's "(/agents to monitor)") —
                  shown while running too, Ink parity. */}
              <span style={{ fg: theme().color.muted }}>{`  ${hint() ?? ''}`}</span>
            </Show>
            <Show when={!running() && props.part.duration !== undefined}>
              <span style={{ fg: theme().color.muted }}>{`  · ${fmtDuration(props.part.duration ?? 0)}`}</span>
            </Show>
            <Show when={collapsible() && !expanded() && lines().length > 1}>
              <span style={{ fg: theme().color.muted }}>{`  (${lines().length} lines)`}</span>
            </Show>
          </text>
        </box>
      </box>

      {/* expanded body — the per-tool renderer's Body, inside a single
          left-bordered column (a `│` rule, not a bg fill — opencode's BlockTool
          style; also renders faithfully and reads cleaner). */}
      <Show when={collapsible() && expanded()}>
        <box
          style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, marginLeft: GUTTER, paddingLeft: 1 }}
          border={['left']}
          borderColor={props.part.error ? theme().color.error : theme().color.border}
        >
          {(() => {
            const Body = renderer().Body
            return <Body part={props.part} width={bodyWidth() - 2} />
          })()}
        </box>
      </Show>
    </box>
  )
}
