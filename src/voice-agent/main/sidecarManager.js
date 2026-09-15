// Starts, supervises and stops the Python voice sidecar.
//
// The venv's python.exe is spawned directly (never through `uv run`, whose child would outlive a
// root-only kill), with an environment allowlist, and stopped by an explicit tree kill. A stale
// sidecar from a crashed session is reaped only when both its pid file and its command line prove
// it is ours.
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildChildEnv } = require("./env");

const PID_NAME = "conversation";
const MODULE_NAME = "ow_conversation";
const READY_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 3000;

function defaultVenvDir() {
  return path.join(os.homedir(), ".cache", "openwhispr", "conversation", "venv");
}

function pythonExecutable(venvDir = defaultVenvDir(), platform = process.platform) {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Pure: the command line and environment for one sidecar launch.
 */
function buildSidecarLaunch({
  venvDir = defaultVenvDir(),
  port,
  token,
  llmApiKey,
  ttsApiKey,
  device = "cuda",
  extraArgs = [],
  sourceEnv = process.env,
  platform = process.platform,
}) {
  const args = [
    "-m",
    MODULE_NAME,
    "--ws-url",
    `ws://127.0.0.1:${port}`,
    "--device",
    device,
    ...extraArgs,
  ];
  const extra = {
    OW_CONVERSATION_TOKEN: token,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1",
  };
  if (llmApiKey) extra.OW_CONVERSATION_LLM_API_KEY = llmApiKey;
  if (ttsApiKey) extra.OW_CONVERSATION_TTS_API_KEY = ttsApiKey;
  return {
    command: pythonExecutable(venvDir, platform),
    args,
    env: buildChildEnv(sourceEnv, { allow: ["HF_HOME", "HUGGINGFACE_HUB_CACHE"], extra }),
  };
}

/**
 * Pure: is this process a Conversation mode sidecar? Both the pid file and the command line must
 * agree, so a recycled pid belonging to another program is never killed.
 */
function isOurSidecarProcess(commandLine) {
  const line = String(commandLine || "").toLowerCase();
  return line.includes("python") && line.includes(`-m ${MODULE_NAME}`);
}

function readCommandLine(pid) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? "" : String(stdout || "").trim())
    );
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      return resolve();
    }
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

function createSidecarManager({ userDataDir, venvDir = defaultVenvDir(), debugLogger, onExit }) {
  const pidFile = path.join(userDataDir, "sidecar-pids", `${PID_NAME}.pid`);
  let child = null;

  async function reapStale() {
    let pid = null;
    try {
      pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
      return false;
    }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const commandLine = await readCommandLine(pid);
    if (isOurSidecarProcess(commandLine)) {
      debugLogger?.warn("Reaping stale voice sidecar", { pid }, "conversation");
      await killTree(pid);
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return true;
  }

  function isAvailable() {
    return fs.existsSync(pythonExecutable(venvDir));
  }

  async function start({ port, token, llmApiKey, ttsApiKey, device, extraArgs }) {
    if (child) return child;
    await reapStale();
    const launch = buildSidecarLaunch({
      venvDir,
      port,
      token,
      llmApiKey,
      ttsApiKey,
      device,
      extraArgs,
    });
    const proc = spawn(launch.command, launch.args, {
      env: launch.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(proc.pid));
    } catch {}

    const log = (stream, level) =>
      stream.on("data", (chunk) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim()) debugLogger?.[level]?.(`[sidecar] ${line}`, {}, "conversation");
        }
      });
    log(proc.stdout, "debug");
    log(proc.stderr, "debug");

    proc.on("exit", (code, signal) => {
      if (child === proc) child = null;
      try {
        fs.unlinkSync(pidFile);
      } catch {}
      onExit?.({ code, signal });
    });
    proc.on("error", (error) => {
      debugLogger?.error("Voice sidecar failed to start", { error: error.message }, "conversation");
    });
    return proc;
  }

  async function stop({ requestShutdown } = {}) {
    const proc = child;
    if (!proc) return;
    try {
      requestShutdown?.();
    } catch {}
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) await killTree(proc.pid);
    child = null;
  }

  function killSync() {
    const proc = child;
    if (!proc?.pid) return;
    child = null;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 5000,
        });
      } else {
        process.kill(-proc.pid, "SIGKILL");
      }
    } catch {}
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }

  return {
    start,
    stop,
    killSync,
    reapStale,
    isAvailable,
    isRunning: () => !!child,
    get pid() {
      return child?.pid ?? null;
    },
  };
}

module.exports = {
  createSidecarManager,
  buildSidecarLaunch,
  isOurSidecarProcess,
  pythonExecutable,
  defaultVenvDir,
  killTree,
  READY_TIMEOUT_MS,
};
