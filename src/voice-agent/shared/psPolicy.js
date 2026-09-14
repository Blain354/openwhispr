// Risk classification for run_powershell. Pure logic, main process only.
//
// Every run_powershell call is confirmed with a button whatever the risk; the classification only
// decides how loudly the confirmation warns, and whether the script is refused outright because it
// reaches for credential material. The parse facts come from a PowerShell AST helper that reads
// the script as data and never executes it.

// Canonical, read-only cmdlets. Aliases (ls, dir, gci, ?, %) are deliberately absent: an alias
// hides what runs, so a script that uses one is shown as high risk.
const LOW_RISK_COMMANDS = new Set([
  "get-date",
  "get-process",
  "get-service",
  "get-childitem",
  "get-startapps",
  "get-volume",
  "get-computerinfo",
  "get-netadapter",
  "select-object",
  "where-object",
  "sort-object",
  "measure-object",
  "format-table",
  "format-list",
  "convertto-json",
  "out-string",
  "write-output",
]);

// Refused outright: secrets the same-user process could read and exfiltrate.
const SENSITIVE_PATTERNS = [
  /cli-bridge\.json/i,
  /\.credentials\.json/i,
  /secure-keys/i,
  /voice-agent[\\/]+secrets/i,
  /local state/i,
  /master-key/i,
  /[\\/]\.ssh([\\/]|\b)/i,
  /\bid_(rsa|ed25519|ecdsa)\b/i,
];

const ENCODED_COMMAND = /(^|\s)-e(c|nc|ncodedcommand)?(\s|$)/i;
const NETWORK_COMMANDS =
  /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|start-bitstransfer|new-object\s+net\.webclient)\b/i;

/**
 * @param {{errors: number, commands: string[], members: number, scriptBlocks: number,
 *          redirections: number, invocations: number} | null} parsed
 * @param {string} script
 * @returns {{risk: "low" | "high", refused: boolean, reasons: string[]}}
 */
function classifyPowerShell(parsed, script) {
  const reasons = [];
  const text = String(script || "");

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { risk: "high", refused: true, reasons: [`sensitive-path:${pattern.source}`] };
    }
  }

  if (!text.trim()) reasons.push("empty-script");
  if (!parsed) reasons.push("parse-unavailable");
  else {
    if (parsed.errors > 0) reasons.push("parse-errors");
    if (parsed.members > 0) reasons.push("member-invocation");
    if (parsed.scriptBlocks > 0) reasons.push("script-block");
    if (parsed.redirections > 0) reasons.push("redirection");
    if (parsed.invocations > 0) reasons.push("call-operator");
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    for (const command of commands) {
      const name = String(command || "").toLowerCase();
      if (!name || !LOW_RISK_COMMANDS.has(name)) reasons.push(`command:${command || "?"}`);
    }
  }
  if (ENCODED_COMMAND.test(text)) reasons.push("encoded-command");
  if (NETWORK_COMMANDS.test(text)) reasons.push("network");

  return { risk: reasons.length === 0 ? "low" : "high", refused: false, reasons };
}

module.exports = { classifyPowerShell, LOW_RISK_COMMANDS, SENSITIVE_PATTERNS };
