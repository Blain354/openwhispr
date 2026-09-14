import { createToolRegistry } from "../../services/tools";
import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { getSettings } from "../../stores/settingsStore";
import { selectVoiceTools, toolResultText, VOICE_TOOL_ALLOWLIST } from "../shared/voiceTools.mjs";

export interface VoiceToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The session window's tool registry. Notes search is forced local (no cloud search) and no
 * web-search or calendar tools are offered: the voice session never widens what leaves the machine.
 */
export function createVoiceToolRegistry(): ToolRegistry {
  const settings = getSettings() as unknown as { cloudBackupEnabled?: boolean };
  return createToolRegistry({
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: !!settings.cloudBackupEnabled,
    webSearchEnabled: false,
  });
}

export function voiceToolSchemas(registry: ToolRegistry): VoiceToolSchema[] {
  return selectVoiceTools(registry.getAll()) as VoiceToolSchema[];
}

export async function executeVoiceToolCall(
  registry: ToolRegistry,
  call: { name?: unknown; arguments?: unknown }
): Promise<{ success: boolean; text: string }> {
  const name = typeof call.name === "string" ? call.name : "";
  const tool = registry.get(name);
  if (!tool || !(VOICE_TOOL_ALLOWLIST as readonly string[]).includes(name)) {
    return { success: false, text: `Unknown tool: ${name || "(none)"}` };
  }
  let args: Record<string, unknown> = {};
  if (typeof call.arguments === "string" && call.arguments.trim()) {
    try {
      args = JSON.parse(call.arguments);
    } catch {
      return { success: false, text: "The tool arguments were not valid JSON." };
    }
  } else if (call.arguments && typeof call.arguments === "object") {
    args = call.arguments as Record<string, unknown>;
  }
  try {
    const result = await tool.execute(args);
    return { success: result.success, text: toolResultText(result) };
  } catch (error) {
    return { success: false, text: (error as Error).message || "The tool failed." };
  }
}
