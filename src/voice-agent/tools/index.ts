import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { getSettings, selectResolvedLLMConfig } from "../../stores/settingsStore";
import { shouldOfferOsTools } from "./gating";
import { createOsTools } from "./os";
import { createWorkerTools } from "./workers";

function currentModes(): string[] {
  const settings = getSettings();
  return [
    selectResolvedLLMConfig(settings, "chatIntelligence").mode,
    selectResolvedLLMConfig(settings, "dictationAgent").mode,
  ];
}

function osToolsAllowedNow(): boolean {
  const api = typeof window !== "undefined" ? window.conversationAPI : undefined;
  if (!api) return false;
  return shouldOfferOsTools({
    windowKind: api.bootstrap.windowKind,
    toolsInChat: api.bootstrap.toolsInChat,
    modes: currentModes(),
  });
}

/**
 * Conversation mode hook into upstream's createToolRegistry(). Registers nothing unless the main
 * process exposed the conversation bridge to this window and the gate allows it. Upstream caches
 * registries, so every tool re-checks the gate when it runs as well.
 */
export function registerConversationTools(registry: ToolRegistry, _settings?: unknown): void {
  if (!osToolsAllowedNow()) return;
  for (const tool of createOsTools(osToolsAllowedNow)) {
    registry.register(tool);
  }
  // Background workers send instructions to Anthropic: voice session only, never upstream chats.
  const inSession = () => window.conversationAPI?.bootstrap.windowKind === "session";
  if (inSession()) {
    for (const tool of createWorkerTools(inSession)) {
      registry.register(tool);
    }
  }
}
