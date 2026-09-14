import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatMessages } from "../../components/chat/ChatMessages";
import type { Message } from "../../components/chat/types";
import { useChatPersistence } from "../../components/chat/useChatPersistence";
import { getSettings } from "../../stores/settingsStore";
import { sessionTitle, shouldPersistVoiceSession } from "../shared/voiceMetadata.mjs";
import { ensureConversationBundles } from "./i18n";
import { invokeConversation, useConversationState } from "./useConversationBridge";

ensureConversationBundles();

interface PublicConfig {
  hotkey: string;
  conversationModel: string;
  sttLanguage: string;
}

const STATE_COLORS: Record<string, string> = {
  idle: "bg-zinc-600",
  starting: "bg-violet-500",
  listening: "bg-blue-500",
  user_speaking: "bg-green-500",
  thinking: "bg-amber-500",
  speaking: "bg-purple-500",
  confirming: "bg-red-500",
  stopping: "bg-zinc-500",
  error: "bg-red-600",
};

export default function SessionRoot() {
  const { t, i18n } = useTranslation();
  const state = useConversationState();
  const { createConversation } = useChatPersistence();
  const [messages] = useState<Message[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [persisted, setPersisted] = useState(true);
  const createdForSession = useRef(false);

  const active = state !== "idle" && state !== "error" && state !== "stopping";

  useEffect(() => {
    document.title = t("conversation:session.title");
  }, [t]);

  // The voice sidecar opens the microphone outside Electron's process tree; this keeps upstream's
  // meeting detection from reading it as a meeting.
  useEffect(() => {
    window.electronAPI?.micWarmHoldChanged?.(true);
    return () => window.electronAPI?.micWarmHoldChanged?.(false);
  }, []);

  useEffect(() => {
    void invokeConversation<PublicConfig>("config.get").then((result) => {
      if (result.success && result.data) {
        setConfig(result.data);
        setHotkeyDraft(result.data.hotkey);
      }
    });
  }, []);

  useEffect(() => {
    if (!active) {
      createdForSession.current = false;
      return;
    }
    if (createdForSession.current) return;
    createdForSession.current = true;
    const settings = getSettings() as unknown as {
      isSignedIn?: boolean;
      cloudBackupEnabled?: boolean;
    };
    const allowed = shouldPersistVoiceSession({
      isSignedIn: !!settings.isSignedIn,
      cloudBackupEnabled: !!settings.cloudBackupEnabled,
      cloudConsent: false,
    });
    setPersisted(allowed);
    if (allowed) {
      void createConversation(sessionTitle(new Date(), i18n.language)).catch(() => {});
    }
  }, [active, createConversation, i18n.language]);

  const saveHotkey = async () => {
    const result = await invokeConversation<PublicConfig>("config.setHotkey", {
      hotkey: hotkeyDraft,
    });
    if (result.success && result.data) {
      setConfig(result.data);
      setFeedback({
        ok: true,
        lines: [t("conversation:session.settings.saved"), ...(result.warnings || [])],
      });
    } else {
      setFeedback({
        ok: false,
        lines: result.errors?.length ? result.errors : [result.displayText || "Error"],
      });
    }
  };

  return (
    <div className="flex h-screen flex-col bg-[#1c1c2e] text-zinc-100">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <span
          className={`h-3 w-3 rounded-full ${STATE_COLORS[state] || STATE_COLORS.idle}`}
          aria-hidden="true"
        />
        <div className="flex-1">
          <div role="heading" aria-level={1} className="text-sm font-semibold">
            {t("conversation:session.title")}
          </div>
          <p className="text-xs text-zinc-400" data-testid="conversation-state">
            {t(`conversation:companion.states.${state}`)}
          </p>
        </div>
        {active && (
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
            onClick={() => void invokeConversation("session.stop")}
          >
            {t("conversation:session.stop")}
          </button>
        )}
      </header>

      {!persisted && (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {t("conversation:session.notPersisted")}
        </p>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        <ChatMessages
          messages={messages}
          emptyState={
            <div className="px-6 py-10 text-center text-sm text-zinc-400">
              <p>{t("conversation:session.emptyHint")}</p>
              {config?.hotkey && (
                <p className="mt-2 text-xs">
                  {t("conversation:session.hotkeyHint", { hotkey: config.hotkey })}
                </p>
              )}
            </div>
          }
        />
      </main>

      <details className="border-t border-white/10 px-4 py-3 text-xs">
        <summary className="cursor-pointer text-zinc-300">
          {t("conversation:session.settings.title")}
        </summary>
        <label className="mt-3 block text-zinc-400" htmlFor="conversation-hotkey">
          {t("conversation:session.settings.hotkey")}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="conversation-hotkey"
            className="flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-zinc-100"
            value={hotkeyDraft}
            onChange={(event) => setHotkeyDraft(event.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500"
            onClick={() => void saveHotkey()}
          >
            {t("conversation:session.settings.save")}
          </button>
        </div>
        {feedback && (
          <ul className={`mt-2 space-y-1 ${feedback.ok ? "text-green-300" : "text-red-300"}`}>
            {feedback.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {config && (
          <dl className="mt-3 grid grid-cols-2 gap-1 text-zinc-400">
            <dt>{t("conversation:session.settings.model")}</dt>
            <dd className="text-zinc-200">{config.conversationModel}</dd>
            <dt>{t("conversation:session.settings.language")}</dt>
            <dd className="text-zinc-200">{config.sttLanguage}</dd>
          </dl>
        )}
      </details>
    </div>
  );
}
