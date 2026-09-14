const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Fixtures and shareable docs must not carry machine paths, private hosts, keys or real ids.
const ROOT = path.join(__dirname, "..", "..");
const FILES = [
  "test/voice-agent/streamJson.test.js",
  "test/voice-agent/workers.test.js",
  "test/voice-agent/workerArgv.test.js",
  "docs/voice-agent/PROTOCOL.md",
  "docs/voice-agent/MEASUREMENTS.md",
  "docs/voice-agent/README.md",
];
const PATTERNS = [
  ["Windows user folder", /[A-Z]:[\\/]+Users[\\/]+\w/i],
  ["private domain", /blain-projects\.ca/i],
  ["API key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._-]{16,}/],
  ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
];

test("fixtures and shareable docs contain no private pattern", () => {
  for (const file of FILES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const [label, pattern] of PATTERNS) {
      assert.equal(pattern.test(text), false, `${file}: ${label}`);
    }
  }
});
