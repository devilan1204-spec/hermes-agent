/**
 * StatusLine — the transient busy indicator (spec §3 chrome; Ink's FaceTicker).
 * Shows the kaomoji face/verb from `thinking.delta`/`status.update` WHILE a turn
 * runs, above the composer; cleared on `message.complete`. This keeps those
 * transient indicators OUT of the transcript (they used to render as reasoning
 * rows and linger). Themed, dim. Renders nothing when idle.
 */
import { Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

export function StatusLine(props: { store: SessionStore }) {
  const theme = useTheme()
  return (
    <Show when={props.store.state.status}>
      {status => (
        <box style={{ flexShrink: 0 }}>
          <text>
            <span style={{ fg: theme().color.muted }}>{status()}</span>
          </text>
        </box>
      )}
    </Show>
  )
}
