const test = require("node:test");
const assert = require("node:assert/strict");

const catalog = require("../../src/voice-agent/shared/voiceCatalog.json");
const { DEFAULTS, sanitizeVoice } = require("../../src/voice-agent/main/config");

const load = () => import("../../src/voice-agent/shared/voiceChoice.mjs");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("the catalog lists the voices of Kokoro's voices file and of pipecat's OpenAI service", () => {
  // voices-v1.0.bin holds 54 voices; pipecat 1.10's OpenAITTSService accepts 13.
  assert.equal(new Set(catalog.kokoro).size, 54);
  assert.equal(new Set(catalog.openai).size, 13);
  assert.equal(catalog.kokoro[0], "ff_siwis");
});

test("a Kokoro id names its language and gender; French voices come first", async () => {
  const { kokoroVoiceInfo, kokoroVoiceGroups } = await load();
  assert.deepEqual(kokoroVoiceInfo("ff_siwis"), {
    id: "ff_siwis",
    language: "fr",
    gender: "female",
    name: "Siwis",
  });
  assert.deepEqual(kokoroVoiceInfo("am_michael"), {
    id: "am_michael",
    language: "enUS",
    gender: "male",
    name: "Michael",
  });
  const groups = kokoroVoiceGroups(catalog.kokoro);
  assert.equal(groups[0].language, "fr");
  assert.deepEqual(
    groups[0].voices.map((voice) => voice.id),
    ["ff_siwis"]
  );
  assert.equal(
    groups.reduce((count, group) => count + group.voices.length, 0),
    catalog.kokoro.length
  );
});

test("the window and the main process start from the same voice", async () => {
  const { DEFAULT_VOICE } = await load();
  assert.deepEqual(plain(DEFAULTS.voice), plain(DEFAULT_VOICE));
});

test("an online voice needs an OpenAI key, and not another provider's", async () => {
  const { sessionVoiceRequest, openaiKeyStatus } = await load();
  const online = { ...DEFAULTS.voice, provider: "openai" };
  assert.deepEqual(sessionVoiceRequest(DEFAULTS.voice, { openaiApiKey: "sk-proj-x" }), {
    provider: "kokoro",
  });
  assert.deepEqual(sessionVoiceRequest(online, {}), {
    provider: "openai",
    error: "voice-missing-api-key",
  });
  assert.deepEqual(sessionVoiceRequest(online, { openaiApiKey: "sk-or-v1-x" }), {
    provider: "openai",
    error: "voice-key-mismatch",
  });
  assert.deepEqual(sessionVoiceRequest(online, { openaiApiKey: " sk-proj-x " }), {
    provider: "openai",
    apiKey: "sk-proj-x",
  });
  assert.equal(openaiKeyStatus({ openaiApiKey: "sk-proj-x" }), "found");
});

test("the settings name the voice in use and where it runs", async () => {
  const { describeVoice, isOnlineVoice } = await load();
  assert.deepEqual(describeVoice(DEFAULTS.voice), { name: "Siwis", where: "local" });
  assert.deepEqual(describeVoice({ ...DEFAULTS.voice, provider: "openai" }), {
    name: "coral",
    where: "OpenAI",
  });
  assert.equal(isOnlineVoice(DEFAULTS.voice), false);
});

test("a saved voice is checked against the catalog and kept in bounds", () => {
  assert.deepEqual(sanitizeVoice(null), plain(DEFAULTS.voice));
  const voice = sanitizeVoice({
    provider: "openai",
    kokoro: { voice: "af_heart", speed: 7 },
    openai: { voice: "shimmer", instructions: `  ${"x".repeat(600)}` },
  });
  assert.equal(voice.provider, "openai");
  assert.deepEqual(voice.kokoro, { voice: "af_heart", speed: 2 });
  assert.equal(voice.openai.voice, "shimmer");
  assert.equal(voice.openai.instructions.length, 500);
  assert.deepEqual(
    sanitizeVoice({
      provider: "elevenlabs",
      kokoro: { voice: "../x", speed: "fast" },
      openai: { voice: "ff_siwis" },
    }),
    plain(DEFAULTS.voice)
  );
});
