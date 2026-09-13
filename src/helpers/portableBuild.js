// electron-builder ships two Windows artifacts (electron-builder.json:
// "win": { "target": ["nsis", "portable"] }) and the website offers both
// (openwhispr-website lib/downloads.ts:87 lists OpenWhispr-<version>.exe as
// the second Windows option).
//
// The portable launcher stub is the only thing that sets
// PORTABLE_EXECUTABLE_DIR - the folder the .exe was double-clicked from.
// Until now the app read it nowhere, so it could not tell which artifact it
// was, and neither could we: src/updater.js calls quitAndInstall(), which on
// Windows hands the downloaded NSIS installer control. The update therefore
// SUCCEEDS, into Program Files, while the user keeps opening the old portable
// exe in Downloads. The app looks like it never updates.
//
// This module is deliberately the only reader of that variable.
const PORTABLE_BUILD_HEADER = "x-openwhispr-portable";

/** True only when this process is electron-builder's Windows portable build. */
function isPortableBuild(env = process.env) {
  const dir = env && env.PORTABLE_EXECUTABLE_DIR;
  return typeof dir === "string" && dir !== "";
}

/**
 * Adds the build-flavour header, set last so a caller cannot override it.
 *
 * Always "1" or "0" - never the directory, which sits under the user's
 * profile and carries their Windows account name. Sending it unconditionally
 * is what lets the server read an ABSENT header as "client too old to know",
 * which is a different answer from "not portable".
 */
function withPortableBuildHeader(headers, env = process.env) {
  return { ...headers, [PORTABLE_BUILD_HEADER]: isPortableBuild(env) ? "1" : "0" };
}

module.exports = { PORTABLE_BUILD_HEADER, isPortableBuild, withPortableBuildHeader };
