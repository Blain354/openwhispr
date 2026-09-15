/**
 * Which microphone the app itself listens to, as a label the voice sidecar can match.
 *
 * The sidecar opens a device by name through PyAudio, whose default is the system's — not
 * necessarily the one OpenWhispr resolved for dictation. Sending the label keeps the two on the
 * same microphone; a label that matches nothing is reported rather than silently ignored.
 *
 * Chromium lists the system default twice, once under `default` and once under the
 * `communications` alias, both carrying the device's own label, sometimes prefixed with
 * "Default - ". The prefix is not part of the device name and is stripped.
 */

const ALIAS_IDS = new Set(["default", "communications"]);

/** @param {unknown} label */
export function cleanMicrophoneLabel(label) {
  return String(label ?? "")
    .replace(/^\s*(?:default|communications)\s+-\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{ microphoneSelectionMode?: string, selectedMicDeviceId?: string,
 *           selectedMicDeviceLabel?: string }} settings
 * @param {Array<{ kind?: string, deviceId?: string, label?: string }>} devices
 * @returns {string} the device label, or "" to let the sidecar use the system default
 */
export function microphoneLabel(settings = {}, devices = []) {
  const inputs = (Array.isArray(devices) ? devices : []).filter(
    (device) => device?.kind === "audioinput"
  );
  const chosenId = settings?.selectedMicDeviceId;
  const mode =
    settings?.microphoneSelectionMode ||
    (chosenId && !ALIAS_IDS.has(chosenId) ? "specific" : "system");

  if (mode === "specific") {
    const chosen = inputs.find((device) => device.deviceId === chosenId);
    const label = cleanMicrophoneLabel(chosen?.label || settings?.selectedMicDeviceLabel);
    if (label) return label;
  }

  const systemDefault =
    inputs.find((device) => device.deviceId === "default") ||
    inputs.find((device) => !ALIAS_IDS.has(device.deviceId ?? "")) ||
    inputs[0];
  return cleanMicrophoneLabel(systemDefault?.label);
}
