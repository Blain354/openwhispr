// Conversation session states, shared by the main process (source of truth) and the companion
// overlay. Transitions are allowlisted: an event that does not apply to the current state is
// ignored instead of producing an impossible state (e.g. "speaking" after the session stopped).

export const SESSION_STATES = Object.freeze([
  "idle",
  "starting",
  "listening",
  "user_speaking",
  "thinking",
  "speaking",
  "confirming",
  "stopping",
  "error",
]);

const ACTIVE = ["listening", "user_speaking", "thinking", "speaking", "confirming"];

// event -> { from: states the event applies to, to: next state }
const TRANSITIONS = Object.freeze({
  "session.start": { from: ["idle", "error"], to: "starting" },
  "sidecar.ready": { from: ["starting"], to: "listening" },
  "user.started": { from: ["listening", "speaking", "thinking"], to: "user_speaking" },
  "user.stopped": { from: ["user_speaking"], to: "thinking" },
  "bot.started": { from: ["thinking", "listening", "confirming"], to: "speaking" },
  "bot.stopped": { from: ["speaking"], to: "listening" },
  "confirm.requested": { from: ACTIVE, to: "confirming" },
  "confirm.resolved": { from: ["confirming"], to: "thinking" },
  "turn.idle": { from: ["thinking", "confirming", "user_speaking"], to: "listening" },
  "session.stop": { from: ["starting", ...ACTIVE, "error"], to: "stopping" },
  "session.stopped": { from: ["stopping", "starting", ...ACTIVE, "error"], to: "idle" },
  "session.error": { from: ["starting", ...ACTIVE, "stopping"], to: "error" },
});

export const SESSION_EVENTS = Object.freeze(Object.keys(TRANSITIONS));

/**
 * @param {string} state
 * @param {string} event
 * @returns {string} the next state, or the current one when the event does not apply
 */
export function nextSessionState(state, event) {
  const rule = Object.prototype.hasOwnProperty.call(TRANSITIONS, event) ? TRANSITIONS[event] : null;
  if (!rule || !rule.from.includes(state)) return state;
  return rule.to;
}

export function isSessionActive(state) {
  return state !== "idle" && state !== "error";
}
