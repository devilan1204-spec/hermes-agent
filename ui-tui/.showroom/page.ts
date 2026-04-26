import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

export const showroomRoot = dirname(fileURLToPath(import.meta.url))
export const workflowsDir = join(showroomRoot, 'workflows')

export interface WorkflowEntry {
  name: string
  path: string
  title: string
}

export const listWorkflows = (): WorkflowEntry[] =>
  readdirSync(workflowsDir)
    .filter(file => file.endsWith('.json') && statSync(join(workflowsDir, file)).isFile())
    .map(file => {
      const path = join(workflowsDir, file)
      const data = JSON.parse(readFileSync(path, 'utf8'))

      return { name: parse(file).name, path, title: String(data.title ?? parse(file).name) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

export const defaultWorkflowPath =
  listWorkflows().find(w => w.name === 'feature-tour')?.path ?? listWorkflows()[0]?.path ?? ''

export const readWorkflow = (path = defaultWorkflowPath) => JSON.parse(readFileSync(path, 'utf8'))

export const renderPage = (initial: { name: string; workflow: unknown }, catalog: WorkflowEntry[]) => {
  const css = readFileSync(join(showroomRoot, 'src', 'showroom.css'), 'utf8')
  const js = readFileSync(join(showroomRoot, 'src', 'showroom.js'), 'utf8')
  const safeCatalog = catalog.map(({ name, title }) => ({ name, title }))
  const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c')
  const catalogJson = JSON.stringify(safeCatalog).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hermes TUI Showroom</title>
    <style>${css}</style>
  </head>
  <body>
    <main id="showroom"></main>
    <script>
      window.__SHOWROOM_INITIAL__ = ${initialJson};
      window.__SHOWROOM_CATALOG__ = ${catalogJson};
    </script>
    <script type="module">${js}</script>
  </body>
</html>`
}
