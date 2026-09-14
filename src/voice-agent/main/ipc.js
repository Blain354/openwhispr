// IPC surface of Conversation mode.
//
// conversation-bridge:bootstrap (sync, called by preloadBridge.js) tells a window whether it may use the
// bridge. conversation-bridge:invoke dispatches one allowlisted op. Both resolve the caller from its
// webContents id, its main frame and its URL; nothing a renderer sends is trusted for identity.
const { BrowserWindow } = require("electron");
const { isOpAllowed, resolveWindowKind } = require("../shared/ipcPolicy");
const { redact } = require("./redact");

function registerConversationIpc({
  ipcMain,
  getWindowIds,
  isAllowedUrl,
  getConfig,
  handlers,
  tr,
  debugLogger,
}) {
  function resolveSender(event) {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    return resolveWindowKind({
      senderId: sender && !sender.isDestroyed() ? sender.id : null,
      isMainFrame: !!frame && !!sender && frame === sender.mainFrame,
      senderUrl: frame ? frame.url : null,
      windowIds: getWindowIds(),
      isAllowedUrl,
    });
  }

  ipcMain.on("conversation-bridge:bootstrap", (event) => {
    try {
      const windowKind = resolveSender(event);
      const config = getConfig();
      event.returnValue = windowKind
        ? { windowKind, enabled: !!config.enabled, toolsInChat: !!config.toolsInChat }
        : null;
    } catch {
      event.returnValue = null;
    }
  });

  ipcMain.handle("conversation-bridge:invoke", async (event, op, payload) => {
    const windowKind = resolveSender(event);
    const config = getConfig();
    if (!windowKind || typeof op !== "string") {
      return { success: false, displayText: tr("conversation.common.unavailable") };
    }
    if (!isOpAllowed({ windowKind, op, toolsInChat: config.toolsInChat })) {
      debugLogger?.warn("Conversation op refused", { op, windowKind }, "conversation");
      return { success: false, displayText: tr("conversation.common.forbidden") };
    }
    const handler = handlers[op];
    if (typeof handler !== "function") {
      return { success: false, displayText: tr("conversation.common.forbidden") };
    }
    const safePayload =
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    try {
      // The dictation overlay is transparent and unfocusable; a dialog parented to it is easy to
      // miss, so only real windows become the confirmation parent.
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const parentWindow = windowKind === "main" ? null : ownerWindow;
      return await handler(safePayload, { windowKind, parentWindow });
    } catch (error) {
      debugLogger?.error(
        "Conversation op failed",
        redact({ op, error: error?.message }),
        "conversation"
      );
      return { success: false, displayText: String(error?.message || error) };
    }
  });
}

module.exports = { registerConversationIpc };
