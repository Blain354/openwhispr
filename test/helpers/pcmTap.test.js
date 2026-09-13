const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/pcmTap.js");

function installFakes(t, { failModule = false } = {}) {
  const contexts = [];
  const nodes = [];
  class FakeAudioContext {
    constructor({ sampleRate }) {
      this.sampleRate = sampleRate;
      this.sources = [];
      this.closed = 0;
      this.audioWorklet = {
        addModule: async () => {
          if (failModule) throw new Error("no worklet");
        },
      };
      contexts.push(this);
    }
    createMediaStreamSource(stream) {
      const source = {
        stream,
        connected: null,
        connect(node) {
          this.connected = node;
        },
        disconnect() {
          this.connected = null;
        },
      };
      this.sources.push(source);
      return source;
    }
    async close() {
      this.closed += 1;
    }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message === "stop") queueMicrotask(() => this.port.onmessage?.({ data: "flushed" }));
        },
      };
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  });
  return { contexts, nodes };
}

const ready = () => new Promise((resolve) => setImmediate(resolve));
const chunk = (values) => ({ data: Int16Array.from(values).buffer });

async function decodeWav(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return {
    header: bytes.subarray(0, 44),
    samples: Array.from(
      new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2)
    ),
  };
}

test("stop returns a 16 kHz mono PCM16 WAV of every chunk in order", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const tap = new PcmTap({ id: "mic" }, "blob:worklet");
  await ready();

  nodes[0].port.onmessage(chunk([1, 2, 3]));
  nodes[0].port.onmessage(chunk([4, 5]));
  const { header, samples } = await decodeWav(await tap.stop());

  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt16LE(22), 1, "mono");
  assert.equal(header.readUInt32LE(24), 16000, "16 kHz");
  assert.equal(header.readUInt16LE(34), 16, "PCM16");
  assert.deepEqual(samples, [1, 2, 3, 4, 5]);
  assert.equal(contexts[0].sampleRate, 16000);
  assert.equal(contexts[0].closed, 1);
});

test("a recording past the cap yields no copy", async (t) => {
  const { nodes } = installFakes(t);
  const { PcmTap } = await load();
  const tap = new PcmTap({ id: "mic" }, "blob:worklet", { maxSamples: 4 });
  await ready();

  nodes[0].port.onmessage(chunk([1, 2, 3]));
  nodes[0].port.onmessage(chunk([4, 5]));
  nodes[0].port.onmessage(chunk([6]));

  assert.equal(await tap.stop(), null);
});

test("a worklet that fails to load yields no copy and still releases the context", async (t) => {
  const { contexts } = installFakes(t, { failModule: true });
  const { PcmTap } = await load();
  const tap = new PcmTap({ id: "mic" }, "blob:worklet");

  assert.equal(await tap.stop(), null);
  assert.equal(contexts[0].closed, 1);
});

test("rebind follows the recording onto a replacement microphone", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const replacement = { id: "headset" };
  const tap = new PcmTap({ id: "mic" }, "blob:worklet");
  await ready();

  tap.rebind(replacement);
  const [original, rebound] = contexts[0].sources;

  assert.equal(original.connected, null);
  assert.equal(rebound.stream, replacement);
  assert.equal(rebound.connected, nodes[0]);
  tap.close();
});

test("close discards the copy and releases the context", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const tap = new PcmTap({ id: "mic" }, "blob:worklet");
  await ready();
  nodes[0].port.onmessage(chunk([1, 2]));

  tap.close();

  assert.equal(contexts[0].closed, 1);
  assert.equal(await tap.stop(), null);
});
