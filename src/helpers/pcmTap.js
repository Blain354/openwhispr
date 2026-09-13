import { buildWav } from "../utils/wavBuilder";

export const PCM_TAP_SAMPLE_RATE = 16000;
// Longer recordings fall back to the WebM path: the WAV crosses IPC in one
// message and must stay well inside Electron's comfortable payload size.
export const PCM_TAP_MAX_SECONDS = 240;
const FLUSH_WATCHDOG_MS = 1000;

// A 16 kHz mono PCM16 shadow of the batch MediaRecorder, fed from the same
// stream, so an offline local engine decodes it as-is instead of waiting for
// FFmpeg to unpack WebM/Opus after stop. Reuses the preview worklet processor.
export class PcmTap {
  constructor(stream, workletUrl, { maxSamples = PCM_TAP_SAMPLE_RATE * PCM_TAP_MAX_SECONDS } = {}) {
    this._chunks = [];
    this._samples = 0;
    this._maxSamples = maxSamples;
    this._dropped = false;
    this._node = null;
    this._flushResolve = null;
    this._context = new AudioContext({ sampleRate: PCM_TAP_SAMPLE_RATE });
    this._source = this._context.createMediaStreamSource(stream);
    this._ready = this._context.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        this._node = new AudioWorkletNode(this._context, "pcm-streaming-processor");
        this._node.port.onmessage = (event) => this._onMessage(event.data);
        this._source.connect(this._node);
      })
      .catch(() => {
        this._dropped = true;
      });
  }

  _onMessage(data) {
    if (data === "flushed") {
      this._flushResolve?.();
      return;
    }
    if (this._dropped) return;
    const chunk = new Int16Array(data);
    this._samples += chunk.length;
    if (this._samples > this._maxSamples) {
      this._dropped = true;
      this._chunks = [];
      return;
    }
    this._chunks.push(chunk);
  }

  // Follows the recording onto a replacement microphone.
  rebind(stream) {
    this._source.disconnect();
    this._source = this._context.createMediaStreamSource(stream);
    if (this._node) this._source.connect(this._node);
  }

  // Resolves to the capture as a WAV blob, or null when the copy was dropped
  // (worklet failed to load, recording too long, or the flush never arrived).
  async stop() {
    await this._ready;
    if (this._node && !this._dropped) {
      let watchdog;
      const flushed = new Promise((resolve) => {
        this._flushResolve = () => resolve(true);
        watchdog = setTimeout(() => resolve(false), FLUSH_WATCHDOG_MS);
      });
      this._node.port.postMessage("stop");
      if (!(await flushed)) this._dropped = true;
      clearTimeout(watchdog);
    }
    const { _chunks: chunks, _samples: total } = this;
    this.close();
    if (this._dropped || total === 0) return null;
    const samples = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return buildWav(samples, PCM_TAP_SAMPLE_RATE);
  }

  close() {
    this._chunks = [];
    this._samples = 0;
    this._node?.disconnect();
    this._source.disconnect();
    this._context.close().catch(() => {});
  }
}
