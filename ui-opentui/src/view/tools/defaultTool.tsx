/**
 * DefaultTool — the fallback renderer for every unmapped tool, incl. MCP tools
 * (Epic 2.2: kill the raw-JSON args path). Expanded args render as LABELED
 * FIELDS (key → value rows), never a JSON dump:
 *   - strings verbatim, flattened to one line + truncated to the frame width
 *   - numbers/booleans via String()
 *   - arrays of primitives joined ("a, b, c"); anything nested summarized as
 *     `(N fields)` / `(N items)` (opencode's primitive-only `input()` idea)
 * A single field whose value already equals the header's primary-arg preview is
 * hidden (it adds nothing over the header). The output body keeps the store's
 * envelope-stripped text, capped to EXPANDED_MAX with the honest omitted /
 * "+N more lines" notes. `ToolOutputBlock` is shared with the per-tool
 * renderers (bash, …). Fully themed; labels/notes are chrome (selectable=false).
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { collapseToolOutput, truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** Max output lines shown when expanded (a sane cap to avoid huge renders). */
export const EXPANDED_MAX = 200
/** Max labeled arg fields shown when expanded. */
const FIELDS_MAX = 16

/** The tool's structured args: `part.args` (tool.complete) or parsed argsText. */
export function structuredArgs(part: ToolPartState): Record<string, unknown> | undefined {
  if (part.args) return part.args
  if (!part.argsText) return undefined
  try {
    const o: unknown = JSON.parse(part.argsText)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** One-line display value for an arg: primitives verbatim, nesting summarized. */
function fieldValue(v: unknown): string {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return '∅'
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isPrimitive)) return v.map(String).join(', ')
    return `(${v.length} item${v.length === 1 ? '' : 's'})`
  }
  const n = Object.keys(v).length
  return `(${n} field${n === 1 ? '' : 's'})`
}

/** Labeled key→value rows for the expanded args (NEVER raw JSON). */
export function argFields(part: ToolPartState): Array<[string, string]> {
  const obj = structuredArgs(part)
  if (!obj) return []
  const entries = Object.entries(obj).map(([k, v]): [string, string] => [k, fieldValue(v)])
  // A single field whose value is already the header's primary-arg preview adds
  // nothing over the header (e.g. terminal's `command`) — hide it (kept from
  // the pre-registry render's redundancy rule).
  const only = entries.length === 1 ? entries[0] : undefined
  if (only && only[1] === (part.argsPreview ?? '').trim()) return []
  return entries
}

/** The settled output body, trailing-whitespace-trimmed, split to lines. */
export function resultLines(part: ToolPartState): string[] {
  const r = (part.resultText ?? '').replace(/\s+$/, '')
  return r ? r.split('\n') : []
}

/** Collapsed subtitle: primary-arg preview, else summary, else the first output line. */
export function defaultSubtitle(part: ToolPartState): string {
  return part.argsPreview || part.summary || resultLines(part)[0] || ''
}

/**
 * The output section of an expanded tool body — shared by the default and the
 * per-tool renderers. Caps to EXPANDED_MAX and renders the honest truncation
 * notes (`omittedNote` from the gateway cap; "+N more lines" from ours).
 */
export function ToolOutputBlock(props: { part: ToolPartState; width: number; label?: boolean }) {
  const theme = useTheme()
  const result = () => (props.part.resultText ?? '').replace(/\s+$/, '')
  const body = createMemo(() => collapseToolOutput(result(), EXPANDED_MAX, props.width))
  return (
    <Show when={result()}>
      {/* section label — chrome, not content */}
      <Show when={props.label}>
        <text selectable={false}>
          <span style={{ fg: theme().color.label }}>output</span>
        </text>
      </Show>
      {/* output body lines are the copyable content → themed selection bar */}
      <For each={body().lines}>
        {line => (
          <text selectionBg={theme().color.selectionBg}>
            <span style={{ fg: theme().color.muted }}>{line}</span>
          </text>
        )}
      </For>
      {/* truncation annotations — chrome (not part of the real output body) */}
      <Show when={props.part.omittedNote}>
        <text selectable={false}>
          <span style={{ fg: theme().color.muted }}>{`… omitted ${props.part.omittedNote}`}</span>
        </text>
      </Show>
      <Show when={body().hiddenLines > 0 && !props.part.omittedNote}>
        <text selectable={false}>
          <span style={{ fg: theme().color.accent }}>{`… +${body().hiddenLines} more lines`}</span>
        </text>
      </Show>
    </Show>
  )
}

/** Expanded body: labeled arg fields, then the (capped) output block. */
export function DefaultToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const fields = createMemo(() => argFields(props.part))
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
      <Show when={fields().length > 0}>
        <For each={fields().slice(0, FIELDS_MAX)}>
          {([key, value]) => (
            <text selectionBg={theme().color.selectionBg}>
              <span style={{ fg: theme().color.label }}>{key}</span>
              <span style={{ fg: theme().color.muted }}>
                {`  ${truncate(value, Math.max(1, props.width - key.length - 2))}`}
              </span>
            </text>
          )}
        </For>
        <Show when={fields().length > FIELDS_MAX}>
          {/* overflow annotation — chrome, not content */}
          <text selectable={false}>
            <span style={{ fg: theme().color.accent }}>{`… +${fields().length - FIELDS_MAX} more`}</span>
          </text>
        </Show>
      </Show>
      <ToolOutputBlock part={props.part} width={props.width} label={fields().length > 0} />
    </box>
  )
}

export const defaultRenderer: ToolRenderer = {
  Body: DefaultToolBody,
  // Expandable when there's a body beyond the header: multi-line output, labeled
  // arg fields, or a single output line the subtitle doesn't already show
  // (argsPreview/summary win the subtitle, hiding that line when collapsed).
  expandable: part =>
    resultLines(part).length > 1 ||
    argFields(part).length > 0 ||
    (resultLines(part).length === 1 && Boolean(part.argsPreview || part.summary)),
  subtitle: defaultSubtitle
}
