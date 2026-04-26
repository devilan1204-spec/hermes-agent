import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { listWorkflows, readWorkflow, renderPage, showroomRoot } from './page.js'

const FLAG_VALUES = new Set<string>([])

const positionals = (() => {
  const argv = process.argv.slice(2)
  const out: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!

    if (FLAG_VALUES.has(value)) {
      i += 1
      continue
    }

    if (value.startsWith('-')) {
      continue
    }

    out.push(value)
  }

  return out
})()

const explicitWorkflow = positionals[0]
const explicitOut = positionals[1]
const distDir = resolve(showroomRoot, 'dist')

const writeHtml = (path: string, html: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html)
}

const buildAll = () => {
  const catalog = listWorkflows()

  for (const entry of catalog) {
    const html = renderPage({ name: entry.name, workflow: readWorkflow(entry.path) }, catalog)
    const out = join(distDir, `${entry.name}.html`)

    writeHtml(out, html)
    console.log(out)
  }

  if (catalog.length) {
    const indexEntry = catalog.find(w => w.name === 'feature-tour') ?? catalog[0]!
    const html = renderPage({ name: indexEntry.name, workflow: readWorkflow(indexEntry.path) }, catalog)
    const out = join(distDir, 'index.html')

    writeHtml(out, html)
    console.log(out)
  }
}

if (explicitWorkflow) {
  const path = resolve(process.cwd(), explicitWorkflow)
  const out = resolve(process.cwd(), explicitOut ?? join(distDir, 'index.html'))
  const catalog = listWorkflows()
  const html = renderPage({ name: 'override', workflow: readWorkflow(path) }, catalog)

  writeHtml(out, html)
  console.log(out)
} else {
  buildAll()
}
