/**
 * The voice that reads a session's replies: the choices the session window's picker shows, and what
 * the window sends when a session starts. Pure logic.
 *
 * Kokoro runs on this computer: one French voice (Siwis) and 53 voices of other languages, which read
 * French with their own accent. OpenAI's speech endpoint (gpt-4o-mini-tts) reads the reply text
 * online, with the key stored for OpenAI in the app's settings. The voice ids are in
 * voiceCatalog.json, which the main process checks a saved choice against.
 */
import { keyOwner, PROVIDER_ENDPOINTS } from "./llmEndpoint.mjs";

/** A Kokoro id starts with a language letter and a gender letter: af_heart is American, female. */
export const KOKORO_LANGUAGES = Object.freeze([
  ["f", "fr"],
  ["a", "enUS"],
  ["b", "enGB"],
  ["e", "es"],
  ["i", "it"],
  ["p", "ptBR"],
  ["h", "hi"],
  ["j", "ja"],
  ["z", "zh"],
]);

export const OPENAI_SPEECH = Object.freeze({ label: "OpenAI", model: "gpt-4o-mini-tts" });

/** Same default as config.js in the main process (a test keeps them equal). */
export const DEFAULT_VOICE = Object.freeze({
  provider: "kokoro",
  kokoro: Object.freeze({ voice: "ff_siwis", speed: 1 }),
  openai: Object.freeze({ voice: "coral", instructions: "" }),
});

export function kokoroVoiceInfo(id) {
  const text = String(id ?? "");
  const [tag = "", name = ""] = text.split("_");
  const language = KOKORO_LANGUAGES.find(([letter]) => letter === tag[0])?.[1] ?? "other";
  return {
    id: text,
    language,
    gender: tag[1] === "m" ? "male" : "female",
    name: name ? name[0].toUpperCase() + name.slice(1) : text,
  };
}

/** Voices grouped by language, French first, each group sorted by name. */
export function kokoroVoiceGroups(ids) {
  const infos = (Array.isArray(ids) ? ids : []).map(kokoroVoiceInfo);
  return KOKORO_LANGUAGES.map(([, language]) => ({
    language,
    voices: infos
      .filter((info) => info.language === language)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.voices.length > 0);
}

/** Whether the key saved for OpenAI in the app's settings can be used: found, missing, mismatch. */
export function openaiKeyStatus(settings) {
  const key = String(settings?.[PROVIDER_ENDPOINTS.openai.keyField] ?? "").trim();
  if (!key) return "missing";
  const owner = keyOwner(key);
  return owner && owner !== "openai" ? "mismatch" : "found";
}

/**
 * What the window sends for the voice when a session starts or a sample is asked for. The main
 * process owns the choice (config.json); the window only adds the key an online voice needs, or the
 * reason it has none.
 */
export function sessionVoiceRequest(voice, settings) {
  if (voice?.provider !== "openai") return { provider: "kokoro" };
  const status = openaiKeyStatus(settings);
  if (status === "missing") return { provider: "openai", error: "voice-missing-api-key" };
  if (status === "mismatch") return { provider: "openai", error: "voice-key-mismatch" };
  return {
    provider: "openai",
    apiKey: String(settings[PROVIDER_ENDPOINTS.openai.keyField]).trim(),
  };
}

export function isOnlineVoice(voice) {
  return voice?.provider === "openai";
}

/** The voice line of the settings panel: its name and where it runs. */
export function describeVoice(voice) {
  if (voice?.provider === "openai") {
    return { name: String(voice.openai?.voice ?? ""), where: OPENAI_SPEECH.label };
  }
  return {
    name: kokoroVoiceInfo(voice?.kokoro?.voice ?? DEFAULT_VOICE.kokoro.voice).name,
    where: "local",
  };
}
