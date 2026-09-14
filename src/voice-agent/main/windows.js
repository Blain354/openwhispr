// Session window and companion overlay of Conversation mode.
//
// Both load the regular renderer with a query marker (read by AppRouter) and upstream's preload,
// but with their own hardened webPreferences (sandboxed, web security on) instead of the control
// panel's, and with the navigation guards upstream only attaches to the control panel: a link in
// a transcript must open in the browser, never inside a window that holds the conversation bridge.
const path = require("path");
const { pathToFileURL } = require("url");
const { BrowserWindow, screen, shell } = require("electron");
const DevServerManager = require("../../helpers/devServerManager");
const { isAllowedAppNavigation, isExternalBrowserUrl } = require("../../helpers/navigationGuard");

const PRELOAD = path.join(__dirname, "..", "..", "..", "preload.js");
const COMPANION_SIZE = 168;
const COMPANION_MARGIN = 24;

const SECURE_WEB_PREFERENCES = Object.freeze({
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
});

function appUrl() {
  const devUrl = DevServerManager.getAppUrl(false);
  if (devUrl) return devUrl;
  const fileInfo = DevServerManager.getAppFilePath(false);
  return fileInfo ? pathToFileURL(fileInfo.path).href : null;
}

function loadView(win, marker) {
  const devUrl = DevServerManager.getAppUrl(false);
  if (devUrl) return win.loadURL(`${devUrl}?${marker}=true`);
  const fileInfo = DevServerManager.getAppFilePath(false);
  return win.loadFile(fileInfo.path, { query: { [marker]: "true" } });
}

function guardNavigation(win, debugLogger) {
  const allowed = appUrl();
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, allowed)) return;
    event.preventDefault();
    if (isExternalBrowserUrl(url)) {
      shell.openExternal(url).catch(() => {});
    } else {
      debugLogger?.debug("Blocked untrusted navigation", { url }, "conversation");
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalBrowserUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => child.close());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function createConversationWindows({ debugLogger, onClosed }) {
  const windows = { session: null, companion: null };
  const alive = (win) => !!win && !win.isDestroyed();

  async function showSession() {
    if (alive(windows.session)) {
      if (windows.session.isMinimized()) windows.session.restore();
      windows.session.show();
      return windows.session;
    }
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      minWidth: 360,
      minHeight: 420,
      show: false,
      title: "OpenWhispr Conversation",
      backgroundColor: "#1c1c2e",
      autoHideMenuBar: true,
      webPreferences: SECURE_WEB_PREFERENCES,
    });
    windows.session = win;
    guardNavigation(win, debugLogger);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      windows.session = null;
      onClosed?.("session");
    });
    await loadView(win, "conversation-session");
    return win;
  }

  async function showCompanion() {
    if (alive(windows.companion)) {
      windows.companion.showInactive();
      return windows.companion;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const win = new BrowserWindow({
      width: COMPANION_SIZE,
      height: COMPANION_SIZE,
      x: Math.round(workArea.x + workArea.width - COMPANION_SIZE - COMPANION_MARGIN),
      y: Math.round(workArea.y + workArea.height - COMPANION_SIZE - COMPANION_MARGIN),
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: SECURE_WEB_PREFERENCES,
    });
    win.setAlwaysOnTop(true, "screen-saver");
    windows.companion = win;
    guardNavigation(win, debugLogger);
    win.once("ready-to-show", () => win.showInactive());
    win.on("closed", () => {
      windows.companion = null;
      onClosed?.("companion");
    });
    await loadView(win, "conversation-companion");
    return win;
  }

  function closeCompanion() {
    if (alive(windows.companion)) windows.companion.close();
  }

  function broadcast(message) {
    for (const win of [windows.session, windows.companion]) {
      if (alive(win)) win.webContents.send("conversation-bridge:event", message);
    }
  }

  return { windows, showSession, showCompanion, closeCompanion, broadcast };
}

module.exports = { createConversationWindows, SECURE_WEB_PREFERENCES };
