const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/voice-agent/shared/stateMachine.mjs");

test("a full spoken turn walks through the expected states", async () => {
  const { nextSessionState } = await load();
  let state = "idle";
  for (const [event, expected] of [
    ["session.start", "starting"],
    ["sidecar.ready", "listening"],
    ["user.started", "user_speaking"],
    ["user.stopped", "thinking"],
    ["bot.started", "speaking"],
    ["bot.stopped", "listening"],
    ["session.stop", "stopping"],
    ["session.stopped", "idle"],
  ]) {
    state = nextSessionState(state, event);
    assert.equal(state, expected, event);
  }
});

test("events that do not apply leave the state unchanged", async () => {
  const { nextSessionState } = await load();
  assert.equal(nextSessionState("idle", "bot.started"), "idle");
  assert.equal(nextSessionState("idle", "user.started"), "idle");
  assert.equal(nextSessionState("stopping", "bot.started"), "stopping");
  assert.equal(nextSessionState("listening", "not.an.event"), "listening");
  assert.equal(nextSessionState("listening", "constructor"), "listening");
});

test("a confirmation pauses the turn and resumes into thinking", async () => {
  const { nextSessionState } = await load();
  assert.equal(nextSessionState("thinking", "confirm.requested"), "confirming");
  assert.equal(nextSessionState("confirming", "confirm.resolved"), "thinking");
});

test("the user can interrupt while the bot speaks, and a session can always be stopped", async () => {
  const { nextSessionState, isSessionActive } = await load();
  assert.equal(nextSessionState("speaking", "user.started"), "user_speaking");
  for (const state of [
    "starting",
    "listening",
    "user_speaking",
    "thinking",
    "speaking",
    "confirming",
    "error",
  ]) {
    assert.equal(nextSessionState(state, "session.stop"), "stopping", state);
  }
  assert.equal(isSessionActive("idle"), false);
  assert.equal(isSessionActive("error"), false);
  assert.equal(isSessionActive("speaking"), true);
});
