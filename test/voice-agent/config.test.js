const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadConfig, saveConfig, DEFAULTS } = require("../../src/voice-agent/main/config");

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-conversation-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults keep the feature off and use Control+Alt+Space", (t) => {
  const config = loadConfig(tempUserData(t), {});
  assert.equal(config.enabled, false);
  assert.equal(config.toolsInChat, false);
  assert.equal(config.hotkey, "Control+Alt+Space");
  assert.equal(config.conversationModel, "qwen3.5-4b-q4_k_m");
  assert.equal(config.confirmDelegation, true);
});

test("invalid values in the file fall back to defaults", (t) => {
  const dir = tempUserData(t);
  fs.mkdirSync(path.join(dir, "voice-agent"));
  fs.writeFileSync(
    path.join(dir, "voice-agent", "config.json"),
    JSON.stringify({ enabled: "yes", bargeIn: "shout", sttLanguage: "de", hotkey: "" })
  );
  const config = loadConfig(dir, {});
  assert.equal(config.enabled, DEFAULTS.enabled);
  assert.equal(config.bargeIn, "mute");
  assert.equal(config.sttLanguage, "auto");
  assert.equal(config.hotkey, "Control+Alt+Space");
});

test("environment flags override the file", (t) => {
  const dir = tempUserData(t);
  saveConfig(dir, { enabled: false, toolsInChat: false });
  const config = loadConfig(dir, {
    OW_CONVERSATION_ENABLED: "1",
    OW_CONVERSATION_TOOLS_IN_CHAT: "true",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.toolsInChat, true);
});

test("saveConfig merges and persists sanitized values", (t) => {
  const dir = tempUserData(t);
  saveConfig(dir, { hotkey: "Alt+F9" });
  saveConfig(dir, { sttLanguage: "fr" });
  const config = loadConfig(dir, {});
  assert.equal(config.hotkey, "Alt+F9");
  assert.equal(config.sttLanguage, "fr");
});
