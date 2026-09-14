/**
 * Dragon "Export custom word and phrase list" parsing. Pure module: no fs, no
 * Electron. Only the written form of each entry is kept — spoken forms are
 * dropped by design (spec §2).
 *
 * Verified shape (Nuance help + real Dragon 13/14 exports; evidence in the
 * titan spec's assets):
 *   TXT  optional "@Version=Plato-UTF8" first line, one entry per line,
 *        "written\\spoken" pairs (a single "\" before Dragon 11).
 *   XML  <WordExport> root, one <Word name="written\\spoken"> per entry,
 *        declared encoding utf-16; word properties live in the element body
 *        and have no public schema, so they are ignored.
 */

const HEADER_LINE = /^@version\s*=\s*plato(-utf8)?$/i;

export function decodeDragonExport(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // UTF-16 by BOM, or by a BOM-less "<" (Dragon's XML declares utf-16).
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0x3c && b[1] === 0x00)) {
    return { text: new TextDecoder("utf-16le").decode(b), encoding: "utf-16le" };
  }
  if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0x00 && b[1] === 0x3c)) {
    return { text: new TextDecoder("utf-16be").decode(b), encoding: "utf-16be" };
  }
  // TextDecoder drops a UTF-8 BOM on its own; hand-made lists are often cp1252.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(b), encoding: "windows-1252" };
  }
}

// Nuance's own rule: the LAST separator wins, because a written form can
// itself contain a backslash. "\\" is the Dragon 11+ separator; a lone "\"
// is the pre-11 one and what users type when they "fix" the double.
function writtenForm(entry) {
  const idx = entry.includes("\\\\") ? entry.lastIndexOf("\\\\") : entry.lastIndexOf("\\");
  if (idx === -1) return entry;
  return entry.slice(0, idx).trim();
}

function collect(entries) {
  const byLower = new Map();
  const warnings = [];
  let duplicatesInFile = 0;
  for (const { value, line } of entries) {
    const written = writtenForm(value);
    if (!written) {
      warnings.push({ code: "AMBIGUOUS_BACKSLASH", line });
      continue;
    }
    const lower = written.toLowerCase();
    if (byLower.has(lower)) {
      duplicatesInFile += 1;
      continue;
    }
    byLower.set(lower, written);
  }
  return { words: [...byLower.values()], totalEntries: entries.length, duplicatesInFile, warnings };
}

function parseTxt(src) {
  const entries = [];
  let header = null;
  src.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const value = raw.trim();
    if (!value) return;
    if (header === null && entries.length === 0 && HEADER_LINE.test(value)) {
      header = value;
      return;
    }
    entries.push({ value, line: i + 1 });
  });
  const result = collect(entries);
  if (result.words.length === 0) return { ok: false, error: { code: "EMPTY_FILE" } };
  return { ok: true, format: "txt", header, ...result };
}

export function parseDragonWordList(text) {
  const src = String(text ?? "");
  return parseTxt(src);
}

export function planDragonImport(words, existingWords) {
  const existing = new Set(existingWords.map((w) => w.trim().toLowerCase()));
  const add = words.filter((w) => !existing.has(w.toLowerCase()));
  return { add, skippedExisting: words.length - add.length };
}
