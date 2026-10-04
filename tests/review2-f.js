#!/usr/bin/env node

// Regression tests for the second review of the queue / pipeline area (area F):
//   R-156 a completed writer that changed nothing (noChanges) is completed, not failed
//   R-157 a child whose every terminal write failed is still reconciled although its bridge
//         instance (kept alive by the parent pipeline) holds a fresh lease
//   R-158 `state-audit --strict` reports a pipeline stuck in `finalizing` with an expired lease
// Every case runs even when an earlier one fails; the process exits non-zero if any failed.
//   node tests/review2-f.js
// The state and cache directories are set before server.js is imported, and "--self-test" is
// added to process.argv because server.js keys its test-mode guards on that flag.
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sandbox = await mkdtemp(path.join(tmpdir(), "codex-opencode-review2-f-"));
process.env.CODEX_OPENCODE_STATE_DIR = path.join(sandbox, "env-state");
process.env.XDG_CACHE_HOME = path.join(sandbox, "env-cache");
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest } = await import("../server.js");
const { auditHasFailures, auditStateDirectory } = await import("../bin/state-audit.js");
const { DatabaseSync } = await import("node:sqlite");
const selfTestHooks = __selfTest.hooks;
const {
  BRIDGE_INSTANCE_ID,
  CONFIG,
  FINALIZING_PIPELINE_IDS,
  INTEGRATION_RECOVERY_BLOCKED_ROOTS,
  PIPELINE_RUNS,
  QUEUE_JOBS,
  activatePipelineBatch,
  assert,
  closeDb,
  enqueueQueueJob,
  heartbeatKnownQueueState,
  mkdir,
  openLockDb,
  persistPipelineRecord,
  persistQueueRecord,
  randomBytes,
  readPersistedPipelineRecord,
  readPersistedQueueRecord,
  reconcileStaleQueueRecords,
  resolveProjectStateRoot,
  runCommand,
  startQueueRecord,
} = __selfTest.internals;

const stateDir = path.join(sandbox, "state");
const repoInput = path.join(sandbox, "repo");
await mkdir(stateDir, { recursive: true });
await mkdir(path.join(repoInput, "src"), { recursive: true });
assert.equal((await runCommand("git", ["init", "-q"], repoInput, 1000 * 30)).exitCode, 0);
const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
const initialQueueMode = selfTestHooks.queueModeOverride;
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";
const repo = await resolveProjectStateRoot(repoInput);

const pastIso = () => new Date(Date.now() - 5000).toISOString();

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
  await withDb((db) => {
    for (const table of ["opencode_pipeline_children", "opencode_jobs", "opencode_pipelines", "integration_operation_files", "integration_operations", "locks"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
}

let recordCounter = 0;
function makeRecord(overrides = {}) {
  recordCounter += 1;
  const jobId = overrides.jobId || `review2-f-${recordCounter}-${randomBytes(4).toString("hex")}`;
  const mode = overrides.mode || "read";
  const now = new Date().toISOString();
  return {
    jobId,
    parentJobId: "",
    cwd: repo,
    agent: mode === "read" ? "reviewer" : "builder",
    task: "Review 2 area F regression",
    request: { agent: mode === "read" ? "reviewer" : "builder", task: "Review 2 area F regression", cwd: repo },
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

async function jobRow(jobId) {
  return await withDb((db) => db.prepare("SELECT * FROM opencode_jobs WHERE job_id = ?").get(jobId));
}

async function runWorker(record) {
  assert.equal(await startQueueRecord(record), true, "the claim must succeed");
  await record.executionPromise;
}

function noChangeExecution() {
  return {
    response: { content: [{ type: "text", text: "No changes were needed." }] },
    result: { errorType: "", changedFiles: [], noChanges: true, worktree: { patchSha256: "" } },
    validation: null,
    worktree: null,
  };
}

async function makePipeline(overrides = {}) {
  const createdAt = new Date().toISOString();
  const record = {
    pipelineId: `review2-f-pipeline-${randomBytes(4).toString("hex")}`,
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

// A running pipeline with one released child, built through the real activation path.
async function makeRunningPipelineWithChild() {
  const pipeline = await makePipeline();
  const enqueued = await enqueueQueueJob(pipeline.jobs[0], pipeline.pipelineId, { schedule: false, initialStatus: "held", persist: false });
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const activated = await activatePipelineBatch(pipeline, [enqueued.record]);
  assert.equal(activated.ok, true, JSON.stringify(activated));
  return { pipeline, child: enqueued.record };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ---- R-156: noChanges writers are completed ----

test("R-156 a writer that changed nothing (noChanges) stays completed", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => noChangeExecution();
  await runWorker(record);
  const row = await jobRow(record.jobId);
  const persisted = await readPersistedQueueRecord(record.jobId, repo);
  assert.equal(row.status, "completed", `durable status ${row.status} (${persisted?.errorType})`);
  assert.equal(record.status, "completed", `in-memory status ${record.status} (${record.errorType})`);
  assert.equal(persisted.errorType, "");
  assert.equal(persisted.noChanges, true);
});

test("R-156 a writer without noChanges and without change evidence still fails", async () => {
  const record = await persistedRecord({ mode: "write", status: "planned" });
  selfTestHooks.queueJobExecutorTestHook = async () => {
    const execution = noChangeExecution();
    execution.result.noChanges = false;
    return execution;
  };
  await runWorker(record);
  const persisted = await readPersistedQueueRecord(record.jobId, repo);
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.errorType, "write_completion_evidence_missing");
});

test("R-156 a noChanges writer does not fail its pipeline", async () => {
  const { pipeline, child } = await makeRunningPipelineWithChild();
  Object.assign(child, { mode: "write", agent: "builder", lockMode: "write", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
  selfTestHooks.queueJobExecutorTestHook = async () => noChangeExecution();
  await runWorker(child);
  const persistedChild = await readPersistedQueueRecord(child.jobId, repo);
  assert.equal(persistedChild.status, "completed", `child ${persistedChild.status} (${persistedChild.errorType})`);
  const parent = await readPersistedPipelineRecord(pipeline.pipelineId, repo);
  assert.notEqual(parent.status, "failed", "a successful no-op writer must not fail the pipeline");
});

// ---- R-157: an abandoned child is reconciled while the parent pipeline keeps the instance alive ----

test("R-157 a child whose terminal writes all failed is reconciled and ends its pipeline", async () => {
  const { pipeline, child } = await makeRunningPipelineWithChild();
  let terminalWrites = 0;
  selfTestHooks.queueJobExecutorTestHook = async () => ({
    response: { content: [{ type: "text", text: "Child work complete." }] },
    result: { errorType: "", changedFiles: [] },
    validation: null,
    worktree: null,
  });
  selfTestHooks.queuePersistTestHook = async (candidate) => {
    if (candidate.jobId === child.jobId && ["completed", "failed"].includes(candidate.status)) {
      terminalWrites += 1;
      throw new Error("forced terminal persistence failure");
    }
  };
  await runWorker(child);
  selfTestHooks.queuePersistTestHook = null;
  assert.ok(terminalWrites > 1, "every terminal write attempt was refused");
  assert.equal(QUEUE_JOBS.has(child.jobId), false, "the abandoned worker left memory");
  assert.equal((await jobRow(child.jobId)).status, "running", "the durable row is still claimed");
  assert.ok(PIPELINE_RUNS.has(pipeline.pipelineId), "the parent pipeline is still driven by this bridge");

  // The child's own lease lapses (nothing renews it any more); the bridge instance lease is
  // renewed by this very heartbeat because the pipeline is still tracked.
  await withDb((db) => db.prepare("UPDATE opencode_jobs SET lease_expires_at = ? WHERE job_id = ?").run(pastIso(), child.jobId));
  heartbeatKnownQueueState();

  const row = await jobRow(child.jobId);
  assert.equal(row.status, "interrupted", `the orphaned child stayed ${row.status}`);
  const bridge = await withDb((db) => db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(BRIDGE_INSTANCE_ID));
  assert.ok(Date.parse(bridge.lease_expires_at) > Date.now(), "the bridge instance lease is fresh");
  const parent = await readPersistedPipelineRecord(pipeline.pipelineId, repo);
  assert.equal(parent.status, "failed", `the pipeline stayed ${parent.status} behind an orphaned child`);
});

test("R-157 a live job of another live instance is still not reconciled", async () => {
  const record = await persistedRecord({ status: "running", startedAt: new Date().toISOString() });
  await withDb((db) => {
    db.prepare("UPDATE opencode_jobs SET owner_instance_id = 'other-live-instance', lease_expires_at = ? WHERE job_id = ?").run(pastIso(), record.jobId);
    db.prepare("INSERT OR REPLACE INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("other-live-instance", process.pid, new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
  });
  // Something to heartbeat so the pass reaches this database.
  const tracked = await persistedRecord({ status: "pending" });
  QUEUE_JOBS.set(tracked.jobId, tracked);
  heartbeatKnownQueueState();
  assert.equal((await jobRow(record.jobId)).status, "running", "another live instance's job must be left alone");
});

test("R-157 a job this bridge still tracks is not reconciled by its own lapsed lease", async () => {
  const record = await persistedRecord({ status: "running", startedAt: new Date().toISOString() });
  QUEUE_JOBS.set(record.jobId, record);
  await withDb((db) => db.prepare("UPDATE opencode_jobs SET lease_expires_at = ? WHERE job_id = ?").run(pastIso(), record.jobId));
  const reconciled = await withDb((db) => reconcileStaleQueueRecords(db, Date.now()));
  assert.deepEqual(reconciled, []);
  assert.equal((await jobRow(record.jobId)).status, "running");
});

// ---- R-158: state-audit --strict knows the finalizing status ----

test("R-158 state-audit --strict fails on an expired finalizing pipeline", async () => {
  const auditRoot = path.join(sandbox, "audit-state");
  await mkdir(path.join(auditRoot, "projects"), { recursive: true });
  const db = new DatabaseSync(path.join(auditRoot, "projects", "fixture.sqlite"));
  try {
    db.exec(`
      CREATE TABLE bridge_instances (instance_id TEXT PRIMARY KEY, lease_expires_at TEXT NOT NULL);
      CREATE TABLE opencode_pipelines (pipeline_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_instance_id TEXT, owner_lease_expires_at TEXT);
    `);
    db.prepare("INSERT INTO opencode_pipelines VALUES (?, ?, ?, ?)").run("stuck-finalizing", "finalizing", "gone-owner", pastIso());
  } finally {
    db.close();
  }
  const report = await auditStateDirectory(auditRoot);
  assert.deepEqual(report.databases[0].activeExpiredPipelines.map((row) => row.id), ["stuck-finalizing"]);
  assert.equal(report.summary.expiredActivePipelines, 1);
  assert.equal(auditHasFailures(report, false), false, "a non-strict audit only fails on corruption");
  assert.equal(auditHasFailures(report, true), true, "a strict audit fails on the stuck finalization");
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
      console.log(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 4).join("\n     ")}`);
    }
  }
  await resetState().catch(() => {});
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  selfTestHooks.queueModeOverride = initialQueueMode;
  await rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
}
console.log(failed ? `${failed} of ${cases.length} review2-f tests failed.` : `All ${cases.length} review2-f tests passed.`);
process.exit(failed ? 1 : 0);
