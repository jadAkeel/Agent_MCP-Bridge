import { randomBytes as cryptoRandomBytes } from "node:crypto";

import { closeDb as defaultCloseDb } from "./sqlite-utils.js";

export function createQueueRepository({
  config,
  effectiveQueueMode,
  openLockDb,
  bridgeInstanceId,
  getProcessId = () => process.pid,
  clockNow = () => Date.now(),
  randomBytes = cryptoRandomBytes,
  queueRecordSnapshot,
  enforceQueueResultEvidence,
  loadPersistedQueueRecord,
  closeDb = defaultCloseDb,
} = {}) {
  const CONFIG = config;
  const BRIDGE_INSTANCE_ID = bridgeInstanceId;

  function stampPersistedQueueCancellation(db, { jobId, status, requestedAt, recordJson }) {
    return db.prepare(`
      UPDATE opencode_jobs
      SET cancellation_requested_at = CASE
            WHEN cancellation_requested_at IS NULL OR cancellation_requested_at = '' THEN ?
            ELSE cancellation_requested_at
          END,
          updated_at = ?, record_json = ?, revision = revision + 1
      WHERE job_id = ? AND status = ?
    `).run(requestedAt, requestedAt, recordJson, jobId, status);
  }

  function persistTerminalQueueRecord(db, record) {
    const activeStatuses = "'running', 'validating', 'reviewing', 'testing'";
    const selectCurrent = db.prepare(`
      SELECT status, started_at, finished_at, owner_instance_id, owner_process_id, owner_generation,
             heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id,
             child_process_started_at, revision, idempotency_key, request_encrypted, record_json
      FROM opencode_jobs WHERE job_id = ?
    `);
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      let current = selectCurrent.get(record.jobId);
      const terminalRecord = {
        ...record,
        ownerInstanceId: current?.owner_instance_id || record.ownerInstanceId || "",
        ownerProcessId: current?.owner_process_id || record.ownerProcessId || 0,
        ownerGeneration: current?.owner_generation || record.ownerGeneration || "",
        revision: Number(current?.revision || record.revision || 0) + 1,
      };
      if (current
        && ["held", "pending", "planned", "blocked"].includes(current.status)
        && current.owner_instance_id === BRIDGE_INSTANCE_ID
        && String(current.owner_generation || "") === String(record.ownerGeneration || "")
        && ["failed", "cancelled"].includes(record.status)) {
        Object.assign(terminalRecord, {
          finishedAt: terminalRecord.finishedAt || new Date(clockNow()).toISOString(),
          heartbeatAt: "",
          leaseExpiresAt: "",
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        if (current.cancellation_requested_at) {
          Object.assign(terminalRecord, {
            status: "cancelled",
            cancellationRequested: true,
            cancellationRequestedAt: current.cancellation_requested_at,
            errorType: "agent_cancelled",
            errorReason: record.errorReason || "Cancellation won before queue execution.",
          });
        }
        const preExecutionChange = db.prepare(`
          UPDATE opencode_jobs
          SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, heartbeat_at = '', lease_expires_at = '',
              child_process_id = 0, child_process_started_at = '', record_json = ?, revision = revision + 1
          WHERE job_id = ? AND status = ? AND revision = ?
            AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
        `).run(
          terminalRecord.status,
          terminalRecord.startedAt || "",
          terminalRecord.finishedAt,
          new Date(clockNow()).toISOString(),
          JSON.stringify(queueRecordSnapshot(terminalRecord)),
          terminalRecord.jobId,
          current.status,
          Number(current.revision || 0),
          BRIDGE_INSTANCE_ID,
          record.ownerGeneration || ""
        );
        if (Number(preExecutionChange.changes || 0) === 1) {
          db.exec("COMMIT");
          transactionOpen = false;
          Object.assign(record, terminalRecord);
          return { persisted: true, status: terminalRecord.status, cancellationWon: terminalRecord.status === "cancelled" };
        }
        current = selectCurrent.get(record.jobId);
      }
      const terminalChange = db.prepare(`
        UPDATE opencode_jobs
        SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
            child_process_id = ?, child_process_started_at = ?, record_json = ?, revision = revision + 1
        WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ?
          AND owner_generation <> ''
          AND status IN (${activeStatuses})
          AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
      `).run(
        terminalRecord.status,
        terminalRecord.startedAt || "",
        terminalRecord.finishedAt || "",
        new Date(clockNow()).toISOString(),
        terminalRecord.heartbeatAt || "",
        terminalRecord.leaseExpiresAt || "",
        terminalRecord.childProcessId || 0,
        terminalRecord.childProcessStartedAt || "",
        JSON.stringify(queueRecordSnapshot(terminalRecord)),
        terminalRecord.jobId,
        BRIDGE_INSTANCE_ID,
        record.ownerGeneration || ""
      );
      if (Number(terminalChange.changes || 0) === 1) {
        db.exec("COMMIT");
        transactionOpen = false;
        Object.assign(record, terminalRecord);
        return { persisted: true, status: terminalRecord.status, cancellationWon: false };
      }

      current = selectCurrent.get(record.jobId);
      const ownsCurrentGeneration = current
        && current.owner_instance_id === BRIDGE_INSTANCE_ID
        && String(current.owner_generation || "") === String(record.ownerGeneration || "");
      if (ownsCurrentGeneration
        && ["running", "validating", "reviewing", "testing"].includes(current.status)
        && current.cancellation_requested_at) {
        const cancelledRecord = {
          ...record,
          status: "cancelled",
          finishedAt: record.finishedAt || new Date(clockNow()).toISOString(),
          heartbeatAt: "",
          leaseExpiresAt: "",
          cancellationRequested: true,
          cancellationRequestedAt: current.cancellation_requested_at,
          errorType: "agent_cancelled",
          errorReason: "Cancellation won the durable terminal-write race.",
          ownerInstanceId: current.owner_instance_id,
          ownerProcessId: current.owner_process_id || 0,
          ownerGeneration: current.owner_generation || "",
          childProcessId: 0,
          childProcessStartedAt: "",
          revision: Number(current.revision || 0) + 1,
        };
        const cancellationChange = db.prepare(`
          UPDATE opencode_jobs
          SET status = 'cancelled', started_at = ?, finished_at = ?, updated_at = ?, heartbeat_at = '', lease_expires_at = '',
              child_process_id = 0, child_process_started_at = '', record_json = ?, revision = revision + 1
          WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ?
            AND owner_generation <> ''
            AND status IN (${activeStatuses})
            AND cancellation_requested_at IS NOT NULL AND cancellation_requested_at <> ''
        `).run(
          cancelledRecord.startedAt || "",
          cancelledRecord.finishedAt,
          new Date(clockNow()).toISOString(),
          JSON.stringify(queueRecordSnapshot(cancelledRecord)),
          cancelledRecord.jobId,
          BRIDGE_INSTANCE_ID,
          record.ownerGeneration || ""
        );
        if (Number(cancellationChange.changes || 0) === 1) {
          db.exec("COMMIT");
          transactionOpen = false;
          Object.assign(record, cancelledRecord);
          return { persisted: true, status: "cancelled", cancellationWon: true };
        }
        current = selectCurrent.get(record.jobId);
      }

      db.exec("COMMIT");
      transactionOpen = false;
      loadPersistedQueueRecord(record, current);
      return { persisted: false, status: current?.status || "missing", cancellationWon: Boolean(current?.cancellation_requested_at) };
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the terminal persistence error. */ }
      }
      throw error;
    }
  }

  async function persistQueueRecord(record) {
    enforceQueueResultEvidence(record);
    if (effectiveQueueMode() !== "sqlite") {
      record.revision = Number(record.revision || 0) + 1;
      return { persisted: true, status: record.status };
    }

    const db = await openLockDb(record.cwd);
    let transactionOpen = false;
    try {
      if (["completed", "failed", "cancelled"].includes(record.status)) {
        return persistTerminalQueueRecord(db, record);
      }
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const selectCurrent = db.prepare(`
        SELECT status, started_at, finished_at, owner_instance_id, owner_process_id, owner_generation,
               heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id,
               child_process_started_at, revision, idempotency_key, request_encrypted, record_json
        FROM opencode_jobs WHERE job_id = ?
      `);
      let current = selectCurrent.get(record.jobId);
      if (!current) {
        if (record.idempotencyKey) {
          const existing = db.prepare("SELECT job_id, record_json FROM opencode_jobs WHERE idempotency_key = ?").get(record.idempotencyKey);
          if (existing) {
            let existingSnapshot = {};
            try { existingSnapshot = JSON.parse(existing.record_json || "{}"); } catch { /* Treat unreadable evidence as a mismatch. */ }
            if (!existingSnapshot.requestFingerprint || existingSnapshot.requestFingerprint !== record.requestFingerprint) {
              db.exec("ROLLBACK");
              transactionOpen = false;
              return { persisted: false, idempotencyConflict: true, jobId: existing.job_id };
            }
            db.exec("COMMIT");
            transactionOpen = false;
            return { persisted: true, deduplicated: true, jobId: existing.job_id };
          }
        }
        try {
          db.prepare(`
          INSERT INTO opencode_jobs
          (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
           owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at, cancellation_requested_at,
           child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.jobId,
          record.cwd || "",
          record.status,
          record.agent,
          record.mode,
          record.createdAt,
          record.startedAt || "",
          record.finishedAt || "",
          JSON.stringify(queueRecordSnapshot(record)),
          record.ownerInstanceId || "",
          record.ownerProcessId || 0,
          record.ownerGeneration || "",
          new Date(clockNow()).toISOString(),
          record.heartbeatAt || "",
          record.leaseExpiresAt || "",
          record.cancellationRequestedAt || "",
          record.childProcessId || 0,
          record.childProcessStartedAt || "",
          Number(record.revision || 0),
          record.idempotencyKey || null,
          record.requestEncrypted || null
        );
        } catch (error) {
          if (record.idempotencyKey && /UNIQUE constraint failed: opencode_jobs\.idempotency_key/i.test(error.message || String(error))) {
            const existing = db.prepare("SELECT job_id, record_json FROM opencode_jobs WHERE idempotency_key = ?").get(record.idempotencyKey);
            let existingSnapshot = {};
            try { existingSnapshot = JSON.parse(existing?.record_json || "{}"); } catch { /* Treat unreadable evidence as a mismatch. */ }
            if (!existingSnapshot.requestFingerprint || existingSnapshot.requestFingerprint !== record.requestFingerprint) {
              db.exec("ROLLBACK");
              transactionOpen = false;
              return { persisted: false, idempotencyConflict: true, jobId: existing?.job_id || "" };
            }
            db.exec("COMMIT");
            transactionOpen = false;
            return { persisted: true, deduplicated: true, jobId: existing?.job_id || "" };
          }
          throw error;
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return { persisted: true, status: record.status, revision: Number(record.revision || 0) };
      }

      const currentRevision = Number(current.revision || 0);
      const sameOwner = current.owner_instance_id === BRIDGE_INSTANCE_ID
        && String(current.owner_generation || "") === String(record.ownerGeneration || "")
        && Boolean(record.ownerGeneration);
      const currentTerminal = ["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(current.status);
      if (currentTerminal || !sameOwner || currentRevision !== Number(record.revision || 0)) {
        db.exec("COMMIT");
        transactionOpen = false;
        loadPersistedQueueRecord(record, current);
        return { persisted: false, status: current.status, revision: currentRevision };
      }

      const nextRecord = {
        ...record,
        cancellationRequested: Boolean(current.cancellation_requested_at || record.cancellationRequested),
        cancellationRequestedAt: current.cancellation_requested_at || record.cancellationRequestedAt || "",
        revision: currentRevision + 1,
      };
      const changed = db.prepare(`
        UPDATE opencode_jobs
        SET cwd = ?, status = ?, agent = ?, mode = ?, started_at = ?, finished_at = ?, record_json = ?,
            owner_instance_id = ?, owner_process_id = ?, owner_generation = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
            cancellation_requested_at = CASE
              WHEN cancellation_requested_at IS NULL OR cancellation_requested_at = '' THEN ?
              ELSE cancellation_requested_at
            END,
            child_process_id = ?, child_process_started_at = ?, revision = revision + 1
        WHERE job_id = ? AND status = ? AND revision = ?
          AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
      `).run(
        nextRecord.cwd || "",
        nextRecord.status,
        nextRecord.agent,
        nextRecord.mode,
        nextRecord.startedAt || "",
        nextRecord.finishedAt || "",
        JSON.stringify(queueRecordSnapshot(nextRecord)),
        nextRecord.ownerInstanceId || "",
        nextRecord.ownerProcessId || 0,
        nextRecord.ownerGeneration || "",
        new Date(clockNow()).toISOString(),
        nextRecord.heartbeatAt || "",
        nextRecord.leaseExpiresAt || "",
        nextRecord.cancellationRequestedAt || "",
        nextRecord.childProcessId || 0,
        nextRecord.childProcessStartedAt || "",
        nextRecord.jobId,
        current.status,
        currentRevision,
        BRIDGE_INSTANCE_ID,
        record.ownerGeneration || ""
      );
      if (Number(changed.changes || 0) === 1) {
        db.exec("COMMIT");
        transactionOpen = false;
        Object.assign(record, nextRecord);
        return { persisted: true, status: nextRecord.status, revision: nextRecord.revision };
      }
      current = selectCurrent.get(record.jobId);
      db.exec("COMMIT");
      transactionOpen = false;
      loadPersistedQueueRecord(record, current);
      return { persisted: false, status: current?.status || "missing", revision: Number(current?.revision || 0) };
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the queue persistence error. */ }
      }
      throw error;
    } finally {
      closeDb(db);
    }
  }

  async function updateQueueRecordDurable(record, patch = {}) {
    Object.assign(record, patch);
    return await persistQueueRecord(record);
  }

  async function persistedRunningQueueRecords(cwd = "") {
    if (effectiveQueueMode() !== "sqlite") {
      return [];
    }

    const db = await openLockDb(cwd);
    try {
      const rows = db.prepare(
        "SELECT record_json FROM opencode_jobs WHERE status IN ('running', 'validating', 'reviewing', 'testing')"
      ).all();
      return rows.flatMap((row) => {
        try {
          return row.record_json ? [JSON.parse(row.record_json)] : [];
        } catch {
          return [];
        }
      });
    } finally {
      closeDb(db);
    }
  }

  async function claimQueueRecord(record) {
    const heartbeatAt = new Date(clockNow()).toISOString();
    const runningState = {
      status: "running",
      startedAt: record.startedAt || new Date(clockNow()).toISOString(),
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerProcessId: getProcessId(),
      ownerGeneration: record.ownerGeneration || randomBytes(12).toString("hex"),
      heartbeatAt,
      leaseExpiresAt: new Date(clockNow() + CONFIG.queueLeaseMs).toISOString(),
      errorType: "",
      errorReason: "",
      revision: Number(record.revision || 0) + 1,
    };
    if (effectiveQueueMode() !== "sqlite") {
      Object.assign(record, runningState);
      return { ok: true };
    }
    const db = await openLockDb(record.cwd);
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare(`
        SELECT status, owner_instance_id, owner_generation, cancellation_requested_at
        FROM opencode_jobs WHERE job_id = ?
      `).get(record.jobId);
      const claimable = row
        && ["pending", "planned", "blocked"].includes(row.status)
        && row.owner_instance_id === BRIDGE_INSTANCE_ID
        && String(row.owner_generation || "") === String(record.ownerGeneration || "")
        && !row.cancellation_requested_at;
      if (!claimable) {
        db.exec("ROLLBACK");
        if (row?.status === "cancelled" || row?.cancellation_requested_at) {
          Object.assign(record, {
            status: "cancelled",
            cancellationRequested: true,
            cancellationRequestedAt: row.cancellation_requested_at || record.cancellationRequestedAt || new Date(clockNow()).toISOString(),
            finishedAt: record.finishedAt || new Date(clockNow()).toISOString(),
            errorType: "agent_cancelled",
            errorReason: "Cancellation won the durable claim race before execution.",
          });
        }
        return { ok: false, status: row?.status || "missing" };
      }
      const snapshot = JSON.stringify(queueRecordSnapshot({ ...record, ...runningState }));
      const changed = db.prepare(`
        UPDATE opencode_jobs
        SET status = 'running', started_at = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
            owner_process_id = ?, record_json = ?, revision = revision + 1
        WHERE job_id = ? AND status = ? AND owner_instance_id = ? AND owner_generation = ?
          AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
      `).run(
        runningState.startedAt,
        heartbeatAt,
        heartbeatAt,
        runningState.leaseExpiresAt,
        getProcessId(),
        snapshot,
        record.jobId,
        row.status,
        BRIDGE_INSTANCE_ID,
        record.ownerGeneration || ""
      );
      if (Number(changed.changes || 0) !== 1) {
        db.exec("ROLLBACK");
        return { ok: false, status: "claim_lost" };
      }
      db.exec("COMMIT");
      Object.assign(record, runningState);
      return { ok: true };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve original claim error. */ }
      throw error;
    } finally {
      closeDb(db);
    }
  }

  async function readPersistedQueueRecord(jobId, cwd = "") {
    if (effectiveQueueMode() !== "sqlite") {
      return null;
    }

    const db = await openLockDb(cwd);
    try {
      const row = db.prepare(`
        SELECT status, finished_at, heartbeat_at, lease_expires_at, cancellation_requested_at,
               child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted, record_json
        FROM opencode_jobs WHERE job_id = ?
      `).get(jobId);
      return row?.record_json ? {
        ...JSON.parse(row.record_json),
        status: row.status,
        finishedAt: row.finished_at || "",
        heartbeatAt: row.heartbeat_at || "",
        leaseExpiresAt: row.lease_expires_at || "",
        cancellationRequested: Boolean(row.cancellation_requested_at),
        cancellationRequestedAt: row.cancellation_requested_at || "",
        childProcessId: row.child_process_id || 0,
        childProcessStartedAt: row.child_process_started_at || "",
        revision: row.revision || 0,
      } : null;
    } finally {
      closeDb(db);
    }
  }

  async function listPersistedQueueRecords(cwd = "", status = "") {
    if (effectiveQueueMode() !== "sqlite") {
      return [];
    }

    const db = await openLockDb(cwd);
    try {
      const fields = "status, finished_at, heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted, record_json";
      const rows = status
        ? db.prepare(`SELECT ${fields} FROM opencode_jobs WHERE status = ? ORDER BY created_at DESC`).all(status)
        : db.prepare(`SELECT ${fields} FROM opencode_jobs ORDER BY created_at DESC`).all();
      return rows.map((row) => ({
        ...JSON.parse(row.record_json),
        status: row.status,
        finishedAt: row.finished_at || "",
        heartbeatAt: row.heartbeat_at || "",
        leaseExpiresAt: row.lease_expires_at || "",
        cancellationRequested: Boolean(row.cancellation_requested_at),
        cancellationRequestedAt: row.cancellation_requested_at || "",
        childProcessId: row.child_process_id || 0,
        childProcessStartedAt: row.child_process_started_at || "",
        revision: row.revision || 0,
      }));
    } finally {
      closeDb(db);
    }
  }

  // Temporary internal composition authority for legacy cancellation/recovery
  // handlers and parity self-tests. Narrow this surface with their owning cuts.
  return {
    stampPersistedQueueCancellation,
    persistTerminalQueueRecord,
    persistQueueRecord,
    updateQueueRecordDurable,
    persistedRunningQueueRecords,
    claimQueueRecord,
    readPersistedQueueRecord,
    listPersistedQueueRecords,
  };
}
