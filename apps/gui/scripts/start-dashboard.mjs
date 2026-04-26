import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const python = process.env.HERMES_PYTHON || "python";
const port = process.env.HERMES_GUI_PORT || "9120";
const url = `http://127.0.0.1:${port}`;

async function isHealthy() {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const data = await res.json();
    return res.ok && data.status === "ok";
  } catch {
    return false;
  }
}

function wslRepoRoot() {
  const normalized = repoRoot.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const host = parts[2]?.toLowerCase();
  if (process.platform !== "win32") return null;
  if (host !== "wsl$" && host !== "wsl.localhost") return null;
  const distro = parts[3];
  const path = `/${parts.slice(4).join("/")}`;
  return distro && path !== "/" ? { distro, path } : null;
}

function spawnDashboard() {
  const wsl = wslRepoRoot();
  if (wsl) {
    return spawn(
      "wsl.exe",
      [
        "-d",
        wsl.distro,
        "--cd",
        wsl.path,
        "env",
        "HERMES_GUI=1",
        process.env.HERMES_WSL_PYTHON || "python",
        "-m",
        "hermes_cli.main",
        "dashboard",
        "--gui",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        port,
      ],
      { stdio: "inherit" },
    );
  }

  return spawn(
    python,
    [
      "-m",
      "hermes_cli.main",
      "dashboard",
      "--gui",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_GUI: "1",
      },
      stdio: "inherit",
    },
  );
}

if (await isHealthy()) {
  console.log(`Hermes GUI already running -> ${url}`);
  process.exit(0);
}

const child = spawnDashboard();

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
