import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { countNodes, maybeStartMemSampler } from './memSampler.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const tree = {
  yogaNode: {},
  childNodes: [
    { yogaNode: {}, childNodes: [{ childNodes: [] }] }, // text child without yoga
    { yogaNode: {} },
    {} // virtual node, no yoga, no children
  ]
}

describe('memSampler', () => {
  afterEach(() => {
    delete process.env['HERMES_TUI_MEMSAMPLE_FD']
    delete process.env['HERMES_TUI_MEMSAMPLE_MS']
  })

  it('counts DOM and yoga nodes', () => {
    expect(countNodes(tree)).toEqual({ dom: 5, yoga: 3 })
  })

  it('is a no-op when the env gate is unset', () => {
    const stop = maybeStartMemSampler(tree)

    expect(typeof stop).toBe('function')
    stop()
  })

  it('writes NDJSON samples to the configured fd', async () => {
    const path = join(tmpdir(), `memsampler-test-${process.pid}-${Date.now()}.ndjson`)
    const fd = openSync(path, 'w')

    process.env['HERMES_TUI_MEMSAMPLE_FD'] = String(fd)

    const stop = maybeStartMemSampler(tree, 10)

    await sleep(60)
    stop()
    closeSync(fd)

    const lines = readFileSync(path, 'utf8').trim().split('\n')

    expect(lines.length).toBeGreaterThanOrEqual(2)

    const sample = JSON.parse(lines[0]!) as { dom: number; t: number; yoga: number }

    expect(sample.dom).toBe(5)
    expect(sample.yoga).toBe(3)
    expect(sample.t).toBeGreaterThan(0)
  })

  it('goes dark permanently on a bad fd instead of throwing', async () => {
    process.env['HERMES_TUI_MEMSAMPLE_FD'] = '987'

    const stop = maybeStartMemSampler(tree, 10)

    await sleep(40)
    stop()
  })
})
