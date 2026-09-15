// Which tools a voice session offers to its (local) supervisor model. Pure logic.
//
// Every schema is part of the prompt the small local model reads on each turn, so the list is
// short, explicit and ordered by usefulness by voice: what acts on the machine and on the user's
// own notes first, MCP servers next, OpenWhispr's own note tools last. The cap cuts the tail.
// Upstream write tools that have no main-process confirmation (create_note, update_note,
// dictionary and snippet edits) are never in the list.

export const MAX_VOICE_TOOLS = 12;

export const CORE_VOICE_TOOLS = Object.freeze([
  "open_app",
  "focus_window",
  "set_displays",
  "run_powershell",
  "delegate_task",
  "list_tasks",
  "cancel_task",
  "vault_search",
  "vault_read",
]);

export const NOTE_VOICE_TOOLS = Object.freeze([
  "search_notes",
  "get_note",
  "list_folders",
  "copy_to_clipboard",
]);

export const VOICE_TOOL_ALLOWLIST = Object.freeze([...CORE_VOICE_TOOLS, ...NOTE_VOICE_TOOLS]);

/**
 * The tools a session keeps when its text leaves the machine: none of them reads the user's data.
 * The vault, the app's notes, MCP servers, background workers and PowerShell output would
 * otherwise reach the online provider in a tool result.
 */
export const ONLINE_VOICE_TOOLS = Object.freeze([
  "open_app",
  "focus_window",
  "set_displays",
  "copy_to_clipboard",
]);

/**
 * The allowlist of one session: MCP tools sit between the core tools and the note tools.
 *
 * With a vault configured, OpenWhispr's own note tools are left out: asked to "search my notes",
 * the model called search_notes (the app's notes) instead of the vault the user actually writes in,
 * and two tools for the same words is a choice a 4B model gets wrong.
 *
 * A session whose text leaves the machine gets ONLINE_VOICE_TOOLS only, whatever else exists.
 */
export function voiceToolAllowlist(
  mcpNames = [],
  { hasVault = false, textLeavesMachine = false } = {}
) {
  if (textLeavesMachine) return [...ONLINE_VOICE_TOOLS];
  const mcp = (Array.isArray(mcpNames) ? mcpNames : []).filter(
    (name) => typeof name === "string" && name.startsWith("mcp_")
  );
  const notes = hasVault ? ["copy_to_clipboard"] : NOTE_VOICE_TOOLS;
  return [...CORE_VOICE_TOOLS, ...new Set(mcp), ...notes];
}

/**
 * @param {Array<{ name: string, description: string, parameters: object }>} tools
 * @param {readonly string[]} [allowlist] in priority order
 * @returns {Array<{ name: string, description: string, parameters: object }>}
 */
export function selectVoiceTools(tools, allowlist = VOICE_TOOL_ALLOWLIST) {
  const byName = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool && typeof tool.name === "string" && !byName.has(tool.name))
      byName.set(tool.name, tool);
  }
  const selected = [];
  for (const name of allowlist) {
    const tool = byName.get(name);
    if (!tool || selected.some((entry) => entry.name === name)) continue;
    selected.push({
      name,
      description: String(tool.description || ""),
      parameters:
        tool.parameters && typeof tool.parameters === "object"
          ? tool.parameters
          : { type: "object", properties: {} },
    });
    if (selected.length === MAX_VOICE_TOOLS) break;
  }
  return selected;
}

/** Text the model reads back from a tool result, capped so a large output cannot flood the context. */
export function toolResultText(result, maxChars = 4000) {
  const success = !!result?.success;
  const data = result?.data;
  let text;
  if (typeof data === "string") text = data;
  else if (data !== undefined && data !== null) text = JSON.stringify(data);
  else text = result?.displayText || (success ? "Done." : "Failed.");
  if (!success && result?.displayText && !text.includes(result.displayText)) {
    text = `${result.displayText}${text && text !== "Failed." ? `\n${text}` : ""}`;
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
