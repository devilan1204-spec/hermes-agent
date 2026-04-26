import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { defaultWorkflowPath, readWorkflow, renderPage } from './page.js'

const arg = (name: string) => {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

const port = Number(arg('--port') ?? process.env.PORT ?? 4317)
const workflowPath = resolve(process.cwd(), arg('--workflow') ?? process.argv[2] ?? defaultWorkflowPath)

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok')

    return
  }

  try {
    const page = renderPage(readWorkflow(workflowPath))

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`showroom: http://127.0.0.1:${port}`)
  console.log(`workflow: ${workflowPath}`)
})
