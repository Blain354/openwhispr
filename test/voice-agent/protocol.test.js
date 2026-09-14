const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/voice-agent/shared/protocol.mjs");

test("encoded messages decode back with their fields", async () => {
  const { encodeMessage, decodeMessage, SIDECAR_MESSAGE_TYPES } = await load();
  const raw = encodeMessage("transcript.final", { text: "Bonjour" }, { turn: 3 });
  const decoded = decodeMessage(raw, SIDECAR_MESSAGE_TYPES);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.message.type, "transcript.final");
  assert.equal(decoded.message.turn, 3);
  assert.deepEqual(decoded.message.data, { text: "Bonjour" });
});

test("messages of the wrong direction, version or shape are rejected", async () => {
  const { decodeMessage, SIDECAR_MESSAGE_TYPES, APP_MESSAGE_TYPES } = await load();
  const cases = [
    ['{"v":1,"type":"shutdown","data":{}}', SIDECAR_MESSAGE_TYPES, "type"],
    ['{"v":1,"type":"tool.call","data":{}}', APP_MESSAGE_TYPES, "type"],
    ['{"v":2,"type":"ready","data":{}}', SIDECAR_MESSAGE_TYPES, "version"],
    ["not json", SIDECAR_MESSAGE_TYPES, "invalid-json"],
    ["[1,2]", SIDECAR_MESSAGE_TYPES, "not-object"],
    ['{"v":1,"type":"ready","data":[1]}', SIDECAR_MESSAGE_TYPES, "data"],
    ['{"v":1,"type":"ready","id":5,"data":{}}', SIDECAR_MESSAGE_TYPES, "id"],
  ];
  for (const [raw, allowed, error] of cases) {
    assert.deepEqual(decodeMessage(raw, allowed), { ok: false, error }, raw);
  }
});

test("oversized payloads are rejected before parsing", async () => {
  const { decodeMessage, SIDECAR_MESSAGE_TYPES, MAX_MESSAGE_BYTES } = await load();
  assert.deepEqual(decodeMessage("x".repeat(MAX_MESSAGE_BYTES + 1), SIDECAR_MESSAGE_TYPES), {
    ok: false,
    error: "too-large",
  });
});

test("tool calls are never relayed to renderer windows", async () => {
  const { RELAYED_TO_WINDOWS } = await load();
  assert.equal(RELAYED_TO_WINDOWS.includes("tool.call"), false);
  assert.equal(RELAYED_TO_WINDOWS.includes("hello"), false);
  assert.equal(RELAYED_TO_WINDOWS.includes("state"), true);
});
