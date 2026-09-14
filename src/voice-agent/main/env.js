// Environment allowlist for every child process the conversation feature spawns (PowerShell,
// the Python sidecar, claude -p workers). OpenWhispr's main process holds decrypted provider keys
// in process.env; none of them may be inherited by a child.

const BASE_ALLOWED = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PSModulePath",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "HOME",
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/**
 * @param {Record<string, string | undefined>} source
 * @param {{ allow?: string[], extra?: Record<string, string> }} [options]
 *   allow: additional variable names to inherit (never a secret-looking name)
 *   extra: variables set explicitly by the caller (may include a secret the child needs)
 */
function buildChildEnv(source = process.env, options = {}) {
  const allowed = new Set([...BASE_ALLOWED, ...(options.allow || [])].map((n) => n.toLowerCase()));
  const env = {};
  for (const name of Object.keys(source || {})) {
    if (!allowed.has(name.toLowerCase())) continue;
    if (SECRET_NAME.test(name)) continue;
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra || {})) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

module.exports = { buildChildEnv, BASE_ALLOWED };
