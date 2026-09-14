const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { createConversationWsServer } = require("../../src/voice-agent/main/wsServer");

// A range away from the app's own (8241-8260) so a running dev instance does not interfere.
const TEST_RANGE = [18241, 18260];

function connect(url, options = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve({ socket, opened: true }));
    socket.once("unexpected-response", (_req, res) =>
      resolve({ socket, opened: false, status: res.statusCode })
    );
    socket.once("error", (error) => resolve({ socket, opened: false, error: error.message }));
  });
}

async function startServer(t, handlers = {}) {
  const server = createConversationWsServer({ portRange: TEST_RANGE, ...handlers });
  const { port, token } = await server.start();
  t.after(() => server.stop());
  return { server, port, token, url: `ws://127.0.0.1:${port}` };
}

test("a client with the token connects and exchanges messages", async (t) => {
  const received = [];
  const { server, url, token } = await startServer(t, { onMessage: (m) => received.push(m) });
  const { socket, opened } = await connect(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(opened, true);
  socket.send('{"v":1,"type":"hello","data":{}}');
  const echoed = new Promise((resolve) =>
    socket.once("message", (data) => resolve(data.toString()))
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.isConnected(), true);
  assert.equal(server.send('{"v":1,"type":"ping","data":{}}'), true);
  assert.equal(await echoed, '{"v":1,"type":"ping","data":{}}');
  assert.deepEqual(received, ['{"v":1,"type":"hello","data":{}}']);
  socket.close();
});

test("a wrong or missing token is refused before the upgrade", async (t) => {
  const { url } = await startServer(t);
  const wrong = await connect(url, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
  assert.equal(wrong.opened, false);
  assert.equal(wrong.status, 401);
  const missing = await connect(url);
  assert.equal(missing.opened, false);
  assert.equal(missing.status, 401);
});

test("a browser-style connection with an Origin header is refused even with the token", async (t) => {
  const { url, token } = await startServer(t);
  const result = await connect(url, {
    headers: { Authorization: `Bearer ${token}` },
    origin: "http://localhost:5183",
  });
  assert.equal(result.opened, false);
  assert.equal(result.status, 401);
});

test("a Host header other than the listening address is refused (DNS rebinding)", async (t) => {
  const { url, token } = await startServer(t);
  const result = await connect(url, {
    headers: { Authorization: `Bearer ${token}`, Host: "evil.example:80" },
  });
  assert.equal(result.opened, false);
  assert.equal(result.status, 401);
});

test("a second client replaces the first", async (t) => {
  const { url, token } = await startServer(t);
  const headers = { Authorization: `Bearer ${token}` };
  const first = await connect(url, { headers });
  const closed = new Promise((resolve) => first.socket.once("close", (code) => resolve(code)));
  const second = await connect(url, { headers });
  assert.equal(second.opened, true);
  assert.equal(await closed, 4000);
  second.socket.close();
});

test("oversized messages close the connection", async (t) => {
  const { url, token } = await startServer(t);
  const { socket } = await connect(url, { headers: { Authorization: `Bearer ${token}` } });
  const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  socket.send("x".repeat(1024 * 1024 + 10));
  assert.equal(await closed, 1009);
});

test("each start issues a new token", async (t) => {
  const server = createConversationWsServer({ portRange: TEST_RANGE });
  const first = await server.start();
  await server.stop();
  const second = await server.start();
  t.after(() => server.stop());
  assert.notEqual(first.token, second.token);
  assert.equal(second.token.length, 64);
});
