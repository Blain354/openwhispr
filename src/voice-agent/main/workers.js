// Background workers of Conversation mode: long read-only tasks delegated to Claude Code (claude -p).
//
// The voice supervisor stays responsive: a delegation is confirmed on screen (the instructions and
// the files the worker reads go to Anthropic), queued, and run with a restricted tool set in an
// allowlisted project folder. Output goes to disk; completion is announced with a fixed sentence.
// A worker's own text never goes back into the voice model's context.
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildChildEnv } = require("./env");
const { buildWorkerLaunch, resolveWorkerCwd } = require("../shared/workerArgv");
const { createLineParser, describeEvent } = require("../shared/streamJson");

const MAX_CONCURRENT = 2;
const TASK_TIMEOUT_MS = 30 * 60_000;
const MAX_TITLE_CHARS = 120;
const MAX_PROMPT_CHARS = 8000;
const MAX_TASKS_LISTED = 20;
const STDERR_TAIL_CHARS = 4096;
const AUTH_ERROR = /failed to authenticate|oauth|not logged in|please run \/login|invalid api key/i;

const WORKER_PREAMBLE = [
  "You are a background worker started from a voice assistant.",
  "You can only read files and git history in the current folder; do not attempt anything else.",
  "Finish with a short summary first (a few sentences, in the language of the task), then details.",
].join(" ");

function defaultClaudePath(platform = process.platform) {
  return path.join(os.homedir(), ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {}
}

const excerpt = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const firstParagraph = (text, max) =>
  excerpt(
    String(text || "")
      .trim()
      .split(/\n\s*\n/)[0] || "",
    max
  );

function createWorkerManager({
  userDataDir,
  getConfig,
  confirm,
  tr,
  debugLogger,
  onUpdate,
  spawnImpl = spawn,
  fsImpl = fs,
  killImpl = killTree,
  now = Date.now,
  env = process.env,
  homeDir = os.homedir(),
}) {
  const tasks = new Map();
  const queue = [];
  const tasksDir = path.join(userDataDir, "voice-agent", "tasks");
  let running = 0;
  let counter = 0;

  const publicTask = (task) => ({
    id: task.id,
    title: task.title,
    project: task.project,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    costUsd: task.costUsd,
    progress: task.progress ?? null,
    summary: task.summary ?? null,
    error: task.error ?? null,
    outputFile: task.outputFile,
  });

  const fail = (displayText) => ({ success: false, displayText });

  function write(file, text) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.appendFileSync(file, text);
    } catch (error) {
      debugLogger?.warn("Worker output write failed", { error: error?.message }, "conversation");
    }
  }

  const audit = (entry) =>
    write(
      path.join(userDataDir, "voice-agent", "audit.jsonl"),
      `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`
    );

  function emit(task, finished = false) {
    try {
      onUpdate?.(publicTask(task), { finished });
    } catch (error) {
      debugLogger?.warn("Worker update handler failed", { error: error?.message }, "conversation");
    }
  }

  function describeRefusal(resolved) {
    switch (resolved.error) {
      case "no-projects":
        return tr("conversation:workers.noProjects");
      case "no-match":
      case "ambiguous":
        return tr("conversation:workers.noMatch", { names: resolved.names.join(", ") || "—" });
      default:
        return tr("conversation:workers.refusedFolder");
    }
  }

  async function delegate(payload, context = {}) {
    const config = getConfig();
    const title = String(payload.title || "")
      .trim()
      .slice(0, MAX_TITLE_CHARS);
    const prompt = String(payload.prompt || "").trim();
    const project = String(payload.project || "").trim();
    if (!title || !prompt) return fail(tr("conversation:workers.missingFields"));
    if (prompt.length > MAX_PROMPT_CHARS) {
      return fail(tr("conversation:workers.promptTooLong", { max: MAX_PROMPT_CHARS }));
    }
    const claudePath = config.claudePath || defaultClaudePath();
    if (!fsImpl.existsSync(claudePath)) {
      return fail(tr("conversation:workers.unavailable", { path: claudePath }));
    }
    const resolved = resolveWorkerCwd(project, {
      roots: config.workerProjectRoots,
      vaultRoot: config.vaultRoot,
      homeDir,
      listDirs: (parent) => {
        try {
          return fsImpl
            .readdirSync(parent, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
      realpath: (dir) => fsImpl.realpathSync.native(dir),
    });
    if (!resolved.ok) {
      audit({ op: "workers.delegate", title, project, decision: `refused:${resolved.error}` });
      return fail(describeRefusal(resolved));
    }

    if (config.confirmDelegation !== false) {
      const approved = await confirm({
        title: tr("conversation:workers.confirmTitle"),
        message: tr("conversation:workers.confirmMessage", { title }),
        detail: [
          tr("conversation:workers.detailProject", { cwd: resolved.cwd }),
          tr("conversation:workers.detailPrivacy"),
          `${tr("conversation:workers.detailPrompt")}\n${excerpt(prompt, 600)}`,
        ].join("\n\n"),
        risk: "normal",
        parent: context.parentWindow,
      });
      if (!approved) {
        audit({ op: "workers.delegate", title, cwd: resolved.cwd, decision: "cancelled" });
        return fail(tr("conversation:workers.cancelled"));
      }
    }

    const id = `t-${now().toString(36)}-${++counter}`;
    const task = {
      id,
      title,
      prompt,
      project: resolved.name,
      cwd: resolved.cwd,
      status: "queued",
      createdAt: now(),
      costUsd: 0,
      outputFile: path.join(tasksDir, `${id}.md`),
    };
    tasks.set(id, task);
    queue.push(task);
    write(
      task.outputFile,
      `# ${title}\n\n- Project: ${resolved.cwd}\n- Created: ${new Date(task.createdAt).toISOString()}\n\n## Instructions\n\n${prompt}\n\n## Worker output\n\n`
    );
    audit({ op: "workers.delegate", taskId: id, title, cwd: resolved.cwd, decision: "approved" });
    emit(task);
    pump();
    return {
      success: true,
      data: { taskId: id, accepted: true },
      displayText: tr("conversation:workers.accepted", { title }),
    };
  }

  function finish(task, status, error) {
    if (task.finishedAt) return;
    task.status = status;
    task.finishedAt = now();
    if (error) task.error = String(error);
    if (task.result) {
      task.costUsd = task.result.costUsd;
      task.summary = firstParagraph(task.result.text, 400);
    }
    write(
      task.outputFile,
      `\n## Result\n\n- Status: ${status}\n${task.error ? `- Error: ${task.error}\n` : ""}- Cost: $${task.costUsd.toFixed(3)}\n\n${task.result?.text || ""}\n`
    );
    audit({
      op: "workers.finish",
      taskId: task.id,
      status,
      costUsd: task.costUsd,
      durationMs: task.startedAt ? task.finishedAt - task.startedAt : 0,
    });
    emit(task, true);
  }

  function start(task) {
    const config = getConfig();
    const launch = buildWorkerLaunch({
      claudePath: config.claudePath || defaultClaudePath(),
      budgetUsd: config.workerBudgetUsd,
    });
    let child;
    try {
      child = spawnImpl(launch.command, launch.args, {
        cwd: task.cwd,
        env: buildChildEnv(env),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(task, "failed", error.message);
      return;
    }
    running++;
    task.child = child;
    task.status = "running";
    task.startedAt = now();
    emit(task);

    let stderrTail = "";
    let settled = false;
    const parser = createLineParser((value) => {
      for (const event of describeEvent(value)) {
        if (event.kind === "text") {
          write(task.outputFile, `${event.text}\n\n`);
          task.progress = excerpt(event.text.split("\n").pop(), 200);
          emit(task);
        } else if (event.kind === "tool") {
          write(task.outputFile, `> ${event.name} ${event.detail}\n\n`);
        } else if (event.kind === "result") {
          task.result = event;
        }
      }
    });

    const settle = (code) => {
      if (settled) return;
      settled = true;
      parser.end();
      clearTimeout(task.timer);
      running--;
      task.child = null;
      const result = task.result;
      if (task.cancelRequested) finish(task, "cancelled");
      else if (task.timedOut) {
        finish(
          task,
          "failed",
          tr("conversation:workers.timedOut", { minutes: TASK_TIMEOUT_MS / 60_000 })
        );
      } else if (result?.denials?.length) {
        finish(
          task,
          "failed",
          tr("conversation:workers.denied", { tools: result.denials.join(", ") })
        );
      } else if (result?.success && code === 0) finish(task, "succeeded");
      else {
        const raw =
          task.spawnError ||
          (result && !result.success ? result.text || result.subtype : "") ||
          stderrTail.trim().slice(-300);
        // A stale CLI login is the common failure, and its raw message does not say what to do.
        const reason = AUTH_ERROR.test(raw)
          ? tr("conversation:workers.authRequired")
          : excerpt(raw, 300) || tr("conversation:workers.exitCode", { code });
        finish(task, "failed", reason);
      }
      pump();
    };

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => parser.push(String(chunk)));
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => {
      task.spawnError = error.message;
      settle(null);
    });
    child.on("close", (code) => settle(code));
    task.timer = setTimeout(() => {
      task.timedOut = true;
      killImpl(child.pid);
    }, TASK_TIMEOUT_MS);
    task.timer.unref?.();
    child.stdin.on("error", () => {});
    child.stdin.end(`${WORKER_PREAMBLE}\n\n${task.prompt}\n`);
  }

  function pump() {
    while (running < MAX_CONCURRENT && queue.length > 0) start(queue.shift());
  }

  function list() {
    const recent = [...tasks.values()].slice(-MAX_TASKS_LISTED).reverse().map(publicTask);
    const lines = recent.map((task) => `${task.id} · ${task.title} · ${task.status}`);
    return {
      success: true,
      data: { tasks: recent, output: lines.join("\n") },
      displayText: recent.length
        ? tr("conversation:workers.listed", { count: recent.length })
        : tr("conversation:workers.none"),
    };
  }

  function cancel(taskId) {
    const task = tasks.get(String(taskId || ""));
    if (!task) return fail(tr("conversation:workers.notFound"));
    if (task.status === "queued") {
      queue.splice(queue.indexOf(task), 1);
      finish(task, "cancelled");
      return {
        success: true,
        displayText: tr("conversation:workers.cancelledTask", { title: task.title }),
      };
    }
    if (task.status === "running") {
      task.cancelRequested = true;
      killImpl(task.child?.pid);
      return {
        success: true,
        displayText: tr("conversation:workers.cancelling", { title: task.title }),
      };
    }
    return fail(tr("conversation:workers.alreadyFinished", { title: task.title }));
  }

  function shutdownSync() {
    for (const task of tasks.values()) {
      if (task.status === "running" && task.child?.pid) {
        task.cancelRequested = true;
        killTreeSync(task.child.pid);
      }
    }
  }

  return { delegate, list, cancel, shutdownSync, runningCount: () => running };
}

module.exports = {
  createWorkerManager,
  defaultClaudePath,
  MAX_CONCURRENT,
  TASK_TIMEOUT_MS,
  WORKER_PREAMBLE,
};
