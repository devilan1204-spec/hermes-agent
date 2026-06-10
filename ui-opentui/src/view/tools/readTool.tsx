/**
 * ReadTool — renderer for `read_file` (feedback items 1 + 7: "limit and offset
 * not rlly needed as separate lines. just show path and output").
 *
 * Collapsed: the cwd-relative path (subtitle, like the other file tools).
 * Expanded: ONLY the file content — no labeled arg rows (the path is already
 * the subtitle; limit/offset are call mechanics, not content) — rendered
 * through the native `<code>` renderable with the filetype derived from the
 * path extension (Tree-sitter highlighting; unknown extension → plain text).
 *
 * Wire shape (verified live, v6fix capture): the read_file result is a JSON
 * dict `{"content": "1|line…", "total_lines": N, "file_size": N, …}` whose
 * `content` carries `N|`-prefixed lines (tools/file_operations.py
 * `f"{i}|{line}"`). The prefixes are stripped before highlighting (they'd
 * break the grammar parse); when a content payload isn't available (resumed
 * session with only mangled result_text, error results) the body falls back to
 * the default labeled-fields renderer with the noise fields suppressed.
 */
import { pathToFiletype } from '@opentui/core'
import { createMemo, Show } from 'solid-js'

import { relativizePath } from '../../logic/diff.ts'
import type { ToolPartState } from '../../logic/store.ts'
import { CodeBlock } from './codeBlock.tsx'
import { DefaultToolBody, defaultSubtitle, resultLines, structuredResult } from './defaultTool.tsx'
import { filePathOf } from './fileTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** Arg keys the expanded view suppresses (item 1): the path is the collapsed
 *  subtitle; limit/offset are pagination mechanics, not content. */
export const READ_NOISE_FIELDS = ['path', 'offset', 'limit'] as const

/** The file content from the structured result (string, non-empty), else undefined. */
export function readContentOf(part: ToolPartState): string | undefined {
  const c = structuredResult(part)?.['content']
  return typeof c === 'string' && c.length > 0 ? c : undefined
}

/**
 * Strip the read tool's `N|` line-number prefixes (only when EVERY non-empty
 * line carries one — genuine file content that happens to contain `12|x` lines
 * mixed with unprefixed ones is left verbatim). Highlighting needs the bare
 * source; the prefixes also make mouse-copy of the body paste-able.
 */
export function stripLineNumbers(content: string): string {
  const lines = content.split('\n')
  const prefixed = /^\d+\|/
  if (!lines.some(l => l.length > 0)) return content
  if (!lines.every(l => l.length === 0 || prefixed.test(l))) return content
  return lines.map(l => l.replace(prefixed, '')).join('\n')
}

/** Expanded body: the highlighted file content only (fallback: default fields
 *  minus the noise keys + output). */
export function ReadToolBody(props: ToolBodyProps) {
  const content = createMemo(() => readContentOf(props.part))
  return (
    <Show
      when={content()}
      fallback={<DefaultToolBody part={props.part} width={props.width} omitFields={READ_NOISE_FIELDS} />}
    >
      {c => <CodeBlock content={stripLineNumbers(c())} filetype={pathToFiletype(filePathOf(props.part))} />}
    </Show>
  )
}

export const readRenderer: ToolRenderer = {
  Body: ReadToolBody,
  // Content (or any output) is hidden behind the header → worth expanding.
  expandable: part => Boolean(readContentOf(part)) || resultLines(part).length > 0,
  // Honest "(N lines)": count the content the body actually shows.
  lines: part => {
    const c = readContentOf(part)
    return c ? stripLineNumbers(c).replace(/\s+$/, '').split('\n') : resultLines(part)
  },
  // The target path, relative to the session cwd (file-tool house rule).
  subtitle: (part, cwd) => relativizePath(filePathOf(part), cwd) || defaultSubtitle(part)
}
