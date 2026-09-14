const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { estimateTokens } = require("../../src/helpers/llamaContextPolicy");

// A note that does not fit the local model's window is summarised in parts and
// then merged (#2142 part 3). Everything that fits keeps today's single call.

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };
const LINE = "Alice: we agreed to ship the billing migration on Friday after QA.\n";
const BIG_BUDGET = { success: true, maxContextTokens: 131072, modelName: "Qwen3.5 9B" };
// 8192 leaves roughly 4,400 tokens per part after the part prompt and output reserve.
const SMALL_BUDGET = { success: true, maxContextTokens: 8192, modelName: "Qwen3.5 9B" };

async function loadStore(
  t,
  { budget = SMALL_BUDGET, mode = "local", failFirst = false, processText } = {}
) {
  const updates = [];
  const budgetCalls = [];
  installBrowserGlobals(t, {
    // The real settings store reads the route from storage at load time.
    initialStorage: { noteFormattingMode: mode, noteFormattingUseLocal: "true" },
    window: {
      electronAPI: {
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: true };
        },
        getLocalContextBudget: async (modelId) => {
          budgetCalls.push(modelId);
          if (budget instanceof Error) throw budget;
          return budget;
        },
      },
    },
  });

  const calls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-chunked-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default {
          processText: async (text, model, agentName, config) => {
            const calls = globalThis.__processTextCalls;
            calls.push({ text, model, config });
            if (globalThis.__failFirst && calls.length === 1) {
              const error = new Error("too big");
              error.code = "CONTEXT_TOO_LARGE";
              throw error;
            }
            if (globalThis.__cancelAfter && calls.length === globalThis.__cancelAfter.after) {
              globalThis.__cancelAfter.cancel();
            }
            if (globalThis.__chunkedProcessText) {
              return globalThis.__chunkedProcessText(text, config, calls.length);
            }
            return "# Part notes " + calls.length + "\\n- decided things";
          },
        };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  globalThis.__processTextCalls = calls;
  globalThis.__failFirst = failFirst;
  globalThis.__chunkedProcessText = processText;
  t.after(() => {
    delete globalThis.__processTextCalls;
    delete globalThis.__failFirst;
    delete globalThis.__cancelAfter;
    delete globalThis.__chunkedProcessText;
  });

  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  return { store, calls, updates, budgetCalls };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const longMaterial = (lines) => ({
  notes: "My own note: watch the QA date.",
  meetingContext: "## Meeting Context\nThe user taking these notes is Alice.",
  transcript: LINE.repeat(lines).trim(),
});

const PRODUCTION_BUDGET = { ...SMALL_BUDGET, maxContextTokens: 16384 };
const contextOverflow = () => Object.assign(new Error("too big"), { code: "CONTEXT_TOO_LARGE" });
const isMerge = (config) => config.systemPrompt.includes("Treat them together");

async function waitForResult(store, updates) {
  await waitFor(
    () => updates.length > 0 || store.useActionProcessingStore.getState().errorEvents.length > 0,
    "save or error"
  );
  assert.deepEqual(store.useActionProcessingStore.getState().errorEvents, []);
  assert.equal(updates.length, 1);
}

test("an exact overflow at the final merge consolidates and saves the recovered result", async (t) => {
  let merges = 0;
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) {
        if (++merges === 1) throw contextOverflow();
        return "Recovered notes: ship Friday after QA.";
      }
      return text.includes("Working notes")
        ? "Ship Friday after QA."
        : "QA gates the Friday release.";
    },
  });
  run(store, 20, longMaterial(1200));
  await waitForResult(store, updates);
  assert.equal(merges, 2);
  assert.ok(calls.some(({ text }) => text.includes("Working notes")));
  assert.equal(updates[0].payload.enhanced_content, "Recovered notes: ship Friday after QA.");
});

test("a large manual body is reduced even when the transcript is only one line", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) =>
      isMerge(config) ? "Friday release; Alice opened the meeting." : "Friday release after QA.",
  });
  const material = {
    notes: LINE.repeat(600),
    meetingContext: "## Meeting Context\nThe note owner is Alice.",
    transcript: "Alice: Let us begin.",
  };
  run(store, 21, material);
  await waitForResult(store, updates);
  const reductions = calls.filter(({ text }) => text.includes("Working notes"));
  assert.ok(reductions.length > 1, "the manual body needs several bounded requests");
  assert.equal(
    reductions
      .map(({ text }) => text)
      .join("\n")
      .split(LINE.trim()).length - 1,
    600,
    "every manual-note line reaches the reducer"
  );
  assert.ok(calls.every(({ text }) => text.includes(material.meetingContext)));
  assert.ok(
    calls.every(
      ({ text, config }) =>
        estimateTokens(text) + estimateTokens(config.systemPrompt) + config.maxTokens + 512 <=
        PRODUCTION_BUDGET.maxContextTokens
    ),
    "manual-note reduction and merge requests respect the context budget"
  );
  assert.equal(updates[0].payload.enhanced_at_content_hash, "hash");
});

test("a shorter single-section reduction is tried before refusing a long custom action", async (t) => {
  let parts = 0;
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) return "The custom action succeeded.";
      return ++parts === 1 ? "note ".repeat(1680) : "Short notes.";
    },
  });
  const action = { ...ACTION, prompt: "Template instruction. ".repeat(1300) };
  store.runBackgroundAction(
    22,
    "word ".repeat(2100),
    "hash",
    action,
    { modelId: "qwen3.5-9b-q4_k_m", isCloudMode: false },
    LABELS
  );
  await waitForResult(store, updates);
  assert.equal(parts, 2);
  assert.equal(calls.length, 3);
  assert.equal(updates[0].payload.enhancement_prompt, action.prompt);
});

test("the result of the third reduction round still gets a final merge", async (t) => {
  let merges = 0;
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) {
        if (++merges <= 3) throw contextOverflow();
        return "Final notes.";
      }
      return "Detailed working notes.";
    },
  });
  run(store, 23, longMaterial(1200));
  await waitForResult(store, updates);
  assert.equal(merges, 4);
  assert.equal(calls.filter(({ text }) => text.includes("Working notes")).length, 3);
});

test("repeated merge overflows stop after three reduction rounds without saving", async (t) => {
  let merges = 0;
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) {
        merges += 1;
        throw contextOverflow();
      }
      return "Working notes.";
    },
  });
  run(store, 24, longMaterial(1200));
  await waitFor(() => store.useActionProcessingStore.getState().errorEvents.length > 0, "refusal");
  assert.equal(merges, 4);
  assert.equal(calls.filter(({ text }) => text.includes("Working notes (part")).length, 3);
  assert.equal(updates.length, 0);
});

test("a non-context merge error is surfaced without consolidation", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) throw new Error("local server disconnected");
      return "Part notes.";
    },
  });
  run(store, 25, longMaterial(1200));
  await waitFor(() => store.useActionProcessingStore.getState().errorEvents.length > 0, "error");
  assert.equal(calls.filter(({ text }) => text.includes("Working notes")).length, 0);
  assert.equal(updates.length, 0);
  assert.equal(store.consumeErrorEvents()[0].message, "local server disconnected");
});

test("cancelling a rejected merge prevents recovery requests and note persistence", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) {
        store.cancelAction(26);
        throw contextOverflow();
      }
      return "Part notes.";
    },
  });
  run(store, 26, longMaterial(1200));
  await waitFor(() => calls.some(({ config }) => isMerge(config)), "merge cancellation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(({ text }) => text.includes("Working notes")).length, 0);
  assert.equal(updates.length, 0);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("unbroken CJK parts recover from exact overflow without losing any input", async (t) => {
  const successfulLengths = [];
  const { store, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: (text, config) => {
      if (isMerge(config)) return "Recovered CJK notes.";
      const length = (text.match(/𠀀/gu) || []).length;
      if (length > 4000) throw contextOverflow();
      successfulLengths.push(length);
      return `Notes from ${length} characters.`;
    },
  });
  run(store, 27, { notes: "", meetingContext: "", transcript: "𠀀".repeat(14000) });
  await waitForResult(store, updates);
  assert.ok(successfulLengths.length > 2);
  assert.ok(successfulLengths.every((length) => length > 0 && length <= 4000));
  assert.equal(
    successfulLengths.reduce((total, length) => total + length, 0),
    14000
  );
  assert.equal(updates[0].payload.enhanced_content, "Recovered CJK notes.");
});

test("cancelling a rejected part prevents recursive retry requests", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: PRODUCTION_BUDGET,
    processText: () => {
      store.cancelAction(28);
      throw contextOverflow();
    },
  });
  run(store, 28, longMaterial(1200));
  await waitFor(() => calls.length > 0, "part cancellation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 0);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

const run = (store, noteId, material, options = {}) =>
  store.runBackgroundAction(
    noteId,
    [material.notes, material.meetingContext, `## Meeting Transcript\n${material.transcript}`].join(
      "\n\n"
    ),
    "hash",
    ACTION,
    { modelId: "qwen3.5-9b-q4_k_m", isCloudMode: false, isMeetingNote: true, material, ...options },
    LABELS
  );

test("material that fits is one request with today's prompt, after one budget read", async (t) => {
  const { store, calls, updates, budgetCalls } = await loadStore(t, { budget: BIG_BUDGET });
  run(store, 1, longMaterial(20));
  await waitFor(() => updates.length > 0, "save");
  assert.equal(calls.length, 1);
  assert.deepEqual(budgetCalls, ["qwen3.5-9b-q4_k_m"]);
  assert.ok(calls[0].text.includes("## Meeting Transcript"));
  assert.ok(calls[0].config.systemPrompt.endsWith("Summarize the meeting."));
  assert.equal(calls[0].config.maxTokens, 4096);
});

test("cloud mode never reads the budget and never chunks", async (t) => {
  const { store, calls, updates, budgetCalls } = await loadStore(t, { mode: "openwhispr" });
  run(store, 2, longMaterial(400), { isCloudMode: true });
  await waitFor(() => updates.length > 0, "save");
  assert.equal(calls.length, 1);
  assert.deepEqual(budgetCalls, []);
});

test("material over the ceiling is summarised in parts, then merged with the action prompt", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  const material = longMaterial(400);
  run(store, 3, material);
  await waitFor(() => updates.length > 0, "save");

  const parts = calls.slice(0, -1);
  const final = calls[calls.length - 1];
  assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
  parts.forEach((call, index) => {
    assert.ok(
      call.text.includes(material.meetingContext),
      "every part carries the meeting context"
    );
    assert.ok(
      call.text.includes(`part ${index + 1} of ${parts.length}`),
      `part ${index + 1} labelled`
    );
    assert.ok(!call.text.includes(material.notes), "manual notes are held for the final pass");
    assert.ok(
      /this part only/i.test(call.config.systemPrompt),
      "part prompt is the part-notes prompt"
    );
    assert.equal(call.config.maxTokens, 2048);
  });
  assert.ok(
    final.config.systemPrompt.includes("Summarize the meeting."),
    "final pass uses the action prompt"
  );
  assert.ok(final.text.includes(material.notes), "final pass carries the manual notes");
  assert.ok(final.text.includes(material.meetingContext));
  for (let index = 1; index <= parts.length; index += 1) {
    assert.ok(
      final.text.includes(`## Notes from part ${index} of ${parts.length}`),
      `part ${index} notes present`
    );
    assert.ok(final.text.includes(`# Part notes ${index}`));
  }
  assert.ok(!final.text.includes("Alice: we agreed"), "final pass never sees the raw transcript");
  assert.equal(
    updates[0].payload.enhanced_content,
    `# Part notes ${calls.length}\n- decided things`
  );
});

test("a failed budget read falls back to today's single request", async (t) => {
  const { store, calls, updates } = await loadStore(t, { budget: new Error("ipc down") });
  run(store, 4, longMaterial(400));
  await waitFor(() => updates.length > 0, "save");
  assert.equal(calls.length, 1);
});

test("a single request refused as CONTEXT_TOO_LARGE falls through to chunking", async (t) => {
  const { store, calls, updates } = await loadStore(t, { budget: BIG_BUDGET, failFirst: true });
  run(store, 5, longMaterial(20));
  await waitFor(() => updates.length > 0, "save");
  assert.ok(calls.length >= 3, `expected the refused call, parts and a merge, got ${calls.length}`);
  assert.ok(/this part only/i.test(calls[1].config.systemPrompt));
});

test("cancelling between parts stops further requests and saves nothing", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  globalThis.__cancelAfter = { after: 1, cancel: () => store.cancelAction(6) };
  run(store, 6, longMaterial(400));
  await waitFor(() => calls.length >= 1, "first part");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 0);
});

test("progress counts parts and ends on the final pass", async (t) => {
  const { store, updates } = await loadStore(t);
  const seen = [];
  const unsubscribe = store.useActionProcessingStore.subscribe((state) => {
    const progress = state.noteStates[7]?.progress;
    if (progress) seen.push(`${progress.step}/${progress.total}`);
  });
  t.after(unsubscribe);
  run(store, 7, longMaterial(400));
  await waitFor(() => updates.length > 0, "save");
  assert.ok(seen.length >= 2, `saw ${JSON.stringify(seen)}`);
  const [step, total] = seen[seen.length - 1].split("/").map(Number);
  assert.equal(step, total);
  assert.equal(seen[0], `1/${total}`);
});
