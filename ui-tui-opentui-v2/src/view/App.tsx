/**
 * App — the Solid view shell (spec v4 §2 `view/App.tsx`). Phase 2: header +
 * scrolling transcript + composer, composed in a flex column. Fully themed via
 * the ThemeProvider — NO hardcoded styles (§7.5).
 *
 *   header     flexShrink:0            (top chrome line)
 *   transcript flexGrow:1, minHeight:0 (the one <scrollbox>; §8 #2 gotchas)
 *   composer   flexShrink:0            (the <textarea>; clears on submit, §8 #3)
 *
 * `onSubmit` is wired by the entry (Effect boundary) to fire `prompt.submit`;
 * it's optional so headless frame tests can mount the shell without a gateway.
 */
import type { SessionStore } from '../logic/store.ts'
import { Composer } from './composer.tsx'
import { Header } from './header.tsx'
import { Transcript } from './transcript.tsx'

export interface AppProps {
  readonly store: SessionStore
  readonly onSubmit?: (text: string) => void
}

const NOOP = () => {}

export function App(props: AppProps) {
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <Header store={props.store} />
      <Transcript store={props.store} />
      <Composer onSubmit={props.onSubmit ?? NOOP} />
    </box>
  )
}
