// Windows OS actions for Conversation mode: open_app, focus_window, set_displays, run_powershell.
//
// Every dynamic value reaches PowerShell as JSON on stdin, never interpolated into a command line.
// Our own wrapper scripts go through -EncodedCommand so no quoting rules apply. Mutating actions
// (set_displays, run_powershell) are confirmed by the main process before they run.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildChildEnv } = require("./env");
const { matchApp } = require("../shared/appMatch");
const { classifyPowerShell } = require("../shared/psPolicy");

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const POWERSHELL = path.join(
  SYSTEM_ROOT,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const EXPLORER = path.join(SYSTEM_ROOT, "explorer.exe");
const DISPLAY_SWITCH = path.join(SYSTEM_ROOT, "System32", "DisplaySwitch.exe");

const START_APPS_TTL_MS = 10 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
// Our own helper scripts return structured data (Get-StartApps is ~40 KB): only a user script's
// output is capped at MAX_OUTPUT_BYTES.
const HELPER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REVIEWABLE_SCRIPT_CHARS = 3000;
const DISPLAY_MODES = new Set(["internal", "external", "extend", "clone"]);

const PRELUDE =
  "$ProgressPreference='SilentlyContinue';" +
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "$OutputEncoding=[Console]::OutputEncoding;";

const READ_INPUT = "$__in=[Console]::In.ReadToEnd();";

const START_APPS_SCRIPT =
  PRELUDE +
  "$a=@(Get-StartApps | Select-Object Name,AppID);" +
  "[Console]::Out.Write((ConvertTo-Json -InputObject $a -Compress -Depth 3))";

const PARSE_SCRIPT =
  PRELUDE +
  READ_INPUT +
  "$t=$null;$e=$null;" +
  "$ast=[System.Management.Automation.Language.Parser]::ParseInput($__in,[ref]$t,[ref]$e);" +
  "function Count-Ast($type){ @($ast.FindAll({ param($n) $n -is $type }, $true)).Count };" +
  "$cmds=@($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true));" +
  "$r=[ordered]@{" +
  "errors=@($e).Count;" +
  "commands=@($cmds | ForEach-Object { [string]$_.GetCommandName() });" +
  "members=(Count-Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]));" +
  "scriptBlocks=(Count-Ast ([System.Management.Automation.Language.ScriptBlockExpressionAst]));" +
  "redirections=(Count-Ast ([System.Management.Automation.Language.FileRedirectionAst]));" +
  "invocations=@($cmds | Where-Object { [string]$_.InvocationOperator -ne 'Unknown' }).Count" +
  "};" +
  "[Console]::Out.Write((ConvertTo-Json -InputObject $r -Compress -Depth 3))";

const RUN_SCRIPT =
  PRELUDE +
  READ_INPUT +
  "$Error.Clear();" +
  "try {" +
  "$o = & ([ScriptBlock]::Create($__in)) 2>$null | Out-String -Width 200;" +
  "[Console]::Out.Write($o);" +
  "if ($Error.Count -gt 0) { [Console]::Error.Write((($Error | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)); exit 1 };" +
  "if ($LASTEXITCODE) { exit $LASTEXITCODE };" +
  "exit 0" +
  "} catch { [Console]::Error.Write($_.ToString()); exit 1 }";

const FOCUS_SCRIPT =
  PRELUDE +
  READ_INPUT +
  "$q=[WildcardPattern]::Escape([string](ConvertFrom-Json $__in).query);" +
  "$p=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like ('*'+$q+'*') -or $_.MainWindowTitle -like ('*'+$q+'*')) } | Select-Object -First 1;" +
  "if (-not $p) { [Console]::Out.Write('{\"found\":false}'); exit 0 };" +
  'Add-Type -Namespace OwConversation -Name Win32 -MemberDefinition \'[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\';' +
  "if ([OwConversation.Win32]::IsIconic($p.MainWindowHandle)) { [void][OwConversation.Win32]::ShowWindowAsync($p.MainWindowHandle, 9) };" +
  "$ok=(New-Object -ComObject WScript.Shell).AppActivate($p.Id);" +
  "if (-not $ok) { $ok=[OwConversation.Win32]::SetForegroundWindow($p.MainWindowHandle) };" +
  "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{found=$true;ok=[bool]$ok;title=[string]$p.MainWindowTitle;process=[string]$p.ProcessName})))";

const WINDOW_PRESENT_SCRIPT =
  PRELUDE +
  READ_INPUT +
  "$q=[WildcardPattern]::Escape([string](ConvertFrom-Json $__in).query);" +
  "$p=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like ('*'+$q+'*') -or $_.MainWindowTitle -like ('*'+$q+'*')) } | Select-Object -First 1;" +
  "[Console]::Out.Write(($(if ($p) { 'true' } else { 'false' })))";

function encodeCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {}
}

function runPowerShellProcess(
  script,
  { input = "", timeoutMs = HELPER_TIMEOUT_MS, maxOutputBytes = HELPER_MAX_OUTPUT_BYTES } = {}
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        POWERSHELL,
        [
          "-NoProfile",
          "-NonInteractive",
          "-NoLogo",
          "-InputFormat",
          "Text",
          "-OutputFormat",
          "Text",
          "-EncodedCommand",
          encodeCommand(script),
        ],
        { windowsHide: true, env: buildChildEnv(process.env), stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error.message, timedOut: false, truncated: false });
      return;
    }

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (chunks, chunk, counter) => {
      const room = maxOutputBytes - counter;
      if (room <= 0) {
        truncated = true;
        return counter;
      }
      if (chunk.length > room) truncated = true;
      chunks.push(chunk.subarray(0, room));
      return counter + Math.min(chunk.length, room);
    };

    child.stdout.on("data", (chunk) => {
      outBytes = collect(out, chunk, outBytes);
    });
    child.stderr.on("data", (chunk) => {
      errBytes = collect(err, chunk, errBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: error.message, timedOut, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function createOsActions({ userDataDir, confirm, tr, debugLogger, platform = process.platform }) {
  let startAppsCache = { at: 0, entries: [] };

  function audit(entry) {
    try {
      const dir = path.join(userDataDir, "voice-agent");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "audit.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
      );
    } catch (error) {
      debugLogger?.warn(
        "Conversation audit write failed",
        { error: error?.message },
        "conversation"
      );
    }
  }

  function windowsOnly() {
    return { success: false, displayText: tr("conversation:common.windowsOnly") };
  }

  async function getStartApps() {
    if (Date.now() - startAppsCache.at < START_APPS_TTL_MS && startAppsCache.entries.length) {
      return startAppsCache.entries;
    }
    const result = await runPowerShellProcess(START_APPS_SCRIPT);
    const entries = toArray(parseJson(result.stdout, [])).filter(
      (entry) => entry && typeof entry.Name === "string" && typeof entry.AppID === "string"
    );
    if (entries.length) startAppsCache = { at: Date.now(), entries };
    return entries;
  }

  async function isWindowPresent(query) {
    const result = await runPowerShellProcess(WINDOW_PRESENT_SCRIPT, {
      input: JSON.stringify({ query }),
    });
    return result.stdout.trim() === "true";
  }

  async function openApp(payload, context) {
    if (platform !== "win32") return windowsOnly();
    const query = String(payload.name || "").trim();
    if (!query)
      return { success: false, displayText: tr("conversation:openApp.notFound", { query }) };

    const { match, candidates } = matchApp(query, await getStartApps());
    if (!match) {
      const names = candidates.map((c) => c.Name);
      const key =
        names.length > 1 ? "conversation:openApp.ambiguous" : "conversation:openApp.notFound";
      audit({ op: "os.openApp", windowKind: context?.windowKind, query, decision: "no-match" });
      return {
        success: false,
        data: { candidates: names },
        displayText: tr(key, { query, candidates: names.join(", ") }),
      };
    }

    const child = spawn(EXPLORER, [`shell:appsFolder\\${match.AppID}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => {});
    child.unref();

    const probe = match.Name.split(/\s+/)[0];
    let verified = false;
    for (let attempt = 0; attempt < 4 && !verified; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      verified = await isWindowPresent(probe);
    }

    audit({ op: "os.openApp", windowKind: context?.windowKind, query, app: match.Name, verified });
    return {
      success: true,
      data: { app: match.Name, verified },
      displayText: tr(
        verified ? "conversation:openApp.launched" : "conversation:openApp.launchedUnverified",
        { name: match.Name }
      ),
    };
  }

  async function focusWindow(payload, context) {
    if (platform !== "win32") return windowsOnly();
    const query = String(payload.query || "").trim();
    if (!query)
      return { success: false, displayText: tr("conversation:focusWindow.notFound", { query }) };
    const result = await runPowerShellProcess(FOCUS_SCRIPT, { input: JSON.stringify({ query }) });
    const parsed = parseJson(result.stdout, { found: false });
    audit({ op: "os.focusWindow", windowKind: context?.windowKind, query, ...parsed });
    if (!parsed.found) {
      return { success: false, displayText: tr("conversation:focusWindow.notFound", { query }) };
    }
    const title = parsed.title || parsed.process || query;
    return parsed.ok
      ? {
          success: true,
          data: { title },
          displayText: tr("conversation:focusWindow.focused", { title }),
        }
      : {
          success: false,
          data: { title },
          displayText: tr("conversation:focusWindow.blocked", { title }),
        };
  }

  async function setDisplays(payload, context) {
    if (platform !== "win32") return windowsOnly();
    const mode = String(payload.mode || "")
      .trim()
      .toLowerCase();
    if (!DISPLAY_MODES.has(mode)) {
      return { success: false, displayText: tr("conversation:setDisplays.invalidMode", { mode }) };
    }
    const approved = await confirm({
      title: tr("conversation:setDisplays.title"),
      message: tr("conversation:setDisplays.message", { mode }),
      detail: tr("conversation:setDisplays.detail"),
      risk: "high",
      parent: context?.parentWindow,
    });
    audit({
      op: "os.setDisplays",
      windowKind: context?.windowKind,
      mode,
      decision: approved ? "approved" : "declined",
    });
    if (!approved) return { success: false, displayText: tr("conversation:common.cancelled") };

    await new Promise((resolve) => {
      const child = spawn(DISPLAY_SWITCH, [`/${mode}`], { windowsHide: true, stdio: "ignore" });
      child.on("error", resolve);
      child.on("close", resolve);
    });
    return {
      success: true,
      data: { mode },
      displayText: tr("conversation:setDisplays.done", { mode }),
    };
  }

  async function runPowershell(payload, context) {
    if (platform !== "win32") return windowsOnly();
    const script = String(payload.script || "");
    const reason = String(payload.reason || "").slice(0, 300);
    const scriptSha256 = crypto.createHash("sha256").update(script).digest("hex");

    if (script.length > MAX_REVIEWABLE_SCRIPT_CHARS) {
      audit({
        op: "os.runPowershell",
        windowKind: context?.windowKind,
        scriptSha256,
        decision: "refused-too-long",
      });
      return { success: false, displayText: tr("conversation:runPowershell.refusedTooLong") };
    }

    const parseResult = await runPowerShellProcess(PARSE_SCRIPT, { input: script });
    const parsed = parseJson(parseResult.stdout, null);
    const verdict = classifyPowerShell(parsed, script);
    if (verdict.refused) {
      audit({
        op: "os.runPowershell",
        windowKind: context?.windowKind,
        scriptSha256,
        script,
        decision: "refused-sensitive",
        reasons: verdict.reasons,
      });
      return { success: false, displayText: tr("conversation:runPowershell.refusedSensitive") };
    }

    const detail = [
      reason ? tr("conversation:runPowershell.reason", { reason }) : "",
      verdict.reasons.length
        ? tr("conversation:runPowershell.risks", { reasons: verdict.reasons.join(", ") })
        : "",
      tr("conversation:runPowershell.script"),
      script,
    ]
      .filter(Boolean)
      .join("\n");

    const approved = await confirm({
      title: tr("conversation:runPowershell.title"),
      message: tr(
        verdict.risk === "high"
          ? "conversation:runPowershell.messageHigh"
          : "conversation:runPowershell.messageLow"
      ),
      detail,
      risk: verdict.risk,
      parent: context?.parentWindow,
    });
    if (!approved) {
      audit({
        op: "os.runPowershell",
        windowKind: context?.windowKind,
        scriptSha256,
        script,
        risk: verdict.risk,
        reasons: verdict.reasons,
        decision: "declined",
      });
      return { success: false, displayText: tr("conversation:common.cancelled") };
    }

    const result = await runPowerShellProcess(RUN_SCRIPT, {
      maxOutputBytes: MAX_OUTPUT_BYTES,
      input: script,
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    const ok = !result.timedOut && result.code === 0 && !result.stderr.trim();
    audit({
      op: "os.runPowershell",
      windowKind: context?.windowKind,
      scriptSha256,
      script,
      risk: verdict.risk,
      reasons: verdict.reasons,
      decision: "approved",
      exitCode: result.code,
      timedOut: result.timedOut,
    });

    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    let displayText = tr("conversation:runPowershell.succeeded");
    if (result.timedOut) {
      displayText = tr("conversation:runPowershell.timedOut", {
        seconds: SCRIPT_TIMEOUT_MS / 1000,
      });
    } else if (!ok) {
      displayText = tr("conversation:runPowershell.failed", { code: result.code });
    }
    return {
      success: ok,
      data: { output, exitCode: result.code, truncated: result.truncated },
      displayText: ok ? displayText : `${displayText}${output ? `\n${output}` : ""}`,
    };
  }

  return { openApp, focusWindow, setDisplays, runPowershell, getStartApps };
}

module.exports = {
  createOsActions,
  runPowerShellProcess,
  encodeCommand,
  PARSE_SCRIPT,
  RUN_SCRIPT,
  DISPLAY_MODES,
  MAX_REVIEWABLE_SCRIPT_CHARS,
};
