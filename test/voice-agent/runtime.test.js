const test = require("node:test");
const assert = require("node:assert/strict");

const {
  routeSidecarMessage,
  resolveLlmEndpoint,
  harnessArgs,
  hotwordsFor,
  SYSTEM_PROMPT,
  systemPromptFor,
} = require("../../src/voice-agent/main/runtime");

const RELAYED = [
  "state",
  "transcript.partial",
  "transcript.final",
  "assistant.delta",
  "assistant.final",
  "latency",
  "level",
  "warning",
  "error",
];

test("sidecar state events drive the session state machine, unknown ones are ignored", () => {
  assert.deepEqual(
    routeSidecarMessage({ type: "state", data: { event: "bot.started" } }, RELAYED),
    {
      kind: "dispatch",
      event: "bot.started",
    }
  );
  assert.deepEqual(
    routeSidecarMessage({ type: "state", data: { event: "session.stopped" } }, RELAYED),
    {
      kind: "ignore",
    }
  );
});

test("transcripts and replies are relayed; tool calls go to the executor only", () => {
  assert.equal(routeSidecarMessage({ type: "transcript.final", data: {} }, RELAYED).kind, "relay");
  assert.equal(routeSidecarMessage({ type: "assistant.final", data: {} }, RELAYED).kind, "relay");
  assert.equal(routeSidecarMessage({ type: "tool.call", data: {} }, RELAYED).kind, "tool");
  assert.equal(routeSidecarMessage({ type: "bye", data: {} }, RELAYED).kind, "ignore");
  assert.equal(
    routeSidecarMessage({ type: "error", data: { fatal: true } }, RELAYED).kind,
    "fatal"
  );
  assert.equal(routeSidecarMessage({ type: "error", data: {} }, RELAYED).kind, "relay");
});

test("a local model needs no secret; a remote endpoint keeps the key it was given", () => {
  assert.deepEqual(resolveLlmEndpoint({ mode: "local", apiKey: "ignored" }), { kind: "local" });
  const remote = resolveLlmEndpoint({
    mode: "remote",
    baseURL: "https://api.example.com/v1/",
    model: "m",
    apiKey: "k1",
  });
  assert.deepEqual(remote, {
    kind: "remote",
    baseURL: "https://api.example.com/v1",
    model: "m",
    apiKey: "k1",
  });
});

test("plain http only reaches the user's own network, and unknown requests are refused", () => {
  assert.equal(
    resolveLlmEndpoint({ mode: "remote", baseURL: "http://203.0.113.10:8080/v1" }).error,
    "insecure-base-url"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "remote", baseURL: "http://192.168.0.125:8080/v1" }).kind,
    "remote"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "remote", baseURL: "http://127.0.0.1:11434/v1" }).kind,
    "remote"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "remote", baseURL: "file:///etc/passwd" }).error,
    "invalid-base-url"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "remote", baseURL: "not a url" }).error,
    "invalid-base-url"
  );
  assert.equal(resolveLlmEndpoint({ mode: "openwhispr" }).error, "unsupported-provider");
  // The shape the app never produces, which the session used to expect.
  assert.equal(
    resolveLlmEndpoint({ mode: "custom", baseURL: "https://api.example.com/v1" }).error,
    "unsupported-provider"
  );
  // A window's reason is passed on only if it is one the session window can word.
  assert.equal(
    resolveLlmEndpoint({ mode: "invalid", error: "missing-api-key" }).error,
    "missing-api-key"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "invalid", error: "<script>" }).error,
    "unsupported-provider"
  );
});

test("the WAV harness is only reachable in development", () => {
  const dir = "C:\fixtures";
  assert.deepEqual(harnessArgs({ NODE_ENV: "development", OW_CONVERSATION_WAV_INPUT: dir }), [
    "--wav-input",
    dir,
  ]);
  assert.deepEqual(harnessArgs({ NODE_ENV: "production", OW_CONVERSATION_WAV_INPUT: dir }), []);
  assert.deepEqual(harnessArgs({ NODE_ENV: "development" }), []);
});

test("Whisper is given the app and project names as hotwords", () => {
  const listDirs = (parent) => (parent === "C:\\code" ? ["blain-infra", "openwhispr"] : []);
  assert.equal(
    hotwordsFor({ workerProjectRoots: ["C:\\code\\*", "D:\\work\\thesis"] }, listDirs),
    "OpenWhispr, blain-infra, openwhispr, thesis"
  );
  assert.equal(hotwordsFor({}, listDirs), "OpenWhispr");
});

test("the user's dictionary follows the app and project names, in a bounded prompt", () => {
  const listDirs = (parent) => (parent === "C:\\code" ? ["blain-infra"] : []);
  const config = { workerProjectRoots: ["C:\\code\\*"] };
  assert.equal(
    hotwordsFor(config, listDirs, ["Claude", "Bambu Studio", " ", null, "blain-infra"]),
    "OpenWhispr, blain-infra, Claude, Bambu Studio"
  );

  const many = Array.from({ length: 400 }, (_, i) => `mot${i}`);
  const hotwords = hotwordsFor(config, listDirs, many);
  assert.ok(hotwords.length <= 1200, `length ${hotwords.length}`);
  assert.ok(hotwords.startsWith("OpenWhispr, blain-infra, mot0, mot1"));
  assert.match(hotwords, /mot\d+$/, "the budget never cuts a word or leaves a separator");
});

test("without a dictionary the hotwords are what they were", () => {
  const listDirs = () => [];
  assert.equal(hotwordsFor({}, listDirs), "OpenWhispr");
  assert.equal(hotwordsFor({}, listDirs, []), "OpenWhispr");
});

test("each session tells the model today's date and time, after the fixed rules", () => {
  const prompt = systemPromptFor(new Date(2026, 8, 15, 10, 52));
  assert.ok(prompt.startsWith(SYSTEM_PROMPT));
  assert.match(prompt, /15 septembre 2026/);
  assert.match(prompt, /10 h 52/);
});

test("a key saved under the wrong provider is a reason the session window can word", () => {
  assert.equal(
    resolveLlmEndpoint({ mode: "invalid", error: "key-mismatch" }).error,
    "key-mismatch"
  );
});

const os = require("os");
const { createConversationRuntime, mcpToolNames } = require("../../src/voice-agent/main/runtime");
const { DEFAULTS } = require("../../src/voice-agent/main/config");

/** A whole begin() with a fake WebSocket and sidecar: returns the session.config it sent. */
async function startFakeSession({ llm, tools, config = {}, voice }) {
  const { encodeMessage } = await import("../../src/voice-agent/shared/protocol.mjs");
  const sent = [];
  const launches = [];
  let deliver = null;
  const runtime = createConversationRuntime({
    userDataDir: os.tmpdir(),
    getConfig: () => ({ ...DEFAULTS, ...config }),
    sessionController: { dispatch: async () => {} },
    conversationWindows: { broadcast() {}, sendToSession() {} },
    getVram: () => ({
      releaseWhisper: async () => {},
      startSessionModel: async () => ({ baseURL: "http://127.0.0.1:8222/v1" }),
      lockModel() {},
      unlockModel() {},
      restoreWhisper() {},
      readVramMiB: async () => 0,
    }),
    wsServerFactory: ({ onMessage }) => {
      deliver = onMessage;
      return {
        start: async () => ({ port: 8241, token: "t" }),
        send: (raw) => {
          const message = JSON.parse(raw);
          sent.push(message);
          if (message.type === "session.config") {
            setImmediate(() => deliver(encodeMessage("ready", {})));
          }
          return true;
        },
        stop: async () => {},
      };
    },
    sidecarManagerFactory: () => ({
      isAvailable: () => true,
      start: async (launch) => {
        launches.push(launch);
        setImmediate(() => deliver(encodeMessage("hello", { protocol: 1 })));
      },
      stop: async () => {},
      killSync() {},
    }),
  });
  const result = await runtime.begin({ llm, tools, inputDevice: "", voice });
  const sessionConfig = sent.find((message) => message.type === "session.config")?.data;
  return { runtime, result, sessionConfig, launch: launches[0] };
}

const TOOL_NAMES = [
  "open_app",
  "run_powershell",
  "vault_read",
  "delegate_task",
  "mcp_itsaplan__list_projects",
  "copy_to_clipboard",
];
const toolSchemas = TOOL_NAMES.map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
}));

test("an online model gets no tool that reads the user's data, whatever the window sent", async () => {
  const { runtime, result, sessionConfig } = await startFakeSession({
    llm: { mode: "remote", baseURL: "https://openrouter.ai/api/v1", model: "m", apiKey: "k" },
    tools: toolSchemas,
    config: { vaultRoot: "V" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    sessionConfig.tools.map((tool) => tool.name),
    ["open_app", "copy_to_clipboard"]
  );
  assert.equal(runtime.textLeavesMachine(), true);
  await runtime.end();
  assert.equal(runtime.textLeavesMachine(), false);
});

test("a local model keeps the vault, PowerShell, workers and the MCP tools the window registered", async () => {
  const { runtime, sessionConfig } = await startFakeSession({
    llm: { mode: "local" },
    tools: toolSchemas,
    config: { vaultRoot: "V" },
  });
  assert.deepEqual(
    sessionConfig.tools.map((tool) => tool.name),
    [
      "open_app",
      "run_powershell",
      "delegate_task",
      "vault_read",
      "mcp_itsaplan__list_projects",
      "copy_to_clipboard",
    ]
  );
  assert.equal(runtime.textLeavesMachine(), false);
  await runtime.end();
});

test("MCP tool names are read from the schemas the window sent", () => {
  assert.deepEqual(mcpToolNames(toolSchemas), ["mcp_itsaplan__list_projects"]);
  assert.deepEqual(mcpToolNames(null), []);
});

const { sessionVoiceFor, kokoroLanguageFor } = require("../../src/voice-agent/main/runtime");

test("the voice comes from config.json; an online one needs the key the window found", () => {
  const local = sessionVoiceFor(
    { ...DEFAULTS, voice: { provider: "kokoro", kokoro: { voice: "af_heart", speed: 1.1 } } },
    { provider: "openai", apiKey: "ignored" }
  );
  const { modelPath, voicesPath, ...kokoro } = local.tts;
  assert.equal(local.kind, "local");
  assert.equal(local.apiKey, undefined);
  assert.match(modelPath, /kokoro-v1\.0\.onnx$/);
  assert.match(voicesPath, /voices-v1\.0\.bin$/);
  assert.deepEqual(kokoro, {
    provider: "kokoro",
    voice: "af_heart",
    speed: 1.1,
    language: "fr-fr",
  });

  const onlineConfig = {
    ...DEFAULTS,
    voice: { provider: "openai", openai: { voice: "marin", instructions: "Calme." } },
  };
  assert.deepEqual(sessionVoiceFor(onlineConfig, { provider: "openai", apiKey: " sk-proj-x " }), {
    kind: "remote",
    apiKey: "sk-proj-x",
    tts: {
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      instructions: "Calme.",
    },
  });
  assert.deepEqual(sessionVoiceFor(onlineConfig, {}), {
    kind: "error",
    error: "voice-missing-api-key",
  });
  assert.deepEqual(sessionVoiceFor(onlineConfig, { error: "voice-key-mismatch" }), {
    kind: "error",
    error: "voice-key-mismatch",
  });
  assert.equal(kokoroLanguageFor("en"), "en-us");
  assert.equal(kokoroLanguageFor("auto"), "fr-fr");
});

test("an online voice limits the tools like an online model; its key goes by environment only", async () => {
  const { runtime, result, sessionConfig, launch } = await startFakeSession({
    llm: { mode: "local" },
    tools: toolSchemas,
    config: { vaultRoot: "V", voice: { provider: "openai", openai: { voice: "coral" } } },
    voice: { provider: "openai", apiKey: "sk-proj-voice" },
  });
  assert.equal(result.success, true);
  assert.equal(sessionConfig.tts.provider, "openai");
  assert.equal(JSON.stringify(sessionConfig).includes("sk-proj-voice"), false);
  assert.equal(launch.ttsApiKey, "sk-proj-voice");
  assert.deepEqual(
    sessionConfig.tools.map((tool) => tool.name),
    ["open_app", "copy_to_clipboard"]
  );
  assert.equal(runtime.textLeavesMachine(), true);
  await runtime.end();
});

test("a session whose online voice has no key does not start", async () => {
  const { result, launch } = await startFakeSession({
    llm: { mode: "local" },
    tools: toolSchemas,
    config: { voice: { provider: "openai" } },
    voice: { provider: "openai", error: "voice-missing-api-key" },
  });
  assert.deepEqual(result, { success: false, errors: ["voice-missing-api-key"] });
  assert.equal(launch, undefined);
});

test("a local session reads with the chosen Kokoro voice, in the session's language", async () => {
  const { runtime, sessionConfig, launch } = await startFakeSession({
    llm: { mode: "local" },
    tools: [],
    config: {
      sttLanguage: "en",
      voice: { provider: "kokoro", kokoro: { voice: "bf_emma", speed: 0.9 } },
    },
  });
  assert.equal(sessionConfig.tts.provider, "kokoro");
  assert.equal(sessionConfig.tts.voice, "bf_emma");
  assert.equal(sessionConfig.tts.speed, 0.9);
  assert.equal(sessionConfig.tts.language, "en-us");
  assert.equal(sessionConfig.kokoro, undefined);
  assert.equal(launch.ttsApiKey, "");
  await runtime.end();
});
