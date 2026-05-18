'use strict'

/**
 * Stage native node-modules dependencies for electron-builder packaging.
 *
 * Workspace dedup hoists @homebridge/node-pty-prebuilt-multiarch into the
 * root `node_modules/`, which electron-builder's default file collector
 * (when `files:` is explicitly set in package.json) cannot reach.  The
 * result: packaged builds ship with no .node binaries and PTY initialization
 * fails at runtime ("PTY support is unavailable").
 *
 * Rather than restructure the workspace dedup (would require nohoist /
 * package.json shenanigans and risk breaking dev) or balloon the package
 * with the whole node_modules tree, we copy ONLY the runtime-essential
 * files of the native dep into apps/desktop/build/native-deps/ and ship
 * THAT subtree via extraResources.  main.cjs falls back to require()-ing
 * from process.resourcesPath when the hoisted-root require fails.
 *
 * Runs as part of `npm run build`. Idempotent -- always re-stages on each
 * build to pick up native binary updates.
 */

const fs = require('node:fs')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const STAGE_ROOT = path.join(APP_ROOT, 'build', 'native-deps')

// Modules to stage. The "from" path is the hoisted location in the workspace
// root; "to" is the layout we want inside build/native-deps/.  The "include"
// globs (relative to "from") select the runtime-essential files.  Anything
// outside the include list is left behind (source, deps/, scripts/, etc.).
const NATIVE_DEPS = [
  {
    from: path.join(REPO_ROOT, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
    to: path.join(STAGE_ROOT, '@homebridge', 'node-pty-prebuilt-multiarch'),
    include: [
      'package.json',
      'lib/**',
      'build/Release/*.node'
    ]
  }
]

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true })
}

function walk(root) {
  const results = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        results.push(full)
      }
    }
  }
  return results
}

// Match a relative path against simple ** and * glob patterns. Implementation
// is intentionally tiny -- the include lists are small and don't need full
// minimatch support.
function matchGlob(rel, pattern) {
  const r = rel.replace(/\\/g, '/')
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\\/g, '/')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLE_STAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE_STAR__/g, '.*') +
      '$'
  )
  return re.test(r)
}

function stageOne(spec) {
  if (!fs.existsSync(spec.from)) {
    throw new Error(
      `stage-native-deps: source missing at ${spec.from}.  Run \`npm install\` ` +
        `at the workspace root first.`
    )
  }
  rmrf(spec.to)
  ensureDir(spec.to)

  const files = walk(spec.from)
  let copied = 0
  for (const abs of files) {
    const rel = path.relative(spec.from, abs)
    const included = spec.include.some(g => matchGlob(rel, g))
    if (!included) continue
    const dest = path.join(spec.to, rel)
    ensureDir(path.dirname(dest))
    fs.copyFileSync(abs, dest)
    copied += 1
  }
  console.log(`[stage-native-deps] ${path.relative(APP_ROOT, spec.to)}: ${copied} files`)
}

function main() {
  rmrf(STAGE_ROOT)
  ensureDir(STAGE_ROOT)
  for (const spec of NATIVE_DEPS) {
    stageOne(spec)
  }
}

main()
