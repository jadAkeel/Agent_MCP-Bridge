export function createQueueRecoveryPrimitives({
  config,
  queueJobs,
  bridgeInstanceId,
  persistedQueueRecordFromRow,
  sanitizePersistedValue,
  logEvent = () => {},
  clockNow = () => Date.now(),
  processKill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const CONFIG = config;
  const QUEUE_JOBS = queueJobs;
  const BRIDGE_INSTANCE_ID = bridgeInstanceId;

  function reconcileStaleQueueRecords(db, now = clockNow()) {
    const nonTerminalStatuses = ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"];
    const placeholders = nonTerminalStatuses.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT job_id, cwd, status, agent, mode, created_at, started_at, owner_instance_id, owner_process_id, owner_generation,
              heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id, child_process_started_at, request_encrypted, record_json
       FROM opencode_jobs
       WHERE status IN (${placeholders})`
    ).all(...nonTerminalStatuses);
    const finishedAt = new Date(now).toISOString();
    const update = db.prepare(
      "UPDATE opencode_jobs SET status = ?, finished_at = ?, record_json = ? WHERE job_id = ? AND status = ? AND (owner_generation = ? OR (owner_generation IS NULL AND ? = ''))"
    );
    const reconciled = [];

    for (const row of rows) {
      if (QUEUE_JOBS.has(row.job_id)) {
        continue;
      }
      if (["held", "pending", "planned", "blocked"].includes(row.status) && row.request_encrypted) {
        continue;
      }

      let snapshot = persistedQueueRecordFromRow(row);
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
        if (Number.isFinite(instanceLease) && instanceLease > now) continue;
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
        errorType: cancellationRequested ? "agent_cancelled" : wasActive ? "queue_job_interrupted" : "queue_job_not_resumable",
        errorReason: cancellationRequested
          ? `Cancellation is terminal because the durable owner leases expired.${orphanChildProcessAlive ? " The recorded child PID still appears alive; the bridge retained its identity for explicit OS-level inspection rather than risk killing a reused PID." : ""}`
          : wasActive
          ? `The durable owner leases expired, so this job was marked interrupted; a live numeric PID is not trusted as ownership because PIDs can be reused, and jobs are never resumed across bridge instances.${orphanChildProcessAlive ? " The recorded child PID still appears alive; the bridge retained its identity for explicit OS-level inspection rather than risk killing a reused PID." : ""}`
          : "The bridge restarted with a queued job whose full execution request is intentionally not persisted. Re-enqueue the job explicitly.",
        orphanChildProcessId: orphanChildProcessAlive ? orphanChildProcessId : 0,
        orphanChildProcessStartedAt: orphanChildProcessAlive ? (row.child_process_started_at || snapshot.childProcessStartedAt || "") : "",
        orphanChildProcessAlive,
      };
      const changed = update.run(terminalStatus, finishedAt, JSON.stringify(sanitizePersistedValue(snapshot)), row.job_id, row.status, row.owner_generation || "", row.owner_generation || "");
      if (Number(changed.changes || 0) > 0) reconciled.push(row.job_id);
    }

    if (reconciled.length) {
      logEvent("warn", "queue.orphaned_records_reconciled", {
        count: reconciled.length,
        jobIds: reconciled,
      });
    }

    return reconciled;
  }

  function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      processKill(pid, 0);
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
        AND status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
      RETURNING revision
    `).get(heartbeatAt, leaseExpiresAt, heartbeatAt, record.jobId, BRIDGE_INSTANCE_ID, record.ownerGeneration || "");
    if (!renewed) return false;
    record.heartbeatAt = heartbeatAt;
    record.leaseExpiresAt = leaseExpiresAt;
    record.revision = Number(renewed.revision || record.revision || 0);
    return true;
  }

  return {
    reconcileStaleQueueRecords,
    processIsAlive,
    renewPersistedQueueRecordLease,
  };
}
