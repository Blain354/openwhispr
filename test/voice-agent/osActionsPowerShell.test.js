// Integration checks of the PowerShell launchers. They spawn powershell.exe, so they only run on
// Windows; the script itself always arrives on stdin and is parsed as one unit.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runPowerShellProcess,
  encodeCommand,
  PARSE_SCRIPT,
  RUN_SCRIPT,
} = require("../../src/voice-agent/main/osActions");

const onWindows = { skip: process.platform !== "win32" };

test("encodeCommand produces UTF-16LE base64", () => {
  assert.equal(Buffer.from(encodeCommand("Get-Date"), "base64").toString("utf16le"), "Get-Date");
});

test("a multi-line script runs in full, blocks included", onWindows, async () => {
  const script = [
    "$x = 1",
    "if ($x -eq 1) {",
    "  Write-Output 'first'",
    "}",
    "foreach ($i in 1..2) {",
    '  Write-Output "loop$i"',
    "}",
    "Write-Output 'last é'",
  ].join("\n");
  const result = await runPowerShellProcess(RUN_SCRIPT, { input: script });
  assert.equal(result.code, 0, result.stderr);
  for (const expected of ["first", "loop1", "loop2", "last é"]) {
    assert.ok(result.stdout.includes(expected), `missing ${expected} in ${result.stdout}`);
  }
});

test("a script ending in throw reports failure", onWindows, async () => {
  const result = await runPowerShellProcess(RUN_SCRIPT, {
    input: "Write-Output 'a'\nthrow 'boom'",
  });
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("boom"));
});

test("the AST helper reports commands without running them", onWindows, async () => {
  const marker = `ow-parse-${process.pid}`;
  const script = `Get-Process | Sort-Object CPU\ndel C:\\nonexistent\\${marker}\n[IO.File]::Delete('x') > out.txt`;
  const result = await runPowerShellProcess(PARSE_SCRIPT, { input: script });
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [parsed.commands];
  assert.ok(commands.includes("Get-Process"));
  assert.ok(commands.includes("del"));
  assert.ok(parsed.members >= 1);
  assert.ok(parsed.redirections >= 1);
  assert.equal(parsed.errors, 0);
});

test(
  "helper output is not capped at the user-script limit, user output is",
  onWindows,
  async () => {
    const big = '1..6000 | ForEach-Object { "line $_" } | Out-String';
    const helper = await runPowerShellProcess("[Console]::Out.Write((" + big + "))");
    assert.equal(helper.truncated, false);
    assert.ok(helper.stdout.length > 40000);
    const capped = await runPowerShellProcess("[Console]::Out.Write((" + big + "))", {
      maxOutputBytes: 8192,
    });
    assert.equal(capped.truncated, true);
    assert.ok(capped.stdout.length <= 8192);
  }
);
