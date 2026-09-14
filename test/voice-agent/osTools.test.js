const test = require("node:test");
const assert = require("node:assert/strict");

test("a successful result reaches the model as readable text", async () => {
  const { toToolResult } = await import("../../src/voice-agent/tools/os.ts");
  const result = toToolResult({
    success: true,
    data: { app: "Obsidian", verified: true },
    displayText: "Opened Obsidian.",
  });
  assert.deepEqual(result, {
    success: true,
    data: "Opened Obsidian.",
    displayText: "Opened Obsidian.",
  });
});

test("command output is appended after the summary", async () => {
  const { toToolResult } = await import("../../src/voice-agent/tools/os.ts");
  const result = toToolResult({
    success: true,
    data: { output: "first\r\nlast é\n", exitCode: 0 },
    displayText: "The script ran successfully.",
  });
  assert.equal(result.data, "The script ran successfully.\nfirst\r\nlast é");
});

test("a failure keeps its explanation and carries no data", async () => {
  const { toToolResult } = await import("../../src/voice-agent/tools/os.ts");
  assert.deepEqual(toToolResult({ success: false, displayText: "Cancelled." }), {
    success: false,
    data: null,
    displayText: "Cancelled.",
  });
  assert.deepEqual(toToolResult(null), { success: false, data: null, displayText: "Failed." });
});
