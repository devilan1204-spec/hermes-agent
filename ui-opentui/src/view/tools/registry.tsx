/**
 * Tool renderer registry (Epic 2.2) — maps a tool NAME to its renderer. The
 * shared shell (header glyph, expand toggle + scroll anchoring, the left-border
 * body frame) stays in `view/toolPart.tsx` so every tool keeps the house rules
 * (useScrollAnchor, themed chrome) for free; a renderer only supplies what
 * varies per tool:
 *   - `subtitle`   — the collapsed one-line summary shown after the tool name
 *   - `hint`       — an extra muted header note (e.g. delegate_task's monitor tip)
 *   - `expandable` — whether there's a body worth expanding beyond the header
 *   - `Body`       — the expanded body (labeled arg fields / output / diff)
 *
 * Unmapped tools (incl. MCP tools) fall back to the labeled-fields default
 * renderer — NEVER a raw JSON dump. To add a per-tool renderer (e.g.
 * `fileTool.tsx` for read/write/edit path+diff — Epic 2.3): export a
 * `ToolRenderer` from a sibling module and add its tool names to `TOOLS`.
 */
import type { Component } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { defaultRenderer } from './defaultTool.tsx'

/** Props every tool Body receives: the part + usable content columns. */
export interface ToolBodyProps {
  part: ToolPartState
  /** Width (columns) available for body lines inside the bordered frame. */
  width: number
}

export interface ToolRenderer {
  /** Collapsed one-line subtitle (verbatim command, primary arg, …). */
  subtitle: (part: ToolPartState) => string
  /** Optional muted header note (chrome) — e.g. delegate_task's "(/agents to monitor)". */
  hint?: (part: ToolPartState) => string
  /** Whether the part has expandable content beyond the header (when settled). */
  expandable: (part: ToolPartState) => boolean
  /** The expanded body, rendered inside the shared left-bordered frame. */
  Body: Component<ToolBodyProps>
}

const TOOLS: Record<string, ToolRenderer> = {
  // delegate_task: default labeled fields + the Ink-parity monitor hint
  // (ui-tui/src/components/thinking.tsx — "(/agents to monitor)").
  delegate_task: { ...defaultRenderer, hint: () => '(/agents to monitor)' }
}

/** Resolve the renderer for a tool name (default = labeled-fields fallback). */
export function rendererFor(name: string): ToolRenderer {
  return TOOLS[name] ?? defaultRenderer
}
