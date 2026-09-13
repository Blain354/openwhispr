/**
 * Packs long note material into parts that each fit a local model's context
 * window (#2142, part 3). Pure: no IPC, no prompts, no React.
 *
 * The token estimate is a copy of llamaContextPolicy.estimateTokens. The
 * renderer cannot import that CommonJS module, and this helper is consumed by
 * the renderer, so the two are pinned together by test instead of by import.
 */

// Latin text tokenizes at roughly 3.5-4.2 chars/token on the BPEs the bundled
// models use; 3 keeps the estimate high, which is the safe direction here.
export const LATIN_CHARS_PER_TOKEN = 3;

const CJK_RANGES = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x3ffff], // CJK Unified Ideographs Extensions B and beyond
];

function isCjkCodePoint(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/** Deliberately high estimate of how many tokens a string will occupy. */
export function estimateNoteTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0))) cjkCount += 1;
    else otherCount += 1;
  }
  return cjkCount + Math.ceil(otherCount / LATIN_CHARS_PER_TOKEN);
}

/** Cuts a run with no whitespace into slices that each fit the budget. */
function sliceByTokens(text, budgetTokens) {
  const slices = [];
  let current = "";
  let cjkCount = 0;
  let otherCount = 0;
  for (const character of text) {
    const cjk = isCjkCodePoint(character.codePointAt(0));
    const nextCjk = cjkCount + (cjk ? 1 : 0);
    const nextOther = otherCount + (cjk ? 0 : 1);
    if (current && nextCjk + Math.ceil(nextOther / LATIN_CHARS_PER_TOKEN) > budgetTokens) {
      slices.push(current);
      current = "";
      cjkCount = 0;
      otherCount = 0;
    }
    current += character;
    if (cjk) cjkCount += 1;
    else otherCount += 1;
  }
  if (current) slices.push(current);
  return slices;
}

/** Splits one over-long line at spaces, then by tokens for unbroken runs. */
function splitLongLine(line, budgetTokens) {
  const pieces = [];
  let current = "";
  for (const word of line.split(/\s+/)) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (estimateNoteTokens(candidate) <= budgetTokens) {
      current = candidate;
      continue;
    }
    if (current) pieces.push(current);
    if (estimateNoteTokens(word) <= budgetTokens) {
      current = word;
      continue;
    }
    pieces.push(...sliceByTokens(word, budgetTokens));
    current = "";
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Greedy line packing: each chunk holds as many whole lines as fit under the
 * budget, in order. A line that alone exceeds the budget is split at spaces.
 */
export function planNoteChunks(body, budgetTokens) {
  if (typeof body !== "string" || !(budgetTokens > 0)) return [];
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const line of body.split("\n")) {
    const pieces =
      estimateNoteTokens(line) > budgetTokens ? splitLongLine(line, budgetTokens) : [line];
    for (const piece of pieces) {
      const cost = estimateNoteTokens(piece) + 1; // the newline
      if (current.length > 0 && currentTokens + cost > budgetTokens) {
        chunks.push(current.join("\n"));
        current = [];
        currentTokens = 0;
      }
      current.push(piece);
      currentTokens += cost;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** Halves a chunk on lines, then on words; null when it cannot be split. */
export function splitChunkInHalf(chunk) {
  const lines = chunk.split("\n");
  if (lines.length >= 2) {
    const middle = Math.ceil(lines.length / 2);
    return [lines.slice(0, middle).join("\n"), lines.slice(middle).join("\n")];
  }
  const words = chunk.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const middle = Math.ceil(words.length / 2);
  return [words.slice(0, middle).join(" "), words.slice(middle).join(" ")];
}
