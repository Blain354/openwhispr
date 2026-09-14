// Who may call which conversation op. Pure logic, main process only.
//
// Window kinds are resolved by the main process from the sender's webContents id, never from
// anything the renderer claims about itself.

const OP_RULES = {
  "os.openApp": { session: true, chat: true },
  "os.focusWindow": { session: true, chat: true },
  "os.setDisplays": { session: true, chat: true },
  "os.runPowershell": { session: true, chat: true },
};

const CHAT_WINDOW_KINDS = new Set(["main", "control-panel"]);

function isOpAllowed({ windowKind, op, toolsInChat }) {
  const rule = Object.prototype.hasOwnProperty.call(OP_RULES, op) ? OP_RULES[op] : null;
  if (!rule) return false;
  if (windowKind === "session") return !!rule.session;
  if (windowKind === "companion") return !!rule.companion;
  if (CHAT_WINDOW_KINDS.has(windowKind)) return !!toolsInChat && !!rule.chat;
  return false;
}

/**
 * @param {{ senderId: number | null, isMainFrame: boolean, senderUrl: string | null,
 *           windowIds: Record<string, number | null | undefined>,
 *           isAllowedUrl: (url: string) => boolean }} input
 * @returns {string | null} the window kind, or null when the sender is not trusted
 */
function resolveWindowKind({ senderId, isMainFrame, senderUrl, windowIds, isAllowedUrl }) {
  if (typeof senderId !== "number" || !isMainFrame || !senderUrl) return null;
  if (!isAllowedUrl(senderUrl)) return null;
  for (const [kind, id] of Object.entries(windowIds || {})) {
    if (typeof id === "number" && id === senderId) return kind;
  }
  return null;
}

module.exports = { isOpAllowed, resolveWindowKind, OP_RULES };
