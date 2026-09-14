const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { createTokenStore } = require("../../src/voice-agent/main/secrets");

const USER_DATA = path.resolve("/appdata");

function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (file, data) => files.set(file, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
  };
}

const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buffer) => String(buffer).replace(/^enc:/, ""),
});

test("a token is stored encrypted and readable only from the main process", () => {
  const fsImpl = fakeFs();
  const store = createTokenStore({ userDataDir: USER_DATA, safeStorage: safeStorage(), fsImpl });
  assert.deepEqual(store.set("openclaw", "t-123"), { ok: true, servers: ["openclaw"] });
  assert.equal(store.get("openclaw"), "t-123");
  assert.deepEqual(store.servers(), ["openclaw"]);
  const [[file, data]] = [...fsImpl.files];
  assert.match(file, /mcp-tokens\.bin$/);
  assert.equal(String(data).startsWith("enc:"), true);
  assert.equal(store.get("other"), "");
});

test("an empty token removes the entry", () => {
  const store = createTokenStore({
    userDataDir: USER_DATA,
    safeStorage: safeStorage(),
    fsImpl: fakeFs(),
  });
  store.set("a", "one");
  store.set("b", "two");
  assert.deepEqual(store.set("a", "  ").servers, ["b"]);
  assert.equal(store.get("a"), "");
});

test("without secure storage nothing is written", () => {
  const fsImpl = fakeFs();
  const store = createTokenStore({
    userDataDir: USER_DATA,
    safeStorage: safeStorage(false),
    fsImpl,
  });
  assert.deepEqual(store.set("openclaw", "t-123"), {
    ok: false,
    error: "no-encryption",
    servers: [],
  });
  assert.equal(fsImpl.files.size, 0);
  assert.equal(store.get("openclaw"), "");
});

test("a server name is required, and a write failure is reported", () => {
  const fsImpl = fakeFs();
  const store = createTokenStore({ userDataDir: USER_DATA, safeStorage: safeStorage(), fsImpl });
  assert.equal(store.set("", "t").error, "no-server");
  fsImpl.writeFileSync = () => {
    throw new Error("disk full");
  };
  assert.equal(store.set("openclaw", "t").error, "write-failed");
});
