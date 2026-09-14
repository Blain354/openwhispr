// Conversation mode configuration, owned by the main process.
//
// Stored in <userData>/voice-agent/config.json. Nothing here is writable from a renderer: flags
// that widen what a renderer may do (toolsInChat) come only from this file or the environment.
const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  enabled: false,
  toolsInChat: false,
  hotkey: "Control+Alt+Space",
  conversationModel: "qwen3.5-4b-q4_k_m",
  sttLanguage: "auto",
  bargeIn: "mute",
  confirmDelegation: true,
});

function parseBooleanEnv(value) {
  if (value === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function configPath(userDataDir) {
  return path.join(userDataDir, "voice-agent", "config.json");
}

function readConfigFile(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(userDataDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.toolsInChat === "boolean") out.toolsInChat = raw.toolsInChat;
  if (typeof raw.hotkey === "string" && raw.hotkey.trim()) out.hotkey = raw.hotkey.trim();
  if (typeof raw.conversationModel === "string" && raw.conversationModel.trim()) {
    out.conversationModel = raw.conversationModel.trim();
  }
  if (raw.sttLanguage === "auto" || raw.sttLanguage === "fr" || raw.sttLanguage === "en") {
    out.sttLanguage = raw.sttLanguage;
  }
  if (raw.bargeIn === "mute" || raw.bargeIn === "voice") out.bargeIn = raw.bargeIn;
  if (typeof raw.confirmDelegation === "boolean") out.confirmDelegation = raw.confirmDelegation;
  return out;
}

function loadConfig(userDataDir, env = process.env) {
  const config = sanitize(readConfigFile(userDataDir));
  const enabledEnv = parseBooleanEnv(env.OW_CONVERSATION_ENABLED);
  const toolsInChatEnv = parseBooleanEnv(env.OW_CONVERSATION_TOOLS_IN_CHAT);
  if (enabledEnv !== undefined) config.enabled = enabledEnv;
  if (toolsInChatEnv !== undefined) config.toolsInChat = toolsInChatEnv;
  return config;
}

function saveConfig(userDataDir, patch) {
  const next = sanitize({ ...readConfigFile(userDataDir), ...patch });
  const file = configPath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { loadConfig, saveConfig, sanitize, DEFAULTS, configPath };
