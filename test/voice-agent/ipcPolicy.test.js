const test = require("node:test");
const assert = require("node:assert/strict");

const { isOpAllowed, resolveWindowKind } = require("../../src/voice-agent/shared/ipcPolicy");
const { isAllowedAppNavigation } = require("../../src/helpers/navigationGuard");

const APP_URL = "http://localhost:5183/";
const isAllowedUrl = (url) => isAllowedAppNavigation(url, APP_URL);
const windowIds = { main: 1, "control-panel": 2, session: 3, companion: 4 };

test("known app windows resolve to their kind", () => {
  const base = { isMainFrame: true, windowIds, isAllowedUrl };
  assert.equal(resolveWindowKind({ ...base, senderId: 1, senderUrl: APP_URL }), "main");
  assert.equal(
    resolveWindowKind({ ...base, senderId: 2, senderUrl: `${APP_URL}?panel=true` }),
    "control-panel"
  );
  assert.equal(
    resolveWindowKind({ ...base, senderId: 3, senderUrl: `${APP_URL}?conversation-session=true` }),
    "session"
  );
});

test("a remote page, a foreign file URL, a subframe or an unknown webContents is rejected", () => {
  const base = { isMainFrame: true, windowIds, isAllowedUrl };
  assert.equal(
    resolveWindowKind({ ...base, senderId: 3, senderUrl: "https://evil.example/" }),
    null
  );
  assert.equal(
    resolveWindowKind({
      ...base,
      senderId: 3,
      senderUrl: "file:///C:/Users/x/Downloads/page.html",
    }),
    null
  );
  assert.equal(
    resolveWindowKind({ ...base, senderId: 3, isMainFrame: false, senderUrl: APP_URL }),
    null
  );
  assert.equal(resolveWindowKind({ ...base, senderId: 99, senderUrl: APP_URL }), null);
  assert.equal(resolveWindowKind({ ...base, senderId: null, senderUrl: APP_URL }), null);
});

test("the session window may use the OS ops", () => {
  for (const op of ["os.openApp", "os.focusWindow", "os.setDisplays", "os.runPowershell"]) {
    assert.equal(isOpAllowed({ windowKind: "session", op, toolsInChat: false }), true);
  }
});

test("chat windows need the toolsInChat flag", () => {
  for (const windowKind of ["main", "control-panel"]) {
    assert.equal(isOpAllowed({ windowKind, op: "os.openApp", toolsInChat: false }), false);
    assert.equal(isOpAllowed({ windowKind, op: "os.openApp", toolsInChat: true }), true);
  }
});

test("the companion overlay and unknown windows get no OS op", () => {
  assert.equal(
    isOpAllowed({ windowKind: "companion", op: "os.runPowershell", toolsInChat: true }),
    false
  );
  assert.equal(isOpAllowed({ windowKind: "pill", op: "os.openApp", toolsInChat: true }), false);
  assert.equal(isOpAllowed({ windowKind: null, op: "os.openApp", toolsInChat: true }), false);
});

test("unknown ops and prototype keys are refused", () => {
  assert.equal(isOpAllowed({ windowKind: "session", op: "os.format", toolsInChat: true }), false);
  assert.equal(isOpAllowed({ windowKind: "session", op: "constructor", toolsInChat: true }), false);
  assert.equal(isOpAllowed({ windowKind: "session", op: "__proto__", toolsInChat: true }), false);
});

test("the companion overlay may only read state and stop the session", () => {
  assert.equal(
    isOpAllowed({ windowKind: "companion", op: "session.getState", toolsInChat: false }),
    true
  );
  assert.equal(
    isOpAllowed({ windowKind: "companion", op: "session.stop", toolsInChat: false }),
    true
  );
  for (const op of ["config.setHotkey", "config.get", "session.debugEvent", "os.openApp"]) {
    assert.equal(isOpAllowed({ windowKind: "companion", op, toolsInChat: true }), false, op);
  }
});

test("session and configuration ops are never available to upstream chat windows", () => {
  for (const windowKind of ["main", "control-panel"]) {
    for (const op of ["session.stop", "config.setHotkey", "session.debugProbe"]) {
      assert.equal(
        isOpAllowed({ windowKind, op, toolsInChat: true }),
        false,
        `${windowKind} ${op}`
      );
    }
  }
});

test("only the session window can begin a session or answer a tool call", () => {
  for (const op of ["session.begin", "session.toolResult"]) {
    assert.equal(isOpAllowed({ windowKind: "session", op, toolsInChat: false }), true, op);
    for (const windowKind of ["companion", "main", "control-panel"]) {
      assert.equal(
        isOpAllowed({ windowKind, op, toolsInChat: true }),
        false,
        `${windowKind} ${op}`
      );
    }
  }
  assert.equal(
    isOpAllowed({ windowKind: "companion", op: "session.interrupt", toolsInChat: false }),
    true
  );
});

test("background workers are reachable from the voice session only", () => {
  for (const op of ["workers.delegate", "workers.list", "workers.cancel"]) {
    assert.equal(isOpAllowed({ windowKind: "session", op, toolsInChat: false }), true, op);
    for (const windowKind of ["companion", "main", "control-panel"]) {
      assert.equal(
        isOpAllowed({ windowKind, op, toolsInChat: true }),
        false,
        `${windowKind} ${op}`
      );
    }
  }
});
