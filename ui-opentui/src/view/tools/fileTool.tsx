/**
 * FileTool — renderer for the file tools `write_file`, `patch`, `read_file` and
 * `skill_manage` (Epic 2.3). Collapsed: the file path RELATIVE to the session
 * cwd, plus a themed `+N −M` change summary (rendered by the shell from
 * `stats`). Expanded: the FULL unified diff (gateway `diff_unified`, 512KB-
 * capped) through the NATIVE `<diff>` renderable — unified view (the transcript
 * is column-constrained), word-wrapped, line-numbered, themed. Multi-file diffs
 * are split per file (DiffRenderable parses only the FIRST file of a multi-file
 * diff) with a path label above each section. `read_file` (or any run without a
 * diff) falls back to the default labeled fields + output body.
 *
 * Arg keys verified against the Python tool schemas (tools/file_tools.py
 * READ_FILE_SCHEMA / WRITE_FILE_SCHEMA / PATCH_SCHEMA: `path`;
 * tools/skill_manager_tool.py skill_manage: `file_path`). patch-mode `patch`
 * calls have no path arg → gateway argsPreview fallback.
 *
 * Sizing: the `<diff>` gets NO height — like opencode's Edit() it sizes to its
 * content (the unified view is one auto-height code pane), so it never scrolls
 * internally against the transcript's outer <scrollbox>.
 */
import { pathToFiletype } from '@opentui/core'
import { createMemo, For, Show } from 'solid-js'

import { type DiffFileSection, relativizePath, splitUnifiedDiff } from '../../logic/diff.ts'
import type { ToolPartState } from '../../logic/store.ts'
import { syntaxStyleFor } from '../markdown.tsx'
import { useTheme } from '../theme.tsx'
import { DefaultToolBody, defaultRenderer, defaultSubtitle, structuredArgs, ToolOutputBlock } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** The tool's target path: `path` (file tools) / `file_path` (skill_manage),
 *  via structuredArgs (prefers gateway-redacted argsText); else argsPreview. */
export function filePathOf(part: ToolPartState): string {
  const args = structuredArgs(part)
  const p = args?.['path'] ?? args?.['file_path']
  if (typeof p === 'string' && p.trim()) return p
  return part.argsPreview ?? ''
}

/**
 * Whether the settled output adds nothing over the rendered diff: file-edit
 * results are JSON records whose payload IS the diff (`patch` returns
 * `{success, diff, …}`) — re-printing that below the native diff is noise.
 * Plain-text results (lint warnings, errors, capped tails) still show.
 */
function outputRedundantWithDiff(part: ToolPartState): boolean {
  const r = (part.resultText ?? '').trim()
  if (!r) return true
  if (!r.startsWith('{')) return false
  try {
    const o: unknown = JSON.parse(r)
    return Boolean(o && typeof o === 'object' && typeof (o as Record<string, unknown>)['diff'] === 'string')
  } catch {
    return false
  }
}

/** One file's diff: an optional path label (chrome) + the native `<diff>`. */
function FileDiff(props: { file: DiffFileSection; label: boolean; cwd?: string | undefined }) {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, minWidth: 0 }}>
      <Show when={props.label && props.file.path}>
        {/* per-file section label (multi-file diffs) — chrome, not content */}
        <text selectable={false}>
          <span style={{ fg: theme().color.label }}>{relativizePath(props.file.path, props.cwd)}</span>
        </text>
      </Show>
      <diff
        diff={props.file.diff}
        view="unified"
        wrapMode="word"
        showLineNumbers
        width="100%"
        filetype={pathToFiletype(props.file.path)}
        syntaxStyle={syntaxStyleFor(theme())}
        fg={theme().color.text}
        addedBg={theme().color.diffAddedBg}
        removedBg={theme().color.diffRemovedBg}
        addedSignColor={theme().color.ok}
        removedSignColor={theme().color.error}
        lineNumberFg={theme().color.muted}
        selectionBg={theme().color.selectionBg}
      />
    </box>
  )
}

/** Expanded body: per-file native diffs (+ non-redundant output), else default. */
export function FileToolBody(props: ToolBodyProps) {
  const files = createMemo(() => (props.part.diffUnified ? splitUnifiedDiff(props.part.diffUnified) : []))
  return (
    <Show when={files().length > 0} fallback={<DefaultToolBody part={props.part} width={props.width} />}>
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <For each={files()}>{file => <FileDiff file={file} label={files().length > 1} cwd={props.cwd} />}</For>
        <Show when={!outputRedundantWithDiff(props.part)}>
          <ToolOutputBlock part={props.part} width={props.width} label />
        </Show>
      </box>
    </Show>
  )
}

export const fileRenderer: ToolRenderer = {
  Body: FileToolBody,
  // A diff is always hidden content worth expanding; otherwise same as default.
  expandable: part => Boolean(part.diffUnified) || defaultRenderer.expandable(part),
  // `+N −M` (store-computed from diffUnified) — themed by the shell.
  stats: part => part.diffStats,
  // The target path, relative to the session cwd.
  subtitle: (part, cwd) => relativizePath(filePathOf(part), cwd) || defaultSubtitle(part)
}
