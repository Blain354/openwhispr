const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { buildGguf, LLAMA_3_2_3B_ENTRIES } = require("../helpers/harness/ggufFixtures");
const registry = require("../../src/models/modelRegistryData.json");

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };
const FINAL_NOTES = "## Decisions\nShip on Friday.\n\n## Action Items\n- [ ] Review QA — Alice";
const TRANSCRIPT_LINE = "Alice: ship the billing migration on Friday after Bob finishes QA.\n";
const MANUAL_NOTE = "Keep the release checklist attached.";
const RECORD_MARKERS = ["EARLY_ITEM", "LATE_ITEM", MANUAL_NOTE];
const CHAIN_MODULES = [
  "../../src/services/localReasoningBridge.js",
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));

function loadLocalChain(home) {
  for (const modulePath of CHAIN_MODULES) delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function loadWithElectron(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name) => (name === "home" ? home : path.join(home, name)),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require("../../src/helpers/modelDirUtils.js");
    return {
      bridge: require("../../src/services/localReasoningBridge.js").default,
      modelManager: require("../../src/helpers/modelManagerBridge.js").default,
    };
  } finally {
    Module._load = originalLoad;
  }
}

// Everything between the renderer store and the HTTP model boundary is real.
// The Electron adapter mirrors the IPC result envelope; model tokens and
// completions are fixtures, so this verifies recovery, not model quality.
async function setup(t, { rejectFirstMerge = false, rejectUnbroken = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-note-local-chain-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { bridge, modelManager } = loadLocalChain(home);
  const model = registry.localProviders
    .flatMap((provider) => provider.models)
    .find((candidate) => candidate.id === "llama-3.2-3b-instruct-q4_k_m");
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  const modelPath = path.join(modelManager.modelsDir, model.fileName);
  await fs.writeFile(
    modelPath,
    Buffer.concat([buildGguf(LLAMA_3_2_3B_ENTRIES), Buffer.alloc(1_000_001, 1)])
  );
  modelManager._systemMemoryBytes = () => 8 * 1024 * 1024 * 1024;

  const completions = [];
  const measurements = [];
  const failures = [];
  const budgets = [];
  let mergeRejected = false;
  const serverManager = modelManager.serverManager;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      let payload;
      if (request.url === "/props") {
        payload = { default_generation_settings: { n_ctx: serverManager.contextSize } };
      } else if (request.url === "/apply-template") {
        payload = { prompt: JSON.stringify(body.messages) };
      } else if (request.url === "/tokenize") {
        const messages = JSON.parse(body.content);
        const system = messages[0].content;
        const content = messages[1].content;
        const isMerge = content.includes("## Notes from part");
        let count = 4000;
        if (rejectFirstMerge && isMerge && !mergeRejected) {
          mergeRejected = true;
          count = 16000; // Only 384 tokens remain: the real preflight must refuse.
        } else if (
          (rejectUnbroken &&
            Array.from(content).filter((character) => character === "𠀀").length > 4000) ||
          (!system.includes("one consecutive part") && content.length > 45000)
        ) {
          count = 20000;
        }
        measurements.push({ content, count });
        payload = { tokens: new Array(count).fill(0) };
      } else if (request.url === "/v1/chat/completions") {
        completions.push(body);
        const system = body.messages[0].content;
        const content = body.messages[1].content;
        const isPart = system.includes("one consecutive part");
        const isConsolidation = content.includes("Working notes (part");
        const preserved = RECORD_MARKERS.filter((marker) => content.includes(marker)).join("\n");
        const text = system.startsWith("Generate a concise")
          ? "Billing Migration QA Plan"
          : isPart
            ? isConsolidation || !rejectFirstMerge
              ? "## Decisions\nAlice: ship on Friday after Bob completes QA.\n" + preserved
              : "## Topics\n" + "detail ".repeat(1200) + "\n" + preserved
            : FINAL_NOTES + (rejectFirstMerge ? "\n" + preserved : "");
        payload = { choices: [{ finish_reason: "stop", message: { content: text } }] };
      } else {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  serverManager.cachedServerBinaryPaths = { default: "/fixture/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  serverManager.contextSize = 16384;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  const updates = [];
  installBrowserGlobals(t, {
    initialStorage: {
      noteFormattingMode: "local",
      noteFormattingUseLocal: "true",
      noteFormattingDisableThinking: "true",
      autoGenerateNoteTitle: "true",
      cleanupMode: "providers",
      cleanupProvider: "openai",
    },
    window: {
      electronAPI: {
        getLogLevel: async () => "fatal",
        getLocalContextBudget: async (modelId) => {
          const modelInfo = modelManager.findModelById(modelId);
          const { ceiling } = await modelManager.contextCeiling(modelInfo, modelPath);
          budgets.push(ceiling);
          return { success: true, maxContextTokens: ceiling, modelName: model.name };
        },
        processLocalReasoning: async (text, modelId, agentName, config) => {
          try {
            return { success: true, text: await bridge.processText(text, modelId, config) };
          } catch (error) {
            const failure = {
              success: false,
              error: error.message,
              code: error.code,
              details: error.details,
            };
            failures.push(failure);
            return failure;
          }
        },
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  t.after(() => store.cancelAction(1));
  return { store, model, budgets, completions, measurements, failures, updates, serverManager };
}

async function runToCompletion(fixture, material, options = {}) {
  fixture.store.runBackgroundAction(
    1,
    [material.notes, material.meetingContext, `## Meeting Transcript\n${material.transcript}`].join(
      "\n\n"
    ),
    "original-content-hash",
    ACTION,
    { modelId: fixture.model.id, isCloudMode: false, isMeetingNote: true, material, ...options },
    LABELS
  );
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const errors = fixture.store.useActionProcessingStore.getState().errorEvents;
    assert.deepEqual(errors, [], "local recovery must not end in an error toast");
    if (fixture.updates.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("note generation did not reach persistence");
}

test("an exact merge overflow consolidates through the local chain and saves the note", async (t) => {
  const fixture = await setup(t, { rejectFirstMerge: true });
  const material = {
    notes: MANUAL_NOTE,
    meetingContext: "## Meeting Context\nThe note owner is Alice. Bob is invited.",
    transcript: "Alice: EARLY_ITEM\n" + TRANSCRIPT_LINE.repeat(800) + "Bob: LATE_ITEM\n",
  };
  await runToCompletion(fixture, material, {
    allowTitleGeneration: true,
    knownPeople: [{ name: "Alice", email: "alice@example.com" }],
  });

  assert.deepEqual(fixture.budgets, [16384]);
  assert.equal(
    fixture.serverManager.contextSize,
    16384,
    "recovery must respect the memory ceiling"
  );
  assert.ok(
    fixture.measurements.some(
      ({ content, count }) => count === 16000 && content.includes("## Notes from part")
    )
  );
  assert.ok(
    fixture.failures.some(
      ({ code, details }) => code === "CONTEXT_TOO_LARGE" && details.maxContextTokens === 16384
    )
  );
  assert.ok(
    fixture.completions.some(({ messages }) => messages[1].content.includes("Working notes (part"))
  );
  const final = fixture.completions.find(({ messages }) =>
    messages[1].content.includes("## Notes from part")
  );
  assert.ok(final.messages[1].content.includes(material.notes));
  assert.ok(final.messages[1].content.includes(material.meetingContext));
  for (const marker of RECORD_MARKERS) {
    assert.ok(
      final.messages[1].content.includes(marker),
      `the final request must retain ${marker}`
    );
  }
  assert.equal(final.max_tokens, 4096);
  for (const completion of fixture.completions) {
    assert.deepEqual(completion.chat_template_kwargs, { enable_thinking: false });
  }
  assert.deepEqual(fixture.updates, [
    {
      noteId: 1,
      payload: {
        enhanced_content:
          "## Decisions\nShip on Friday.\n\n## Action Items\n- [ ] Review QA — [@Alice](mention:alice%40example.com)\nEARLY_ITEM\nLATE_ITEM\nKeep the release checklist attached.",
        enhancement_prompt: ACTION.prompt,
        enhanced_at_content_hash: "original-content-hash",
        title: "Billing Migration QA Plan",
      },
    },
  ]);
});

test("a fitting note still uses one local completion and leaves its title untouched", async (t) => {
  const fixture = await setup(t);
  await runToCompletion(fixture, {
    notes: "Remember QA.",
    meetingContext: "## Meeting Context\nAlice and Bob.",
    transcript: TRANSCRIPT_LINE,
  });
  assert.equal(fixture.completions.length, 1);
  assert.equal(fixture.completions[0].max_tokens, 4096);
  assert.equal(fixture.updates[0].payload.enhanced_content, FINAL_NOTES);
  assert.equal(Object.hasOwn(fixture.updates[0].payload, "title"), false);
  assert.deepEqual(fixture.failures, []);
});

test("an unbroken Unicode part rejected by the model is split and eventually saved", async (t) => {
  const fixture = await setup(t, { rejectUnbroken: true });
  await runToCompletion(fixture, {
    notes: "",
    meetingContext: "",
    transcript: "𠀀".repeat(14000),
  });
  assert.ok(fixture.failures.some(({ code }) => code === "CONTEXT_TOO_LARGE"));
  const parts = fixture.completions.filter(({ messages }) =>
    messages[0].content.includes("one consecutive part")
  );
  assert.ok(parts.length >= 4, "the rejected unbroken input must become smaller requests");
  const submittedCodepoints = parts
    .flatMap(({ messages }) => Array.from(messages[1].content))
    .filter((character) => character === "𠀀");
  assert.equal(submittedCodepoints.length, 14000, "splitting must preserve every source codepoint");
  assert.equal(fixture.updates[0].payload.enhanced_content, FINAL_NOTES);
});
