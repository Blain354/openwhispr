// MCP servers offered to the voice session: configuration validation and tool naming. Pure logic.
//
// Only tools listed by their exact name are exposed, each marked read or write; there are no
// wildcards, so a server that adds a tool later exposes nothing new. Exposed names are prefixed
// with the server so two servers cannot shadow each other.

const MAX_MCP_TOOLS = 12;
const MAX_FUNCTION_NAME = 64;
const SERVER_NAME = /^[a-z][a-z0-9]{0,23}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

const mcpToolName = (server, tool) => `mcp_${server}__${tool}`;

function parseMcpToolName(name) {
  const match = /^mcp_([a-z][a-z0-9]{0,23})__(.+)$/.exec(String(name || ""));
  return match ? { server: match[1], tool: match[2] } : null;
}

function validUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:" || LOOPBACK.test(url.href)) return url.href;
  return null;
}

/**
 * @param {unknown} raw `{ servers: [{ name, url, read: string[], write: string[] }] }`
 * @returns {{ servers: Array<{ name: string, url: string, read: string[], write: string[] }>, errors: string[] }}
 */
function validateMcpConfig(raw) {
  const errors = [];
  const servers = [];
  const seenServers = new Set();
  const input = raw && Array.isArray(raw.servers) ? raw.servers : [];
  for (const server of input) {
    const name = String(server?.name || "");
    if (!SERVER_NAME.test(name)) {
      errors.push(`server-name:${name}`);
      continue;
    }
    if (seenServers.has(name)) {
      errors.push(`duplicate-server:${name}`);
      continue;
    }
    seenServers.add(name);
    const url = validUrl(server.url);
    if (!url) {
      errors.push(`url:${name}`);
      continue;
    }
    const lists = { read: [], write: [] };
    let valid = true;
    for (const access of ["read", "write"]) {
      const tools = Array.isArray(server[access]) ? server[access] : [];
      for (const tool of tools) {
        if (typeof tool !== "string" || !TOOL_NAME.test(tool)) {
          errors.push(`tool:${name}:${String(tool)}`);
          valid = false;
        } else if (mcpToolName(name, tool).length > MAX_FUNCTION_NAME) {
          errors.push(`too-long:${name}:${tool}`);
          valid = false;
        } else if (!lists[access].includes(tool)) {
          lists[access].push(tool);
        }
      }
    }
    for (const tool of lists.read) {
      if (lists.write.includes(tool)) {
        errors.push(`both:${name}:${tool}`);
        valid = false;
      }
    }
    if (valid) servers.push({ name, url, read: lists.read, write: lists.write });
  }
  const total = servers.reduce((sum, server) => sum + server.read.length + server.write.length, 0);
  if (total > MAX_MCP_TOOLS) {
    return { servers: [], errors: [...errors, `too-many-tools:${total}`] };
  }
  return { servers, errors };
}

/** @returns {{ server: string, tool: string, access: "read" | "write" } | null} */
function toolAccess(servers, exposedName) {
  const parsed = parseMcpToolName(exposedName);
  if (!parsed) return null;
  const server = servers.find((candidate) => candidate.name === parsed.server);
  if (!server) return null;
  if (server.read.includes(parsed.tool)) return { ...parsed, access: "read" };
  if (server.write.includes(parsed.tool)) return { ...parsed, access: "write" };
  return null;
}

module.exports = {
  validateMcpConfig,
  toolAccess,
  mcpToolName,
  parseMcpToolName,
  MAX_MCP_TOOLS,
};
