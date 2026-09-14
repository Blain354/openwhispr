import type { ToolDefinition, ToolResult } from "../../services/tools/ToolRegistry";

type OsOp = "os.openApp" | "os.focusWindow" | "os.setDisplays" | "os.runPowershell";

interface BridgeResult {
  success?: boolean;
  data?: unknown;
  displayText?: string;
}

/**
 * Upstream's chat shows an object tool result as a bare "Done", and the model reads the same value,
 * so successful results carry readable text: the main-process summary plus any command output.
 */
export function toToolResult(result: BridgeResult | null | undefined): ToolResult {
  const success = !!result?.success;
  const displayText = result?.displayText || (success ? "Done." : "Failed.");
  const output =
    result?.data && typeof result.data === "object" && "output" in result.data
      ? String((result.data as { output?: unknown }).output ?? "").trim()
      : "";
  return {
    success,
    data: success ? (output ? `${displayText}\n${output}` : displayText) : null,
    displayText,
  };
}

async function invoke(
  op: OsOp,
  payload: Record<string, unknown>,
  isAllowed: () => boolean
): Promise<ToolResult> {
  const api = window.conversationAPI;
  if (!api || !isAllowed()) {
    return toToolResult({
      success: false,
      displayText: "Conversation tools are not available here.",
    });
  }
  try {
    return toToolResult((await api.invoke(op, payload)) as BridgeResult);
  } catch (error) {
    return toToolResult({ success: false, displayText: (error as Error).message || "Failed." });
  }
}

export function createOsTools(isAllowed: () => boolean): ToolDefinition[] {
  return [
    {
      name: "open_app",
      description:
        "Open an installed Windows application by its name (Start menu entry), e.g. Obsidian, Notepad, Spotify.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Application name as the user said it" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) => invoke("os.openApp", { name: String(args.name ?? "") }, isAllowed),
    },
    {
      name: "focus_window",
      description:
        "Bring an already open window to the front, matched by application or window title.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Part of the application name or window title" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) => invoke("os.focusWindow", { query: String(args.query ?? "") }, isAllowed),
    },
    {
      name: "set_displays",
      description:
        "Change the Windows display mode. The user confirms on screen before anything changes.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["internal", "external", "extend", "clone"],
            description: "internal = main screen only, extend = all screens, clone = duplicate",
          },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) => invoke("os.setDisplays", { mode: String(args.mode ?? "") }, isAllowed),
    },
    {
      name: "run_powershell",
      description:
        "Run a short PowerShell script on the user's Windows PC. The user reviews the exact script and must press Run on screen; never claim it ran unless the result says so.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "The PowerShell script to run" },
          reason: { type: "string", description: "One sentence explaining why it is needed" },
        },
        required: ["script", "reason"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) =>
        invoke(
          "os.runPowershell",
          { script: String(args.script ?? ""), reason: String(args.reason ?? "") },
          isAllowed
        ),
    },
  ];
}
