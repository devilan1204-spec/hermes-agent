/**
 * ClarifyTool — renderer for `clarify` (feedback item 4: "c'mon lol i see
 * output in json xD" — the settled clarify part rendered its raw JSON result,
 * a north-star violation).
 *
 * Wire shape (verified live, v6fix capture + tools/clarify_tool.py):
 *   args   → {"question": "…", "choices": ["…"]?}
 *   result → {"question": "…", "choices_offered": ["…"]|null, "user_response": "…"}
 *
 * Collapsed: compact `question: answer`. Expanded (the user's sketch):
 *   User answered:
 *   · <question>: <answer>
 * One `·` line per Q/A — a clarify result carries one pair today; the renderer
 * maps whatever pairs it finds so a future multi-question result stays right.
 * NEVER JSON: when no Q/A can be extracted there is no body (header only).
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import { defaultSubtitle, structuredResult } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

export interface ClarifyQA {
  question: string
  answer: string
}

/** The Q/A pairs from the settled result (today: exactly one), else []. */
export function clarifyQA(part: ToolPartState): ClarifyQA[] {
  const r = structuredResult(part)
  if (!r) return []
  const question = typeof r['question'] === 'string' ? r['question'].trim() : ''
  const answer = typeof r['user_response'] === 'string' ? r['user_response'].trim() : ''
  if (!question || !answer) return []
  return [{ answer, question }]
}

/** Expanded body: `User answered:` + one `· question: answer` row per pair. */
export function ClarifyToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const qa = createMemo(() => clarifyQA(props.part))
  return (
    <Show when={qa().length > 0}>
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        {/* section label — chrome, not content */}
        <text selectable={false}>
          <span style={{ fg: theme().color.label }}>User answered:</span>
        </text>
        <For each={qa()}>
          {({ question, answer }) => (
            <text selectionBg={theme().color.selectionBg}>
              <span style={{ fg: theme().color.muted }}>{'· '}</span>
              <span style={{ fg: theme().color.text }}>
                {truncate(`${question}: ${answer}`, Math.max(1, props.width - 2))}
              </span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

export const clarifyRenderer: ToolRenderer = {
  Body: ClarifyToolBody,
  // Only the extracted Q/A is worth expanding — never the JSON result.
  expandable: part => clarifyQA(part).length > 0,
  // Honest "(N lines)": label + one row per pair.
  lines: part => {
    const qa = clarifyQA(part)
    return qa.length > 0 ? ['User answered:', ...qa.map(p => `· ${p.question}: ${p.answer}`)] : []
  },
  // Collapsed: compact `question: answer` once settled; the question while running.
  subtitle: part => {
    const qa = clarifyQA(part)
    const first = qa[0]
    if (first) return `${first.question}: ${first.answer}`.replace(/\s+/g, ' ').trim()
    return defaultSubtitle(part)
  }
}
