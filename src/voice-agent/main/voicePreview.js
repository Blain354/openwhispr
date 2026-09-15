// A short sample of a voice for the session window's picker, outside any session.
//
// The venv's python runs `-m ow_conversation.preview` with the voice as JSON on stdin and writes a
// WAV on stdout. Same environment allowlist as the sidecar; an online voice's key goes in
// OW_CONVERSATION_TTS_API_KEY, never on the command line. One sample at a time, killed when stuck.
const { spawn } = require("child_process");
const { buildChildEnv } = require("./env");
const { defaultVenvDir, pythonExecutable, killTree } = require("./sidecarManager");

const PREVIEW_MODULE = "ow_conversation.preview";
const PREVIEW_TIMEOUT_MS = 45_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;
// A RIFF header alone is 44 bytes.
const MIN_WAV_BYTES = 45;

/**
 * Pure: the command line and environment of one preview.
 */
function buildPreviewLaunch({
  venvDir = defaultVenvDir(),
  ttsApiKey,
  sourceEnv = process.env,
  platform = process.platform,
}) {
  const extra = { PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1" };
  if (ttsApiKey) extra.OW_CONVERSATION_TTS_API_KEY = ttsApiKey;
  return {
    command: pythonExecutable(venvDir, platform),
    args: ["-m", PREVIEW_MODULE],
    env: buildChildEnv(sourceEnv, { extra }),
  };
}

function lastLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) || "").slice(0, MAX_ERROR_CHARS);
}

function createVoicePreview({
  venvDir = defaultVenvDir(),
  spawnProcess = spawn,
  killProcessTree = killTree,
  timeoutMs = PREVIEW_TIMEOUT_MS,
} = {}) {
  let busy = false;

  /**
   * @param {{ tts: object, language: string, apiKey?: string }} request
   * @returns {Promise<{ ok: true, wav: Buffer } | { ok: false, error: string }>}
   */
  function run({ tts, language, apiKey }) {
    if (busy) return Promise.resolve({ ok: false, error: "busy" });
    busy = true;
    const launch = buildPreviewLaunch({ venvDir, ttsApiKey: apiKey });
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let stderr = "";
      let timer = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        busy = false;
        clearTimeout(timer);
        resolve(result);
      };

      let proc;
      try {
        proc = spawnProcess(launch.command, launch.args, {
          env: launch.env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ ok: false, error: error.message });
        return;
      }
      timer = setTimeout(() => {
        void killProcessTree(proc.pid);
        finish({ ok: false, error: "timeout" });
      }, timeoutMs);

      proc.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_PREVIEW_BYTES) {
          void killProcessTree(proc.pid);
          finish({ ok: false, error: "too-large" });
          return;
        }
        chunks.push(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      proc.on("error", (error) => finish({ ok: false, error: error.message }));
      proc.on("close", (code) => {
        if (code === 0 && size >= MIN_WAV_BYTES) {
          finish({ ok: true, wav: Buffer.concat(chunks) });
        } else {
          finish({ ok: false, error: lastLine(stderr) || `exit ${code}` });
        }
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(JSON.stringify({ tts, language }));
    });
  }

  return { run, isBusy: () => busy };
}

module.exports = { buildPreviewLaunch, createVoicePreview, PREVIEW_TIMEOUT_MS };
