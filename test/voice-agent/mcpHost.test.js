const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  createMcpHost,
  readServerConfig,
  resultText,
} = require("../../src/voice-agent/main/mcpHost");

const USER_DATA = path.resolve("/appdata");
const tr = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

const CONFIG = {
  servers: [
    {
      name: "notes",
      url: "https://mcp.example.org/mcp",
      read: ["search_notes", "read_note"],
      write: ["drop_note"],
    },
  ],
};

function fakeFs(config = CONFIG) {
  return {
    readFileSync: (file) => {
      if (!String(file).endsWith("mcp.json")) throw new Error("ENOENT");
      if (config === null) throw new Error("ENOENT");
      return JSON.stringify(config);
    },
  };
}

function fakeClient({ tools = ["search_notes", "read_note", "drop_note"], onExecute } = {}) {
  const calls = [];
  const client = {
    listTools: async () => ({
      tools: tools.map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      })),
    }),
    tools: async () =>
      Object.fromEntries(
        tools.map((name) => [
          name,
          {
            execute: async (args, options) => {
              calls.push({ name, args, options });
              return onExecute
                ? onExecute(name, args)
                : { content: [{ type: "text", text: `${name} ok` }] };
            },
          },
        ])
      ),
    close: async () => calls.push({ name: "close" }),
  };
  return { client, calls };
}

function setup({ approve = true, config = CONFIG, clientOptions } = {}) {
  const { client, calls } = fakeClient(clientOptions);
  const confirmations = [];
  const host = createMcpHost({
    userDataDir: USER_DATA,
    tokens: { get: (server) => (server === "notes" ? "secret-token" : "") },
    confirm: async (request) => {
      confirmations.push(request);
      return approve;
    },
    tr,
    createClient: async (options) => {
      calls.push({ name: "connect", options });
      return client;
    },
    fsImpl: fakeFs(config),
  });
  return { host, calls, confirmations };
}

test("only declared tools are exposed, prefixed, with their access", async () => {
  const { host, calls } = setup();
  const list = await host.list();
  assert.deepEqual(
    list.data.tools.map((tool) => `${tool.name}:${tool.access}`),
    ["mcp_notes__search_notes:read", "mcp_notes__read_note:read", "mcp_notes__drop_note:write"]
  );
  const connect = calls.find((call) => call.name === "connect");
  assert.equal(connect.options.transport.url, "https://mcp.example.org/mcp");
  assert.equal(connect.options.transport.headers.Authorization, "Bearer secret-token");
  assert.equal(connect.options.transport.redirect, "error");
});

test("a tool the server offers but the configuration does not declare stays hidden", async () => {
  const { host } = setup({ clientOptions: { tools: ["search_notes", "ask_agent"] } });
  const list = await host.list();
  assert.deepEqual(
    list.data.tools.map((tool) => tool.name),
    ["mcp_notes__search_notes"]
  );
  const refused = await host.call({ name: "mcp_notes__ask_agent", arguments: {} });
  assert.equal(refused.success, false);
  assert.match(refused.displayText, /unknownTool/);
});

test("a read runs directly; a write waits for the native confirmation", async () => {
  const { host, calls, confirmations } = setup();
  const read = await host.call({
    name: "mcp_notes__search_notes",
    arguments: { query: "murmure" },
  });
  assert.equal(read.success, true);
  assert.equal(read.data.output, "search_notes ok");
  assert.equal(confirmations.length, 0);

  const write = await host.call({ name: "mcp_notes__drop_note", arguments: { text: "hello" } });
  assert.equal(write.success, true);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].detail, /hello/);
  assert.equal(confirmations[0].risk, "high");
  assert.deepEqual(calls.at(-1).args, { text: "hello" });
});

test("a refused confirmation does not call the server", async () => {
  const { host, calls } = setup({ approve: false });
  const write = await host.call({ name: "mcp_notes__drop_note", arguments: {} });
  assert.equal(write.success, false);
  assert.equal(
    calls.some((call) => call.name === "drop_note"),
    false
  );
});

test("a tool error is a failure, and its text comes back readable", async () => {
  const { host } = setup({
    clientOptions: {
      onExecute: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }),
    },
  });
  const result = await host.call({ name: "mcp_notes__search_notes", arguments: {} });
  assert.equal(result.success, false);
  assert.equal(result.displayText, "boom");
});

test("no configuration means no servers, and results are turned into bounded text", () => {
  assert.deepEqual(readServerConfig(USER_DATA, fakeFs(null)), { servers: [], errors: [] });
  assert.equal(resultText({ content: [{ type: "text", text: "  hi  " }] }), "hi");
  assert.equal(resultText({ content: [{ type: "image", data: "…" }] }), "[image]");
  assert.equal(resultText({ content: [], isError: true }), "The tool reported an error.");
  assert.equal(resultText({ content: [{ type: "text", text: "x".repeat(50) }] }, 10).length, 11);
});
