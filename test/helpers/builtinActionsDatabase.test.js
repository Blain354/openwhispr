const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { BUILTIN_ACTIONS } = require("../../src/helpers/builtinActions.js");

// Exact defaults from the affected 1.10.1 build, before the empty-summary fix.
const previousDefaults = require("./builtinNotePromptFixtures.json");
let userDataDir;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

function createDatabase(t) {
  const Sqlite = require("better-sqlite3");
  try {
    new Sqlite(":memory:").close();
  } catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(error.message)) {
      t.skip("Run with Electron's Node runtime to use the installed SQLite binding");
      return null;
    }
    throw error;
  }
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-builtin-actions-"));
  const directory = userDataDir;
  const database = new DatabaseManager();
  t.after(() => {
    if (database.db.open) database.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

for (const [translationKey, previousPrompt] of Object.entries(previousDefaults)) {
  const action = BUILTIN_ACTIONS.find((entry) => entry.translationKey === translationKey);

  test(`${action.name}: fresh installs receive the revised prompt`, (t) => {
    const database = createDatabase(t);
    if (!database) return;
    const stored = database.getActions().find((entry) => entry.translation_key === translationKey);
    assert.equal(stored.prompt, action.prompt);
    assert.notEqual(stored.prompt, previousPrompt);
  });

  test(`${action.name}: an untouched previous default upgrades once on launch`, (t) => {
    const database = createDatabase(t);
    if (!database) return;
    const stored = database.getActions().find((entry) => entry.translation_key === translationKey);
    database.db
      .prepare("UPDATE actions SET prompt = ? WHERE id = ?")
      .run(previousPrompt, stored.id);
    database.db.close();

    const reopened = new DatabaseManager();
    try {
      const updated = reopened.getActions().find((entry) => entry.id === stored.id);
      assert.equal(updated.prompt, action.prompt);
      assert.notEqual(updated.prompt, previousPrompt);
    } finally {
      reopened.db.close();
    }
    const relaunched = new DatabaseManager();
    try {
      const matching = relaunched
        .getActions()
        .filter((entry) => entry.translation_key === translationKey);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].id, stored.id);
      assert.equal(matching[0].prompt, action.prompt);
    } finally {
      relaunched.db.close();
    }
  });

  test(`${action.name}: a user-edited default survives launch`, (t) => {
    const database = createDatabase(t);
    if (!database) return;
    const customizedPrompt = `${previousPrompt}\nAlways use numbered lists.`;
    database.db
      .prepare("UPDATE actions SET prompt = ? WHERE translation_key = ?")
      .run(customizedPrompt, translationKey);
    database.db.close();

    const reopened = new DatabaseManager();
    try {
      const stored = reopened
        .getActions()
        .find((entry) => entry.translation_key === translationKey);
      assert.equal(stored.prompt, customizedPrompt);
    } finally {
      reopened.db.close();
    }
  });
}
