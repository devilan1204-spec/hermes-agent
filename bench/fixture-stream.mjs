#!/usr/bin/env node
// Serialize the deterministic lumpy-turn fixture (ui-opentui/scripts/fixture.ts)
// to NDJSON for the fake gateway. We check in THIS generator invocation, not the
// generated file (it is megabytes); the stream is byte-reproducible for a given
// message count because the fixture is seeded by turn index.
//
// The generator is imported DIRECTLY from ui-opentui/scripts/fixture.ts via
// Node >=26 type stripping — no port, no drift. `applyTurn(store, turn)` only
// calls store.pushUser/pushSystem/apply, so a recorder stub extracts the exact
// per-turn action stream the OpenTUI mem-bench drives.
//
// Line format (one JSON object per line):
//   {"k":"e","v":{...GatewayEvent...}}   → sent on the wire as
//                                          {jsonrpc:"2.0",method:"event",params:v}
//   {"k":"r","role":"user"|"system"}     → row marker, NOT sent (composer-local
//                                          rows have no wire representation —
//                                          see README "deviation: user rows")
//   {"k":"t","msgs":N}                   → end-of-turn marker with the CUMULATIVE
//                                          fixture-message count (rowsPerTurn
//                                          accounting, same as scripts/mem-bench.tsx)
//
// Usage: node fixture-stream.mjs --msgs 3000 [--out path]
// Default out: bench/.cache/fixture-<msgs>.ndjson  (prints path + sha256)

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureTs = resolve(here, '../ui-opentui/scripts/fixture.ts')

function parseArgs(argv) {
  const args = { msgs: 3000, out: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--msgs') args.msgs = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--out') args.out = argv[++i]
  }
  if (!Number.isFinite(args.msgs) || args.msgs <= 0) throw new Error('--msgs must be a positive integer')
  return args
}

export async function generate(msgs, outPath) {
  const { applyTurn, rowsPerTurn } = await import(pathToFileURL(fixtureTs).href)
  mkdirSync(dirname(outPath), { recursive: true })
  const out = createWriteStream(outPath)
  const hash = createHash('sha256')
  const write = line => {
    const data = line + '\n'
    hash.update(data)
    if (!out.write(data)) return new Promise(r => out.once('drain', r))
    return null
  }

  let pushed = 0
  let events = 0
  let turn = 0
  while (pushed < msgs) {
    const lines = []
    const recorder = {
      pushUser: () => lines.push('{"k":"r","role":"user"}'),
      pushSystem: () => lines.push('{"k":"r","role":"system"}'),
      apply: ev => {
        lines.push(JSON.stringify({ k: 'e', v: ev }))
        events++
      }
    }
    applyTurn(recorder, turn)
    pushed += rowsPerTurn(turn)
    lines.push(JSON.stringify({ k: 't', msgs: pushed }))
    for (const line of lines) {
      const wait = write(line)
      if (wait) await wait
    }
    turn++
  }
  await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())))
  return { path: outPath, msgs: pushed, events, turns: turn, sha256: hash.digest('hex') }
}

if (import.meta.main) {
  const args = parseArgs(process.argv)
  const outPath = args.out ?? resolve(here, `.cache/fixture-${args.msgs}.ndjson`)
  const info = await generate(args.msgs, outPath)
  process.stdout.write(JSON.stringify(info) + '\n')
}
