// Command line and working folder of a background worker (claude -p). Pure logic.
//
// A worker is read-only: it may read, search and run a few git read commands in one project folder,
// with no MCP server, no user-level settings and a spending cap. Its folder is chosen among the
// configured project roots and is never the notes vault, a folder that contains it, a sealed
// folder, the home folder or anything above it.
const path = require("path");

const GIT_READ_COMMANDS = ["git log", "git show", "git status", "git diff", "git branch"];
const SEALED_SEGMENTS = ["60_sante"];
const MAX_BUDGET_USD = 20;

function buildWorkerLaunch({ claudePath, budgetUsd = 2 }) {
  const budget = Number(budgetUsd);
  const cap = Number.isFinite(budget) && budget > 0 ? Math.min(budget, MAX_BUDGET_USD) : 2;
  return {
    command: claudePath,
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      ...GIT_READ_COMMANDS.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
      "--max-budget-usd",
      String(cap),
    ],
  };
}

const normalizePath = (value) =>
  path
    .resolve(String(value))
    .replace(/[\\/]+$/, "")
    .toLowerCase();

function isSameOrInside(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(`${p}${path.sep}`) || c.startsWith(`${p}/`);
}

/** @returns {null | "missing" | "too-broad" | "sealed" | "vault"} */
function checkWorkerDir(dir, { vaultRoot = "", homeDir = "" } = {}) {
  if (!dir || typeof dir !== "string") return "missing";
  const resolved = path.resolve(dir);
  if (normalizePath(resolved) === normalizePath(path.parse(resolved).root)) return "too-broad";
  if (homeDir && isSameOrInside(homeDir, resolved)) return "too-broad";
  const segments = normalizePath(resolved).split(/[\\/]+/);
  if (segments.some((segment) => SEALED_SEGMENTS.includes(segment))) return "sealed";
  if (vaultRoot && (isSameOrInside(resolved, vaultRoot) || isSameOrInside(vaultRoot, resolved))) {
    return "vault";
  }
  return null;
}

/** A root ending in `*` contributes its sub-folders; any other root is itself a project. */
function projectCandidates(roots, listDirs) {
  const candidates = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== "string" || !root.trim()) continue;
    const trimmed = root.trim();
    if (trimmed.endsWith("*")) {
      const parent = trimmed.slice(0, -1).replace(/[\\/]+$/, "");
      for (const name of listDirs(parent)) candidates.push({ name, dir: path.join(parent, name) });
    } else {
      candidates.push({ name: path.basename(trimmed.replace(/[\\/]+$/, "")), dir: trimmed });
    }
  }
  return candidates;
}

const fold = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s._-]+/g, "");

/** 0..1 similarity of two folded names (Levenshtein ratio). */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function resolveWorkerCwd(
  project,
  { roots = [], vaultRoot = "", homeDir = "", listDirs = () => [], realpath = (p) => p } = {}
) {
  const guard = { vaultRoot, homeDir };
  const candidates = projectCandidates(roots, listDirs).filter(
    (candidate) => !checkWorkerDir(candidate.dir, guard)
  );
  if (candidates.length === 0) return { ok: false, error: "no-projects", names: [] };
  const names = (list) => list.map((candidate) => candidate.name).slice(0, 12);
  const query = fold(project);
  let matches = query ? candidates.filter((candidate) => fold(candidate.name) === query) : [];
  if (matches.length === 0 && query.length >= 3) {
    matches = candidates.filter((candidate) => {
      const name = fold(candidate.name);
      return name.length >= 3 && (name.includes(query) || query.includes(name));
    });
  }
  if (matches.length === 0 && query.length >= 4) {
    // Speech recognition mangles project names ("Blin Infra" for "blain-infra").
    const scored = candidates
      .map((candidate) => ({ candidate, score: similarity(query, fold(candidate.name)) }))
      .filter((entry) => entry.score >= 0.72)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0].score - scored[1].score >= 0.08)) {
      matches = [scored[0].candidate];
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error: matches.length ? "ambiguous" : "no-match",
      names: names(matches.length ? matches : candidates),
    };
  }
  let real;
  try {
    real = realpath(matches[0].dir);
  } catch {
    return { ok: false, error: "no-match", names: names(candidates) };
  }
  // A link inside a project root could point into the vault: check the real path again.
  const problem = checkWorkerDir(real, guard);
  if (problem) return { ok: false, error: problem, names: [] };
  return { ok: true, cwd: real, name: matches[0].name };
}

module.exports = {
  buildWorkerLaunch,
  similarity,
  checkWorkerDir,
  resolveWorkerCwd,
  projectCandidates,
  GIT_READ_COMMANDS,
};
