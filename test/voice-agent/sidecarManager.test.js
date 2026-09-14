const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildSidecarLaunch,
  isOurSidecarProcess,
  pythonExecutable,
} = require("../../src/voice-agent/main/sidecarManager");

const SOURCE_ENV = {
  PATH: "C:\\Windows\\system32",
  SystemRoot: "C:\\Windows",
  USERPROFILE: "C:\\Users\\someone",
  OPENAI_API_KEY: "sk-leak-me-000000000",
  DICTATION_AGENT_CUSTOM_API_KEY: "custom-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  HF_HOME: "D:\\hf",
};

test("the venv python is spawned directly, never through uv", () => {
  const launch = buildSidecarLaunch({
    venvDir: "C:\\venv",
    port: 8241,
    token: "t".repeat(64),
    sourceEnv: SOURCE_ENV,
    platform: "win32",
  });
  assert.equal(launch.command, path.join("C:\\venv", "Scripts", "python.exe"));
  assert.deepEqual(launch.args.slice(0, 3), ["-m", "ow_conversation", "--ws-url"]);
  assert.equal(launch.args[3], "ws://127.0.0.1:8241");
  assert.ok(
    !launch.args.join(" ").includes("t".repeat(64)),
    "token must not be on the command line"
  );
});

test("the child environment carries the token but no inherited provider key", () => {
  const launch = buildSidecarLaunch({
    venvDir: "C:\\venv",
    port: 8241,
    token: "abc",
    sourceEnv: SOURCE_ENV,
    platform: "win32",
  });
  assert.equal(launch.env.OW_CONVERSATION_TOKEN, "abc");
  assert.equal(launch.env.HF_HUB_OFFLINE, "1");
  assert.equal(launch.env.HF_HOME, "D:\\hf");
  for (const name of ["OPENAI_API_KEY", "DICTATION_AGENT_CUSTOM_API_KEY", "ANTHROPIC_API_KEY"]) {
    assert.equal(launch.env[name], undefined, name);
  }
  assert.equal(launch.env.OW_CONVERSATION_LLM_API_KEY, undefined);
});

test("a custom LLM key is passed only through its dedicated variable", () => {
  const launch = buildSidecarLaunch({
    venvDir: "C:\\venv",
    port: 8241,
    token: "abc",
    llmApiKey: "sk-custom",
    sourceEnv: SOURCE_ENV,
    platform: "win32",
  });
  assert.equal(launch.env.OW_CONVERSATION_LLM_API_KEY, "sk-custom");
  assert.ok(!launch.args.includes("sk-custom"));
});

test("only a python process running the sidecar module counts as ours", () => {
  assert.equal(
    isOurSidecarProcess(
      '"C:\\Users\\x\\.cache\\openwhispr\\conversation\\venv\\Scripts\\python.exe" -m ow_conversation --ws-url ws://127.0.0.1:8241'
    ),
    true
  );
  assert.equal(isOurSidecarProcess("C:\\Windows\\notepad.exe"), false);
  assert.equal(isOurSidecarProcess("python.exe -m http.server"), false);
  assert.equal(isOurSidecarProcess(""), false);
});

test("python lives in Scripts on Windows and bin elsewhere", () => {
  assert.equal(pythonExecutable("/v", "win32"), path.join("/v", "Scripts", "python.exe"));
  assert.equal(pythonExecutable("/v", "linux"), path.join("/v", "bin", "python"));
});
