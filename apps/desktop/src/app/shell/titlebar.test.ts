import { describe, expect, it } from 'vitest'

import { TITLEBAR_CONTROL_OFFSET_X, titlebarControlsPosition } from './titlebar'

describe('titlebarControlsPosition', () => {
  it('offsets controls from visible traffic lights', () => {
    expect(titlebarControlsPosition({ x: 24, y: 10 }).left).toBe(24 + TITLEBAR_CONTROL_OFFSET_X)
  })

  it('pins to the edge when macOS fullscreen hides traffic lights', () => {
    expect(titlebarControlsPosition({ x: 24, y: 10 }, true).left).toBe(14)
  })

  it('falls back to the default offset when traffic-light coords are unavailable', () => {
    expect(titlebarControlsPosition(undefined, true).left).toBe(24 + TITLEBAR_CONTROL_OFFSET_X)
  })
})
