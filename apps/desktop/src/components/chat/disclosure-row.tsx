import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Shared header row for any collapsible block (thinking, tool group, single
// tool). Each parent supplies its own outer wrapper (with the data-slot CSS
// uses to escape the message padding) and its own expanded body.
//
// Cursor-style affordance:
//   - No leading chevron; a caret appears to the RIGHT of the text on hover
//     (and stays visible when the row is open).
//   - The hover background is a tight content-shaped pill — sized to the
//     title text, NOT the full row — and reaches just past the chevron with
//     `-mx-1.5 px-1.5` so it reads as a soft hit-target rather than a slab
//     stretching to the message edge.
export function DisclosureRow({
  children,
  onToggle,
  open,
  trailing
}: {
  children: ReactNode
  onToggle?: () => void
  open: boolean
  trailing?: ReactNode
}) {
  return (
    <div className="group/disclosure-row relative flex w-full max-w-full min-w-0 text-muted-foreground">
      <button
        aria-expanded={onToggle ? open : undefined}
        className={cn(
          // max-w-fit so the click target hugs the title text width — no
          // background fill, just the cursor + the affordance caret.
          'flex min-w-0 max-w-fit items-start gap-2 text-left transition-colors',
          onToggle
            ? 'cursor-pointer hover:text-foreground focus-visible:text-foreground focus-visible:outline-none'
            : 'cursor-default'
        )}
        disabled={!onToggle}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 flex-col">{children}</span>
        {onToggle && (
          // Wrapper height matches the title row's line-height so the caret
          // is vertically centred with the title (not with the full stack
          // when a subtitle wraps below).
          <span
            className={cn(
              'flex h-[1.1rem] shrink-0 items-center justify-center transition-opacity duration-150',
              open
                ? 'opacity-80'
                : 'opacity-0 group-hover/disclosure-row:opacity-80 group-focus-within/disclosure-row:opacity-80'
            )}
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')}
              // currentColor + a chunkier stroke so the caret reads as a
              // confident hover affordance instead of a hairline.
              color="currentColor"
              strokeWidth={2.75}
            />
          </span>
        )}
      </button>
      {trailing && <span className="absolute right-1 top-0.5 flex h-[1.1rem] items-center">{trailing}</span>}
    </div>
  )
}
