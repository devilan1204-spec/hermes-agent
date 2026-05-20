/**
 * Host-side copy-text builder. Plugged into Ink via `setCopyTextFn`.
 *
 * Walks the live DOM at copy time to find every Box tagged with
 * `style.copyRangeId` that intersects the current selection rect, builds
 * SelectionPoints for the anchor + focus of the selection, and calls
 * `toCopyText` against the registry + transcript.
 *
 * Drag-scroll fidelity comes for free: rangeIds remain in the registry
 * after their DOMs unmount, and the anchor SelectionPoint captured at
 * mouse-down stays valid through scroll because rangeIds are stable.
 * The "extends past viewport" cases that captureScrolledRows used to
 * handle are handled by toCopyText seeing the anchor-side range as
 * fully included (start col 0, span includes the range).
 */

import type { InkInstance } from '@hermes/ink'

import { copyPointFromColRow } from './hitTestBridge.js'
import { toCopyText } from './toCopyText.js'
import type { MsgSnapshot, SelectionPoint } from './types.js'

/**
 * Build the copy-text builder. Pass the current `transcript` getter so the
 * builder always sees the latest Msg[] when copy fires (avoids closing
 * over stale state).
 */
export function makeCopyTextFn(
  getTranscript: () => readonly MsgSnapshot[]
): (ink: InkInstance) => string {
  return (ink) => {
    const bounds = ink.getSelectionBoundsScreen()

    if (!bounds) {
      return ''
    }

    const rootDom = ink.getRootDom()
    const transcript = getTranscript()
    const anchor = copyPointFromColRow(rootDom, bounds.start.col, bounds.start.row, 'start')
    const focus = copyPointFromColRow(rootDom, bounds.end.col, bounds.end.row, 'end')

    // Cell-INCLUSIVE selection bounds × byte-EXCLUSIVE slice semantics:
    // when the focus point fell through to the no-fragment fallback
    // path (no sourceOffset set — e.g. code fences, plain text blocks
    // without inline markdown registered as fragments), the resolved
    // col still points AT the last selected cell. Bump it by +1 so
    // toCopyText's pointToOffset returns the byte-EXCLUSIVE end. The
    // bump is clamped by getOffset's per-row source-end cap, so no
    // over-read across line boundaries.
    //
    // For the fragment path, the hit-test already baked this bump in
    // (see copyPointHitTest endpoint='end' arg) and sourceOffset is
    // set — we leave that alone.
    const focusBumped: SelectionPoint =
      focus.kind === 'in-range' && focus.sourceOffset === undefined
        ? { ...focus, col: focus.col + 1 }
        : focus

    return toCopyText({ anchor, focus: focusBumped, transcript })
  }
}
