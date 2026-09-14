const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  resolveVaultPath,
  parseFrontmatter,
  pocketExcerpt,
  searchVault,
  readVaultNote,
} = require("../../src/voice-agent/shared/vaultGuard");

const ROOT = path.resolve("/vault");

// In-memory vault: { "folder/note.md": "text" }, links: { "alias": "target folder" }.
function fakeFs(files, links = {}) {
  const abs = (relative) => path.join(ROOT, ...relative.split("/"));
  const dirs = new Set([ROOT]);
  for (const relative of Object.keys(files)) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(abs(parts.slice(0, i).join("/")));
  }
  const byPath = new Map(Object.entries(files).map(([relative, text]) => [abs(relative), text]));
  const linkTargets = new Map(Object.entries(links).map(([from, to]) => [abs(from), abs(to)]));
  for (const from of linkTargets.keys()) dirs.add(from);
  const reads = [];
  return {
    reads,
    readdirSync(dir) {
      const entries = new Map();
      for (const candidate of [...dirs, ...byPath.keys()]) {
        if (path.dirname(candidate) !== dir || candidate === dir) continue;
        entries.set(path.basename(candidate), candidate);
      }
      return [...entries].map(([name, full]) => ({
        name,
        isDirectory: () => dirs.has(full),
        isSymbolicLink: () => linkTargets.has(full),
      }));
    },
    readFileSync(file) {
      reads.push(path.relative(ROOT, file).split(path.sep).join("/"));
      if (!byPath.has(file)) throw new Error("ENOENT");
      return byPath.get(file);
    },
    realpathSync: {
      native(p) {
        for (const [from, to] of linkTargets) {
          if (p === from || p.startsWith(from + path.sep)) return to + p.slice(from.length);
        }
        if (!dirs.has(p) && !byPath.has(p)) throw new Error("ENOENT");
        return p;
      },
    },
  };
}

const VAULT = {
  "50_AI/Reponses/Murmure.md":
    "---\nupdated: 2026-09-14\n---\n# Murmure\nOpenWhispr remplace Murmure.",
  "50_AI/Reponses/Murmure_Conflict 2026.md": "# Murmure\nOpenWhispr copie en conflit.",
  "60_Sante/bilan.md": "OpenWhispr bilan",
  ".obsidian/workspace.md": "OpenWhispr",
  "Private/secret.md": "---\nsensitive: true\n---\nOpenWhispr secret",
  "Journal/2026-09-14.md": "---\nscope: santé\n---\nOpenWhispr rendez-vous",
  "00_Inbox/pocket/reunion.md":
    "---\ntype: pocket\n---\n# Résumé\nOn parle d'OpenWhispr.\n## Transcription\nPropos privés OpenWhispr.\n# Action items\n- Tester OpenWhispr",
  "Archive/old.md": "OpenWhispr ancien",
};

test("paths are refused when absolute, hidden, sealed, streamed, parent or excluded", () => {
  const options = { excluded: ["Archive"], realpath: (p) => p };
  const refused = {
    "C:/x.md": "absolute",
    "\\\\server\\share\\x.md": "absolute",
    "../outside.md": "parent",
    ".obsidian/workspace.md": "hidden",
    "60_Santé/bilan.md": "sealed",
    "60_SANTE/bilan.md": "sealed",
    "50_AI/note.md:stream": "stream",
    "50_AI./note.md": "trailing-dot-or-space",
    "archive/old.md": "excluded",
    "": "empty",
  };
  for (const [input, error] of Object.entries(refused)) {
    assert.equal(resolveVaultPath(ROOT, input, options).error, error, input);
  }
  assert.deepEqual(resolveVaultPath(ROOT, "50_AI\\Reponses\\Murmure.md", options), {
    ok: true,
    path: path.join(ROOT, "50_AI", "Reponses", "Murmure.md"),
    relative: "50_AI/Reponses/Murmure.md",
  });
});

test("a link inside the vault cannot lead into the sealed folder", () => {
  const fsImpl = fakeFs(VAULT, { Raccourci: "60_Sante" });
  const result = readVaultNote({ vaultRoot: ROOT, relativePath: "Raccourci/bilan.md", fsImpl });
  assert.equal(result.error, "sealed");
  assert.equal(fsImpl.reads.length, 0);
});

test("frontmatter is parsed; sensitive and health-scoped notes are never read back", () => {
  assert.deepEqual(parseFrontmatter('---\nsensitive: "true"\n---\nbody').data, {
    sensitive: "true",
  });
  const fsImpl = fakeFs(VAULT);
  assert.equal(
    readVaultNote({ vaultRoot: ROOT, relativePath: "Private/secret.md", fsImpl }).error,
    "sensitive"
  );
  assert.equal(
    readVaultNote({ vaultRoot: ROOT, relativePath: "Journal/2026-09-14.md", fsImpl }).error,
    "sensitive"
  );
  const note = readVaultNote({
    vaultRoot: ROOT,
    relativePath: "50_AI/Reponses/Murmure.md",
    fsImpl,
  });
  assert.equal(note.ok, true);
  assert.match(note.text, /remplace Murmure/);
});

test("a search prunes sealed, hidden and excluded folders before reading anything", () => {
  const fsImpl = fakeFs(VAULT);
  const result = searchVault({
    vaultRoot: ROOT,
    query: "openwhispr",
    excluded: ["archive"],
    fsImpl,
  });
  assert.equal(result.ok, true);
  const paths = result.results.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    "00_Inbox/pocket/reunion.md",
    "50_AI/Reponses/Murmure.md",
    "50_AI/Reponses/Murmure_Conflict 2026.md",
  ]);
  assert.equal(
    fsImpl.reads.some((file) => /60_Sante|\.obsidian|Archive/.test(file)),
    false
  );
  assert.equal(result.sensitiveSkipped, 2);
  assert.equal(result.results.find((r) => r.path.includes("Conflict")).conflict, true);
});

test("meeting notes only expose their summary and action items", () => {
  const excerpt = pocketExcerpt(VAULT["00_Inbox/pocket/reunion.md"]);
  assert.match(excerpt, /Résumé/);
  assert.match(excerpt, /Tester OpenWhispr/);
  assert.doesNotMatch(excerpt, /Propos privés/);
  const fsImpl = fakeFs(VAULT);
  const search = searchVault({ vaultRoot: ROOT, query: "propos privés", fsImpl });
  assert.deepEqual(search.results, []);
  const read = readVaultNote({
    vaultRoot: ROOT,
    relativePath: "00_Inbox/pocket/reunion.md",
    fsImpl,
  });
  assert.doesNotMatch(read.text, /Propos privés/);
});

test("no vault configured means no access", () => {
  const fsImpl = fakeFs(VAULT);
  assert.equal(searchVault({ vaultRoot: "", query: "x y", fsImpl }).error, "no-vault");
  assert.equal(readVaultNote({ vaultRoot: "", relativePath: "a.md", fsImpl }).error, "no-vault");
});
