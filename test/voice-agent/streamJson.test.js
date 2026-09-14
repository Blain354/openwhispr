const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLineParser,
  describeEvent,
  MAX_LINE_CHARS,
} = require("../../src/voice-agent/shared/streamJson");

// Hand-written fixtures in the shape of `claude -p --output-format stream-json --verbose`.
const INIT = { type: "system", subtype: "init", model: "example-model", tools: ["Read", "Bash"] };
const ASSISTANT = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Looking at the history.\n" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Bash",
        input: { command: "git log --since=midnight --oneline" },
      },
    ],
  },
};
const TOOL_ERROR = {
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "denied" }],
  },
};
const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Three commits today.\n\nDetails follow.",
  total_cost_usd: 0.0421,
  duration_ms: 18250,
  num_turns: 4,
  permission_denials: [],
};

test("lines split across chunks are parsed once each, and garbage is reported", () => {
  const seen = [];
  const parser = createLineParser((value) => seen.push(value.type));
  const text = `${JSON.stringify(INIT)}\n${JSON.stringify(ASSISTANT)}\nnot json\n${JSON.stringify(RESULT_OK)}`;
  parser.push(text.slice(0, 17));
  parser.push(text.slice(17, 120));
  parser.push(text.slice(120));
  assert.deepEqual(seen, ["system", "assistant", "invalid"]);
  parser.end();
  assert.deepEqual(seen, ["system", "assistant", "invalid", "result"]);
});

test("an endless line is dropped instead of growing without bound", () => {
  const seen = [];
  const parser = createLineParser((value) => seen.push(value.type));
  parser.push("x".repeat(MAX_LINE_CHARS + 1));
  assert.deepEqual(seen, ["invalid"]);
});

test("events keep the text, the tools used and the outcome", () => {
  assert.deepEqual(describeEvent(INIT), [
    { kind: "init", model: "example-model", tools: ["Read", "Bash"] },
  ]);
  assert.deepEqual(describeEvent(ASSISTANT), [
    { kind: "text", text: "Looking at the history." },
    { kind: "tool", name: "Bash", detail: "git log --since=midnight --oneline" },
  ]);
  assert.deepEqual(describeEvent(TOOL_ERROR), [{ kind: "tool-error" }]);
  assert.deepEqual(describeEvent(RESULT_OK), [
    {
      kind: "result",
      success: true,
      subtype: "success",
      text: "Three commits today.\n\nDetails follow.",
      costUsd: 0.0421,
      durationMs: 18250,
      turns: 4,
      denials: [],
    },
  ]);
  assert.deepEqual(describeEvent({ type: "stream_event" }), []);
  assert.deepEqual(describeEvent(null), []);
});

test("a refused tool or a budget stop is not a success", () => {
  const [denied] = describeEvent({
    ...RESULT_OK,
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "tool-2", tool_input: { command: "ssh host" } },
    ],
  });
  assert.equal(denied.success, false);
  assert.deepEqual(denied.denials, ["Bash"]);
  const [budget] = describeEvent({
    ...RESULT_OK,
    subtype: "error_max_budget_usd",
    is_error: true,
    result: undefined,
  });
  assert.equal(budget.success, false);
  assert.equal(budget.text, "");
});
