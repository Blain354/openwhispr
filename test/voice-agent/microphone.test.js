const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/voice-agent/shared/microphone.mjs");

// What Chromium reports on the reference machine: the default listed twice under its own label,
// once as `default` and once as the `communications` alias, plus the physical devices.
const DEVICES = [
  {
    kind: "audioinput",
    deviceId: "default",
    label: "Default - Microphone (2- Stealth 600X Gen 3)",
  },
  {
    kind: "audioinput",
    deviceId: "communications",
    label: "Communications - Microphone (2- Stealth 600X Gen 3)",
  },
  { kind: "audioinput", deviceId: "aaa111", label: "Microphone (2- Stealth 600X Gen 3)" },
  { kind: "audioinput", deviceId: "bbb222", label: "Microphone (NVIDIA Broadcast)" },
  { kind: "audiooutput", deviceId: "ccc333", label: "Speakers (NVIDIA Broadcast)" },
];

test("with no preference, the system default is sent under the device's own name", async () => {
  const { microphoneLabel } = await load();
  assert.equal(microphoneLabel({}, DEVICES), "Microphone (2- Stealth 600X Gen 3)");
});

test("a chosen microphone wins over the system default", async () => {
  const { microphoneLabel } = await load();
  assert.equal(
    microphoneLabel(
      { microphoneSelectionMode: "specific", selectedMicDeviceId: "bbb222" },
      DEVICES
    ),
    "Microphone (NVIDIA Broadcast)"
  );
});

test("a chosen microphone that is unplugged falls back to its remembered label", async () => {
  const { microphoneLabel } = await load();
  assert.equal(
    microphoneLabel(
      {
        microphoneSelectionMode: "specific",
        selectedMicDeviceId: "gone",
        selectedMicDeviceLabel: "Microphone (Blue Yeti)",
      },
      DEVICES
    ),
    "Microphone (Blue Yeti)"
  );
});

test("an id set without a mode still counts as a choice", async () => {
  const { microphoneLabel } = await load();
  assert.equal(
    microphoneLabel({ selectedMicDeviceId: "bbb222" }, DEVICES),
    "Microphone (NVIDIA Broadcast)"
  );
});

test("the alias ids are not a choice", async () => {
  const { microphoneLabel } = await load();
  assert.equal(
    microphoneLabel({ selectedMicDeviceId: "communications" }, DEVICES),
    "Microphone (2- Stealth 600X Gen 3)"
  );
});

test("no label is sent when the labels are hidden or there is no microphone", async () => {
  const { microphoneLabel } = await load();
  assert.equal(microphoneLabel({}, []), "");
  assert.equal(microphoneLabel({}, [{ kind: "audioinput", deviceId: "x", label: "" }]), "");
  assert.equal(microphoneLabel(undefined, undefined), "");
});

test("outputs are never picked", async () => {
  const { microphoneLabel } = await load();
  assert.equal(microphoneLabel({}, [DEVICES[4]]), "");
});

test("the Default and Communications prefixes are not part of the device name", async () => {
  const { cleanMicrophoneLabel } = await load();
  assert.equal(cleanMicrophoneLabel("Default - Microphone (X)"), "Microphone (X)");
  assert.equal(cleanMicrophoneLabel("Communications - Microphone (X)"), "Microphone (X)");
  // A device whose real name starts with "Default" keeps it: only the " - " form is a prefix.
  assert.equal(cleanMicrophoneLabel("Default Audio Device"), "Default Audio Device");
});
