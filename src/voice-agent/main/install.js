// Single entry point of Conversation mode in the main process.
//
// main.js calls install() once, right after the upstream sidecars are registered and before the
// first window is created: the preload bridge must be registered before any window loads.
const path = require("path");
const { pathToFileURL } = require("url");
const { app, dialog, ipcMain, session } = require("electron");
const DevServerManager = require("../../helpers/devServerManager");
const { isAllowedAppNavigation } = require("../../helpers/navigationGuard");
const { loadConfig } = require("./config");
const { tr } = require("./i18n");
const { createConfirm } = require("./confirm");
const { createOsActions } = require("./osActions");
const { registerConversationIpc } = require("./ipc");

const PRELOAD_ID = "openwhispr-conversation-bridge";

let installed = null;

function resolveAppUrl() {
  const devUrl = DevServerManager.getAppUrl(false);
  if (devUrl) return devUrl;
  const fileInfo = DevServerManager.getAppFilePath(false);
  return fileInfo ? pathToFileURL(fileInfo.path).href : null;
}

function registerPreloadBridge(debugLogger) {
  const defaultSession = session.defaultSession;
  if (typeof defaultSession?.registerPreloadScript !== "function") {
    debugLogger?.warn(
      "registerPreloadScript unavailable; conversation bridge disabled",
      {},
      "conversation"
    );
    return false;
  }
  const already = defaultSession.getPreloadScripts?.().some((script) => script.id === PRELOAD_ID);
  if (!already) {
    defaultSession.registerPreloadScript({
      id: PRELOAD_ID,
      type: "frame",
      filePath: path.join(__dirname, "preloadBridge.js"),
    });
  }
  return true;
}

function install({ windowManager, debugLogger }) {
  if (installed) return installed;

  const userDataDir = app.getPath("userData");
  let config = loadConfig(userDataDir);
  const appUrl = resolveAppUrl();

  registerPreloadBridge(debugLogger);

  const confirm = createConfirm({ dialog, tr, debugLogger });
  const os = createOsActions({ userDataDir, confirm, tr, debugLogger });

  const conversationWindows = { session: null, companion: null };
  const idOf = (win) => (win && !win.isDestroyed() ? win.webContents.id : null);

  registerConversationIpc({
    ipcMain,
    getWindowIds: () => ({
      main: idOf(windowManager?.mainWindow),
      "control-panel": idOf(windowManager?.controlPanelWindow),
      session: idOf(conversationWindows.session),
      companion: idOf(conversationWindows.companion),
    }),
    isAllowedUrl: (url) => isAllowedAppNavigation(url, appUrl),
    getConfig: () => config,
    handlers: {
      "os.openApp": os.openApp,
      "os.focusWindow": os.focusWindow,
      "os.setDisplays": os.setDisplays,
      "os.runPowershell": os.runPowershell,
    },
    tr,
    debugLogger,
  });

  debugLogger?.info(
    "Conversation mode installed",
    { enabled: config.enabled, toolsInChat: config.toolsInChat },
    "conversation"
  );

  installed = {
    getConfig: () => config,
    reloadConfig: () => {
      config = loadConfig(userDataDir);
      return config;
    },
    conversationWindows,
  };
  return installed;
}

module.exports = { install };
