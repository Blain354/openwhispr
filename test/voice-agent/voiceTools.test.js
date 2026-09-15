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

test("the default allowlist has no write tool without confirmation", async () => {
  const { VOICE_TOOL_ALLOWLIST } = await load();
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

test("the allowlist is ordered: machine and vault first, MCP next, note tools last", async () => {
  const { voiceToolAllowlist, selectVoiceTools, MAX_VOICE_TOOLS } = await load();
  const mcpNames = ["mcp_openclaw__drop_note", "mcp_itsaplan__list_projects", "not_mcp"];
  const allowlist = voiceToolAllowlist(mcpNames);
  assert.equal(allowlist[0], "open_app");
  assert.equal(allowlist[7], "vault_search");
  assert.deepEqual(allowlist.slice(9, 11), mcpNames.slice(0, 2));
  assert.equal(allowlist.at(-1), "copy_to_clipboard");
  assert.equal(allowlist.includes("not_mcp"), false);

  // Every tool exists: the cap keeps the head of the list, so the note tools are what gets cut.
  const tools = allowlist.map((name) => ({
    name,
    description: name,
    parameters: { type: "object" },
  }));
  const selected = selectVoiceTools(tools, allowlist).map((tool) => tool.name);
  assert.equal(selected.length, MAX_VOICE_TOOLS);
  assert.ok(selected.includes("vault_read"));
  assert.ok(selected.includes("mcp_itsaplan__list_projects"));
  assert.equal(selected.includes("copy_to_clipboard"), false);
});

test("with a vault configured, the app's own note tools are left out", async () => {
  const { voiceToolAllowlist } = await load();
  const withVault = voiceToolAllowlist([], { hasVault: true });
  assert.equal(withVault.includes("search_notes"), false);
  assert.equal(withVault.includes("get_note"), false);
  assert.ok(withVault.includes("vault_search"));
  assert.ok(withVault.includes("copy_to_clipboard"));
  assert.ok(voiceToolAllowlist([]).includes("search_notes"));
});

test("a session whose text leaves the machine keeps only tools that read none of the user's data", async () => {
  const { voiceToolAllowlist, ONLINE_VOICE_TOOLS } = await load();
  const allowlist = voiceToolAllowlist(["mcp_itsaplan__list_projects"], {
    hasVault: true,
    textLeavesMachine: true,
  });
  assert.deepEqual(allowlist, [...ONLINE_VOICE_TOOLS]);
  for (const name of [
    "vault_search",
    "vault_read",
    "search_notes",
    "get_note",
    "run_powershell",
    "delegate_task",
    "list_tasks",
    "mcp_itsaplan__list_projects",
  ]) {
    assert.equal(allowlist.includes(name), false, name);
  }
});
