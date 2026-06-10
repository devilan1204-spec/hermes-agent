/**
 * SkillTool — renderer for `skill_view` (feedback item 5: "don't show the
 * skill output — just show WHICH skill was loaded"). The result is a JSON dict
 * whose `content` is the ENTIRE skill body (often many KB) — pure noise in the
 * transcript (the agent consumed it, the user only needs the fact of the load).
 *
 * Collapsed: `skill_view <name>` (plus the linked file path when the call
 * loaded one). Expanded: the name + its one-line description (cheap: the
 * result already carries `description`); the full contents stay suppressed.
 *
 * Wire shape (verified live, v6fix capture + tools/skills_tool.py):
 *   args   → {"name": "…", "file_path"?: "references/…"}
 *   result → {"success": true, "name": "…", "description": "…", "content": …}
 *   (file view → {"success": true, "name": "…", "file": "…", "content": …})
 */
import { createMemo, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import { defaultSubtitle, structuredArgs, structuredResult } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

export interface SkillInfo {
  name: string
  /** Linked file loaded by this call (args `file_path` / result `file`), if any. */
  file?: string
  /** One-line description from the result (main SKILL.md views only). */
  description?: string
}

/** Which skill (and optional linked file) this call loaded. */
export function skillInfoOf(part: ToolPartState): SkillInfo | undefined {
  const args = structuredArgs(part)
  const result = structuredResult(part)
  const name =
    (typeof result?.['name'] === 'string' && result['name'].trim()) ||
    (typeof args?.['name'] === 'string' && args['name'].trim()) ||
    ''
  if (!name) return undefined
  const info: SkillInfo = { name }
  const file = args?.['file_path'] ?? result?.['file']
  if (typeof file === 'string' && file.trim()) info.file = file.trim()
  const description = result?.['description']
  if (typeof description === 'string' && description.trim()) info.description = description.replace(/\s+/g, ' ').trim()
  return info
}

/** Expanded body: name (+ linked file) and the one-line description — never the contents. */
export function SkillToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const info = createMemo(() => skillInfoOf(props.part))
  return (
    <Show when={info()}>
      {i => (
        <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <text selectionBg={theme().color.selectionBg}>
            {/* field label — chrome-colored, value is the content */}
            <span style={{ fg: theme().color.label }}>skill</span>
            <span style={{ fg: theme().color.text }}>
              {`  ${truncate(i().name + (i().file ? ` · ${i().file ?? ''}` : ''), Math.max(1, props.width - 7))}`}
            </span>
          </text>
          <Show when={i().description}>
            <text selectionBg={theme().color.selectionBg}>
              <span style={{ fg: theme().color.muted }}>
                {truncate(i().description ?? '', Math.max(1, props.width))}
              </span>
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

export const skillRenderer: ToolRenderer = {
  Body: SkillToolBody,
  // Only the name/description summary is worth expanding — never the contents.
  expandable: part => Boolean(skillInfoOf(part)?.description),
  // Honest "(N lines)": what the body actually shows (suppresses the JSON count).
  lines: part => {
    const i = skillInfoOf(part)
    if (!i) return []
    return i.description ? [i.name, i.description] : [i.name]
  },
  // Collapsed: WHICH skill was loaded (+ the linked file when one was).
  subtitle: part => {
    const i = skillInfoOf(part)
    if (!i) return defaultSubtitle(part)
    return i.file ? `${i.name} · ${i.file}` : i.name
  }
}
