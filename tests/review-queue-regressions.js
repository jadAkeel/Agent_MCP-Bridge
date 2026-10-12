// Day-2 queue regressions. Only scratch repositories, fake agents and synthetic SQLite rows.
import "./test-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPathMatcher, isWithinAnyPath, unsafePathReason } from "../lib/paths.js";
import { createAutoIntegrationRuntime } from "../lib/queue/auto-integration.js";
import { createQueueSchedulerRuntime } from "../lib/queue/scheduler.js";
import { createQueueStoreRuntime } from "../lib/queue/store.js";
import { createQueueStartRuntime } from "../lib/queue/start.js";
import { createQueueWorkerFilesRuntime } from "../lib/queue/worker-files.js";
import { createStateCrypto } from "../lib/state/crypto.js";
import { makeFlexFixture } from "./flex-fixture.js";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { hooks, internals: I } = __selfTest;
const f = await makeFlexFixture(__selfTest, "queue-day2");
const { repo, root, writeJob, readJob, durable, execution, callTool, textOf, sleep, waitFor } = f;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const metric = (name, value) => console.log(`METRIC ${name}: ${JSON.stringify(value)}`);
const measure = async (run) => {
  const started = performance.now();
  let previous = started;
  let maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 1);
  try {
    const value = await run();
    const ms = performance.now() - started;
    await sleep(5);
    return { value, ms, maxGap };
  } finally { clearInterval(timer); }
};
const withDb = async (run) => {
  const db = await I.openLockDb(repo);
  try { return await run(db); } finally { I.closeDb(db); }
};
const drainIntegration = async () => {
  while (I.AUTO_INTEGRATION_CHAINS.size) await Promise.all([...I.AUTO_INTEGRATION_CHAINS.values()]);
  await sleep(0);
};

test("L-2-F3-11: matcher parity, literal brackets, globs and fresh link boundaries", async () => {
  fs.mkdirSync(I.path.join(repo, "app", "[slug]"), { recursive: true });
  fs.writeFileSync(I.path.join(repo, "app", "[slug]", "page.tsx"), "page");
  const entries = ["src", "app/[slug]/page.tsx", "**/secrets/**", "config/{prod,staging}.json", "src/?.txt", "missing/[xy]/file", "src/*.txt", "src/**"];
  const files = ["src/a.txt", "src/deep/a.txt", "src/*.txt/child", "app/[slug]/page.tsx", "app/s/page.tsx", "app/[slug]/page.tsx/child", "secrets/key", "pkg/secrets/key", "config/prod.json", "missing/x/file", "missing/[xy]/file", "src", "other"];
  for (const paths of [[], ...entries.map((entry) => [entry]), entries]) {
    const matches = createPathMatcher(paths, repo);
    for (const file of files) assert.equal(matches(file), isWithinAnyPath(file, paths, repo), `${JSON.stringify(paths)}: ${file}`);
  }
  for (const cwd of [repo, ""]) {
    for (const paths of [["/"], ["/**"], ["."], [""], ["src", "/"]]) {
      const matches = createPathMatcher(paths, cwd);
      for (const file of ["/", "/tmp/x", "", ".", "src/a.txt"]) assert.equal(matches(file), isWithinAnyPath(file, paths, cwd), `${cwd} ${paths}: ${file}`);
    }
  }
  const bracketJob = writeJob("app/[slug]/page.tsx", { lockedPaths: ["app/[slug]"] });
  assert.equal(I.validateSingleLockPlan(bracketJob).error, null);
  fs.rmSync(I.path.join(repo, "app", "[slug]", "page.tsx"));
  assert.ok(I.validateSingleLockPlan(bracketJob).error, "a later check sees the deleted literal bracket file");
  const outside = I.path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, I.path.join(repo, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.match(unsafePathReason(["escape/file"], repo), /outside|symbolic link|junction/);
  assert.ok(I.validateSingleLockPlan(writeJob("escape/file", { lockedPaths: ["escape"] })).error);
});

test("L-2-F3-11/L-2-F3-1: 500/1000/2000 paths, enqueue/requeue/dedup and bounded replies", async () => {
  queueWorkerApi.requestQueueDrain();
  const timings = [];
  try {
  for (const count of [500, 1000, 2000]) {
    const paths = Array.from({ length: count }, (_, index) => `src/${"p".repeat(120)}${String(index).padStart(4, "0")}.txt`);
    const job = writeJob(paths[0], { task: `Edit ${count} paths`, allowedEdits: paths,
      scopeContract: { mode: "write", write: paths, allowedEdits: paths, validationCommand: "git diff --check" },
      idempotencyKey: `scale-${count}` });
    const validation = await measure(() => I.validateSingleLockPlanAsync(job));
    assert.equal(validation.value.error, null);
    const validationMs = validation.ms;
    let previous = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 1);
    try {
      const begin = performance.now();
      const accepted = await callTool("enqueue_opencode_job", job);
      const enqueueMs = performance.now() - begin;
      assert.notEqual(accepted.isError, true, textOf(accepted));
      const id = /Job ID: (\S+)/.exec(textOf(accepted))[1];
      const dedupStart = performance.now();
      const dedup = await callTool("enqueue_opencode_job", job);
      const dedupMs = performance.now() - dedupStart;
      assert.match(textOf(dedup), /Deduplicated: yes/);
      await withDb((db) => I.cancelPersistedQueueJob(db, id));
      const requeueStart = performance.now();
      const requeued = await callTool("requeue_opencode_job", { cwd: repo, jobId: id });
      const requeueMs = performance.now() - requeueStart;
      assert.notEqual(requeued.isError, true, textOf(requeued));
      const newId = /New job ID: (\S+)/.exec(textOf(requeued))[1];
      await callTool("cancel_opencode_job", { cwd: repo, jobId: newId });
      await sleep(5);
      timings.push({ paths: count, validationMs, pathEventLoopGapMs: validation.maxGap, enqueueMs, dedupMs, requeueMs, requestEventLoopGapMs: maxGap,
        enqueueChars: textOf(accepted).length, dedupChars: textOf(dedup).length, requeueChars: textOf(requeued).length });
      metric("path-scale-row", timings.at(-1));
      for (const response of [accepted, dedup, requeued]) {
        assert.match(textOf(response), new RegExp(`\\(\\+${count - 40} more\\)`));
        assert.ok(textOf(response).length < 6500, "only forty long paths are echoed");
      }
      assert.ok(validationMs < 1000, `path validation took ${validationMs} ms`);
      assert.ok(validation.maxGap < 100, `path check event loop gap ${validation.maxGap} ms`);
    } finally { clearInterval(timer); }
  }
  metric("path-scale", timings);
  } finally { queueWorkerApi.stopWorkerMode(); }
});

test("L-2-F3-7: cancellation wins terminal persistence and leaves no integration claim", async () => {
  hooks.queueJobExecutorTestHook = async (request, { jobId }) => {
    await withDb(async (db) => assert.equal((await I.cancelPersistedQueueJob(db, jobId)).outcome, "cancellation_requested"));
    return execution({ changedFiles: ["src/new.txt"], worktree: { path: I.path.join(root, "fake-worktree") }, validation: { status: "passed" } });
  };
  const result = await I.enqueueQueueJob(writeJob("src/new.txt", { autoIntegrate: true }));
  assert.equal(result.ok, true, result.error);
  assert.ok(await waitFor(async () => (await durable(result.record.jobId))?.status === "cancelled"));
  await drainIntegration();
  assert.equal((await durable(result.record.jobId)).autoIntegration, null);
  const refused = await I.autoIntegrateQueueJob({ cwd: repo, jobId: result.record.jobId, worktreePath: "unused" });
  assert.equal(refused.status, "not_claimed", "the durable claim itself refuses cancellation");
  assert.equal((await durable(result.record.jobId)).autoIntegration, null);
});

test("L-2-F3-6: switch off refuses single and batch claims, including an accepted job", async () => {
  let claims = 0;
  let integrations = 0;
  const runtime = createAutoIntegrationRuntime({ CONFIG: { autoIntegrateAllowed: false },
    resolveProjectStateRoot: async (cwd) => cwd,
    patchTerminalQueueSummary: async () => { claims++; return { patched: true }; },
    integratePatchSerially: async () => { integrations++; return { ok: true }; } });
  const details = { cwd: repo, jobId: "accepted-while-on", worktreePath: "unused" };
  assert.equal((await runtime.autoIntegrateQueueJob(details)).status, "not_claimed");
  await runtime.autoIntegrateQueueJobs([details, { ...details, jobId: "second-accepted-job" }]);
  assert.equal(claims, 0);
  assert.equal(integrations, 0);
  // Drive completion of an already accepted job in a runtime whose operator switch is off.
  let scheduled = 0;
  const record = { jobId: "adopted-while-off", status: "pending", request: { autoIntegrate: true }, mode: "write", cwd: repo };
  const start = createQueueStartRuntime({ CONFIG: { autoIntegrateAllowed: false },
    claimQueueRecord: async () => ({ ok: true }), resetQueueLeaseFence: () => {}, clearQueueLeaseFence: () => {}, nowMs: () => performance.now(),
    providerSlotWaitStorage: new AsyncLocalStorage(), effectiveQueueMode: () => "memory", changedFileValidationErrorType: () => "",
    executeOpenCodeJob: async () => execution({ changedFiles: ["src/new.txt"], worktree: { path: "unused" } }),
    updateQueueTerminalRecordDurable: async (live, patch) => { Object.assign(live, patch); return { persisted: true, status: patch.status }; },
    logEvent: () => {}, scheduleAutoIntegration: () => { scheduled++; }, scheduleQueue: () => {},
    summarizeStderr: () => "", timedOutWriterEvidence: () => ({}), timedOutWriterNote: () => "", QUEUE_ACTIVE_STATUSES: ["running"],
    superviseQueueWorker: (live, promise) => { live.executionPromise = promise; } });
  await start.startQueueRecord(record);
  await record.executionPromise;
  assert.equal(record.status, "completed");
  assert.equal(scheduled, 0);
});

test("L-2-F3-8: a refused recovery claim is retried after its process dies", async () => {
  hooks.queueJobExecutorTestHook = async () => execution({ changedFiles: ["src/recover.txt"], worktree: { path: root }, validation: { status: "passed" } });
  const accepted = await I.enqueueQueueJob(writeJob("src/recover.txt", { autoIntegrate: true }), "", { schedule: false });
  const id = accepted.record.jobId;
  I.QUEUE_JOBS.delete(id);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const instanceId = `${child.pid}-claim-test`;
  try {
    await withDb(async (db) => {
      const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(id);
      const summary = { ...JSON.parse(row.record_json), status: "completed", finishedAt: new Date().toISOString(),
        worktreePath: root, changedFiles: ["src/recover.txt"], autoIntegration: { status: "integrating", claimedBy: instanceId, at: new Date().toISOString() } };
      db.prepare("UPDATE opencode_jobs SET status='completed', record_json=? WHERE job_id=?").run(JSON.stringify(summary), id);
      assert.equal(await I.rescheduleOpenAutoIntegrations(db), 1);
    });
    await drainIntegration();
    assert.equal((await durable(id)).autoIntegration.claimedBy, instanceId);
    assert.equal(I.AUTO_INTEGRATION_RESCHEDULED.has(id), false);
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await I.reconcileQueueStateAtStartup();
    await drainIntegration();
    const outcome = (await durable(id)).autoIntegration;
    assert.equal(outcome.claimedBy, I.BRIDGE_INSTANCE_ID);
    assert.equal(outcome.errorType, "auto_integration_source_unattested", "the same process reclaimed it, then enforced source proof");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test("L-2-F3-3: bounded legacy cleanup advances past retained sources across database handles", async () => {
  const retained = I.path.join(root, "retained-legacy");
  fs.mkdirSync(retained);
  const runtime = createAutoIntegrationRuntime({ CONFIG: { autoIntegrateAllowed: true },
    resolveProjectStateRoot: async () => repo, logEvent: () => {}, patchTerminalQueueSummary: async () => ({ patched: true }) });
  await withDb((db) => {
    const insert = db.prepare(`INSERT INTO opencode_jobs (job_id, cwd, status, agent, mode, created_at, record_json)
      VALUES (?, ?, 'completed', 'builder', 'write', ?, ?)`);
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 200; index++) {
      const id = `legacy-sweep-${String(index).padStart(4, "0")}`;
      insert.run(id, repo, new Date().toISOString(), JSON.stringify({ jobId: id, cwd: repo, status: "completed",
        worktreePath: index < 70 ? retained : I.path.join(root, "missing-legacy", id), autoIntegration: { status: "committed" } }));
    }
    db.exec("COMMIT");
  });
  try {
    for (const expected of [0, 58, 122, 130]) {
      await withDb(async (db) => {
        assert.equal(await runtime.sweepCommittedWorktrees(db), 0, "retained sources are never removed");
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM opencode_jobs WHERE job_id LIKE 'legacy-sweep-%'
          AND json_extract(record_json, '$.autoIntegration.worktreeSweepDone') = 1`).get().n, expected);
        assert.equal(runtime.committedWorktreeSweepPending(db), expected !== 130);
      });
    }
    await withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM opencode_jobs WHERE job_id LIKE 'legacy-sweep-%' AND revision = 1").get().n, 130);
    });
    assert.equal(fs.existsSync(retained), true);
  } finally { await withDb((db) => db.prepare("DELETE FROM opencode_jobs WHERE job_id LIKE 'legacy-sweep-%'").run()); }
});

test("L-2-F3-9: a crash before onLockAcquired still releases the durable hard lock", async () => {
  const accepted = await I.enqueueQueueJob(writeJob("src/crash.txt"), "", { schedule: false });
  assert.equal((await I.claimQueueRecord(accepted.record)).ok, true);
  const record = accepted.record;
  const acquired = await I.acquireHardLock({ cwd: repo, paths: ["src/crash.txt"], ttlMs: 1800000,
    queueOwner: { jobId: record.jobId, ownerInstanceId: record.ownerInstanceId, ownerGeneration: record.ownerGeneration } });
  assert.equal(acquired.ok, true, acquired.error);
  assert.equal((await durable(record.jobId)).lockId, "", "simulate dying before the callback persisted the id");
  const associationCount = async (db, lockId) => db.prepare("SELECT COUNT(*) AS n FROM queue_job_locks WHERE lock_id = ?").get(lockId).n;
  await withDb(async (db) => assert.equal(await associationCount(db, acquired.lock.id), 1));
  // A lapsed lease with an unchanged generation is still owned; the acquire is not refused.
  await withDb(async (db) => db.prepare("UPDATE opencode_jobs SET lease_expires_at='' WHERE job_id=?").run(record.jobId));
  // The normal completion path drops the association with its fully released lock.
  const second = await I.acquireHardLock({ cwd: repo, paths: ["src/crash-second.txt"], ttlMs: 1800000,
    queueOwner: { jobId: record.jobId, ownerInstanceId: record.ownerInstanceId, ownerGeneration: record.ownerGeneration } });
  assert.equal(second.ok, true, second.error);
  assert.equal((await I.releaseHardLock(second.lock.id, second.lock.token, second.lock.paths, second.lock.cwd)).released, true);
  await withDb(async (db) => assert.equal(await associationCount(db, second.lock.id), 0));
  I.QUEUE_JOBS.delete(record.jobId);
  await withDb(async (db) => {
    db.prepare("UPDATE opencode_jobs SET lease_expires_at='' WHERE job_id=?").run(record.jobId);
    db.prepare("UPDATE bridge_instances SET lease_expires_at='' WHERE instance_id=?").run(I.BRIDGE_INSTANCE_ID);
    I.reconcileStaleQueueRecords(db, Date.now() + I.CONFIG.queueStaleAfterMs + 1000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM locks WHERE run_id=?").get(acquired.lock.id).n, 0);
    assert.equal(await associationCount(db, acquired.lock.id), 0);
    assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id=?").get(record.jobId).status, "interrupted");
  });
});

test("L-2-F3-10: refresh preserves a newer presence published after opening its descriptor", async () => {
  const presenceRuntime = createQueueWorkerFilesRuntime({ projectStateKey: () => "test", effectiveBridgeStateDirectory: () => root,
    BRIDGE_INSTANCE_ID: "worker-A", getQueueWorkerMode: () => null, getQueueDrainFlag: () => false });
  const claimed = presenceRuntime.claimQueueWorkerPresence(repo);
  assert.equal(claimed.ok, true);
  const newer = { instanceId: "worker-B", heartbeatAt: new Date().toISOString(), pid: process.pid };
  const write = fs.writeSync;
  let interleaved = false;
  fs.writeSync = (...args) => {
    if (!interleaved) {
      interleaved = true;
      const next = `${claimed.files.presence}.new`;
      fs.writeFileSync(next, JSON.stringify(newer));
      fs.renameSync(claimed.files.presence, `${claimed.files.presence}.stale`);
      fs.renameSync(next, claimed.files.presence);
    }
    return write(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(presenceRuntime.refreshQueueWorkerPresence(claimed.files).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(claimed.files.presence)).instanceId, "worker-B");
  } finally { fs.writeSync = write; syncBuiltinESMExports(); }
});

test("L-2-F3-10: refresh recreates a removed presence and rewrites an unreadable one", async () => {
  const presenceRuntime = createQueueWorkerFilesRuntime({ projectStateKey: () => "test-tolerant", effectiveBridgeStateDirectory: () => root,
    BRIDGE_INSTANCE_ID: "worker-C", getQueueWorkerMode: () => null, getQueueDrainFlag: () => false });
  const claimed = presenceRuntime.claimQueueWorkerPresence(repo);
  assert.equal(claimed.ok, true);
  fs.rmSync(claimed.files.presence);
  assert.equal(presenceRuntime.refreshQueueWorkerPresence(claimed.files).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(claimed.files.presence)).instanceId, "worker-C");
  fs.writeFileSync(claimed.files.presence, "{ not json");
  assert.equal(presenceRuntime.refreshQueueWorkerPresence(claimed.files).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(claimed.files.presence)).instanceId, "worker-C");
  fs.writeFileSync(claimed.files.presence, JSON.stringify({ instanceId: "worker-D", pid: process.pid }));
  assert.equal(presenceRuntime.refreshQueueWorkerPresence(claimed.files).ok, false, "another worker's readable record is kept");
  assert.equal(JSON.parse(fs.readFileSync(claimed.files.presence)).instanceId, "worker-D");
});

test("L-2-F3-13: a heartbeat that reacquires a lapsed pre-execution lease clears the lost flag", async () => {
  const accepted = await I.enqueueQueueJob(writeJob("src/reacquire.txt"), "", { schedule: false });
  assert.equal(accepted.ok, true, accepted.error);
  const record = accepted.record;
  try {
    assert.ok(record.ownerGeneration && ["held", "pending", "planned", "blocked"].includes(record.status), record.status);
    await withDb(async (db) => db.prepare("UPDATE opencode_jobs SET lease_expires_at='' WHERE job_id=?").run(record.jobId));
    record.queueOwnershipLost = true;
    I.heartbeatKnownQueueState();
    assert.equal(record.queueOwnershipLost, false);
    assert.ok(Date.parse(record.leaseExpiresAt) > Date.now());
  } finally {
    I.QUEUE_JOBS.delete(record.jobId);
    await withDb(async (db) => db.prepare("UPDATE opencode_jobs SET status='cancelled' WHERE job_id=?").run(record.jobId));
  }
});

test("L-2-F3-2: forty unchanged local blocks do no conflict reads, then wake on release", async () => {
  const holder = { jobId: "holder", status: "running", ownerGeneration: "g", mode: "write" };
  const records = new Map([[holder.jobId, holder]]);
  for (let index = 0; index < 40; index++) records.set(`blocked-${index}`, { jobId: `blocked-${index}`, status: "pending", mode: "write" });
  let reads = 0;
  let starts = 0;
  const runtime = createQueueSchedulerRuntime({ CONFIG: { queueParallelLimit: 64, queueBlockedPollMs: 20 }, QUEUE_JOBS: records,
    INTEGRATION_RECOVERY_BLOCKED_ROOTS: new Set(), effectiveQueueMode: () => "sqlite", refreshRuntimeConcurrency: async () => {},
    runningQueueRecords: () => [...records.values()].filter((record) => record.status === "running"), queueMemoryGate: () => ({ blocked: false }),
    releaseQueueMemoryHold: () => {}, releaseResumedPauseWaits: () => {}, queueDrainRequested: () => false,
    updateQueueRecordDurableReacquiringLease: async (record, patch) => { Object.assign(record, patch); return { persisted: true }; },
    updateQueueRecordDurable: async (record, patch) => { Object.assign(record, patch); return { persisted: true }; },
    effectiveQueueWriteConflictPolicy: () => "wait", queueRecordOwnedElsewhere: () => false,
    findQueueWriteConflict: async () => { reads++; return holder.status === "running" ? { source: "queue", jobId: holder.jobId, paths: ["src/a.txt"], errorType: "write_lock_conflict", reason: "held" } : null; },
    startQueueRecord: async (record) => { starts++; record.status = "completed"; return true; },
    nextQueueScheduleDelay: () => null, logEvent: () => {} });
  runtime.scheduleQueue();
  assert.ok(await waitFor(() => [...records.values()].filter((record) => record.status === "blocked").length === 40));
  reads = 0;
  for (let pass = 0; pass < 20; pass++) { runtime.scheduleQueue(); await sleep(25); }
  assert.equal(reads, 0);
  holder.status = "completed";
  runtime.scheduleQueue();
  assert.ok(await waitFor(() => starts === 40));
});

test("L-2-F3-5: memory queue refuses idempotencyKey with a next step", async () => {
  hooks.queueModeOverride = "memory";
  try {
    const result = await I.enqueueQueueJob(readJob({ idempotencyKey: "memory-key" }));
    assert.equal(result.ok, false);
    assert.equal(result.errorType, "idempotency_requires_sqlite");
    assert.match(result.suggestedFix, /sqlite/);
  } finally { hooks.queueModeOverride = "sqlite"; }
});

test("B-226: default list and status-filtered list retain every unfinished job", async () => {
  await withDb((db) => {
    const insert = db.prepare(`INSERT INTO opencode_jobs (job_id, cwd, status, agent, mode, created_at, record_json)
      VALUES (?, ?, 'held', 'reviewer', 'read', ?, ?)`);
    for (let index = 0; index < 45; index++) {
      const id = `unfinished-list-${index}`;
      insert.run(id, repo, new Date().toISOString(), JSON.stringify({ jobId: id, cwd: repo, status: "held", agent: "reviewer", mode: "read" }));
    }
  });
  try {
    for (const status of [undefined, "held"]) {
      const text = textOf(await callTool("list_opencode_jobs", { cwd: repo, ...(status ? { status } : {}) }));
      for (let index = 0; index < 45; index++) assert.ok(text.includes(`- unfinished-list-${index} `), `missing unfinished job ${index}`);
      if (status) assert.match(text, /Jobs: 45/);
    }
  } finally { await withDb((db) => db.prepare("DELETE FROM opencode_jobs WHERE job_id LIKE 'unfinished-list-%'").run()); }
});

test("L-2-F3-14/L-2-F3-12: slot progress is live without persists; finished details leave memory", async () => {
  let finish;
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const report = "REPORT: " + "r".repeat(20000);
  hooks.queueJobExecutorTestHook = async () => {
    const { onWait } = I.providerSlotWaitStorage.getStore();
    for (let tick = 0; tick < 240; tick++) await onWait({ waiting: true, waitedMs: tick * 5000, providerKey: "fixture", marker: `tick-${tick}` });
    waiting();
    await release;
    return execution({ text: report });
  };
  let writes = 0;
  hooks.queuePersistTestHook = (record) => { if (record.providerWaitInfo?.waiting) writes++; };
  try {
    const accepted = await I.enqueueQueueJob(readJob({ task: "Wait for provider progress" }));
    await ready;
    assert.equal(writes, 0);
    const persisted = await durable(accepted.record.jobId);
    assert.equal(persisted.providerWaitInfo.marker, "tick-239");
    I.heartbeatKnownQueueState();
    await withDb((db) => assert.equal(JSON.parse(db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id=?").get(accepted.record.jobId).record_json).providerWaitInfo.marker,
      "tick-239", "other processes see the latest wait at the existing heartbeat, without a progress persist"));
    const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, detail: true, limit: 500 }));
    assert.match(list, /tick-239/);
    finish();
    assert.ok(await waitFor(async () => (await durable(accepted.record.jobId))?.status === "completed"));
    await sleep(0);
    assert.equal((await durable(accepted.record.jobId)).resultText, report);
    const local = I.QUEUE_JOBS.get(accepted.record.jobId);
    for (const key of ["resultText", "resultDetailText", "resultEncrypted", "requestEncrypted", "cancellationResultEncrypted"]) assert.equal(local[key], undefined, key);
    metric("finished-local-chars", JSON.stringify(local).length);
  } finally { finish(); hooks.queuePersistTestHook = null; }
});

test("L-2-F3-4: ordinary persistence encrypts once; a winning cancellation encrypts its used envelope", async () => {
  let encryptions = 0;
  const crypto = createStateCrypto({ CONFIG: I.CONFIG, effectiveBridgeStateDirectory: () => f.stateDir, assertNoLinkedPath: I.assertNoLinkedPath });
  const runtime = createQueueStoreRuntime({ ...I, CONFIG: I.CONFIG, effectiveQueueMode: () => "sqlite",
    truncateText: (text, limit) => String(text).slice(0, limit),
    getQueuePersistTestHook: () => null, getQueueCancellationTestHook: () => null, propagatePipelineTerminalInTransaction: () => null,
    encryptIntegrationJournalBytes: async (...args) => { encryptions++; return crypto.encryptIntegrationJournalBytes(...args); } });
  const accepted = await I.enqueueQueueJob(readJob(), "", { schedule: false });
  const record = accepted.record;
  try {
    assert.equal((await runtime.persistQueueRecord(record)).persisted, true);
    assert.equal(encryptions, 1);
    assert.equal(record.cancellationResultEncrypted, undefined);
    assert.equal((await I.claimQueueRecord(record)).ok, true);
    await withDb((db) => I.cancelPersistedQueueJob(db, record.jobId));
    encryptions = 0;
    const result = await runtime.persistQueueRecord({ ...record, status: "completed", finishedAt: new Date().toISOString(), resultText: "REPORT: finished before noticing cancellation" });
    assert.equal(result.status, "cancelled");
    assert.equal(encryptions, 2, "the cancellation envelope is generated only after the transaction observes cancellation");
    assert.equal((await durable(record.jobId)).resultText, "");
  } finally { I.QUEUE_JOBS.delete(record.jobId); }
});

test("L-2-F3-14: each progress tick still observes cross-process cancellation without a heartbeat", async () => {
  let onWait;
  let ready;
  let release;
  const waiting = new Promise((resolve) => { ready = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  hooks.queueJobExecutorTestHook = async () => {
    onWait = I.providerSlotWaitStorage.getStore().onWait;
    await onWait({ waiting: true, waitedMs: 0, providerKey: "fixture" });
    ready();
    await finish;
    return execution();
  };
  const accepted = await I.enqueueQueueJob(readJob({ task: "Cancel while awaiting provider" }));
  try {
    await waiting;
    await withDb(async (db) => assert.equal((await I.cancelPersistedQueueJob(db, accepted.record.jobId)).outcome, "cancellation_requested"));
    await assert.rejects(onWait({ waiting: true, waitedMs: 5000, providerKey: "fixture" }), (error) => error.errorType === "agent_cancelled");
    assert.equal(accepted.record.abortController.signal.aborted, true);
    release();
    assert.ok(await waitFor(async () => (await durable(accepted.record.jobId))?.status === "cancelled"));
  } finally { release(); }
});

let failed = 0;
try {
  for (const { name, run } of tests) {
    const started = performance.now();
    try { await run(); console.log(`ok   ${name} (${Math.round(performance.now() - started)} ms)`); }
    catch (error) { failed++; console.log(`FAIL ${name}\n${error.stack}`); }
  }
} finally {
  hooks.queuePersistTestHook = null;
  await drainIntegration();
  await f.cleanup();
}
console.log(`${tests.length - failed}/${tests.length} queue regression tests passed.`);
process.exit(failed ? 1 : 0);
