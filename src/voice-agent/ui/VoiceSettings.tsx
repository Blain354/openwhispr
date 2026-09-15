import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSettings, initializeSettings } from "../../stores/settingsStore";
import catalog from "../shared/voiceCatalog.json";
import {
  kokoroVoiceGroups,
  kokoroVoiceInfo,
  openaiKeyStatus,
  sessionVoiceRequest,
} from "../shared/voiceChoice.mjs";
import { invokeConversation } from "./useConversationBridge";

export interface VoiceConfig {
  provider: "kokoro" | "openai";
  kokoro: { voice: string; speed: number };
  openai: { voice: string; instructions: string };
}

type Provider = VoiceConfig["provider"];
type KeyStatus = "found" | "missing" | "mismatch";

const SPEED_MIN = 0.8;
const SPEED_MAX = 1.3;
const SPEED_STEP = 0.05;
const STYLE_MAX_CHARS = 500;

const KEY_STATUS_KEYS: Record<KeyStatus, string> = {
  found: "conversation.voice.keyFound",
  missing: "conversation.voice.keyMissing",
  mismatch: "conversation.voice.keyMismatch",
};

interface VoiceSettingsProps {
  voice: VoiceConfig;
  sttLanguage: string;
  sessionActive: boolean;
  onSaved: (config: unknown) => void;
}

/** The app's settings, provider keys included once initializeSettings() has run. */
const appSettings = () => getSettings() as unknown as Record<string, unknown>;

/**
 * The voice picker of the session window: Kokoro voices on this computer, or OpenAI voices online,
 * each with a sample to listen to. A choice is saved at once and read from the next session on.
 */
export default function VoiceSettings({
  voice,
  sttLanguage,
  sessionActive,
  onSaved,
}: VoiceSettingsProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Provider>(voice.provider);
  const [language, setLanguage] = useState(() => kokoroVoiceInfo(voice.kokoro.voice).language);
  const [speed, setSpeed] = useState(voice.kokoro.speed);
  const [style, setStyle] = useState(voice.openai.instructions);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const samples = useRef(new Map<string, string>());
  const groups = useMemo(() => kokoroVoiceGroups(catalog.kokoro), []);
  const readsEnglish = sttLanguage === "en";

  useEffect(() => {
    void initializeSettings()
      .catch(() => {})
      .then(() => setKeyStatus(openaiKeyStatus(appSettings()) as KeyStatus));
  }, []);

  useEffect(() => () => audioRef.current?.pause(), []);

  const withChoice = (provider: Provider, id: string): VoiceConfig =>
    provider === "kokoro"
      ? { ...voice, provider, kokoro: { voice: id, speed } }
      : { ...voice, provider, openai: { voice: id, instructions: style.trim() } };

  const save = async (next: VoiceConfig) => {
    const result = await invokeConversation("config.setVoice", { voice: next });
    if (result.success && result.data) {
      onSaved(result.data);
      setMessage({
        ok: true,
        text: sessionActive
          ? t("conversation.voice.savedNextSession")
          : t("conversation.voice.saved"),
      });
    } else {
      setMessage({
        ok: false,
        text: result.displayText || t("conversation.voice.errors.saveFailed"),
      });
    }
  };

  const play = (url: string) => {
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    void audio.play().catch(() => {});
  };

  const preview = async (provider: Provider, id: string) => {
    const candidate = withChoice(provider, id);
    const sampleKey = JSON.stringify([
      provider,
      id,
      provider === "kokoro" ? speed : style.trim(),
      sttLanguage,
    ]);
    const cached = samples.current.get(sampleKey);
    if (cached) {
      play(cached);
      return;
    }
    setPreviewing(id);
    setMessage(null);
    await initializeSettings().catch(() => {});
    const result = await invokeConversation<{ wav: string }>("voice.preview", {
      voice: candidate,
      request: sessionVoiceRequest(candidate, appSettings()),
    });
    setPreviewing(null);
    if (result.success && result.data?.wav) {
      const url = `data:audio/wav;base64,${result.data.wav}`;
      samples.current.set(sampleKey, url);
      play(url);
    } else {
      setMessage({
        ok: false,
        text: result.displayText || t("conversation.voice.errors.previewFailed", { reason: "?" }),
      });
    }
  };

  const commitSpeed = () => {
    if (speed !== voice.kokoro.speed) void save({ ...voice, kokoro: { ...voice.kokoro, speed } });
  };

  const commitStyle = () => {
    const trimmed = style.trim();
    if (trimmed !== voice.openai.instructions) {
      void save({ ...voice, openai: { ...voice.openai, instructions: trimmed } });
    }
  };

  const tabs: Array<[Provider, string]> = [
    ["kokoro", t("conversation.voice.tabs.local")],
    ["openai", t("conversation.voice.tabs.online")],
  ];
  const group = groups.find((entry) => entry.language === language) ?? groups[0];
  const nativeGroup = readsEnglish
    ? group.language === "enUS" || group.language === "enGB"
    : group.language === "fr";

  const voiceCard = (provider: Provider, id: string, name: string, detail: string) => {
    const saved = provider === "kokoro" ? voice.kokoro.voice : voice.openai.voice;
    const selected = voice.provider === provider && saved === id;
    const listen = t("conversation.voice.preview", { voice: name });
    return (
      <li
        key={id}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 ${
          selected
            ? "border-blue-500 bg-blue-500/15"
            : "border-white/10 bg-black/20 hover:border-white/25"
        }`}
      >
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-pressed={selected}
          onClick={() => void save(withChoice(provider, id))}
        >
          <span className="block truncate capitalize text-zinc-100">{name}</span>
          <span className="block truncate text-[10px] text-zinc-400">
            {selected ? t("conversation.voice.inUse") : detail}
          </span>
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-1 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          aria-label={listen}
          title={listen}
          disabled={previewing !== null || (provider === "openai" && keyStatus !== "found")}
          onClick={() => void preview(provider, id)}
        >
          {previewing === id ? "…" : "▶"}
        </button>
      </li>
    );
  };

  return (
    <section className="mt-4" aria-labelledby="conversation-voice-title">
      <h3 id="conversation-voice-title" className="text-zinc-400">
        {t("conversation.voice.title")}
      </h3>
      <div role="tablist" className="mt-2 inline-flex gap-1 rounded-full bg-black/30 p-0.5">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1 font-medium ${
              tab === id ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "kokoro" ? (
        <div className="mt-2">
          <p className="text-zinc-400">{t("conversation.voice.kokoroIntro")}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {groups.map((entry) => (
              <button
                key={entry.language}
                type="button"
                aria-pressed={entry.language === group.language}
                onClick={() => setLanguage(entry.language)}
                className={`rounded-full px-2 py-0.5 ${
                  entry.language === group.language
                    ? "bg-white/15 text-zinc-100"
                    : "text-zinc-400 ring-1 ring-white/10 hover:text-zinc-100"
                }`}
              >
                {t(`conversation.voice.languages.${entry.language}`)} · {entry.voices.length}
              </button>
            ))}
          </div>
          {!nativeGroup && (
            <p className="mt-2 text-amber-200/80">
              {readsEnglish
                ? t("conversation.voice.accentHintEnglish")
                : t("conversation.voice.accentHintFrench")}
            </p>
          )}
          <ul className="mt-2 grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
            {group.voices.map((info) =>
              voiceCard("kokoro", info.id, info.name, t(`conversation.voice.gender.${info.gender}`))
            )}
          </ul>
          <label
            className="mt-3 flex items-center gap-2 text-zinc-400"
            htmlFor="conversation-voice-speed"
          >
            <span>{t("conversation.voice.speed")}</span>
            <input
              id="conversation-voice-speed"
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              onPointerUp={commitSpeed}
              onKeyUp={commitSpeed}
              onBlur={commitSpeed}
              className="flex-1 accent-blue-500"
            />
            <span className="w-12 text-right tabular-nums text-zinc-200">×{speed.toFixed(2)}</span>
          </label>
        </div>
      ) : (
        <div className="mt-2">
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-100">
            {t("conversation.voice.onlineNotice")}
          </p>
          <p className={`mt-2 ${keyStatus === "found" ? "text-green-300" : "text-red-300"}`}>
            {keyStatus ? t(KEY_STATUS_KEYS[keyStatus]) : "…"}
          </p>
          <ul className="mt-2 grid grid-cols-3 gap-1.5">
            {catalog.openai.map((id) =>
              voiceCard("openai", id, id, t("conversation.voice.openaiDetail"))
            )}
          </ul>
          <label className="mt-3 block text-zinc-400" htmlFor="conversation-voice-style">
            {t("conversation.voice.style")}
          </label>
          <textarea
            id="conversation-voice-style"
            rows={2}
            maxLength={STYLE_MAX_CHARS}
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            onBlur={commitStyle}
            placeholder={t("conversation.voice.stylePlaceholder")}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-zinc-100"
          />
        </div>
      )}

      {message && (
        <p className={`mt-2 ${message.ok ? "text-green-300" : "text-red-300"}`}>{message.text}</p>
      )}
    </section>
  );
}
