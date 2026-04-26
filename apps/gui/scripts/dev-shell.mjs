import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const python = process.env.HERMES_PYTHON || "python";
let port = process.env.HERMES_GUI_PORT || "9120";
let url = `http://127.0.0.1:${port}`;

let dashboard = null;

function stop() {
  if (dashboard && !dashboard.killed) dashboard.kill();
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});
process.on("exit", stop);

async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    if (await isHealthy()) return true;
    await delay(500);
  }
  return false;
}

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

function canBind(candidate) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.listen(Number(candidate), "127.0.0.1", () => {
      server.close(() => resolveBind(true));
    });
  });
}

async function choosePort() {
  if (process.env.HERMES_GUI_PORT) return;

  let candidate = Number(port);
  for (let i = 0; i < 20; i += 1) {
    if (await canBind(candidate)) {
      port = String(candidate);
      url = `http://127.0.0.1:${port}`;
      return;
    }
    candidate += 1;
  }
}

function startDashboard() {
  dashboard = spawn(
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

  dashboard.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function run(command, args) {
  return (
    spawnSync(command, args, {
      shell: process.platform === "win32",
      stdio: "ignore",
    }).status === 0
  );
}

function openGuiWindow() {
  if (process.platform === "win32") {
    return (
      run("cmd.exe", ["/C", "start", "", "chrome", `--app=${url}`]) ||
      run("cmd.exe", ["/C", "start", "", "msedge", `--app=${url}`]) ||
      run("cmd.exe", ["/C", "start", "", url])
    );
  }

  if (process.env.WSL_DISTRO_NAME) {
    return (
      run("cmd.exe", ["/C", "start", "", "chrome", `--app=${url}`]) ||
      run("cmd.exe", ["/C", "start", "", "msedge", `--app=${url}`]) ||
      run("cmd.exe", ["/C", "start", "", url])
    );
  }

  if (process.platform === "darwin") {
    return (
      run("open", ["-na", "Google Chrome", "--args", `--app=${url}`]) ||
      run("open", [url])
    );
  }

  return (
    run("google-chrome", [`--app=${url}`]) ||
    run("chromium", [`--app=${url}`]) ||
    run("xdg-open", [url])
  );
}

if (await isHealthy()) {
  console.log(`Hermes GUI already running -> ${url}`);
  openGuiWindow();
  process.exit(0);
}

await choosePort();
startDashboard();

if (await waitForHealth()) {
  console.log(`Hermes GUI -> ${url}`);
  openGuiWindow();
} else {
  console.error(`Hermes GUI did not become healthy at ${url}`);
}
