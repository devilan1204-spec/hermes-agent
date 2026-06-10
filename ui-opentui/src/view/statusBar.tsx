/**
 * StatusBar — Variant A dense single status bar (v6 Epic 1.3; signed-off design).
 * The header stays the minimal brand line; EVERYTHING else lives here, one
 * themed row pinned above the composer:
 *
 *   ● model ·effort │ ███░░ 42% 84k │ $0.41 · 23m · cmp 2 │ profile │ 2 mcp │ …/cwd (branch)
 *
 * Progressive disclosure (Ink's `statusRuleWidths` idiom): the dot+model and
 * the context % are PINNED; the tail segments drop whole as columns shrink, in
 * reverse priority — mcp → bg → profile → cost → duration/cmp → token/bar
 * detail — and the cwd left-truncates into whatever remains. `statusSegments`
 * is the pure width→visibility table (table-tested); nothing truncates
 * mid-segment, so the row NEVER wraps or clips.
 *
 * A pending update (`info.update_behind > 0`) BORROWS the whole line as a
 * transient notice (Variant A decision — no permanent transcript row); it
 * dismisses on Esc or after NOTICE_TTL_MS.
 *
 * Parity notes (data that does not reach this TUI yet — reported, not faked):
 *   - `N bg` (background tasks): the OpenTUI store has no background-task
 *     tracking (Ink counts `prompt.background` task_ids + `background.complete`
 *     locally); the segment slot exists in `statusSegments` but renders nothing.
 *   - `display.show_cost`: Ink reads it from its `config.get` polling loop,
 *     which this TUI doesn't have — cost shows whenever `usage.cost_usd` is
 *     present instead.
 *
 * Read-only chrome — the only input handled is Esc-to-dismiss for the notice.
 */
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useDimensions } from './dimensions.tsx'
import { elapsedSeconds, useElapsedTick } from './elapsed.ts'
import { useTheme } from './theme.tsx'

const HOME = process.env.HOME ?? ''
const CTX_BAR_CELLS = 5
const SEP = ' │ '
const DOT_SEP = ' · '
/** How long the transient update notice may borrow the bar line. */
const NOTICE_TTL_MS = 30_000

// ── pure, table-tested width/threshold logic ────────────────────────────

/** Which tail segments are visible at a given column count. Drop order as the
 *  terminal narrows (reverse priority, spec Epic 1.3): mcp → bg → profile →
 *  cost → duration/cmp → ctxDetail (bar+token count collapse to a bare `42%`).
 *  Dot+model and the context % are pinned and never gated here. */
export interface StatusSegments {
  /** Full `███░░ 42% 84k` read-out; false → compact bare `42%`. */
  ctxDetail: boolean
  duration: boolean
  compressions: boolean
  cost: boolean
  profile: boolean
  /** Background-tasks count — reserved; no store data feeds it yet (see header). */
  bg: boolean
  mcp: boolean
}

export function statusSegments(cols: number): StatusSegments {
  const w = Math.max(1, Math.floor(cols || 1))
  return {
    ctxDetail: w >= 72,
    duration: w >= 80,
    compressions: w >= 80,
    cost: w >= 92,
    profile: w >= 100,
    bg: w >= 108,
    mcp: w >= 116
  }
}

/** Context-pressure level for the bar/% colour (spec thresholds 50/80/95). */
export type CtxLevel = 'ok' | 'warn' | 'bad' | 'critical'
export function ctxLevel(pct: number): CtxLevel {
  if (pct >= 95) return 'critical'
  if (pct >= 80) return 'bad'
  if (pct >= 50) return 'warn'
  return 'ok'
}

/** Compression-count level (spec: warn ≥5, error ≥10). */
export type CmpLevel = 'ok' | 'warn' | 'bad'
export function cmpLevel(n: number): CmpLevel {
  if (n >= 10) return 'bad'
  if (n >= 5) return 'warn'
  return 'ok'
}

/** Compact token count: 84321 → `84k`, 1_250_000 → `1.3M`, 950 → `950`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${Math.max(0, Math.round(n))}`
}

/** Compact session duration: 42 → `42s`, 23*60 → `23m`, 65*60 → `1h05m`. */
export function fmtShortDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

// ── local formatting helpers ────────────────────────────────────────────

/** `anthropic/claude-opus-4-8` → `claude-opus-4-8`; trims the provider prefix (Ink shortModelLabel). */
function shortModel(model: string): string {
  return model.includes('/') ? (model.split('/').at(-1) ?? model) : model
}

/** Reasoning effort → a compact suffix; hidden for the default/medium effort. */
function effortSuffix(effort: string | undefined, fast: boolean | undefined): string {
  const parts: string[] = []
  if (effort && effort !== 'medium' && effort !== 'default') parts.push(effort)
  if (fast) parts.push('fast')
  return parts.length ? ` ·${parts.join('·')}` : ''
}

/** Abbreviate cwd with `~` for $HOME, then collapse to the last two path segments
 *  (`…/lively-thrush/hermes-agent`) so deep worktree paths stay readable (Ink fmtCwdBranch). */
function shortCwd(cwd: string): string {
  const home = HOME && (cwd === HOME || cwd.startsWith(HOME + '/')) ? '~' + cwd.slice(HOME.length) : cwd
  const segs = home.split('/').filter(Boolean)
  return segs.length <= 3 ? home : '…/' + segs.slice(-2).join('/')
}

/** Keep the TAIL of a string, prefixing with `…` when it must be clipped. */
function truncLeft(s: string, max: number): string {
  if (max <= 1) return s.length > max ? '…' : s
  return s.length <= max ? s : '…' + s.slice(s.length - max + 1)
}

/** Keep the HEAD of a string, suffixing with `…` when it must be clipped. */
function truncRight(s: string, max: number): string {
  if (max <= 1) return s.length > max ? '…' : s
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** A unicode meter: `███░░` filled to `pct`% over `width` cells (Ink ctxBar). */
function ctxBar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function StatusBar(props: { store: SessionStore }) {
  const theme = useTheme()
  const dims = useDimensions()
  const info = () => props.store.state.info
  const tick = useElapsedTick()

  const ctxColorOf = (pct: number) => {
    const level = ctxLevel(pct)
    return level === 'critical'
      ? theme().color.statusCritical
      : level === 'bad'
        ? theme().color.statusBad
        : level === 'warn'
          ? theme().color.statusWarn
          : theme().color.statusGood
  }
  const cmpColorOf = (n: number) => {
    const level = cmpLevel(n)
    return level === 'bad' ? theme().color.error : level === 'warn' ? theme().color.warn : theme().color.muted
  }

  const dot = () => (info().running ? '◐' : props.store.state.ready ? '●' : '○')
  const dotColor = () =>
    info().running ? theme().color.statusWarn : props.store.state.ready ? theme().color.statusGood : theme().color.muted

  const segs = createMemo(() => statusSegments(dims().width))

  // ── transient update notice (borrows the whole line; Esc / TTL dismisses) ──
  const [dismissed, setDismissed] = createSignal(false)
  const noticeText = createMemo(() => {
    const behind = info().updateBehind
    if (dismissed() || behind === undefined || behind <= 0) return ''
    const cmd = info().updateCommand
    const base = `↑ hermes is ${behind} commit${behind === 1 ? '' : 's'} behind`
    return `${base}${cmd ? ` — update: ${cmd}` : ''}${SEP}Esc to dismiss`
  })
  createEffect(() => {
    if (!noticeText()) return
    const timer = setTimeout(() => setDismissed(true), NOTICE_TTL_MS)
    onCleanup(() => clearTimeout(timer))
  })
  // Dismiss-only handler: never swallows Esc from overlays/composer (they keep
  // their own handlers); dismissing the notice alongside is benign.
  useKeyboard(key => {
    if (key.name === 'escape' && noticeText()) setDismissed(true)
  })

  // ── segment texts (each '' when hidden/absent — also feeds the width budget) ──
  const model = () => {
    const m = info().model
    return m ? shortModel(m) : ''
  }
  const effort = () => effortSuffix(info().effort, info().fast)
  const pct = () => info().contextPercent

  const ctxText = createMemo(() => {
    const p = pct()
    if (p === undefined) return ''
    if (!segs().ctxDetail) return `${p}%`
    const used = info().contextUsed
    return `${ctxBar(p, CTX_BAR_CELLS)} ${p}%${used !== undefined ? ` ${fmtTokens(used)}` : ''}`
  })

  const costText = createMemo(() => {
    const c = info().costUsd
    return segs().cost && c !== undefined ? `$${c.toFixed(2)}` : ''
  })
  const durationText = createMemo(() => {
    const started = info().startedAt
    if (!segs().duration || !started || !model()) return ''
    tick() // re-derive once per second while shown
    return fmtShortDuration(elapsedSeconds(started))
  })
  const cmpCount = () => info().compressions ?? 0
  const cmpText = createMemo(() => (segs().compressions && cmpCount() > 0 ? `cmp ${cmpCount()}` : ''))
  /** cost · duration · cmp as ONE bar segment (the spec's `$0.41 · 23m · cmp 2`). */
  const meterText = createMemo(() => [costText(), durationText(), cmpText()].filter(Boolean).join(DOT_SEP))

  const profileText = createMemo(() => {
    const p = info().profileName
    return segs().profile && p && p !== 'default' && p !== 'custom' ? p : ''
  })
  const mcpText = createMemo(() => {
    const n = info().mcpServers ?? 0
    return segs().mcp && n > 0 ? `${n} mcp` : ''
  })

  // Width budget for the right-aligned cwd: total minus box padding minus the
  // plain-text width of every visible left segment (all monospace-1-col chars).
  const leftLen = createMemo(() => {
    let len = 1 // dot
    if (model()) len += 1 + model().length + effort().length
    for (const seg of [ctxText(), meterText(), profileText(), mcpText()]) {
      if (seg) len += SEP.length + seg.length
    }
    return len
  })
  const cwdFull = createMemo(() => {
    const cwd = info().cwd
    const c = cwd ? shortCwd(cwd) : ''
    if (!c) return ''
    return info().branch ? `${c} (${info().branch})` : c
  })
  const rightText = createMemo(() => {
    // dims() is the TERMINAL width; the bar's row is narrower by the app shell's
    // horizontal padding (2) + this box's own padding (2), and we keep a 2-col
    // gap so the cwd never butts against the left segments.
    const budget = dims().width - 4 - leftLen() - 2
    return budget > 4 ? truncLeft(cwdFull(), budget) : ''
  })

  return (
    <box
      style={{
        flexShrink: 0,
        flexDirection: 'row',
        backgroundColor: theme().color.statusBg,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <Show
        when={!noticeText()}
        fallback={
          // the update notice borrows the WHOLE line (Variant A) — warn-tinted,
          // head-truncated so the Esc hint clips last only on absurd widths.
          <text selectable={false}>
            <span style={{ fg: theme().color.warn }}>{truncRight(noticeText(), Math.max(1, dims().width - 4))}</span>
          </text>
        }
      >
        {/* left: pinned dot+model, then the priority-ordered tail segments */}
        <box style={{ flexShrink: 0, flexDirection: 'row' }}>
          <text selectable={false}>
            <span style={{ fg: dotColor() }}>{dot()}</span>
            <Show when={model()}>
              <span style={{ fg: theme().color.statusFg }}>{` ${model()}`}</span>
              <span style={{ fg: theme().color.muted }}>{effort()}</span>
            </Show>
            <Show when={ctxText()}>
              <span style={{ fg: theme().color.border }}>{SEP}</span>
              {/* ctxText() truthy guarantees pct() is defined; `?? 0` only satisfies the type. */}
              <Show when={segs().ctxDetail} fallback={<span style={{ fg: ctxColorOf(pct() ?? 0) }}>{ctxText()}</span>}>
                <span style={{ fg: ctxColorOf(pct() ?? 0) }}>{ctxBar(pct() ?? 0, CTX_BAR_CELLS)}</span>
                <span style={{ fg: theme().color.statusFg }}>{` ${pct()}%`}</span>
                <Show when={info().contextUsed !== undefined}>
                  <span style={{ fg: theme().color.muted }}>{` ${fmtTokens(info().contextUsed ?? 0)}`}</span>
                </Show>
              </Show>
            </Show>
            <Show when={meterText()}>
              <span style={{ fg: theme().color.border }}>{SEP}</span>
              <Show when={costText()}>
                <span style={{ fg: theme().color.muted }}>{costText()}</span>
              </Show>
              <Show when={costText() && durationText()}>
                <span style={{ fg: theme().color.muted }}>{DOT_SEP}</span>
              </Show>
              <Show when={durationText()}>
                <span style={{ fg: theme().color.muted }}>{durationText()}</span>
              </Show>
              <Show when={(costText() || durationText()) && cmpText()}>
                <span style={{ fg: theme().color.muted }}>{DOT_SEP}</span>
              </Show>
              <Show when={cmpText()}>
                <span style={{ fg: cmpColorOf(cmpCount()) }}>{cmpText()}</span>
              </Show>
            </Show>
            <Show when={profileText()}>
              <span style={{ fg: theme().color.border }}>{SEP}</span>
              {/* statusFg, not accent — persistent chrome spends no warm ink
                  (design pass); the navy fill is the bar's one blue surface. */}
              <span style={{ fg: theme().color.statusFg }}>{profileText()}</span>
            </Show>
            {/* `N bg` would slot here (segs().bg) — no store data feeds it yet (see header). */}
            <Show when={mcpText()}>
              <span style={{ fg: theme().color.border }}>{SEP}</span>
              <span style={{ fg: theme().color.muted }}>{mcpText()}</span>
            </Show>
          </text>
        </box>

        {/* spacer pushes the cwd to the right edge */}
        <box style={{ flexGrow: 1, minWidth: 0 }} />

        {/* right: cwd (branch), pre-truncated so the row never wraps */}
        <Show when={rightText()}>
          <box style={{ flexShrink: 0, flexDirection: 'row' }}>
            <text selectable={false}>
              <span style={{ fg: theme().color.muted }}>{rightText()}</span>
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}
