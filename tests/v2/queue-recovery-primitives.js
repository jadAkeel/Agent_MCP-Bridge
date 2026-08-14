import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

import { createQueueRecordCodec } from "../../src/v2/persistence/queue-record-codec.js";
import { createQueueRecoveryPrimitives } from "../../src/v2/persistence/queue-recovery-primitives.js";
import { sanitizePersistedValue } from "../../src/v2/security/redaction.js";

const NOW = Date.parse("2026-08-14T08:00:00.000Z");
const OLD = new Date(NOW - 120_000).toISOString();
const EXPIRED = new Date(NOW - 1_000).toISOString();
const FUTURE = new Date(NOW + 120_000).toISOString();
const CONFIG = Object.freeze({ queueStaleAfterMs: 60_000 });
const BRIDGE_INSTANCE_ID = "queue-recovery-test-instance";

const idle = createQueueRecoveryPrimitives({
  config: CONFIG,
  queueJobs: new Map(),
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  persistedQueueRecordFromRow: () => { throw new Error("must remain lazy"); },
  sanitizePersistedValue: () => { throw new Error("must remain lazy"); },
});
assert.deepEqual(Object.keys(idle), [
  "reconcileStaleQueueRecords",
  "processIsAlive",
  "renewPersistedQueueRecordLease",
]);

const processSignals = [];
const events = [];
const codec = createQueueRecordCodec({ config: { queueResultMaxChars: 64 } });
const queueJobs = new Map([["in-memory", { jobId: "in-memory" }]]);
const recovery = createQueueRecoveryPrimitives({
  config: CONFIG,
  queueJobs,
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  persistedQueueRecordFromRow: codec.persistedQueueRecordFromRow,
  sanitizePersistedValue,
  logEvent: (level, event, data) => events.push({ level, event, data }),
  clockNow: () => NOW,
  processKill(pid, signal) {
    processSignals.push([pid, signal]);
    if (pid !== 4242) throw new Error("not alive");
  },
});

assert.equal(recovery.processIsAlive(0), false);
assert.equal(recovery.processIsAlive(-1), false);
assert.equal(recovery.processIsAlive(1.5), false);
assert.equal(recovery.processIsAlive(4242), true);
assert.equal(recovery.processIsAlive(9999), false);
assert.deepEqual(processSignals, [[4242, 0], [9999, 0]]);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE opencode_jobs (
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
    CREATE TABLE bridge_instances (
      instance_id TEXT PRIMARY KEY,
      process_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );
  `);

  const insert = db.prepare(`
    INSERT INTO opencode_jobs
      (job_id, cwd, status, agent, mode, created_at, started_at, record_json,
       owner_instance_id, owner_process_id, owner_generation, heartbeat_at, lease_expires_at,
       cancellation_requested_at, child_process_id, child_process_started_at, revision, request_encrypted)
    VALUES (?, 'C:/fixture', ?, 'reviewer', 'read', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const add = ({
    jobId,
    status = "pending",
    createdAt = OLD,
    startedAt = "",
    recordJson = JSON.stringify({ jobId, status, createdAt }),
    ownerInstanceId = "",
    ownerProcessId = 0,
    ownerGeneration = "",
    heartbeatAt = "",
    leaseExpiresAt = "",
    cancellationRequestedAt = "",
    childProcessId = 0,
    childProcessStartedAt = "",
    revision = 0,
    requestEncrypted = "",
  }) => insert.run(
    jobId,
    status,
    createdAt,
    startedAt,
    recordJson,
    ownerInstanceId,
    ownerProcessId,
    ownerGeneration,
    heartbeatAt,
    leaseExpiresAt,
    cancellationRequestedAt,
    childProcessId,
    childProcessStartedAt,
    revision,
    requestEncrypted
  );

  add({ jobId: "in-memory" });
  add({ jobId: "encrypted", requestEncrypted: "encrypted-request" });
  add({ jobId: "recent", createdAt: new Date(NOW).toISOString() });
  add({ jobId: "stale-invalid", recordJson: "null" });
  add({
    jobId: "active-expired",
    status: "running",
    startedAt: OLD,
    ownerInstanceId: "dead-instance",
    ownerProcessId: 111,
    ownerGeneration: "generation-active",
    heartbeatAt: OLD,
    leaseExpiresAt: EXPIRED,
    childProcessId: 4242,
    childProcessStartedAt: OLD,
  });
  add({
    jobId: "cancelled-expired",
    status: "testing",
    startedAt: OLD,
    ownerInstanceId: "dead-instance",
    ownerProcessId: 222,
    ownerGeneration: "generation-cancelled",
    heartbeatAt: OLD,
    leaseExpiresAt: EXPIRED,
    cancellationRequestedAt: OLD,
  });
  add({
    jobId: "job-lease-live",
    status: "running",
    ownerInstanceId: "dead-instance",
    ownerGeneration: "generation-live-job",
    heartbeatAt: OLD,
    leaseExpiresAt: FUTURE,
  });
  add({
    jobId: "instance-lease-live",
    status: "running",
    ownerInstanceId: "live-instance",
    ownerGeneration: "generation-live-instance",
    heartbeatAt: OLD,
    leaseExpiresAt: EXPIRED,
  });
  db.prepare(`
    INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
    VALUES ('live-instance', 333, ?, ?, ?)
  `).run(OLD, OLD, FUTURE);

  assert.deepEqual(new Set(recovery.reconcileStaleQueueRecords(db)), new Set([
    "stale-invalid",
    "active-expired",
    "cancelled-expired",
  ]));
  assert.deepEqual(events, [{
    level: "warn",
    event: "queue.orphaned_records_reconciled",
    data: {
      count: 3,
      jobIds: ["stale-invalid", "active-expired", "cancelled-expired"],
    },
  }]);

  const stale = db.prepare("SELECT status, record_json FROM opencode_jobs WHERE job_id = 'stale-invalid'").get();
  assert.equal(stale.status, "not_resumable");
  assert.equal(JSON.parse(stale.record_json).jobId, "stale-invalid");
  assert.equal(JSON.parse(stale.record_json).errorType, "queue_job_not_resumable");

  const active = JSON.parse(db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = 'active-expired'").get().record_json);
  assert.equal(active.status, "interrupted");
  assert.equal(active.orphanChildProcessAlive, true);
  assert.equal(active.orphanChildProcessId, 4242);
  assert.equal(active.orphanChildProcessStartedAt, OLD);
  assert.match(active.errorReason, /retained its identity/);
  assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id = 'cancelled-expired'").get().status, "cancelled");
  assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id = 'job-lease-live'").get().status, "running");
  assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id = 'instance-lease-live'").get().status, "running");
  assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id = 'in-memory'").get().status, "pending");
  assert.equal(db.prepare("SELECT status FROM opencode_jobs WHERE job_id = 'encrypted'").get().status, "pending");

  add({
    jobId: "renewable",
    ownerInstanceId: BRIDGE_INSTANCE_ID,
    ownerGeneration: "renew-generation",
    revision: 2,
  });
  const renewable = {
    jobId: "renewable",
    ownerGeneration: "renew-generation",
    heartbeatAt: "",
    leaseExpiresAt: "",
    revision: 2,
  };
  assert.equal(recovery.renewPersistedQueueRecordLease(db, renewable, "heartbeat-new", "lease-new"), true);
  assert.deepEqual(renewable, {
    jobId: "renewable",
    ownerGeneration: "renew-generation",
    heartbeatAt: "heartbeat-new",
    leaseExpiresAt: "lease-new",
    revision: 3,
  });
  assert.deepEqual(
    { ...db.prepare("SELECT heartbeat_at, lease_expires_at, revision FROM opencode_jobs WHERE job_id = 'renewable'").get() },
    { heartbeat_at: "heartbeat-new", lease_expires_at: "lease-new", revision: 3 }
  );

  const foreign = { ...renewable, ownerGeneration: "foreign", heartbeatAt: "local-heartbeat" };
  assert.equal(recovery.renewPersistedQueueRecordLease(db, foreign, "ignored", "ignored"), false);
  assert.equal(foreign.heartbeatAt, "local-heartbeat");
  assert.equal(foreign.revision, 3);
} finally {
  db.close();
}

console.log("V2 queue recovery primitive tests passed.");
