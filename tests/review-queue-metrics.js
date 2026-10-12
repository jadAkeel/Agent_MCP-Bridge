// Reproducible queue costs against f8fd9ed code, using scratch state only.
import "./test-env.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { makeFlexFixture } from "./flex-fixture.js";
import { createQueueSchedulerRuntime } from "../lib/queue/scheduler.js";
import { createStateSchema } from "../lib/state/schema.js";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS = "200";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { hooks, internals: I } = __selfTest;
const f = await makeFlexFixture(__selfTest, "queue-metrics");
const oldSource = (file) => execFileSync("git", ["show", `f8fd9ed:${file}`], { encoding: "utf8", cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const oldModule = async (file, replacements = {}) => {
  let source = oldSource(file);
  for (const [specifier, replacement] of Object.entries(replacements)) source = source.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  source = source.replaceAll(/from "(\.\.?\/[^\"]+)"/g, (_, specifier) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), specifier)).href)}`);
  return import(dataUrl(source));
};
const metric = (name, value) => console.log(`METRIC ${name}: ${JSON.stringify(value)}`);
const timed = async (run) => { const start = performance.now(); const value = await run(); return { ms: performance.now() - start, value }; };
const db = await I.openLockDb(f.repo);
try {
  // Enable the expensive baseline explicitly; every baseline module comes from this worktree's
  // fixed base commit. This does not check out, copy a repository or touch operator state.
  if (process.env.QUEUE_COST_BASELINE === "1") {
    const oldPaths = dataUrl(oldSource("lib/paths.js"));
    const { createLockPlanRuntime } = await oldModule("lib/lock-plan.js", { "./paths.js": oldPaths });
    const oldPlan = createLockPlanRuntime({ CONFIG: I.CONFIG, hasWriteIntent: (job) => job.write === true,
      normalizeOrchestratorMode: () => "", userAuthorizedOrchestrator: () => false, contractorAuthorizationValid: () => false,
      READ_ONLY_PARALLEL_AGENTS: new Set(["reviewer"]), PARALLEL_LOCK_TYPES: new Set(["read", "write"]), WRITE_CAPABLE_AGENTS: new Set(["builder", "debugger"]),
      hardLockPathsForPlan: I.hardLockPathsForPlan, orchestratorPolicyError: () => null, validationCommandTrustError: () => null });
    for (const count of [500, 1000, 2000]) {
      const paths = Array.from({ length: count }, (_, index) => `src/${"p".repeat(120)}${String(index).padStart(4, "0")}.txt`);
      const job = f.writeJob(paths[0], { allowedEdits: paths, scopeContract: { mode: "write", write: paths, allowedEdits: paths, validationCommand: "git diff --check" } });
      const before = await timed(() => oldPlan.validateSingleLockPlan(job));
      const after = await timed(() => I.validateSingleLockPlanAsync(job));
      assert.equal(before.value.error, null);
      assert.equal(after.value.error, null);
      metric("path-before-after", { paths: count, beforeMs: before.ms, afterMs: after.ms });
    }
  }

  const oldLeases = (await oldModule("lib/queue/leases.js")).createQueueLeaseRuntime({ ...I,
    CONFIG: I.CONFIG, QUEUE_JOBS: I.QUEUE_JOBS, PIPELINE_RUNS: I.PIPELINE_RUNS, KNOWN_STATE_DB_PATHS: new Set(),
    foreignQueueWorkerPresence: () => ({}), effectiveQueueMode: () => "sqlite", statePruneTimes: new Map() });
  for (const count of [20, 100]) {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + I.CONFIG.queueLeaseMs).toISOString();
    const seed = db.prepare(`INSERT INTO opencode_jobs
      (job_id, cwd, status, agent, mode, created_at, owner_instance_id, owner_process_id, owner_generation, heartbeat_at, lease_expires_at, record_json)
      VALUES (?, ?, 'pending', 'reviewer', 'read', ?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < count; index++) {
      const record = { jobId: `heartbeat-${index}`, cwd: f.repo, status: "pending", mode: "read", createdAt: at,
        ownerInstanceId: I.BRIDGE_INSTANCE_ID, ownerProcessId: process.pid, ownerGeneration: `heartbeat-gen-${index}`,
        heartbeatAt: at, leaseExpiresAt: until, revision: 0 };
      seed.run(record.jobId, f.repo, at, record.ownerInstanceId, process.pid, record.ownerGeneration, at, until, JSON.stringify(record));
      I.QUEUE_JOBS.set(record.jobId, record);
    }
    db.exec("COMMIT");
    const before = await timed(() => oldLeases.heartbeatKnownQueueState());
    const after = await timed(() => I.heartbeatKnownQueueState());
    assert.equal(db.prepare("SELECT MIN(revision) AS n FROM opencode_jobs WHERE job_id LIKE 'heartbeat-%'").get().n, 2);
    // A failed batch must not publish renewals in memory or leave half its rows renewed.
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) { if (sql === "COMMIT") throw new Error("injected heartbeat commit failure"); return originalExec.call(this, sql); };
    try { I.heartbeatKnownQueueState(); } finally { DatabaseSync.prototype.exec = originalExec; }
    assert.equal(db.prepare("SELECT MAX(revision) AS n FROM opencode_jobs WHERE job_id LIKE 'heartbeat-%'").get().n, 2);
    assert.ok([...I.QUEUE_JOBS.values()].every((record) => record.revision === 2));
    metric("heartbeat", { ownedRows: count + 1, beforeMs: before.ms, afterMs: after.ms, rollbackVerified: true });
    I.QUEUE_JOBS.clear();
    db.prepare("DELETE FROM opencode_jobs WHERE job_id LIKE 'heartbeat-%'").run();
  }

  // Twenty thousand 3.5 KB summaries and genuine encrypted 20 KB reports. Each envelope's
  // authenticated identity is its own synthetic job id; no plaintext report is stored.
  const key = randomBytes(32);
  const report = Buffer.from(JSON.stringify({ resultText: "REPORT: " + "r".repeat(20000) }));
  const insert = db.prepare(`INSERT INTO opencode_jobs
    (job_id, cwd, status, agent, mode, created_at, finished_at, record_json, result_encrypted)
    VALUES (?, ?, 'completed', 'reviewer', 'read', ?, ?, ?, ?)`);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 20000; index++) {
      const id = `history-${index}`;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`queue-result\0${id}`));
      const bytes = Buffer.concat([cipher.update(report), cipher.final()]);
      const envelope = JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: bytes.toString("base64") });
      const summary = { jobId: id, cwd: f.repo, status: "completed", autoIntegrateRequested: true, worktreePath: path.join(f.root, "removed-history", id),
        completionOutcome: index % 20 === 0 ? "gave_up" : "", autoIntegration: { status: "committed" }, padding: "x".repeat(3200) };
      insert.run(id, f.repo, now, now, JSON.stringify(summary), envelope);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const held = await I.enqueueQueueJob(f.readJob(), "", { schedule: false, initialStatus: "held" });
  assert.equal(held.ok, true, held.error);
  const baselineAuto = (await oldModule("lib/queue/auto-integration.js")).createAutoIntegrationRuntime({ CONFIG: I.CONFIG });
  const baselineCountSource = /function countQueueWorkerJobs\(db, counts\) \{[\s\S]*?\n\}/.exec(oldSource("server.js"))[0];
  const baselineCount = new Function("QUEUE_WORKER_NON_TERMINAL_STATUSES", "QUEUE_ACTIVE_STATUSES", `return (${baselineCountSource})`)(
    ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"], ["running", "validating", "reviewing", "testing"]);
  for (const index of ["opencode_jobs_open_integration_idx", "opencode_jobs_committed_worktree_idx", "opencode_jobs_gave_up_idx", "opencode_jobs_auto_committed_idx"]) db.exec(`DROP INDEX ${index}`);
  const baselineSnapshot = await timed(() => baselineCount(db, { pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, notResumable: 0, waitingForPause: 0, gaveUp: 0, autoIntegrated: 0, open: 0 }));
  const baselineRecovery = await timed(() => baselineAuto.rescheduleOpenAutoIntegrations(db));
  const migrate = await timed(() => createStateSchema().ensureQueueLeaseSchema(db));
  const legacyRecovery = await timed(() => I.reconcileQueueStateAtStartup());
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM opencode_jobs WHERE job_id LIKE 'history-%'
    AND json_extract(record_json, '$.autoIntegration.worktreeSweepDone') = 1`).get().n, 64, "a legacy pass visits only its bounded batch");
  assert.ok(legacyRecovery.ms < 250, `legacy recovery scanned all history: ${legacyRecovery.ms}`);
  // Seed the eventual steady state without waiting for hundreds of five-second passes.
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`UPDATE opencode_jobs SET record_json = json_set(record_json, '$.autoIntegration.worktreeSweepDone', json('true')),
    revision = revision + 1 WHERE job_id LIKE 'history-%'`).run();
  db.exec("COMMIT");
  const recoveryTimes = [];
  for (let pass = 0; pass < 3; pass++) recoveryTimes.push((await timed(() => I.reconcileQueueStateAtStartup())).ms);
  const snapshot = await timed(() => queueWorkerApi.queueWorkerSnapshot({ repo: f.repo }));
  assert.equal(snapshot.value.counts.open, 1);
  assert.equal(snapshot.value.counts.completed, 20000);
  assert.equal(snapshot.value.counts.gaveUp, 1000);
  assert.equal(snapshot.value.counts.autoIntegrated, 20000);
  assert.ok(Math.max(...recoveryTimes) < 250, `recovery scanned history: ${recoveryTimes}`);
  assert.ok(snapshot.ms < 250, `snapshot scanned history: ${snapshot.ms}`);
  metric("history-20000", { summaryChars: db.prepare("SELECT length(record_json) AS n FROM opencode_jobs WHERE job_id='history-0'").get().n,
    beforeSnapshotCountMs: baselineSnapshot.ms, beforeRecoveryIntegrationScansMs: baselineRecovery.ms, indexMigrationMs: migrate.ms,
    firstLegacyRecoveryPassMs: legacyRecovery.ms, afterRecoveryPassMs: recoveryTimes, afterWorkerSnapshotMs: snapshot.ms });
  db.prepare("DELETE FROM opencode_jobs WHERE job_id LIKE 'history-%'").run();
  I.QUEUE_JOBS.delete(held.record.jobId);
  db.prepare("DELETE FROM opencode_jobs WHERE job_id=?").run(held.record.jobId);

  // Count real database opens by their instance upsert, and actual running-row reads. Drive the
  // old/new scheduler for the same forty blocks and the same real conflict function.
  const holder = { ...held.record, jobId: "cost-holder", status: "running", mode: "write", allowedEdits: ["src/a.txt"], lockedPaths: ["src/a.txt"] };
  I.QUEUE_JOBS.set(holder.jobId, holder);
  const rows = new Map([[holder.jobId, holder]]);
  for (let index = 0; index < 40; index++) rows.set(`cost-block-${index}`, { jobId: `cost-block-${index}`, cwd: f.repo, status: "blocked", mode: "write", allowedEdits: ["src/a.txt"], errorType: "write_lock_conflict", errorReason: "Waiting for queued write job cost-holder to release: src/a.txt, src/a.txt" });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let opens = 0;
  let probes = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    if (/INSERT INTO bridge_instances/.test(sql)) opens++;
    if (/SELECT record_json FROM opencode_jobs WHERE status IN/.test(sql)) probes++;
    return originalPrepare.call(this, sql);
  };
  const oldSchedulerFactory = (await oldModule("lib/queue/scheduler.js")).createQueueSchedulerRuntime;
  const runPasses = async (factory) => {
    let passFinished;
    const runtime = factory({ CONFIG: { ...I.CONFIG, queueParallelLimit: 64 }, QUEUE_JOBS: rows, INTEGRATION_RECOVERY_BLOCKED_ROOTS: new Set(),
      effectiveQueueMode: () => "sqlite", refreshRuntimeConcurrency: async () => {}, runningQueueRecords: () => [holder], queueMemoryGate: () => ({ blocked: false }),
      releaseQueueMemoryHold: () => {}, queueDrainRequested: () => false, findQueueWriteConflict: I.findQueueWriteConflict,
      updateQueueRecordDurableReacquiringLease: async (record, patch) => { Object.assign(record, patch); return { persisted: true }; },
      updateQueueRecordDurable: async (record, patch) => { Object.assign(record, patch); return { persisted: true }; },
      effectiveQueueWriteConflictPolicy: () => "wait", startQueueRecord: async () => { throw new Error("a blocked job started"); },
      logEvent: () => {}, nextQueueScheduleDelay: () => { passFinished(); return null; } });
    const pass = () => new Promise((resolve) => { passFinished = resolve; runtime.scheduleQueue(); });
    await pass(); // establish each block's dependency (untimed)
    opens = 0; probes = 0;
    const started = performance.now();
    for (let index = 0; index < 5; index++) { await pass(); await f.sleep(200); }
    const seconds = (performance.now() - started) / 1000;
    return { seconds, opens, probes, opensPerSecond: opens / seconds, probesPerSecond: probes / seconds };
  };
  try {
    const before = await runPasses(oldSchedulerFactory);
    for (const record of rows.values()) { delete record.queueBlockedCount; delete record.queueBlockedRetryAt; }
    const after = await runPasses(createQueueSchedulerRuntime);
    assert.equal(after.opens, 0);
    assert.equal(after.probes, 0);
    metric("blocked-40", { before, after });
  } finally { DatabaseSync.prototype.prepare = originalPrepare; }
  I.QUEUE_JOBS.delete(holder.jobId);
  console.log("3/3 queue cost measurements passed.");
} finally { I.closeDb(db); I.QUEUE_JOBS.clear(); await f.cleanup(); }
process.exit(0);
