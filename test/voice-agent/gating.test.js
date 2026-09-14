const test = require("node:test");
const assert = require("node:assert/strict");

test("the session window always gets OS tools", async () => {
  const { shouldOfferOsTools } = await import("../../src/voice-agent/tools/gating.ts");
  assert.equal(
    shouldOfferOsTools({ windowKind: "session", toolsInChat: false, modes: ["providers"] }),
    true
  );
});

test("chat windows need the flag and local models on every scope", async () => {
  const { shouldOfferOsTools } = await import("../../src/voice-agent/tools/gating.ts");
  for (const windowKind of ["main", "control-panel"]) {
    assert.equal(
      shouldOfferOsTools({ windowKind, toolsInChat: false, modes: ["local", "local"] }),
      false
    );
    assert.equal(
      shouldOfferOsTools({ windowKind, toolsInChat: true, modes: ["local", "local"] }),
      true
    );
    assert.equal(
      shouldOfferOsTools({ windowKind, toolsInChat: true, modes: ["local", "openwhispr"] }),
      false
    );
    assert.equal(
      shouldOfferOsTools({ windowKind, toolsInChat: true, modes: ["providers", "local"] }),
      false
    );
    assert.equal(shouldOfferOsTools({ windowKind, toolsInChat: true, modes: [] }), false);
  }
});

test("other windows never get OS tools", async () => {
  const { shouldOfferOsTools } = await import("../../src/voice-agent/tools/gating.ts");
  for (const windowKind of ["companion", "pill", undefined, null]) {
    assert.equal(
      shouldOfferOsTools({ windowKind, toolsInChat: true, modes: ["local", "local"] }),
      false
    );
  }
});
