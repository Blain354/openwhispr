// GPU memory coordination for a voice session on a single consumer GPU.
//
// Upstream runs one shared llama-server and replaces its model whenever any caller asks for a
// different one. During a session the conversation model is pinned: requests for another model fail
// with a clear error instead of unloading the voice model mid-sentence, and a keepalive stops the
// idle timer from unloading it. OpenWhispr's own whisper-server is released for the session (the
// sidecar brings its own Whisper and dictation is blocked anyway) and restarted afterwards.
const path = require("path");
const { execFile } = require("child_process");

const KEEPALIVE_MS = 60_000;

function readVramMiB() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        const value = Number.parseInt(String(stdout || "").split(/\r?\n/)[0], 10);
        resolve(error || !Number.isFinite(value) ? null : value);
      }
    );
  });
}

function createVramCoordinator({
  modelManager,
  whisperManager,
  debugLogger,
  keepaliveMs = KEEPALIVE_MS,
}) {
  let lock = null;
  let previousWhisperModel = null;

  async function waitForPendingStartup(serverManager) {
    while (serverManager.startupPromise) {
      await serverManager.startupPromise.catch(() => {});
    }
  }

  async function startSessionModel(modelId) {
    modelManager.ensureInitialized?.();
    const info = modelManager.findModelById(modelId);
    if (!info) throw new Error(`Unknown local model "${modelId}"`);
    const modelPath = path.join(modelManager.modelsDir, info.model.fileName);
    if (!(await modelManager.checkModelValid(modelPath))) {
      throw new Error(`Local model "${modelId}" is not downloaded or is corrupted`);
    }
    const serverManager = modelManager.serverManager;
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitForPendingStartup(serverManager);
      const status = serverManager.getStatus();
      if (status.running && status.modelPath === modelPath) break;
      await serverManager.start(modelPath, await modelManager.serverStartOptions(info));
      modelManager.currentServerModelId = modelId;
    }
    const status = serverManager.getStatus();
    if (!status.running || status.modelPath !== modelPath || !status.port) {
      throw new Error(`The local model server did not start "${modelId}"`);
    }
    return { modelId, modelPath, port: status.port, baseURL: `http://127.0.0.1:${status.port}/v1` };
  }

  function lockModel({ modelPath, port }, onMismatch) {
    if (lock) return;
    const serverManager = modelManager.serverManager;
    const hadOwnStart = Object.prototype.hasOwnProperty.call(serverManager, "start");
    const originalStart = serverManager.start;
    serverManager.start = async function lockedStart(requestedPath, options) {
      if (lock && requestedPath !== lock.modelPath) {
        throw new Error(
          "A voice conversation is using the local model. End the conversation to use another model."
        );
      }
      return originalStart.call(serverManager, requestedPath, options);
    };
    const timer = setInterval(() => {
      const status = serverManager.getStatus();
      if (!status.running || status.modelPath !== modelPath || status.port !== port) {
        debugLogger?.warn("Voice session model server changed", status, "conversation");
        onMismatch?.(status);
        return;
      }
      serverManager.resetIdleTimer?.();
    }, keepaliveMs);
    timer.unref?.();
    lock = { modelPath, port, hadOwnStart, originalStart, timer };
  }

  function unlockModel() {
    if (!lock) return;
    const serverManager = modelManager.serverManager;
    if (lock.hadOwnStart) serverManager.start = lock.originalStart;
    else delete serverManager.start;
    clearInterval(lock.timer);
    lock = null;
  }

  async function releaseWhisper() {
    if (!whisperManager?.currentServerModel) return null;
    previousWhisperModel = whisperManager.currentServerModel;
    await whisperManager.stopServer();
    debugLogger?.info(
      "whisper-server released for the voice session",
      { model: previousWhisperModel },
      "conversation"
    );
    return previousWhisperModel;
  }

  function restoreWhisper() {
    if (!whisperManager || !previousWhisperModel) return;
    const model = previousWhisperModel;
    previousWhisperModel = null;
    Promise.resolve(
      whisperManager.startServer(model, whisperManager.resolveGpuStartOptions?.() || {})
    ).catch(() => {});
  }

  return {
    startSessionModel,
    lockModel,
    unlockModel,
    releaseWhisper,
    restoreWhisper,
    readVramMiB,
    isLocked: () => !!lock,
  };
}

module.exports = { createVramCoordinator, readVramMiB, KEEPALIVE_MS };
