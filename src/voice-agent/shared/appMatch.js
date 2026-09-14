// Matches a spoken or typed application name against the Start menu entries returned by
// Get-StartApps ({ Name, AppID }). Pure logic, main process only.

// Entries that must never be launched from a fuzzy name: an uninstaller or installer reached by
// a misheard word is not a reversible action. Display names are checked for the whole family;
// AppIDs only for uninstallers, because Squirrel apps (Discord, Slack, GitHub Desktop) legitimately
// start through an Update.exe path.
const EXCLUDED_NAME =
  /(^|[^a-z])(uninstall|unins\d*|desinstall|desinstaller|setup|install|installer|update|updater|repair|reparer)([^a-z]|$)/;
const EXCLUDED_APP_ID = /(^|[^a-z])(uninstall|unins\d*)([^a-z]|$)/;

const DEFAULT_THRESHOLD = 0.6;
const AMBIGUITY_GAP = 0.08;

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  const normalized = normalize(value);
  return normalized ? normalized.split(" ") : [];
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function tokenSimilarity(queryToken, nameToken) {
  if (queryToken === nameToken) return 1;
  if (nameToken.startsWith(queryToken) && queryToken.length >= 3) return 0.9;
  const longest = Math.max(queryToken.length, nameToken.length);
  if (longest < 4) return 0;
  return 1 - levenshtein(queryToken, nameToken) / longest;
}

function isExcludedEntry(entry) {
  return (
    EXCLUDED_NAME.test(normalize(entry && entry.Name)) ||
    EXCLUDED_APP_ID.test(normalize(entry && entry.AppID))
  );
}

function scoreEntry(query, entryName) {
  const queryNormalized = normalize(query);
  const nameNormalized = normalize(entryName);
  if (!queryNormalized || !nameNormalized) return 0;
  if (queryNormalized === nameNormalized) return 1;

  const queryTokens = tokens(query);
  const nameTokens = tokens(entryName);
  let total = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const nameToken of nameTokens) {
      best = Math.max(best, tokenSimilarity(queryToken, nameToken));
    }
    total += best;
  }
  const coverage = total / queryTokens.length;
  // Extra words in the entry name ("Obsidian" vs "Obsidian Canary") cost a little.
  const lengthPenalty = Math.min(0.15, Math.max(0, nameTokens.length - queryTokens.length) * 0.05);
  return Math.max(0, Math.min(0.99, coverage - lengthPenalty));
}

/**
 * @param {string} query
 * @param {Array<{Name: string, AppID: string}>} entries
 * @param {{threshold?: number}} [options]
 * @returns {{ match: {Name: string, AppID: string, score: number} | null,
 *             candidates: Array<{Name: string, AppID: string, score: number}> }}
 */
function matchApp(query, entries, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const scored = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.Name && entry.AppID && !isExcludedEntry(entry))
    .map((entry) => ({
      Name: entry.Name,
      AppID: entry.AppID,
      score: scoreEntry(query, entry.Name),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, 5);
  const best = scored[0];
  if (!best || best.score < threshold) return { match: null, candidates };

  const runnerUp = scored[1];
  const ambiguous =
    runnerUp &&
    best.score < 1 &&
    best.score - runnerUp.score < AMBIGUITY_GAP &&
    normalize(best.Name) !== normalize(runnerUp.Name);
  if (ambiguous) return { match: null, candidates };

  return { match: best, candidates };
}

module.exports = { matchApp, normalize, isExcludedEntry, scoreEntry };
