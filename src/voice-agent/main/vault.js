// Read-only notes vault tools of the voice session (main process).
//
// The vault is read from the main process only, through vaultGuard. The audit log records what was
// asked of the vault (counts and paths returned), never the query text or note content.
const fs = require("fs");
const path = require("path");
const { searchVault, readVaultNote } = require("../shared/vaultGuard");

const MAX_QUERY_CHARS = 200;

const ERROR_KEYS = {
  "no-vault": "conversation.vault.notConfigured",
  "empty-query": "conversation.vault.emptyQuery",
  sensitive: "conversation.vault.private",
  sealed: "conversation.vault.private",
  hidden: "conversation.vault.private",
  excluded: "conversation.vault.private",
  "not-found": "conversation.vault.notFound",
  "not-markdown": "conversation.vault.notFound",
};

function createVaultAccess({
  userDataDir,
  getConfig,
  tr,
  debugLogger,
  fsImpl = fs,
  now = Date.now,
}) {
  function audit(entry) {
    try {
      const file = path.join(userDataDir, "voice-agent", "audit.jsonl");
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.appendFileSync(
        file,
        `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`
      );
    } catch (error) {
      debugLogger?.warn("Vault audit write failed", { error: error?.message }, "conversation");
    }
  }

  const refusal = (error) => ({
    success: false,
    displayText: tr(ERROR_KEYS[error] || "conversation.vault.refused"),
  });

  function search(payload) {
    const config = getConfig();
    const query = String(payload?.query || "")
      .trim()
      .slice(0, MAX_QUERY_CHARS);
    const result = searchVault({
      vaultRoot: config.vaultRoot,
      query,
      excluded: config.vaultExcluded,
      fsImpl,
    });
    audit({
      op: "vault.search",
      queryChars: query.length,
      results: result.ok ? result.results.map((item) => item.path) : [],
      sensitiveSkipped: result.sensitiveSkipped || 0,
      error: result.ok ? undefined : result.error,
    });
    if (!result.ok) return refusal(result.error);
    const lines = result.results.map(
      (item) => `${item.path}${item.conflict ? " (sync conflict copy)" : ""}\n  ${item.snippet}`
    );
    if (result.sensitiveSkipped) {
      lines.push(tr("conversation.vault.sensitiveSkipped", { count: result.sensitiveSkipped }));
    }
    return {
      success: true,
      data: { results: result.results, output: lines.join("\n") },
      displayText: tr("conversation.vault.found", { count: result.results.length }),
    };
  }

  function read(payload) {
    const config = getConfig();
    const result = readVaultNote({
      vaultRoot: config.vaultRoot,
      relativePath: String(payload?.path || ""),
      excluded: config.vaultExcluded,
      fsImpl,
    });
    audit({
      op: "vault.read",
      path: result.ok ? result.path : undefined,
      error: result.ok ? undefined : result.error,
    });
    if (!result.ok) return refusal(result.error);
    const notes = [
      result.conflict ? tr("conversation.vault.conflictCopy") : "",
      result.truncated ? tr("conversation.vault.truncated") : "",
    ].filter(Boolean);
    return {
      success: true,
      data: { path: result.path, output: [...notes, result.text].join("\n\n") },
      displayText: tr("conversation.vault.read", { path: result.path }),
    };
  }

  return { search, read };
}

module.exports = { createVaultAccess };
