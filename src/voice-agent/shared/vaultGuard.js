// Read-only access to a Markdown notes vault for the voice session. Pure logic over an injected fs.
//
// A vault can hold a sealed folder (health records) and private notes. Every requested path is
// resolved inside the vault root segment by segment, then checked again on its real path, so a
// link cannot lead out of the vault or into a sealed folder. Searches prune sealed, hidden and
// excluded folders instead of filtering results afterwards, never follow links, and skip any note
// whose frontmatter marks it sensitive.
const path = require("path");

const SEALED_SEGMENTS = new Set(["60_sante"]);
const POCKET_PREFIX = "00_inbox/pocket/";
const DEFAULT_LIMITS = Object.freeze({
  maxFilesScanned: 5000,
  maxResults: 8,
  maxReadChars: 12000,
  maxSnippetChars: 240,
});

const fold = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** @returns {null | string} why a single path segment is refused */
function segmentProblem(segment) {
  if (!segment || segment === ".") return "empty";
  if (segment === "..") return "parent";
  if (segment.startsWith(".")) return "hidden";
  if (/[. ]$/.test(segment)) return "trailing-dot-or-space";
  if (segment.includes(":")) return "stream";
  if (SEALED_SEGMENTS.has(fold(segment))) return "sealed";
  return null;
}

function checkSegments(segments, excludedSet) {
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) return problem;
    if (excludedSet.has(fold(segment))) return "excluded";
  }
  return null;
}

function resolveVaultPath(vaultRoot, relativePath, { excluded = [], realpath = (p) => p } = {}) {
  if (!vaultRoot) return { ok: false, error: "no-vault" };
  const raw = String(relativePath || "").trim();
  if (!raw) return { ok: false, error: "empty" };
  if (/^[\\/]{2}/.test(raw) || /^[A-Za-z]:/.test(raw) || path.isAbsolute(raw)) {
    return { ok: false, error: "absolute" };
  }
  const excludedSet = new Set(excluded.map(fold));
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const requested = checkSegments(segments, excludedSet);
  if (requested) return { ok: false, error: requested };

  let realRoot;
  let real;
  try {
    realRoot = realpath(path.resolve(vaultRoot));
    real = realpath(path.join(path.resolve(vaultRoot), ...segments));
  } catch {
    return { ok: false, error: "not-found" };
  }
  const relative = path.relative(realRoot, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: "outside" };
  }
  const realSegments = relative.split(/[\\/]+/).filter(Boolean);
  const resolved = checkSegments(realSegments, excludedSet);
  if (resolved) return { ok: false, error: resolved };
  return { ok: true, path: real, relative: realSegments.join("/") };
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text, raw: "" };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (field) data[field[1].toLowerCase()] = field[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(match[0].length), raw: match[0] };
}

function isSensitive(data) {
  return /^(true|yes|oui)$/i.test(data.sensitive || "") || fold(data.scope) === "sante";
}

const isConflictFile = (name) => /_conflict/i.test(name) || /\.sync-conflict-/i.test(name);
const isPocketNote = (relative) => fold(relative).startsWith(POCKET_PREFIX);

/** Meeting transcripts: only the frontmatter, the summary and the action items leave the vault. */
function pocketExcerpt(text) {
  const { raw, body } = parseFrontmatter(text);
  const kept = [];
  let keeping = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    // Any other heading, even nested under the summary, may start the transcript: stop there.
    if (heading) keeping = /^(resume|summary|action items)\b/.test(fold(heading[1].trim()));
    if (keeping) kept.push(line);
  }
  return `${raw}${kept.join("\n")}`.trim();
}

function snippetFor(body, terms, maxChars) {
  const folded = fold(body);
  const hits = terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - Math.floor(maxChars / 3)) : 0;
  const text = body
    .slice(start, start + maxChars)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${text}${start + maxChars < body.length ? "…" : ""}`;
}

function searchVault({ vaultRoot, query, excluded = [], limits = {}, fsImpl }) {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  if (!vaultRoot) return { ok: false, error: "no-vault" };
  const terms = fold(query)
    .split(/\s+/)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return { ok: false, error: "empty-query" };
  const excludedSet = new Set(excluded.map(fold));
  const results = [];
  let scanned = 0;
  let sensitiveSkipped = 0;
  let truncated = false;
  const pending = [""];

  while (pending.length > 0 && !truncated) {
    const folder = pending.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(path.join(vaultRoot, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (segmentProblem(name) || excludedSet.has(fold(name))) continue;
      if (entry.isSymbolicLink?.()) continue;
      const relative = folder ? `${folder}/${name}` : name;
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!/\.md$/i.test(name)) continue;
      if (++scanned > limit.maxFilesScanned) {
        truncated = true;
        break;
      }
      let text;
      try {
        text = fsImpl.readFileSync(path.join(vaultRoot, relative), "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      if (isSensitive(data)) {
        sensitiveSkipped++;
        continue;
      }
      const visible = isPocketNote(relative) ? parseFrontmatter(pocketExcerpt(text)).body : body;
      const haystack = fold(`${name}\n${visible}`);
      const score = terms.filter((term) => haystack.includes(term)).length;
      if (score === 0) continue;
      results.push({
        path: relative,
        title: name.replace(/\.md$/i, ""),
        score,
        snippet: snippetFor(visible, terms, limit.maxSnippetChars),
        conflict: isConflictFile(name),
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    ok: true,
    results: results.slice(0, limit.maxResults),
    scanned: Math.min(scanned, limit.maxFilesScanned),
    sensitiveSkipped,
    truncated,
  };
}

function readVaultNote({ vaultRoot, relativePath, excluded = [], limits = {}, fsImpl }) {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  const resolved = resolveVaultPath(vaultRoot, relativePath, {
    excluded,
    realpath: (p) => fsImpl.realpathSync.native(p),
  });
  if (!resolved.ok) return resolved;
  if (!/\.md$/i.test(resolved.relative)) return { ok: false, error: "not-markdown" };
  let text;
  try {
    text = fsImpl.readFileSync(resolved.path, "utf8");
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (isSensitive(parseFrontmatter(text).data)) return { ok: false, error: "sensitive" };
  const visible = isPocketNote(resolved.relative) ? pocketExcerpt(text) : text;
  return {
    ok: true,
    path: resolved.relative,
    text: visible.slice(0, limit.maxReadChars),
    truncated: visible.length > limit.maxReadChars,
    conflict: isConflictFile(path.basename(resolved.relative)),
  };
}

module.exports = {
  resolveVaultPath,
  parseFrontmatter,
  isSensitive,
  pocketExcerpt,
  searchVault,
  readVaultNote,
  segmentProblem,
  DEFAULT_LIMITS,
};
