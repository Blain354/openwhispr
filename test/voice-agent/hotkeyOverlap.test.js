const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/voice-agent/shared/hotkeyOverlap.mjs");
const PC_BLAIN_SLOTS = { dictation: ["Control+Super"], voiceAgent: ["Control+Alt+F10"] };

test("Control+Alt+Space is accepted next to a Control+Super dictation key", async () => {
  const { validateConversationHotkey } = await load();
  assert.deepEqual(validateConversationHotkey("Control+Alt+Space", PC_BLAIN_SLOTS), {
    ok: true,
    errors: [],
    warnings: [],
  });
});

test("a combination that starts with the modifier-only dictation chord is rejected", async () => {
  const { validateConversationHotkey } = await load();
  const verdict = validateConversationHotkey("Control+Super+Space", PC_BLAIN_SLOTS);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes("starts-with:dictation"));
  assert.ok(verdict.errors.includes("windows-reserved"));
  // Aliases resolve to the same keys.
  assert.ok(
    validateConversationHotkey("Ctrl+Win+K", PC_BLAIN_SLOTS).errors.includes(
      "starts-with:dictation"
    )
  );
});

test("exact duplicates of another slot are rejected, whatever the alias or order", async () => {
  const { validateConversationHotkey } = await load();
  assert.ok(
    validateConversationHotkey("Alt+Ctrl+F10", PC_BLAIN_SLOTS).errors.includes(
      "duplicate:voiceAgent"
    )
  );
});

test("modifier-only, right-side and multi-key hotkeys are rejected", async () => {
  const { validateConversationHotkey } = await load();
  assert.ok(validateConversationHotkey("Control+Alt", {}).errors.includes("modifier-only"));
  assert.ok(validateConversationHotkey("RightAlt", {}).errors.includes("right-side-modifier"));
  assert.ok(validateConversationHotkey("Control+A+B", {}).errors.includes("multiple-keys"));
  assert.ok(validateConversationHotkey("Space", {}).errors.includes("needs-modifier"));
  assert.deepEqual(validateConversationHotkey("", {}).errors, ["empty"]);
});

test("a bare function key is allowed", async () => {
  const { validateConversationHotkey } = await load();
  assert.equal(validateConversationHotkey("F9", PC_BLAIN_SLOTS).ok, true);
  assert.equal(validateConversationHotkey("Alt+F9", PC_BLAIN_SLOTS).ok, true);
});

test("Windows input-method shortcuts are reserved", async () => {
  const { validateConversationHotkey } = await load();
  for (const hotkey of ["Super+Space", "Win+Shift+Space", "Control+Super+Space"]) {
    assert.ok(validateConversationHotkey(hotkey, {}).errors.includes("windows-reserved"), hotkey);
  }
});

test("known third-party bindings only warn", async () => {
  const { validateConversationHotkey } = await load();
  const powerToys = validateConversationHotkey("Alt+Space", {});
  assert.equal(powerToys.ok, true);
  assert.deepEqual(powerToys.warnings, ["powertoys-run"]);
  assert.deepEqual(validateConversationHotkey("Super+Alt+Space", {}).warnings, ["command-palette"]);
});
