// Main-process strings of Conversation mode. They live in src/locales/<lang>/translation.json
// under the "conversation" key, like every other string of the app.
const { i18nMain } = require("../../helpers/i18nMain");

function tr(key, vars) {
  return i18nMain.t(key, { fallbackLng: "en", ...(vars || {}) });
}

module.exports = { tr };
