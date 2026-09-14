const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough, Writable } = require("stream");

const { createWorkerManager, MAX_CONCURRENT } = require("../../src/voice-agent/main/workers");

const HOME = path.resolve("/home/tester");
const CODE = path.join(HOME, "code");
const USER_DATA = path.join(HOME, "appdata");

function fakeFs() {
  const files = {};
  return {
    files,
    existsSync: () => true,
    mkdirSync: () => {},
    appendFileSync: (file, text) => {
      files[file] = (files[file] || "") + text;
    },
    readdirSync: () => ["alpha", "beta"].map((name) => ({ name, isDirectory: () => true })),
    realpathSync: { native: (dir) => dir },
  };
}

function fakeSpawn() {
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdinText = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        child.stdinText += chunk;
        callback();
      },
    });
    child.command = command;
    child.args = args;
    child.options = options;
    child.finish = (lines, code = 0) => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      setImmediate(() => child.emit("close", code));
    };
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

const tr = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ approve = true, config = {} } = {}) {
  const fsImpl = fakeFs();
  const { spawnImpl, children } = fakeSpawn();
  const updates = [];
  const confirmations = [];
  const killed = [];
  const manager = createWorkerManager({
    userDataDir: USER_DATA,
    getConfig: () => ({
      claudePath: "claude-bin",
      workerProjectRoots: [`${CODE}${path.sep}*`],
      vaultRoot: path.join(HOME, "Notes"),
      confirmDelegation: true,
      workerBudgetUsd: 2,
      ...config,
    }),
    confirm: async (request) => {
      confirmations.push(request);
      return approve;
    },
    tr,
    onUpdate: (task, meta) => updates.push({ ...task, finished: meta.finished }),
    spawnImpl,
    fsImpl,
    killImpl: (pid) => killed.push(pid),
    env: { PATH: "x", USERPROFILE: HOME, ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret" },
    homeDir: HOME,
  });
  return { manager, fsImpl, children, updates, confirmations, killed };
}

const RESULT = (extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Summary line.\n\nMore details.",
  total_cost_usd: 0.05,
  duration_ms: 1000,
  num_turns: 2,
  permission_denials: [],
  ...extra,
});

test("a confirmed delegation runs in the project folder with a clean environment", async () => {
  const { manager, children, confirmations, updates, fsImpl } = setup();
  const accepted = await manager.delegate(
    { title: "Commits", prompt: "Summarize today's commits", project: "Alpha" },
    {}
  );
  assert.equal(accepted.success, true);
  assert.match(accepted.data.taskId, /^t-/);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].detail, /alpha/);
  const [child] = children;
  assert.equal(child.command, "claude-bin");
  assert.equal(child.options.cwd, path.join(CODE, "alpha"));
  assert.equal(
    Object.keys(child.options.env).some((name) => /KEY|TOKEN/i.test(name)),
    false
  );
  assert.match(child.stdinText, /Summarize today's commits/);

  child.finish([
    { type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } },
    RESULT(),
  ]);
  await tick();
  await tick();
  const last = updates.at(-1);
  assert.equal(last.status, "succeeded");
  assert.equal(last.finished, true);
  assert.equal(last.summary, "Summary line.");
  assert.equal(last.costUsd, 0.05);
  const output = fsImpl.files[last.outputFile];
  assert.match(output, /Working on it/);
  assert.match(output, /Status: succeeded/);
});

test("a refused confirmation or a vault folder starts nothing", async () => {
  const refused = setup({ approve: false });
  const result = await refused.manager.delegate({ title: "t", prompt: "p", project: "alpha" }, {});
  assert.equal(result.success, false);
  assert.equal(refused.children.length, 0);

  const vault = setup({ config: { workerProjectRoots: [path.join(HOME, "Notes")] } });
  const blocked = await vault.manager.delegate({ title: "t", prompt: "p", project: "Notes" }, {});
  assert.equal(blocked.success, false);
  assert.equal(vault.confirmations.length, 0);
  assert.equal(vault.children.length, 0);
});

test("at most two workers run at once; a queued task can be cancelled", async () => {
  const { manager, children } = setup();
  const ids = [];
  for (const project of ["alpha", "beta", "alpha"]) {
    ids.push((await manager.delegate({ title: project, prompt: "p", project }, {})).data.taskId);
  }
  assert.equal(children.length, MAX_CONCURRENT);
  assert.equal(manager.runningCount(), 2);
  assert.equal(manager.cancel(ids[2]).success, true);
  children[0].finish([RESULT()]);
  await tick();
  await tick();
  assert.equal(children.length, 2, "the cancelled task never starts");
  const statuses = manager.list().data.tasks.map((task) => task.status);
  assert.deepEqual(statuses, ["cancelled", "running", "succeeded"]);
});

test("a tool refusal fails the task, and cancelling a running task kills its tree", async () => {
  const { manager, children, updates, killed } = setup();
  await manager.delegate({ title: "one", prompt: "p", project: "alpha" }, {});
  children[0].finish([RESULT({ permission_denials: [{ tool_name: "Bash" }] })]);
  await tick();
  await tick();
  assert.equal(updates.at(-1).status, "failed");
  assert.match(updates.at(-1).error, /denied/);

  const second = await manager.delegate({ title: "two", prompt: "p", project: "beta" }, {});
  const cancelled = manager.cancel(second.data.taskId);
  assert.equal(cancelled.success, true);
  assert.deepEqual(killed, [children[1].pid]);
  children[1].emit("close", 1);
  await tick();
  assert.equal(updates.at(-1).status, "cancelled");
});

test("a stale Claude Code login is reported as a sign-in request", async () => {
  const { manager, children, updates } = setup();
  await manager.delegate({ title: "auth", prompt: "p", project: "alpha" }, {});
  children[0].finish(
    [
      RESULT({
        is_error: true,
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
        total_cost_usd: 0,
      }),
    ],
    1
  );
  await tick();
  await tick();
  assert.equal(updates.at(-1).status, "failed");
  assert.equal(updates.at(-1).error, "conversation:workers.authRequired");
});
