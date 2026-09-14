// What a voice session stores in OpenWhispr's conversation tables. Pure logic.
//
// Messages are tagged in agent_messages.metadata (no schema change). Tool results are never
// stored: they may hold vault excerpts, command output or MCP data, and conversations sync to
// OpenWhispr Cloud when the user is signed in with cloud backup on.

const pad = (n) => String(n).padStart(2, "0");

export function sessionTitle(date, language) {
  const d = date instanceof Date ? date : new Date(date);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
  const prefix = String(language || "")
    .toLowerCase()
    .startsWith("fr")
    ? "Session vocale"
    : "Voice session";
  return `${prefix} — ${stamp}`;
}

/**
 * @param {{ interrupted?: boolean, toolCalls?: Array<{ name?: string, status?: string }> }} [input]
 */
export function voiceMessageMetadata(input = {}) {
  const metadata = { source: "voice" };
  if (input.interrupted) metadata.interrupted = true;
  const calls = Array.isArray(input.toolCalls) ? input.toolCalls : [];
  if (calls.length > 0) {
    metadata.toolCalls = calls.map((call) => ({
      name: String(call?.name || "unknown"),
      status:
        call?.status === "error"
          ? "error"
          : call?.status === "executing"
            ? "executing"
            : "completed",
    }));
  }
  return metadata;
}

/**
 * Persisting a session is local-only by default: a signed-in user with cloud backup must opt in.
 */
export function shouldPersistVoiceSession({ isSignedIn, cloudBackupEnabled, cloudConsent }) {
  if (isSignedIn && cloudBackupEnabled) return !!cloudConsent;
  return true;
}
