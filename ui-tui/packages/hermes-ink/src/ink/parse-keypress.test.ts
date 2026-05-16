import { describe, expect, it } from 'vitest'

import { INITIAL_STATE, parseMultipleKeypresses } from './parse-keypress.js'
import { PASTE_END, PASTE_START } from './termio/csi.js'

describe('parseMultipleKeypresses bracketed paste recovery', () => {
  it('emits empty bracketed pastes when the terminal sends both markers', () => {
    const [keys, state] = parseMultipleKeypresses(INITIAL_STATE, PASTE_START + PASTE_END)

    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ isPasted: true, raw: '' })
    expect(state.mode).toBe('NORMAL')
  })

  it('flushes unterminated paste content back to normal input mode', () => {
    const [pendingKeys, pendingState] = parseMultipleKeypresses(INITIAL_STATE, PASTE_START + 'hello')

    expect(pendingKeys).toEqual([])
    expect(pendingState.mode).toBe('IN_PASTE')

    const [keys, state] = parseMultipleKeypresses(pendingState, null)

    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ isPasted: true, raw: 'hello' })
    expect(state.mode).toBe('NORMAL')
    expect(state.pasteBuffer).toBe('')
  })

  it('resets an empty unterminated paste start instead of staying stuck', () => {
    const [pendingKeys, pendingState] = parseMultipleKeypresses(INITIAL_STATE, PASTE_START)

    expect(pendingKeys).toEqual([])
    expect(pendingState.mode).toBe('IN_PASTE')

    const [keys, state] = parseMultipleKeypresses(pendingState, null)

    expect(keys).toEqual([])
    expect(state.mode).toBe('NORMAL')
    expect(state.pasteBuffer).toBe('')
  })
})

describe('mouse wheel modifier decoding', () => {
  // SGR mouse format: ESC [ < button ; col ; row M
  // Wheel up = 64 (0x40), wheel down = 65 (0x41).
  // Modifier bits: shift = 0x04, meta = 0x08, ctrl = 0x10.
  const sgrWheel = (button: number) => `\x1b[<${button};10;10M`

  it('plain wheel up has no modifiers', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x40))

    expect(key).toMatchObject({ name: 'wheelup', ctrl: false, meta: false, shift: false })
  })

  it('plain wheel down has no modifiers', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x41))

    expect(key).toMatchObject({ name: 'wheeldown', ctrl: false, meta: false, shift: false })
  })

  it('decodes meta (Alt/Option) on wheel up', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x40 | 0x08))

    expect(key).toMatchObject({ name: 'wheelup', ctrl: false, meta: true, shift: false })
  })

  it('decodes meta (Alt/Option) on wheel down', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x41 | 0x08))

    expect(key).toMatchObject({ name: 'wheeldown', ctrl: false, meta: true, shift: false })
  })

  it('decodes ctrl on wheel events', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x40 | 0x10))

    expect(key).toMatchObject({ name: 'wheelup', ctrl: true, meta: false, shift: false })
  })

  it('decodes shift on wheel events', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x41 | 0x04))

    expect(key).toMatchObject({ name: 'wheeldown', ctrl: false, meta: false, shift: true })
  })

  it('decodes combined modifiers', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, sgrWheel(0x40 | 0x08 | 0x10))

    expect(key).toMatchObject({ name: 'wheelup', ctrl: true, meta: true, shift: false })
  })

  it('decodes meta on legacy X10 wheel encoding', () => {
    // X10: ESC [ M Cb Cx Cy where each byte is value+32.
    const x10 = `\x1b[M${String.fromCharCode(0x40 + 0x08 + 32)}${String.fromCharCode(10 + 32)}${String.fromCharCode(10 + 32)}`
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, x10)

    expect(key).toMatchObject({ name: 'wheelup', meta: true })
  })
})

describe('fragmented SGR mouse recovery', () => {
  it('re-synthesizes bracket-only SGR mouse tails as mouse events', () => {
    const [[mouse]] = parseMultipleKeypresses(INITIAL_STATE, '[<35;159;11M')

    expect(mouse).toMatchObject({ kind: 'mouse', button: 35, col: 159, row: 11, action: 'press' })
  })

  it('re-synthesizes angle-only SGR mouse tails as mouse events', () => {
    const [[mouse]] = parseMultipleKeypresses(INITIAL_STATE, '<35;159;11M')

    expect(mouse).toMatchObject({ kind: 'mouse', button: 35, col: 159, row: 11, action: 'press' })
  })

  it('re-synthesizes degraded SGR mouse bursts without leaking prompt text', () => {
    const [events] = parseMultipleKeypresses(INITIAL_STATE, '5;142;11M<35;159;11M35;124;26M35;119;26Mtyped')

    expect(events.slice(0, 4)).toEqual([
      expect.objectContaining({ kind: 'mouse', button: 5, col: 142, row: 11 }),
      expect.objectContaining({ kind: 'mouse', button: 35, col: 159, row: 11 }),
      expect.objectContaining({ kind: 'mouse', button: 35, col: 124, row: 26 }),
      expect.objectContaining({ kind: 'mouse', button: 35, col: 119, row: 26 })
    ])
    expect(events[4]).toMatchObject({ kind: 'key', sequence: 'typed' })
  })

  it('keeps isolated semicolon text that only resembles a prefixless mouse report', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, 'see 1;2;3M for details')

    expect(key).toMatchObject({ kind: 'key', sequence: 'see 1;2;3M for details' })
  })

  it('does not match prefixless fragments inside longer digit runs', () => {
    const [[key]] = parseMultipleKeypresses(INITIAL_STATE, '1234;56;78M9;10;11M')

    expect(key).toMatchObject({ kind: 'key', sequence: '1234;56;78M9;10;11M' })
  })

  it('swallows degraded windows-terminal mouse bursts without leaking to the prompt', () => {
    // Real capture from Windows Terminal during a wheel-scroll storm: button
    // codes / ESC[< prefixes have been chewed off, leaving pure mouse-leak
    // alphabet with many M/m terminators.
    const leak =
      ';76;50mM1M68;36M;73;35M;74;38M74;41M75;41M66;38M37M2;38M;49;38M35;40;39M9M5;37;39M39M;32;39M29;39M0M0MM6MMMMM'
    const [events] = parseMultipleKeypresses(INITIAL_STATE, leak)
    const visibleKeys = events.filter(e => e.kind === 'key' && !e.isPasted)

    expect(visibleKeys).toEqual([])
  })

  it('swallows a degraded mouse burst that surrounds a real fragment with leak chars', () => {
    // Real fragment in the middle, noise on both sides — the surrounding
    // noise should not leak as typed keys.
    const text = ';12;34m<32;76;50M;78;52M;99;9M0MM'
    const [events] = parseMultipleKeypresses(INITIAL_STATE, text)
    const visibleKeys = events.filter(e => e.kind === 'key' && !e.isPasted)

    expect(visibleKeys).toEqual([])
  })
})
