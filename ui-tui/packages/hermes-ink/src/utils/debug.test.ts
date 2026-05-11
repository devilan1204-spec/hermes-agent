import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { logForDebugging } from './debug.js'

let logDir: string
let logPath: string

const ENV_KEYS = [
  'HERMES_TUI_DEBUG',
  'HERMES_TUI_DEBUG_CLIPBOARD',
  'HERMES_TUI_DEBUG_INPUT',
  'HERMES_TUI_DEBUG_RENDER',
  'HERMES_TUI_DEBUG_SELECTION',
  'HERMES_TUI_DEBUG_LOG'
]

beforeEach(() => {
  logDir = join(tmpdir(), `hermes-debug-test-${process.pid}-${Date.now()}`)
  mkdirSync(logDir, { recursive: true })
  logPath = join(logDir, 'tui-stderr.log')

  // Clean slate every test — env vars from this test must not leak
  // into the next, and vice versa.
  for (const k of ENV_KEYS) {
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    delete process.env[k]
  }

  rmSync(logDir, { recursive: true, force: true })
})

describe('logForDebugging', () => {
  it('drops messages on the floor when no debug flag is set', () => {
    process.env.HERMES_TUI_DEBUG_LOG = logPath
    logForDebugging('should not appear')

    expect(existsSync(logPath)).toBe(false)
  })

  it('writes to HERMES_TUI_DEBUG_LOG when HERMES_TUI_DEBUG=1', () => {
    process.env.HERMES_TUI_DEBUG = '1'
    process.env.HERMES_TUI_DEBUG_LOG = logPath

    logForDebugging('hello world')

    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toMatch(/\[info\] hello world/)
  })

  it('honors level option', () => {
    process.env.HERMES_TUI_DEBUG = '1'
    process.env.HERMES_TUI_DEBUG_LOG = logPath

    logForDebugging('something went wrong', { level: 'error' })

    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toMatch(/\[error\] something went wrong/)
  })

  it('activates on any HERMES_TUI_DEBUG_* flag', () => {
    process.env.HERMES_TUI_DEBUG_CLIPBOARD = '1'
    process.env.HERMES_TUI_DEBUG_LOG = logPath

    logForDebugging('clipboard probe done')

    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toMatch(/clipboard probe done/)
  })

  it('appends rather than overwriting', () => {
    process.env.HERMES_TUI_DEBUG = '1'
    process.env.HERMES_TUI_DEBUG_LOG = logPath

    logForDebugging('first')
    logForDebugging('second')

    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/first/)
    expect(lines[1]).toMatch(/second/)
  })

  it('prefixes each line with an ISO timestamp', () => {
    process.env.HERMES_TUI_DEBUG = '1'
    process.env.HERMES_TUI_DEBUG_LOG = logPath

    logForDebugging('marker')

    const contents = readFileSync(logPath, 'utf8').trim()
    // ISO 8601 prefix: 2026-05-11T22:30:45.123Z
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /)
  })

  it('does not throw when the log directory cannot be created', () => {
    process.env.HERMES_TUI_DEBUG = '1'
    // Path under /proc/1 is read-only on Linux — unwritable for tests.
    // Falls back to silent failure rather than crashing the TUI.
    process.env.HERMES_TUI_DEBUG_LOG = '/proc/1/cant-write-here.log'

    expect(() => logForDebugging('boom')).not.toThrow()
  })
})
