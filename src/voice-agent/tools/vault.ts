import type { ToolDefinition, ToolResult } from "../../services/tools/ToolRegistry";
import { toToolResult } from "./os";

type VaultOp = "vault.search" | "vault.read";

async function invoke(
  op: VaultOp,
  payload: Record<string, unknown>,
  isAllowed: () => boolean
): Promise<ToolResult> {
  const api = window.conversationAPI;
  if (!api || !isAllowed()) {
    return toToolResult({
      success: false,
      displayText: "The notes vault is only available in a voice session.",
    });
  }
  try {
    return toToolResult((await api.invoke(op, payload)) as Parameters<typeof toToolResult>[0]);
  } catch (error) {
    return toToolResult({ success: false, displayText: (error as Error).message || "Failed." });
  }
}

/**
 * Read-only access to the user's Markdown vault, evaluated in the main process: this renderer never
 * touches the file system, and sealed or private notes are refused there.
 */
export function createVaultTools(isAllowed: () => boolean): ToolDefinition[] {
  return [
    {
      name: "vault_search",
      description:
        "Search the user's own notes — their personal Markdown vault: daily notes, projects, meetings, decisions. This is where the user writes, so use it for anything about what the user noted, planned or decided, including today's notes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, in the user's language" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      readOnly: true,
      execute: (args) => invoke("vault.search", { query: String(args.query ?? "") }, isAllowed),
    },
    {
      name: "vault_read",
      description:
        "Read one of the user's notes in full, by the path returned by vault_search (for example 50_AI/Note.md).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the note inside the vault" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      readOnly: true,
      execute: (args) => invoke("vault.read", { path: String(args.path ?? "") }, isAllowed),
    },
  ];
}
