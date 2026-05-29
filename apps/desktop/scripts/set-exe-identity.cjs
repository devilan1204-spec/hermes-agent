#!/usr/bin/env node
// set-exe-identity.cjs — stamp the Hermes icon + version metadata onto the
// built Hermes.exe using rcedit, completely decoupled from electron-builder's
// signing path.
//
// WHY THIS EXISTS
// ---------------
// apps/desktop/package.json sets build.win.signAndEditExecutable=false. That
// flag is load-bearing: turning electron-builder's own exe-editing ON also
// re-enables its signtool step, which fetches winCodeSign-2.6.0.7z, whose
// macOS symlinks crash 7-Zip on non-admin Windows (no Developer Mode = no
// SeCreateSymbolicLinkPrivilege). That is an unfixable dead end — we do NOT
// try to extract winCodeSign.
//
// The cost of disabling signAndEditExecutable is that electron-builder also
// skips rcedit, so the unpacked Hermes.exe keeps the stock Electron icon and
// "Electron" taskbar name. This script restores the icon + identity by calling
// rcedit DIRECTLY. rcedit is a pure PE resource editor: no signing, no certs,
// no winCodeSign, no symlinks. Invoked from install.ps1's Install-Desktop
// after `npm run pack`.
//
// USAGE
//   node scripts/set-exe-identity.cjs <path-to-Hermes.exe>
//
// Exits 0 on success, non-zero on failure. install.ps1 treats failure as
// non-fatal (worst case: stock icon, not a broken app).

const path = require('node:path')
const fs = require('node:fs')

async function main() {
  const exe = process.argv[2]
  if (!exe) {
    console.error('[set-exe-identity] usage: set-exe-identity.cjs <path-to-exe>')
    process.exit(2)
  }
  if (!fs.existsSync(exe)) {
    console.error(`[set-exe-identity] target exe not found: ${exe}`)
    process.exit(2)
  }

  // Icon lives beside this script's package root: apps/desktop/assets/icon.ico
  const desktopRoot = path.resolve(__dirname, '..')
  const icon = path.join(desktopRoot, 'assets', 'icon.ico')
  if (!fs.existsSync(icon)) {
    console.error(`[set-exe-identity] icon not found: ${icon}`)
    process.exit(2)
  }

  // rcedit is a direct devDependency of apps/desktop, so it resolves whether
  // we're run from the desktop dir or the repo root (workspace hoist).
  // rcedit@5 exports a NAMED `rcedit` function (CommonJS: { rcedit }), not a
  // default export.
  let rcedit
  try {
    const mod = require('rcedit')
    rcedit = typeof mod === 'function' ? mod : mod.rcedit
    if (typeof rcedit !== 'function') {
      throw new Error(`unexpected rcedit export shape: ${typeof mod} keys=${Object.keys(mod)}`)
    }
  } catch (err) {
    console.error(`[set-exe-identity] could not load rcedit module: ${err.message}`)
    process.exit(3)
  }

  console.log(`[set-exe-identity] stamping ${exe}`)
  console.log(`[set-exe-identity] icon: ${icon}`)

  try {
    await rcedit(exe, {
      icon,
      'version-string': {
        ProductName: 'Hermes',
        FileDescription: 'Hermes',
        CompanyName: 'Nous Research',
        LegalCopyright: 'Copyright (c) 2026 Nous Research'
      }
    })
  } catch (err) {
    console.error(`[set-exe-identity] rcedit failed: ${err.message}`)
    process.exit(1)
  }

  console.log('[set-exe-identity] done — Hermes icon + identity stamped')
}

main()
