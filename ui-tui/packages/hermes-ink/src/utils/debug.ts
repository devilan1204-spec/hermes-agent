import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Capture stderr/console.error writes that the alt-screen patcher would
 * otherwise drop on the floor.
 *
 * Why this exists: ink's `patchStderr()` rewrites `process.stderr.write`
 * to call `logForDebugging()` so stray writes don't corrupt the
 * alt-screen diff buffer. Historically this function was a no-op, which
 * meant `console.error` (and any module that wrote diagnostics to stderr)
 * was completely silent inside the TUI. That made bugs like the wl-copy
 * daemonization hang impossible to diagnose without rebuilding and
 * trial-and-erroring with strategic edits.
 *
 * Now: when `HERMES_TUI_DEBUG=1` (or any of the more specific
 * `HERMES_TUI_DEBUG_*` flags) is set, drop messages into
 * `~/.hermes/logs/tui-stderr.log`. Best-effort — failures are swallowed
 * because we'd rather lose a debug message than crash the TUI.
 *
 * Override the destination via `HERMES_TUI_DEBUG_LOG=<path>` when you
 * want a one-off log file (e.g. `/tmp/clip.log`).
 */

const HERMES_DEBUG_FLAGS = [
  'HERMES_TUI_DEBUG',
  'HERMES_TUI_DEBUG_CLIPBOARD',
  'HERMES_TUI_DEBUG_INPUT',
  'HERMES_TUI_DEBUG_RENDER',
  'HERMES_TUI_DEBUG_SELECTION'
]

function isDebugEnabled(): boolean {
  for (const flag of HERMES_DEBUG_FLAGS) {
    if (process.env[flag]) {
      return true
    }
  }

  return false
}

function resolveLogPath(): string {
  const override = process.env.HERMES_TUI_DEBUG_LOG?.trim()

  if (override) {
    return override
  }

  return join(homedir(), '.hermes', 'logs', 'tui-stderr.log')
}

let logPathReady = false

function ensureLogPath(path: string): void {
  if (logPathReady) {
    return
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    logPathReady = true
  } catch {
    // Best-effort — a missing/unwritable parent dir means we'll try
    // appendFileSync below and silently lose this message. Caller is
    // already in an error path; we don't surface the issue.
  }
}

export function logForDebugging(
  message: string,
  options: {
    level?: string
  } = {}
): void {
  if (!isDebugEnabled()) {
    return
  }

  const path = resolveLogPath()
  ensureLogPath(path)

  const level = options.level ?? 'info'
  const ts = new Date().toISOString()
  const line = `${ts} [${level}] ${message}\n`

  try {
    appendFileSync(path, line)
  } catch {
    // Lost message — the alternative is crashing the TUI from a logger.
  }
}
