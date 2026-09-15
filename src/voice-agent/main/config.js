// Conversation mode configuration, owned by the main process.
//
// Stored in <userData>/voice-agent/config.json. Nothing here is writable from a renderer: flags
// that widen what a renderer may do (toolsInChat) come only from this file or the environment.
const fs = require("fs");
const path = require("path");
const VOICE_CATALOG = require("../shared/voiceCatalog.json");

const VOICE_INSTRUCTIONS_MAX_CHARS = 500;

const DEFAULTS = Object.freeze({
  enabled: false,
  toolsInChat: false,
  hotkey: "Control+Alt+Space",
  conversationModel: "qwen3.5-4b-q4_k_m",
  sttLanguage: "auto",
  bargeIn: "mute",
  // Empty: the microphone the app resolved for dictation. A label here wins, for a machine
  // where that resolution is wrong.
  inputDevice: "",
  // Loudness floor for speech detection (0..1). Pipecat's 0.6 ignores a quiet headset.
  vadMinVolume: 0.4,
  // A pause to think is not the end of a turn: the model says whether the user has finished
  // (sidecar turn_completion.py). Off: the reply starts after a fixed silence, as before.
  waitForCompleteTurns: true,
  confirmDelegation: true,
  // Background workers: project folders (a folder, or "parent/*" for its sub-folders), the notes
  // vault they must never touch, the Claude Code executable (empty: ~/.local/bin/claude) and a
  // spending cap per task.
  workerProjectRoots: Object.freeze([]),
  vaultRoot: "",
  vaultExcluded: Object.freeze([]),
  claudePath: "",
  workerBudgetUsd: 2,
  // The voice that reads the replies: a Kokoro voice on this computer, or an OpenAI voice online
  // (with an optional reading style). Each provider keeps its own last choice.
  voice: Object.freeze({
    provider: "kokoro",
    kokoro: Object.freeze({ voice: "ff_siwis", speed: 1 }),
    openai: Object.freeze({ voice: "coral", instructions: "" }),
  }),
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

/** A saved voice, checked against the voices that exist; anything else falls back to the default. */
function sanitizeVoice(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const kokoro = source.kokoro && typeof source.kokoro === "object" ? source.kokoro : {};
  const openai = source.openai && typeof source.openai === "object" ? source.openai : {};
  const out = {
    provider: source.provider === "openai" ? "openai" : "kokoro",
    kokoro: { ...DEFAULTS.voice.kokoro },
    openai: { ...DEFAULTS.voice.openai },
  };
  if (VOICE_CATALOG.kokoro.includes(kokoro.voice)) out.kokoro.voice = kokoro.voice;
  if (typeof kokoro.speed === "number" && Number.isFinite(kokoro.speed)) {
    out.kokoro.speed = Math.round(Math.min(2, Math.max(0.5, kokoro.speed)) * 100) / 100;
  }
  if (VOICE_CATALOG.openai.includes(openai.voice)) out.openai.voice = openai.voice;
  if (typeof openai.instructions === "string") {
    out.openai.instructions = openai.instructions.trim().slice(0, VOICE_INSTRUCTIONS_MAX_CHARS);
  }
  return out;
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
  if (typeof raw.inputDevice === "string") out.inputDevice = raw.inputDevice.trim().slice(0, 200);
  if (typeof raw.vadMinVolume === "number" && Number.isFinite(raw.vadMinVolume)) {
    out.vadMinVolume = Math.min(0.9, Math.max(0.1, raw.vadMinVolume));
  }
  if (typeof raw.waitForCompleteTurns === "boolean") {
    out.waitForCompleteTurns = raw.waitForCompleteTurns;
  }
  if (typeof raw.confirmDelegation === "boolean") out.confirmDelegation = raw.confirmDelegation;
  if (Array.isArray(raw.workerProjectRoots)) {
    out.workerProjectRoots = raw.workerProjectRoots
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => root.trim())
      .slice(0, 20);
  }
  if (typeof raw.vaultRoot === "string") out.vaultRoot = raw.vaultRoot.trim();
  if (Array.isArray(raw.vaultExcluded)) {
    out.vaultExcluded = raw.vaultExcluded
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => name.trim())
      .slice(0, 40);
  }
  if (typeof raw.claudePath === "string") out.claudePath = raw.claudePath.trim();
  if (
    typeof raw.workerBudgetUsd === "number" &&
    raw.workerBudgetUsd > 0 &&
    raw.workerBudgetUsd <= 20
  ) {
    out.workerBudgetUsd = raw.workerBudgetUsd;
  }
  out.voice = sanitizeVoice(raw.voice);
  return out;
}

function loadConfig(userDataDir, env = process.env) {
  const config = sanitize(readConfigFile(userDataDir));
  const enabledEnv = parseBooleanEnv(env.OW_CONVERSATION_ENABLED);
  const toolsInChatEnv = parseBooleanEnv(env.OW_CONVERSATION_TOOLS_IN_CHAT);
  if (enabledEnv !== undefined) config.enabled = enabledEnv;
  if (toolsInChatEnv !== undefined) config.toolsInChat = toolsInChatEnv;
  if (env.OW_CONVERSATION_WORKER_ROOTS) {
    config.workerProjectRoots = sanitize({
      workerProjectRoots: env.OW_CONVERSATION_WORKER_ROOTS.split(path.delimiter),
    }).workerProjectRoots;
  }
  if (env.OW_CONVERSATION_VAULT_ROOT) config.vaultRoot = env.OW_CONVERSATION_VAULT_ROOT.trim();
  if (env.OW_CONVERSATION_INPUT_DEVICE) {
    config.inputDevice = env.OW_CONVERSATION_INPUT_DEVICE.trim().slice(0, 200);
  }
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

module.exports = { loadConfig, saveConfig, sanitize, sanitizeVoice, DEFAULTS, configPath };
