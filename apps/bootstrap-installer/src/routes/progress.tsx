import { useEffect, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { Button } from '../components/button'
import {
  cancelInstall,
  $mode,
  $progress,
  type BootstrapStateModel,
  type StageState
} from '../store'
import { Check, X, ChevronRight, FileText } from 'lucide-react'
import clsx from 'clsx'
import { Loader } from '../components/loader'

interface ProgressProps {
  bootstrap: BootstrapStateModel
}

/*
 * Progress screen — drives a stage list + collapsible log panel. Uses
 * the DS <Progress> for the top bar so its motion + ring match the rest
 * of the product.
 */
export default function ProgressScreen({ bootstrap }: ProgressProps) {
  const progress = useStore($progress)
  const mode = useStore($mode)
  const [showLogs, setShowLogs] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showLogs && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [bootstrap.logs.length, showLogs])

  // Fixed action label — the per-stage detail lives in the list below, so the
  // header must not echo the current stage (that read as the same thing twice).
  const heading =
    bootstrap.status === 'completed' ? 'Done' : mode === 'update' ? 'Updating' : 'Installing'

  return (
    <div className="hermes-fade-in flex h-full flex-col">
      <div className="border-b border-(--stroke-nous) px-6 py-4">
        <div className="mb-3 flex items-center justify-between text-xs">
          <span className={clsx(bootstrap.status === 'running' ? 'shimmer text-foreground/60' : 'text-foreground')}>
            {heading}
          </span>
          <div className="tabular-nums text-muted-foreground">
            {progress.done} of {progress.total} steps
          </div>
        </div>
        {/* Top progress bar — plain HTML, derived from --primary so it
            tracks the theme accent. */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.max(2, progress.fraction * 100)}%` }}
          />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Flat stage list: only the running step is opaque; the rest read as
            muted. Running spinner overhangs left so labels stay aligned; the
            terminal check/cross sits right of the label. */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ol className="space-y-0.5">
            {bootstrap.stageOrder.map((name) => {
              const rec = bootstrap.stages[name]
              if (!rec) return null
              return (
                <li
                  key={name}
                  className={clsx(
                    'flex items-center gap-2.5 px-3 py-1.5 text-sm',
                    rec.state === 'running'
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  )}
                >
                  {rec.state === 'running' && <Loader className="-ml-2 size-6 shrink-0" />}
                  <span className="flex-1 truncate">{rec.info.title}</span>
                  {rec.durationMs != null && rec.state !== 'failed' && (
                    <span className="text-xs tabular-nums text-muted-foreground/70">
                      {formatDuration(rec.durationMs)}
                    </span>
                  )}
                  <StateIcon state={rec.state ?? null} />
                </li>
              )
            })}
          </ol>
        </div>

        {showLogs && (
          <div className="flex w-1/2 flex-col border-l border-(--stroke-nous)">
            <div className="flex shrink-0 items-center justify-between border-b border-(--stroke-nous) px-3 py-2 text-xs">
              <span className="font-medium text-foreground/80">Live output</span>
              <span className="tabular-nums text-muted-foreground">{bootstrap.logs.length} lines</span>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed">
              {bootstrap.logs.map((entry, idx) => (
                <div
                  key={idx}
                  className={clsx(
                    'whitespace-pre-wrap',
                    entry.stream === 'stderr' ? 'text-foreground/45' : 'text-foreground/70'
                  )}
                >
                  {entry.line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-(--stroke-nous) px-6 py-3">
        <button
          type="button"
          onClick={() => setShowLogs((v) => !v)}
          className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileText size={14} />
          {showLogs ? 'Hide details' : 'Show details'}
          <ChevronRight size={12} className={clsx('transition-transform', showLogs && 'rotate-90')} />
        </button>

        {bootstrap.status === 'running' && (
          <Button variant="outline" size="sm" onClick={() => void cancelInstall()}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

// Terminal-state markers, neutral by design: a muted check for done/skipped
// (no celebratory green), a destructive cross for failure. Running renders its
// spinner on the left; pending stays icon-less.
function StateIcon({ state }: { state: StageState | null }) {
  if (state === 'succeeded') {
    return <Check size={13} className="shrink-0 text-muted-foreground" />
  }
  if (state === 'skipped') {
    return <Check size={13} className="shrink-0 text-muted-foreground/50" />
  }
  if (state === 'failed') {
    return <X size={13} className="shrink-0 text-destructive" />
  }
  return null
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m ${s}s`
}
