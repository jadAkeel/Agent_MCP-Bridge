#!/usr/bin/env node

// Friend-readiness regressions: real supervised payloads, temporary SQLite state,
// and the existing queue executor hook. No model or personal bridge state is used.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const root = await mkdtemp(path.join(tmpdir(), "review-friend-runtime-"));
process.env.CODEX_OPENCODE_STATE_DIR = path.join(root, "state");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_QUEUE_LEASE_MS = "1000";
process.env.CODEX_OPENCODE_QUEUE_HEARTBEAT_MS = "100";
process.env.CODEX_OPENCODE_PROVIDER_LEASE_MS = "2000";
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "1";
const { __selfTest } = await import("../server.js");
const { internals: I, hooks } = __selfTest;
const saved = {
  queueMode: hooks.queueModeOverride,
  stateDirectory: hooks.stateDirectoryOverride,
};
hooks.stateDirectoryOverride = path.join(root, "state");
hooks.queueModeOverride = "off";
const cwd = path.join(root, "repo");
await mkdir(cwd, { recursive: true });
const initializedDb = await I.openLockDb(cwd);
I.closeDb(initializedDb);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cases = [];
const test = (name, body) => cases.push({ name, body });
let sequence = 0;

async function withDb(body) {
  const db = await I.openLockDb(cwd);
  try { return await body(db); } finally { I.closeDb(db); }
}

async function supervisedLockProbe(refreshLease, { ttlMs = 60_000, payloadMs = 900 } = {}) {
  const lock = { id: `friend-lock-${++sequence}`, token: "fixture-token", lockType: "write", expiresAt: Date.now() + ttlMs };
  const heartbeat = I.startHardLockHeartbeat(lock, ttlMs, { intervalMs: 30_000, refreshLease });
  try {
    const result = await I.runSpawnCommand(process.execPath, ["-e", `process.stdout.write('started\\n'); setTimeout(() => process.stdout.write('finished\\n'), ${payloadMs});`], cwd, payloadMs + 5000, null, {
      signal: heartbeat.signal,
      onSpawn: async () => ({ ok: true, deadlineAt: lock.expiresAt }),
      // The execution supervisor accepts the public boolean pulse API and then
      // uses the confirmed expiry, exactly as execute-job's authority callback does.
      beforeHeartbeat: async () => {
        const renewed = await heartbeat.pulse();
        return renewed ? { ok: true, deadlineAt: lock.expiresAt } : { ok: false };
      },
    });
    return { result, heartbeat, lock };
  } finally { await heartbeat(); }
}

test("one transient hard-lock renewal error does not kill a supervised payload", async () => {
  let calls = 0;
  const { result, heartbeat } = await supervisedLockProbe(async () => {
    if (++calls === 1) throw new Error("database is locked (SQLITE_BUSY)");
    return true;
  });
  assert.equal(result.exitCode, 0);
  assert.ok(calls >= 2, "a later supervisor heartbeat must retry the renewal");
  assert.match(result.stdout, /started\nfinished\n/);
  assert.equal(heartbeat.signal.aborted, false);
});

test("definitive hard-lock ownership loss still stops a supervised payload", async () => {
  const { result, heartbeat } = await supervisedLockProbe(async () => false, { payloadMs: 4000 });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /finished/);
  assert.equal(heartbeat.signal.reason?.errorType, "write_lock_ownership_lost");
  assert.equal(result.cancelled, true);
  assert.equal(result.cancellationErrorType, "write_lock_ownership_lost");
});

test("sustained hard-lock renewal errors stop at the confirmed lease guard", async () => {
  const { result, heartbeat } = await supervisedLockProbe(async () => { throw new Error("database is locked (SQLITE_BUSY)"); }, { ttlMs: 1500, payloadMs: 4000 });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /finished/);
  assert.equal(heartbeat.signal.reason?.errorType, "write_lock_ownership_lost");
  assert.equal(result.cancelled, true);
  assert.equal(result.cancellationErrorType, "write_lock_ownership_lost");
});

test("an error arriving at the guarded deadline cannot authorize another heartbeat", async () => {
  const lock = { id: "friend-guard", token: "fixture-token", lockType: "write", expiresAt: Date.now() + 300 };
  const heartbeat = I.startHardLockHeartbeat(lock, 300, {
    intervalMs: 150,
    refreshLease: async () => { await sleep(250); throw new Error("late renewal failed"); },
  });
  try {
    assert.equal(await heartbeat.pulse(), false);
    assert.equal(heartbeat.signal.reason?.errorType, "write_lock_ownership_lost");
  } finally { await heartbeat(); }
});

function memoryRecord() {
  return {
    jobId: `friend-memory-${++sequence}`, cwd, agent: "reviewer", task: "isolated queue fixture",
    request: { agent: "reviewer", task: "isolated queue fixture", cwd },
    mode: "read", lockMode: "read", status: "pending", revision: 0,
    createdAt: new Date().toISOString(), changedFiles: [],
  };
}

test("a memory job survives both the durable fence period and a heartbeat", async () => {
  hooks.queueModeOverride = "memory";
  const record = memoryRecord();
  I.QUEUE_JOBS.set(record.jobId, record);
  hooks.queueJobExecutorTestHook = async (_job, { signal }) => {
    I.heartbeatKnownQueueState();
    await sleep(1200);
    assert.equal(signal.aborted, false, "a memory job has no durable queue lease to lose");
    return { response: { content: [{ type: "text", text: "completed fixture" }] }, result: { errorType: "", changedFiles: [] } };
  };
  assert.equal(await I.startQueueRecord(record), true);
  await record.executionPromise;
  assert.equal(record.status, "completed", record.errorReason);
  assert.equal(record.queueLeaseFenceTimer, null);
});

test("an active memory job can still be cancelled through the tool", async () => {
  hooks.queueModeOverride = "memory";
  const record = memoryRecord();
  I.QUEUE_JOBS.set(record.jobId, record);
  hooks.queueJobExecutorTestHook = async (_job, { signal }) => {
    await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }));
    return { response: { content: [{ type: "text", text: "cancelled fixture" }] }, result: { errorType: "agent_cancelled", changedFiles: [] } };
  };
  assert.equal(await I.startQueueRecord(record), true);
  const controller = record.abortController;
  const response = await I.server._registeredTools.cancel_opencode_job.handler({ jobId: record.jobId, cwd }, {});
  assert.match(response.content[0].text, /Cancellation requested/);
  await record.executionPromise;
  assert.equal(record.status, "cancelled");
  assert.equal(controller.signal.aborted, true);
});

test("memory-mode heartbeats do not steal pipeline ownership", async () => {
  hooks.queueModeOverride = "memory";
  const pipeline = { pipelineId: "friend-memory-pipeline", cwd, status: "running", ownerInstanceId: I.BRIDGE_INSTANCE_ID, ownerGeneration: "fixture-generation" };
  I.PIPELINE_RUNS.set(pipeline.pipelineId, pipeline);
  I.heartbeatKnownQueueState();
  assert.equal(pipeline.pipelineOwnershipLost, undefined);
  assert.equal(I.PIPELINE_RUNS.get(pipeline.pipelineId), pipeline);
});

test("a continued memory job retains its live claim while waiting for an occupied provider slot", async () => {
  hooks.queueModeOverride = "memory";
  const providerKey = "friend-memory-wait";
  const held = await I.acquireProviderLease({ providerKey, timeoutMs: 3000 });
  assert.equal(held.ok, true, held.error);
  const stopProviderHeartbeat = I.startProviderLeaseHeartbeat(held.lease);
  const record = memoryRecord();
  const worktreePath = path.join(root, "waiting-continued-tree");
  await mkdir(worktreePath, { recursive: true });
  Object.assign(record, { agent: "builder", mode: "write", lockMode: "strict", ownerInstanceId: I.BRIDGE_INSTANCE_ID });
  Object.assign(record.request, { agent: "builder", continueWorktree: worktreePath });
  I.QUEUE_JOBS.set(record.jobId, record);
  let ready;
  const prepared = new Promise((resolve) => { ready = resolve; });
  let acquired;
  let heartbeatTimer;
  hooks.queueJobExecutorTestHook = async (_job, { signal }) => {
    let stopLockHeartbeat;
    try {
      const now = new Date().toISOString();
      await withDb((db) => db.prepare(`INSERT INTO worktree_artifacts
        (worktree_path, cwd, branch, job_id, status, created_at, updated_at)
        VALUES (?, ?, 'fixture-branch', 'finished-fixture', 'retained', ?, ?)`)
        .run(worktreePath, cwd, now, now));
      acquired = await I.acquireHardLock({ owner: "fixture", agent: "builder", cwd, task: "waiting continuation", lockType: "write", paths: ["src"], ttlMs: 60_000 });
      assert.equal(acquired.ok, true, acquired.error);
      stopLockHeartbeat = I.startHardLockHeartbeat(acquired.lock, 60_000);
      const claim = await I.claimRetainedWorktree({ cwd, worktreePath, jobId: record.jobId });
      assert.equal(claim.ok, true, claim.error);
      ready();
      const slot = await I.acquireProviderLease({ providerKey, timeoutMs: 5000, signal });
      if (slot.ok) await I.releaseProviderLease(slot.lease);
      return { response: { content: [{ type: "text", text: "isolated provider wait ended" }] }, result: { errorType: slot.errorType || "", changedFiles: [] } };
    } finally {
      await stopLockHeartbeat?.();
      if (acquired?.ok) await I.releaseHardLock(acquired.lock.id, acquired.lock.token, acquired.lock.paths, cwd);
      await I.releaseRetainedWorktreeClaim({ cwd, worktreePath, jobId: record.jobId });
    }
  };
  try {
    assert.equal(await I.startQueueRecord(record), true);
    await Promise.race([prepared, record.executionPromise.then(() => { throw new Error("The continuation ended before entering its provider wait."); })]);
    // Production enables this timer; --self-test suppresses it, so reproduce its
    // cadence explicitly. Do not pulse the hard lock or openLockDb during the wait.
    heartbeatTimer = setInterval(I.heartbeatKnownQueueState, I.CONFIG.queueHeartbeatMs);
    await sleep(1300);
    assert.equal(record.status, "running");
    assert.equal(record.abortController.signal.aborted, false);
    const db = new I.DatabaseSync(I.stateDbPath(cwd));
    try {
      assert.equal(db.prepare("SELECT status FROM opencode_direct_runs WHERE job_id = ?").get(record.jobId).status, "started");
      assert.ok(db.prepare("SELECT expires_at FROM locks WHERE run_id = ?").get(acquired.lock.id).expires_at > Date.now());
      const instance = db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(I.BRIDGE_INSTANCE_ID);
      assert.ok(Date.parse(instance.lease_expires_at) > Date.now(), "the waiting continuation must renew its direct-audit instance");
      assert.deepEqual(await I.recoverStaleWorktreeClaims(db), []);
      assert.equal(db.prepare("SELECT status FROM worktree_artifacts WHERE worktree_path = ?").get(worktreePath).status, "in_use");
    } finally { I.closeDb(db); }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    record.abortController?.abort();
    await record.executionPromise;
    await stopProviderHeartbeat();
    await I.releaseProviderLease(held.lease);
  }
});

test("memory-mode hard-lock renewal keeps a continued direct-audit claim alive", async () => {
  hooks.queueModeOverride = "memory";
  const auditStore = I.directRunAuditStore();
  const audit = await auditStore.start({ agent: "reviewer", task: "continued owner fixture", cwd }, { runId: "friend-direct", kind: "direct", jobId: "friend-direct" });
  assert.equal(audit.audit.startedPersisted, true);
  const worktreePath = path.join(root, "continued-tree");
  await mkdir(worktreePath, { recursive: true });
  const registeredAt = new Date().toISOString();
  await withDb((db) => db.prepare(`INSERT INTO worktree_artifacts
    (worktree_path, cwd, branch, job_id, status, created_at, updated_at)
    VALUES (?, ?, 'fixture-branch', 'friend-direct', 'in_use', ?, ?)`)
    .run(worktreePath, cwd, registeredAt, registeredAt));
  const acquired = await I.acquireHardLock({ owner: "fixture", agent: "reviewer", cwd, task: "direct audit lease", lockType: "read", paths: ["src"], ttlMs: 60_000 });
  assert.equal(acquired.ok, true, acquired.error);
  const heartbeat = I.startHardLockHeartbeat(acquired.lock, 60_000);
  try {
    await withDb((db) => db.prepare("UPDATE bridge_instances SET lease_expires_at = ? WHERE instance_id = ?").run(new Date(Date.now() - 1000).toISOString(), I.BRIDGE_INSTANCE_ID));
    assert.equal(await heartbeat.pulse(), true);
    // Raw inspection avoids openLockDb renewing the row on the assertion's behalf.
    const db = new I.DatabaseSync(I.stateDbPath(cwd));
    try {
      const instance = db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(I.BRIDGE_INSTANCE_ID);
      assert.ok(Date.parse(instance.lease_expires_at) > Date.now());
      assert.deepEqual(await I.recoverStaleWorktreeClaims(db), []);
      assert.equal(db.prepare("SELECT status FROM worktree_artifacts WHERE worktree_path = ?").get(worktreePath).status, "in_use");
    } finally { I.closeDb(db); }
  } finally {
    await heartbeat();
    await I.releaseHardLock(acquired.lock.id, acquired.lock.token, acquired.lock.paths, cwd);
    await auditStore.finish(audit, { execution: { result: { changedFiles: [], errorType: "" }, response: { content: [] } } });
  }
});

test("a missing SQLite queue row still aborts its local owner", async () => {
  hooks.queueModeOverride = "sqlite";
  const record = memoryRecord();
  Object.assign(record, { status: "running", ownerInstanceId: I.BRIDGE_INSTANCE_ID, ownerGeneration: "fixture-generation", leaseExpiresAt: new Date(Date.now() + 1000).toISOString(), abortController: new AbortController() });
  I.QUEUE_JOBS.set(record.jobId, record);
  I.heartbeatKnownQueueState();
  assert.equal(record.abortController.signal.reason?.errorType, "queue_ownership_lost");
  assert.equal(record.queueOwnershipLost, true);
});

let failures = 0;
try {
  for (const { name, body } of cases) {
    const began = Date.now();
    try { await body(); console.log(`PASS ${name} (${Date.now() - began} ms)`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack || error}`); }
    finally {
      for (const record of I.QUEUE_JOBS.values()) I.clearQueueLeaseFence(record);
      I.QUEUE_JOBS.clear();
      I.PIPELINE_RUNS.clear();
      hooks.queueJobExecutorTestHook = null;
      hooks.queueModeOverride = "off";
    }
  }
} finally {
  hooks.queueModeOverride = saved.queueMode;
  hooks.stateDirectoryOverride = saved.stateDirectory;
  await rm(root, { recursive: true, force: true });
}
console.log(`${cases.length - failures}/${cases.length} friend-runtime tests passed; skipped: 0.`);
process.exit(failures ? 1 : 0);
