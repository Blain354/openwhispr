// Tokens of the MCP servers a voice session may use.
//
// A token is written from the session window and never read back into a renderer: the store has no
// read op, only a list of which servers have one. Values are encrypted with Electron's safeStorage;
// without it, nothing is stored at all rather than stored in the clear.
const fs = require("fs");
const path = require("path");

function createTokenStore({ userDataDir, safeStorage, debugLogger, fsImpl = fs }) {
  const file = path.join(userDataDir, "voice-agent", "mcp-tokens.bin");

  function readAll() {
    try {
      if (!safeStorage?.isEncryptionAvailable()) return {};
      const parsed = JSON.parse(safeStorage.decryptString(fsImpl.readFileSync(file)));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(tokens) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
    const temporary = `${file}.tmp`;
    fsImpl.writeFileSync(temporary, encrypted);
    fsImpl.renameSync(temporary, file);
  }

  return {
    /** @returns {{ ok: boolean, error?: string, servers: string[] }} */
    set(server, token) {
      if (!safeStorage?.isEncryptionAvailable()) {
        return { ok: false, error: "no-encryption", servers: [] };
      }
      const name = String(server || "").trim();
      const value = String(token || "").trim();
      if (!name) return { ok: false, error: "no-server", servers: Object.keys(readAll()) };
      const tokens = readAll();
      if (value) tokens[name] = value;
      else delete tokens[name];
      try {
        writeAll(tokens);
      } catch (error) {
        debugLogger?.error("MCP token write failed", { error: error?.message }, "conversation");
        return { ok: false, error: "write-failed", servers: Object.keys(tokens) };
      }
      return { ok: true, servers: Object.keys(tokens) };
    },
    /** Main process only. */
    get(server) {
      return readAll()[String(server || "")] || "";
    },
    servers() {
      return Object.keys(readAll());
    },
  };
}

module.exports = { createTokenStore };
