// Decides where Conversation mode tools may be offered. Pure logic, no store or window access.

export type ConversationWindowKind = "main" | "control-panel" | "session" | "companion";

export interface OsToolGateInput {
  windowKind: ConversationWindowKind | string | null | undefined;
  toolsInChat: boolean;
  /** Resolved inference modes of the chat and voice-assistant scopes. */
  modes: Array<string | null | undefined>;
}

/**
 * The session window runs its own local conversation loop, so it always gets the OS tools.
 * Upstream chat surfaces get them only behind the toolsInChat developer flag, and only while every
 * scope that could answer is a local model: OS tools are never offered to a cloud model.
 */
export function shouldOfferOsTools({ windowKind, toolsInChat, modes }: OsToolGateInput): boolean {
  if (windowKind === "session") return true;
  if (windowKind !== "main" && windowKind !== "control-panel") return false;
  if (!toolsInChat) return false;
  return modes.length > 0 && modes.every((mode) => mode === "local");
}
