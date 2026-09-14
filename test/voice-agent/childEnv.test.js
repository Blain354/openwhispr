const test = require("node:test");
const assert = require("node:assert/strict");

const { buildChildEnv } = require("../../src/voice-agent/main/env");
const { redact } = require("../../src/voice-agent/main/redact");

test("child processes inherit only allowlisted, non-secret variables", () => {
  const env = buildChildEnv({
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\someone",
    OPENAI_API_KEY: "sk-should-not-leak-000000",
    ANTHROPIC_API_KEY: "secret",
    DICTATION_AGENT_CUSTOM_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    RANDOM_VAR: "not allowlisted",
  });
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  for (const leaked of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DICTATION_AGENT_CUSTOM_API_KEY",
    "GITHUB_TOKEN",
    "RANDOM_VAR",
  ]) {
    assert.equal(env[leaked], undefined, leaked);
  }
});

test("a secret-looking name cannot be allowlisted, only passed explicitly", () => {
  const env = buildChildEnv(
    { OW_CONVERSATION_LLM_API_KEY: "inherited", PATH: "p" },
    { allow: ["OW_CONVERSATION_LLM_API_KEY"], extra: { OW_CONVERSATION_TOKEN: "explicit" } }
  );
  assert.equal(env.OW_CONVERSATION_LLM_API_KEY, undefined);
  assert.equal(env.OW_CONVERSATION_TOKEN, "explicit");
});

test("allowlist matching ignores case, as Windows does", () => {
  assert.equal(buildChildEnv({ Path: "x" }).Path, "x");
});

test("redact hides credential fields and bearer strings", () => {
  const out = redact({
    llm: { baseURL: "http://127.0.0.1:8221/v1", apiKey: "sk-abcdefghijkl" },
    headers: { Authorization: "Bearer abc.def" },
    note: "call with Bearer xyz123 and sk-abcdefghijklmnop",
    list: [{ token: "t" }],
  });
  assert.equal(out.llm.baseURL, "http://127.0.0.1:8221/v1");
  assert.equal(out.llm.apiKey, "[redacted]");
  assert.equal(out.headers.Authorization, "[redacted]");
  assert.ok(!out.note.includes("xyz123"));
  assert.ok(!out.note.includes("sk-abcdefghijklmnop"));
  assert.equal(out.list[0].token, "[redacted]");
});
