const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateMcpConfig,
  toolAccess,
  mcpToolName,
  parseMcpToolName,
  MAX_MCP_TOOLS,
} = require("../../src/voice-agent/shared/mcpNaming");

const server = (overrides = {}) => ({
  name: "openclaw",
  url: "https://mcp.example.org/mcp",
  read: ["list_workspace_files", "read_workspace_file"],
  write: ["drop_note"],
  ...overrides,
});

test("exact tool names are exposed with a server prefix and a read or write access", () => {
  const { servers, errors } = validateMcpConfig({ servers: [server()] });
  assert.deepEqual(errors, []);
  assert.equal(mcpToolName("openclaw", "drop_note"), "mcp_openclaw__drop_note");
  assert.deepEqual(parseMcpToolName("mcp_openclaw__read_workspace_file"), {
    server: "openclaw",
    tool: "read_workspace_file",
  });
  assert.deepEqual(toolAccess(servers, "mcp_openclaw__drop_note"), {
    server: "openclaw",
    tool: "drop_note",
    access: "write",
  });
  assert.equal(toolAccess(servers, "mcp_openclaw__ask_agent"), null);
  assert.equal(toolAccess(servers, "mcp_other__drop_note"), null);
  assert.equal(toolAccess(servers, "open_app"), null);
});

test("wildcards, bad names, insecure URLs and duplicates are refused", () => {
  const { servers, errors } = validateMcpConfig({
    servers: [
      server({ read: ["*"], write: [] }),
      server({ name: "itsaplan", url: "http://192.168.0.10/mcp", read: ["list_projects"] }),
      server({ name: "Bad Name" }),
      server({
        name: "local",
        url: "http://127.0.0.1:8080/mcp",
        read: ["list_projects"],
        write: [],
      }),
      server({ name: "local", read: [] }),
      server({ name: "creds", url: "https://user:pass@example.org/mcp" }),
      server({ name: "mixed", read: ["same"], write: ["same"] }),
    ],
  });
  assert.deepEqual(
    servers.map((s) => s.name),
    ["local"]
  );
  assert.deepEqual(errors, [
    "tool:openclaw:*",
    "url:itsaplan",
    "server-name:Bad Name",
    "duplicate-server:local",
    "url:creds",
    "both:mixed:same",
  ]);
});

test("a configuration exposing more tools than the cap is refused as a whole", () => {
  const read = Array.from({ length: MAX_MCP_TOOLS }, (_, i) => `tool_${i}`);
  const { servers, errors } = validateMcpConfig({ servers: [server({ read, write: ["extra"] })] });
  assert.deepEqual(servers, []);
  assert.deepEqual(errors, [`too-many-tools:${MAX_MCP_TOOLS + 1}`]);
});

test("names that would exceed the function name limit are refused", () => {
  const long = `t${"x".repeat(63)}`;
  const { errors } = validateMcpConfig({ servers: [server({ read: [long], write: [] })] });
  assert.deepEqual(errors, [`too-long:openclaw:${long}`]);
});
