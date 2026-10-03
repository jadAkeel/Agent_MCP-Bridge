// Queue leases and state upkeep: stale-record reconciliation, lease renewal and fencing, heartbeats, pruning and state maintenance.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sanitizePersistedValue } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createQueueLeaseRuntime({ BRIDGE_INSTANCE_ID, CONFIG, KNOWN_STATE_DB_PATHS, PIPELINE_RUNS, QUEUE_JOBS, closeDb, effectiveQueueMode, expireLocksFromDb, foreignQueueWorkerPresence = () => null, logEvent, openLockDb, propagatePipelineTerminalInTransaction, scheduleQueueRetryPolicy, stateDbPath, statePruneTimes }) {
let queueHeartbeatTimer = null;
let stateMaintenanceTimer = null;
let stateMaintenanceCursor = 0;

function reconcileStaleQueueRecords(db, now = Date.now()) {
  const nonTerminalStatuses = ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"];
  const placeholders = nonTerminalStatuses.map(() => "?").join(", ");
  const finishedAt = new Date(now).toISOString();
  const reconciled = [];
  const interrupted = [];
  const lockReleases = [];
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const rows = db.prepare(
      `SELECT job_id, cwd, status, created_at, started_at, owner_instance_id, owner_process_id, owner_generation,
              heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id, child_process_started_at,
              request_encrypted, revision, record_json
       FROM opencode_jobs
       WHERE status IN (${placeholders})`
    ).all(...nonTerminalStatuses);
    const update = db.prepare(`
      UPDATE opencode_jobs
      SET status = ?, finished_at = ?, updated_at = ?, heartbeat_at = '', lease_expires_at = '',
          record_json = ?, revision = revision + 1
      WHERE job_id = ? AND status = ? AND revision = ?
        AND (owner_generation = ? OR (owner_generation IS NULL AND ? = ''))
        AND (lease_expires_at IS NULL OR lease_expires_at = '' OR julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)
        AND (owner_instance_id = ? OR NOT EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        ))
    `);

    for (const row of rows) {
      if (QUEUE_JOBS.has(row.job_id)) {
        continue;
      }
      if (["held", "pending", "planned", "blocked"].includes(row.status) && row.request_encrypted) {
        continue;
      }

      let snapshot;
      try {
        snapshot = row.record_json ? JSON.parse(row.record_json) : {};
      } catch {
        snapshot = {};
      }
      const activityAt = Date.parse(
        row.heartbeat_at
        || row.lease_expires_at
        || row.started_at
        || snapshot.startedAt
        || row.created_at
        || snapshot.createdAt
        || ""
      );
      const wasActive = ["running", "validating", "reviewing", "testing"].includes(row.status);
      const cancellationRequested = Boolean(row.cancellation_requested_at || snapshot.cancellationRequestedAt);
      const hasOwner = Boolean(row.owner_instance_id || row.owner_process_id || row.owner_generation);
      const leaseExpiresAt = Date.parse(row.lease_expires_at || snapshot.leaseExpiresAt || "");
      if (hasOwner) {
        if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now) continue;
        if (!Number.isFinite(leaseExpiresAt) && Number.isFinite(activityAt) && now - activityAt < CONFIG.queueStaleAfterMs) continue;
        const instance = row.owner_instance_id
          ? db.prepare("SELECT heartbeat_at, lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(row.owner_instance_id)
          : null;
        const instanceLease = Date.parse(instance?.lease_expires_at || "");
        // A live owner instance covers its jobs, but only another instance is trusted to be
        // running them: QUEUE_JOBS (checked above) is this process's own worker list. A job
        // this instance owns and no longer tracks (its worker was abandoned, e.g. every
        // terminal write failed) was left behind while the instance lease stayed fresh for
        // other work (a parent pipeline, other jobs), so shielding it would keep it, and
        // its parent pipeline, running forever.
        if (Number.isFinite(instanceLease) && instanceLease > now && row.owner_instance_id !== BRIDGE_INSTANCE_ID) continue;
        // Once both durable owner leases have expired, PID liveness cannot prove
        // ownership: operating systems reuse PIDs after crashes. Reconcile the
        // record without killing any process; retain child identity as evidence.
      } else if (Number.isFinite(activityAt) && now - activityAt < CONFIG.queueStaleAfterMs) {
        continue;
      }
      const orphanChildProcessId = Number(row.child_process_id || snapshot.childProcessId || 0);
      const orphanChildProcessAlive = wasActive && processIsAlive(orphanChildProcessId);
      const terminalStatus = cancellationRequested ? "cancelled" : wasActive ? "interrupted" : "not_resumable";
      snapshot = {
        ...snapshot,
        status: terminalStatus,
        finishedAt,
        heartbeatAt: "",
        leaseExpiresAt: "",
        revision: Number(row.revision || 0) + 1,
        errorType: cancellationRequested ? "agent_cancelled" : wasActive ? "queue_job_interrupted" : "queue_job_not_resumable",
        orphanChildProcessId: orphanChildProcessAlive ? orphanChildProcessId : 0,
        orphanChildProcessStartedAt: orphanChildProcessAlive ? (row.child_process_started_at || snapshot.childProcessStartedAt || "") : "",
        orphanChildProcessAlive,
      };
      const changed = update.run(
        terminalStatus,
        finishedAt,
        finishedAt,
        JSON.stringify(sanitizePersistedValue(snapshot)),
        row.job_id,
        row.status,
        Number(row.revision || 0),
        row.owner_generation || "",
        row.owner_generation || "",
        finishedAt,
        BRIDGE_INSTANCE_ID,
        finishedAt
      );
      if (Number(changed.changes || 0) > 0) {
        propagatePipelineTerminalInTransaction(db, row.job_id, terminalStatus, finishedAt);
        reconciled.push(row.job_id);
        if (terminalStatus === "interrupted" && row.request_encrypted) interrupted.push({ jobId: row.job_id, cwd: row.cwd || snapshot.cwd || "" });
        // B-156: the dead owner's hard lock went on holding the job's paths until its TTL (the
        // agent timeout plus a margin, 40 minutes and more), so the retry of this very job was
        // blocked on write_lock_conflict. The lock rows of an interrupted job are released here;
        // a containment quarantine (expires_at = MAX_SAFE_INTEGER) is kept for the recovery pass.
        if (wasActive && snapshot.lockId) {
          const released = releaseQueueJobLocks(db, snapshot.lockId, now);
          if (released) lockReleases.push({ jobId: row.job_id, lockId: snapshot.lockId, paths: released });
        }
      }
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the reconciliation error. */ }
    }
    throw error;
  }

  if (reconciled.length) {
    logEvent("warn", "queue.orphaned_records_reconciled", {
      count: reconciled.length,
      jobIds: reconciled,
      ...(lockReleases.length ? { locksReleased: lockReleases.map((item) => `${item.jobId}:${item.lockId}:${item.paths}`) } : {}),
    });
  }
  // Q-008: a job a restart interrupted is resumed as its next attempt when it has a retry policy
  // (applyQueueRetryPolicy decides; jobs without one stay interrupted for requeue_opencode_job).
  for (const item of interrupted) scheduleQueueRetryPolicy(item.cwd, item.jobId);

  return reconciled;
}

// B-156: inside the reconciliation transaction (same database: the locks table lives next to
// opencode_jobs). Returns the number of lock rows released, or 0 when none (or a quarantine) was
// found; a missing locks table (an old database) releases nothing.
function releaseQueueJobLocks(db, lockId, now = Date.now()) {
  try {
    const removed = db.prepare("DELETE FROM locks WHERE run_id = ? AND expires_at <> ?").run(String(lockId), Number.MAX_SAFE_INTEGER);
    const count = Number(removed.changes || 0);
    if (count > 0) {
      db.prepare(`
        UPDATE runs SET status = 'expired', finished_at = ?
        WHERE run_id = ? AND status = 'running'
          AND NOT EXISTS (SELECT 1 FROM locks WHERE locks.run_id = runs.run_id)
      `).run(now, String(lockId));
    }
    return count;
  } catch (error) {
    logEvent("warn", "queue.interrupted_lock_release_failed", { lockId: String(lockId), error: error?.message || String(error) });
    return 0;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renewPersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt) {
  const renewed = db.prepare(`
    UPDATE opencode_jobs
    SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
    WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ?
      AND lease_expires_at > ?
      AND status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
      AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
      AND EXISTS (
        SELECT 1 FROM bridge_instances
        WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
      )
    RETURNING revision
  `).get(
    heartbeatAt,
    leaseExpiresAt,
    heartbeatAt,
    record.jobId,
    BRIDGE_INSTANCE_ID,
    record.ownerGeneration || "",
    heartbeatAt,
    heartbeatAt
  );
  if (!renewed) return false;
  record.heartbeatAt = heartbeatAt;
  record.leaseExpiresAt = leaseExpiresAt;
  record.revision = Number(renewed.revision || record.revision || 0);
  resetQueueLeaseFence(record);
  return true;
}

const QUEUE_PRE_EXECUTION_STATUSES = ["held", "pending", "planned", "blocked"];

// A lapsed lease (a sleeping laptop, a few failed heartbeats on a busy database) is not lost
// ownership: every takeover writes a new owner generation and every foreign write bumps the
// revision, so an unchanged generation + revision proves nobody else took the row. The
// current owner re-takes its own lease here without the lease predicate; before this, the
// row could never be renewed, claimed or planned again while the bridge lived.
function reacquirePersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt) {
  if (!record?.ownerGeneration) return false;
  const reacquired = db.prepare(`
    UPDATE opencode_jobs
    SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
    WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
      AND revision = ?
      AND status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
      AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
    RETURNING revision
  `).get(
    heartbeatAt,
    leaseExpiresAt,
    heartbeatAt,
    record.jobId,
    BRIDGE_INSTANCE_ID,
    record.ownerGeneration,
    Number(record.revision || 0)
  );
  if (!reacquired) return false;
  record.heartbeatAt = heartbeatAt;
  record.leaseExpiresAt = leaseExpiresAt;
  record.revision = Number(reacquired.revision || record.revision || 0);
  record.queueOwnershipLost = false;
  logEvent("warn", "queue.lease_reacquired", { jobId: record.jobId, ownerGeneration: record.ownerGeneration });
  return true;
}

function queueOwnershipLossError(detail = "Durable queue ownership could not be renewed before lease expiry.") {
  const error = new Error(detail);
  error.errorType = "queue_ownership_lost";
  return error;
}

function clearQueueLeaseFence(record) {
  if (record?.queueLeaseFenceTimer) clearTimeout(record.queueLeaseFenceTimer);
  if (record) record.queueLeaseFenceTimer = null;
}

function loseQueueOwnership(record, detail) {
  if (!record || record.queueOwnershipLost) return;
  record.queueOwnershipLost = true;
  const error = queueOwnershipLossError(detail);
  logEvent("error", "queue.ownership_lost", { jobId: record.jobId, ownerGeneration: record.ownerGeneration || "", detail });
  record.abortController?.abort(error);
}

// B-158: why this owner's renewal failed, read from the row itself. A terminal row or a
// cancellation request means another process ended the job on purpose; such a handover is
// reported at info level (queue.ownership_released) and the local work is stopped with the
// matching error type. null means a real loss (the row is gone, or active under another owner).
const QUEUE_TERMINAL_ROW_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "not_resumable"]);

function queueOwnershipHandover(db, record) {
  let row = null;
  try {
    row = db.prepare("SELECT status, owner_instance_id, cancellation_requested_at FROM opencode_jobs WHERE job_id = ?").get(record.jobId);
  } catch {
    return null;
  }
  if (!row) return null;
  const cancelled = Boolean(row.cancellation_requested_at) || row.status === "cancelled";
  if (cancelled) return { reason: "cancelled", errorType: "agent_cancelled", rowStatus: row.status, detail: `The job was cancelled by another process (${row.owner_instance_id === BRIDGE_INSTANCE_ID ? "its row carries a cancellation request" : `the row is now ${row.status}`}).` };
  if (QUEUE_TERMINAL_ROW_STATUSES.has(row.status)) return { reason: "finished", errorType: "queue_job_finished_elsewhere", rowStatus: row.status, detail: `The job's row was finished by another process (${row.status}).` };
  return null;
}

function releaseQueueOwnership(record, handover) {
  if (!record || record.queueOwnershipLost) return;
  record.queueOwnershipLost = true;
  if (handover.reason === "cancelled") record.cancellationRequested = true;
  logEvent("info", "queue.ownership_released", { jobId: record.jobId, ownerGeneration: record.ownerGeneration || "", handover: handover.reason, rowStatus: handover.rowStatus, summary: `${record.jobId}: ${handover.detail}` });
  const error = new Error(handover.detail);
  error.errorType = handover.errorType;
  record.abortController?.abort(error);
}

function resetQueueLeaseFence(record) {
  clearQueueLeaseFence(record);
  if (!record?.abortController || !["running", "validating", "reviewing", "testing"].includes(record.status)) return;
  const leaseExpiresAt = Date.parse(record.leaseExpiresAt || "");
  if (!Number.isFinite(leaseExpiresAt)) {
    loseQueueOwnership(record, "The durable queue lease has no valid expiry timestamp.");
    return;
  }
  const guardMs = Math.max(20, Math.min(CONFIG.queueHeartbeatMs, Math.floor(CONFIG.queueLeaseMs / 4)));
  record.queueLeaseFenceTimer = setTimeout(() => {
    loseQueueOwnership(record, "The queue lease was not durably renewed before the fail-closed deadline.");
  }, Math.max(0, leaseExpiresAt - Date.now() - guardMs));
  record.queueLeaseFenceTimer.unref?.();
}

function noteQueueLeaseRenewalFailure(record, { definitive = false, detail = "Queue heartbeat persistence failed." } = {}) {
  const leaseExpiresAt = Date.parse(record?.leaseExpiresAt || "");
  if (definitive || !Number.isFinite(leaseExpiresAt) || Date.now() + CONFIG.queueHeartbeatMs >= leaseExpiresAt) {
    loseQueueOwnership(record, detail);
  }
}

async function assertQueueRecordDurableOwnership(record) {
  if (effectiveQueueMode() !== "sqlite") return { ok: true };
  const db = await openLockDb(record.cwd);
  try {
    const row = db.prepare(`
      SELECT status, owner_instance_id, owner_generation, lease_expires_at
      FROM opencode_jobs WHERE job_id = ?
    `).get(record.jobId);
    const owned = row
      && ["running", "validating", "reviewing", "testing"].includes(row.status)
      && row.owner_instance_id === BRIDGE_INSTANCE_ID
      && String(row.owner_generation || "") === String(record.ownerGeneration || "")
      && Date.parse(row.lease_expires_at || "") > Date.now();
    return owned
      ? { ok: true }
      : { ok: false, error: queueOwnershipLossError("The durable queue generation or lease is no longer owned immediately before agent spawn.") };
  } finally {
    closeDb(db);
  }
}

async function renewQueueRecordDurableOwnership(record) {
  if (effectiveQueueMode() !== "sqlite") return { ok: true, deadlineAt: Date.now() + CONFIG.queueLeaseMs };
  const heartbeatAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  const db = await openLockDb(record.cwd);
  try {
    const renewed = renewPersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt);
    if (!renewed) {
      noteQueueLeaseRenewalFailure(record, {
        definitive: true,
        detail: "The queue lease could not be renewed for the external process watchdog.",
      });
      return { ok: false };
    }
    return { ok: true, deadlineAt: Date.parse(record.leaseExpiresAt) };
  } finally {
    closeDb(db);
  }
}

function heartbeatKnownQueueState() {
  const heartbeatAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  const recordsByDbPath = new Map();
  const pipelinesByDbPath = new Map();
  for (const record of QUEUE_JOBS.values()) {
    if (record.ownerInstanceId !== BRIDGE_INSTANCE_ID
      || !["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"].includes(record.status)) continue;
    const dbPath = stateDbPath(record.cwd);
    const records = recordsByDbPath.get(dbPath) || [];
    records.push(record);
    recordsByDbPath.set(dbPath, records);
  }
  for (const record of PIPELINE_RUNS.values()) {
    if (record.ownerInstanceId !== BRIDGE_INSTANCE_ID
      || !record.ownerGeneration
      || ["completed", "failed", "cancelled"].includes(record.status)) continue;
    const dbPath = stateDbPath(record.cwd);
    const pipelines = pipelinesByDbPath.get(dbPath) || [];
    pipelines.push(record);
    pipelinesByDbPath.set(dbPath, pipelines);
  }
  const activeDbPaths = new Set([...recordsByDbPath.keys(), ...pipelinesByDbPath.keys()]);
  for (const dbPath of activeDbPaths) {
    let db = null;
    const localRecords = recordsByDbPath.get(dbPath) || [];
    const localPipelines = pipelinesByDbPath.get(dbPath) || [];
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA synchronous = FULL;");
      db.exec("PRAGMA secure_delete = ON;");
      db.prepare(`
        INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          process_id = excluded.process_id,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
      `).run(BRIDGE_INSTANCE_ID, process.pid, heartbeatAt, heartbeatAt, leaseExpiresAt);
      db.prepare("DELETE FROM bridge_instances WHERE lease_expires_at < ?").run(new Date(Date.now() - CONFIG.queueStaleAfterMs).toISOString());
      for (const record of localRecords) {
        if (!renewPersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt)
          && !(QUEUE_PRE_EXECUTION_STATUSES.includes(record.status)
            && reacquirePersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt))) {
          // B-158: a row another process cancelled or finished (cancel_opencode_job from a
          // client while the worker held the job) is handed over, not lost: the fault log got
          // 28 "faults" in one evening for operator cancellations. Only a row that still looks
          // active under another owner, or that is gone, is an ownership loss.
          const handover = queueOwnershipHandover(db, record);
          if (handover) releaseQueueOwnership(record, handover);
          else {
            noteQueueLeaseRenewalFailure(record, {
              definitive: true,
              detail: "The durable queue row no longer matches this owner generation.",
            });
          }
        }
      }
      const renewPipeline = db.prepare(`
        UPDATE opencode_pipelines
        SET owner_heartbeat_at = ?, owner_lease_expires_at = ?
        WHERE pipeline_id = ? AND owner_instance_id = ? AND owner_generation = ?
          AND owner_lease_expires_at > ?
          AND status NOT IN ('completed', 'failed', 'cancelled')
      `);
      const reclaimPipeline = db.prepare(`
        UPDATE opencode_pipelines
        SET owner_heartbeat_at = ?, owner_lease_expires_at = ?
        WHERE pipeline_id = ? AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
          AND status NOT IN ('completed', 'failed', 'cancelled')
      `);
      const pipelineOwner = db.prepare("SELECT owner_instance_id, owner_generation FROM opencode_pipelines WHERE pipeline_id = ?");
      for (const record of localPipelines) {
        const renewed = renewPipeline.run(
          heartbeatAt,
          leaseExpiresAt,
          record.pipelineId,
          BRIDGE_INSTANCE_ID,
          record.ownerGeneration,
          heartbeatAt
        );
        // A lapsed lease under this instance's generation is still ours (every takeover writes
        // a new generation), so it is re-taken instead of being reported lost. Only a row that
        // another generation took is lost; dropping it from PIPELINE_RUNS stops this
        // instance's heartbeat from covering it so recovery can resume it.
        if (Number(renewed.changes || 0) === 1
          || Number(reclaimPipeline.run(
            heartbeatAt,
            leaseExpiresAt,
            record.pipelineId,
            BRIDGE_INSTANCE_ID,
            record.ownerGeneration
          ).changes || 0) === 1) {
          record.ownerHeartbeatAt = heartbeatAt;
          record.ownerLeaseExpiresAt = leaseExpiresAt;
        } else {
          record.pipelineOwnershipLost = true;
          const owner = pipelineOwner.get(record.pipelineId);
          if ((!owner || owner.owner_instance_id !== BRIDGE_INSTANCE_ID
            || String(owner.owner_generation || "") !== String(record.ownerGeneration || ""))
            && PIPELINE_RUNS.get(record.pipelineId) === record) {
            PIPELINE_RUNS.delete(record.pipelineId);
          }
          logEvent("warn", "pipeline.ownership_lost", {
            pipelineId: record.pipelineId,
            ownerGeneration: record.ownerGeneration,
          });
        }
      }
      const cancellationRows = db.prepare(`
        SELECT job_id, revision, cancellation_requested_at FROM opencode_jobs
        WHERE owner_instance_id = ? AND cancellation_requested_at IS NOT NULL AND cancellation_requested_at <> ''
          AND status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
      `).all(BRIDGE_INSTANCE_ID);
      for (const row of cancellationRows) {
        const record = QUEUE_JOBS.get(row.job_id);
        if (record) {
          record.revision = Number(row.revision || record.revision || 0);
          record.cancellationRequested = true;
          record.cancellationRequestedAt = row.cancellation_requested_at || record.cancellationRequestedAt || "";
          record.abortController?.abort();
        }
      }
      // B-122: as in the recovery pass (B-077/B-079), the rows of a repository whose queue a live
      // worker of another process owns, or that a stopped worker parked, are left alone: after a
      // sleep this process would otherwise mark the worker's running jobs interrupted and run
      // their retries itself. This process's own rows were renewed above.
      if (!foreignQueueWorkerPresence(dbPath)) reconcileStaleQueueRecords(db, Date.now());
    } catch (error) {
      logEvent("warn", "queue.heartbeat_failed", { dbPath, error: error.message || String(error) });
      for (const record of localRecords) {
        noteQueueLeaseRenewalFailure(record, { detail: error.message || String(error) });
      }
    } finally {
      if (db) closeDb(db);
    }
  }
}

function ensureQueueHeartbeatTimer() {
  if (process.argv.includes("--self-test")) return;
  if (queueHeartbeatTimer) return;
  queueHeartbeatTimer = setInterval(heartbeatKnownQueueState, CONFIG.queueHeartbeatMs);
  queueHeartbeatTimer.unref?.();
}

function pruneInMemoryState(now = Date.now()) {
  const cutoff = now - CONFIG.queueRetentionDays * 24 * 60 * 60 * 1000;
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted", "not_resumable"]);
  for (const [pipelineId, record] of PIPELINE_RUNS) {
    const terminalAt = Date.parse(record.finishedAt || record.updatedAt || record.createdAt || "");
    if (terminalStatuses.has(record.status) && Number.isFinite(terminalAt) && terminalAt < cutoff) {
      PIPELINE_RUNS.delete(pipelineId);
    }
  }
  const referencedJobIds = new Set(
    [...PIPELINE_RUNS.values()].flatMap((record) => Array.isArray(record.queueJobIds) ? record.queueJobIds : [])
  );
  for (const [jobId, record] of QUEUE_JOBS) {
    const terminalAt = Date.parse(record.finishedAt || record.updatedAt || record.createdAt || "");
    if (terminalStatuses.has(record.status) && !referencedJobIds.has(jobId) && Number.isFinite(terminalAt) && terminalAt < cutoff) {
      QUEUE_JOBS.delete(jobId);
    }
  }
}

function sqliteUsedBytes(db) {
  const pageCount = Number(db.prepare("PRAGMA page_count").get()?.page_count || 0);
  const freePages = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count || 0);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size || 0);
  return Math.max(0, (pageCount - freePages) * pageSize);
}

function stateCapacityError(db, incomingBytes = 0) {
  const usedBytes = sqliteUsedBytes(db);
  const projectedBytes = usedBytes + Math.max(0, Number(incomingBytes || 0));
  return projectedBytes >= CONFIG.stateDbMaxBytes
    ? {
        errorType: "state_capacity_exceeded",
        error: `Project state database reached its configured soft capacity (${projectedBytes} projected live bytes). Terminal and cancellation updates remain enabled; prune/archive old state before creating new work.`,
        usedBytes,
        projectedBytes,
      }
    : null;
}

function prunePersistedState(db, dbPath) {
  const now = Date.now();
  const lastPruned = statePruneTimes.get(dbPath) || 0;
  if (now - lastPruned < 1000 * 60 * 5) {
    return;
  }
  pruneInMemoryState(now);
  const queueCutoff = new Date(now - CONFIG.queueRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const auditCutoff = now - CONFIG.auditRetentionDays * 24 * 60 * 60 * 1000;
  const auditCutoffIso = new Date(auditCutoff).toISOString();
  const terminalStatuses = ["completed", "failed", "cancelled", "interrupted", "not_resumable"];
  const placeholders = terminalStatuses.map(() => "?").join(", ");
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    expireLocksFromDb(db, now);
    db.prepare("DELETE FROM consumed_integration_previews WHERE expires_at <= ?").run(now);
    db.prepare(`
      DELETE FROM changed_files
      WHERE run_id IN (
        SELECT run_id FROM runs
        WHERE status IN ('released', 'expired', 'quarantine_released') AND finished_at IS NOT NULL AND finished_at < ?
      )
    `).run(auditCutoff);
    db.prepare(`
      DELETE FROM runs
      WHERE status IN ('released', 'expired', 'quarantine_released') AND finished_at IS NOT NULL AND finished_at < ?
        AND NOT EXISTS (SELECT 1 FROM locks WHERE locks.run_id = runs.run_id)
    `).run(auditCutoff);
    db.prepare(`
      DELETE FROM opencode_pipelines
      WHERE status IN (${placeholders}) AND updated_at < ?
    `).run(...terminalStatuses, queueCutoff);
    db.prepare(`
      DELETE FROM opencode_jobs AS job
      WHERE job.status IN (${placeholders})
        AND COALESCE(NULLIF(job.finished_at, ''), NULLIF(job.updated_at, ''), job.created_at) < ?
        AND NOT EXISTS (
          SELECT 1 FROM opencode_pipeline_children AS relation
          WHERE relation.job_id = job.job_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM opencode_pipelines AS pipeline,
               json_each(CASE WHEN json_valid(pipeline.record_json) THEN pipeline.record_json ELSE '{}' END, '$.queueJobIds') AS child
          WHERE CAST(child.value AS TEXT) = job.job_id
      )
    `).run(...terminalStatuses, queueCutoff);
    // Retention prunes only the bridge's own closures. An operation closed through
    // resolve_integration_quarantine (recovered_verified, resolved_by_operator) keeps its rows
    // and pre-images as the audit trail of that decision.
    db.prepare(`
      DELETE FROM integration_operation_files
      WHERE operation_id IN (
        SELECT operation_id FROM integration_operations
        WHERE status IN ('committed', 'rolled_back', 'recovered_noop')
          AND finished_at IS NOT NULL AND finished_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM opencode_pipelines AS pipeline
            WHERE pipeline.pipeline_id = integration_operations.pipeline_id
              AND pipeline.status NOT IN ('completed', 'failed', 'cancelled')
          )
      )
    `).run(auditCutoffIso);
    db.prepare(`
      DELETE FROM integration_operations
      WHERE status IN ('committed', 'rolled_back', 'recovered_noop')
        AND finished_at IS NOT NULL AND finished_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM opencode_pipelines AS pipeline
          WHERE pipeline.pipeline_id = integration_operations.pipeline_id
            AND pipeline.status NOT IN ('completed', 'failed', 'cancelled')
        )
    `).run(auditCutoffIso);
    db.prepare(`
      DELETE FROM opencode_pipelines
      WHERE pipeline_id IN (
        SELECT pipeline_id FROM opencode_pipelines
        WHERE status IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at DESC, pipeline_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(CONFIG.terminalPipelineMaxRows);
    db.prepare(`
      DELETE FROM opencode_jobs
      WHERE job_id IN (
        SELECT job.job_id FROM opencode_jobs AS job
        WHERE job.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'not_resumable')
          AND NOT EXISTS (
            SELECT 1 FROM opencode_pipeline_children AS relation WHERE relation.job_id = job.job_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM opencode_pipelines AS pipeline,
                 json_each(CASE WHEN json_valid(pipeline.record_json) THEN pipeline.record_json ELSE '{}' END, '$.queueJobIds') AS child
            WHERE CAST(child.value AS TEXT) = job.job_id
          )
        ORDER BY COALESCE(NULLIF(job.finished_at, ''), NULLIF(job.updated_at, ''), job.created_at) DESC, job.job_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(CONFIG.terminalJobMaxRows);
    db.prepare(`
      DELETE FROM integration_operation_files
      WHERE operation_id IN (
        SELECT operation_id FROM integration_operations
        WHERE status IN ('committed', 'rolled_back', 'recovered_noop')
          AND NOT EXISTS (
            SELECT 1 FROM opencode_pipelines AS pipeline
            WHERE pipeline.pipeline_id = integration_operations.pipeline_id
              AND pipeline.status NOT IN ('completed', 'failed', 'cancelled')
          )
        ORDER BY COALESCE(finished_at, updated_at) DESC, operation_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(CONFIG.terminalIntegrationMaxRows);
    db.prepare(`
      DELETE FROM integration_operations
      WHERE operation_id IN (
        SELECT operation_id FROM integration_operations
        WHERE status IN ('committed', 'rolled_back', 'recovered_noop')
          AND NOT EXISTS (
            SELECT 1 FROM opencode_pipelines AS pipeline
            WHERE pipeline.pipeline_id = integration_operations.pipeline_id
              AND pipeline.status NOT IN ('completed', 'failed', 'cancelled')
          )
        ORDER BY COALESCE(finished_at, updated_at) DESC, operation_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(CONFIG.terminalIntegrationMaxRows);
    db.prepare(`
      DELETE FROM worktree_artifacts
      WHERE status IN ('cleaned', 'cleaned_branch_retained') AND cleaned_at IS NOT NULL AND cleaned_at < ?
    `).run(auditCutoffIso);
    db.exec("COMMIT");
    transactionOpen = false;
    statePruneTimes.set(dbPath, now);
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the pruning error. */ }
    }
    throw error;
  }
}

function maintainKnownStateDatabases() {
  for (const dbPath of [...KNOWN_STATE_DB_PATHS]) {
    if (!existsSync(dbPath)) KNOWN_STATE_DB_PATHS.delete(dbPath);
  }
  const dbPaths = [...KNOWN_STATE_DB_PATHS];
  if (!dbPaths.length) return;
  const dbPath = dbPaths[stateMaintenanceCursor % dbPaths.length];
  stateMaintenanceCursor = (stateMaintenanceCursor + 1) % Math.max(1, dbPaths.length);
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("PRAGMA secure_delete = ON;");
    prunePersistedState(db, dbPath);
  } catch (error) {
    logEvent("warn", "state.maintenance_failed", {
      dbPathSha256: createHash("sha256").update(dbPath).digest("hex"),
      errorType: /^[A-Z0-9_]+$/.test(String(error?.code || "")) ? String(error.code) : "sqlite_state_maintenance_failed",
    });
  } finally {
    if (db) closeDb(db);
  }
}

function ensureStateMaintenanceTimer() {
  if (stateMaintenanceTimer || process.argv.includes("--self-test")) return;
  stateMaintenanceTimer = setInterval(maintainKnownStateDatabases, 1000 * 60 * 5);
  stateMaintenanceTimer.unref?.();
}
  return { reconcileStaleQueueRecords, releaseQueueJobLocks, queueOwnershipHandover, releaseQueueOwnership, processIsAlive, renewPersistedQueueRecordLease, QUEUE_PRE_EXECUTION_STATUSES, reacquirePersistedQueueRecordLease, queueOwnershipLossError, clearQueueLeaseFence, loseQueueOwnership, resetQueueLeaseFence, noteQueueLeaseRenewalFailure, assertQueueRecordDurableOwnership, renewQueueRecordDurableOwnership, heartbeatKnownQueueState, ensureQueueHeartbeatTimer, pruneInMemoryState, sqliteUsedBytes, stateCapacityError, prunePersistedState, maintainKnownStateDatabases, ensureStateMaintenanceTimer };
}
