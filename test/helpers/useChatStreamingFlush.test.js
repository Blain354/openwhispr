const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Both chat surfaces re-parse the whole answer through react-markdown on
// every content write, so one write per streamed token made parse cost scale
// with token count. The hook buffers streamed text and flushes it at most
// once per interval; every exit from the stream loop flushes synchronously
// first. This drives the REAL hook the same way
// useChatStreamingCancellation.test.js does (one synchronous render, then
// the returned closures), with setMessages counting content writes.
function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-cancellation-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function renderChatStreaming(
  t,
  { electronAPI = {}, settings = {}, onStreamComplete, live = false } = {}
) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = live ? installHookDom(t) : null;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-flush-test-",
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  // A self-hosted (LAN) chat agent with no tools in play: 4B+ in the model
  // name makes it tool-eligible by the size heuristic, but the fixture
  // fetch never emits a tool call, so it stays on the plain-content path.
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: false,
    ...settings,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  // useChatStreaming imports ReasoningService.ts, whose default export is a
  // singleton constructed at import time; its API-key cache starts a real
  // setInterval that otherwise keeps the process alive after the test ends.
  t.after(() => reasoningService.destroy());

  let messages = [];
  let responseContentCalls = 0;
  let contentWrites = 0;
  const setMessages = (updater) => {
    const next = typeof updater === "function" ? updater(messages) : updater;
    const prevAssistant = messages.find((m) => m.role === "assistant");
    const nextAssistant = next.find((m) => m.role === "assistant");
    if (prevAssistant && nextAssistant && prevAssistant.content !== nextAssistant.content) {
      contentWrites += 1;
    }
    messages = next;
  };

  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      onStreamComplete,
      onResponseContent: () => {
        responseContentCalls += 1;
      },
    });
    return null;
  }

  let unmount;
  if (live) {
    const { createRoot } = require("react-dom/client");
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    let unmounted = false;
    unmount = async () => {
      if (unmounted) return;
      unmounted = true;
      await React.act(async () => root.unmount());
    };
    t.after(unmount);
  } else {
    renderToStaticMarkup(React.createElement(Harness));
  }

  return {
    captured,
    getMessages: () => messages,
    getResponseContentCalls: () => responseContentCalls,
    getContentWrites: () => contentWrites,
    unmount,
  };
}

const ERROR_PREFIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).agentMode.chat.errorPrefix;

function sseEvent(delta, finishReason = null) {
  return `data: ${JSON.stringify(createOpenAiChunk(delta, finishReason))}\n\n`;
}

function stubFetch(t, body) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("fifty streamed tokens produce a handful of content writes, and the final text is intact", async (t) => {
  const deltas = Array.from({ length: 50 }, (_, i) => `tok${i} `);
  stubFetch(
    t,
    deltas.map((text) => sseEvent({ content: text })).join("") + sseEvent({}, "stop") + "data: [DONE]\n\n"
  );
  const harness = await renderChatStreaming(t);

  await harness.captured.sendToAI("count to fifty", harness.getMessages());

  const assistant = harness.getMessages().find((m) => m.role === "assistant");
  assert.equal(assistant.content, deltas.join(""), "every token is in the final text");
  assert.equal(assistant.isStreaming, false);
  assert.ok(
    harness.getContentWrites() <= 3,
    `expected at most 3 content writes for 50 tokens, got ${harness.getContentWrites()}`
  );
});

// Guard, not fail-first: on main there is no timer to cancel, so this passes
// there too. It pins the cancel in the catch block — a flush firing after the
// error text was written would replace the error with the partial reply.
test("a stream that fails after a token shows the error, not a late partial flush", async (t) => {
  const encoder = new TextEncoder();
  stubFetch(
    t,
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent({ content: "tok0 " })));
      },
      // Erroring inside start() would discard the queued token, and erroring
      // synchronously in pull() aborts the SDK's parsing pipe before the parsed
      // token is read. One real tick lets the token reach the hook first.
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.error(new Error("boom"));
      },
    })
  );
  const harness = await renderChatStreaming(t);

  await harness.captured.sendToAI("fail please", harness.getMessages());
  await new Promise((resolve) => setTimeout(resolve, 60)); // longer than the flush interval

  const assistant = harness.getMessages().find((m) => m.role === "assistant");
  assert.ok(assistant.content.startsWith(`${ERROR_PREFIX}:`), `error text shown, got ${JSON.stringify(assistant.content)}`);
  assert.equal(assistant.isStreaming, false);
});
