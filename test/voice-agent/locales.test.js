// Conversation mode strings live in a separate "conversation" i18next namespace until the
// upstream migration. Upstream's coverage test skips namespaced keys, so this test checks them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../src/voice-agent");
const en = require("../../src/voice-agent/locales/en.json");
const fr = require("../../src/voice-agent/locales/fr.json");

const SOURCE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs"]);
const KEY_PATTERN = /(["'`])conversation:([A-Za-z0-9_.-]+)\1/g;

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "sidecar" || entry.name === "node_modules")
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function flatten(object, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, full, out);
    else out.add(full);
  }
  return out;
}

test("every conversation: key used in source exists in en and fr", () => {
  const enKeys = flatten(en);
  const frKeys = flatten(fr);
  const missing = [];
  for (const file of sourceFiles(ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(KEY_PATTERN)) {
      const key = match[2];
      if (!enKeys.has(key)) missing.push(`en:${key} (${path.relative(ROOT, file)})`);
      if (!frKeys.has(key)) missing.push(`fr:${key} (${path.relative(ROOT, file)})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("en and fr define the same keys", () => {
  assert.deepEqual([...flatten(fr)].sort(), [...flatten(en)].sort());
});

test("no Python environment or cache lives under src/", () => {
  const sidecar = path.join(ROOT, "sidecar");
  for (const name of [".venv", ".pytest_cache"]) {
    assert.equal(
      fs.existsSync(path.join(sidecar, name)),
      false,
      `${name} must stay outside the repo`
    );
  }
});
