// Reader for Claude Code's `--output-format stream-json` (one JSON object per line). Pure logic.

const MAX_LINE_CHARS = 1024 * 1024;

function createLineParser(onObject) {
  let buffer = "";
  const emitLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      onObject({ type: "invalid" });
      return;
    }
    onObject(
      value && typeof value === "object" && !Array.isArray(value) ? value : { type: "invalid" }
    );
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        emitLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > MAX_LINE_CHARS) {
        buffer = "";
        onObject({ type: "invalid" });
      }
    },
    end() {
      emitLine(buffer);
      buffer = "";
    },
  };
}

function toolDetail(input) {
  if (!input || typeof input !== "object") return "";
  const value = input.command ?? input.pattern ?? input.file_path ?? input.path ?? "";
  return String(value).slice(0, 160);
}

function summarizeResult(result) {
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials.map((denial) => String(denial?.tool_name || "unknown"))
    : [];
  return {
    success: result.subtype === "success" && !result.is_error && denials.length === 0,
    subtype: String(result.subtype || ""),
    text: typeof result.result === "string" ? result.result : "",
    costUsd: Number(result.total_cost_usd) || 0,
    durationMs: Number(result.duration_ms) || 0,
    turns: Number(result.num_turns) || 0,
    denials,
  };
}

/** @returns {Array<object>} the events of interest in one stream-json object */
function describeEvent(value) {
  if (!value || typeof value !== "object") return [];
  const content = Array.isArray(value.message?.content) ? value.message.content : [];
  switch (value.type) {
    case "system":
      return value.subtype === "init"
        ? [
            {
              kind: "init",
              model: String(value.model || ""),
              tools: Array.isArray(value.tools) ? value.tools : [],
            },
          ]
        : [];
    case "assistant":
      return content.flatMap((item) => {
        if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
          return [{ kind: "text", text: item.text.trim() }];
        }
        if (item?.type === "tool_use") {
          return [
            { kind: "tool", name: String(item.name || "tool"), detail: toolDetail(item.input) },
          ];
        }
        return [];
      });
    case "user":
      return content
        .filter((item) => item?.type === "tool_result" && item.is_error)
        .map(() => ({ kind: "tool-error" }));
    case "result":
      return [{ kind: "result", ...summarizeResult(value) }];
    case "invalid":
      return [{ kind: "invalid" }];
    default:
      return [];
  }
}

module.exports = { createLineParser, describeEvent, summarizeResult, MAX_LINE_CHARS };
