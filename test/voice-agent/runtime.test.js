const test = require("node:test");
const assert = require("node:assert/strict");

const {
  routeSidecarMessage,
  resolveLlmEndpoint,
  harnessArgs,
  hotwordsFor,
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

test("a local model needs no secret; a custom provider keeps the key it was given", () => {
  assert.deepEqual(resolveLlmEndpoint({ mode: "local", apiKey: "ignored" }), { kind: "local" });
  const custom = resolveLlmEndpoint({
    mode: "custom",
    baseURL: "https://api.example.com/v1/",
    model: "m",
    apiKey: "k1",
  });
  assert.deepEqual(custom, {
    kind: "custom",
    baseURL: "https://api.example.com/v1",
    model: "m",
    apiKey: "k1",
  });
});

test("plain http is only accepted on loopback, and unknown providers are refused", () => {
  assert.equal(
    resolveLlmEndpoint({ mode: "custom", baseURL: "http://192.168.0.10:8080/v1" }).error,
    "insecure-base-url"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "custom", baseURL: "http://127.0.0.1:11434/v1" }).kind,
    "custom"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "custom", baseURL: "file:///etc/passwd" }).error,
    "invalid-base-url"
  );
  assert.equal(
    resolveLlmEndpoint({ mode: "custom", baseURL: "not a url" }).error,
    "invalid-base-url"
  );
  assert.equal(resolveLlmEndpoint({ mode: "openwhispr" }).error, "unsupported-provider");
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
