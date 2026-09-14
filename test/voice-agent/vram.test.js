const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { createVramCoordinator } = require("../../src/voice-agent/main/vram");

class FakeServerManager {
  constructor() {
    this.ready = false;
    this.modelPath = null;
    this.port = null;
    this.startupPromise = null;
    this.starts = [];
    this.idleResets = 0;
  }
  async start(modelPath) {
    this.starts.push(modelPath);
    this.ready = true;
    this.modelPath = modelPath;
    this.port = 8221 + this.starts.length;
  }
  getStatus() {
    return { running: this.ready, port: this.port, modelPath: this.modelPath };
  }
  resetIdleTimer() {
    this.idleResets++;
  }
}

function fakeModelManager() {
  const serverManager = new FakeServerManager();
  return {
    modelsDir: "C:\\models",
    serverManager,
    currentServerModelId: null,
    findModelById: (id) =>
      ({
        "qwen3.5-4b-q4_k_m": { model: { fileName: "Qwen_Qwen3.5-4B-Q4_K_M.gguf" } },
        "qwen3.5-9b-q4_k_m": { model: { fileName: "Qwen_Qwen3.5-9B-Q4_K_M.gguf" } },
      })[id],
    checkModelValid: async () => true,
    serverStartOptions: async () => ({}),
  };
}

test("the session model is started once and exposed as an OpenAI-compatible base URL", async () => {
  const mm = fakeModelManager();
  const vram = createVramCoordinator({ modelManager: mm, keepaliveMs: 10_000 });
  const started = await vram.startSessionModel("qwen3.5-4b-q4_k_m");
  assert.equal(started.modelPath, path.join("C:\\models", "Qwen_Qwen3.5-4B-Q4_K_M.gguf"));
  assert.equal(started.baseURL, `http://127.0.0.1:${started.port}/v1`);
  assert.equal(mm.currentServerModelId, "qwen3.5-4b-q4_k_m");
  await vram.startSessionModel("qwen3.5-4b-q4_k_m");
  assert.equal(mm.serverManager.starts.length, 1, "an already running model is reused");
});

test("while locked, requests for another model fail and the voice model stays loaded", async () => {
  const mm = fakeModelManager();
  const vram = createVramCoordinator({ modelManager: mm, keepaliveMs: 10_000 });
  const started = await vram.startSessionModel("qwen3.5-4b-q4_k_m");
  vram.lockModel(started);
  await assert.rejects(
    mm.serverManager.start(path.join("C:\\models", "Qwen_Qwen3.5-9B-Q4_K_M.gguf")),
    /voice conversation is using the local model/
  );
  assert.equal(mm.serverManager.getStatus().modelPath, started.modelPath);
  await mm.serverManager.start(started.modelPath);
  vram.unlockModel();
  assert.equal(Object.prototype.hasOwnProperty.call(mm.serverManager, "start"), false);
  await mm.serverManager.start(path.join("C:\\models", "Qwen_Qwen3.5-9B-Q4_K_M.gguf"));
  assert.match(mm.serverManager.getStatus().modelPath, /9B/);
});

test("a missing or unknown model is reported, not started", async () => {
  const mm = fakeModelManager();
  const vram = createVramCoordinator({ modelManager: mm });
  await assert.rejects(vram.startSessionModel("nope"), /Unknown local model/);
  mm.checkModelValid = async () => false;
  await assert.rejects(
    vram.startSessionModel("qwen3.5-4b-q4_k_m"),
    /not downloaded or is corrupted/
  );
  assert.equal(mm.serverManager.starts.length, 0);
});

test("the keepalive resets the idle timer and reports a changed server", async () => {
  const mm = fakeModelManager();
  const mismatches = [];
  const vram = createVramCoordinator({ modelManager: mm, keepaliveMs: 20 });
  const started = await vram.startSessionModel("qwen3.5-4b-q4_k_m");
  vram.lockModel(started, (status) => mismatches.push(status));
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(mm.serverManager.idleResets >= 2);
  mm.serverManager.port = 9999;
  await new Promise((r) => setTimeout(r, 50));
  vram.unlockModel();
  assert.ok(mismatches.length >= 1);
});

test("whisper-server is released for the session and restarted afterwards", async () => {
  const calls = [];
  const whisperManager = {
    currentServerModel: "turbo",
    stopServer: async () => {
      calls.push("stop");
      whisperManager.currentServerModel = null;
    },
    startServer: async (model) => calls.push(`start:${model}`),
    resolveGpuStartOptions: () => ({ useCuda: true }),
  };
  const vram = createVramCoordinator({ modelManager: fakeModelManager(), whisperManager });
  assert.equal(await vram.releaseWhisper(), "turbo");
  vram.restoreWhisper();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["stop", "start:turbo"]);
  vram.restoreWhisper();
  assert.deepEqual(calls, ["stop", "start:turbo"], "restores only once");
});
