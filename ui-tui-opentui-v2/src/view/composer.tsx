/**
 * Composer — the input row (spec v4 §2 `view/composer.tsx`). Phase 2: a native
 * <textarea> captured by ref; Enter submits, the input clears imperatively.
 *
 * Gotchas (§8 #3): `flexShrink:0` on the wrapper so it never collapses onto its
 * rule under a full transcript; clear via the renderable's `.clear()` (NOT a
 * `key`-remount or controlled `value=""`); a `submitting` re-entrancy guard so a
 * double-Enter can't read the now-empty buffer and submit a phantom prompt.
 *
 * `onSubmit` is a plain callback wired by the entry (Effect boundary) — it fires
 * the `prompt.submit` RPC. The composer itself stays pure Solid (no Effect).
 */
import { type TextareaRenderable } from '@opentui/core'
import { onMount } from 'solid-js'

import { useTheme } from './theme.tsx'

export function Composer(props: { onSubmit: (text: string) => void }) {
  const theme = useTheme()
  let ta: TextareaRenderable | undefined
  let submitting = false

  const submit = () => {
    if (submitting || !ta) return
    const text = ta.plainText.trim()
    if (!text) return
    submitting = true
    props.onSubmit(text)
    ta.clear()
    submitting = false
  }

  onMount(() => ta?.focus())

  return (
    <box style={{ flexShrink: 0, marginTop: 1 }}>
      <textarea
        ref={el => (ta = el)}
        style={{ height: 3, width: '100%' }}
        placeholder={theme().brand.welcome}
        placeholderColor={theme().color.muted}
        textColor={theme().color.text}
        cursorColor={theme().color.accent}
        focusedBackgroundColor={theme().color.statusBg}
        keyBindings={[{ action: 'submit', name: 'return' }]}
        onSubmit={submit}
      />
    </box>
  )
}
