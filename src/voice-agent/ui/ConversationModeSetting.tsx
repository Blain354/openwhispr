import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeConversation } from "./useConversationBridge";

interface PublicConfig {
  enabled: boolean;
  hotkey: string;
}

/**
 * Conversation mode is off until it is switched on here: while it is off the main process registers
 * no hotkey, starts no sidecar and offers no tool, so the feature costs nothing to the rest of the
 * app. Rendered inside the Hotkeys section of the settings page.
 */
export default function ConversationModeSetting() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invokeConversation<PublicConfig>("config.get").then((result) => {
      if (result.success && result.data) setConfig(result.data);
    });
  }, []);

  if (!config) return null;

  const toggle = async () => {
    setBusy(true);
    const result = await invokeConversation<PublicConfig>("config.setEnabled", {
      enabled: !config.enabled,
    });
    if (result.data) setConfig(result.data);
    setError(result.success ? null : result.errors?.[0] || result.displayText || "");
    setBusy(false);
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{t("conversation.settings.enableTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("conversation.settings.enableDescription", { hotkey: config.hotkey })}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label={t("conversation.settings.enableTitle")}
          disabled={busy}
          onClick={() => void toggle()}
          className={`mt-1 h-6 w-11 shrink-0 rounded-full transition-colors ${
            config.enabled ? "bg-blue-600" : "bg-zinc-400/50"
          }`}
        >
          <span
            className={`block h-5 w-5 rounded-full bg-white transition-transform ${
              config.enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
