import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { defaultWorkflowPath, readWorkflow, renderPage, showroomRoot } from './page.js'

const workflowPath = resolve(process.cwd(), process.argv[2] ?? defaultWorkflowPath)
const outPath = resolve(process.cwd(), process.argv[3] ?? join(showroomRoot, 'dist', 'index.html'))

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, renderPage(readWorkflow(workflowPath)))

console.log(outPath)
