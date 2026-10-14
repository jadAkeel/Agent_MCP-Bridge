#!/usr/bin/env node

// D5-R04: the public finalizer lease wrapper uses real scratch SQLite locks.
// Validation, snapshots and containment capture are synthetic; no provider is executed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLockRuntime } from "../lib/locks.js";
import { createPipelineFinalizeRuntime } from "../lib/pipelines/finalize.js";
import { createProcessTableRuntime } from "../lib/process-table.js";
import { createProviderQuarantineRuntime } from "../lib/provider-quarantine.js";
import { createStateSchema } from "../lib/state/schema.js";
import { createValidationRuntime } from "../lib/validation-command.js";
import { finishSkips } from "./skip-gate.js";

const parent = await realpath(tmpdir());
const scratch = await mkdtemp(path.join(parent, "review-day5-finalizer-containment-"));
assert.equal(path.dirname(await realpath(scratch)), parent);
const tests = [], test = (name, fn) => tests.push({ name, fn });
const held = Number.MAX_SAFE_INTEGER;
const gonePid = 2147483647;
const old = Date.now() - 60 * 60 * 1000;
const evidence = complete => JSON.stringify({ pids: [gonePid], processes: [], complete, recordedAt: old });
const passed = { status: "passed", exitCode: 0, stdout: "", stderr: "", errorType: null };
const uncertain = { status: "failed", exitCode: "timeout", stdout: "", stderr: "fixture containment unconfirmed",
  errorType: "validation_process_tree_unconfirmed", processTreeUnconfirmed: true,
  supervisorProcessId: gonePid, payloadProcessId: gonePid - 1 };
const sha = value => createHash("sha256").update(value).digest("hex");
let sequence = 0;
function noMaps(value) {
  assert.ok(!(value instanceof Map), "ordinary snapshots must remain transient");
  if (value && typeof value === "object") for (const child of Object.values(value)) noMaps(child);
}

async function withFixture(options, fn) {
  const root = path.join(scratch, `fixture-${++sequence}`);
  const cwd = path.join(root, "repo"), source = path.join(root, "source");
  await mkdir(cwd, { recursive: true }); await mkdir(source);
  await writeFile(path.join(source, "kept.txt"), "reviewed source\n");
  const dbPath = path.join(root, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA synchronous = FULL;
    CREATE TABLE locks (normalized_path TEXT NOT NULL, owner_agent TEXT NOT NULL,
      acquisition_origin TEXT NOT NULL DEFAULT 'legacy', run_id TEXT NOT NULL, token TEXT NOT NULL,
      lock_mode TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      cwd TEXT, task TEXT, edits_checkout INTEGER, PRIMARY KEY (normalized_path, run_id));
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent TEXT NOT NULL, status TEXT NOT NULL,
      lock_mode TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, containment TEXT);
    CREATE TABLE queue_job_locks (lock_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_generation TEXT NOT NULL);
    CREATE TABLE integration_operations (operation_id TEXT PRIMARY KEY, cwd TEXT, status TEXT, updated_at TEXT);`);
  const calls = { acquire: 0, release: 0, quarantine: 0, evidence: 0, provisionalEvidence: 0, protect: 0, restore: 0, heartbeatStops: 0,
    captures: 0, validation: 0, agents: 0, cleanup: 0, authorizations: 0, writes: 0 };
  const events = [], locks = [], heartbeats = [];
  let context;
  const openLockDb = async () => {
    const stage = context?.dbStage;
    if (stage && (context?.failDbOpen === stage || stage === "quarantine" && context?.failQuarantineOpen)) throw new Error(`fixture ${stage} database unavailable`);
    if (context?.pauseHeartbeatOpen) { const resume = context.pauseHeartbeatOpen; context.pauseHeartbeatOpen = null; await resume; }
    const handle = new DatabaseSync(dbPath);
    if (!context?.commitFault || !stage) return handle;
    const fault = context.commitFault;
    return new Proxy(handle, { get(target, key) {
      if (key === "exec") return sql => {
        if (sql === "COMMIT" && fault.stage === stage && !fault.used) {
          fault.used = true;
          if (fault.afterCommit) target.exec(sql);
          if (fault.failReadback) context.failDbOpen = stage;
          throw new Error(`fixture ${stage} commit acknowledgement failed`);
        }
        return target.exec(sql);
      };
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const closeDb = handle => handle.close();
  const processRuntime = createProcessTableRuntime({ CONFIG: { containmentReleaseGraceMs: 1000 },
    BRIDGE_RUNTIME_DIR: root, OPENCODE_EXE: "opencode.exe",
    runCommand: async () => { throw new Error("No process inventory should be needed for these synthetic roots"); } });
  assert.equal(processRuntime.containmentProcessExists(gonePid), false, "synthetic gone PID is actually absent");
  const reclamation = createProviderQuarantineRuntime({ CONFIG: {}, containmentStillPossible: processRuntime.containmentStillPossible,
    openLockDb, closeDb, logEvent: (level, name, details) => events.push({ level, name, details }) });
  const lockDependencies = {
    CONFIG: { worktreeMode: "off" }, DEFAULT_LOCK_TTL_MS: 1000, MAX_LOCK_TTL_MS: 600000,
    PARALLEL_LOCK_TYPES: new Set(["read", "write", "serial_integration"]),
    INTEGRATION_RECOVERY_BLOCKED_ROOTS: new Set(), INTEGRATION_RESOLVED_SQL: "'completed'",
    ensureTableColumn: createStateSchema().ensureTableColumn,
    openLockDb, closeDb, resolveProjectStateRoot: async () => cwd,
    reclaimLockQuarantinesForRoot: reclamation.reclaimLockQuarantinesForRoot,
    logEvent: (level, name, details) => events.push({ level, name, details }), timeoutForAgent: () => 1000,
  };
  const primary = createLockRuntime(lockDependencies), independent = createLockRuntime(lockDependencies);
  const proof = { sourceBaseCommit: "1".repeat(40), patchSha256: sha("reviewed source\n"), sourceStateSha256: sha("reviewed source\n") };
  const record = { pipelineId: `pipeline-${sequence}`, cwd, status: "awaiting_finalization", events: [], errors: [],
    finalValidationCommand: "synthetic-validator", finalValidationSource: "caller",
    reviewerJob: { agent: "reviewer", task: "Review" }, testerJob: { agent: "tester", task: "Test" },
    integrationQueue: [{ jobId: "fixture-job", status: "integrated", cleanupRequested: true,
      worktreePath: source, branch: "fixture-source", ...proof }] };
  context = { root, cwd, source, db, dbPath, calls, events, locks, heartbeats, primary, independent, record, lockDependencies,
    gateResult: { ...uncertain }, failQuarantineOpen: false, ...options };
  const dependencies = {
    CONFIG: { validationCommandTimeoutMs: 1000, readOnlyRetryMaxElapsedMs: 0 }, DEFAULT_LOCK_TTL_MS: 1000,
    PIPELINE_INTEGRATION_CLOSED_STATUSES: new Set(["completed", "failed", "cancelled"]), nowMs: Date.now,
    abortSignalErrorType: (signal, fallback) => signal?.reason?.errorType || fallback,
    combineAbortSignals: signals => AbortSignal.any(signals.filter(Boolean)),
    resolveProjectStateRoot: async () => cwd,
    acquireHardLock: async request => {
      calls.acquire++;
      const acquired = await primary.acquireHardLock(request);
      if (acquired.ok) locks.push(acquired.lock);
      return acquired;
    },
    releaseHardLock: async (...args) => { calls.release++; return await primary.releaseHardLock(...args); },
    beginFinalizerValidationProtection: async (...args) => {
      calls.protect++; await context.beforeProtection?.(context); context.dbStage = "protection";
      try { const result = await primary.beginFinalizerValidationProtection(...args); context.receipt = result.receipt; return result; }
      finally { context.dbStage = null; }
    },
    restoreFinalizerReadLease: async (...args) => {
      calls.restore++; await context.beforeRestoration?.(context); context.dbStage = "restoration";
      try { return await primary.restoreFinalizerReadLease(...args); } finally { context.dbStage = null; }
    },
    quarantineHardLock: async (lock, containment, mode) => {
      calls.quarantine++;
      assert.equal(mode.exclusive, true); assert.equal(mode.expectedProtection, context.receipt);
      context.dbStage = "quarantine";
      try { return await primary.quarantineHardLock(lock, containment, mode); } finally { context.dbStage = null; }
    },
    startHardLockHeartbeat: (lock, ttl) => {
      const heartbeat = primary.startHardLockHeartbeat(lock, ttl);
      heartbeats.push(heartbeat);
      const controller = new AbortController();
      context.heartbeatControllers ||= []; context.heartbeatControllers.push(controller);
      return Object.assign(async () => { calls.heartbeatStops++; const drained = heartbeat(); context.onHeartbeatStop?.(); await drained; }, {
        signal: AbortSignal.any([heartbeat.signal, controller.signal]), pulse: heartbeat.pulse, assertOwned: heartbeat.assertOwned,
      });
    },
    containmentRecord: async result => {
      if (!Object.keys(result).length) {
        calls.provisionalEvidence++; await context.beforeProvisionalEvidence?.(context);
        return JSON.stringify({ pids: [], processes: [], complete: false, recordedAt: old });
      }
      calls.evidence++;
      assert.equal(result.supervisorProcessId, uncertain.supervisorProcessId);
      assert.equal(result.payloadProcessId, uncertain.payloadProcessId);
      if (context.failEvidence) throw new Error("fixture containment capture failed");
      return evidence(false);
    },
    listLocks: primary.listLocks, conflictsWithActiveLock: primary.conflictsWithActiveLock,
    conflictPathsFromConflict: conflict => conflict?.paths || [],
    reconcilePipelineIntegrationOperationStates: async () => {}, refreshPipelineRecord: async () => {},
    captureIntegrationTargetState: async (_cwd, captureOptions = {}) => {
      calls.captures++;
      await context.onCapture?.(context);
      if (calls.validation && context.failLaterCapture) throw new Error("fixture later capture failed");
      return { ok: true, targetStateSha256: "fixture-state",
        ...(captureOptions.includeOrdinarySnapshot ? { ordinarySnapshot: new Map([["tracked.txt", "same"]]) } : {}) };
    },
    trackedTargetStateSha256: state => state.targetStateSha256,
    changedFilesBetween: (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)),
    runValidationGate: async request => {
      calls.validation++;
      if (context.validationGate) return await context.validationGate(request);
      await context.onGate?.(context); return { ...context.gateResult };
    },
    updatePipelineRecord: async (current, patch) => {
      const next = typeof patch === "function" ? patch(current) : patch;
      noMaps(next);
      if (context.failPersistence && next.finalValidationResult?.processTreeUnconfirmed) throw new Error("fixture pipeline persistence failed");
      if (next.events?.at(-1)?.type === "source_cleanup_authorized") calls.authorizations++;
      Object.assign(current, next); calls.writes++;
    },
    isManagedReadOnlyAgent: agent => ["reviewer", "tester"].includes(agent),
    changedFileValidationErrorType: () => "fixture_scope_violation", truncateResultText: text => text,
    executeOpenCodeJob: async () => { calls.agents++; await context.onAgent?.(context); return { result: { stdout: "GATE_VERDICT: pass", changedFiles: [] }, validation: {} }; },
    collectIntegrationPatch: async () => ({ ok: true, ...proof }),
    runCommand: async (executable, args) => {
      assert.equal(executable, "git"); assert.deepEqual(args, ["branch", "--show-current"]);
      return { exitCode: 0, stdout: "fixture-source\n" };
    },
    cleanupWorktree: async () => { assert.ok(calls.authorizations > 0); calls.cleanup++; return { cleanup: "success" }; },
  };
  context.runtime = createPipelineFinalizeRuntime(dependencies);
  context.otherFinalizer = createPipelineFinalizeRuntime({ ...dependencies,
    acquireHardLock: independent.acquireHardLock, releaseHardLock: independent.releaseHardLock,
    beginFinalizerValidationProtection: independent.beginFinalizerValidationProtection, restoreFinalizerReadLease: independent.restoreFinalizerReadLease,
    quarantineHardLock: independent.quarantineHardLock, startHardLockHeartbeat: independent.startHardLockHeartbeat });
  context.reclamation = reclamation;
  try { await fn(context); }
  finally {
    for (const heartbeat of heartbeats) await heartbeat();
    db.close();
  }
}
function durableQuarantine(context, { captured = true } = {}) {
  const lock = context.locks[0];
  assert.ok(lock);
  const row = context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(lock.id);
  assert.equal(row.normalized_path, "."); assert.equal(row.expires_at, held);
  assert.equal(row.lock_mode, "serial_integration"); assert.equal(row.edits_checkout, 1);
  assert.equal(row.token, `sha256:${sha(lock.token)}`);
  const run = context.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(lock.id);
  assert.equal(run.status, captured ? "quarantined" : "running"); assert.equal(run.lock_mode, "serial_integration");
  assert.equal(run.finished_at, null);
  if (captured) assert.equal(run.containment, evidence(false));
  else { const pending = JSON.parse(run.containment); assert.equal(pending.complete, false); assert.deepEqual(pending.pids, []); }
  assert.equal(lock.expiresAt, held); assert.equal(lock.lockType, "serial_integration");
  assert.equal(lock.lockMode, "serial_integration"); assert.equal(lock.editsCheckout, true);
  return lock;
}
async function competingRequestsRejected(context) {
  for (const request of [
    { lockType: "write", paths: ["checkout.txt"], editsCheckout: true },
    { lockType: "serial_integration", repositoryScope: true },
    { lockType: "read", repositoryScope: true },
  ]) {
    const acquired = await context.independent.acquireHardLock({ owner: "other", agent: "fixture-competitor", cwd: context.cwd, ...request });
    assert.equal(acquired.ok, false, JSON.stringify(acquired));
    assert.equal(acquired.conflict.lockId, context.locks[0].id);
    assert.equal(acquired.conflict.lockType, "serial_integration");
  }
  const validationCount = context.calls.validation;
  const record = { ...context.record, pipelineId: "another-finalizer", status: "awaiting_finalization" };
  const retry = await context.otherFinalizer.finalizePipelineRecord(record);
  assert.equal(retry.errorType, "pipeline_finalization_lock_conflict");
  const sameRetry = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(sameRetry.errorType, "pipeline_finalization_lock_conflict");
  const dry = await context.otherFinalizer.finalizePipelineRecord(record, { dryRun: true });
  assert.equal(dry.errorType, "pipeline_finalization_lock_conflict");
  assert.equal(context.calls.validation, validationCount, "no refinalization gate under quarantine");
}
function retainedBeforeLaterWork(context, result) {
  assert.equal(result.ok, false); assert.equal(result.processTreeUnconfirmed, true);
  assert.equal(result.finalValidationResult.supervisorProcessId, uncertain.supervisorProcessId);
  assert.equal(result.finalValidationResult.payloadProcessId, uncertain.payloadProcessId);
  assert.equal(context.calls.release, 0); assert.equal(context.calls.validation, 1);
  assert.equal(context.calls.captures, 1, "no later checkout snapshot after uncertain containment");
  assert.equal(context.calls.agents, 0); assert.equal(context.calls.cleanup, 0); assert.equal(context.calls.authorizations, 0);
  assert.equal(result.finalValidationContainment.lockId, context.locks[0].id);
  assert.equal(JSON.stringify(result).includes(context.locks[0].token), false, "retention receipts do not persist capabilities");
}

for (const [name, gateResult] of [
  ["flag and error", { ...uncertain }],
  ["flag only with exit zero", { ...uncertain, status: "passed", exitCode: 0, errorType: null }],
  ["error only", { ...uncertain, processTreeUnconfirmed: undefined }],
]) test(`${name} durably quarantines and rejects checkout writers, integration and refinalization`, async () => withFixture({ gateResult }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  retainedBeforeLaterWork(context, result); durableQuarantine(context);
  assert.equal(context.record.status, "awaiting_finalization");
  assert.equal(result.errorType, "validation_process_tree_unconfirmed");
  assert.equal(result.finalValidationContainment.ok, true);
  assert.equal(context.calls.quarantine, 1); assert.equal(context.calls.evidence, 1); assert.equal(context.calls.heartbeatStops, 1);
  assert.equal(await context.heartbeats[0].pulse(), false, "successful quarantine stops renewal");
  await competingRequestsRejected(context); durableQuarantine(context);
  assert.equal(await readFile(path.join(context.source, "kept.txt"), "utf8"), "reviewed source\n");
}));
test("the reported validation error survives an accompanying containment flag", async () => withFixture({ gateResult: { ...uncertain, errorType: "validation_command_failed" } }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(result.errorType, "validation_command_failed");
  assert.equal(result.finalValidationResult.errorType, "validation_command_failed");
  retainedBeforeLaterWork(context, result); durableQuarantine(context);
}));
test("an injected later snapshot failure cannot run or release the uncertain lease", async () => withFixture({ failLaterCapture: true }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  retainedBeforeLaterWork(context, result); durableQuarantine(context);
  await competingRequestsRejected(context);
}));
test("pipeline persistence failure after an uncertain gate retains durable protection and IDs", async () => withFixture({ failPersistence: true }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assert.match(result.error, /fixture pipeline persistence failed/);
  assert.equal(context.record.status, "finalizing");
  retainedBeforeLaterWork(context, result); durableQuarantine(context);
  await competingRequestsRejected(context);
}));
test("failed containment capture reports failure while missing-evidence quarantine stays held", async () => withFixture({ failEvidence: true }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  retainedBeforeLaterWork(context, result); durableQuarantine(context, { captured: false });
  assert.equal(result.finalValidationContainment.ok, false);
  assert.equal(result.finalValidationContainment.evidenceCaptured, false);
  assert.equal(result.finalValidationContainment.quarantinePersisted, false);
  assert.equal(result.finalValidationContainment.provisionalProtectionPersisted, true);
  assert.match(result.error, /fixture containment capture failed/);
  await competingRequestsRejected(context);
  assert.equal(await context.reclamation.reclaimProvenGoneLockQuarantines(context.db), 0);
}));
test("confirmed pass keeps normal read concurrency and releases after authorized cleanup", async () => withFixture({ gateResult: passed, onCapture: async context => {
  if (context.calls.captures !== 1) return;
  const reader = await context.independent.acquireHardLock({ agent: "snapshot-reader", lockType: "read", repositoryScope: true, cwd: context.cwd });
  assert.equal(reader.ok, true, "the initial snapshot still uses ordinary read concurrency");
  await context.independent.releaseHardLock(reader.lock.id, reader.lock.token, reader.lock.paths, reader.lock.cwd);
}, onGate: async context => {
  const reader = await context.independent.acquireHardLock({ agent: "fixture-reader", lockType: "read", repositoryScope: true, cwd: context.cwd });
  assert.equal(reader.ok, false, "only the checkout-command interval is exclusive");
  assert.equal(context.locks[0].lockType, "serial_integration");
  assert.equal(context.locks[0].expiresAt, held);
}, onAgent: async context => {
  const reader = await context.independent.acquireHardLock({ agent: "fixture-reader", lockType: "read", repositoryScope: true, cwd: context.cwd });
  assert.equal(reader.ok, true); assert.equal(context.locks[0].lockType, "read");
  assert.ok(context.locks[0].expiresAt < held);
  assert.equal((await context.independent.releaseHardLock(reader.lock.id, reader.lock.token, reader.lock.paths, reader.lock.cwd)).ok, true);
} }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(result.ok, true); assert.equal(context.record.status, "completed");
  assert.equal(context.calls.cleanup, 1); assert.equal(context.calls.authorizations, 1);
  assert.equal(context.calls.release, 1); assert.equal(context.calls.quarantine, 0); assert.equal(context.calls.evidence, 0);
  assert.equal(context.calls.heartbeatStops, 2); assert.equal(context.calls.captures, 3); assert.equal(context.calls.agents, 2);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 0);
}));
for (const [name, gateResult] of [
  ["confirmed validation failure", { ...passed, status: "failed", exitCode: 1, errorType: "validation_command_failed" }],
  ["pre-spawn refusal", { ...passed, status: "failed", exitCode: "not_run", processStarted: false, errorType: "validation_command_untrusted" }],
]) test(`${name} retains ordinary release semantics`, async () => withFixture({ gateResult }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(result.errorType, gateResult.errorType); assert.equal(context.record.status, "failed");
  assert.equal(context.calls.release, 1); assert.equal(context.calls.quarantine, 0); assert.equal(context.calls.evidence, 0);
  assert.equal(context.calls.heartbeatStops, 2); assert.equal(context.calls.cleanup, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 0);
}));
test("dry runs and existing finalized/error paths retain their ordinary lifecycle", async () => withFixture({}, async context => {
  const dry = await context.runtime.finalizePipelineRecord(context.record, { dryRun: true });
  assert.equal(dry.ok, true); assert.equal(context.calls.acquire, 0); assert.equal(context.calls.writes, 0);
  for (const status of ["completed", "failed", "cancelled", "cleanup_pending", "cleanup_failed"]) {
    const record = { ...context.record, status };
    const before = context.calls.release;
    const result = await context.runtime.finalizePipelineRecord(record);
    assert.equal(result.ok, status === "completed"); assert.equal(context.calls.release, before + 1);
    assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 0);
  }
  assert.equal(context.calls.validation, 0); assert.equal(context.calls.quarantine, 0);
}));
test("independent ownership loss without uncertain containment still attempts ordinary release", async () => withFixture({ gateResult: passed, onCapture: async context => {
  context.db.prepare("DELETE FROM locks WHERE run_id = ?").run(context.locks[0].id);
  assert.equal(await context.heartbeats[0].pulse(), false);
  assert.equal(context.heartbeats[0].signal.aborted, true);
} }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(result.ok, false); assert.equal(result.errorType, "read_lock_ownership_lost");
  assert.equal(context.calls.release, 1); assert.equal(context.calls.quarantine, 0); assert.equal(context.calls.cleanup, 0);
  assert.equal(context.calls.validation, 0, "sticky reader ownership loss refuses payload admission");
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 0);
}));
test("native quarantine rollback retains provisional protection and fences independent retry", async () => withFixture({}, async context => {
  context.db.exec(`CREATE TRIGGER refuse_quarantine BEFORE UPDATE OF status ON runs
    WHEN NEW.status = 'quarantined' BEGIN SELECT RAISE(ABORT, 'fixture quarantine write refused'); END;`);
  const result = await context.runtime.finalizePipelineRecord(context.record);
  retainedBeforeLaterWork(context, result);
  assert.equal(result.finalValidationContainment.ok, false); assert.equal(result.finalValidationContainment.quarantinePersisted, false);
  assert.equal(context.calls.heartbeatStops, 1);
  const lock = context.locks[0];
  assert.equal(lock.lockType, "serial_integration"); assert.equal(lock.expiresAt, held);
  const row = context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(lock.id);
  assert.equal(row.lock_mode, "serial_integration"); assert.equal(row.expires_at, held);
  assert.equal(context.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status, "running");
  assert.equal(await context.heartbeats[0].pulse(), false, "the drained heartbeat cannot shrink provisional protection");
  const before = context.calls.quarantine;
  await context.runtime.finalizePipelineRecord(context.record, { dryRun: true });
  assert.equal(context.calls.quarantine, before, "a dry run cannot retry persistence");
  const retry = await context.runtime.finalizePipelineRecord({ ...context.record, pipelineId: "other-pipeline" });
  assert.equal(retry.errorType, "pipeline_finalization_lock_conflict");
  assert.equal(context.calls.validation, 1); assert.equal(context.calls.release, 0);
  const writer = await context.independent.acquireHardLock({ agent: "writer", paths: ["checkout.txt"], editsCheckout: true, cwd: context.cwd });
  assert.equal(writer.ok, false, "existing reader still protects checkout mutation");
  context.db.exec("DROP TRIGGER refuse_quarantine");
  const protectedRetry = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(protectedRetry.ok, false); assert.equal(protectedRetry.errorType, "pipeline_finalization_lock_conflict");
  assert.equal(context.calls.validation, 1); assert.equal(context.calls.evidence, 1);
  assert.equal(context.calls.heartbeatStops, 1); durableQuarantine(context, { captured: false });
  await competingRequestsRejected(context);
}));
test("a thrown quarantine open failure does not claim durability or ordinarily release", async () => withFixture({ failQuarantineOpen: true }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  retainedBeforeLaterWork(context, result);
  assert.equal(result.finalValidationContainment.ok, false); assert.equal(result.finalValidationContainment.quarantinePersisted, false);
  assert.match(result.error, /fixture quarantine database unavailable/);
  assert.equal(context.calls.heartbeatStops, 1); assert.equal(await context.heartbeats[0].pulse(), false);
  const retry = await context.runtime.finalizePipelineRecord(context.record);
  assert.equal(retry.ok, false); assert.equal(context.calls.validation, 1); assert.equal(context.calls.release, 0);
  context.failQuarantineOpen = false;
  await context.runtime.finalizePipelineRecord(context.record);
  durableQuarantine(context, { captured: false }); await competingRequestsRejected(context);
}));
test("default two-argument quarantine preserves read mode, checkout flag and read concurrency", async () => withFixture({}, async context => {
  const acquired = await context.primary.acquireHardLock({ agent: "reader", cwd: context.cwd, lockType: "read", paths: ["read.txt"], editsCheckout: false });
  assert.equal(acquired.ok, true);
  assert.equal((await context.primary.quarantineHardLock(acquired.lock, evidence(false))).ok, true);
  const row = context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(acquired.lock.id);
  assert.equal(row.lock_mode, "read"); assert.equal(row.edits_checkout, 0); assert.equal(row.expires_at, held);
  assert.equal(acquired.lock.lockType, "read"); assert.equal(acquired.lock.editsCheckout, false);
  const reader = await context.independent.acquireHardLock({ agent: "other-reader", cwd: context.cwd, lockType: "read", paths: ["read.txt"] });
  assert.equal(reader.ok, true);
  assert.equal((await context.independent.releaseHardLock(reader.lock.id, reader.lock.token, reader.lock.paths, reader.lock.cwd)).ok, true);
}));
test("exclusive quarantine restores missing owned repository rows in the requested mode", async () => withFixture({}, async context => {
  const acquired = await context.primary.acquireHardLock({ agent: "pipeline_finalizer", cwd: context.cwd, lockType: "read", repositoryScope: true, editsCheckout: false });
  assert.equal(acquired.ok, true); context.locks.push(acquired.lock);
  context.db.prepare("INSERT INTO queue_job_locks VALUES (?, 'fixture-job', 'original-generation')").run(acquired.lock.id);
  context.db.prepare("DELETE FROM locks WHERE run_id = ?").run(acquired.lock.id);
  assert.equal((await context.primary.quarantineHardLock(acquired.lock, evidence(false), { exclusive: true })).ok, true);
  durableQuarantine(context);
  assert.equal(context.db.prepare("SELECT owner_generation FROM queue_job_locks WHERE lock_id = ?").get(acquired.lock.id).owner_generation, "original-generation");
  await competingRequestsRejected(context);
}));
test("exclusive mode cannot overwrite a foreign token or upgrade a nonrepository reader", async () => withFixture({}, async context => {
  const acquired = await context.primary.acquireHardLock({ agent: "pipeline_finalizer", cwd: context.cwd, lockType: "read", repositoryScope: true });
  assert.equal(acquired.ok, true);
  const before = { ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(acquired.lock.id) };
  const wrong = { ...acquired.lock, token: "different-token" };
  assert.equal((await context.primary.quarantineHardLock(wrong, evidence(false), { exclusive: true })).ok, false);
  assert.deepEqual({ ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(acquired.lock.id) }, before);
  assert.equal(wrong.lockType, "read"); assert.ok(wrong.expiresAt < held);
  for (const invalid of [{ ...acquired.lock, agent: "reader" }, { ...acquired.lock, paths: ["file.txt"] }]) {
    assert.equal((await context.primary.quarantineHardLock(invalid, evidence(false), { exclusive: true })).ok, false);
  }
  assert.equal(context.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(acquired.lock.id).status, "running");
}));
test("existing reclamation requires complete gone-process proof before allowing finalization again", async () => withFixture({}, async context => {
  await context.runtime.finalizePipelineRecord(context.record);
  const lock = durableQuarantine(context);
  context.db.prepare("INSERT INTO queue_job_locks VALUES (?, 'fixture-job', 'original-generation')").run(lock.id);
  context.primary.expireLocksFromDb(context.db, Date.now() + 60 * 60 * 1000);
  assert.equal(await context.reclamation.reclaimProvenGoneLockQuarantines(context.db), 0);
  durableQuarantine(context); await competingRequestsRejected(context);
  context.db.prepare("UPDATE runs SET containment = ? WHERE run_id = ?").run(evidence(true), lock.id);
  assert.equal(await context.reclamation.reclaimProvenGoneLockQuarantines(context.db), 1);
  assert.equal(context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(lock.id), undefined);
  assert.equal(context.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status, "quarantine_released");
  assert.equal(context.db.prepare("SELECT * FROM queue_job_locks WHERE lock_id = ?").get(lock.id), undefined);
  context.gateResult = passed;
  assert.equal((await context.runtime.finalizePipelineRecord(context.record)).ok, true);
  assert.equal(context.calls.validation, 2); assert.equal(context.calls.release, 1);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 0);
}));

function assertNoLaterWork(context, result) {
  assert.equal(result.ok, false); assert.equal(context.calls.captures, 1);
  assert.equal(context.calls.agents, 0); assert.equal(context.calls.cleanup, 0); assert.equal(context.calls.authorizations, 0);
  assert.equal(JSON.stringify(result).includes(context.locks[0].token), false);
}

for (const failure of ["rollback", "open", "commit_rolled_back", "commit_acknowledgement", "commit_unconfirmed"]) {
  test(`pre-protection ${failure} never launches without a confirmed barrier`, async () => withFixture({ gateResult: passed }, async context => {
    if (failure === "rollback") context.db.exec(`CREATE TRIGGER refuse_protection BEFORE UPDATE OF lock_mode ON locks
      WHEN NEW.lock_mode = 'serial_integration' BEGIN SELECT RAISE(ABORT, 'fixture protection write refused'); END;`);
    if (failure === "open") context.failDbOpen = "protection";
    if (failure.startsWith("commit")) context.commitFault = { stage: "protection", afterCommit: failure !== "commit_rolled_back", failReadback: failure === "commit_unconfirmed" };
    const result = await context.runtime.finalizePipelineRecord(context.record);
    if (failure === "commit_acknowledgement") {
      assert.equal(result.ok, true); assert.equal(context.calls.validation, 1); assert.equal(context.calls.release, 1);
    } else {
      assertNoLaterWork(context, result); assert.equal(context.calls.validation, 0);
      assert.equal(context.calls.release, failure === "commit_unconfirmed" ? 0 : 1);
      assert.equal(result.errorType, "final_validation_protection_failed");
      if (failure === "commit_unconfirmed") {
        assert.equal(result.finalValidationContainment.provisionalProtectionPersisted, false);
        assert.equal(result.finalValidationContainment.durabilityUnconfirmed, true);
        context.failDbOpen = null;
        const row = context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(context.locks[0].id);
        assert.equal(row.lock_mode, "serial_integration"); assert.equal(row.expires_at, held);
        await competingRequestsRejected(context);
      }
    }
  }));
}

for (const failure of ["rollback", "open", "commit_rolled_back", "commit_acknowledgement", "commit_unconfirmed"]) {
  test(`confirmed validation restoration ${failure} is guarded and truthfully reported`, async () => withFixture({ gateResult: passed }, async context => {
    if (failure === "rollback") context.db.exec(`CREATE TRIGGER refuse_restoration BEFORE UPDATE OF lock_mode ON locks
      WHEN OLD.lock_mode = 'serial_integration' AND NEW.lock_mode = 'read' BEGIN SELECT RAISE(ABORT, 'fixture restoration write refused'); END;`);
    if (failure === "open") context.failDbOpen = "restoration";
    if (failure.startsWith("commit")) context.commitFault = { stage: "restoration", afterCommit: failure !== "commit_rolled_back", failReadback: failure === "commit_unconfirmed" };
    const result = await context.runtime.finalizePipelineRecord(context.record);
    if (failure === "commit_acknowledgement") {
      assert.equal(result.ok, true); assert.equal(context.calls.release, 1); assert.equal(context.calls.agents, 2);
    } else {
      assertNoLaterWork(context, result); assert.equal(context.calls.validation, 1); assert.equal(context.calls.release, 0);
      assert.equal(result.errorType, "final_validation_restoration_failed");
      assert.equal(result.finalValidationContainment.quarantinePersisted, false);
      assert.equal(result.finalValidationContainment.readLeaseRestored, false);
      if (failure === "commit_unconfirmed") {
        assert.equal(result.finalValidationContainment.durabilityUnconfirmed, true);
        assert.equal(context.db.prepare("SELECT lock_mode FROM locks WHERE run_id = ?").get(context.locks[0].id).lock_mode, "read");
      } else {
        durableQuarantine(context, { captured: false }); await competingRequestsRejected(context);
      }
    }
  }));
}

for (const alteration of ["missing", "foreign", "extra_scope", "expired", "wrong_run", "recovery"]) {
  test(`provisional admission refuses ${alteration} ownership without payload or recreation`, async () => withFixture({ gateResult: passed, beforeProtection: async context => {
    const lock = context.locks[0];
    if (alteration === "missing") context.db.prepare("DELETE FROM locks WHERE run_id = ?").run(lock.id);
    if (alteration === "foreign") context.db.prepare("UPDATE locks SET token = 'foreign-token' WHERE run_id = ?").run(lock.id);
    if (alteration === "expired") context.db.prepare("UPDATE locks SET expires_at = 1 WHERE run_id = ?").run(lock.id);
    if (alteration === "wrong_run") context.db.prepare("UPDATE runs SET agent = 'foreign-agent' WHERE run_id = ?").run(lock.id);
    if (alteration === "extra_scope") context.db.prepare(`INSERT INTO locks SELECT 'extra.txt', owner_agent, acquisition_origin, run_id,
      token, lock_mode, expires_at, created_at, cwd, task, edits_checkout FROM locks WHERE run_id = ?`).run(lock.id);
    if (alteration === "recovery") context.db.prepare("INSERT INTO integration_operations VALUES ('fixture-unresolved', ?, 'prepared', '1')").run(path.resolve(context.cwd));
  } }, async context => {
    const result = await context.runtime.finalizePipelineRecord(context.record);
    assertNoLaterWork(context, result); assert.equal(context.calls.validation, 0); assert.equal(context.calls.quarantine, 0);
    assert.equal(result.errorType, alteration === "recovery" ? "integration_recovery_pending" : "read_lock_ownership_lost");
    assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks WHERE lock_mode = 'serial_integration'").get().n, 0);
    if (alteration === "foreign") assert.equal(context.db.prepare("SELECT token FROM locks WHERE run_id = ?").get(context.locks[0].id).token, "foreign-token");
  }));
}

for (const alteration of ["missing", "foreign", "changed_evidence", "extra_scope"]) {
  test(`restoration and detailed quarantine refuse ${alteration} protected ownership`, async () => withFixture({ gateResult: passed, beforeRestoration: async context => {
    const lock = context.locks[0];
    if (alteration === "missing") context.db.prepare("DELETE FROM locks WHERE run_id = ?").run(lock.id);
    if (alteration === "foreign") context.db.prepare("UPDATE locks SET token = 'foreign-token' WHERE run_id = ?").run(lock.id);
    if (alteration === "changed_evidence") context.db.prepare("UPDATE runs SET containment = 'foreign-evidence' WHERE run_id = ?").run(lock.id);
    if (alteration === "extra_scope") context.db.prepare(`INSERT INTO locks SELECT 'extra.txt', owner_agent, acquisition_origin, run_id,
      token, lock_mode, expires_at, created_at, cwd, task, edits_checkout FROM locks WHERE run_id = ?`).run(lock.id);
  } }, async context => {
    const result = await context.runtime.finalizePipelineRecord(context.record);
    assertNoLaterWork(context, result); assert.equal(result.errorType, "final_validation_restoration_failed"); assert.equal(context.calls.release, 0);
    const before = context.db.prepare("SELECT * FROM locks ORDER BY normalized_path").all();
    assert.equal((await context.primary.quarantineHardLock(context.locks[0], evidence(false), { exclusive: true, expectedProtection: context.receipt })).ok, false);
    assert.deepEqual(context.db.prepare("SELECT * FROM locks ORDER BY normalized_path").all(), before);
    assert.equal(context.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(context.locks[0].id).status, "running");
  }));
}

test("competing readers defer an upgrade rather than waiting while retaining their reader", async () => withFixture({ gateResult: passed }, async context => {
  const reader = await context.independent.acquireHardLock({ agent: "other-finalizer", lockType: "read", repositoryScope: true, cwd: context.cwd });
  assert.equal(reader.ok, true);
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assertNoLaterWork(context, result); assert.equal(result.errorType, "pipeline_finalization_lock_conflict");
  assert.equal(context.calls.validation, 0); assert.equal(context.calls.release, 1);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 1);
  await context.independent.releaseHardLock(reader.lock.id, reader.lock.token, reader.lock.paths, reader.lock.cwd);
  assert.equal((await context.otherFinalizer.finalizePipelineRecord(context.record)).ok, true);
  assert.equal(context.calls.validation, 1);
}));

test("provisional protection and confirmed restoration preserve token, run fields and queue association", async () => withFixture({}, async context => {
  const acquired = await context.primary.acquireHardLock({ agent: "pipeline_finalizer", cwd: context.cwd, lockType: "read", repositoryScope: true, editsCheckout: false });
  assert.equal(acquired.ok, true);
  const lock = acquired.lock;
  context.db.prepare("INSERT INTO queue_job_locks VALUES (?, 'fixture-job', 'original-generation')").run(lock.id);
  const beforeRow = { ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(lock.id) };
  const beforeRun = { ...context.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(lock.id) };
  const protectedResult = await context.primary.beginFinalizerValidationProtection(lock, { containment: JSON.stringify({ pids: [], processes: [], complete: false, recordedAt: old }) });
  assert.equal(protectedResult.ok, true);
  assert.equal(context.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status, "running");
  assert.equal((await context.primary.restoreFinalizerReadLease(lock, protectedResult.receipt, { ttlMs: 1000 })).ok, true);
  const afterRow = { ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(lock.id) };
  assert.ok(afterRow.expires_at > Date.now() && afterRow.expires_at < held);
  afterRow.expires_at = beforeRow.expires_at;
  assert.deepEqual(afterRow, beforeRow);
  assert.deepEqual({ ...context.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(lock.id) }, beforeRun);
  assert.equal(context.db.prepare("SELECT owner_generation FROM queue_job_locks WHERE lock_id = ?").get(lock.id).owner_generation, "original-generation");
  assert.equal((await context.primary.releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)).ok, true);
}));

test("a thrown or malformed gate keeps the provisional barrier without later work", async () => {
  for (const malformed of [false, true]) await withFixture({ gateResult: malformed ? {} : passed, onGate: malformed ? null : async () => { throw new Error("fixture gate response lost"); } }, async context => {
    const result = await context.runtime.finalizePipelineRecord(context.record);
    assertNoLaterWork(context, result); assert.equal(result.processTreeUnconfirmed, true); assert.equal(context.calls.release, 0);
    durableQuarantine(context, { captured: false }); await competingRequestsRejected(context);
  });
});

test("heartbeat drain completes before protection and replacement renews only the restored reader", async () => withFixture({ gateResult: passed, onCapture: async context => {
  context.onCapture = null;
  let resume;
  context.pauseHeartbeatOpen = new Promise(resolve => { resume = resolve; });
  context.pendingPulse = context.heartbeats[0].pulse();
  context.onHeartbeatStop = resume;
}, beforeProtection: async context => {
  assert.equal(await context.pendingPulse, false, "drained pulse does not renew after stop");
  assert.equal(await context.heartbeats[0].pulse(), false);
}, onAgent: async context => {
  assert.equal(context.heartbeats.length, 2);
  assert.equal(await context.heartbeats[1].pulse(), true);
  const row = context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(context.locks[0].id);
  assert.equal(row.lock_mode, "read"); assert.ok(row.expires_at < held && row.expires_at > Date.now());
} }, async context => {
  assert.equal((await context.runtime.finalizePipelineRecord(context.record)).ok, true);
  assert.equal(context.calls.heartbeatStops, 2); assert.equal(context.calls.release, 1);
}));

test("sticky ownership loss after heartbeat drain permits no validation payload", async () => withFixture({ gateResult: passed, beforeProvisionalEvidence: async context => {
  // The old controller is retained even after its timer has stopped.
  context.db.prepare("DELETE FROM locks WHERE run_id = ?").run(context.locks[0].id);
} }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assertNoLaterWork(context, result); assert.equal(result.errorType, "read_lock_ownership_lost");
  assert.equal(context.calls.validation, 0); assert.equal(context.heartbeats.length, 1);
}));

test("a stopped heartbeat's late ownership loss stays latched through replacement", async () => withFixture({ gateResult: passed, beforeProtection: async context => {
  const error = Object.assign(new Error("fixture old heartbeat ownership loss"), { errorType: "read_lock_ownership_lost" });
  context.heartbeatControllers[0].abort(error);
} }, async context => {
  const result = await context.runtime.finalizePipelineRecord(context.record);
  assertNoLaterWork(context, result); assert.equal(result.errorType, "read_lock_ownership_lost");
  assert.equal(context.calls.validation, 0); assert.equal(context.calls.restore, 1);
  assert.equal(context.heartbeats.length, 2); assert.equal(context.calls.release, 1);
}));

test("owner process exits during uncertain validation and restarted runtime remains fenced", async () => withFixture({}, async context => {
  const childFile = path.join(context.root, "owner.mjs");
  const locksModule = new URL("../lib/locks.js", import.meta.url).href;
  const finalizerModule = new URL("../lib/pipelines/finalize.js", import.meta.url).href;
  await writeFile(childFile, `import { DatabaseSync } from 'node:sqlite';
import { createLockRuntime } from ${JSON.stringify(locksModule)};
import { createPipelineFinalizeRuntime } from ${JSON.stringify(finalizerModule)};
const [dbPath,cwd] = process.argv.slice(2);
setTimeout(()=>process.exit(38),12000); // Bounded lifetime even if the parent fails before asking it to exit.
const runtime = createLockRuntime({ CONFIG:{worktreeMode:'off'}, DEFAULT_LOCK_TTL_MS:1000, MAX_LOCK_TTL_MS:600000,
 PARALLEL_LOCK_TYPES:new Set(['read','write','serial_integration']), INTEGRATION_RECOVERY_BLOCKED_ROOTS:new Set(), INTEGRATION_RESOLVED_SQL:"'completed'",
 openLockDb:async()=>new DatabaseSync(dbPath), closeDb:db=>db.close(), resolveProjectStateRoot:async()=>cwd,
 reclaimLockQuarantinesForRoot:async()=>{}, logEvent:()=>{} });
let lock,gateInvocations=0;
process.on('message',message=>{if(message==='exit-without-cleanup')process.exit(37);});
const finalizer = createPipelineFinalizeRuntime({...runtime,
 CONFIG:{validationCommandTimeoutMs:1000,readOnlyRetryMaxElapsedMs:0},DEFAULT_LOCK_TTL_MS:1000,
 PIPELINE_INTEGRATION_CLOSED_STATUSES:new Set(['completed','failed','cancelled']),nowMs:Date.now,
 resolveProjectStateRoot:async()=>cwd,combineAbortSignals:signals=>AbortSignal.any(signals.filter(Boolean)),
 abortSignalErrorType:(signal,fallback)=>signal?.reason?.errorType||fallback,
 acquireHardLock:async request=>{const acquired=await runtime.acquireHardLock(request);if(acquired.ok)lock=acquired.lock;return acquired;},
 conflictPathsFromConflict:conflict=>conflict?.paths||[],reconcilePipelineIntegrationOperationStates:async()=>{},refreshPipelineRecord:async()=>{},
 updatePipelineRecord:async(record,patch)=>Object.assign(record,typeof patch==='function'?patch(record):patch),
 captureIntegrationTargetState:async()=>({ok:true,targetStateSha256:'fixture-state',ordinarySnapshot:new Map()}),
 runValidationGate:async()=>{gateInvocations++;return {status:'failed',exitCode:'timeout',errorType:'validation_process_tree_unconfirmed',processTreeUnconfirmed:true};},
 containmentRecord:async result=>{
  if(Object.keys(result).length){process.send({lock,gateInvocations,processTreeUnconfirmed:result.processTreeUnconfirmed});return await new Promise(()=>{});}
  return JSON.stringify({pids:[],processes:[],complete:false,recordedAt:Date.now()});
 }
});
await finalizer.finalizePipelineRecord({pipelineId:'fixture-child-owner',cwd,status:'awaiting_finalization',events:[],errors:[],
 finalValidationCommand:'synthetic-validator',finalValidationSource:'caller',integrationQueue:[]});
throw new Error('fixture finalizer unexpectedly returned before owner termination');
`);
  const child = spawn(process.execPath, [childFile, context.dbPath, context.cwd], { cwd: context.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  let timer;
  try {
    const message = await Promise.race([new Promise(resolve => child.once("message", resolve)), exit.then(result => { throw new Error(`fixture owner exited early: ${JSON.stringify(result)} ${output}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded fixture owner startup expired")), 10000); })]);
    clearTimeout(timer); context.locks.push(message.lock); assert.equal(message.gateInvocations, 1); assert.equal(message.processTreeUnconfirmed, true);
    durableQuarantine(context, { captured: false }); child.send("exit-without-cleanup");
    const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded fixture owner exit expired")), 5000); })]);
    clearTimeout(timer); assert.equal(result.code, 37); assert.equal(result.signal, null);
    const probe = createProcessTableRuntime({ CONFIG: {}, BRIDGE_RUNTIME_DIR: context.root, OPENCODE_EXE: "unused", runCommand: async () => { throw new Error("No provider inventory"); } });
    assert.equal(probe.containmentProcessExists(child.pid), false, "the synthetic owner actually exited");
    context.primary.expireLocksFromDb(context.db, Date.now() + 60 * 60 * 1000);
    assert.equal(await context.reclamation.reclaimProvenGoneLockQuarantines(context.db), 0);
    await competingRequestsRejected(context); durableQuarantine(context, { captured: false });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
  }
}));

for (const [label, command] of [["empty", ""], ["whitespace-only", " \t\r\n "]]) {
  test(`${label} checkout command genuinely skips alongside native readers without provisional protection`, async () => withFixture({}, async context => {
    let payloads = 0;
    const noPayload = async () => { payloads++; throw new Error("An empty validation command must not launch a payload"); };
    context.validationGate = createValidationRuntime({
      CONFIG: { validationCommandTimeoutMs: 1000, validationExecutableAllowlist: [] },
      integrationTimed: (_phase, fn) => fn(), nowMs: Date.now,
      runCommand: noPayload, runSpawnCommand: noPayload,
    }).runValidationGate;
    context.record.finalValidationCommand = command;
    context.record.finalValidationSource = command ? "caller" : "none";
    context.record.integrationQueue = [];
    delete context.record.reviewerJob; delete context.record.testerJob;
    const reader = await context.independent.acquireHardLock({ agent: "ordinary-reader", cwd: context.cwd,
      lockType: "read", repositoryScope: true, ttlMs: 60000 });
    assert.equal(reader.ok, true);
    const readerBefore = { ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(reader.lock.id) };
    try {
      const result = await context.runtime.finalizePipelineRecord(context.record);
      assert.equal(result.ok, true); assert.equal(context.record.status, "completed");
      assert.equal(context.record.finalValidationResult.status, "skipped");
      assert.equal(context.record.finalValidationResult.command, "");
      assert.equal(context.record.finalValidationResult.exitCode, "not_run");
      assert.equal(context.calls.validation, 1); assert.equal(payloads, 0);
      assert.equal(context.calls.protect, 0); assert.equal(context.calls.restore, 0);
      assert.equal(context.calls.provisionalEvidence, 0); assert.equal(context.calls.quarantine, 0); assert.equal(context.calls.evidence, 0);
      assert.equal(context.calls.agents, 0); assert.equal(context.calls.cleanup, 0);
      assert.equal(context.calls.release, 1); assert.equal(context.calls.heartbeatStops, 1);
      assert.equal(context.locks[0].lockType, "read");
      assert.deepEqual({ ...context.db.prepare("SELECT * FROM locks WHERE run_id = ?").get(reader.lock.id) }, readerBefore);
      assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM locks").get().n, 1);
    } finally {
      assert.equal((await context.independent.releaseHardLock(reader.lock.id, reader.lock.token, reader.lock.paths, reader.lock.cwd)).ok, true);
    }
  }));
}

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  assert.equal(path.dirname(await realpath(scratch)), parent);
  assert.ok(path.basename(scratch).startsWith("review-day5-finalizer-containment-"));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-day5-finalizer-containment.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} D5 finalizer containment tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
