import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const bin = process.platform === "win32" ? "tauri.cmd" : "tauri";
const localTauri = resolve(appRoot, "node_modules", ".bin", bin);
const args = process.argv.slice(2);

function isWsl() {
  return process.platform === "linux" && !!process.env.WSL_DISTRO_NAME;
}

function quotePs(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function dispatchToWindows() {
  const pathResult = spawnSync("wslpath", ["-w", appRoot], {
    encoding: "utf8",
  });
  const windowsPath = pathResult.stdout.trim();
  if (!windowsPath) return false;

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force",
    "if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {",
    '  Write-Error "Windows npm was not found. Install Windows Node.js first: winget install OpenJS.NodeJS.LTS"',
    "}",
    "if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {",
    '  Write-Error "Windows Rust was not found. Install Rust first: winget install Rustlang.Rustup"',
    "}",
    `Set-Location -LiteralPath ${quotePs(windowsPath)}`,
    "& npm run dev:tauri",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

function run(command, commandArgs, { exit = true } = {}) {
  if (process.platform === "win32") {
    const psCommand = [
      "$ErrorActionPreference = 'Stop'",
      "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force",
      `Set-Location -LiteralPath ${quotePs(appRoot)}`,
      `& ${quotePs(command)} ${commandArgs.map(quotePs).join(" ")}`,
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { stdio: "inherit" },
    );
    if (result.error && result.error.code === "ENOENT") return false;
    if (exit) process.exit(result.status ?? 1);
    return result.status === 0;
  }

  const result = spawnSync(command, commandArgs, {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error && result.error.code === "ENOENT") return false;
  if (exit) process.exit(result.status ?? 1);
  return result.status === 0;
}

if (isWsl() && process.env.HERMES_GUI_TAURI_WSL !== "1") {
  console.log("Launching native Windows Tauri from WSL...");
  dispatchToWindows();
  console.error(
    "Could not hand off to Windows PowerShell. Run this from Windows PowerShell instead:",
  );
  console.error("  cd \\\\wsl$\\Ubuntu\\home\\bb\\hermes-agent\\apps\\gui");
  console.error("  npm run dev:tauri");
  process.exit(1);
}

if (existsSync(localTauri)) run(localTauri, args);
if (run("tauri", args, { exit: false })) process.exit(0);
if (run("cargo", ["tauri", ...args], { exit: false })) process.exit(0);
run("npx", ["--yes", "@tauri-apps/cli@latest", ...args]);
