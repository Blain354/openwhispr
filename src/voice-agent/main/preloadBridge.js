// Conversation mode renderer bridge.
//
// Registered with session.defaultSession.registerPreloadScript({ type: "frame" }), so it runs
// before preload.js in every window of the default session, including sandboxed ones and any
// page a window navigates to. Sandboxed preloads can only require "electron", so this file must
// stay self-contained.
//
// The main process is the authority on who may use the bridge: the synchronous bootstrap call
// returns null for any sender that is not an app window it recognises (wrong URL, subframe,
// unknown webContents), and then nothing is exposed.
const { contextBridge, ipcRenderer } = require("electron");

function readBootstrap() {
  try {
    if (window.top !== window) return null;
    return ipcRenderer.sendSync("conversation-bridge:bootstrap");
  } catch {
    return null;
  }
}

const bootstrap = readBootstrap();

if (bootstrap && typeof bootstrap === "object" && bootstrap.windowKind) {
  const frozenBootstrap = Object.freeze({ ...bootstrap });

  contextBridge.exposeInMainWorld("conversationAPI", {
    bootstrap: frozenBootstrap,
    invoke: (op, payload) => ipcRenderer.invoke("conversation-bridge:invoke", op, payload),
    on: (type, callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, message) => {
        if (!message || typeof message !== "object") return;
        if (type === "*" || message.type === type) callback(message);
      };
      ipcRenderer.on("conversation-bridge:event", listener);
      return () => ipcRenderer.removeListener("conversation-bridge:event", listener);
    },
  });
}
