const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The PCM tap must follow the batch recorder exactly: handed over at finalize,
// released on cancel, and carried onto a replacement microphone.

async function load(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-pcm-tap-lifecycle-test-",
    settingsKey: "__pcmTapLifecycleSettings",
  });
  return AudioManager;
}

const webm = () => new Blob([new Uint8Array(512)], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array(4)], { type: "audio/wav" });

function finalizingManager(AudioManager, tap) {
  let handoff = null;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [],
    _batchPcmTap: tap,
    _receivedAudioData: true,
    _localSpeechGateState: null,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    lastAudioBlob: null,
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: async () => webm(),
    getLargestRecordedSegment: () => null,
    processAudio: async (blob, metadata) => {
      handoff = { blob, metadata };
    },
    onStateChange() {},
    _requestStreamingCancellation() {},
  });
  return { manager, handoff: () => handoff };
}

test("finalize waits for the tap and hands its WAV over beside the WebM", async (t) => {
  const AudioManager = await load(t);
  const rawWav = wav();
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => rawWav });

  await manager.finalizeBatchRecording(webm());

  assert.equal(handoff().blob.type, "audio/webm", "the WebM remains the recording of record");
  assert.strictEqual(handoff().metadata.rawWav, rawWav);
  assert.equal(manager._batchPcmTap, null);
});

test("a dropped tap leaves the WebM path exactly as before", async (t) => {
  const AudioManager = await load(t);
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => null });

  await manager.finalizeBatchRecording(webm());

  assert.equal("rawWav" in handoff().metadata, false);
});

test("cancelling a recording releases the tap", async (t) => {
  const AudioManager = await load(t);
  let closes = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _batchPcmTap: { close: () => (closes += 1) },
    teardownSpeechGate() {},
    cleanupPreview() {},
    onStateChange() {},
  });

  manager.resetDiscardedBatchRecordingState();

  assert.equal(closes, 1);
  assert.equal(manager._batchPcmTap, null);
});

test("a replacement microphone is bound into the same tap", async (t) => {
  const AudioManager = await load(t);
  const replacement = { id: "headset" };
  const rebound = [];
  const recorders = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    mediaRecorder: { state: "inactive" },
    _silenceSource: null,
    _silenceCtx: null,
    _previewSource: null,
    _previewAudioContext: null,
    _batchPcmTap: { rebind: (stream) => rebound.push(stream) },
    _cancelRequestedDuringMicRecovery: false,
    _stopRequestedDuringMicRecovery: false,
    createBatchRecorder: (stream) => recorders.push(stream),
  });

  await manager.replaceBatchMic(replacement);

  assert.deepEqual(rebound, [replacement]);
  assert.deepEqual(recorders, [replacement]);
});
