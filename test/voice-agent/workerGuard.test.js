const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { decide } = require("../../src/voice-agent/main/workerGuard.cjs");

const CWD = path.resolve("/work/project");
const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: CWD });

test("reads stay inside the project folder", () => {
  assert.deepEqual(call("Read", { file_path: "src/app.js" }), { allow: true });
  assert.deepEqual(call("Grep", { pattern: "TODO" }), { allow: true });
  assert.deepEqual(call("Read", { file_path: path.join(CWD, "notes.md") }), { allow: true });
  assert.equal(call("Read", { file_path: "../../secrets.txt" }).allow, false);
  assert.equal(call("Read", { file_path: path.resolve("/windows/win.ini") }).allow, false);
  assert.equal(call("Glob", { path: path.resolve("/") }).allow, false);
});

test("only git read commands may run, and never chained", () => {
  for (const command of [
    "git log --since=midnight",
    "git show HEAD",
    "git status",
    "git diff",
    "git branch -a",
  ]) {
    assert.deepEqual(call("Bash", { command }), { allow: true }, command);
  }
  for (const command of [
    "whoami",
    "git push",
    "git commit -m x",
    "git log; whoami",
    "git log && curl example.org",
    "git log | tee out.txt",
    "git log > out.txt",
    "git log `whoami`",
    "git log $(whoami)",
    "ssh host free -m",
  ]) {
    assert.equal(call("Bash", { command }).allow, false, command);
  }
});

test("every other tool is refused", () => {
  for (const tool of ["Write", "Edit", "WebFetch", "WebSearch", "Task", "Agent", ""]) {
    assert.equal(call(tool, {}).allow, false, tool);
  }
});
