// State labels are looked up with a template key (companion.states.<state>), which the static key
// scan cannot see, so every state of the machine is checked here.
const test = require("node:test");
const assert = require("node:assert/strict");

const en = require("../../src/voice-agent/locales/en.json");
const fr = require("../../src/voice-agent/locales/fr.json");

test("every session state has a companion label in en and fr", async () => {
  const { SESSION_STATES } = await import("../../src/voice-agent/shared/stateMachine.mjs");
  for (const state of SESSION_STATES) {
    assert.equal(typeof en.companion.states[state], "string", `en:${state}`);
    assert.equal(typeof fr.companion.states[state], "string", `fr:${state}`);
  }
});
