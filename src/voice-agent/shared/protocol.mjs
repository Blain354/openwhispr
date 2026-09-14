// Loopback WebSocket protocol between Electron (server) and the Python voice sidecar (client).
// Pure logic. Every message is a JSON object: { v, type, ts, id?, turn?, data }.

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const SIDECAR_MESSAGE_TYPES = Object.freeze([
  "hello",
  "ready",
  "state",
  "transcript.partial",
  "transcript.final",
  "assistant.delta",
  "assistant.final",
  "tool.call",
  "tool.cancel",
  "latency",
  "level",
  "warning",
  "error",
  "bye",
]);

export const APP_MESSAGE_TYPES = Object.freeze([
  "session.config",
  "tool.result",
  "say",
  "interrupt",
  "mute",
  "update_tools",
  "shutdown",
  "ping",
]);

// What may reach renderer windows. tool.call goes only to the tool executor, and nothing the
// sidecar sends is relayed unless listed here.
export const RELAYED_TO_WINDOWS = Object.freeze([
  "state",
  "transcript.partial",
  "transcript.final",
  "assistant.delta",
  "assistant.final",
  "latency",
  "level",
  "warning",
  "error",
]);

export function encodeMessage(type, data = {}, extra = {}) {
  const message = { v: PROTOCOL_VERSION, type, ts: Date.now(), data };
  if (typeof extra.id === "string") message.id = extra.id;
  if (typeof extra.turn === "number") message.turn = extra.turn;
  return JSON.stringify(message);
}

/**
 * @param {string} raw
 * @param {readonly string[]} allowedTypes
 * @returns {{ ok: true, message: object } | { ok: false, error: string }}
 */
export function decodeMessage(raw, allowedTypes) {
  if (typeof raw !== "string") return { ok: false, error: "not-text" };
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: "too-large" };
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: "not-object" };
  }
  if (message.v !== PROTOCOL_VERSION) return { ok: false, error: "version" };
  if (typeof message.type !== "string" || !allowedTypes.includes(message.type)) {
    return { ok: false, error: "type" };
  }
  if (
    message.data !== undefined &&
    (typeof message.data !== "object" || message.data === null || Array.isArray(message.data))
  ) {
    return { ok: false, error: "data" };
  }
  if (message.id !== undefined && typeof message.id !== "string") return { ok: false, error: "id" };
  return { ok: true, message: { ...message, data: message.data || {} } };
}
