import { createServer } from 'node:http'
import { resolve } from 'node:path'

import {
  defaultWorkflowPath,
  listWorkflows,
  readWorkflow,
  renderPage,
  workflowsDir,
  type WorkflowEntry
} from './page.js'

const FLAG_VALUES = new Set(['--port', '--workflow'])

const arg = (name: string) => {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

const positional = (() => {
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!

    if (FLAG_VALUES.has(value)) {
      i += 1
      continue
    }

    if (value.startsWith('-')) {
      continue
    }

    return value
  }

  return undefined
})()

const port = Number(arg('--port') ?? process.env.PORT ?? 4317)
const overridePath = arg('--workflow') ?? positional

const pickInitial = (catalog: WorkflowEntry[], requested: null | string): WorkflowEntry => {
  if (overridePath) {
    const fullPath = resolve(process.cwd(), overridePath)

    return { name: 'override', path: fullPath, title: requested ?? 'override' }
  }

  if (requested) {
    const hit = catalog.find(w => w.name === requested)

    if (hit) {
      return hit
    }
  }

  return catalog.find(w => w.path === defaultWorkflowPath) ?? catalog[0]!
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (url.pathname === '/healthz') {
    res.writeHead(200).end('ok')

    return
  }

  if (url.pathname === '/api/workflows') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(listWorkflows()))

    return
  }

  if (url.pathname.startsWith('/api/workflow/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/workflow/'.length))
    const hit = listWorkflows().find(w => w.name === name)

    if (!hit) {
      res.writeHead(404).end('not found')

      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(readWorkflow(hit.path)))

    return
  }

  try {
    const catalog = listWorkflows()
    const initial = pickInitial(catalog, url.searchParams.get('w'))
    const page = renderPage({ name: initial.name, workflow: readWorkflow(initial.path) }, catalog)

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`showroom: http://127.0.0.1:${port}`)
  console.log(`workflows dir: ${workflowsDir}`)
})
