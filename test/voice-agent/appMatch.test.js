const test = require("node:test");
const assert = require("node:assert/strict");

const { matchApp, isExcludedEntry } = require("../../src/voice-agent/shared/appMatch");

// Shape of Get-StartApps output, with accented and Squirrel-style entries.
const START_APPS = [
  { Name: "Obsidian", AppID: "md.obsidian" },
  {
    Name: "Uninstall Obsidian",
    AppID: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Obsidian\\Uninstall Obsidian.exe",
  },
  {
    Name: "Paramètres",
    AppID: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
  },
  { Name: "Bloc-notes", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
  { Name: "Discord", AppID: "com.squirrel.Discord.Discord" },
  { Name: "Slack", AppID: "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\slack\\Update.exe" },
  { Name: "Visual Studio Code", AppID: "Microsoft.VisualStudioCode" },
  { Name: "Visual Studio Code - Insiders", AppID: "Microsoft.VisualStudioCodeInsiders" },
  {
    Name: "Visual Studio Installer",
    AppID: "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Microsoft Visual Studio\\Installer\\setup.exe",
  },
];

test("an exact name opens the app", () => {
  const { match } = matchApp("Obsidian", START_APPS);
  assert.equal(match.Name, "Obsidian");
});

test("a misheard name still resolves when it is close enough", () => {
  assert.equal(matchApp("obsidien", START_APPS).match.Name, "Obsidian");
});

test("accents and case do not matter", () => {
  assert.equal(matchApp("parametres", START_APPS).match.Name, "Paramètres");
  assert.equal(matchApp("BLOC NOTES", START_APPS).match.Name, "Bloc-notes");
});

test("uninstallers and installers are never matched, even when named explicitly", () => {
  const { match, candidates } = matchApp("uninstall obsidian", START_APPS);
  assert.ok(!match || match.Name === "Obsidian");
  assert.ok(candidates.every((c) => !/uninstall/i.test(c.Name)));
  assert.equal(matchApp("visual studio installer", START_APPS).match?.Name ?? null, null);
});

test("Squirrel apps launched through Update.exe stay reachable", () => {
  assert.equal(isExcludedEntry({ Name: "Slack", AppID: "{x}\\slack\\Update.exe" }), false);
  assert.equal(matchApp("slack", START_APPS).match.Name, "Slack");
  assert.equal(matchApp("discord", START_APPS).match.Name, "Discord");
});

test("an ambiguous name returns candidates instead of launching", () => {
  const { match, candidates } = matchApp("studio", START_APPS);
  assert.equal(match, null);
  assert.ok(candidates.length >= 2);
});

test("an exact full name wins over a longer sibling", () => {
  assert.equal(matchApp("visual studio code", START_APPS).match.Name, "Visual Studio Code");
});

test("an unrelated name matches nothing", () => {
  assert.equal(matchApp("photoshop", START_APPS).match, null);
  assert.equal(matchApp("", START_APPS).match, null);
});
