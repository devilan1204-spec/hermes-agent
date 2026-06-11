#!/usr/bin/env node
// live-cdp.mjs — minimal CDP client for live-attach.sh (no deps; Node ws via raw socket
// is overkill — use the built-in WebSocket of Node >=22).
// usage: node live-cdp.mjs <ws-url> profile <secs> <out> | heap 0 <out>
const [, , url, mode, secsArg, out] = process.argv
const { writeFileSync, appendFileSync } = await import('node:fs')
const ws = new WebSocket(url)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const chunks = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  } else if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk)
}
ws.onopen = async () => {
  try {
    if (mode === 'profile') {
      await send('Profiler.enable')
      await send('Profiler.start')
      await new Promise(r => setTimeout(r, Number(secsArg) * 1000))
      const { profile } = await send('Profiler.stop')
      writeFileSync(out, JSON.stringify(profile))
    } else {
      await send('HeapProfiler.enable')
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      writeFileSync(out, chunks.join(''))
    }
    process.exit(0)
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }
}
ws.onerror = err => { console.error('ws error', err.message ?? err); process.exit(1) }
