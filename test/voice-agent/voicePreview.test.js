const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const {
  buildPreviewLaunch,
  createVoicePreview,
} = require("../../src/voice-agent/main/voicePreview");

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.input = "";
  proc.stdin.on("data", (chunk) => {
    proc.input += chunk;
  });
  return proc;
}

// Python writes the WAV, then the process closes: the data events come first.
const later = (fn) => setImmediate(() => setImmediate(fn));
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60)]);

test("a preview runs the venv's python with the voice on stdin and the key in its environment", () => {
  const launch = buildPreviewLaunch({
    venvDir: "venv",
    ttsApiKey: "sk-voice",
    sourceEnv: { PATH: "p", OPENAI_API_KEY: "inherited" },
    platform: "win32",
  });
  assert.deepEqual(launch.args, ["-m", "ow_conversation.preview"]);
  assert.match(launch.command, /python\.exe$/);
  assert.equal(launch.env.OW_CONVERSATION_TTS_API_KEY, "sk-voice");
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.args.join(" ").includes("sk-voice"), false);
  assert.equal(
    buildPreviewLaunch({ venvDir: "venv", sourceEnv: {} }).env.OW_CONVERSATION_TTS_API_KEY,
    undefined
  );
});

test("the WAV written on stdout comes back, and the voice went in on stdin", async () => {
  const proc = fakeProcess();
  const preview = createVoicePreview({
    venvDir: "venv",
    spawnProcess: () => proc,
    killProcessTree: async () => {},
  });
  const pending = preview.run({
    tts: { provider: "kokoro", voice: "af_heart" },
    language: "fr-fr",
  });
  assert.equal(preview.isBusy(), true);
  setImmediate(() => {
    proc.stdout.write(WAV);
    later(() => proc.emit("close", 0));
  });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.wav.equals(WAV), true);
  assert.deepEqual(JSON.parse(proc.input), {
    tts: { provider: "kokoro", voice: "af_heart" },
    language: "fr-fr",
  });
  assert.equal(preview.isBusy(), false);
});

test("a failed preview reports the last line python wrote on stderr", async () => {
  const proc = fakeProcess();
  const preview = createVoicePreview({
    venvDir: "venv",
    spawnProcess: () => proc,
    killProcessTree: async () => {},
  });
  const pending = preview.run({ tts: {}, language: "fr-fr" });
  setImmediate(() => {
    proc.stderr.write("onnxruntime warning\nHTTP 401\n");
    later(() => proc.emit("close", 2));
  });
  assert.deepEqual(await pending, { ok: false, error: "HTTP 401" });
});

test("one sample at a time, and a stuck one is killed", async () => {
  const proc = fakeProcess();
  const killed = [];
  const preview = createVoicePreview({
    venvDir: "venv",
    spawnProcess: () => proc,
    killProcessTree: async (pid) => killed.push(pid),
    timeoutMs: 20,
  });
  const first = preview.run({ tts: {}, language: "fr-fr" });
  assert.deepEqual(await preview.run({ tts: {}, language: "fr-fr" }), { ok: false, error: "busy" });
  assert.deepEqual(await first, { ok: false, error: "timeout" });
  assert.deepEqual(killed, [4242]);
});
