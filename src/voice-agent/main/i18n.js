// Main-process strings for Conversation mode. Keys are always written with the "conversation:"
// namespace prefix so upstream's translation coverage scan (dotted keys only) ignores them; the
// fork's own test checks them against src/voice-agent/locales.
const { i18nMain } = require("../../helpers/i18nMain");
const en = require("../locales/en.json");
const fr = require("../locales/fr.json");

let registered = false;

function ensureBundles() {
  if (registered) return;
  i18nMain.addResourceBundle("en", "conversation", en, true, true);
  i18nMain.addResourceBundle("fr", "conversation", fr, true, true);
  registered = true;
}

function tr(key, vars) {
  ensureBundles();
  return i18nMain.t(key, { fallbackLng: "en", ...(vars || {}) });
}

module.exports = { tr };
