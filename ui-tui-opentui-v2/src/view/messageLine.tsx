/**
 * MessageLine — renders one transcript row (spec v4 §2 `view/messageLine.tsx`).
 * Phase 2 slice: flat text messages with a role gutter + streaming `▍` cursor,
 * fully themed. The ordered-parts dispatch (text/tool/reasoning §7) replaces the
 * flat `text` field in the next slice — this file grows into that `<Switch>` loop.
 *
 * Rich text via <b>/<span> children, never an attributes bitmask (gotcha §8 #1);
 * inline color is `<span style={{ fg }}>`.
 */
import { Show } from 'solid-js'

import type { Message } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

export function MessageLine(props: { message: Message }) {
  const theme = useTheme()
  const gutter = () =>
    props.message.role === 'assistant'
      ? `${theme().brand.icon} `
      : props.message.role === 'user'
        ? `${theme().brand.prompt} `
        : ''
  const gutterFg = () => (props.message.role === 'assistant' ? theme().color.accent : theme().color.prompt)

  return (
    <text style={{ flexShrink: 0 }}>
      <span style={{ fg: gutterFg() }}>{gutter()}</span>
      <span style={{ fg: theme().color.text }}>{props.message.text}</span>
      <Show when={props.message.streaming}>
        <span style={{ fg: theme().color.muted }}>▍</span>
      </Show>
    </text>
  )
}
