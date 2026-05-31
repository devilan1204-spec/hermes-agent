import { describe, expect, it } from 'vitest'

import { stripAnsi } from '../lib/text.js'
import { estimatedMsgHeight, wrappedLines } from '../lib/virtualHeights.js'
import type { Msg } from '../types.js'

// Guards the Copilot perf concern on #35992: stripAnsi(msg.text) ran over the
// FULL message before wrappedLines' byte budget could cap the work, so a
// multi-megabyte ANSI-heavy message re-introduced O(text) cost at cold-mount.
// The bounded strippedForEstimate slices to the wrap budget (× an ANSI overhead
// factor) first. These tests assert (a) the bounded estimate still equals the
// full-strip estimate even when the message saturates the row cap, including
// for the densest realistic SGR, and (b) cold-mounting a giant ANSI message
// stays fast (no full-text strip).

// Densest realistic SGR: per-word truecolor open + reset (~20 bytes wrapping a
// short token, ~5.5× overhead) — the cli-highlight / Rich style that triggered
// the original resume desync.
const colorWord = (w: string) => `\u001b[38;2;200;120;40m${w}\u001b[39m`

const makeAnsiBlob = (lines: number, wordsPerLine: number) => {
  const row = Array.from({ length: wordsPerLine }, (_, i) => colorWord(`tok${i}`)).join(' ')

  return Array.from({ length: lines }, () => row).join('\n')
}

const asMsg = (text: string): Msg => ({ role: 'assistant', text }) as Msg
const opts = { compact: false, details: false }

describe('strippedForEstimate (bounded ANSI strip)', () => {
  it('matches the full-strip estimate when a dense-SGR message saturates the row cap', () => {
    // Far longer than MAX_ESTIMATE_LINES (800) rows. The invariant: the bounded
    // strip yields the SAME estimate as stripping the whole string — the perf
    // fix must not change the number even for the densest SGR.
    const blob = makeAnsiBlob(2000, 12)
    const cols = 80

    const bounded = estimatedMsgHeight(asMsg(blob), cols, opts)
    const fullStrip = estimatedMsgHeight(asMsg(stripAnsi(blob)), cols, opts)

    expect(fullStrip).toBe(bounded)
  })

  it('matches the full-strip estimate for a message that fits within the budget', () => {
    const blob = makeAnsiBlob(40, 10)
    const cols = 80

    const bounded = estimatedMsgHeight(asMsg(blob), cols, opts)
    const fullStrip = estimatedMsgHeight(asMsg(stripAnsi(blob)), cols, opts)

    expect(bounded).toBe(fullStrip)
    // sanity: small message, no clamping
    expect(bounded).toBe(wrappedLines(stripAnsi(blob), cols))
  })

  it('cold-mounts a multi-megabyte ANSI message without an O(text) strip', () => {
    // ~23 MB of dense ANSI — unbounded, this would chew the whole buffer on
    // every offset rebuild. Bounded, it touches only ~520 KB (budget × 8).
    const blob = makeAnsiBlob(60_000, 14)
    expect(blob.length).toBeGreaterThan(3_000_000)

    const cols = 100
    let h = 0
    const start = performance.now()

    // Simulate repeated offset rebuilds (the hot path on cold-mount / resize).
    for (let i = 0; i < 50; i++) {
      h = estimatedMsgHeight(asMsg(blob), cols, opts)
    }

    const elapsed = performance.now() - start

    // Still clamps to the row cap (bounded slice reaches it on dense SGR).
    expect(h).toBe(800)
    // 50 estimates over a 23 MB message must stay well under a second. An
    // unbounded strip (multiple regex passes × 23 MB × 50) would blow past
    // this by orders of magnitude. Generous ceiling avoids CI flake while
    // still catching a regression to full-text stripping.
    expect(elapsed).toBeLessThan(500)
  })
})
