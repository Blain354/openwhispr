// Orchestrates one voice session between the session window, the loopback WebSocket, the Python
// sidecar and the shared local model server.
//
// The renderer resolves which LLM the session uses (OpenWhispr keeps those settings in renderer
// storage) and which tools it offers; the main process starts everything, owns the secrets, and
// routes what the sidecar sends: state changes to the session state machine, transcripts and
// replies to both windows, tool calls to the session window only.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createConversationWsServer } = require("./wsServer");
const { createSidecarManager, READY_TIMEOUT_MS } = require("./sidecarManager");
const { sanitizeVoice } = require("./config");
const { redact } = require("./redact");
const { projectCandidates } = require("../shared/workerArgv");

const HELLO_TIMEOUT_MS = 30_000;
const WHISPER_MODEL = "deepdml/faster-whisper-large-v3-turbo-ct2";
const STATE_EVENTS = new Set([
  "user.started",
  "user.stopped",
  "bot.started",
  "bot.stopped",
  "turn.idle",
  "confirm.requested",
  "confirm.resolved",
]);

const SYSTEM_PROMPT = [
  "Tu es l'assistant vocal d'OpenWhispr sur l'ordinateur Windows de l'utilisateur.",
  "Réponds dans la langue de l'utilisateur, en une à trois phrases courtes et naturelles à l'oral.",
  "Pas de markdown, pas de listes, pas d'émojis ; ne lis jamais d'URL, de chemin de fichier ou de code à voix haute.",
  "Utilise les outils quand l'utilisateur demande une action sur son ordinateur ou dans ses notes.",
  "Une demande qui porte sur un projet, du code, des commits ou des fichiers passe par delegate_task, jamais par une réponse de mémoire.",
  "Les actions sensibles demandent une confirmation à l'écran : dans ce cas dis simplement « Confirme à l'écran ».",
  "N'affirme jamais qu'une action a réussi si le résultat de l'outil ne le dit pas.",
].join(" ");

// Same budget as the sidecar's HOTWORDS_MAX_CHARS; faster-whisper keeps the first 223 tokens.
const HOTWORDS_MAX_CHARS = 1200;

/**
 * The prompt of one session: the fixed rules, then what the model cannot know by itself.
 * A local model has no clock; without this it could not answer « quel jour sommes-nous ».
 */
function systemPromptFor(now = new Date()) {
  const today = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short" }).format(
    now
  );
  return `${SYSTEM_PROMPT} Nous sommes le ${today}, heure locale de l'utilisateur, au début de cette session.`;
}

/**
 * Proper nouns Whisper should hear correctly: the app, the configured project folders, then the
 * user's own dictionary — the words dictation is already biased with. Whisper transcribed
 * "blain-infra" as "Blin Infra" without them. The string is bounded and never cuts a word.
 */
function hotwordsFor(config, listDirs, dictionary = []) {
  const names = projectCandidates(config.workerProjectRoots || [], listDirs)
    .map((c) => c.name)
    .slice(0, 11);
  const candidates = [
    "OpenWhispr",
    ...names,
    ...dictionary.map((word) => String(word ?? "").trim()),
  ];
  const words = [];
  let length = 0;
  for (const word of new Set(candidates)) {
    if (!word) continue;
    const added = (words.length ? 2 : 0) + word.length;
    if (length + added > HOTWORDS_MAX_CHARS) break;
    words.push(word);
    length += added;
  }
  return words.join(", ");
}

function dictionaryWords(getDictionary, debugLogger) {
  try {
    const words = getDictionary();
    return Array.isArray(words) ? words : [];
  } catch (error) {
    // A session without the dictionary still works; it only hears the user's names less well.
    debugLogger?.warn?.(
      "Custom dictionary unavailable for the voice session",
      { error: error.message },
      "conversation"
    );
    return [];
  }
}

function listProjectDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function kokoroPaths() {
  const dir = path.join(os.homedir(), ".cache", "openwhispr", "conversation", "kokoro");
  return {
    modelPath: path.join(dir, "kokoro-v1.0.onnx"),
    voicesPath: path.join(dir, "voices-v1.0.bin"),
  };
}

/**
 * Pure: what to do with one decoded sidecar message.
 * @returns {{ kind: "hello" | "ready" | "dispatch" | "relay" | "tool" | "fatal" | "ignore", event?: string }}
 */
function routeSidecarMessage(message, relayed) {
  switch (message.type) {
    case "hello":
      return { kind: "hello" };
    case "ready":
      return { kind: "ready" };
    case "state":
      return STATE_EVENTS.has(message.data?.event)
        ? { kind: "dispatch", event: message.data.event }
        : { kind: "ignore" };
    case "tool.call":
    case "tool.cancel":
      return { kind: "tool" };
    case "error":
      return message.data?.fatal ? { kind: "fatal" } : { kind: "relay" };
    default:
      return relayed.includes(message.type) ? { kind: "relay" } : { kind: "ignore" };
  }
}

/**
 * Pure: the LLM endpoint the sidecar talks to, from the session window's choice. Only a local model
 * or a custom OpenAI-compatible provider are supported in v1. Upstream keeps BYOK keys in renderer
 * settings, so the key arrives with the request; it reaches the sidecar only through its
 * environment, never over the WebSocket, and is never logged.
 */
const { remoteBaseProblem } = require("../shared/llmPolicy");

// Reasons a session window may give for not having a usable model (shared/llmEndpoint.mjs).
const LLM_REQUEST_ERRORS = new Set([
  "unsupported-provider",
  "missing-api-key",
  "missing-model",
  "missing-base-url",
  "invalid-base-url",
  "insecure-base-url",
  "key-mismatch",
]);

/**
 * The window only asks: the main process decides where a prompt and a key may go. HTTPS anywhere,
 * plain HTTP only inside the user's own network (shared/llmPolicy.js).
 */
function resolveLlmEndpoint(request) {
  if (request?.mode === "local") return { kind: "local" };
  if (request?.mode === "invalid") {
    const error = LLM_REQUEST_ERRORS.has(request.error) ? request.error : "unsupported-provider";
    return { kind: "error", error };
  }
  if (request?.mode !== "remote") return { kind: "error", error: "unsupported-provider" };
  const problem = remoteBaseProblem(request.baseURL);
  if (problem) return { kind: "error", error: problem };
  return {
    kind: "remote",
    baseURL: new URL(String(request.baseURL)).href.replace(/\/$/, ""),
    model: String(request.model || ""),
    apiKey: typeof request.apiKey === "string" ? request.apiKey : "",
  };
}

// Development only: OW_CONVERSATION_WAV_INPUT plays recorded turns instead of the microphone.
function harnessArgs(env = process.env) {
  if (env.NODE_ENV !== "development" || !env.OW_CONVERSATION_WAV_INPUT) return [];
  return ["--wav-input", env.OW_CONVERSATION_WAV_INPUT];
}

// OpenAI's speech endpoint, with the model that follows a reading style (tts-1 ignores one).
const OPENAI_SPEECH_BASE_URL = "https://api.openai.com/v1";
const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const VOICE_REQUEST_ERRORS = new Set(["voice-missing-api-key", "voice-key-mismatch"]);

/** Kokoro reads in the session's language: English when speech is set to English, else French. */
function kokoroLanguageFor(sttLanguage) {
  return sttLanguage === "en" ? "en-us" : "fr-fr";
}

/**
 * The voice of a session: the choice saved in config.json (owned by this process) plus the key the
 * window found for an online voice, or why it found none.
 */
function sessionVoiceFor(config, request) {
  const voice = sanitizeVoice(config?.voice);
  if (voice.provider === "openai") {
    if (VOICE_REQUEST_ERRORS.has(request?.error)) return { kind: "error", error: request.error };
    const apiKey = typeof request?.apiKey === "string" ? request.apiKey.trim() : "";
    if (!apiKey) return { kind: "error", error: "voice-missing-api-key" };
    return {
      kind: "remote",
      apiKey,
      tts: {
        provider: "openai",
        baseURL: OPENAI_SPEECH_BASE_URL,
        model: OPENAI_SPEECH_MODEL,
        voice: voice.openai.voice,
        instructions: voice.openai.instructions,
      },
    };
  }
  return {
    kind: "local",
    tts: {
      provider: "kokoro",
      ...kokoroPaths(),
      voice: voice.kokoro.voice,
      speed: voice.kokoro.speed,
      language: kokoroLanguageFor(config?.sttLanguage),
    },
  };
}

/** Names of the MCP tools a session window registered, from the schemas it sent. */
function mcpToolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string" && name.startsWith("mcp_"));
}

function createConversationRuntime({
  getDictionary = () => [],
  userDataDir,
  getConfig,
  sessionController,
  conversationWindows,
  getVram,
  debugLogger,
  wsServerFactory = createConversationWsServer,
  sidecarManagerFactory = createSidecarManager,
}) {
  let protocol = null;
  let ws = null;
  let sidecar = null;
  let vram = null;
  let running = false;
  let ending = false;
  // Whether the running session sends its text to an online provider.
  let sessionOnline = false;
  const waiters = new Map();

  const loadProtocol = async () => (protocol ||= await import("../shared/protocol.mjs"));

  function waitFor(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(type);
        reject(new Error(`Timed out waiting for sidecar "${type}"`));
      }, timeoutMs);
      waiters.set(type, (message) => {
        clearTimeout(timer);
        waiters.delete(type);
        resolve(message);
      });
    });
  }

  function handleRaw(raw) {
    const decoded = protocol.decodeMessage(raw, protocol.SIDECAR_MESSAGE_TYPES);
    if (!decoded.ok) {
      debugLogger?.warn("Invalid sidecar message", { error: decoded.error }, "conversation");
      return;
    }
    const message = decoded.message;
    const route = routeSidecarMessage(message, protocol.RELAYED_TO_WINDOWS);
    switch (route.kind) {
      case "hello":
      case "ready":
        waiters.get(message.type)?.(message);
        break;
      case "dispatch":
        void sessionController.dispatch(route.event);
        break;
      case "relay":
        conversationWindows.broadcast(message);
        break;
      case "tool":
        conversationWindows.sendToSession(message);
        break;
      case "fatal":
        conversationWindows.broadcast(message);
        debugLogger?.error(
          "Voice sidecar reported a fatal error",
          redact(message.data),
          "conversation"
        );
        void sessionController.dispatch("session.error");
        break;
      default:
        break;
    }
  }

  async function begin({ llm, tools, inputDevice, voice }) {
    if (running) return { success: false, displayText: "A voice session is already running." };
    const proto = await loadProtocol();
    const { selectVoiceTools, voiceToolAllowlist } = await import("../shared/voiceTools.mjs");
    const config = getConfig();
    const refuse = async (code) => {
      await sessionController.dispatch("session.error");
      return { success: false, errors: [code] };
    };
    const endpoint = resolveLlmEndpoint(llm);
    // Which model a session really calls, never its key.
    debugLogger?.info(
      "Voice session model",
      endpoint.kind === "remote"
        ? { kind: "remote", host: new URL(endpoint.baseURL).host, model: endpoint.model }
        : endpoint.kind === "local"
          ? { kind: "local", model: config.conversationModel }
          : { kind: "error", error: endpoint.error },
      "conversation"
    );
    if (endpoint.kind === "error") return refuse(endpoint.error);
    // The main process decides which tools a session offers, not the window: text that leaves the
    // machine never comes with a tool that reads the user's data.
    const speech = sessionVoiceFor(config, voice);
    debugLogger?.info(
      "Voice session voice",
      speech.kind === "error"
        ? { kind: "error", error: speech.error }
        : { kind: speech.kind, provider: speech.tts.provider, voice: speech.tts.voice },
      "conversation"
    );
    if (speech.kind === "error") return refuse(speech.error);
    const online = endpoint.kind === "remote" || speech.kind === "remote";
    const allowlist = voiceToolAllowlist(mcpToolNames(tools), {
      hasVault: !!config.vaultRoot,
      textLeavesMachine: online,
    });

    sidecar = sidecarManagerFactory({
      userDataDir,
      debugLogger,
      onExit: ({ code }) => {
        if (running && !ending) {
          debugLogger?.error("Voice sidecar exited during a session", { code }, "conversation");
          conversationWindows.broadcast({
            type: "error",
            data: { message: `sidecar exited (${code})` },
          });
          void sessionController.dispatch("session.error");
          void end();
        }
      },
    });
    if (!sidecar.isAvailable()) {
      sidecar = null;
      return refuse("sidecar-not-installed");
    }

    running = true;
    ending = false;
    sessionOnline = online;
    try {
      vram = getVram();
      let llmConfig;
      if (endpoint.kind === "local") {
        await vram.releaseWhisper();
        const model = await vram.startSessionModel(config.conversationModel);
        vram.lockModel(model, () => {
          conversationWindows.broadcast({
            type: "error",
            data: { message: "local model server changed" },
          });
          void sessionController.dispatch("session.error");
          void end();
        });
        llmConfig = { baseURL: model.baseURL, model: config.conversationModel, local: true };
      } else {
        llmConfig = { baseURL: endpoint.baseURL, model: endpoint.model, local: false };
      }

      ws = wsServerFactory({ onMessage: handleRaw, debugLogger });
      const { port, token } = await ws.start();
      const hello = waitFor("hello", HELLO_TIMEOUT_MS);
      const ready = waitFor("ready", READY_TIMEOUT_MS);
      await sidecar.start({
        port,
        token,
        llmApiKey: endpoint.apiKey || "",
        ttsApiKey: speech.apiKey || "",
        extraArgs: harnessArgs(),
      });
      await hello;
      ws.send(
        proto.encodeMessage("session.config", {
          llm: llmConfig,
          tools: selectVoiceTools(tools, allowlist),
          systemPrompt: systemPromptFor(),
          sttLanguage: config.sttLanguage,
          hotwords: hotwordsFor(
            config,
            listProjectDirs,
            dictionaryWords(getDictionary, debugLogger)
          ),
          // The model decides whether the user has finished before anything is spoken.
          waitForCompleteTurns: config.waitForCompleteTurns,
          bargeIn: config.bargeIn,
          // The microphone the app itself is using: the sidecar's own default is PyAudio's,
          // which is not always the one the user picked in OpenWhispr.
          inputDevice: config.inputDevice || inputDevice || "",
          vadMinVolume: config.vadMinVolume,
          whisperModel: WHISPER_MODEL,
          tts: speech.tts,
        })
      );
      const readyMessage = await ready;
      if (readyMessage.data?.inputDeviceStatus === "unmatched") {
        conversationWindows.broadcast({
          type: "warning",
          data: {
            code: "micNotFound",
            device: config.inputDevice || inputDevice || "",
            heard: readyMessage.data?.inputDevice || "",
          },
        });
      }
      await sessionController.dispatch("sidecar.ready");
      const vramMiB = await vram.readVramMiB();
      debugLogger?.info("Voice session ready", { ...readyMessage.data, vramMiB }, "conversation");
      return { success: true, data: { ...readyMessage.data, vramMiB } };
    } catch (error) {
      debugLogger?.error("Voice session failed to start", { error: error.message }, "conversation");
      await end();
      await sessionController.dispatch("session.error");
      return { success: false, displayText: error.message };
    }
  }

  function toolResult({ id, success, text }) {
    if (!ws || !protocol || typeof id !== "string") return { success: false };
    const sent = ws.send(
      protocol.encodeMessage(
        "tool.result",
        { success: !!success, text: String(text ?? "") },
        { id }
      )
    );
    return { success: sent };
  }

  function send(type, data = {}) {
    if (!ws || !protocol) return false;
    return ws.send(protocol.encodeMessage(type, data));
  }

  async function end() {
    if (!running || ending) return;
    ending = true;
    try {
      await sidecar?.stop({ requestShutdown: () => send("shutdown") });
    } catch {}
    try {
      await ws?.stop();
    } catch {}
    vram?.unlockModel();
    vram?.restoreWhisper();
    vram = null;
    for (const resolve of waiters.values()) resolve({ type: "cancelled", data: {} });
    waiters.clear();
    ws = null;
    sidecar = null;
    running = false;
    ending = false;
    sessionOnline = false;
  }

  // App quit cannot await: kill the sidecar tree synchronously so no python.exe outlives the app.
  function shutdownSync() {
    if (!running) return;
    ending = true;
    sidecar?.killSync();
    vram?.unlockModel();
  }

  return {
    begin,
    end,
    toolResult,
    send,
    shutdownSync,
    isRunning: () => running,
    textLeavesMachine: () => running && sessionOnline,
  };
}

module.exports = {
  createConversationRuntime,
  routeSidecarMessage,
  resolveLlmEndpoint,
  harnessArgs,
  hotwordsFor,
  mcpToolNames,
  sessionVoiceFor,
  kokoroLanguageFor,
  SYSTEM_PROMPT,
  systemPromptFor,
  WHISPER_MODEL,
};
