// Which tools a voice session offers to its (local) supervisor model. Pure logic.
//
// Every schema is part of the prompt the small local model reads on each turn, so the list is
// short and explicit. Upstream write tools that have no main-process confirmation (create_note,
// update_note, dictionary and snippet edits) are left out of voice sessions.

export const MAX_VOICE_TOOLS = 12;

export const VOICE_TOOL_ALLOWLIST = Object.freeze([
  "open_app",
  "focus_window",
  "set_displays",
  "run_powershell",
  "search_notes",
  "get_note",
  "list_folders",
  "copy_to_clipboard",
]);

/**
 * @param {Array<{ name: string, description: string, parameters: object }>} tools
 * @param {readonly string[]} [allowlist]
 * @returns {Array<{ name: string, description: string, parameters: object }>}
 */
export function selectVoiceTools(tools, allowlist = VOICE_TOOL_ALLOWLIST) {
  const allowed = new Set(allowlist);
  const selected = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool.name !== "string" || !allowed.has(tool.name) || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    selected.push({
      name: tool.name,
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
