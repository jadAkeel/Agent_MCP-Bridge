#!/usr/bin/env node

// D4-F9-001: exercise the real recovery pass, detached retry policy and durable successor.
// Only scratch SQLite/Git state and the queue executor hook are used; no model is started.
// Root can run --repro-only against saved baseline bytes in an isolated mirror. Supply only
// the queueRetryPolicyTestHook seam there (see the implementation report), leaving the old
// reservation, scheduler and memo unchanged. The first test must fail its successor assertion.
import "./test-env.js";
import { spawn } from "node:child_process";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "warn";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
process.env.CODEX_OPENCODE_ISSUE_LOG = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS = "false";
process.env.CODEX_OPENCODE_MIN_FREE_MEMORY_MB = "0";
process.env.CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED = "true";
const { isolateBridgeStateDir, makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-f9-startup");
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { hooks, internals: I } = __selfTest;
const { assert } = I;
const MODEL = "opencode/muse-spark-1.3-contributor-free@high";
hooks.selfTestModelOverrideAllowlist = [MODEL];
const fixture = await makeFlexFixture(__selfTest, "review-f9-startup");
const { repo, readJob, waitFor, execution } = fixture;
const dbPath = I.stateDbPath(repo);
const requests = [];
const tasks = new Map();
hooks.queueJobExecutorTestHook = async request => {
  requests.push(request);
  return execution({ configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" });
};
const tests = [], test = (name, fn) => tests.push({ name, fn });
let sequence = 0;

// Assertions read raw handles: openLockDb would mutate instance leases and could conceal a
// recovery memo that incorrectly stopped revisiting an unchanged database.
function raw(fn) {
  const db = new I.DatabaseSync(dbPath);
  try { return fn(db); } finally { I.closeDb(db); }
}
function summary(jobId) {
  return raw(db => {
    const row = db.prepare("SELECT status, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    return row ? { ...JSON.parse(row.record_json), status: row.status } : null;
  });
}
function patchSummary(jobId, patch) {
  raw(db => {
    const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.record_json), ...patch }), jobId);
  });
}
function successors(jobId) {
  return raw(db => db.prepare(`SELECT job_id, record_json FROM opencode_jobs
    WHERE json_valid(record_json) AND json_extract(record_json, '$.requeuedFrom') = ?`).all(jobId));
}
async function seedDeferred({ models = [MODEL], maxAttempts = 3, orphanPid = 0 } = {}) {
  const enqueued = await I.enqueueQueueJob(readJob({ task: `F9 deferred fixture ${++sequence}`,
    ...(models ? { models, maxAttempts } : {}) }), "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  tasks.set(jobId, enqueued.record.task);
  I.QUEUE_JOBS.delete(jobId);
  const past = new Date(Date.now() - 600_000).toISOString();
  raw(db => {
    const row = db.prepare("SELECT record_json, revision FROM opencode_jobs WHERE job_id = ?").get(jobId);
    const record = { ...JSON.parse(row.record_json), status: "interrupted", finishedAt: past,
      errorType: "queue_job_interrupted", ownerInstanceId: "f9-dead-owner", ownerProcessId: 0,
      ownerGeneration: "f9-dead-generation", heartbeatAt: "", leaseExpiresAt: "",
      retryDeferredAt: past, orphanChildProcessAlive: Boolean(orphanPid), orphanChildProcessId: orphanPid,
      revision: Number(row.revision) + 1 };
    db.prepare(`UPDATE opencode_jobs SET status = 'interrupted', finished_at = ?,
      owner_instance_id = 'f9-dead-owner', owner_process_id = 0, owner_generation = 'f9-dead-generation',
      heartbeat_at = '', lease_expires_at = '', record_json = ?, revision = revision + 1 WHERE job_id = ?`)
      .run(past, JSON.stringify(record), jobId);
  });
  return jobId;
}
const scan = () => I.reconcileQueueStateAtStartup({ busyTimeoutMs: 250 });
async function settled() {
  assert.ok(await waitFor(() => queueWorkerApi.activity().retries === 0), "the detached retry dispatch must settle");
}
async function completedSuccessor(jobId) {
  assert.ok(await waitFor(() => Boolean(summary(jobId)?.requeuedAs)), "the next recovery pass must produce a durable retry successor");
  const successorId = summary(jobId).requeuedAs;
  assert.equal(successors(jobId).length, 1, "administrative redispatch must create exactly one successor");
  assert.ok(await waitFor(() => summary(successorId)?.status === "completed"), "the fixture successor must finish");
  assert.equal(summary(successorId).retryAttempt, 2, "a failed administrative dispatch must not spend an agent attempt");
  assert.equal(summary(successorId).attemptHistory.length, 1);
  return successorId;
}
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test("a transient dispatch failure after orphan exit is revisited and creates exactly one successor", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}`))); });
  await exited;
  const jobId = await seedDeferred({ orphanPid: child.pid });
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async ({ jobId: dispatched }) => {
    assert.equal(dispatched, jobId);
    if (++dispatches === 1) throw Object.assign(new Error("F9 injected transient SQLite contention"), { code: "SQLITE_BUSY" });
  };
  const events = [], originalError = console.error;
  console.error = value => { try { events.push(JSON.parse(String(value))); } catch { originalError(value); } };
  try {
    await scan();
    await settled();
    assert.equal(dispatches, 1, "the first dispatch must actually encounter the injected failure");
    assert.equal(successors(jobId).length, 0);
    assert.ok(events.some(event => event.event === "queue.retry_policy_failed"));
    assert.equal(summary(jobId).retryAttempt, 1);
    assert.equal(summary(jobId).completionOutcome || "", "");
    await scan();
    await settled();
    await completedSuccessor(jobId);
    assert.equal(dispatches, 2);
    assert.equal(requests.filter(request => request.task === tasks.get(jobId)).length, 1,
      "only the successful retry may execute the agent fixture");
  } finally { console.error = originalError; hooks.queueRetryPolicyTestHook = null; }
});

test("overlapping recovery passes keep an in-flight dispatch pending and dispatch it once", async () => {
  const jobId = await seedDeferred();
  const held = gate();
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async () => { dispatches++; await held.promise; };
  try {
    await scan();
    assert.ok(await waitFor(() => dispatches === 1));
    assert.equal(queueWorkerApi.activity().retries, 1);
    assert.equal(I.deferredRecoveryLastPass().busy, true, "the initial scan must keep its in-flight retry pending");
    await scan();
    assert.equal(I.deferredRecoveryLastPass().busy, true, "an unchanged database must stay pending until completion");
    assert.equal(dispatches, 1);
    held.release();
    await settled();
    await completedSuccessor(jobId);
    await scan();
    await settled();
    assert.equal(dispatches, 1, "a definitive outcome must suppress replay");
  } finally { held.release(); await settled(); hooks.queueRetryPolicyTestHook = null; }
});

test("a live orphan keeps recovery pending without dispatching the policy", async () => {
  const jobId = await seedDeferred({ orphanPid: process.pid });
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async () => { dispatches++; };
  try {
    await scan();
    await scan();
    await settled();
    assert.equal(dispatches, 0);
    assert.equal(I.deferredRecoveryLastPass().busy, true);
    assert.equal(successors(jobId).length, 0);
    assert.equal(summary(jobId).retryAttempt, 1);
  } finally { hooks.queueRetryPolicyTestHook = null; patchSummary(jobId, { retryDeferredAt: "" }); }
});

test("a still-deferred policy result releases its reservation for a later pass", async () => {
  const jobId = await seedDeferred();
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async () => {
    if (++dispatches === 1) patchSummary(jobId, { orphanChildProcessAlive: true, orphanChildProcessId: process.pid });
  };
  try {
    await scan();
    await settled();
    assert.equal(dispatches, 1);
    assert.equal(successors(jobId).length, 0);
    assert.equal(summary(jobId).retryAttempt, 1);
    await scan();
    assert.equal(dispatches, 1, "the renewed live-orphan check must still block replay");
    patchSummary(jobId, { orphanChildProcessAlive: false, orphanChildProcessId: 0 });
    await scan();
    await settled();
    await completedSuccessor(jobId);
    assert.equal(dispatches, 2);
  } finally { hooks.queueRetryPolicyTestHook = null; }
});

for (const [name, options, disabled, outcome] of [
  ["disabled auto-resume", {}, true, ""],
  ["no retry policy", { models: null }, false, ""],
  ["exhausted attempt budget", { maxAttempts: 1 }, false, "gave_up"],
]) test(`${name} retains its existing outcome and suppresses redispatch`, async () => {
  const jobId = await seedDeferred(options);
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async () => { dispatches++; };
  hooks.autoResumeInterruptedOverride = disabled ? false : null;
  try {
    await scan();
    await settled();
    await scan();
    await settled();
    assert.equal(dispatches, 1);
    assert.equal(summary(jobId).status, "interrupted");
    assert.equal(summary(jobId).completionOutcome || "", outcome);
    assert.equal(successors(jobId).length, 0);
  } finally { hooks.queueRetryPolicyTestHook = null; hooks.autoResumeInterruptedOverride = null; }
});

test("an existing durable successor is excluded from orphan retry recovery", async () => {
  const jobId = await seedDeferred();
  await I.applyQueueRetryPolicy({ cwd: repo, jobId });
  await completedSuccessor(jobId);
  let dispatches = 0;
  hooks.queueRetryPolicyTestHook = async () => { dispatches++; };
  try {
    await scan();
    await settled();
    assert.equal(dispatches, 0);
    assert.equal(successors(jobId).length, 1);
  } finally { hooks.queueRetryPolicyTestHook = null; }
});

await runFlexTests({ file: "tests/review-f9-startup.js", tests: process.argv.includes("--repro-only") ? tests.slice(0, 1) : tests,
  isolatedStateDir, finishSkips, label: "F9 startup recovery", cleanup: async () => {
    hooks.queueRetryPolicyTestHook = null;
    hooks.autoResumeInterruptedOverride = null;
    hooks.selfTestModelOverrideAllowlist = null;
    await settled();
    await fixture.cleanup();
  } });
