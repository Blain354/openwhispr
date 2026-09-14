import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatMessages } from "../../components/chat/ChatMessages";
import type { Message } from "../../components/chat/types";
import { useChatPersistence } from "../../components/chat/useChatPersistence";
import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { getSettings, selectResolvedLLMConfig } from "../../stores/settingsStore";
import {
  sessionTitle,
  shouldPersistVoiceSession,
  voiceMessageMetadata,
} from "../shared/voiceMetadata.mjs";
import { ensureConversationBundles } from "./i18n";
import { createVoiceToolRegistry, executeVoiceToolCall, voiceToolSchemas } from "./toolExecutor";
import { invokeConversation, useConversationState } from "./useConversationBridge";

ensureConversationBundles();

interface PublicConfig {
  hotkey: string;
  conversationModel: string;
  sttLanguage: string;
}

interface BridgeMessage {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

interface TaskCard {
  id: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: string | null;
  summary: string | null;
  error: string | null;
}

interface ToolCallRecord {
  name: string;
  status: "executing" | "completed" | "error";
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

const BEGIN_ERROR_KEYS: Record<string, string> = {
  "sidecar-not-installed": "conversation:session.errors.sidecarNotInstalled",
  "unsupported-provider": "conversation:session.errors.unsupportedProvider",
  "invalid-base-url": "conversation:session.errors.invalidBaseUrl",
  "insecure-base-url": "conversation:session.errors.insecureBaseUrl",
};

export default function SessionRoot() {
  const { t, i18n } = useTranslation();
  const state = useConversationState();
  const { createConversation } = useChatPersistence();
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const createdForSession = useRef(false);
  const begunForSession = useRef(false);
  const conversationIdRef = useRef<number | null>(null);
  const registryRef = useRef<ToolRegistry | null>(null);
  const toolCallsRef = useRef<ToolCallRecord[]>([]);

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
    void invokeConversation<{ tasks: TaskCard[] }>("workers.list").then((result) => {
      if (result.success && Array.isArray(result.data?.tasks)) setTasks(result.data.tasks);
    });
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
    conversationIdRef.current = null;
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
      createConversation(sessionTitle(new Date(), i18n.language))
        .then((id) => {
          conversationIdRef.current = id;
        })
        .catch(() => {});
    }
  }, [active, createConversation, i18n.language]);

  // Once per session: resolve the LLM and the tools here (upstream keeps both in this renderer),
  // then ask the main process to start the voice runtime.
  useEffect(() => {
    if (state === "idle" || state === "error") {
      begunForSession.current = false;
      return;
    }
    if (state !== "starting" || begunForSession.current) return;
    begunForSession.current = true;
    setMessages([]);
    setNotice(null);
    setLatencyMs(null);
    toolCallsRef.current = [];

    const registry = createVoiceToolRegistry();
    registryRef.current = registry;
    const llmConfig = selectResolvedLLMConfig(getSettings(), "dictationAgent");
    const llm =
      llmConfig.mode === "local"
        ? { mode: "local" }
        : {
            mode: llmConfig.mode,
            model: llmConfig.model,
            baseURL: llmConfig.cloudBaseUrl || llmConfig.remoteUrl || "",
            apiKey: llmConfig.customApiKey || "",
          };
    void invokeConversation("session.begin", { llm, tools: voiceToolSchemas(registry) }).then(
      (result) => {
        if (result.success) return;
        const code = result.errors?.[0];
        setNotice(
          code && BEGIN_ERROR_KEYS[code]
            ? t(BEGIN_ERROR_KEYS[code])
            : t("conversation:session.errors.startFailed", {
                reason: result.displayText || code || "?",
              })
        );
      }
    );
  }, [state, t]);

  const persist = useCallback(
    (role: "user" | "assistant", content: string, metadata: Record<string, unknown>) => {
      const id = conversationIdRef.current;
      if (!id || !content) return;
      const pending = window.electronAPI?.addAgentMessage?.(id, role, content, metadata);
      pending?.catch(() => {});
    },
    []
  );

  useEffect(() => {
    const api = window.conversationAPI;
    if (!api) return;
    type Listener = Parameters<typeof api.on>[1];
    const on = (type: string, handler: (message: BridgeMessage) => void) =>
      api.on(type, handler as unknown as Listener);

    const runToolCall = async (message: BridgeMessage) => {
      if (typeof message.id !== "string") return;
      const registry = registryRef.current ?? createVoiceToolRegistry();
      registryRef.current = registry;
      const name = String(message.data?.name ?? "");
      const record: ToolCallRecord = { name, status: "executing" };
      toolCallsRef.current.push(record);
      const result = await executeVoiceToolCall(registry, {
        name,
        arguments: message.data?.arguments,
      });
      record.status = result.success ? "completed" : "error";
      await invokeConversation("session.toolResult", {
        id: message.id,
        success: result.success,
        text: result.text,
      });
    };

    const offs = [
      on("transcript.final", (message) => {
        const text = String(message.data?.text ?? "").trim();
        if (!text) return;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "user", content: text, isStreaming: false },
        ]);
        persist("user", text, voiceMessageMetadata());
      }),
      on("assistant.delta", (message) => {
        const chunk = String(message.data?.text ?? "");
        if (!chunk) return;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
          }
          return [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: chunk, isStreaming: true },
          ];
        });
      }),
      on("assistant.final", (message) => {
        const interrupted = !!message.data?.interrupted;
        // An interrupted reply is kept as far as it was actually heard.
        const text = String(
          (interrupted ? message.data?.spokenText : message.data?.text) ?? ""
        ).trim();
        const toolCalls = toolCallsRef.current;
        toolCallsRef.current = [];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const streaming = !!last && last.role === "assistant" && last.isStreaming;
          const rest = streaming ? prev.slice(0, -1) : prev;
          const content = text || (streaming && last ? last.content : "");
          if (!content) return rest;
          return [
            ...rest,
            {
              id: streaming && last ? last.id : crypto.randomUUID(),
              role: "assistant",
              content,
              isStreaming: false,
            },
          ];
        });
        persist("assistant", text, voiceMessageMetadata({ interrupted, toolCalls }));
      }),
      on("tool.call", (message) => void runToolCall(message)),
      on("latency", (message) => {
        const ms = Number(message.data?.userBotMs);
        if (Number.isFinite(ms)) setLatencyMs(Math.round(ms));
      }),
      on("task.update", (message) => {
        const task = message.data as unknown as TaskCard | undefined;
        if (!task?.id) return;
        setTasks((prev) =>
          prev.some((item) => item.id === task.id)
            ? prev.map((item) => (item.id === task.id ? task : item))
            : [task, ...prev].slice(0, 10)
        );
      }),
      on("warning", (message) => setNotice(String(message.data?.message ?? ""))),
      on("error", (message) => setNotice(String(message.data?.message ?? ""))),
    ];
    return () => offs.forEach((off) => off());
  }, [persist]);

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
            {latencyMs !== null && (
              <span className="ml-2 text-zinc-500" data-testid="conversation-latency">
                {t("conversation:session.latency", { ms: latencyMs })}
              </span>
            )}
          </p>
        </div>
        {state === "speaking" && (
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
            onClick={() => void invokeConversation("session.interrupt")}
          >
            {t("conversation:session.interrupt")}
          </button>
        )}
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

      {notice && (
        <p
          className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200"
          data-testid="conversation-notice"
        >
          {notice}
        </p>
      )}

      {tasks.length > 0 && (
        <section
          className="border-b border-white/10 px-4 py-2 text-xs"
          data-testid="conversation-tasks"
        >
          <div className="mb-1 text-zinc-400">{t("conversation:workers.heading")}</div>
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id} className="rounded-md bg-white/5 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-zinc-100">{task.title}</span>
                  <span className="text-zinc-400">
                    {t(`conversation:workers.status.${task.status}`)}
                  </span>
                  {(task.status === "queued" || task.status === "running") && (
                    <button
                      type="button"
                      className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                      onClick={() => void invokeConversation("workers.cancel", { taskId: task.id })}
                    >
                      {t("conversation:workers.cancel")}
                    </button>
                  )}
                </div>
                {(task.error || task.summary || task.progress) && (
                  <p className="mt-1 line-clamp-2 text-zinc-400">
                    {task.error || task.summary || task.progress}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
