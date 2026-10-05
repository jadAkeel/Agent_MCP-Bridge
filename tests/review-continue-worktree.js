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

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const root = await mkdtemp(path.join(tmpdir(), "review-continue-worktree-"));
process.env.CODEX_OPENCODE_STATE_DIR = path.join(root, "global-state");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Continue Test\n\temail = continue@example.invalid\n[core]\n\tautocrlf = false\n");
const { __selfTest } = await import("../server.js");
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
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
assert.ok(total > 0, "CODEX_TEST_ONLY must select at least one case");
const skipFailed = finishSkips({ file: "tests/review-continue-worktree.js", total, skips: [] });
console.log(failed ? `${failed} of ${total} continue-worktree tests failed.` : `All ${total} continue-worktree tests passed.`);
process.exitCode = failed || skipFailed ? 1 : 0;
