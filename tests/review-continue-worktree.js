#!/usr/bin/env node

// Q-018: retained worktree claims and sequential jobs share one integratable patch.
// Git, SQLite, scopes and validation are real; only OpenCode is replaced by the existing hook.
// CODEX_TEST_ONLY=registry runs the first implementation step without the new job schema.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLockPlanRuntime } from "../lib/lock-plan.js";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const root = await mkdtemp(path.join(tmpdir(), "review-continue-worktree-"));
process.env.CODEX_OPENCODE_STATE_DIR = path.join(root, "global-state");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_WORKTREE_ROOT = "global";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Continue Test\n\temail = continue@example.invalid\n[core]\n\tautocrlf = false\n");
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { internals: I, hooks } = __selfTest;
const saved = { stateDirectoryOverride: hooks.stateDirectoryOverride, queueModeOverride: hooks.queueModeOverride };
hooks.stateDirectoryOverride = path.join(root, "state");
hooks.queueModeOverride = "sqlite";
const execFileAsync = promisify(execFile);
const VALIDATION = "git diff --check";
const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const tool = (name, args) => I.server._registeredTools[name].handler(args, {});
let sequence = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
async function write(cwd, file, content) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), content);
}
async function repo(name) {
  const cwd = path.join(root, `${++sequence}-${name}`);
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "-q", "-b", "main");
  await write(cwd, "src/seed.txt", "seed\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-q", "-m", "seed");
  return await I.resolveProjectStateRoot(cwd);
}
async function database(cwd, operation) {
  const db = await I.openLockDb(cwd);
  try { return operation(db); } finally { I.closeDb(db); }
}
async function artifact(cwd, worktreePath) {
  return database(cwd, (db) => db.prepare("SELECT * FROM worktree_artifacts WHERE worktree_path = ?").get(path.resolve(worktreePath)));
}
async function retained(cwd, name = "source", edits = { "src/a.txt": "from A\n" }) {
  const branch = `q018-${++sequence}-${name}`;
  const worktreePath = path.join(root, branch);
  await git(cwd, "worktree", "add", "-q", "-b", branch, worktreePath, "HEAD");
  for (const [file, content] of Object.entries(edits)) await write(worktreePath, file, content);
  const now = new Date().toISOString();
  await database(cwd, (db) => db.prepare(`INSERT INTO worktree_artifacts
    (worktree_path, cwd, branch, job_id, status, measured_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'retained', 1, ?, ?)`)
    .run(path.resolve(worktreePath), cwd, branch, `${name}-job-A`, now, now));
  return { cwd, worktreePath, branch, previousJobId: `${name}-job-A` };
}
async function queueOwner(cwd, jobId, status = "running") {
  await database(cwd, (db) => db.prepare(`INSERT INTO opencode_jobs
    (job_id, cwd, status, agent, mode, created_at, record_json)
    VALUES (?, ?, ?, 'builder', 'write', ?, '{}')`).run(jobId, cwd, status, new Date().toISOString()));
}
async function clearQueueOwner(cwd, jobId) {
  await database(cwd, (db) => db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run(jobId));
}
const claim = (source, jobId, extra = {}) => I.claimRetainedWorktree({ cwd: source.cwd, worktreePath: source.worktreePath, jobId, ...extra });
const release = (source, jobId) => I.releaseRetainedWorktreeClaim({ cwd: source.cwd, worktreePath: source.worktreePath, jobId });
function refusal(result, errorType) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.errorType, errorType, JSON.stringify(result));
  assert.ok(result.suggestedFix?.trim(), "a stable refusal includes an actionable suggestedFix");
}

test("Q-018 registry: CAS has one winner and release is fenced by job ownership", async () => {
  const cwd = await repo("cas");
  const source = await retained(cwd);
  const owners = ["cas-owner-B", "cas-owner-C"];
  for (const owner of owners) await queueOwner(cwd, owner);
  try {
    const results = await Promise.all(owners.map((owner) => claim(source, owner)));
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    const winner = results[0].ok ? 0 : 1;
    refusal(results[1 - winner], "worktree_in_use");
    assert.equal(results[winner].continuedFrom, source.previousJobId);
    assert.equal(results[winner].branch, source.branch);
    assert.equal((await artifact(cwd, source.worktreePath)).job_id, owners[winner]);
    await release(source, owners[1 - winner]);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use", "a foreign release cannot unlock the writer");
    await release(source, owners[winner]);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
    await release(source, owners[winner]);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained", "release is idempotent");
  } finally { for (const owner of owners) await clearQueueOwner(cwd, owner); }
});

test("Q-018 registry: every active queue status protects its claim from recovery", async () => {
  const cwd = await repo("queue-live");
  const source = await retained(cwd);
  for (const status of ["pending", "planned", "running", "validating", "reviewing", "testing", "blocked"]) {
    const owner = `live-${status}`;
    await queueOwner(cwd, owner, status);
    try {
      assert.equal((await claim(source, owner)).ok, true);
      await I.recoverStaleWorktreeClaims(cwd);
      assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use", status);
      refusal(await claim(source, "competing-owner"), "worktree_in_use");
      await release(source, owner);
    } finally { await clearQueueOwner(cwd, owner); }
  }
});

test("Q-018 registry: a started direct run requires a live bridge owner", async () => {
  const cwd = await repo("direct-live");
  const source = await retained(cwd);
  const owner = "live-direct-job";
  const audit = I.directRunAuditStore();
  const handle = await audit.start({ cwd, agent: "builder" }, { jobId: owner });
  assert.equal(handle.audit.startedPersisted, true);
  try {
    assert.equal((await claim(source, owner)).ok, true);
    await I.recoverStaleWorktreeClaims(cwd);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
    refusal(await claim(source, "competitor"), "worktree_in_use");
  } finally { await audit.finish(handle, { errorType: "fixture_finished" }); }
  await I.recoverStaleWorktreeClaims(cwd);
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained", "a finished direct run no longer owns the worktree");
});

test("Q-018 registry: stale claims recover lazily and dry-run performs no write", async () => {
  const cwd = await repo("lazy");
  const source = await retained(cwd);
  await database(cwd, (db) => db.prepare("UPDATE worktree_artifacts SET status = 'in_use', job_id = 'dead-owner' WHERE worktree_path = ?").run(source.worktreePath));
  const before = { ...await artifact(cwd, source.worktreePath) };
  const preview = await claim(source, "dry-run", { dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual({ ...await artifact(cwd, source.worktreePath) }, before);
  const next = await claim(source, "recovered-owner");
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.continuedFrom, "dead-owner");
  assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
  await release(source, "recovered-owner");
});

test("Q-018 registry: startup recovery releases a dead claim", async () => {
  const cwd = await repo("startup");
  const source = await retained(cwd);
  await database(cwd, (db) => db.prepare("UPDATE worktree_artifacts SET status = 'in_use', job_id = 'dead-startup-owner' WHERE worktree_path = ?").run(source.worktreePath));
  await I.reconcileQueueStateAtStartup();
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 registry: in_use is listed and reconciliation preserves its identity", async () => {
  const cwd = await repo("registry-view");
  const source = await retained(cwd);
  await queueOwner(cwd, "view-owner");
  try {
    assert.equal((await claim(source, "view-owner")).ok, true);
    await I.reconcileWorktreeArtifactRegistry(cwd);
    assert.equal((await artifact(cwd, source.worktreePath)).job_id, "view-owner");
    const listed = (await I.listRetainedWorktreeArtifacts(cwd)).find((row) => row.worktreePath === source.worktreePath);
    assert.equal(listed?.status, "in_use");
  } finally { await release(source, "view-owner"); await clearQueueOwner(cwd, "view-owner"); }
});

test("Q-018 registry: cleaned and unregistered paths cannot be claimed", async () => {
  const cwd = await repo("not-retained");
  const source = await retained(cwd);
  await database(cwd, (db) => db.prepare("UPDATE worktree_artifacts SET status = 'cleaned' WHERE worktree_path = ?").run(source.worktreePath));
  refusal(await claim(source, "new-owner"), "worktree_not_retained");
  refusal(await claim({ cwd, worktreePath: path.join(root, "missing") }, "new-owner"), "worktree_not_retained");
});

test("Q-018 registry: a live serial integration lock excludes a new claim", async () => {
  const cwd = await repo("integration-lock");
  const source = await retained(cwd);
  await database(cwd, (db) => db.prepare(`INSERT INTO locks
    (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task)
    VALUES ('__repository__', 'integration', 'q018-integration-lock', 'fixture', 'serial_integration', ?, ?, ?, '')`)
    .run(Date.now() + 60_000, Date.now(), cwd));
  try {
    refusal(await claim(source, "blocked-claim"), "worktree_in_use");
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
  } finally {
    await database(cwd, (db) => db.prepare("DELETE FROM locks WHERE run_id = 'q018-integration-lock'").run());
  }
  assert.equal((await claim(source, "unblocked-claim")).ok, true);
  await release(source, "unblocked-claim");
});

test("Q-018 registry: a fresh writer's retained row cannot be continued before it finishes", async () => {
  const cwd = await repo("fresh-live");
  const source = await retained(cwd);
  const audit = I.directRunAuditStore();
  const handle = await audit.start({ cwd, agent: "builder" }, { jobId: source.previousJobId });
  assert.equal(handle.audit.startedPersisted, true);
  try {
    refusal(await claim(source, "premature-B"), "worktree_in_use");
    refusal(await claim(source, "premature-preview", { dryRun: true }), "worktree_in_use");
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
  } finally { await audit.finish(handle, { errorType: "fixture_finished" }); }
  assert.equal((await claim(source, "finished-A-next-B")).ok, true);
  await release(source, "finished-A-next-B");
});

test("Q-018 registry: containment quarantine blocks even a disjoint continuation", async () => {
  const cwd = await repo("quarantine");
  const source = await retained(cwd);
  await database(cwd, (db) => db.prepare(`INSERT INTO locks
    (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task)
    VALUES ('src/unrelated.txt', 'builder', 'q018-quarantine', 'fixture', 'write', ?, ?, ?, '')`)
    .run(Number.MAX_SAFE_INTEGER, Date.now(), cwd));
  try {
    refusal(await claim(source, "disjoint-claim"), "worktree_in_use");
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
  } finally {
    await database(cwd, (db) => db.prepare("DELETE FROM locks WHERE run_id = 'q018-quarantine'").run());
  }
  assert.equal((await claim(source, "after-quarantine-resolved")).ok, true);
  await release(source, "after-quarantine-resolved");
});

function writeJob(cwd, file = "src/b.txt", extra = {}) {
  return {
    agent: "builder", task: `Write ${file}.`, cwd, write: true, lockMode: "simple",
    lockedPaths: [file], allowedEdits: [file], validationCommand: VALIDATION, timeoutMs: 600_000,
    scopeContract: { mode: "write", read: ["src"], write: [file], allowedEdits: [file], forbidden: [".env"], validationCommand: VALIDATION },
    ...extra,
  };
}
function fakeAgent(onRun = async () => {}) {
  const runs = [];
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: agent === "builder" || agent === "debugger", canDelegate: false,
      externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true,
      protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan, timeoutMs, options = {}) => {
      const run = { agent, prompt, cwd, dryRun, lockPlan, timeoutMs, signal: options.signal, index: runs.length };
      runs.push(run);
      const started = Date.now();
      const outcome = dryRun ? {} : await onRun(run);
      return {
        exitCode: 0, stdout: "REPORT: done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs: started, childFinishedAtMs: Date.now() + 1, ...outcome,
      };
    },
  };
  return runs;
}
async function execute(job, options = {}) {
  const jobId = options.jobId || `q018-execution-${++sequence}`;
  const audit = I.directRunAuditStore();
  const handle = await audit.start(job, { jobId });
  assert.equal(handle.audit.startedPersisted, true, "the fake agent has real durable direct-run ownership");
  let execution;
  try {
    execution = await I.executeOpenCodeJob(job, { ...options, jobId });
    return { ...execution, fixtureJobId: jobId };
  } finally {
    await audit.finish(handle, { execution, executionThrew: !execution });
  }
}
function accepted(execution) {
  assert.ok(!execution.result?.errorType, textOf(execution.response));
  assert.deepEqual(execution.validation?.disallowedFiles || [], [], textOf(execution.response));
}
function sameFiles(actual, expected) { assert.deepEqual([...actual].sort(), [...expected].sort()); }

test("Q-018 execution: B sees A's uncommitted work and only B's edits belong to B", async () => {
  const cwd = await repo("chain");
  fakeAgent(async (run) => {
    if (run.index === 0) await write(run.cwd, "src/a.txt", "from A\n");
    else {
      assert.equal(await readFile(path.join(run.cwd, "src/a.txt"), "utf8"), "from A\n");
      await write(run.cwd, "src/b.txt", "from B\n");
    }
  });
  const first = await execute(writeJob(cwd, "src/a.txt"));
  accepted(first);
  assert.ok(first.worktree?.path);
  const second = await execute(writeJob(cwd, "src/b.txt", { continueWorktree: first.worktree.path }));
  accepted(second);
  sameFiles(second.result.changedFiles, ["src/b.txt"]);
  sameFiles(second.result.worktree.changedFiles, ["src/a.txt", "src/b.txt"]);
  sameFiles(second.result.worktree.thisRunChangedFiles, ["src/b.txt"]);
  assert.equal(second.result.worktree.continued, true);
  assert.equal(second.result.worktree.continuedFrom, first.fixtureJobId);
  assert.equal(second.worktree.path, first.worktree.path);
  assert.equal((await artifact(cwd, first.worktree.path)).status, "retained");
  assert.equal(existsSync(path.join(cwd, "src/a.txt")), false, "the chain has not been integrated implicitly");
  assert.equal(existsSync(path.join(cwd, "src/b.txt")), false);
});

test("Q-018 execution: a no-edit continuation retains A's work", async () => {
  const cwd = await repo("no-edits");
  const source = await retained(cwd);
  fakeAgent();
  const result = await execute(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }));
  accepted(result);
  assert.deepEqual(result.result.changedFiles, []);
  assert.ok(existsSync(source.worktreePath));
  assert.equal(await readFile(path.join(source.worktreePath, "src/a.txt"), "utf8"), "from A\n");
  assert.equal(result.worktreeCleanup.cleanup, "retained_for_review");
  assert.match(result.worktreeCleanup.reason, /continued worktree keeps earlier jobs' work/);
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

for (const outcome of ["success", "failure", "throw", "abort"]) {
  test(`Q-018 execution: claim is released after ${outcome}`, async () => {
    const cwd = await repo(`release-${outcome}`);
    const source = await retained(cwd);
    const controller = new AbortController();
    fakeAgent(async (run) => {
      assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use", "claim covers the complete agent run");
      await write(run.cwd, "src/b.txt", `B ${outcome}\n`);
      if (outcome === "throw") throw new Error("Q-018 fixture infrastructure failure");
      if (outcome === "abort") {
        controller.abort(new Error("fixture cancellation"));
        assert.equal(run.signal.aborted, true);
        return { exitCode: 1, errorType: "agent_cancelled", stderr: "fixture cancellation" };
      }
      if (outcome === "failure") return { exitCode: 1, errorType: "agent_exit_nonzero", stderr: "fixture failure" };
    });
    const result = await execute(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }), { signal: controller.signal });
    if (outcome === "success") accepted(result);
    else assert.equal(result.result.errorType, outcome === "throw" ? "job_infrastructure_failed" : outcome === "abort" ? "agent_cancelled" : "agent_exit_nonzero", textOf(result.response));
    assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
    assert.ok(existsSync(source.worktreePath));
    assert.equal(await readFile(path.join(source.worktreePath, "src/a.txt"), "utf8"), "from A\n");
  });
}

test("Q-018 execution: a concurrent second writer cannot attach to the claimed source", async () => {
  const cwd = await repo("running-claim");
  const source = await retained(cwd);
  let entered;
  let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  fakeAgent(async (run) => { entered(); await released; await write(run.cwd, "src/b.txt", "from B\n"); });
  const running = execute(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }));
  let timer;
  try {
    await Promise.race([
      started,
      running.then((result) => { throw new Error(`Writer ended before the fake agent started: ${textOf(result.response)}`); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Writer never entered the fake agent")), 30_000); }),
    ]);
    const competing = await execute(writeJob(cwd, "src/c.txt", { continueWorktree: source.worktreePath }));
    assert.equal(competing.result.errorType, "worktree_in_use", textOf(competing.response));
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
  } finally { clearTimeout(timer); finish(); await running; }
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 execution: attach dry-run verifies identity without changing the registry", async () => {
  const cwd = await repo("attach-dry");
  const source = await retained(cwd);
  const before = { ...await artifact(cwd, source.worktreePath) };
  const attached = await I.attachRetainedWorktree({ cwd, worktreePath: source.worktreePath, jobId: "dry-attach", dryRun: true });
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.equal(attached.continued, true);
  assert.equal(attached.continuedFrom, source.previousJobId);
  assert.equal(attached.branch, source.branch);
  assert.equal(attached.baseCommit, (await git(source.worktreePath, "rev-parse", "HEAD")).trim());
  assert.equal(attached.baseTree, (await git(source.worktreePath, "rev-parse", "HEAD^{tree}")).trim());
  assert.deepEqual({ ...await artifact(cwd, source.worktreePath) }, before);
});

test("Q-018 execution: wrong repository, non-root, missing and unregistered paths are refused", async () => {
  const cwd = await repo("identity");
  const source = await retained(cwd);
  const other = await repo("identity-other");
  for (const [target, worktreePath, errors] of [
    [other, source.worktreePath, ["worktree_identity_mismatch"]],
    [cwd, path.join(source.worktreePath, "src"), ["worktree_identity_mismatch"]],
    [cwd, path.join(root, "missing-attach"), ["worktree_identity_mismatch", "worktree_not_retained"]],
    [cwd, cwd, ["worktree_identity_mismatch", "worktree_not_retained"]],
  ]) {
    const result = await I.attachRetainedWorktree({ cwd: target, worktreePath, jobId: "bad-identity", dryRun: true });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(errors.includes(result.errorType), JSON.stringify(result));
    assert.ok(result.suggestedFix?.trim());
  }
  const unregistered = path.join(root, `unregistered-${++sequence}`);
  await git(cwd, "worktree", "add", "-q", "--detach", unregistered, "HEAD");
  refusal(await I.attachRetainedWorktree({ cwd, worktreePath: unregistered, jobId: "unregistered" }), "worktree_not_retained");
});

test("Q-018 execution: a worktree HEAD outside checkout history is refused", async () => {
  const cwd = await repo("diverged-head");
  const source = await retained(cwd);
  await git(source.worktreePath, "add", ".");
  await git(source.worktreePath, "commit", "-q", "-m", "unapproved source commit");
  refusal(await I.attachRetainedWorktree({ cwd, worktreePath: source.worktreePath, jobId: "diverged", dryRun: true }), "worktree_identity_mismatch");
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 execution: continuation does not require the checkout's dirty scope to be committed", async () => {
  const cwd = await repo("dirty-checkout");
  const source = await retained(cwd);
  await write(cwd, "src/b.txt", "operator's uncommitted B\n");
  fakeAgent(async (run) => { await write(run.cwd, "src/b.txt", "continued B\n"); });
  const result = await execute(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }));
  accepted(result);
  assert.equal(await readFile(path.join(cwd, "src/b.txt"), "utf8"), "operator's uncommitted B\n");
  assert.equal(await readFile(path.join(source.worktreePath, "src/b.txt"), "utf8"), "continued B\n");
});

test("Q-018 public: removing an earlier addition refuses an unrepresentable strict union", async () => {
  const cwd = await repo("strict-union");
  const source = await retained(cwd);
  fakeAgent(async (run) => { await rm(path.join(run.cwd, "src/a.txt")); });
  const result = await execute(writeJob(cwd, "src/a.txt", { continueWorktree: source.worktreePath }));
  assert.equal(result.result.errorType, "worktree_output_unrepresentable", textOf(result.response));
  sameFiles(result.result.changedFiles, ["src/a.txt"]);
  sameFiles(result.result.worktree.thisRunChangedFiles, ["src/a.txt"]);
  sameFiles(result.result.worktree.changedFiles, []);
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
  assert.equal(existsSync(source.worktreePath), true, "the refused patch remains available for manual repair");
});

test("Q-018 public: startup retires a dead queue owner and releases its claim in the same pass", async () => {
  const cwd = await repo("startup-queue-owner");
  const source = await retained(cwd);
  const owner = "dead-startup-queue-owner";
  const expired = new Date(Date.now() - I.CONFIG.queueStaleAfterMs - 60_000).toISOString();
  await queueOwner(cwd, owner);
  await database(cwd, (db) => {
    db.prepare("UPDATE opencode_jobs SET created_at = ?, started_at = ?, heartbeat_at = ?, lease_expires_at = ?, owner_instance_id = 'dead-fixture-instance', owner_process_id = 99999999, owner_generation = 'dead-fixture-generation' WHERE job_id = ?").run(expired, expired, expired, expired, owner);
    db.prepare("UPDATE worktree_artifacts SET status = 'in_use', job_id = ? WHERE worktree_path = ?").run(owner, source.worktreePath);
  });
  await I.reconcileQueueStateAtStartup();
  const status = await database(cwd, (db) => db.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(owner).status);
  assert.equal(status, "interrupted");
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained", "startup must recover after retiring stale queue ownership");
});

test("Q-018 public: schema preserves a nonempty continuation path and rejects invalid types", () => {
  const schema = I.jobInputShape.continueWorktree;
  assert.ok(schema, "the public job schema exposes continueWorktree");
  assert.equal(schema.safeParse(path.join(root, "source")).success, true);
  assert.equal(schema.safeParse(undefined).success, true);
  for (const value of ["", false, 42, {}, []]) assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));
  const parsed = queueWorkerApi.parseJobLine(JSON.stringify(writeJob(root, "src/b.txt", { continueWorktree: path.join(root, "source"), idempotencyKey: "q018-parse" })));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.job.continueWorktree, path.join(root, "source"));
});

test("Q-018 public: the single-agent tool forwards the path and reports per-job versus total work", async () => {
  const cwd = await repo("public-tool");
  const source = await retained(cwd);
  const runs = fakeAgent(async (run) => {
    assert.equal(await readFile(path.join(run.cwd, "src/a.txt"), "utf8"), "from A\n");
    await write(run.cwd, "src/b.txt", "from B\n");
  });
  const text = textOf(await tool("run_opencode_agent", writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath })));
  assert.equal(runs.length, 1);
  assert.equal(path.resolve(runs[0].cwd), path.resolve(source.worktreePath));
  assert.match(text, new RegExp(`Continued worktree of job ${source.previousJobId}`));
  assert.match(text, /this run changed 1 file\(s\): src\/b\.txt/);
  assert.match(text, /worktree total vs base: 2 file\(s\)/);
  assert.match(text, /integration.*total|integrat.*whole/i);
  assert.match(text, /allowedEdits.*union/i);
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 public: read, auto-integration, sanitized and contractor combinations are refused", async () => {
  const cwd = await repo("option-refusals");
  const source = await retained(cwd);
  const common = writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath });
  const cases = [
    [{ agent: "reviewer", task: "Review.", cwd, write: false, lockMode: "off", allowedEdits: [], scopeContract: { mode: "read", read: ["src"] }, continueWorktree: source.worktreePath }, "continue_worktree_requires_write_job"],
    [{ ...common, autoIntegrate: true }, "continue_worktree_not_applicable"],
    [{ ...common, sanitizedWorkspace: { root: cwd } }, "continue_worktree_not_applicable"],
    [{ ...common, orchestratorMode: "contractor" }, "continue_worktree_not_applicable"],
  ];
  const runs = fakeAgent();
  for (const [job, expected] of cases) {
    const planned = I.validateSingleLockPlan(job);
    assert.equal(planned.errorType, expected, JSON.stringify(planned));
    assert.ok(planned.suggestedFix?.trim());
    const queued = await I.enqueueQueueJob(job, "", { schedule: false });
    refusal(queued, expected);
    const text = textOf(await tool("run_opencode_agent", job));
    assert.ok(text.includes(expected), text);
  }
  assert.equal(runs.length, 0, "refused jobs never run a fake or real agent");
});

test("Q-018 public: worktree mode off refuses continuation without mutating frozen CONFIG", () => {
  const runtime = createLockPlanRuntime({ CONFIG: { ...I.CONFIG, worktreeMode: "off" } });
  const result = runtime.continueWorktreeJobError({ continueWorktree: "source" }, { lockType: "write", orchestratorMode: "" });
  assert.equal(result.errorType, "continue_worktree_not_applicable");
  assert.ok(result.suggestedFix?.trim());
  assert.equal(I.CONFIG.worktreeMode, "write");
});

test("Q-018 public: parallel calls, multi-job preflight and pipelines refuse continuation", async () => {
  const cwd = await repo("parallel-refusal");
  const source = await retained(cwd);
  const first = writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath, dryRun: true });
  const second = writeJob(cwd, "src/c.txt", { dryRun: true });
  fakeAgent();
  for (const jobs of [[first], [first, second]]) {
    const text = textOf(await tool("run_opencode_parallel", { jobs }));
    assert.ok(text.includes("continue_worktree_unsupported_in_parallel"), text);
  }
  const plan = textOf(await tool("validate_delegation_plan", { jobs: [first, second] }));
  assert.ok(plan.includes("continue_worktree_unsupported_in_parallel"), plan);
  const pipeline = textOf(await tool("create_multi_agent_pipeline", { cwd, usePolicy: false, jobs: [first, second], finalValidationCommand: VALIDATION }));
  assert.ok(pipeline.includes("continue_worktree_unsupported_in_parallel"), pipeline);
});

test("Q-018 public: single-job delegation preflight checks the source without claiming", async () => {
  const cwd = await repo("plan-dry");
  const source = await retained(cwd);
  const runs = fakeAgent();
  const before = { ...await artifact(cwd, source.worktreePath) };
  const text = textOf(await tool("validate_delegation_plan", { jobs: [writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath })] }));
  assert.match(text, /Delegation plan accepted\./);
  assert.equal(runs.length, 0);
  assert.deepEqual({ ...await artifact(cwd, source.worktreePath) }, before);
  const invalid = textOf(await tool("validate_delegation_plan", { jobs: [writeJob(cwd, "src/b.txt", { continueWorktree: path.join(root, "missing-plan") })] }));
  assert.match(invalid, /worktree_identity_mismatch|worktree_not_retained/);
});

test("Q-018 public: an in_use artifact is visibly in flight even without a queue view", async () => {
  const cwd = await repo("view");
  const source = await retained(cwd);
  await queueOwner(cwd, "view-job");
  try {
    assert.equal((await claim(source, "view-job")).ok, true);
    const listed = (await I.listRetainedWorktreeArtifacts(cwd)).find((row) => row.worktreePath === source.worktreePath);
    const view = I.retainedWorktreeView(listed);
    assert.equal(view.inFlight, true);
    assert.match(view.recoveryAction, /job.*running/i);
  } finally { await release(source, "view-job"); await clearQueueOwner(cwd, "view-job"); }
});

test("Q-018 public: SQLite worker input keeps continuation through encryption and terminal lineage", async () => {
  const cwd = await repo("queue-roundtrip");
  const source = await retained(cwd);
  const job = writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath, idempotencyKey: "q018-queue-chain" });
  const parsed = queueWorkerApi.parseJobLine(JSON.stringify(job));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const enqueued = await queueWorkerApi.enqueueFromToolInput(parsed.job, { repo: cwd });
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const encrypted = await database(cwd, (db) => db.prepare("SELECT request_encrypted FROM opencode_jobs WHERE job_id = ?").get(enqueued.record.jobId).request_encrypted);
  const request = await I.decryptQueueRequest(encrypted, enqueued.record.jobId);
  assert.equal(request.continueWorktree, source.worktreePath);
  const runs = fakeAgent(async (run) => { await write(run.cwd, "src/b.txt", "queued B\n"); });
  assert.equal(await I.startQueueRecord(enqueued.record), true);
  await enqueued.record.executionPromise;
  assert.equal(runs.length, 1);
  assert.equal(path.resolve(runs[0].cwd), path.resolve(source.worktreePath));
  const durable = await I.readPersistedQueueRecord(enqueued.record.jobId, cwd);
  assert.equal(durable.status, "completed", JSON.stringify(durable));
  assert.equal(durable.continuedFrom, source.previousJobId);
  assert.equal(durable.worktreePath, source.worktreePath);
  sameFiles(durable.changedFiles, ["src/b.txt"]);
  assert.match(I.compactQueueJobLines([durable]), /wt=continued/);
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 public: a failed durable audit prevents direct and memory continuation from claiming", async () => {
  const cwd = await repo("audit-write-failure");
  const source = await retained(cwd);
  const before = { ...await artifact(cwd, source.worktreePath) };
  const runs = fakeAgent();
  await database(cwd, (db) => db.exec("CREATE TRIGGER q018_refuse_direct_audit BEFORE INSERT ON opencode_direct_runs BEGIN SELECT RAISE(ABORT, 'q018 fixture audit write failure'); END"));
  const oldMode = hooks.queueModeOverride;
  try {
    const response = textOf(await tool("run_opencode_agent", writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath })));
    assert.ok(response.includes("direct_run_audit_start_failed"), response);
    assert.deepEqual({ ...await artifact(cwd, source.worktreePath) }, before);
    hooks.queueModeOverride = "memory";
    const queued = await I.enqueueQueueJob(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }), "", { schedule: false });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    assert.equal(await I.startQueueRecord(queued.record), true);
    await queued.record.executionPromise;
    assert.equal(queued.record.status, "failed");
    assert.equal(queued.record.errorType, "direct_run_audit_start_failed");
    assert.deepEqual({ ...await artifact(cwd, source.worktreePath) }, before);
    assert.equal(runs.length, 0, "the agent cannot launch without a persisted live owner");
  } finally {
    hooks.queueModeOverride = oldMode;
    await database(cwd, (db) => db.exec("DROP TRIGGER q018_refuse_direct_audit"));
  }
});

test("Q-018 public: a running memory-queue continuation retains live claim protection", async () => {
  const cwd = await repo("memory-queue");
  const source = await retained(cwd);
  const oldMode = hooks.queueModeOverride;
  hooks.queueModeOverride = "memory";
  let entered;
  let finish;
  let record;
  let timer;
  const started = new Promise((resolve) => { entered = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  fakeAgent(async (run) => { entered(); await released; await write(run.cwd, "src/b.txt", "memory B\n"); });
  try {
    const queued = await I.enqueueQueueJob(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }), "", { schedule: false });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    record = queued.record;
    assert.equal(await I.startQueueRecord(record), true);
    await Promise.race([
      started,
      record.executionPromise.then(() => { throw new Error(`Memory writer ended before starting: ${record.errorReason || record.errorType}`); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Memory writer did not start")), 30_000); }),
    ]);
    const second = await execute(writeJob(cwd, "src/c.txt", { continueWorktree: source.worktreePath }));
    assert.equal(second.result.errorType, "worktree_in_use", textOf(second.response));
    await I.recoverStaleWorktreeClaims(cwd);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
  } finally {
    clearTimeout(timer);
    finish();
    if (record?.executionPromise) await record.executionPromise;
    hooks.queueModeOverride = oldMode;
  }
  assert.equal(record.status, "completed", JSON.stringify(record.errorReason));
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 integration: a live continuation blocks single, batch and an earlier receipt", async () => {
  const cwd = await repo("integration-live");
  const source = await retained(cwd);
  const contract = { cwd, worktreePath: source.worktreePath, allowedEdits: ["src/a.txt", "src/b.txt"], validationCommand: VALIDATION, cleanupAfterSuccess: false };
  const preview = await I.integratePatchSerially({ ...contract, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  let entered;
  let finish;
  let running;
  let timer;
  const started = new Promise((resolve) => { entered = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  fakeAgent(async (run) => { entered(); await released; await write(run.cwd, "src/b.txt", "from live B\n"); });
  try {
    running = execute(writeJob(cwd, "src/b.txt", { continueWorktree: source.worktreePath }));
    await Promise.race([
      started,
      running.then((result) => { throw new Error(`Writer ended before starting: ${result.result?.errorType}`); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Writer did not start")), 30_000); }),
    ]);
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
    refusal(await I.integratePatchSerially({ ...contract, dryRun: true }), "worktree_in_use");
    refusal(await I.integratePatchSerially({
      cwd, batch: { items: [{ worktreePath: source.worktreePath, allowedEdits: contract.allowedEdits, cleanup: false }] },
      allowedEdits: contract.allowedEdits, validationCommand: VALIDATION, dryRun: true,
    }), "worktree_in_use");
    refusal(await I.integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt }), "worktree_in_use");
    for (const file of contract.allowedEdits) assert.equal(existsSync(path.join(cwd, file)), false, "no integration can write while the source is owned");
    assert.equal((await artifact(cwd, source.worktreePath)).status, "in_use");
  } finally {
    clearTimeout(timer);
    finish();
    if (running) accepted(await running);
  }
  assert.equal((await artifact(cwd, source.worktreePath)).status, "retained");
});

test("Q-018 integration: one reviewed integration lands A and B and cleans the chain", async () => {
  const cwd = await repo("integration-chain");
  fakeAgent(async (run) => {
    if (run.index === 0) await write(run.cwd, "src/a.txt", "from A\n");
    else {
      assert.equal(await readFile(path.join(run.cwd, "src/a.txt"), "utf8"), "from A\n");
      await write(run.cwd, "src/b.txt", "from B\n");
    }
  });
  const first = await execute(writeJob(cwd, "src/a.txt"));
  accepted(first);
  const second = await execute(writeJob(cwd, "src/b.txt", { continueWorktree: first.worktree.path }));
  accepted(second);
  const contract = { cwd, worktreePath: first.worktree.path, allowedEdits: ["src/a.txt", "src/b.txt"], validationCommand: VALIDATION, cleanupAfterSuccess: true };
  const narrow = await I.integratePatchSerially({ ...contract, allowedEdits: ["src/b.txt"], dryRun: true });
  assert.equal(narrow.ok, false, JSON.stringify(narrow));
  sameFiles(narrow.disallowedFiles, ["src/a.txt"]);
  const preview = await I.integratePatchSerially({ ...contract, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  sameFiles(preview.changedFiles, ["src/a.txt", "src/b.txt"]);
  assert.equal((await artifact(cwd, first.worktree.path)).status, "retained", "preview does not clean or claim the chain");
  const applied = await I.integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.status, "applied");
  sameFiles(applied.appliedFiles, ["src/a.txt", "src/b.txt"]);
  assert.equal(applied.validationGate.status, "passed");
  assert.equal(await readFile(path.join(cwd, "src/a.txt"), "utf8"), "from A\n");
  assert.equal(await readFile(path.join(cwd, "src/b.txt"), "utf8"), "from B\n");
  assert.equal(applied.sourceCleanup.cleanup, "pending");
  const cleanupDeadline = Date.now() + 20_000;
  while (await artifact(cwd, first.worktree.path)) {
    const cleanup = await I.drainDeferredWorktreeCleanup(cwd);
    assert.ok(!cleanup.some(item => item.cleanup === "retained_for_review"), JSON.stringify(cleanup));
    assert.ok(Date.now() < cleanupDeadline, JSON.stringify(cleanup));
    if (await artifact(cwd, first.worktree.path)) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await artifact(cwd, first.worktree.path), undefined);
  assert.equal(existsSync(first.worktree.path), false);
  const operations = await database(cwd, (db) => db.prepare("SELECT status, affected_paths_json FROM integration_operations WHERE cwd = ?").all(cwd));
  assert.equal(operations.length, 1, "the complete chain uses one journaled integration");
  assert.equal(operations[0].status, "committed");
  sameFiles(JSON.parse(operations[0].affected_paths_json), ["src/a.txt", "src/b.txt"]);
  refusal(await I.attachRetainedWorktree({ cwd, worktreePath: first.worktree.path, jobId: "after-integration" }), "worktree_not_retained");
});

let failed = 0;
let total = 0;
try {
  for (const { name, fn } of tests) {
    if (process.env.CODEX_TEST_ONLY && !name.includes(process.env.CODEX_TEST_ONLY)) continue;
    total += 1;
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.log(`FAIL ${name}\n${error?.stack || error}`); }
    finally { hooks.agentRuntimeTestHook = null; hooks.queueJobExecutorTestHook = null; }
  }
} finally {
  hooks.stateDirectoryOverride = saved.stateDirectoryOverride;
  hooks.queueModeOverride = saved.queueModeOverride;
  assert.ok(path.isAbsolute(root) && path.basename(root).startsWith("review-continue-worktree-"), "cleanup stays inside this suite's scratch directory");
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
assert.ok(total > 0, "CODEX_TEST_ONLY must select at least one case");
const skipFailed = finishSkips({ file: "tests/review-continue-worktree.js", total, skips: [] });
console.log(failed ? `${failed} of ${total} continue-worktree tests failed.` : `All ${total} continue-worktree tests passed.`);
process.exitCode = failed || skipFailed ? 1 : 0;
