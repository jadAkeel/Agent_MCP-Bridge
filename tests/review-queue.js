#!/usr/bin/env node

// Regression tests for the queue, scheduler, pipeline-persistence and recovery review fixes
// (2026-09-29). Each case names the defect it covers; every case runs even when an earlier
// one fails, and the process exits non-zero if any failed.
//   node tests/review-queue.js
// "--self-test" is added to process.argv before the import because server.js keys its
// test-mode guards (background timers, attestation cache TTL) on that flag.
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
// The tool wrapper's startup-recovery wait is read at import; keep it short for the gate test.
process.env.CODEX_OPENCODE_STARTUP_RECOVERY_WAIT_MS = "200";
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  BRIDGE_INSTANCE_ID,
  BRIDGE_RUNTIME_DIR,
  BRIDGE_SERVER_PATH,
  CONFIG,
  FINALIZING_PIPELINE_IDS,
  INTEGRATION_RECOVERY_BLOCKED_ROOTS,
  PIPELINE_RUNS,
  QUEUE_JOBS,
  acquireHardLock,
  activatePipelineBatch,
  assert,
  awaitBridgeStartupRecovery,
  bridgeLaunchedAsMain,
  cancelPersistedQueueJob,
  claimPersistedPipeline,
  closeDb,
  createHash,
  enqueueQueueJob,
  findQueueWriteConflict,
  heartbeatKnownQueueState,
  mkdir,
  mkdtemp,
  nextQueueScheduleDelay,
  openLockDb,
  path,
  persistPipelineRecord,
  persistQueueRecord,
  persistTerminalQueueRecord,
  queueRequestFingerprint,
  randomBytes,
  readFile,
  readPersistedPipelineRecord,
  readPersistedQueueRecord,
  reconcileQueueStateAtStartup,
  releaseHardLock,
  resolveProjectStateRoot,
  rm,
  runCommand,
  scheduleQueue,
  scopeContractDurableSummary,
  server,
  sqliteUniqueConstraintError,
  startQueueRecord,
  symlink,
  tmpdir,
  updatePipelineRecord,
  updateQueueRecordDurable,
  verifyReleaseIntegrity,
  writeFile,
} = __selfTest.internals;

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-review-queue-"));
const stateDir = path.join(fixtureRoot, "state");
const repoInput = path.join(fixtureRoot, "repo");
await mkdir(stateDir, { recursive: true });
await mkdir(path.join(repoInput, "src"), { recursive: true });
assert.equal((await runCommand("git", ["init", "-q"], repoInput, 1000 * 30)).exitCode, 0);
const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
const initialQueueMode = selfTestHooks.queueModeOverride;
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";
const repo = await resolveProjectStateRoot(repoInput);

const pastIso = () => new Date(Date.now() - 5000).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 4000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return Boolean(await predicate());
}

async function withDb(fn) {
  const db = await openLockDb(repo);
  try {
    return await fn(db);
  } finally {
    closeDb(db);
  }
}

async function resetState() {
  QUEUE_JOBS.clear();
  PIPELINE_RUNS.clear();
  FINALIZING_PIPELINE_IDS.clear();
  for (const root of [...INTEGRATION_RECOVERY_BLOCKED_ROOTS]) INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(root);
  selfTestHooks.queueJobExecutorTestHook = null;
  selfTestHooks.queuePersistTestHook = null;
  selfTestHooks.bridgeStartupRecovery = null;
  selfTestHooks.queueWriteConflictPolicyOverride = "";
  await withDb((db) => {
    for (const table of ["opencode_pipeline_children", "opencode_jobs", "opencode_pipelines", "integration_operation_files", "integration_operations", "locks"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
}

let recordCounter = 0;
function makeRecord(overrides = {}) {
  recordCounter += 1;
  const jobId = overrides.jobId || `review-queue-${recordCounter}-${randomBytes(4).toString("hex")}`;
  const mode = overrides.mode || "read";
  const now = new Date().toISOString();
  return {
    jobId,
    parentJobId: "",
    cwd: repo,
    agent: mode === "read" ? "reviewer" : "builder",
    task: "Review queue regression",
    request: { agent: mode === "read" ? "reviewer" : "builder", task: "Review queue regression", cwd: repo },
    mode,
    lockMode: mode === "read" ? "read" : "write",
    lockedPaths: mode === "read" ? [] : ["src/a.txt"],
    allowedEdits: mode === "read" ? [] : ["src/a.txt"],
    scopeContract: mode === "read" ? { scope: { read: ["src"] } } : null,
    status: "pending",
    createdAt: now,
    startedAt: "",
    finishedAt: "",
    errorType: "",
    errorReason: "",
    resultText: "",
    changedFiles: [],
    ownerInstanceId: BRIDGE_INSTANCE_ID,
    ownerProcessId: process.pid,
    ownerGeneration: randomBytes(12).toString("hex"),
    heartbeatAt: now,
    leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    cancellationRequested: false,
    cancellationRequestedAt: "",
    childProcessId: 0,
    childProcessStartedAt: "",
    revision: 0,
    ...overrides,
  };
}

async function persistedRecord(overrides = {}) {
  const record = makeRecord(overrides);
  assert.equal((await persistQueueRecord(record)).persisted, true);
  return record;
}

async function lapseQueueLease(record) {
  await withDb((db) => db.prepare("UPDATE opencode_jobs SET lease_expires_at = ? WHERE job_id = ?").run(pastIso(), record.jobId));
  record.leaseExpiresAt = pastIso();
}

async function jobRow(jobId) {
  return await withDb((db) => db.prepare("SELECT * FROM opencode_jobs WHERE job_id = ?").get(jobId));
}

function completedExecution(text = "REVIEW REPORT: nothing to change.") {
  return {
    response: { content: [{ type: "text", text }] },
    result: { errorType: "", changedFiles: [] },
    validation: null,
    worktree: null,
  };
}

function lockRefusedExecution(errorType = "queue_lock_conflict") {
  return {
    response: { content: [{ type: "text", text: `Queued job is waiting for a conflicting consistency lock.\nerrorType: ${errorType}` }] },
    result: { errorType, changedFiles: [] },
  };
}

async function runWorker(record) {
  assert.equal(await startQueueRecord(record), true, "the claim must succeed");
  const worker = record.executionPromise;
  await worker;
}

async function insertIntegrationOperation({ operationId = `op-${randomBytes(4).toString("hex")}`, status = "quarantined", ownerInstanceId = "dead-instance", cwd = repo } = {}) {
  const now = new Date().toISOString();
  await withDb((db) => db.prepare(`
    INSERT INTO integration_operations
    (operation_id, cwd, owner_instance_id, owner_generation, status, target_head, target_state_sha256, pre_index_sha256,
     patch_sha256, source_base_commit, source_state_sha256, contract_sha256, affected_paths_json, created_at, updated_at)
    VALUES (?, ?, ?, 'gen', ?, 'head', 'state', 'index', 'patch', 'base', 'source', 'contract', '["src/a.txt"]', ?, ?)
  `).run(operationId, cwd, ownerInstanceId, status, now, now));
  return operationId;
}

function captureEvents() {
  const events = [];
  const original = console.error;
  console.error = (...args) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed?.event) {
        events.push(parsed);
        return;
      }
    } catch { /* Not a bridge event. */ }
    original(...args);
  };
  return { events, restore: () => { console.error = original; } };
}

async function makePipeline(overrides = {}) {
  const createdAt = new Date().toISOString();
  const record = {
    pipelineId: `review-pipeline-${randomBytes(4).toString("hex")}`,
    cwd: repo,
    status: "planned",
    createdAt,
    updatedAt: createdAt,
    jobs: [{ agent: "reviewer", task: "pipeline child", cwd: repo, write: false, lockType: "read", lockMode: "off", dryRun: true }],
    queueJobIds: [],
    expectedChildCount: 0,
    batchState: "unstarted",
    cleanupState: "none",
    queueMode: "sqlite",
    events: [],
    errors: [],
    ...overrides,
  };
  await persistPipelineRecord(record);
  return record;
}

async function lapsePipelineLease(record) {
  await withDb((db) => db.prepare("UPDATE opencode_pipelines SET owner_lease_expires_at = ? WHERE pipeline_id = ?").run(pastIso(), record.pipelineId));
  record.ownerLeaseExpiresAt = pastIso();
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ---- Defect 1: a lapsed queue lease is re-taken by its current owner ----

test("D1 heartbeat re-takes a lapsed lease of a pre-execution record", async () => {
  const record = await persistedRecord({ status: "held" });
  QUEUE_JOBS.set(record.jobId, record);
  await lapseQueueLease(record);
  heartbeatKnownQueueState();
  const row = await jobRow(record.jobId);
  assert.ok(Date.parse(row.lease_expires_at) > Date.now(), "the heartbeat must renew the lapsed lease");
  assert.equal(row.owner_generation, record.ownerGeneration);
  assert.ok(!record.queueOwnershipLost, "a lapsed lease with the same generation is not lost ownership");
});

test("D1 scheduler re-takes a lapsed lease and runs the job instead of spinning", async () => {
  const record = await persistedRecord();
  await lapseQueueLease(record);
  let executions = 0;
  selfTestHooks.queueJobExecutorTestHook = async () => {
    executions += 1;
    return completedExecution();
  };
  QUEUE_JOBS.set(record.jobId, record);
  scheduleQueue();
  assert.ok(await waitFor(() => record.status === "completed"), `the job must complete, status=${record.status}`);
  assert.equal(executions, 1);
  assert.equal((await jobRow(record.jobId)).status, "completed");
});

test("D1 a pass that advanced nothing polls instead of rescheduling at 0 ms", async () => {
  assert.equal(nextQueueScheduleDelay([{ status: "pending" }], true, false), CONFIG.queueBlockedPollMs);
  assert.equal(nextQueueScheduleDelay([{ status: "pending" }], true, true), 0);
  assert.equal(nextQueueScheduleDelay([{ status: "pending" }], true), 0, "the default keeps the old behaviour for callers that made progress");
});

test("D1 a record another owner took is dropped from QUEUE_JOBS so recovery can resume it", async () => {
  const record = await persistedRecord();
  await withDb((db) => db.prepare(`
    UPDATE opencode_jobs SET owner_instance_id = 'foreign-instance', owner_generation = 'foreign-generation', revision = revision + 1
    WHERE job_id = ?
  `).run(record.jobId));
  selfTestHooks.queueJobExecutorTestHook = async () => completedExecution();
  QUEUE_JOBS.set(record.jobId, record);
  scheduleQueue();
  assert.ok(await waitFor(() => !QUEUE_JOBS.has(record.jobId)), "the foreign-owned record must leave QUEUE_JOBS");
  assert.equal((await jobRow(record.jobId)).status, "pending", "the foreign row is not modified");
});

test("D1 a running job whose lease lapsed still commits its terminal status", async () => {
  const record = await persistedRecord({ status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => {
    await lapseQueueLease(record);
    return completedExecution();
  };
  await runWorker(record);
  const row = await jobRow(record.jobId);
  assert.equal(row.status, "completed", "the terminal commit must not require an unexpired lease");
  assert.equal(record.status, "completed");
});

test("D1 persistTerminalQueueRecord: generation and revision, not the lease, fence the commit", async () => {
  const record = await persistedRecord({ status: "planned" });
  assert.equal((await updateQueueRecordDurable(record, { status: "running", startedAt: new Date().toISOString() })).persisted, true);
  await lapseQueueLease(record);
  const stale = { ...record, ownerGeneration: "stale-generation", status: "failed", finishedAt: new Date().toISOString() };
  const db = await openLockDb(repo);
  try {
    const staleResult = persistTerminalQueueRecord(db, stale);
    assert.equal(staleResult.persisted, false);
    assert.equal(staleResult.ownershipLost, true);
    const current = persistTerminalQueueRecord(db, { ...record, status: "completed", finishedAt: new Date().toISOString(), resultText: "done" });
    assert.equal(current.persisted, true);
  } finally {
    closeDb(db);
  }
  assert.equal((await jobRow(record.jobId)).status, "completed");
});

// ---- Defect 2: a pipeline whose lease lapsed can be re-claimed by its owner ----

test("D2 claimPersistedPipeline re-claims this instance's own lapsed pipeline", async () => {
  const record = await makePipeline();
  await lapsePipelineLease(record);
  const claim = await claimPersistedPipeline(record);
  assert.equal(claim.ok, true, `claim reason=${claim.reason}`);
  const durable = await withDb((db) => db.prepare("SELECT owner_generation, owner_lease_expires_at FROM opencode_pipelines WHERE pipeline_id = ?").get(record.pipelineId));
  assert.equal(durable.owner_generation, record.ownerGeneration, "the same generation keeps the pipeline");
  assert.ok(Date.parse(durable.owner_lease_expires_at) > Date.now());
});

test("D2 updatePipelineRecord succeeds after the lease lapsed under the same generation", async () => {
  const record = await makePipeline();
  await lapsePipelineLease(record);
  await updatePipelineRecord(record, { status: "running" });
  assert.equal((await readPersistedPipelineRecord(record.pipelineId, repo)).status, "running");
});

test("D2 heartbeat re-takes a lapsed pipeline lease and drops a pipeline another generation took", async () => {
  const own = await makePipeline();
  const taken = await makePipeline();
  PIPELINE_RUNS.set(own.pipelineId, own);
  PIPELINE_RUNS.set(taken.pipelineId, taken);
  await lapsePipelineLease(own);
  await withDb((db) => db.prepare(`
    UPDATE opencode_pipelines SET owner_instance_id = 'foreign-instance', owner_generation = 'foreign-generation', revision = revision + 1
    WHERE pipeline_id = ?
  `).run(taken.pipelineId));
  heartbeatKnownQueueState();
  const ownRow = await withDb((db) => db.prepare("SELECT owner_lease_expires_at FROM opencode_pipelines WHERE pipeline_id = ?").get(own.pipelineId));
  assert.ok(Date.parse(ownRow.owner_lease_expires_at) > Date.now(), "the own lapsed lease is renewed");
  assert.ok(!own.pipelineOwnershipLost, "the own pipeline is not reported lost");
  assert.equal(PIPELINE_RUNS.has(own.pipelineId), true);
  assert.equal(PIPELINE_RUNS.has(taken.pipelineId), false, "a pipeline another generation took leaves PIPELINE_RUNS");
});

// ---- Defect 3: the scheduler sees non-queue locks and integration operations ----

test("D3 findQueueWriteConflict reports an active direct/manual hard lock", async () => {
  const lock = await acquireHardLock({ owner: "codex", agent: "builder", origin: "manual", cwd: repo, lockType: "write", paths: ["src/a.txt"] });
  assert.equal(lock.ok, true, lock.error);
  try {
    const conflict = await findQueueWriteConflict(makeRecord({ mode: "write" }));
    assert.ok(conflict, "a writer overlapping an active hard lock must wait before it is claimed");
    assert.equal(conflict.errorType, "write_lock_conflict");
    assert.match(conflict.reason, new RegExp(lock.lock.id));
  } finally {
    await releaseHardLock(lock.lock.id, lock.lock.token, lock.lock.paths, repo);
  }
});

test("D3 findQueueWriteConflict reports an unresolved integration operation as integration_recovery_pending", async () => {
  const operationId = await insertIntegrationOperation({ status: "applying" });
  const conflict = await findQueueWriteConflict(makeRecord({ mode: "write" }));
  assert.ok(conflict, "a writer must wait for an unresolved integration operation before it is claimed");
  assert.equal(conflict.errorType, "integration_recovery_pending");
  assert.match(conflict.reason, new RegExp(operationId));
  assert.equal(await findQueueWriteConflict(makeRecord({ mode: "read" })), null, "readers are not held by the integration journal");
});

test("D3 a lock refusal after the claim names the real lock, keeps its errorType and backs off", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned" });
  let lock = null;
  selfTestHooks.queueJobExecutorTestHook = async () => {
    lock = await acquireHardLock({ owner: "codex", agent: "builder", origin: "manual", cwd: repo, lockType: "write", paths: ["src/a.txt"] });
    return lockRefusedExecution("queue_lock_conflict");
  };
  try {
    await runWorker(record);
    assert.equal(record.status, "blocked");
    assert.equal(record.errorType, "queue_lock_conflict");
    assert.match(record.errorReason, new RegExp(lock.lock.id), "the blocked reason names the lock that refused the job");
    assert.ok(Number(record.queueBlockedRetryAt) > Date.now(), "a blocked re-claim is backed off");
    assert.equal(record.queueBlockedCount, 1);
    assert.ok(nextQueueScheduleDelay([{ status: "blocked", queueBlockedRetryAt: Date.now() + 30000 }], true) > CONFIG.queueBlockedPollMs * 5,
      "the scheduler waits for the backoff instead of polling every few seconds");
  } finally {
    if (lock?.ok) await releaseHardLock(lock.lock.id, lock.lock.token, lock.lock.paths, repo);
  }
});

test("D3 integration_recovery_pending from the execution stays blocked with that errorType", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => lockRefusedExecution("integration_recovery_pending");
  await runWorker(record);
  assert.equal(record.status, "blocked", `status=${record.status} errorType=${record.errorType}`);
  assert.equal(record.errorType, "integration_recovery_pending");
  assert.equal((await jobRow(record.jobId)).status, "blocked");
});

test("D3 a lock request the lock layer can never accept fails instead of retrying forever", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned", lockedPaths: ["../outside.txt"], allowedEdits: ["../outside.txt"] });
  selfTestHooks.queueJobExecutorTestHook = async () => lockRefusedExecution("queue_lock_conflict");
  await runWorker(record);
  assert.equal(record.status, "failed", `status=${record.status}`);
  assert.equal(record.errorType, "lock_request_rejected");
  assert.match(record.errorReason, /parent traversal/);
  assert.equal((await jobRow(record.jobId)).status, "failed");
});

// ---- Defect 4: a blocked state that cannot be persisted does not leave a worker-less "running" record ----

test("D4 cancellation during a lock refusal ends cancelled, not running without a worker", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => {
    const db = await openLockDb(repo);
    try {
      assert.equal((await cancelPersistedQueueJob(db, record.jobId)).outcome, "cancellation_requested");
    } finally {
      closeDb(db);
    }
    return lockRefusedExecution("queue_lock_conflict");
  };
  await runWorker(record);
  assert.equal((await jobRow(record.jobId)).status, "cancelled");
  assert.equal(record.status, "cancelled", `the in-memory record must not stay ${record.status}`);
});

// ---- Defect 5: a transient terminal-write error keeps the result ----

test("D5 a transient error on the terminal write is retried and the job stays completed with its result", async () => {
  const record = await persistedRecord({ status: "planned" });
  let failures = 0;
  selfTestHooks.queueJobExecutorTestHook = async () => completedExecution("REVIEW REPORT: retried terminal write.");
  selfTestHooks.queuePersistTestHook = async (candidate) => {
    if (candidate.jobId === record.jobId && candidate.status === "completed" && failures < 2) {
      failures += 1;
      const error = new Error("database is locked");
      error.code = "ERR_SQLITE_ERROR";
      error.errcode = 5;
      throw error;
    }
  };
  await runWorker(record);
  assert.equal(failures, 2);
  const persisted = await readPersistedQueueRecord(record.jobId, repo);
  assert.equal(persisted.status, "completed");
  assert.match(persisted.resultText, /retried terminal write/);
});

test("D5 when the terminal write keeps failing, the recorded failure keeps the evidence", async () => {
  const record = await persistedRecord({ status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => completedExecution("REVIEW REPORT: evidence that must survive.");
  selfTestHooks.queuePersistTestHook = async (candidate) => {
    if (candidate.jobId === record.jobId && candidate.status === "completed") throw new Error("database is locked");
  };
  await runWorker(record);
  const persisted = await readPersistedQueueRecord(record.jobId, repo);
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.errorType, "queue_worker_infrastructure_failed");
  assert.match(persisted.resultText, /evidence that must survive/);
  assert.match(persisted.errorReason, /ended completed/);
});

// ---- Defect 6: a concurrent-update rejection does not strip the in-memory record ----

test("D6 updatePipelineRecord keeps unredacted fields after a concurrent-update rejection", async () => {
  const finalValidationSpec = { command: "git diff --check", trusted: true };
  const record = await makePipeline({
    finalValidationCommand: "git diff --check",
    finalValidationSpec,
    events: [{ type: "created", at: new Date().toISOString() }],
    integrationQueue: [{ jobId: "child-1", status: "pending", validationSpec: { command: "git diff --check" } }],
  });
  await withDb((db) => db.prepare("UPDATE opencode_pipelines SET revision = revision + 1 WHERE pipeline_id = ?").run(record.pipelineId));
  await assert.rejects(updatePipelineRecord(record, { status: "running" }), (error) => error?.errorType === "pipeline_concurrent_update");
  assert.deepEqual(record.finalValidationSpec, finalValidationSpec);
  assert.equal(record.events.length, 1);
  assert.deepEqual(record.integrationQueue[0].validationSpec, { command: "git diff --check" });
  assert.equal(record.revision, (await readPersistedPipelineRecord(record.pipelineId, repo)).revision, "the fresh revision is still taken");
  assert.equal(record.status, "planned");
});

// ---- Defect 7: idempotent contractor retries ----

test("D7 the request fingerprint ignores the per-enqueue internal job id", async () => {
  const request = { agent: "orchestrator", task: "same work", cwd: repo };
  assert.equal(
    queueRequestFingerprint({ ...request, internalQueueJobId: "orchestrator-1-aaaa", internalQueueContractorProof: "p1" }),
    queueRequestFingerprint({ ...request, internalQueueJobId: "orchestrator-2-bbbb", internalQueueContractorProof: "p2" })
  );
});

// ---- Defect 8: node:sqlite unique-constraint detection ----

test("D8 activatePipelineBatch reports an idempotency-key collision as pipeline_batch_idempotency_conflict", async () => {
  const idempotencyKey = `review-key-${randomBytes(4).toString("hex")}`;
  const existing = await enqueueQueueJob({ agent: "reviewer", task: "Existing keyed review.", cwd: repo, dryRun: true, idempotencyKey }, "", { schedule: false });
  assert.equal(existing.ok, true, JSON.stringify(existing));
  QUEUE_JOBS.delete(existing.record.jobId);
  const pipeline = await makePipeline();
  const child = await enqueueQueueJob(pipeline.jobs[0], pipeline.pipelineId, { schedule: false, initialStatus: "held", persist: false });
  assert.equal(child.ok, true, JSON.stringify(child));
  child.record.idempotencyKey = idempotencyKey;
  const activated = await activatePipelineBatch(pipeline, [child.record]);
  assert.equal(activated.ok, false);
  assert.equal(activated.errorType, "pipeline_batch_idempotency_conflict", activated.error);
  const { DatabaseSync } = await import("node:sqlite");
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("CREATE TABLE t (k TEXT UNIQUE); INSERT INTO t VALUES ('a');");
    let thrown = null;
    try { memory.exec("INSERT INTO t VALUES ('a')"); } catch (error) { thrown = error; }
    assert.ok(thrown);
    assert.equal(sqliteUniqueConstraintError(thrown), true, `code=${thrown.code} errcode=${thrown.errcode}`);
    assert.equal(sqliteUniqueConstraintError(new Error("database is locked")), false);
  } finally {
    memory.close();
  }
});

// ---- Defect 9: re-summarizing a summarized scope contract ----

test("D9 scopeContractDurableSummary keeps the command fingerprint when re-summarized", async () => {
  const once = scopeContractDurableSummary({ mode: "write", write: ["src/a.txt"], validationCommand: "npm test" });
  const twice = scopeContractDurableSummary(once);
  const expected = createHash("sha256").update("npm test").digest("hex");
  assert.equal(once.validationCommandSha256, expected);
  assert.equal(twice.validationCommandSha256, expected);
  assert.equal(twice.validationCommandChars, "npm test".length);
  assert.equal(scopeContractDurableSummary({ mode: "read" }).validationCommandSha256, createHash("sha256").update("").digest("hex"));
});

// ---- Defect 10: recovery never runs cleanup the live finalizer (or live owner) drives ----

test("D10 recovery skips a pipeline this process is finalizing or drives live", async () => {
  const finalizing = await makePipeline({ status: "cleanup_pending", cleanupState: "authorized" });
  const live = await makePipeline({ status: "cleanup_pending", cleanupState: "authorized" });
  PIPELINE_RUNS.set(finalizing.pipelineId, finalizing);
  PIPELINE_RUNS.set(live.pipelineId, live);
  FINALIZING_PIPELINE_IDS.add(finalizing.pipelineId);
  const claim = await claimPersistedPipeline(await readPersistedPipelineRecord(live.pipelineId, repo));
  assert.equal(claim.ok, true);
  assert.equal(claim.alreadyOwnedLive, true, "claiming an own live pipeline reports it");
  await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
  assert.equal((await readPersistedPipelineRecord(finalizing.pipelineId, repo)).status, "cleanup_pending", "the finalizing pipeline's cleanup is left to the finalizer");
  assert.equal((await readPersistedPipelineRecord(live.pipelineId, repo)).status, "cleanup_pending", "an own live pipeline is left to its driver");
});

// ---- Defect 11: an ordinary integration does not block writers; lock conflicts are "unknown" ----

test("D11 a live integration (owner alive, serial lock held) is not recovered and does not block writers", async () => {
  const serialLock = await acquireHardLock({ owner: "codex", agent: "integration", cwd: repo, lockType: "serial_integration", paths: ["."], repositoryScope: true });
  assert.equal(serialLock.ok, true, serialLock.error);
  try {
    await insertIntegrationOperation({ status: "applying", ownerInstanceId: BRIDGE_INSTANCE_ID });
    const capture = captureEvents();
    try {
      await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
    } finally {
      capture.restore();
    }
    assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), false, "a live integration must not mark the repository quarantined");
    assert.equal(capture.events.filter((event) => event.event === "integration.startup_recovery_blocked").length, 0);
  } finally {
    await releaseHardLock(serialLock.lock.id, serialLock.lock.token, serialLock.lock.paths, repo);
  }
});

test("D11 a recovery refused by the serial lock leaves the blocked set unchanged", async () => {
  const serialLock = await acquireHardLock({ owner: "codex", agent: "integration", cwd: repo, lockType: "serial_integration", paths: ["."], repositoryScope: true });
  assert.equal(serialLock.ok, true, serialLock.error);
  try {
    await insertIntegrationOperation({ status: "applying", ownerInstanceId: "dead-instance" });
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
    assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), false, "a lock conflict is not evidence of a quarantine");
    INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(repo);
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
    assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), true, "nor evidence that a blocked repository recovered");
  } finally {
    await releaseHardLock(serialLock.lock.id, serialLock.lock.token, serialLock.lock.paths, repo);
  }
});

test("D11 a quarantined-only repository is requalified once, then backed off", async () => {
  await insertIntegrationOperation({ status: "quarantined" });
  const capture = captureEvents();
  try {
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
  } finally {
    capture.restore();
  }
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), true, "the quarantine blocks writers");
  const attempts = capture.events.filter((event) => ["integration.startup_recovery_blocked", "integration.startup_recovery_failed"].includes(event.event)).length;
  assert.equal(attempts, 1, `the second pass must not take the repository serial lock again (attempts=${attempts})`);
});

// ---- Defect 12: a failed scan keeps its roots blocked; roots compare case-insensitively on win32 ----

test("D12 a database whose scan fails keeps its quarantined roots blocked", async () => {
  await insertIntegrationOperation({ status: "quarantined" });
  await reconcileQueueStateAtStartup({ busyTimeoutMs: 1000 });
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), true);
  // Make the next scan fail before it reads the journal: the scan must add a missing column
  // while another connection holds the write lock, so it hits SQLITE_BUSY.
  // (A raw connection: openLockDb would add the column straight back.)
  const { DatabaseSync } = await import("node:sqlite");
  const holderPath = await withDb((db) => db.prepare("PRAGMA database_list").get().file);
  const holder = new DatabaseSync(holderPath);
  holder.exec("ALTER TABLE runs DROP COLUMN containment");
  let failedScan = 0;
  const capture = captureEvents();
  try {
    holder.exec("BEGIN IMMEDIATE");
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 50 });
    failedScan = capture.events.filter((event) => event.event === "queue.startup_recovery_failed").length;
  } finally {
    capture.restore();
    try { holder.exec("ROLLBACK"); } catch { /* Released. */ }
    holder.close();
  }
  assert.ok(failedScan >= 1, "the fixture must make the scan fail");
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), true, "a failed scan must not unblock the repository");
});

test("D12 blocked roots compare case-insensitively on win32", async () => {
  INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(repo);
  const other = process.platform === "win32" ? repo.toUpperCase() : repo;
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(other), true);
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(`${repo}${path.sep}`), true, "a trailing separator is the same root");
  INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(other);
  assert.equal(INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(repo), false);
});

// ---- Defect 13: release integrity hashes the bridge itself ----

test("D13 verifyReleaseIntegrity hashes server.js, not the importer or argv[1]", async () => {
  const expected = createHash("sha256").update(await readFile(BRIDGE_SERVER_PATH)).digest("hex");
  // B-092: a server pin without the lib/ pin is refused, so the test pins both.
  const { libDigest } = await import("../bin/lib-digest.js");
  const expectedLib = (await libDigest(path.dirname(BRIDGE_SERVER_PATH))).sha256;
  const previousExpected = process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256;
  const previousLib = process.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256;
  const previousManifest = process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
  const previousArgv1 = process.argv[1];
  try {
    process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = expected;
    process.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256 = expectedLib;
    delete process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    await verifyReleaseIntegrity();
    process.argv[1] = "";
    await verifyReleaseIntegrity();
  } finally {
    process.argv[1] = previousArgv1;
    if (previousExpected === undefined) delete process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256;
    else process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = previousExpected;
    if (previousLib === undefined) delete process.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256;
    else process.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256 = previousLib;
    if (previousManifest !== undefined) process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = previousManifest;
  }
});

// ---- Defect 14: launch detection, connect-first startup, startup gate, readdir errors ----

test("D14 a launch through a junction/symlink or without the .js extension is the main module", async () => {
  const link = path.join(fixtureRoot, "bridge-link");
  await symlink(BRIDGE_RUNTIME_DIR, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(bridgeLaunchedAsMain(path.join(link, "server.js")), true);
  assert.equal(bridgeLaunchedAsMain(path.join(BRIDGE_RUNTIME_DIR, "server")), true);
  assert.equal(bridgeLaunchedAsMain(path.join(link, "server")), true);
  assert.equal(bridgeLaunchedAsMain(path.join(BRIDGE_RUNTIME_DIR, "tests", "review-queue.js")), false);
  assert.equal(bridgeLaunchedAsMain(""), false);
  if (process.platform === "win32") assert.equal(bridgeLaunchedAsMain(BRIDGE_SERVER_PATH.toUpperCase()), true);

  // End to end: the bridge started through the link, without the extension, answers MCP.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const runtimeRoot = path.join(fixtureRoot, "e2e");
  const e2eState = path.join(runtimeRoot, "state");
  const e2eTemp = path.join(runtimeRoot, "temp");
  const e2eConfig = path.join(runtimeRoot, "config");
  await Promise.all([e2eState, e2eTemp, e2eConfig].map((directory) => mkdir(directory, { recursive: true })));
  const client = new Client({ name: "review-queue-launch", version: "1.0.0" });
  const env = { ...process.env };
  delete env.CODEX_OPENCODE_STARTUP_RECOVERY_WAIT_MS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(link, "server")],
    cwd: BRIDGE_RUNTIME_DIR,
    env: {
      ...env,
      CODEX_HOME: path.join(runtimeRoot, "codex-home"),
      XDG_CONFIG_HOME: e2eConfig,
      XDG_DATA_HOME: path.join(runtimeRoot, "data"),
      XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
      XDG_STATE_HOME: path.join(runtimeRoot, "xdg-state"),
      CODEX_OPENCODE_STATE_DIR: e2eState,
      CODEX_OPENCODE_QUEUE_MODE: "sqlite",
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
      CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "",
      CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "",
      CODEX_OPENCODE_WORKTREE_MODE: "off",
      TEMP: e2eTemp,
      TMP: e2eTemp,
      TMPDIR: e2eTemp,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport, { timeout: 30000 });
    const tools = await client.listTools(undefined, { timeout: 30000 });
    assert.ok(tools.tools.some((tool) => tool.name === "list_opencode_jobs"));
    const jobs = await client.callTool({ name: "list_opencode_jobs", arguments: {} }, undefined, { timeout: 30000 });
    assert.ok(Array.isArray(jobs.content) && jobs.content.length, JSON.stringify(jobs));
    assert.doesNotMatch(jobs.content[0].text || "", /startup_recovery_pending/);
  } finally {
    await client.close().catch(() => {});
  }
});

test("D14 tool calls wait for startup recovery, bounded, then reject clearly", async () => {
  let release = null;
  selfTestHooks.bridgeStartupRecovery = new Promise((resolve) => { release = resolve; });
  let ran = 0;
  server.tool("review_queue_startup_probe", "Review regression probe.", async () => {
    ran += 1;
    return { content: [{ type: "text", text: "ran" }] };
  });
  const probe = server._registeredTools.review_queue_startup_probe;
  const handler = probe.handler || probe.callback;
  assert.equal((await awaitBridgeStartupRecovery(20)).ok, false);
  const pending = await handler({}, {});
  assert.equal(pending.isError, true);
  assert.match(pending.content[0].text, /startup_recovery_pending/);
  assert.equal(ran, 0, "the handler must not run before recovery finished");
  release();
  const done = await handler({}, {});
  assert.equal(done.content[0].text, "ran");
  assert.equal(ran, 1);
  const source = await readFile(BRIDGE_SERVER_PATH, "utf8");
  const mainBlock = source.slice(source.lastIndexOf("const BRIDGE_RUN_AS_MAIN"));
  assert.ok(mainBlock.indexOf("await server.connect(transport)") >= 0);
  assert.ok(mainBlock.indexOf("await server.connect(transport)") < mainBlock.indexOf("await bridgeStartupRecovery"),
    "the transport connects before startup recovery is awaited");
});

test("D14 a non-ENOENT projects-directory error is logged, not thrown", async () => {
  const brokenState = path.join(fixtureRoot, "broken-state");
  await mkdir(brokenState, { recursive: true });
  await writeFile(path.join(brokenState, "projects"), "not a directory", "utf8");
  const previous = selfTestHooks.stateDirectoryOverride;
  const capture = captureEvents();
  try {
    selfTestHooks.stateDirectoryOverride = brokenState;
    await reconcileQueueStateAtStartup({ busyTimeoutMs: 250 });
  } finally {
    capture.restore();
    selfTestHooks.stateDirectoryOverride = previous;
  }
  assert.ok(capture.events.some((event) => event.event === "state.recovery_projects_scan_failed"));
});

let failed = 0;
try {
  for (const { name, fn } of cases) {
    try {
      await resetState();
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 3).join("\n     ")}`);
    }
  }
  await resetState().catch(() => {});
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  selfTestHooks.queueModeOverride = initialQueueMode;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
}
console.log(failed ? `${failed} of ${cases.length} review-queue tests failed.` : `All ${cases.length} review-queue tests passed.`);
process.exit(failed ? 1 : 0);
