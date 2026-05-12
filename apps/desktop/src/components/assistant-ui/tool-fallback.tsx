'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { createContext, type FC, type PropsWithChildren, type ReactNode, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { DisclosureRow } from '@/components/chat/disclosure-row'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { BrailleSpinner } from '@/components/ui/braille-spinner'
import { CopyButton } from '@/components/ui/copy-button'
import { FadeText } from '@/components/ui/fade-text'
import { PrettyLink, LinkifiedText as SharedLinkifiedText, urlSlugTitleLabel } from '@/lib/external-link'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $toolInlineDiffs } from '@/store/tool-diffs'
import { $toolDisclosureOpen, $toolViewMode, setToolDisclosureOpen } from '@/store/tool-view'

import {
  groupCopyText as buildGroupCopyText,
  buildToolView,
  cleanVisibleText,
  compactPreview,
  groupFailedStepCount,
  groupPreviewTargets,
  groupStatus,
  groupTailSubtitle,
  groupTitle,
  groupTotalDurationLabel,
  inlineDiffFromResult,
  isPreviewableTarget,
  looksRedundant,
  type SearchResultRow,
  selectMessageRunning,
  stripInlineDiffChrome,
  toolCopyPayload,
  type ToolPart,
  toolPartDisclosureId,
  type ToolStatus
} from './tool-fallback-model'

// Tool names that ChainToolFallback intercepts and renders as something
// other than a ToolEntry — they don't count toward "is this a group of
// tool calls?" because they have no visible tool block.
const SPECIAL_TOOL_NAMES = new Set(['todo', 'image_generate', 'clarify'])

// `true` when the current ToolEntry is being rendered inside a group
// wrapper. Lets ToolEntry suppress per-row chrome (timer / preview) that
// the group already shows.
const ToolEmbedContext = createContext(false)

const STATUS_DOT_CLASS: Record<ToolStatus, string> = {
  error: 'bg-destructive',
  running: 'bg-muted-foreground/55 animate-pulse',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500'
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  error: 'Error',
  running: 'Running',
  success: 'Done',
  warning: 'Recovered'
}

function statusDot(status: ToolStatus): ReactNode {
  return (
    <span
      aria-label={STATUS_LABEL[status]}
      className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[status])}
    />
  )
}

function statusGlyph(status: ToolStatus): ReactNode {
  if (status === 'running') {
    return (
      <BrailleSpinner
        ariaLabel="Running"
        className="size-3.5 shrink-0 text-[0.95rem] text-muted-foreground/80"
        spinner="breathe"
      />
    )
  }

  if (status === 'error') {
    return <AlertCircle aria-label="Error" className="size-3.5 shrink-0 text-destructive" />
  }

  if (status === 'warning') {
    return <AlertCircle aria-label="Recovered" className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
  }

  return <CheckCircle2 aria-label="Done" className="size-3.5 shrink-0 text-emerald-600/85 dark:text-emerald-400/85" />
}

function SearchResultsList({ hits }: { hits: SearchResultRow[] }) {
  return (
    <ol className="m-0 grid list-none gap-2.5 p-0">
      {hits.map((hit, index) => {
        const key = `${hit.url || hit.title}-${index}`
        const trimmedTitle = hit.title.trim()

        return (
          <li className="grid min-w-0 gap-0.5" key={key}>
            {hit.url ? (
              <PrettyLink
                className="block max-w-full text-[0.78rem] leading-snug"
                fallbackLabel={trimmedTitle || urlSlugTitleLabel(hit.url)}
                href={hit.url}
                label={trimmedTitle || undefined}
              />
            ) : (
              <span className="text-[0.78rem] font-medium leading-snug text-foreground/85">{trimmedTitle}</span>
            )}
            {hit.snippet && (
              <p className="m-0 line-clamp-3 text-[0.7rem] leading-snug text-muted-foreground/85">{hit.snippet}</p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function LinkifiedText({ className, text }: { className?: string; text: string }) {
  return <SharedLinkifiedText className={className} pretty text={cleanVisibleText(text)} />
}

interface ToolEntryProps {
  part: ToolPart
}

function useDisclosureOpen(disclosureId: string, fallbackOpen = false): boolean {
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))

  return persistedOpen ?? fallbackOpen
}

function ToolEntry({ part }: ToolEntryProps) {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)
  const embedded = useContext(ToolEmbedContext)
  const toolViewMode = useStore($toolViewMode)
  const disclosureId = `tool-entry:${messageId}:${toolPartDisclosureId(part)}`
  const open = useDisclosureOpen(disclosureId)
  const isPending = messageRunning && part.result === undefined
  // Only animate entries that mount while their message is actively
  // streaming — historical sessions mount with `messageRunning === false`,
  // so they paint statically without a settle cascade. The wrapping group
  // handles its own enter animation, so embedded children skip it.
  const enterRef = useEnterAnimation(messageRunning && !embedded, `tool-entry:${disclosureId}`)
  const elapsed = useElapsedSeconds(isPending, `tool:${disclosureId}`)
  const preview = compactPreview(part.args) || compactPreview(part.result)
  const liveDiffs = useStore($toolInlineDiffs)
  const sideDiff = part.toolCallId ? liveDiffs[part.toolCallId] || '' : ''
  const inlineDiff = stripInlineDiffChrome(sideDiff) || inlineDiffFromResult(part.result)

  // Stale parts (no result, but message stopped running) get a synthetic
  // empty result so buildToolView treats them as completed-no-output.
  const view = useMemo(() => {
    const p = !isPending && part.result === undefined ? { ...part, result: {} } : part

    return buildToolView(p, inlineDiff)
  }, [inlineDiff, isPending, part])

  const detailSections = useMemo(() => {
    if (!view.detail) {
      return { body: '', summary: '' }
    }

    if (view.status !== 'error') {
      return { body: view.detail, summary: '' }
    }

    const chunks = view.detail
      .split(/\n\s*\n+/)
      .map(chunk => chunk.trim())
      .filter(Boolean)

    const [summary = '', ...rest] = chunks
    const subtitleNorm = view.subtitle.trim().toLowerCase()
    const summaryDuplicatesSubtitle = summary && summary.toLowerCase() === subtitleNorm

    if (summaryDuplicatesSubtitle) {
      return { body: rest.join('\n\n').trim(), summary: '' }
    }

    return { body: rest.join('\n\n').trim(), summary }
  }, [view.detail, view.status, view.subtitle])

  const detailMatchesSubtitle = looksRedundant(view.subtitle, view.detail)

  const showDetail =
    (view.status === 'error' && Boolean(detailSections.summary || detailSections.body)) ||
    (view.status !== 'error' &&
      Boolean(view.detail) &&
      !looksRedundant(view.title, view.detail) &&
      !detailMatchesSubtitle)

  const renderDetailAsCode =
    view.status !== 'error' &&
    (part.toolName === 'terminal' || part.toolName === 'execute_code' || part.toolName === 'read_file')

  const hasSearchHits = Boolean(view.searchHits?.length)
  const searchResultsLabel = part.toolName === 'web_search' ? 'Search results' : view.detailLabel

  const showRawSearchDrilldown =
    part.toolName === 'web_search' &&
    part.result !== undefined &&
    toolViewMode !== 'technical' &&
    Boolean(view.rawResult.trim())

  const hasExpandableContent = Boolean(
    (view.previewTarget && isPreviewableTarget(view.previewTarget)) ||
    view.imageUrl ||
    showDetail ||
    hasSearchHits ||
    toolViewMode === 'technical'
  )

  const isTerminalLike = part.toolName === 'terminal' || part.toolName === 'execute_code'
  const subtitleText = view.subtitle ? (toolViewMode === 'technical' ? preview || view.subtitle : view.subtitle) : ''
  const subtitleIsSingleLine = !subtitleText.includes('\n')
  const showStatusGlyph = isPending || view.status === 'error' || view.status === 'warning'
  const copyAction = useMemo(() => toolCopyPayload(part, view), [part, view])

  const trailing =
    isPending && !embedded ? (
      <ActivityTimerText className="text-[0.625rem] tabular-nums text-muted-foreground/55" seconds={elapsed} />
    ) : !isPending && copyAction.text ? (
      <CopyButton appearance="tool-row" label={copyAction.label} stopPropagation text={copyAction.text} />
    ) : undefined

  return (
    <div
      className="min-w-0 max-w-full overflow-hidden text-sm text-muted-foreground"
      data-slot="tool-block"
      ref={enterRef}
    >
      <DisclosureRow
        onToggle={hasExpandableContent ? () => setToolDisclosureOpen(disclosureId, !open) : undefined}
        open={open}
        trailing={trailing}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {showStatusGlyph && (
            <span className="flex h-[1.1rem] shrink-0 items-center">
              {statusGlyph(isPending ? 'running' : view.status)}
            </span>
          )}
          <FadeText
            className={cn(
              'text-[0.78rem] font-medium leading-[1.1rem] text-foreground/85',
              isPending && 'shimmer text-foreground/55',
              view.status === 'error' && 'text-destructive',
              view.status === 'warning' && 'text-amber-700 dark:text-amber-300'
            )}
          >
            {view.title}
          </FadeText>
          {!isPending && view.countLabel && (
            <span className="shrink-0 text-[0.68rem] tabular-nums text-foreground/70">{view.countLabel}</span>
          )}
          {!isPending && view.durationLabel && (
            <span className="shrink-0 text-[0.625rem] tabular-nums text-midground/60 tracking-[0.04em]">
              {view.durationLabel}
            </span>
          )}
        </span>
        {subtitleText &&
          (subtitleIsSingleLine ? (
            <FadeText
              className={cn(
                'text-[0.7rem] leading-[1.05rem] text-muted-foreground/70',
                isTerminalLike && 'font-mono text-[0.68rem]'
              )}
            >
              {subtitleText}
            </FadeText>
          ) : (
            <span
              className={cn(
                'line-clamp-2 block whitespace-pre-wrap text-[0.7rem] leading-[1.05rem] text-muted-foreground/70',
                isTerminalLike && 'font-mono text-[0.68rem]'
              )}
            >
              {subtitleText}
            </span>
          ))}
      </DisclosureRow>
      {open && (
        <div className={cn('mt-2 grid w-full min-w-0 max-w-full gap-2 overflow-hidden pb-2 pr-2 pl-3')}>
          {!embedded && view.previewTarget && isPreviewableTarget(view.previewTarget) && (
            <PreviewAttachment source="tool-result" target={view.previewTarget} />
          )}
          {view.imageUrl && (
            <div className="max-w-72 overflow-hidden rounded-lg border border-border/70">
              <ZoomableImage alt="Tool output" className="h-auto w-full object-cover" src={view.imageUrl} />
            </div>
          )}
          {hasSearchHits && view.searchHits && (
            <div className="max-w-full text-xs leading-relaxed text-muted-foreground/90">
              {searchResultsLabel && (
                <p className="mb-1 text-[0.66rem] font-medium uppercase tracking-[0.06em] text-muted-foreground/65">
                  {searchResultsLabel}
                </p>
              )}
              <SearchResultsList hits={view.searchHits} />
            </div>
          )}
          {showDetail &&
            (view.status === 'error' ? (
              detailSections.summary || detailSections.body ? (
                <div className="max-w-full text-xs leading-relaxed text-destructive">
                  {detailSections.summary && (
                    <LinkifiedText className="block font-medium" text={detailSections.summary} />
                  )}
                  {detailSections.body && (
                    <pre
                      className={cn(
                        'max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-[0.7rem] leading-[1.55] text-destructive/90',
                        detailSections.summary && 'mt-1.5'
                      )}
                    >
                      {detailSections.body}
                    </pre>
                  )}
                </div>
              ) : null
            ) : (
              <div className="max-w-full text-xs leading-relaxed text-muted-foreground/90">
                {view.detailLabel && (
                  <p className="mb-1 text-[0.66rem] font-medium uppercase tracking-[0.06em] text-muted-foreground/65">
                    {view.detailLabel}
                  </p>
                )}
                {renderDetailAsCode ? (
                  <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere border-l-2 border-border/50 pl-3 font-mono text-[0.7rem] leading-[1.55] text-foreground/85">
                    {view.detail}
                  </pre>
                ) : (
                  <CompactMarkdown text={view.detail} />
                )}
              </div>
            ))}
          {showRawSearchDrilldown && (
            <details className="max-w-full rounded-md border border-border/60 bg-background/55 px-2 py-1.5">
              <summary className="cursor-pointer text-[0.65rem] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
                Raw response
              </summary>
              <pre className="mt-2 max-h-56 max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-[0.66rem] leading-normal text-muted-foreground/90">
                {view.rawResult}
              </pre>
            </details>
          )}
          {toolViewMode === 'technical' && (
            <div className="grid gap-2">
              <JsonSection label="Input" value={view.rawArgs} />
              {part.result !== undefined && <JsonSection label="Output" value={view.rawResult} />}
            </div>
          )}
        </div>
      )}
      {view.inlineDiff && <InlineDiff text={view.inlineDiff} />}
    </div>
  )
}

function JsonSection({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[0.65rem] font-medium tracking-[0.08em] text-muted-foreground/75 uppercase">
        {label}
      </div>
      <pre className="max-h-56 max-w-full overflow-auto rounded-md border border-border/70 bg-background/65 p-2 font-mono text-[0.65rem] leading-relaxed text-muted-foreground/90">
        {value}
      </pre>
    </div>
  )
}

/**
 * Always-present wrapper around the consecutive tool-call range that
 * `MessagePrimitive.Parts` already grouped for us. Renders a header +
 * collapsible body when there are 2+ visible tools; otherwise it's a
 * transparent passthrough that just owns the entry animation for the
 * single ToolEntry inside.
 *
 * Crucially, the wrapper element is the SAME `<div>` regardless of
 * group size — only the optional header element appears/disappears.
 * That preserves React identity for the inner `MessagePartByIndex`
 * children when the 1→2 transition happens, so existing tool blocks
 * never remount when a new tool joins them mid-stream.
 *
 * The previous design (per-tool ToolFallback computing its own group
 * lookup and conditionally returning either `<ToolEntry>` or
 * `<ToolGroup>`) flipped the React element type at the 1→2 transition
 * and tore down the existing tool entirely, which is what showed up as
 * "the previous tool's animation resets every time a new tool arrives."
 */
export const ToolGroupSlot: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)

  // Pull the visible tool parts in this range. `useShallow` makes this
  // re-render only when the actual part references change (assistant-ui
  // gives stable refs for unchanged parts), not on every text/reasoning
  // delta elsewhere in the message.
  const visibleParts = useAuiState(
    useShallow((s: { message: { parts: readonly unknown[] } }) =>
      s.message.parts.slice(startIndex, endIndex + 1).filter((p): p is ToolPart => {
        if (!p || typeof p !== 'object') {
          return false
        }
        const row = p as { toolName?: unknown; type?: unknown }

        return row.type === 'tool-call' && typeof row.toolName === 'string' && !SPECIAL_TOOL_NAMES.has(row.toolName)
      })
    )
  )

  const isGroup = visibleParts.length > 1
  const isRunning = messageRunning && visibleParts.some(p => p.result === undefined)
  // Stable across the group's lifetime (start index doesn't shift when
  // tools append to the end), so user-driven open/close persists across
  // streaming.
  const disclosureId = `tool-group:${messageId}:${startIndex}`
  const open = useDisclosureOpen(disclosureId)
  const enterRef = useEnterAnimation(messageRunning, disclosureId)

  const status = groupStatus(visibleParts)
  const displayStatus = !isRunning && status === 'running' ? 'success' : status
  const failedStepCount = useMemo(() => groupFailedStepCount(visibleParts), [visibleParts])
  const totalDurationLabel = useMemo(() => groupTotalDurationLabel(visibleParts), [visibleParts])

  const statusSummary =
    displayStatus === 'running' || failedStepCount === 0
      ? ''
      : displayStatus === 'warning'
        ? failedStepCount === 1
          ? 'Recovered after 1 failed step'
          : `Recovered after ${failedStepCount} failed steps`
        : failedStepCount === 1
          ? '1 step failed'
          : `${failedStepCount} steps failed`

  const tailSummary = useMemo(() => groupTailSubtitle(visibleParts), [visibleParts])
  const groupCopyText = useMemo(() => buildGroupCopyText(visibleParts), [visibleParts])
  const previewTargets = useMemo(() => groupPreviewTargets(visibleParts), [visibleParts])
  const showGroupStatusGlyph = displayStatus !== 'success'

  return (
    <ToolEmbedContext.Provider value={isGroup}>
      <div className="min-w-0 max-w-full overflow-hidden" data-slot="tool-block" ref={enterRef}>
        {isGroup && (
          <DisclosureRow
            key="header"
            onToggle={() => setToolDisclosureOpen(disclosureId, !open)}
            open={open}
            trailing={
              !isRunning && groupCopyText ? (
                <CopyButton appearance="tool-row" label="Copy activity" stopPropagation text={groupCopyText} />
              ) : undefined
            }
          >
            <span className="flex min-w-0 items-baseline gap-1.5">
              {showGroupStatusGlyph && (
                <span className="flex h-[1.1rem] shrink-0 items-center">{statusGlyph(displayStatus)}</span>
              )}
              <FadeText
                className={cn(
                  'text-[0.78rem] font-medium leading-[1.1rem] text-foreground/85',
                  displayStatus === 'error' && 'text-destructive',
                  displayStatus === 'warning' && 'text-amber-700 dark:text-amber-300'
                )}
              >
                {groupTitle(visibleParts)}
              </FadeText>
              {totalDurationLabel && (
                <span className="shrink-0 text-[0.625rem] tabular-nums text-muted-foreground/55">
                  {totalDurationLabel}
                </span>
              )}
            </span>
            {tailSummary && (
              <FadeText className="text-[0.7rem] leading-[1.05rem] text-muted-foreground/70">
                {tailSummary.replace(/\n+/g, ' · ')}
              </FadeText>
            )}
            {statusSummary && (
              <FadeText
                className={cn(
                  'text-[0.68rem] leading-[1.05rem]',
                  displayStatus === 'warning' ? 'text-amber-700/80 dark:text-amber-300/85' : 'text-destructive/85'
                )}
              >
                {statusSummary}
              </FadeText>
            )}
          </DisclosureRow>
        )}
        {isGroup && previewTargets.length > 0 && (
          <div className="mt-2 grid w-full min-w-0 max-w-full gap-2 overflow-hidden pr-2 pl-3">
            {previewTargets.map(target => (
              <PreviewAttachment key={target} source="tool-result" target={target} />
            ))}
          </div>
        )}
        {/* Body is always rendered so children stay mounted across collapse/
            expand and across the 1→2 group transition. `hidden` removes it
            from a11y/visual flow without unmounting React subtree. */}
        <div className={cn(isGroup && 'mt-0.5 w-full overflow-hidden pr-2 pl-3')} hidden={isGroup && !open} key="body">
          {children}
        </div>
      </div>
    </ToolEmbedContext.Provider>
  )
}

/**
 * Per-tool fallback. Now strictly returns a single ToolEntry — the
 * grouping decision lives in ToolGroupSlot above, so this never swaps
 * its return type and the underlying ToolEntry stays mounted across
 * group-shape changes.
 */
export const ToolFallback = ({ toolCallId, toolName, args, isError, result }: ToolCallMessagePartProps) => {
  const part: ToolPart = { args, isError, result, toolCallId, toolName, type: 'tool-call' }

  return <ToolEntry part={part} />
}

function InlineDiff({ text }: { text: string }) {
  return (
    <pre className="mt-2 max-h-96 max-w-full min-w-0 overflow-auto rounded-lg border border-border/60 bg-background/70 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
      {text.split('\n').map((line, index) => {
        const added = line.startsWith('+') && !line.startsWith('+++')
        const removed = line.startsWith('-') && !line.startsWith('---')
        const hunk = line.startsWith('@@')
        const fileHeader = line.startsWith('---') || line.startsWith('+++') || / → /.test(line.slice(0, 60))

        return (
          <span
            className={cn(
              'block min-w-max whitespace-pre',
              added && 'text-emerald-700 dark:text-emerald-300',
              removed && 'text-rose-700 dark:text-rose-300',
              hunk && 'text-sky-700 dark:text-sky-300',
              !added && !removed && !hunk && fileHeader && 'text-muted-foreground/80'
            )}
            key={`${index}-${line}`}
          >
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}
