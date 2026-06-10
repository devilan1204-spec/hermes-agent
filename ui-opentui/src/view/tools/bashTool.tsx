/**
 * BashTool — renderer for the shell-ish tools `terminal`, `execute_code` and
 * `process` (Epic 2.4). Collapsed: the COMMAND BEING INVOKED, verbatim, on one
 * line (the shell truncates to width; expanding reveals the rest). Expanded:
 * the full output — uncapped by default (HERMES_TUI_TOOL_OUTPUT_LINES restores
 * a cap, e.g. `=200`) with the honest omitted / "+N more lines" notes from
 * `logic/toolOutput.ts` (via the shared ToolOutputBlock).
 *
 * The command echo is shown only when the header could NOT (feedback item 3:
 * "the dropdown header and the info below it is mostly the same for one-liner
 * commands") — i.e. multi-line or header-truncated commands. When echoed,
 * terminal/process keep the `$ `-prefixed plain lines (bash output stays
 * plain), while execute_code's `code` argument goes through the shared
 * Tree-sitter CodeBlock as Python (item 7 — the tool's schema has a single
 * `code` arg and is always Python).
 *
 * Arg keys verified against the Python tool schemas:
 *   terminal     → `command`                 (tools/terminal_tool.py TERMINAL_SCHEMA)
 *   execute_code → `code`                    (tools/code_execution_tool.py)
 *   process      → `action` (+ `session_id`) (tools/process_registry.py PROCESS_SCHEMA)
 * Falls back to the gateway's one-line argsPreview when args weren't captured.
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { argsCapColumns, truncate } from '../../logic/toolOutput.ts'
import { useDimensions } from '../dimensions.tsx'
import { useTheme } from '../theme.tsx'
import { CodeBlock } from './codeBlock.tsx'
import { defaultSubtitle, resultLines, structuredArgs, ToolOutputBlock } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** The verbatim invocation: terminal `command` / execute_code `code` /
 *  process `action [session_id]`; else the gateway's argsPreview. Via
 *  structuredArgs this prefers the gateway-redacted args_text parse — a
 *  masked command string is the CORRECT display when the gateway redacted it. */
export function commandOf(part: ToolPartState): string {
  const args = structuredArgs(part)
  if (args) {
    const cmd = args['command'] ?? args['code']
    if (typeof cmd === 'string' && cmd.trim()) return cmd
    const action = args['action'] // process: the verb is the invocation
    if (typeof action === 'string' && action) {
      const sid = args['session_id']
      const sidText = typeof sid === 'string' || typeof sid === 'number' ? String(sid) : ''
      return sidText ? `${action} ${sidText}` : action
    }
  }
  return part.argsPreview ?? ''
}

/**
 * True when the collapsed header already shows the WHOLE command (item 3) —
 * single line AND untruncated. Mirrors the header math in `view/toolPart.tsx`:
 * the subtitle gets `bodyWidth - name - 2` columns while the Body gets
 * `bodyWidth - 2`, so the header's subtitle width is `width - name.length` —
 * ALSO capped to ~half the pane (`argsCapColumns`, the design pass's args
 * width cap) when `headerCap` is given, keeping this check mirrored with the
 * header's actual truncation. A failed part's header shows the ERROR instead
 * of the command, so the body must echo it again.
 */
export function commandFitsHeader(part: ToolPartState, width: number, headerCap?: number): boolean {
  if (part.error) return false
  const cmd = commandOf(part)
  if (cmd.includes('\n')) return false
  const flat = cmd.replace(/\s+/g, ' ').trim()
  return flat.length <= Math.min(Math.max(1, width - part.name.length), headerCap ?? Number.POSITIVE_INFINITY)
}

/** Expanded body: the command echo (only when the header truncated it), then
 *  the full (capped) output. */
export function BashToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const dims = useDimensions()
  const command = createMemo(() => commandOf(props.part).replace(/\s+$/, ''))
  const echo = createMemo(
    () => Boolean(command()) && !commandFitsHeader(props.part, props.width, argsCapColumns(dims().width))
  )
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
      <Show when={echo()}>
        <Show
          when={props.part.name === 'execute_code'}
          fallback={
            <For each={command().split('\n')}>
              {(line, i) => (
                <box style={{ flexDirection: 'row', flexShrink: 0 }}>
                  {/* `$ ` prompt glyph (continuation lines indent under it) — chrome;
                      machinery BLUE (design pass: all tool glyphs ride shellDollar) */}
                  <text selectable={false}>
                    <span style={{ fg: theme().color.shellDollar }}>{i() === 0 ? '$ ' : '  '}</span>
                  </text>
                  {/* the command itself is copyable content */}
                  <text selectionBg={theme().color.selectionBg}>
                    <span style={{ fg: theme().color.text }}>{truncate(line, Math.max(1, props.width - 2))}</span>
                  </text>
                </box>
              )}
            </For>
          }
        >
          {/* execute_code's code argument — Tree-sitter highlighted (item 7) */}
          <CodeBlock content={command()} filetype="python" />
        </Show>
      </Show>
      <ToolOutputBlock part={props.part} width={props.width} label={echo()} />
    </box>
  )
}

export const bashRenderer: ToolRenderer = {
  Body: BashToolBody,
  // Collapsed never shows output (the header shows the command), so ANY output
  // is hidden content worth expanding — as is a multi-line command.
  expandable: part => resultLines(part).length > 0 || commandOf(part).includes('\n'),
  // The command, verbatim, flattened to one line (the shell truncates to width).
  subtitle: part => commandOf(part).replace(/\s+/g, ' ').trim() || defaultSubtitle(part)
}
