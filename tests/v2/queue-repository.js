import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createQueueRecordCodec } from "../../src/v2/persistence/queue-record-codec.js";
import { createQueueRepository } from "../../src/v2/persistence/queue-repository.js";
import { closeDb } from "../../src/v2/persistence/sqlite-utils.js";

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "queue-repository-worker.js");
const BRIDGE_INSTANCE_ID = "queue-repository-test-instance";
const CONFIG = Object.freeze({ queueLeaseMs: 60_000, queueResultMaxChars: 64 });
const FIXED_NOW = Date.parse("2026-08-13T20:00:00.000Z");

function initializeDb(db) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS opencode_jobs (
      job_id TEXT PRIMARY KEY,
      cwd TEXT,
      status TEXT NOT NULL,
      agent TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      record_json TEXT NOT NULL,
      owner_instance_id TEXT,
      owner_process_id INTEGER,
      owner_generation TEXT,
      updated_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      cancellation_requested_at TEXT,
      child_process_id INTEGER,
      child_process_started_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      request_encrypted TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS opencode_jobs_idempotency_idx
      ON opencode_jobs (idempotency_key)
      WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
  `);
  return db;
}

function createOpener(stateDirectory, observations = []) {
  const dbPath = path.join(stateDirectory, "queue-repository.sqlite");
  mkdirSync(stateDirectory, { recursive: true });
  return {
    dbPath,
    openLockDb: async (cwd = "") => {
      observations.push(cwd);
      return initializeDb(new DatabaseSync(dbPath));
    },
  };
}

function createRecord(cwd, overrides = {}) {
  const jobId = overrides.jobId || `job-${Math.random().toString(16).slice(2)}`;
  return {
    jobId,
    parentJobId: "",
    idempotencyKey: "",
    requestFingerprint: `fingerprint-${jobId}`,
    requestEncrypted: `envelope-${jobId}`,
    agent: "build",
    task: `sensitive task ${jobId}`,
    cwd,
    mode: "read",
    lockMode: "read",
    lockedPaths: [],
    allowedEdits: [],
    status: "pending",
    createdAt: "2026-08-13T19:00:00.000Z",
    startedAt: "",
    finishedAt: "",
    ownerInstanceId: BRIDGE_INSTANCE_ID,
    ownerProcessId: 111,
    ownerGeneration: `generation-${jobId}`,
    heartbeatAt: "",
    leaseExpiresAt: "",
    cancellationRequested: false,
    cancellationRequestedAt: "",
    childProcessId: 0,
    childProcessStartedAt: "",
    revision: 0,
    resultText: "",
    changedFiles: [],
    ...overrides,
  };
}

function createRepository(stateDirectory, dependencies = {}) {
  const observations = dependencies.observations || [];
  const { dbPath, openLockDb } = createOpener(stateDirectory, observations);
  const codec = createQueueRecordCodec({ config: CONFIG });
  let queueMode = dependencies.queueMode || "sqlite";
  const repository = createQueueRepository({
    config: CONFIG,
    effectiveQueueMode: () => queueMode,
    openLockDb,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    getProcessId: () => 4242,
    clockNow: () => FIXED_NOW,
    randomBytes: () => Buffer.alloc(12, 0xab),
    ...codec,
    ...dependencies,
    observations: undefined,
    queueMode: undefined,
  });
  return {
    dbPath,
    observations,
    repository,
    setQueueMode(value) { queueMode = value; },
  };
}

async function withTemporaryState(run) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codex-queue-repository-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const projectRoot = path.join(temporaryRoot, "project");
  mkdirSync(projectRoot, { recursive: true });
  try {
    await run({ temporaryRoot, stateDirectory, projectRoot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

function waitForWorkerMessage(child, predicate, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for queue-repository worker. stderr: ${stderr}`)), timeoutMs);
    const onStderr = (chunk) => { stderr += String(chunk); };
    const onMessage = (message) => {
      if (message?.type === "error") finish(new Error(message.error));
      else if (predicate(message)) finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(`Queue-repository worker exited early (code=${code}, signal=${signal}). stderr: ${stderr}`));
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stderr?.off("data", onStderr);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    child.stderr?.on("data", onStderr);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function startWorker(dbPath, record) {
  return fork(workerPath, [
    dbPath,
    BRIDGE_INSTANCE_ID,
    Buffer.from(JSON.stringify(record)).toString("base64url"),
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

let idleOpenCalls = 0;
const idleRepository = createQueueRepository({
  config: CONFIG,
  effectiveQueueMode: () => "memory",
  openLockDb: async () => {
    idleOpenCalls += 1;
    throw new Error("must not open");
  },
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  queueRecordSnapshot: (record) => ({ ...record }),
  enforceQueueResultEvidence: (record) => record,
  loadPersistedQueueRecord: (record) => record,
});
assert.equal(idleOpenCalls, 0, "Constructing the repository must not open persistent state.");
assert.deepEqual(Object.keys(idleRepository), [
  "stampPersistedQueueCancellation",
  "persistTerminalQueueRecord",
  "persistQueueRecord",
  "updateQueueRecordDurable",
  "persistedRunningQueueRecords",
  "claimQueueRecord",
  "readPersistedQueueRecord",
  "listPersistedQueueRecords",
]);

const memoryRecord = createRecord("memory", { revision: 4 });
assert.deepEqual(await idleRepository.persistQueueRecord(memoryRecord), { persisted: true, status: "pending" });
assert.equal(memoryRecord.revision, 5);
assert.deepEqual(await idleRepository.persistedRunningQueueRecords("memory"), []);
assert.equal(await idleRepository.readPersistedQueueRecord("missing", "memory"), null);
assert.deepEqual(await idleRepository.listPersistedQueueRecords("memory"), []);
assert.equal(idleOpenCalls, 0, "Memory mode must not open SQLite.");

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { observations, repository, setQueueMode } = createRepository(stateDirectory, { queueMode: "memory" });
  const record = createRecord(projectRoot, { jobId: "dynamic-mode", ownerGeneration: "" });
  assert.deepEqual(await repository.claimQueueRecord(record), { ok: true });
  assert.equal(record.ownerGeneration, "abababababababababababab");
  assert.equal(record.ownerProcessId, 4242);
  assert.equal(record.leaseExpiresAt, "2026-08-13T20:01:00.000Z");
  assert.deepEqual(observations, [], "Memory mode must remain state-free.");

  setQueueMode("sqlite");
  const persisted = createRecord(projectRoot, { jobId: "dynamic-mode-sqlite" });
  assert.equal((await repository.persistQueueRecord(persisted)).persisted, true);
  assert.deepEqual(observations, [projectRoot], "The queue-mode dependency must be evaluated per operation.");
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { dbPath, observations, repository } = createRepository(stateDirectory);
  const first = createRecord(projectRoot, {
    jobId: "inserted",
    idempotencyKey: "idempotency-inserted",
    requestFingerprint: "fingerprint-one",
    createdAt: "2026-08-13T19:00:00.000Z",
  });
  assert.deepEqual(await repository.persistQueueRecord(first), { persisted: true, status: "pending", revision: 0 });
  assert.deepEqual(observations, [projectRoot]);

  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT * FROM opencode_jobs WHERE job_id = ?").get(first.jobId);
    assert.equal(row.cwd, projectRoot);
    assert.equal(row.status, "pending");
    assert.equal(row.owner_instance_id, BRIDGE_INSTANCE_ID);
    assert.equal(row.owner_process_id, 111);
    assert.equal(row.owner_generation, first.ownerGeneration);
    assert.equal(row.updated_at, "2026-08-13T20:00:00.000Z");
    assert.equal(row.request_encrypted, first.requestEncrypted);
    assert.equal(row.idempotency_key, first.idempotencyKey);
    assert.equal(row.revision, 0);
    assert.doesNotMatch(row.record_json, /sensitive task inserted/);

    db.prepare(`
      UPDATE opencode_jobs SET
        status = 'validating', finished_at = 'authoritative-finished', heartbeat_at = 'authoritative-heartbeat',
        lease_expires_at = 'authoritative-lease', cancellation_requested_at = 'authoritative-cancel',
        child_process_id = 99, child_process_started_at = 'authoritative-child-start', revision = 7
      WHERE job_id = ?
    `).run(first.jobId);
  } finally {
    closeDb(db);
  }

  const read = await repository.readPersistedQueueRecord(first.jobId, projectRoot);
  assert.equal(read.status, "validating");
  assert.equal(read.finishedAt, "authoritative-finished");
  assert.equal(read.heartbeatAt, "authoritative-heartbeat");
  assert.equal(read.leaseExpiresAt, "authoritative-lease");
  assert.equal(read.cancellationRequested, true);
  assert.equal(read.cancellationRequestedAt, "authoritative-cancel");
  assert.equal(read.childProcessId, 99);
  assert.equal(read.childProcessStartedAt, "authoritative-child-start");
  assert.equal(read.revision, 7);

  const runningBeforeMalformed = await repository.persistedRunningQueueRecords(projectRoot);
  assert.equal(runningBeforeMalformed.length, 1);
  assert.equal(runningBeforeMalformed[0].jobId, first.jobId);
  assert.equal(runningBeforeMalformed[0].status, "pending", "Running-row enumeration intentionally returns the stored JSON snapshot.");

  const second = createRecord(projectRoot, {
    jobId: "newer",
    createdAt: "2026-08-13T21:00:00.000Z",
    status: "blocked",
  });
  assert.equal((await repository.persistQueueRecord(second)).persisted, true);
  const listed = await repository.listPersistedQueueRecords(projectRoot);
  assert.deepEqual(listed.map((record) => record.jobId), ["newer", "inserted"]);
  assert.deepEqual((await repository.listPersistedQueueRecords(projectRoot, "blocked")).map((record) => record.jobId), ["newer"]);
  assert.equal(await repository.readPersistedQueueRecord("missing", projectRoot), null);

  const malformedDb = new DatabaseSync(dbPath);
  try {
    malformedDb.prepare(`
      INSERT INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, record_json, owner_instance_id, owner_generation, revision)
      VALUES (?, ?, 'running', 'build', 'read', ?, '{malformed', ?, 'generation-malformed', 0)
    `).run("malformed", projectRoot, "2026-08-13T22:00:00.000Z", BRIDGE_INSTANCE_ID);
  } finally {
    closeDb(malformedDb);
  }
  const running = await repository.persistedRunningQueueRecords(projectRoot);
  assert.equal(running.some((record) => record.jobId === "malformed"), false, "Unreadable running snapshots must be skipped.");
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { repository } = createRepository(stateDirectory);
  const original = createRecord(projectRoot, {
    jobId: "idempotency-original",
    idempotencyKey: "shared-key",
    requestFingerprint: "same-fingerprint",
  });
  assert.equal((await repository.persistQueueRecord(original)).persisted, true);

  const duplicate = createRecord(projectRoot, {
    jobId: "idempotency-duplicate",
    idempotencyKey: "shared-key",
    requestFingerprint: "same-fingerprint",
  });
  assert.deepEqual(await repository.persistQueueRecord(duplicate), {
    persisted: true,
    deduplicated: true,
    jobId: original.jobId,
  });

  const conflict = createRecord(projectRoot, {
    jobId: "idempotency-conflict",
    idempotencyKey: "shared-key",
    requestFingerprint: "different-fingerprint",
  });
  assert.deepEqual(await repository.persistQueueRecord(conflict), {
    persisted: false,
    idempotencyConflict: true,
    jobId: original.jobId,
  });

  const stored = await repository.listPersistedQueueRecords(projectRoot);
  assert.deepEqual(stored.map((record) => record.jobId), [original.jobId]);
});

for (const [existingFingerprint, expected, finalTransaction] of [
  ["race-fingerprint", { persisted: true, deduplicated: true, jobId: "race-winner" }, "COMMIT"],
  ["different-fingerprint", { persisted: false, idempotencyConflict: true, jobId: "race-winner" }, "ROLLBACK"],
]) {
  let idempotencyReads = 0;
  let closeCalls = 0;
  const transactions = [];
  const fakeDb = {
    exec(statement) { transactions.push(statement); },
    prepare(statement) {
      if (/SELECT status, started_at/.test(statement)) return { get: () => null };
      if (statement === "SELECT job_id, record_json FROM opencode_jobs WHERE idempotency_key = ?") {
        return {
          get() {
            idempotencyReads += 1;
            return idempotencyReads === 1
              ? undefined
              : { job_id: "race-winner", record_json: JSON.stringify({ requestFingerprint: existingFingerprint }) };
          },
        };
      }
      if (/INSERT INTO opencode_jobs/.test(statement)) {
        return { run() { throw new Error("UNIQUE constraint failed: opencode_jobs.idempotency_key"); } };
      }
      throw new Error(`Unexpected SQL in unique-race fixture: ${statement}`);
    },
  };
  const repository = createQueueRepository({
    config: CONFIG,
    effectiveQueueMode: () => "sqlite",
    openLockDb: async () => fakeDb,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    queueRecordSnapshot: (record) => ({ requestFingerprint: record.requestFingerprint }),
    enforceQueueResultEvidence: (record) => record,
    loadPersistedQueueRecord: (record) => record,
    closeDb: () => { closeCalls += 1; },
  });
  const raced = createRecord("race", {
    jobId: `unique-race-${finalTransaction.toLowerCase()}`,
    idempotencyKey: "race-key",
    requestFingerprint: "race-fingerprint",
  });
  assert.deepEqual(await repository.persistQueueRecord(raced), expected);
  assert.equal(idempotencyReads, 2, "The UNIQUE fallback must reload the winning idempotency row.");
  assert.deepEqual(transactions, ["BEGIN IMMEDIATE", finalTransaction]);
  assert.equal(closeCalls, 1);
}

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { dbPath, repository } = createRepository(stateDirectory);
  const current = createRecord(projectRoot, { jobId: "cas-record" });
  assert.equal((await repository.persistQueueRecord(current)).persisted, true);

  const stale = structuredClone(current);
  assert.deepEqual(await repository.updateQueueRecordDurable(current, { status: "planned" }), {
    persisted: true,
    status: "planned",
    revision: 1,
  });
  assert.equal(current.revision, 1);

  const staleResult = await repository.updateQueueRecordDurable(stale, { status: "blocked" });
  assert.deepEqual(staleResult, { persisted: false, status: "planned", revision: 1 });
  assert.equal(stale.status, "planned", "A lost CAS must reload the authoritative row.");
  assert.equal(stale.revision, 1);

  const foreignOwner = structuredClone(current);
  foreignOwner.ownerGeneration = "foreign-generation";
  const foreignResult = await repository.updateQueueRecordDurable(foreignOwner, { status: "blocked" });
  assert.deepEqual(foreignResult, { persisted: false, status: "planned", revision: 1 });
  assert.equal(foreignOwner.ownerGeneration, current.ownerGeneration, "A foreign owner must receive authoritative owner evidence.");

  const claimed = await repository.claimQueueRecord(current);
  assert.deepEqual(claimed, { ok: true });
  assert.equal(current.status, "running");
  assert.equal(current.startedAt, "2026-08-13T20:00:00.000Z");
  assert.equal(current.heartbeatAt, "2026-08-13T20:00:00.000Z");
  assert.equal(current.leaseExpiresAt, "2026-08-13T20:01:00.000Z");
  assert.equal(current.ownerProcessId, 4242);
  assert.equal(current.revision, 2);

  const staleClaim = await repository.claimQueueRecord(stale);
  assert.deepEqual(staleClaim, { ok: false, status: "running" });

  const cancellationAt = "2026-08-13T20:00:30.000Z";
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE opencode_jobs SET cancellation_requested_at = ? WHERE job_id = ?").run(cancellationAt, current.jobId);
  } finally {
    closeDb(db);
  }
  const terminal = await repository.updateQueueRecordDurable(current, {
    status: "completed",
    finishedAt: "2026-08-13T20:00:45.000Z",
    resultText: "verified final response",
  });
  assert.deepEqual(terminal, { persisted: true, status: "cancelled", cancellationWon: true });
  assert.equal(current.status, "cancelled");
  assert.equal(current.cancellationRequested, true);
  assert.equal(current.cancellationRequestedAt, cancellationAt);
  assert.equal(current.errorType, "agent_cancelled");
  assert.equal(current.errorReason, "Cancellation won the durable terminal-write race.");
  assert.equal(current.heartbeatAt, "");
  assert.equal(current.leaseExpiresAt, "");
  assert.equal(current.revision, 3);
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { dbPath, repository } = createRepository(stateDirectory);
  const pending = createRecord(projectRoot, { jobId: "pre-execution-cancellation" });
  assert.equal((await repository.persistQueueRecord(pending)).persisted, true);
  const cancellationAt = "2026-08-13T20:00:15.000Z";
  const laterCancellationAt = "2026-08-13T20:00:16.000Z";
  let terminal;
  const db = new DatabaseSync(dbPath);
  try {
    const initialCancellation = repository.stampPersistedQueueCancellation(db, {
      jobId: pending.jobId,
      status: pending.status,
      requestedAt: cancellationAt,
      recordJson: JSON.stringify({ ...pending, cancellationRequestedAt: cancellationAt }),
    });
    assert.equal(Number(initialCancellation.changes || 0), 1);
    repository.stampPersistedQueueCancellation(db, {
      jobId: pending.jobId,
      status: pending.status,
      requestedAt: laterCancellationAt,
      recordJson: JSON.stringify({ ...pending, cancellationRequestedAt: laterCancellationAt }),
    });
    const stamped = db.prepare("SELECT cancellation_requested_at, record_json FROM opencode_jobs WHERE job_id = ?").get(pending.jobId);
    assert.equal(stamped.cancellation_requested_at, cancellationAt, "The first durable cancellation timestamp must win.");
    assert.equal(JSON.parse(stamped.record_json).cancellationRequestedAt, laterCancellationAt, "Legacy JSON replacement behavior remains exact for compatibility.");
    pending.status = "failed";
    terminal = repository.persistTerminalQueueRecord(db, pending);
  } finally {
    closeDb(db);
  }
  assert.deepEqual(terminal, { persisted: true, status: "cancelled", cancellationWon: true });
  assert.equal(pending.status, "cancelled");
  assert.equal(pending.finishedAt, "2026-08-13T20:00:00.000Z");
  assert.equal(pending.errorType, "agent_cancelled");
  assert.equal(pending.errorReason, "Cancellation won before queue execution.");

  const cancelledClaim = await repository.claimQueueRecord(pending);
  assert.deepEqual(cancelledClaim, { ok: false, status: "cancelled" });
  assert.equal(pending.cancellationRequestedAt, cancellationAt);

  const missing = createRecord(projectRoot, { jobId: "missing-claim" });
  assert.deepEqual(await repository.claimQueueRecord(missing), { ok: false, status: "missing" });
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { repository } = createRepository(stateDirectory);
  const completedWithoutEvidence = createRecord(projectRoot, {
    jobId: "completion-evidence",
    resultText: "",
  });
  assert.equal((await repository.persistQueueRecord(completedWithoutEvidence)).persisted, true);
  const result = await repository.updateQueueRecordDurable(completedWithoutEvidence, { status: "completed" });
  assert.deepEqual(result, { persisted: true, status: "failed", cancellationWon: false });
  assert.equal(completedWithoutEvidence.status, "failed");
  assert.equal(completedWithoutEvidence.errorType, "completion_evidence_missing");
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { repository } = createRepository(stateDirectory);
  const completed = createRecord(projectRoot, { jobId: "successful-terminal" });
  assert.equal((await repository.persistQueueRecord(completed)).persisted, true);
  assert.deepEqual(await repository.claimQueueRecord(completed), { ok: true });
  const terminal = await repository.updateQueueRecordDurable(completed, {
    status: "completed",
    finishedAt: "2026-08-13T20:00:30.000Z",
    resultText: "verified final response",
  });
  assert.deepEqual(terminal, { persisted: true, status: "completed", cancellationWon: false });
  assert.equal(completed.revision, 2);
  const stored = await repository.readPersistedQueueRecord(completed.jobId, projectRoot);
  assert.equal(stored.status, "completed");
  assert.equal(stored.resultText, "verified final response");
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const codec = createQueueRecordCodec({ config: CONFIG });
  const { dbPath, openLockDb } = createOpener(stateDirectory);
  let closeCalls = 0;
  const repository = createQueueRepository({
    config: CONFIG,
    effectiveQueueMode: () => "sqlite",
    openLockDb,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    ...codec,
    queueRecordSnapshot: () => { throw new Error("snapshot failed"); },
    closeDb(db) {
      closeCalls += 1;
      closeDb(db);
    },
  });
  await assert.rejects(repository.persistQueueRecord(createRecord(projectRoot, { jobId: "rollback" })), /snapshot failed/);
  assert.equal(closeCalls, 1);
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE job_id = 'rollback'").get().count, 0);
  } finally {
    closeDb(db);
  }
});

await withTemporaryState(async ({ stateDirectory, projectRoot }) => {
  const { dbPath, repository } = createRepository(stateDirectory);
  const record = createRecord(projectRoot, { jobId: "cross-process-claim" });
  assert.equal((await repository.persistQueueRecord(record)).persisted, true);

  const first = startWorker(dbPath, structuredClone(record));
  const second = startWorker(dbPath, structuredClone(record));
  try {
    await Promise.all([
      waitForWorkerMessage(first, (message) => message?.type === "ready"),
      waitForWorkerMessage(second, (message) => message?.type === "ready"),
    ]);
    const firstClaim = waitForWorkerMessage(first, (message) => message?.type === "claimed");
    const secondClaim = waitForWorkerMessage(second, (message) => message?.type === "claimed");
    first.send({ type: "claim" });
    second.send({ type: "claim" });
    const claims = await Promise.all([firstClaim, secondClaim]);
    assert.equal(claims.filter((claim) => claim.result.ok).length, 1, "Exactly one process may claim a durable queue record.");
    assert.equal(claims.filter((claim) => !claim.result.ok && claim.result.status === "running").length, 1);
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill();
    if (second.exitCode === null && second.signalCode === null) second.kill();
  }
  assert.equal((await repository.readPersistedQueueRecord(record.jobId, projectRoot)).status, "running");
});

console.log("V2 queue repository tests passed.");
