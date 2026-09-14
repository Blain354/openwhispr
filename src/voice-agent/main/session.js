// Conversation session lifecycle, owned by the main process.
//
// While a session is active, dictation is kept out of the way: a running dictation is cancelled
// when the session starts, the one-line upstream gate refuses new dictation presses, and a
// dictation started some other way (a click on the pill) is cancelled as soon as it reports that
// it is recording.
const { ipcMain } = require("electron");

function createSessionController({ windowManager, conversationWindows, debugLogger }) {
  let state = "idle";
  let startedAt = null;
  let machinePromise = null;
  const loadMachine = () => (machinePromise ||= import("../shared/stateMachine.mjs"));

  async function dispatch(event, extra = {}) {
    const { nextSessionState } = await loadMachine();
    const next = nextSessionState(state, event);
    if (next !== state) {
      state = next;
      conversationWindows.broadcast({ type: "state", state, event, at: Date.now(), ...extra });
    }
    return state;
  }

  const isActive = () => state !== "idle" && state !== "error";

  async function start() {
    if (isActive()) return state;
    windowManager?.sendCancelActiveDictation?.();
    windowManager?.hideDictationPanel?.();
    startedAt = Date.now();
    await dispatch("session.start");
    await conversationWindows.showSession();
    await conversationWindows.showCompanion();
    // Until the voice sidecar exists, the session is ready as soon as its windows are.
    await dispatch("sidecar.ready");
    debugLogger?.info("Conversation session started", {}, "conversation");
    return state;
  }

  async function stop() {
    if (!isActive()) return state;
    await dispatch("session.stop");
    conversationWindows.closeCompanion();
    await dispatch("session.stopped");
    startedAt = null;
    debugLogger?.info("Conversation session stopped", {}, "conversation");
    return state;
  }

  const toggle = () => (isActive() ? stop() : start());

  ipcMain.on("dictation-lifecycle-state-changed", (event, lifecycle) => {
    if (!isActive()) return;
    const dictationWindow = windowManager?.mainWindow;
    if (
      !dictationWindow ||
      dictationWindow.isDestroyed() ||
      event.sender !== dictationWindow.webContents
    ) {
      return;
    }
    if (lifecycle === "preparing" || lifecycle === "recording") {
      debugLogger?.info(
        "Dictation started during a conversation session; cancelling",
        { lifecycle },
        "conversation"
      );
      windowManager.sendCancelActiveDictation?.();
    }
  });

  return {
    start,
    stop,
    toggle,
    dispatch,
    isActive,
    getState: () => ({ state, startedAt }),
  };
}

module.exports = { createSessionController };
