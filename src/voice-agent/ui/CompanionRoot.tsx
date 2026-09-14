import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invokeConversation, useConversationState } from "./useConversationBridge";

const ORB_COLORS: Record<string, string> = {
  idle: "#6b7280",
  starting: "#a78bfa",
  listening: "#3b82f6",
  user_speaking: "#22c55e",
  thinking: "#f59e0b",
  speaking: "#8b5cf6",
  confirming: "#ef4444",
  stopping: "#6b7280",
  error: "#dc2626",
};

const PULSING = new Set(["listening", "user_speaking", "speaking"]);

export default function CompanionRoot() {
  const { t } = useTranslation();
  const state = useConversationState();
  const color = ORB_COLORS[state] || ORB_COLORS.idle;
  const label = t(`conversation.companion.states.${state}`);

  // The overlay window is transparent; upstream's global stylesheet paints the page background.
  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (el) el.style.background = "transparent";
    }
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "transparent",
        userSelect: "none",
      }}
    >
      <style>{`
        @keyframes owConversationPulse { 0%,100% { transform: scale(0.92); opacity: 0.8 } 50% { transform: scale(1.05); opacity: 1 } }
        @keyframes owConversationSpin { to { transform: rotate(360deg) } }
      `}</style>
      <div
        data-state={state}
        title={label}
        style={{
          position: "relative",
          width: 104,
          height: 104,
          borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.45), ${color} 58%, rgba(0,0,0,0.55))`,
          boxShadow: `0 0 28px ${color}`,
          animation:
            state === "thinking"
              ? "owConversationSpin 1.6s linear infinite"
              : PULSING.has(state)
                ? "owConversationPulse 1.4s ease-in-out infinite"
                : "none",
        }}
      >
        <button
          type="button"
          aria-label={t("conversation.companion.stop")}
          title={t("conversation.companion.stop")}
          onClick={() => void invokeConversation("session.stop")}
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.3)",
            background: "#111827",
            color: "#fff",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: "26px",
          }}
        >
          ×
        </button>
      </div>
      <span style={{ fontSize: 11, color: "#fff", textShadow: "0 1px 3px #000" }}>{label}</span>
    </div>
  );
}
