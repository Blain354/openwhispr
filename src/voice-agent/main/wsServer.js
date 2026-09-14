// Loopback WebSocket server the Python voice sidecar connects to.
//
// Only one client, only from loopback, only with the Host header this server listens on, never
// from a browser (any Origin header is refused), and only with the per-launch token compared in
// constant time before the upgrade is accepted.
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const DEFAULT_PORT_RANGE = [8241, 8260];
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createConversationWsServer({
  onMessage,
  onConnect,
  onDisconnect,
  debugLogger,
  host = "127.0.0.1",
  portRange = DEFAULT_PORT_RANGE,
} = {}) {
  let server = null;
  let client = null;
  let token = null;
  let port = null;

  function verifyClient(info, done, listeningPort) {
    const req = info.req;
    const checks = {
      loopback: LOOPBACK.has(req.socket.remoteAddress),
      host: req.headers.host === `${host}:${listeningPort}`,
      noOrigin: !req.headers.origin,
      token: tokensMatch(String(req.headers.authorization || "").replace(/^Bearer /, ""), token),
    };
    if (Object.values(checks).every(Boolean)) {
      done(true);
      return;
    }
    debugLogger?.warn("Rejected voice sidecar connection", checks, "conversation");
    done(false, 401, "Unauthorized");
  }

  function handleConnection(socket) {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close(4000, "replaced");
    }
    client = socket;
    onConnect?.();
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      onMessage?.(data.toString("utf8"));
    });
    socket.on("close", () => {
      if (client === socket) {
        client = null;
        onDisconnect?.();
      }
    });
    socket.on("error", () => {});
  }

  function listen(listeningPort) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host,
        port: listeningPort,
        maxPayload: MAX_PAYLOAD_BYTES,
        verifyClient: (info, done) => verifyClient(info, done, listeningPort),
      });
      const onError = (error) => {
        wss.close();
        reject(error);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", () => {});
        resolve(wss);
      });
      wss.on("connection", handleConnection);
    });
  }

  async function start() {
    if (server) return { port, token };
    token = crypto.randomBytes(32).toString("hex");
    for (let candidate = portRange[0]; candidate <= portRange[1]; candidate++) {
      try {
        server = await listen(candidate);
        port = candidate;
        return { port, token };
      } catch (error) {
        if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
      }
    }
    throw new Error(`No free port for the voice sidecar in ${portRange.join("-")}`);
  }

  function send(text) {
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(text);
      return true;
    }
    return false;
  }

  async function stop() {
    if (client) {
      try {
        client.close(1001, "shutdown");
      } catch {}
      client = null;
    }
    if (server) {
      const closing = server;
      server = null;
      await new Promise((resolve) => closing.close(() => resolve()));
    }
    token = null;
    port = null;
  }

  return {
    start,
    stop,
    send,
    isConnected: () => !!client && client.readyState === WebSocket.OPEN,
    get port() {
      return port;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { createConversationWsServer, DEFAULT_PORT_RANGE, MAX_PAYLOAD_BYTES };
