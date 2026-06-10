#!/usr/bin/env node
// E3-lite inner driver — runs INSIDE the memory-capped container (see
// run-e3.sh). Survival-to-OOM runs: Ink vs OpenTUI-capped on a long fixture;
// the CONTAINER cgroup is the cap (UI + fake gateway + this harness share it —
// labeled E3-lite, generic node image, not the shipped one).
//
// Heap sizing mirrors the production launcher inside a container:
// _resolve_tui_heap_mb reads /sys/fs/cgroup/memory.max → 75% of the limit
// (no floor at ≤2048MB limits): 1g → 768MB --max-old-space-size.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runScenario } from './harness.mjs'

const RESULTS = process.env.E3_RESULTS_DIR || '/results'
const MSGS = Number.parseInt(process.env.E3_MSGS ?? '10000', 10)
const FIXTURE = process.env.E3_FIXTURE || ''
const CELL = process.env.E3_CELL || 'e3lite-1g'

function launcherHeapMb() {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (raw === 'max') return 8192
    const limitMb = Math.floor(Number(raw) / (1024 * 1024))
    const sized = Math.floor(limitMb * 0.75)
    if (sized >= 8192) return 8192
    return limitMb > 2048 ? Math.max(1536, sized) : sized
  } catch {
    return 8192
  }
}

const heapMb = launcherHeapMb()
const memTotal = (() => {
  try {
    return readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
  } catch {
    return 'unknown'
  }
})()

process.stdout.write(`E3-lite: container memory.max=${memTotal} heapMb=${heapMb} msgs=${MSGS}\n`)

for (const [config, ui, cap] of [
  ['ink', 'ink', null],
  ['otui-capped', 'opentui', 3000]
]) {
  const utc = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const outFile = join(RESULTS, `${utc}-e3-${CELL}-${ui}-${config}-r0.json`)
  process.stdout.write(`▶ ${CELL} ${config}\n`)
  const r = await runScenario({
    ui,
    configName: config,
    opentuiCap: cap,
    mode: 'mem',
    fixturePath: FIXTURE,
    fixtureMsgs: MSGS,
    fixtureSha: process.env.E3_FIXTURE_SHA ?? '',
    memoryMax: null,
    containerCap: true,
    containerMemory: memTotal,
    heapMb,
    cell: CELL,
    rep: 0,
    outFile,
    runTimeoutMs: 60 * 60 * 1000
  })
  process.stdout.write(`  ✔ ${r.summary.result} msgs=${r.summary.msgs_streamed} vmhwm=${((r.summary.vmhwm_kb ?? 0) / 1024).toFixed(0)}MB basis=${r.summary.cap_hit_basis ?? '—'}\n`)
  await new Promise(res => setTimeout(res, 5000))
}
