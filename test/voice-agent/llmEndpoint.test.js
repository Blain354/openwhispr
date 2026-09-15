const test = require("node:test");
const assert = require("node:assert/strict");

const { isPrivateHost, remoteBaseProblem } = require("../../src/voice-agent/shared/llmPolicy");

const load = () => import("../../src/voice-agent/shared/llmEndpoint.mjs");

// The shape selectResolvedLLMConfig(settings, "dictationAgent") really returns
// (src/stores/settingsStore.ts). An earlier test used a `mode: "custom"` the app never produces,
// which is how a session refused every cloud model while its tests passed.
const resolved = (overrides) => ({
  scope: "dictationAgent",
  mode: "providers",
  provider: "",
  model: "",
  cloudMode: "byok",
  cloudBaseUrl: undefined,
  remoteUrl: undefined,
  customApiKey: undefined,
  disableThinking: true,
  ...overrides,
});

test("a local model is the local server, whatever else is stored", async () => {
  const { sessionLlmRequest } = await load();
  assert.deepEqual(
    sessionLlmRequest(resolved({ mode: "local", provider: "openai", model: "gpt-5.1" }), {
      openaiApiKey: "sk-x",
    }),
    { mode: "local" }
  );
});

test("each provider of the app maps to its Chat Completions endpoint and its own key", async () => {
  const { sessionLlmRequest } = await load();
  const settings = {
    openaiApiKey: "k-openai",
    groqApiKey: "k-groq",
    openrouterApiKey: "k-openrouter",
    anthropicApiKey: "k-anthropic",
    geminiApiKey: "k-gemini",
  };
  const expected = {
    openai: ["https://api.openai.com/v1", "k-openai", "OpenAI"],
    groq: ["https://api.groq.com/openai/v1", "k-groq", "Groq"],
    openrouter: ["https://openrouter.ai/api/v1", "k-openrouter", "OpenRouter"],
    anthropic: ["https://api.anthropic.com/v1", "k-anthropic", "Anthropic"],
    gemini: ["https://generativelanguage.googleapis.com/v1beta/openai", "k-gemini", "Google"],
  };
  for (const [provider, [baseURL, apiKey, label]] of Object.entries(expected)) {
    assert.deepEqual(sessionLlmRequest(resolved({ provider, model: "m" }), settings), {
      mode: "remote",
      provider,
      label,
      baseURL,
      model: "m",
      apiKey,
    });
  }
});

test("a custom endpoint gets /v1 and the scope's own key, which may be empty", async () => {
  const { sessionLlmRequest } = await load();
  assert.deepEqual(
    sessionLlmRequest(
      resolved({
        provider: "custom",
        model: "qwen",
        cloudBaseUrl: "http://192.168.0.125:11434/",
        customApiKey: "",
      }),
      { openaiApiKey: "never-borrowed" }
    ),
    {
      mode: "remote",
      provider: "custom",
      label: "192.168.0.125:11434",
      baseURL: "http://192.168.0.125:11434/v1",
      model: "qwen",
      apiKey: "",
    }
  );
});

test("a self-hosted server is reached at its URL with /v1", async () => {
  const { sessionLlmRequest } = await load();
  const request = sessionLlmRequest(
    resolved({ mode: "self-hosted", model: "gemma", remoteUrl: "https://llm.example.ts.net" }),
    {}
  );
  assert.equal(request.mode, "remote");
  assert.equal(request.baseURL, "https://llm.example.ts.net/v1");
  assert.equal(request.label, "llm.example.ts.net");
});

test("nothing is sent without a model, a key for a named provider, or a URL", async () => {
  const { sessionLlmRequest } = await load();
  assert.deepEqual(sessionLlmRequest(resolved({ provider: "openai", model: "m" }), {}), {
    mode: "invalid",
    error: "missing-api-key",
  });
  assert.equal(
    sessionLlmRequest(resolved({ provider: "openai" }), { openaiApiKey: "k" }).error,
    "missing-model"
  );
  assert.equal(
    sessionLlmRequest(resolved({ provider: "custom", model: "m" }), {}).error,
    "missing-base-url"
  );
  assert.equal(
    sessionLlmRequest(resolved({ mode: "self-hosted", model: "m" }), {}).error,
    "missing-base-url"
  );
});

test("OpenWhispr Cloud, enterprise and unknown providers are refused, never rerouted", async () => {
  const { sessionLlmRequest } = await load();
  for (const config of [
    resolved({ mode: "openwhispr", provider: "openai", model: "m" }),
    resolved({ mode: "enterprise", provider: "bedrock", model: "m" }),
    resolved({ provider: "tinfoil", model: "m" }),
    resolved({ provider: "constructor", model: "m" }),
    resolved({ mode: undefined }),
  ]) {
    assert.deepEqual(sessionLlmRequest(config, { openaiApiKey: "k" }), {
      mode: "invalid",
      error: "unsupported-provider",
    });
  }
});

test("a version segment is appended only when the URL has none", async () => {
  const { withV1Suffix } = await load();
  assert.equal(withV1Suffix("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(withV1Suffix("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(withV1Suffix("https://host/openai/v1"), "https://host/openai/v1");
  assert.equal(withV1Suffix("https://host/v1beta/openai"), "https://host/v1beta/openai");
  assert.equal(withV1Suffix("  "), "");
});

test("plain HTTP is only for the user's own network, as everywhere else in the app", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.0.0.4",
    "192.168.0.125",
    "172.20.1.1",
    "100.101.2.3",
    "169.254.1.1",
    "[::1]",
    "fd12::1",
    "nas.local",
    "serveur.tail1234.ts.net",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "api.openai.com", "example.com"]) {
    assert.equal(isPrivateHost(host), false, host);
  }
  assert.equal(remoteBaseProblem("https://api.openai.com/v1"), null);
  assert.equal(remoteBaseProblem("http://192.168.0.125:8080/v1"), null);
  assert.equal(remoteBaseProblem("http://203.0.113.10/v1"), "insecure-base-url");
  assert.equal(remoteBaseProblem("file:///etc/passwd"), "invalid-base-url");
  assert.equal(remoteBaseProblem("not a url"), "invalid-base-url");
});

test("a key saved under another provider is refused before it is sent anywhere", async () => {
  const { sessionLlmRequest, keyOwner } = await load();
  // What happened on the reference machine: an OpenRouter key saved as the OpenAI key.
  assert.deepEqual(
    sessionLlmRequest(resolved({ provider: "openai", model: "m" }), {
      openaiApiKey: "sk-or-v1-abc",
    }),
    { mode: "invalid", error: "key-mismatch" }
  );
  assert.equal(
    sessionLlmRequest(resolved({ provider: "openrouter", model: "m" }), {
      openrouterApiKey: "sk-or-v1-abc",
    }).mode,
    "remote"
  );
  assert.equal(
    sessionLlmRequest(resolved({ provider: "openai", model: "m" }), { openaiApiKey: "sk-proj-abc" })
      .mode,
    "remote"
  );
  // A custom endpoint may be a proxy for any provider: its key is not second-guessed.
  assert.equal(
    sessionLlmRequest(
      resolved({
        provider: "custom",
        model: "m",
        cloudBaseUrl: "https://openrouter.ai/api/v1",
        customApiKey: "sk-or-v1-abc",
      }),
      {}
    ).mode,
    "remote"
  );
  assert.equal(keyOwner("sk-ant-api03-x"), "anthropic");
  assert.equal(keyOwner("gsk_x"), "groq");
  assert.equal(keyOwner("AIzaSyX"), "gemini");
  assert.equal(keyOwner("sk-proj-x"), null);
  assert.equal(keyOwner(undefined), null);
});

test("the settings name the model a session uses and where it runs, or why none", async () => {
  const { describeSessionModel } = await load();
  assert.deepEqual(describeSessionModel({ mode: "local" }, "qwen3.5-4b-q4_k_m"), {
    model: "qwen3.5-4b-q4_k_m",
    where: "local",
  });
  assert.deepEqual(
    describeSessionModel(
      {
        mode: "remote",
        label: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-sonnet-4.5",
      },
      "unused"
    ),
    { model: "anthropic/claude-sonnet-4.5", where: "OpenRouter" }
  );
  assert.deepEqual(describeSessionModel({ mode: "invalid", error: "key-mismatch" }, "unused"), {
    model: "",
    where: "",
    error: "key-mismatch",
  });
});
