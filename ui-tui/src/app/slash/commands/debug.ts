import { formatBytes, performHeapDump } from '../../../lib/memory.js'
import { patchOverlayState } from '../../overlayStore.js'
import type { SlashCommand } from '../types.js'

const GRID_TEST_USAGE = 'usage: /grid-test [cols]x[rows]  or  /grid-test [cols] [rows]'
const GRID_TEST_MAX_SIZE = 12

const clampGridSize = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.max(1, Math.min(GRID_TEST_MAX_SIZE, Math.trunc(value)))
}

const parseGridTestSize = (arg: string) => {
  const trimmed = arg.trim()

  if (!trimmed) {
    return { cols: 4, rows: 3 }
  }

  const grid = trimmed.match(/^(\d+)\s*x\s*(\d+)$/i)

  if (grid) {
    return { cols: clampGridSize(Number(grid[1]), 4), rows: clampGridSize(Number(grid[2]), 3) }
  }

  const [cols, rows, ...rest] = trimmed.split(/\s+/)

  if (rest.length || !cols || !rows || Number.isNaN(Number(cols)) || Number.isNaN(Number(rows))) {
    return null
  }

  return { cols: clampGridSize(Number(cols), 4), rows: clampGridSize(Number(rows), 3) }
}

export const debugCommands: SlashCommand[] = [
  {
    help: 'open an interactive widget-grid demo overlay',
    name: 'grid-test',
    run: (arg, ctx) => {
      const size = parseGridTestSize(arg)

      if (!size) {
        return ctx.transcript.sys(GRID_TEST_USAGE)
      }

      patchOverlayState({
        gridTest: {
          activeCol: 0,
          activeRow: 0,
          cols: size.cols,
          gap: null,
          nested: false,
          paddingX: null,
          rows: size.rows,
          zoomed: false
        }
      })
    }
  },

  {
    help: 'write a V8 heap snapshot + memory diagnostics (see HERMES_HEAPDUMP_DIR)',
    name: 'heapdump',
    run: (_arg, ctx) => {
      const { heapUsed, rss } = process.memoryUsage()

      ctx.transcript.sys(`writing heap dump (heap ${formatBytes(heapUsed)} · rss ${formatBytes(rss)})…`)

      void performHeapDump('manual').then(r => {
        if (ctx.stale()) {
          return
        }

        if (!r.success) {
          return ctx.transcript.sys(`heapdump failed: ${r.error ?? 'unknown error'}`)
        }

        ctx.transcript.sys(`heapdump: ${r.heapPath}`)
        ctx.transcript.sys(`diagnostics: ${r.diagPath}`)
      })
    }
  },

  {
    help: 'print live V8 heap + rss numbers',
    name: 'mem',
    run: (_arg, ctx) => {
      const { arrayBuffers, external, heapTotal, heapUsed, rss } = process.memoryUsage()

      ctx.transcript.panel('Memory', [
        {
          rows: [
            ['heap used', formatBytes(heapUsed)],
            ['heap total', formatBytes(heapTotal)],
            ['external', formatBytes(external)],
            ['array buffers', formatBytes(arrayBuffers)],
            ['rss', formatBytes(rss)],
            ['uptime', `${process.uptime().toFixed(0)}s`]
          ]
        }
      ])
    }
  }
]
