// Single entry point of Conversation mode in the main process.
//
// main.js calls install() once, right after the upstream sidecars are registered and before the
// first window is created: the preload bridge must be registered before any window loads. The
// hotkey slot is registered later, once the dictation window (and its hotkeys) exist.
const path = require("path");
const { pathToFileURL } = require("url");
const { app, dialog, ipcMain, Notification, session } = require("electron");
const DevServerManager = require("../../helpers/devServerManager");
const { isAllowedAppNavigation } = require("../../helpers/navigationGuard");
const { loadConfig, saveConfig } = require("./config");
const { tr } = require("./i18n");
const { createConfirm } = require("./confirm");
const { createOsActions } = require("./osActions");
const { registerConversationIpc } = require("./ipc");
const { createConversationWindows } = require("./windows");
const { createSessionController } = require("./session");
const { createConversationHotkey } = require("./hotkey");
const { createVramCoordinator } = require("./vram");
const { createConversationRuntime } = require("./runtime");
const { createWorkerManager } = require("./workers");

const PRELOAD_ID = "openwhispr-conversation-bridge";
const HOTKEY_REGISTRATION_DELAY_MS = 2000;

const HOTKEY_ERROR_KEYS = {
  empty: "conversation:hotkey.errors.empty",
  "modifier-only": "conversation:hotkey.errors.modifierOnly",
  "right-side-modifier": "conversation:hotkey.errors.rightSideModifier",
  "multiple-keys": "conversation:hotkey.errors.multipleKeys",
  "needs-modifier": "conversation:hotkey.errors.needsModifier",
  "windows-reserved": "conversation:hotkey.errors.windowsReserved",
  duplicate: "conversation:hotkey.errors.duplicate",
  "starts-with": "conversation:hotkey.errors.startsWith",
  "registration-failed": "conversation:hotkey.errors.registrationFailed",
  "hotkey-manager-unavailable": "conversation:hotkey.errors.unavailable",
};

const HOTKEY_WARNING_KEYS = {
  "powertoys-run": "conversation:hotkey.warnings.powertoysRun",
  "command-palette": "conversation:hotkey.warnings.commandPalette",
};

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

function describeCodes(codes, table) {
  return (codes || []).map((code) => {
    const [name, slot] = String(code).split(":");
    return table[name] ? tr(table[name], { slot }) : String(code);
  });
}

function install({ windowManager, whisperManager, debugLogger }) {
  if (installed) return installed;

  const userDataDir = app.getPath("userData");
  let config = loadConfig(userDataDir);
  const appUrl = resolveAppUrl();
  const isDevelopment = process.env.NODE_ENV === "development";

  registerPreloadBridge(debugLogger);

  const confirm = createConfirm({ dialog, tr, debugLogger });
  const os = createOsActions({ userDataDir, confirm, tr, debugLogger });

  let sessionController = null;
  let runtime = null;
  const conversationWindows = createConversationWindows({
    debugLogger,
    onClosed: (kind) => {
      if (kind === "session") void sessionController?.stop();
    },
  });
  sessionController = createSessionController({
    windowManager,
    conversationWindows,
    debugLogger,
    onStopping: () => runtime?.end(),
  });

  // The model manager is loaded on first use, as main.js does.
  let vram = null;
  runtime = createConversationRuntime({
    userDataDir,
    getConfig: () => config,
    sessionController,
    conversationWindows,
    getVram: () =>
      (vram ||= createVramCoordinator({
        modelManager: require("../../helpers/modelManagerBridge").default,
        whisperManager,
        debugLogger,
      })),
    debugLogger,
  });
  app.on("will-quit", () => runtime.shutdownSync());

  // A finished background task is announced with a fixed sentence (never the worker's own text):
  // spoken now when a session is running, otherwise when the next session starts.
  const pendingAnnouncements = [];
  const workers = createWorkerManager({
    userDataDir,
    getConfig: () => config,
    confirm,
    tr,
    debugLogger,
    onUpdate: (task, { finished } = {}) => {
      conversationWindows.broadcast({ type: "task.update", data: task });
      if (!finished || task.status === "cancelled") return;
      const succeeded = task.status === "succeeded";
      if (Notification.isSupported()) {
        new Notification({
          title: tr(
            succeeded
              ? "conversation:workers.notificationDone"
              : "conversation:workers.notificationFailed"
          ),
          body: task.title,
        }).show();
      }
      const sentence = tr(
        succeeded ? "conversation:workers.spokenDone" : "conversation:workers.spokenFailed",
        { title: task.title }
      );
      if (runtime.isRunning()) runtime.send("say", { text: sentence });
      else pendingAnnouncements.push(sentence);
    },
  });
  app.on("will-quit", () => workers.shutdownSync());

  const conversationHotkey = createConversationHotkey({
    windowManager,
    onToggle: () => sessionController.toggle(),
    debugLogger,
  });

  // A hotkey owned by another application cannot be registered, and without it there is no way to
  // reach the session settings: the notification opens the session window so it can be changed.
  const notifyHotkeyUnavailable = (hotkey) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: tr("conversation:hotkey.unavailableTitle"),
      body: tr("conversation:hotkey.unavailableBody", { hotkey }),
    });
    notification.on("click", () => void conversationWindows.showSession());
    notification.show();
  };

  if (windowManager) {
    // The one-line upstream gate in _shouldBlockDictationInput reads this.
    windowManager.isConversationActive = () => sessionController.isActive();

    if (typeof windowManager.createMainWindow === "function") {
      const originalCreateMainWindow = windowManager.createMainWindow.bind(windowManager);
      let registrationScheduled = false;
      windowManager.createMainWindow = async (...args) => {
        const result = await originalCreateMainWindow(...args);
        if (!registrationScheduled && config.enabled) {
          registrationScheduled = true;
          setTimeout(() => {
            conversationHotkey
              .register(config.hotkey)
              .then((result) => {
                if (!result.success) notifyHotkeyUnavailable(config.hotkey);
              })
              .catch((error) => {
                debugLogger?.error(
                  "Conversation hotkey setup failed",
                  { error: error?.message },
                  "conversation"
                );
              });
          }, HOTKEY_REGISTRATION_DELAY_MS);
        }
        return result;
      };
    }
  }

  // Another slot changed (for example dictation moved to a modifier-only chord): re-check that the
  // conversation hotkey still cannot fire together with it.
  ipcMain.on("hotkey-changed", () => {
    if (!config.enabled) return;
    setTimeout(async () => {
      const verdict = await conversationHotkey.validate(config.hotkey);
      if (!verdict.ok) {
        conversationHotkey.unregister();
        debugLogger?.warn(
          "Conversation hotkey disabled after another hotkey changed",
          verdict,
          "conversation"
        );
      }
    }, 500);
  });

  const publicConfig = () => ({
    enabled: config.enabled,
    toolsInChat: config.toolsInChat,
    hotkey: config.hotkey,
    conversationModel: config.conversationModel,
    sttLanguage: config.sttLanguage,
    bargeIn: config.bargeIn,
    confirmDelegation: config.confirmDelegation,
  });

  const developmentOnly = (handler) => async (payload, context) =>
    isDevelopment
      ? handler(payload, context)
      : { success: false, displayText: tr("conversation:common.forbidden") };

  const idOf = (win) => (win && !win.isDestroyed() ? win.webContents.id : null);

  registerConversationIpc({
    ipcMain,
    getWindowIds: () => ({
      main: idOf(windowManager?.mainWindow),
      "control-panel": idOf(windowManager?.controlPanelWindow),
      session: idOf(conversationWindows.windows.session),
      companion: idOf(conversationWindows.windows.companion),
    }),
    isAllowedUrl: (url) => isAllowedAppNavigation(url, appUrl),
    getConfig: () => config,
    handlers: {
      "os.openApp": os.openApp,
      "os.focusWindow": os.focusWindow,
      "os.setDisplays": os.setDisplays,
      "os.runPowershell": os.runPowershell,
      "session.getState": async () => ({ success: true, data: sessionController.getState() }),
      "session.stop": async () => ({
        success: true,
        data: { state: await sessionController.stop() },
      }),
      "session.begin": async (payload) => {
        if (!sessionController.isActive()) {
          return { success: false, displayText: tr("conversation:common.unavailable") };
        }
        const result = await runtime.begin({ llm: payload.llm, tools: payload.tools });
        if (result.success) {
          for (const text of pendingAnnouncements.splice(0)) runtime.send("say", { text });
        }
        return result;
      },
      "session.toolResult": async (payload) => runtime.toolResult(payload),
      "session.interrupt": async () => ({ success: runtime.send("interrupt") }),
      "workers.delegate": (payload, context) => workers.delegate(payload, context),
      "workers.list": async () => workers.list(),
      "workers.cancel": async (payload) => workers.cancel(payload.taskId),
      "config.get": async () => ({ success: true, data: publicConfig() }),
      "config.setHotkey": async (payload) => {
        const hotkey = String(payload.hotkey || "").trim();
        const previous = config.hotkey;
        const result = await conversationHotkey.register(hotkey);
        if (!result.success) {
          if (result.errors.includes("registration-failed") && previous && previous !== hotkey) {
            await conversationHotkey.register(previous);
          }
          return {
            success: false,
            errors: describeCodes(result.errors, HOTKEY_ERROR_KEYS),
            warnings: describeCodes(result.warnings, HOTKEY_WARNING_KEYS),
          };
        }
        saveConfig(userDataDir, { hotkey });
        config = loadConfig(userDataDir);
        return {
          success: true,
          data: publicConfig(),
          warnings: describeCodes(result.warnings, HOTKEY_WARNING_KEYS),
        };
      },
      "session.debugEvent": developmentOnly(async (payload) => ({
        success: true,
        data: { state: await sessionController.dispatch(String(payload.event || "")) },
      })),
      "session.debugProbe": developmentOnly(async () => ({
        success: true,
        data: {
          ...sessionController.getState(),
          active: sessionController.isActive(),
          blockDictation: !!windowManager?._shouldBlockDictationInput?.("dictation"),
          blockAssistant: !!windowManager?._shouldBlockDictationInput?.("assistant"),
          runtimeRunning: runtime.isRunning(),
          hotkeySlot: windowManager?.hotkeyManager?.getSlotHotkeys?.("conversation") || [],
        },
      })),
    },
    tr,
    debugLogger,
  });

  debugLogger?.info(
    "Conversation mode installed",
    { enabled: config.enabled, toolsInChat: config.toolsInChat, hotkey: config.hotkey },
    "conversation"
  );

  installed = {
    getConfig: () => config,
    sessionController,
    conversationWindows,
  };
  return installed;
}

module.exports = { install };
