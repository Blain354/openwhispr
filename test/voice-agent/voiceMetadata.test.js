const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/voice-agent/shared/voiceMetadata.mjs");

test("session titles are localized and dated", async () => {
  const { sessionTitle } = await load();
  const date = new Date(2026, 8, 14, 21, 5);
  assert.equal(sessionTitle(date, "fr"), "Session vocale — 2026-09-14 21:05");
  assert.equal(sessionTitle(date, "fr-CA"), "Session vocale — 2026-09-14 21:05");
  assert.equal(sessionTitle(date, "en"), "Voice session — 2026-09-14 21:05");
  assert.equal(sessionTitle(date, undefined), "Voice session — 2026-09-14 21:05");
});

test("message metadata tags the source and never stores tool results", async () => {
  const { voiceMessageMetadata } = await load();
  assert.deepEqual(voiceMessageMetadata(), { source: "voice" });
  const metadata = voiceMessageMetadata({
    interrupted: true,
    toolCalls: [
      { name: "vault_read", status: "completed", result: "secret note body", arguments: "{}" },
      { name: "run_powershell", status: "error", result: "output" },
    ],
  });
  assert.deepEqual(metadata, {
    source: "voice",
    interrupted: true,
    toolCalls: [
      { name: "vault_read", status: "completed" },
      { name: "run_powershell", status: "error" },
    ],
  });
});

test("a signed-in user with cloud backup must opt in before a session is stored", async () => {
  const { shouldPersistVoiceSession } = await load();
  assert.equal(shouldPersistVoiceSession({ isSignedIn: false, cloudBackupEnabled: true }), true);
  assert.equal(shouldPersistVoiceSession({ isSignedIn: true, cloudBackupEnabled: false }), true);
  assert.equal(shouldPersistVoiceSession({ isSignedIn: true, cloudBackupEnabled: true }), false);
  assert.equal(
    shouldPersistVoiceSession({ isSignedIn: true, cloudBackupEnabled: true, cloudConsent: true }),
    true
  );
});
