// MCP servers a voice session may use (main process).
//
// Servers and the exact tools they expose are declared in <userData>/voice-agent/mcp.json; nothing
// a server offers beyond that list is ever visible to the model. Tools are prefixed with their
// server, so two servers cannot shadow each other, and a tool declared as a write is confirmed in
// a native dialog before it runs. Tokens stay in the main process.
const fs = require("fs");
const path = require("path");
const { validateMcpConfig, toolAccess } = require("../shared/mcpNaming");
const { mcpToolName } = require("../shared/mcpNaming");

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 4000;
const MAX_ARGUMENT_CHARS = 600;

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);

function configPath(userDataDir) {
  return path.join(userDataDir, "voice-agent", "mcp.json");
}

/** Pure: the declared servers, or none when the file is missing or invalid. */
function readServerConfig(userDataDir, fsImpl = fs) {
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(configPath(userDataDir), "utf8"));
  } catch {
    return { servers: [], errors: [] };
  }
  return validateMcpConfig(raw);
}

/** Pure: readable text from an MCP tool result. */
function resultText(result, maxChars = MAX_RESULT_CHARS) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = content.map((block) => {
    if (block?.type === "text") return String(block.text || "");
    if (block?.type === "resource" && typeof block.resource?.text === "string") {
      return block.resource.text;
    }
    return `[${String(block?.type || "content")}]`;
  });
  const text = parts.join("\n").trim();
  if (!text) return result?.isError ? "The tool reported an error." : "Done.";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function createMcpHost({
  userDataDir,
  tokens,
  confirm,
  tr,
  debugLogger,
  createClient,
  fsImpl = fs,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  callTimeoutMs = CALL_TIMEOUT_MS,
}) {
  let connection = null;

  async function connectServer(server) {
    const token = tokens.get(server.name);
    const client = await withTimeout(
      createClient({
        transport: {
          type: "http",
          url: server.url,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          // A redirect could send the token to another host.
          redirect: "error",
        },
      }),
      connectTimeoutMs,
      `MCP ${server.name}`
    );
    const [listed, toolset] = await Promise.all([
      withTimeout(client.listTools(), connectTimeoutMs, `MCP ${server.name} tools`),
      withTimeout(client.tools(), connectTimeoutMs, `MCP ${server.name} tools`),
    ]);
    const offered = new Map((listed?.tools || []).map((tool) => [tool.name, tool]));
    const exposed = [];
    for (const access of ["read", "write"]) {
      for (const name of server[access]) {
        const definition = offered.get(name);
        if (!definition || typeof toolset?.[name]?.execute !== "function") {
          debugLogger?.warn(
            "MCP tool not offered by the server",
            { server: server.name, tool: name },
            "conversation"
          );
          continue;
        }
        exposed.push({
          name: mcpToolName(server.name, name),
          server: server.name,
          tool: name,
          access,
          description: String(definition.description || name),
          parameters:
            definition.inputSchema && typeof definition.inputSchema === "object"
              ? definition.inputSchema
              : { type: "object", properties: {} },
          execute: (args) =>
            toolset[name].execute(args, { toolCallId: `voice-${name}`, messages: [] }),
        });
      }
    }
    return { client, exposed };
  }

  async function connect() {
    const { servers, errors } = readServerConfig(userDataDir, fsImpl);
    if (errors.length) {
      debugLogger?.warn("Invalid MCP configuration", { errors }, "conversation");
    }
    const settled = await Promise.allSettled(servers.map((server) => connectServer(server)));
    const clients = [];
    const callables = new Map();
    const failed = [];
    settled.forEach((outcome, index) => {
      if (outcome.status !== "fulfilled") {
        failed.push({ server: servers[index].name, error: outcome.reason?.message || "failed" });
        debugLogger?.warn(
          "MCP server unavailable",
          { server: servers[index].name, error: outcome.reason?.message },
          "conversation"
        );
        return;
      }
      clients.push(outcome.value.client);
      for (const entry of outcome.value.exposed) callables.set(entry.name, entry);
    });
    return { servers, clients, callables, failed, errors };
  }

  function ensureConnection() {
    if (!connection)
      connection = connect().catch((error) => ((connection = null), Promise.reject(error)));
    return connection;
  }

  async function reset() {
    const current = connection;
    connection = null;
    if (!current) return;
    try {
      const { clients } = await current;
      await Promise.allSettled(clients.map((client) => client.close?.()));
    } catch {}
  }

  async function list() {
    try {
      const { callables, failed, errors } = await ensureConnection();
      return {
        success: true,
        data: {
          tools: [...callables.values()].map(({ name, description, parameters, access }) => ({
            name,
            description,
            parameters,
            access,
          })),
          failed,
          errors,
        },
      };
    } catch (error) {
      await reset();
      return {
        success: false,
        displayText: tr("conversation.mcp.unavailable"),
        errors: [error.message],
      };
    }
  }

  async function call(payload, context = {}) {
    const name = String(payload?.name || "");
    let state;
    try {
      state = await ensureConnection();
    } catch {
      return { success: false, displayText: tr("conversation.mcp.unavailable") };
    }
    const entry = state.callables.get(name);
    // Re-checked here, not only when the tool list was built.
    if (!entry || !toolAccess(state.servers, name)) {
      return { success: false, displayText: tr("conversation.mcp.unknownTool", { name }) };
    }
    const args =
      payload?.arguments && typeof payload.arguments === "object" ? payload.arguments : {};

    if (entry.access === "write") {
      const approved = await confirm({
        title: tr("conversation.mcp.confirmTitle"),
        message: tr("conversation.mcp.confirmMessage", { tool: entry.tool, server: entry.server }),
        detail: `${tr("conversation.mcp.detailArguments")}\n${JSON.stringify(args, null, 2).slice(0, MAX_ARGUMENT_CHARS)}`,
        risk: "high",
        parent: context.parentWindow,
      });
      if (!approved) return { success: false, displayText: tr("conversation.mcp.cancelled") };
    }

    try {
      const result = await withTimeout(entry.execute(args), callTimeoutMs, `MCP ${name}`);
      const text = resultText(result);
      if (result?.isError) return { success: false, displayText: text, data: { output: text } };
      return {
        success: true,
        data: { output: text },
        displayText: tr("conversation.mcp.done", { tool: entry.tool }),
      };
    } catch (error) {
      await reset();
      debugLogger?.warn("MCP call failed", { tool: name, error: error?.message }, "conversation");
      return { success: false, displayText: tr("conversation.mcp.failed", { tool: entry.tool }) };
    }
  }

  return { list, call, reset, configPath: () => configPath(userDataDir) };
}

module.exports = { createMcpHost, readServerConfig, resultText, configPath };
