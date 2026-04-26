import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const showroomRoot = dirname(fileURLToPath(import.meta.url))
export const defaultWorkflowPath = join(showroomRoot, 'workflows', 'feature-tour.json')

export const readWorkflow = (path = defaultWorkflowPath) => JSON.parse(readFileSync(path, 'utf8'))

export const renderPage = (workflow: unknown) => {
  const css = readFileSync(join(showroomRoot, 'src', 'showroom.css'), 'utf8')
  const js = readFileSync(join(showroomRoot, 'src', 'showroom.js'), 'utf8')
  const data = JSON.stringify(workflow).replace(/</g, '\\u003c')

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
    <script>window.__SHOWROOM_WORKFLOW__ = ${data}</script>
    <script type="module">${js}</script>
  </body>
</html>`
}
