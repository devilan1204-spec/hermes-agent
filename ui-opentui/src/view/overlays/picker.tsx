/**
 * Picker — the generic fuzzy picker overlay (spec §2b; Epic 7 model picker v2;
 * picker v2.1). Powers /model and /skills: a native `<input>` query line (real
 * editing — word-delete, home/end, kill-line come free) filters live across
 * label AND group AND extra haystacks (provider slug / lab name — `son4` finds
 * claude-sonnet-4, `copilot` narrows to the GitHub Copilot group); results
 * render GROUPED with non-selectable headers, and ↑↓ traverse the flat item
 * order seamlessly ACROSS group boundaries. Enter picks, Esc/Ctrl+C closes
 * (keymap layer + fallback).
 *
 * v2.1 (direct user feedback):
 * - The input stays focused the whole time; ↑↓/Enter/Ctrl+U/Ctrl+R are handled
 *   by the GLOBAL key handler (which the renderer runs BEFORE routing to the
 *   focused renderable — composer pattern) with `preventDefault` so the input
 *   never also applies them (Ctrl+U is natively kill-to-line-start!).
 * - `unavailable` rows (unconfigured providers, `no API key — set <ENV_VAR>`)
 *   are hidden by default; Ctrl+U reveals them dimmed + NON-selectable and
 *   traversal skips them (buildPickerRows index -1).
 * - Ctrl+R re-fetches the catalog via the seam registered by the opener
 *   (logic/slash.ts registerPickerRefresh) and swaps the rows in live, with a
 *   transient `refreshing…` note — also self-heals a stale ✓.
 *
 * Everything heavy is memoized off (query, toggle, items): keystrokes re-score
 * at most once and unrelated store updates don't.
 */
import type { BoxRenderable, InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'

import { buildPickerRows, fuzzyFilter, visibleRows, type FuzzyField } from '../../logic/fuzzy.ts'
import { canRefreshPicker, runPickerRefresh } from '../../logic/slash.ts'
import type { PickerItem } from '../../logic/store.ts'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

/** Max visible rows (headers + items) before the window scrolls. */
const MAX_ROWS = 12

/** The fuzzy haystacks of a row: label ×2 (opencode's title weighting), then
 *  group (lab name), description and any extra haystacks (provider slug).
 *  Unavailable rows match on provider IDENTITY only (group + haystacks) — their
 *  hint label (`no API key — …`) must not make `api`/`set` match every row. */
function fieldsOf(item: PickerItem): FuzzyField[] {
  const fields: FuzzyField[] = item.unavailable ? [] : [{ text: item.label, weight: 2 }]
  if (item.group) fields.push({ text: item.group })
  if (item.description) fields.push({ text: item.description })
  for (const h of item.haystacks ?? []) fields.push({ text: h })
  return fields
}

export function Picker(props: {
  title: string
  items: PickerItem[]
  onPick: (value: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  let inputRef: InputRenderable | undefined
  // Esc/Ctrl+C close via the native keymap, scoped focus-within to the root box
  // (the focused `<input>` is a descendant, so the layer stays active).
  useCloseLayer(
    () => rootRef,
    () => props.onClose()
  )

  const [query, setQuery] = createSignal('')
  // Ctrl+U availability toggle: unavailable (unconfigured-provider) rows are
  // out of the pool by default; toggled on they join — dimmed, non-selectable.
  const [showAll, setShowAll] = createSignal(false)
  // Ctrl+R live-refreshed rows override the (static) opener snapshot.
  const [live, setLive] = createSignal<PickerItem[] | undefined>(undefined)
  const [refreshing, setRefreshing] = createSignal(false)
  const items = () => live() ?? props.items
  const hasUnavailable = createMemo(() => items().some(it => it.unavailable))

  // pool → score → group → window, all memoized: typing re-scores once; nothing else does.
  const pool = createMemo(() => (showAll() ? items() : items().filter(it => !it.unavailable)))
  const filtered = createMemo(() => fuzzyFilter(query(), pool(), fieldsOf))
  const grouped = createMemo(() =>
    buildPickerRows(
      filtered(),
      it => it.group,
      it => !it.unavailable
    )
  )

  // Start on the current (✓) item; reset to the top match whenever the filter changes.
  const [sel, setSel] = createSignal(
    Math.max(
      0,
      grouped().flat.findIndex(it => it.current)
    )
  )
  createEffect(on(filtered, () => setSel(0), { defer: true }))

  const win = createMemo(() => visibleRows(grouped().rows, sel(), MAX_ROWS))

  const pick = (item: PickerItem | undefined) => {
    if (item) props.onPick(item.value)
  }

  /** Ctrl+R: run the opener-registered catalog re-fetch, swap the rows in live. */
  const refresh = () => {
    if (refreshing()) return
    const pending = runPickerRefresh()
    if (!pending) return
    setRefreshing(true)
    pending
      .then(fresh => {
        if (fresh.length) setLive(fresh)
      })
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  useKeyboard(key => {
    // Esc/Ctrl+C also close via the keymap layer above; handling them here too
    // keeps close working even when focus never landed.
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onClose()
    // Picker chords are consumed BEFORE the focused input sees them
    // (preventDefault) — Ctrl+U would otherwise kill-to-line-start, Enter would
    // fire the input's own submit, ↑↓ would move its cursor.
    const count = grouped().flat.length
    if (key.name === 'return') {
      key.preventDefault()
      return pick(grouped().flat[sel()])
    }
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      key.preventDefault()
      if (count) setSel(s => (s - 1 + count) % count)
      return
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      key.preventDefault()
      if (count) setSel(s => (s + 1) % count)
      return
    }
    if (key.ctrl && key.name === 'u') {
      key.preventDefault()
      setShowAll(v => !v)
      return
    }
    if (key.ctrl && key.name === 'r') {
      key.preventDefault()
      refresh()
      return
    }
    // everything else (printables, backspace, word-delete, home/end…) belongs
    // to the focused native input.
  })

  return (
    <box
      ref={el => (rootRef = el)}
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme().color.accent}>
          <b>{props.title}</b>
        </text>
        <text fg={theme().color.label}>{'  '}</text>
        <text fg={theme().color.prompt}>{'> '}</text>
        <input
          ref={el => (inputRef = el)}
          focused
          onInput={setQuery}
          onMouseDown={() => inputRef?.focus()}
          placeholder="type to filter"
          placeholderColor={theme().color.muted}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          style={{ flexGrow: 1, minWidth: 0 }}
        />
        <Show when={refreshing()}>
          <text fg={theme().color.muted}>refreshing…</text>
        </Show>
      </box>
      <Show when={win().above > 0}>
        <text fg={theme().color.muted}>{`  ↑ ${win().above} more`}</text>
      </Show>
      <For each={win().rows}>
        {row =>
          row.kind === 'header' ? (
            <text fg={theme().color.label}>
              <b>{row.label}</b>
            </text>
          ) : row.index === -1 ? (
            // unavailable (unconfigured provider) — dimmed hint, never selectable
            <text fg={theme().color.muted}>{`  ${row.item.label}`}</text>
          ) : (
            <text
              bg={row.index === sel() ? theme().color.selectionBg : 'transparent'}
              onMouseDown={() => pick(row.item)}
            >
              <span style={{ fg: row.index === sel() ? theme().color.text : theme().color.muted }}>
                {row.index === sel() ? '› ' : '  '}
              </span>
              <span style={{ fg: theme().color.text }}>{row.item.label}</span>
              <Show when={row.item.current}>
                <span style={{ fg: theme().color.ok }}> ✓</span>
              </Show>
              <Show when={row.item.description}>
                <span style={{ fg: theme().color.muted }}> {row.item.description}</span>
              </Show>
            </text>
          )
        }
      </For>
      <Show when={filtered().length === 0}>
        <text fg={theme().color.muted}> (no matches)</text>
      </Show>
      <Show when={win().below > 0}>
        <text fg={theme().color.muted}>{`  ↓ ${win().below} more`}</text>
      </Show>
      <text fg={theme().color.muted}>
        {`↑↓ select · Enter pick${
          hasUnavailable() ? ` · Ctrl+U ${showAll() ? 'hide' : 'show'} unconfigured` : ''
        }${canRefreshPicker() ? ' · Ctrl+R refresh' : ''} · Esc close`}
      </text>
    </box>
  )
}
