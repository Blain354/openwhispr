const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildWorkerLaunch,
  checkWorkerDir,
  resolveWorkerCwd,
} = require("../../src/voice-agent/shared/workerArgv");

const HOME = path.resolve("/home/tester");
const VAULT = path.join(HOME, "Notes");
const CODE = path.join(HOME, "code");

test("a worker is read-only, without MCP servers or user settings, and capped", () => {
  const { command, args } = buildWorkerLaunch({
    claudePath: "claude",
    budgetUsd: 50,
    guardCommand: 'node "guard.cjs"',
  });
  assert.equal(command, "claude");
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.equal(after("--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(after("--tools"), "Read,Grep,Glob,Bash");
  assert.equal(after("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after("--mcp-config"), '{"mcpServers":{}}');
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(after("--max-budget-usd"), "20");
  const settings = JSON.parse(after("--settings"));
  assert.deepEqual(settings.hooks.PreToolUse[0].matcher, "*");
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node "guard.cjs"');
  for (const forbidden of ["--dangerously-skip-permissions", "bypassPermissions", "--model"]) {
    assert.equal(args.includes(forbidden), false, forbidden);
  }
});

test("folders around the vault, sealed folders and broad folders are refused", () => {
  const guard = { vaultRoot: VAULT, homeDir: HOME };
  assert.equal(checkWorkerDir(path.join(CODE, "app"), guard), null);
  assert.equal(checkWorkerDir(VAULT, guard), "vault");
  assert.equal(checkWorkerDir(path.join(VAULT, "50_AI"), guard), "vault");
  assert.equal(checkWorkerDir(path.join(CODE, "60_Sante", "x"), guard), "sealed");
  assert.equal(checkWorkerDir(HOME, guard), "too-broad");
  assert.equal(checkWorkerDir(path.dirname(HOME), guard), "too-broad");
  assert.equal(checkWorkerDir(path.parse(HOME).root, guard), "too-broad");
});

test("projects resolve by folded name from wildcard and plain roots", () => {
  const listDirs = (parent) =>
    parent === CODE ? ["blain-infra", "code-delegate", "OpenWhispr"] : [];
  const options = {
    roots: [`${CODE}${path.sep}*`, path.join(HOME, "work", "Thèse")],
    vaultRoot: VAULT,
    homeDir: HOME,
    listDirs,
  };
  assert.deepEqual(resolveWorkerCwd("Blain Infra", options), {
    ok: true,
    cwd: path.join(CODE, "blain-infra"),
    name: "blain-infra",
  });
  assert.equal(resolveWorkerCwd("these", options).cwd, path.join(HOME, "work", "Thèse"));
  assert.equal(resolveWorkerCwd("openwhispr repo", options).name, "OpenWhispr");
  const unknown = resolveWorkerCwd("minivalve", options);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "no-match");
  assert.ok(unknown.names.includes("blain-infra"));
  assert.equal(resolveWorkerCwd("", options).error, "no-match");
  assert.equal(resolveWorkerCwd("x", { ...options, roots: [] }).error, "no-projects");
});

test("a project root pointing at the vault is ignored, and a link into the vault is refused", () => {
  const listDirs = () => ["docs"];
  const options = {
    roots: [VAULT, `${CODE}${path.sep}*`],
    vaultRoot: VAULT,
    homeDir: HOME,
    listDirs,
  };
  assert.equal(resolveWorkerCwd("Notes", options).ok, false);
  const linked = resolveWorkerCwd("docs", { ...options, realpath: () => path.join(VAULT, "docs") });
  assert.deepEqual(linked, { ok: false, error: "vault", names: [] });
});

test("a project name mangled by speech recognition still resolves, ambiguity does not", () => {
  const listDirs = () => ["blain-infra", "blain-studio", "code-delegate"];
  const options = { roots: [`${CODE}${path.sep}*`], vaultRoot: VAULT, homeDir: HOME, listDirs };
  assert.equal(resolveWorkerCwd("Blin Infra", options).name, "blain-infra");
  assert.equal(resolveWorkerCwd("code delegate", options).name, "code-delegate");
  assert.equal(resolveWorkerCwd("blain", options).ok, false);
});
