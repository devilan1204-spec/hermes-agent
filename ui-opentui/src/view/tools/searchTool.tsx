/**
 * SearchTool — renderer for `search_files` (feedback item 2: "context,
 * output_mode kinda not needed — just pattern and output").
 *
 * Collapsed: the PATTERN (arg key verified against tools/file_tools.py
 * SEARCH_FILES_SCHEMA — required `pattern`). Expanded: ONLY the results, shaped
 * as grep-style lines — no labeled arg rows (context/output_mode/limit/offset/
 * path/target/file_glob are call mechanics the user didn't ask to re-read).
 *
 * Wire shape (verified live + tools/file_operations.py SearchResult.to_dict):
 *   content mode → {"total_count": N, "matches": [{path, line, content}…]}
 *   files mode   → {"total_count": N, "files": ["…"]}
 *   count mode   → {"total_count": N, "counts": {"path": N}}
 *   any mode     → optional "truncated": true
 * Fallback (no structured result): default labeled fields minus the noise keys.
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import { DefaultToolBody, defaultSubtitle, resultLines, structuredArgs, structuredResult } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** Arg keys the expanded view suppresses (item 2): pattern is the subtitle;
 *  the rest are search mechanics, not results. */
export const SEARCH_NOISE_FIELDS = [
  'pattern',
  'context',
  'output_mode',
  'target',
  'path',
  'file_glob',
  'limit',
  'offset'
] as const

/** The search pattern, via structuredArgs (redacted args_text precedence). */
export function patternOf(part: ToolPartState): string {
  const p = structuredArgs(part)?.['pattern']
  return typeof p === 'string' ? p.trim() : ''
}

/** Grep-style result lines from the structured result, else undefined. */
export function searchResultLines(part: ToolPartState): string[] | undefined {
  const r = structuredResult(part)
  if (!r) return undefined
  const out: string[] = []
  const matches = r['matches']
  if (Array.isArray(matches)) {
    for (const m of matches) {
      if (!m || typeof m !== 'object') continue
      const o = m as Record<string, unknown>
      const path = typeof o['path'] === 'string' ? o['path'] : ''
      const line = typeof o['line'] === 'number' ? o['line'] : undefined
      const content = typeof o['content'] === 'string' ? o['content'].replace(/\s+$/, '') : ''
      out.push(`${path}${line === undefined ? '' : `:${line}`}: ${content}`)
    }
  }
  const files = r['files']
  if (Array.isArray(files)) for (const f of files) if (typeof f === 'string') out.push(f)
  const counts = r['counts']
  if (counts && typeof counts === 'object' && !Array.isArray(counts))
    for (const [path, n] of Object.entries(counts)) out.push(`${path}: ${String(n)}`)
  if (out.length === 0) {
    // a structured result with no result rows IS the answer: nothing matched
    if (typeof r['total_count'] === 'number') return ['no matches']
    return undefined
  }
  if (r['truncated'] === true) out.push('… results truncated')
  return out
}

/** Expanded body: the result lines only (fallback: default fields minus noise). */
export function SearchToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const lines = createMemo(() => searchResultLines(props.part))
  return (
    <Show
      when={lines()}
      fallback={<DefaultToolBody part={props.part} width={props.width} omitFields={SEARCH_NOISE_FIELDS} />}
    >
      {rows => (
        <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <For each={rows()}>
            {row => (
              <text selectionBg={theme().color.selectionBg}>
                <span style={{ fg: theme().color.muted }}>{truncate(row, Math.max(1, props.width))}</span>
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}

export const searchRenderer: ToolRenderer = {
  Body: SearchToolBody,
  // Any result rows (or raw output) are hidden behind the header.
  expandable: part => (searchResultLines(part)?.length ?? 0) > 0 || resultLines(part).length > 0,
  // Honest "(N lines)": the rows the body actually shows.
  lines: part => searchResultLines(part) ?? resultLines(part),
  // The pattern, verbatim (it already IS the gateway preview for search_files).
  subtitle: part => patternOf(part) || defaultSubtitle(part)
}
