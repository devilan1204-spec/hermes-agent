#!/usr/bin/env node
// live-render.mjs — quick chart from live-attach samples: node bench/live-render.mjs <dir>
import { readFileSync, writeFileSync } from 'node:fs'
const dir = process.argv[2] ?? '.'
const rows = readFileSync(`${dir}/samples.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const t0 = rows[0].t
const pts = rows.map(r => ({ t: r.t - t0, rss: r.rss_kb / 1024, hwm: r.vmhwm_kb / 1024 }))
const W = 900, H = 360, mt = (v, max) => H - 30 - (v / max) * (H - 60)
const maxY = Math.max(...pts.map(p => p.hwm)) * 1.1
const path = k => pts.map((p, i) => `${i ? 'L' : 'M'}${30 + (p.t / pts.at(-1).t) * (W - 60)},${mt(p[k], maxY)}`).join('')
const cpu = rows.map((r, i) => i ? (r.cpu_ticks - rows[i-1].cpu_ticks) / r.cpu_hz / (r.t - rows[i-1].t) : 0)
writeFileSync(`${dir}/live.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#0d0d12">
<text x="30" y="20" fill="#ccc" font-family="monospace">live session: RSS (gold) / VmHWM (grey) MB · avg cpu ${(cpu.reduce((a,b)=>a+b,0)/Math.max(1,cpu.length-1)*100).toFixed(1)}% · ${rows.length}s</text>
<path d="${path('hwm')}" stroke="#888" fill="none"/><path d="${path('rss')}" stroke="#F5B820" fill="none" stroke-width="2"/>
<text x="30" y="${H-10}" fill="#888" font-family="monospace">0s</text><text x="${W-80}" y="${H-10}" fill="#888" font-family="monospace">${Math.round(pts.at(-1).t)}s</text>
<text x="${W-120}" y="${mt(pts.at(-1).rss,maxY)}" fill="#F5B820" font-family="monospace">${pts.at(-1).rss.toFixed(0)}MB</text></svg>`)
console.log(`${dir}/live.svg`)
