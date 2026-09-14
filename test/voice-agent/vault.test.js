const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { createVaultAccess } = require("../../src/voice-agent/main/vault");

const ROOT = path.resolve("/vault");
const tr = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

function fakeFs(files) {
  const abs = (relative) => path.join(ROOT, ...relative.split("/"));
  const dirs = new Set([ROOT]);
  for (const relative of Object.keys(files)) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(abs(parts.slice(0, i).join("/")));
  }
  const byPath = new Map(Object.entries(files).map(([relative, text]) => [abs(relative), text]));
  const appended = [];
  return {
    appended,
    readdirSync: (dir) =>
      [...dirs, ...byPath.keys()]
        .filter((candidate) => candidate !== dir && path.dirname(candidate) === dir)
        .map((full) => ({
          name: path.basename(full),
          isDirectory: () => dirs.has(full),
          isSymbolicLink: () => false,
        })),
    readFileSync: (file) => {
      if (!byPath.has(file)) throw new Error("ENOENT");
      return byPath.get(file);
    },
    realpathSync: {
      native: (p) => {
        if (!dirs.has(p) && !byPath.has(p)) throw new Error("ENOENT");
        return p;
      },
    },
    mkdirSync: () => {},
    appendFileSync: (_file, text) => appended.push(JSON.parse(text)),
  };
}

const FILES = {
  "50_AI/Murmure.md": "# Murmure\nOpenWhispr remplace Murmure pour la dictée.",
  "Private/journal.md": "---\nsensitive: true\n---\nOpenWhispr et mes pensées",
  "60_Sante/rdv.md": "OpenWhispr",
};

function setup(config = {}) {
  const fsImpl = fakeFs(FILES);
  const vault = createVaultAccess({
    userDataDir: path.resolve("/appdata"),
    getConfig: () => ({ vaultRoot: ROOT, vaultExcluded: [], ...config }),
    tr,
    fsImpl,
  });
  return { vault, fsImpl };
}

test("a search returns paths and snippets, and the audit keeps no query text", () => {
  const { vault, fsImpl } = setup();
  const result = vault.search({ query: "OpenWhispr dictée" });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.data.results.map((r) => r.path),
    ["50_AI/Murmure.md"]
  );
  assert.match(result.data.output, /remplace Murmure/);
  assert.match(result.data.output, /sensitiveSkipped/);
  const [entry] = fsImpl.appended;
  assert.equal(entry.op, "vault.search");
  assert.equal(entry.queryChars, "OpenWhispr dictée".length);
  assert.equal(JSON.stringify(entry).includes("dictée"), false);
});

test("reading a note returns its text; private and sealed notes are refused", () => {
  const { vault } = setup();
  const note = vault.read({ path: "50_AI/Murmure.md" });
  assert.equal(note.success, true);
  assert.match(note.data.output, /pour la dictée/);
  assert.equal(
    vault.read({ path: "Private/journal.md" }).displayText,
    "conversation.vault.private"
  );
  assert.equal(vault.read({ path: "60_Sante/rdv.md" }).displayText, "conversation.vault.private");
  assert.equal(vault.read({ path: "../etc/passwd" }).displayText, "conversation.vault.refused");
});

test("without a configured vault nothing is read", () => {
  const { vault } = setup({ vaultRoot: "" });
  assert.equal(
    vault.search({ query: "OpenWhispr" }).displayText,
    "conversation.vault.notConfigured"
  );
  assert.equal(vault.read({ path: "50_AI/Murmure.md" }).success, false);
});
