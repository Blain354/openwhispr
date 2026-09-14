const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/voice-agent/shared/voiceTools.mjs");

const tool = (name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object" },
  execute: () => {},
});

test("only allowlisted tools reach the voice supervisor, without their implementations", async () => {
  const { selectVoiceTools } = await load();
  const selected = selectVoiceTools([
    tool("open_app"),
    tool("create_note"),
    tool("search_notes"),
    tool("update_dictionary"),
  ]);
  assert.deepEqual(
    selected.map((t) => t.name),
    ["open_app", "search_notes"]
  );
  assert.equal("execute" in selected[0], false);
});

test("duplicates are dropped and the list never exceeds the cap", async () => {
  const { selectVoiceTools, MAX_VOICE_TOOLS } = await load();
  const names = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
  const selected = selectVoiceTools([...names, ...names].map(tool), names);
  assert.equal(selected.length, MAX_VOICE_TOOLS);
  assert.equal(new Set(selected.map((t) => t.name)).size, MAX_VOICE_TOOLS);
});

test("the default allowlist itself respects the cap and has no write tool without confirmation", async () => {
  const { VOICE_TOOL_ALLOWLIST, MAX_VOICE_TOOLS } = await load();
  assert.ok(VOICE_TOOL_ALLOWLIST.length <= MAX_VOICE_TOOLS);
  for (const name of ["create_note", "update_note", "update_dictionary", "update_snippets"]) {
    assert.equal(VOICE_TOOL_ALLOWLIST.includes(name), false, name);
  }
});

test("tool results become bounded text", async () => {
  const { toolResultText } = await load();
  assert.equal(toolResultText({ success: true, data: "Opened Obsidian." }), "Opened Obsidian.");
  assert.equal(toolResultText({ success: true, data: { count: 2 } }), '{"count":2}');
  assert.equal(
    toolResultText({ success: false, data: null, displayText: "Cancelled." }),
    "Cancelled."
  );
  assert.equal(toolResultText(null), "Failed.");
  const long = toolResultText({ success: true, data: "x".repeat(5000) }, 100);
  assert.equal(long.length, 101);
});
