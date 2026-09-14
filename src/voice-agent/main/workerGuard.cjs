#!/usr/bin/env node
// PreToolUse hook of a background worker: the tool wall of `claude -p`.
//
// Measured on Claude Code 2.1.233: in print mode, --allowedTools and --permission-mode do not stop
// a tool that is not on the list (a worker asked for `whoami` ran it). This hook is the actual
// wall: it reads the tool call on stdin and answers deny unless it is a read of the project folder
// or one of a few git read commands.
//
// Contract: JSON on stdin ({ tool_name, tool_input, cwd }), decision printed as JSON on stdout.
const path = require("path");

const GIT_READ = /^git\s+(log|show|status|diff|branch)\b/;
const SHELL_CHAINING = /[;&|`>]|\$\(|\n/;
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

function decide(input) {
  const tool = String(input?.tool_name || "");
  const args = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = String(input?.cwd || process.cwd());

  if (READ_TOOLS.has(tool)) {
    for (const field of PATH_FIELDS) {
      const value = args[field];
      if (typeof value !== "string" || !value) continue;
      const resolved = path.resolve(cwd, value);
      const relative = path.relative(path.resolve(cwd), resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { allow: false, reason: `Outside the project folder: ${value}` };
      }
    }
    return { allow: true };
  }

  if (tool === "Bash") {
    const command = String(args.command || "").trim();
    if (SHELL_CHAINING.test(command)) {
      return { allow: false, reason: "Chained or redirected shell commands are not allowed here." };
    }
    if (!GIT_READ.test(command)) {
      return {
        allow: false,
        reason: "This worker may only run git log, show, status, diff and branch.",
      };
    }
    return { allow: true };
  }

  return { allow: false, reason: `This worker may not use ${tool || "this tool"}.` };
}

function main(raw) {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    input = {};
  }
  const decision = decide(input);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.allow ? "allow" : "deny",
        permissionDecisionReason: decision.reason || "Allowed by the OpenWhispr worker guard.",
      },
    })}\n`
  );
  process.exit(0);
}

if (require.main === module) {
  // Read stdin synchronously: under Electron running as node, the stream events never fired and
  // the hook answered on an empty payload, which denied every call.
  let raw = "";
  try {
    raw = require("fs").readFileSync(0, "utf8");
  } catch {}
  main(raw);
}

module.exports = { decide };
