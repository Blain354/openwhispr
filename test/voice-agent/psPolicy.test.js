const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyPowerShell } = require("../../src/voice-agent/shared/psPolicy");

const parsed = (overrides = {}) => ({
  errors: 0,
  commands: [],
  members: 0,
  scriptBlocks: 0,
  redirections: 0,
  invocations: 0,
  ...overrides,
});

test("a read-only cmdlet pipeline is low risk", () => {
  assert.equal(classifyPowerShell(parsed({ commands: ["Get-Date"] }), "Get-Date").risk, "low");
  const pipeline = classifyPowerShell(
    parsed({ commands: ["Get-Process", "Sort-Object"] }),
    "Get-Process | Sort-Object CPU"
  );
  assert.equal(pipeline.risk, "low");
  assert.equal(pipeline.refused, false);
});

for (const [label, script, facts] of [
  ["alias del", "del C:\\temp\\x", { commands: ["del"] }],
  ["alias ri", "ri x", { commands: ["ri"] }],
  ["alias rd", "rd x", { commands: ["rd"] }],
  ["alias erase", "erase x", { commands: ["erase"] }],
  ["Remove-Item", "Remove-Item x", { commands: ["Remove-Item"] }],
  [".NET delete", "[IO.File]::Delete('x')", { members: 1 }],
  ["iex", "iex $s", { commands: ["iex"] }],
  ["cmd /c", "cmd /c del x", { commands: ["cmd"] }],
  ["Start-Process", "Start-Process notepad", { commands: ["Start-Process"] }],
  ["nested encoded command", "powershell -enc AAAA", { commands: ["powershell"] }],
  ["redirection", "Get-ChildItem > out.txt", { commands: ["Get-ChildItem"], redirections: 1 }],
  ["web post", "Invoke-WebRequest -Method Post -Uri x", { commands: ["Invoke-WebRequest"] }],
  [
    "script block",
    "Get-Process | Where-Object { $_.CPU -gt 1 }",
    { commands: ["Get-Process", "Where-Object"], scriptBlocks: 1 },
  ],
  ["call operator", "& $cmd", { commands: [""], invocations: 1 }],
  ["parse error", "Get-Date (", { commands: ["Get-Date"], errors: 1 }],
]) {
  test(`${label} is high risk`, () => {
    const verdict = classifyPowerShell(parsed(facts), script);
    assert.equal(verdict.risk, "high");
    assert.equal(verdict.refused, false);
    assert.ok(verdict.reasons.length > 0);
  });
}

test("a missing parse result is treated as high risk", () => {
  assert.equal(classifyPowerShell(null, "Get-Date").risk, "high");
});

for (const script of [
  "Get-Content $HOME\\.openwhispr\\cli-bridge.json",
  "Get-ChildItem ~/.openwhispr/cli-bridge.json",
  "type $env:USERPROFILE\\.claude\\.credentials.json",
  "Get-ChildItem $env:APPDATA\\open-whispr\\secure-keys",
  "Get-ChildItem $env:APPDATA\\open-whispr\\voice-agent\\secrets",
  'Get-Content "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Local State"',
  "Get-Content master-key-backup.enc",
  "Get-Content ~\\.ssh\\id_ed25519",
]) {
  test(`credential material is refused outright: ${script}`, () => {
    const verdict = classifyPowerShell(parsed({ commands: ["Get-Content"] }), script);
    assert.equal(verdict.refused, true);
    assert.equal(verdict.risk, "high");
  });
}
