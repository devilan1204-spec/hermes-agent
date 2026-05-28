// No-op sign function for electron-builder.
//
// electron-builder's win.signtoolOptions.sign hook lets you BYO signing
// logic instead of letting electron-builder fetch signtool from winCodeSign
// and run it itself. We don't sign on grandma's box (no cert, no cert
// infrastructure, and the bundled node-pty prebuilds are already signed
// by their authors upstream).
//
// By providing this no-op function, electron-builder:
//   1. Doesn't try to fetch winCodeSign from GitHub
//   2. Doesn't try to extract winCodeSign-2.6.0.7z (which fails on
//      non-admin Windows due to the darwin/*.dylib symlinks needing
//      SeCreateSymbolicLinkPrivilege)
//   3. Considers every bundled binary "signed" and moves on
//
// The produced Hermes.exe and its bundled prebuild .exes ship unsigned.
// SmartScreen will warn once on first launch ("More info → Run anyway"),
// same friction as Hermes-Setup.exe itself. The architecture's signing-
// ready: when Nous Research's signing cert lands, replace this file with
// a real signtool invocation or @electron/windows-sign-based hook.
//
// Referenced from package.json's build.win.signtoolOptions.sign.

module.exports = async function noopSign(_configuration) {
  // Intentionally do nothing. electron-builder treats a resolved promise
  // (or non-Error return) as "signing succeeded."
  return undefined
}
