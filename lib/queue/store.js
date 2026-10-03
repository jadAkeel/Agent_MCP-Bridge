// Queue snapshots, encrypted details and durable persistence transactions.
// Extracted from server.js in modularization round M-001.
// Runtime state and synchronous pipeline transaction propagation are supplied by the host.

import { createHash } from "node:crypto";
import { redactSensitiveText, sanitizePersistedValue } from "../redaction.js";
import { queueAgentTiming, RETRY_POLICY_HISTORY_MAX, scopeContractDurableSummary } from "../queue.js";

export function createQueueStoreRuntime({
  CONFIG,
  BRIDGE_INSTANCE_ID,
  QUEUE_JOBS,
  queueRunStage,
  truncateResultText,
  truncateText,
  encryptIntegrationJournalBytes,
  decryptIntegrationJournalBytes,
  effectiveQueueMode,
  openLockDb,
  closeDb,
  stateCapacityError,
  propagatePipelineTerminalInTransaction,
  getQueueCancellationTestHook,
  getQueuePersistTestHook,
}) {
function queueRecordSnapshot(record, includeResult = true) {
  const persistedResultText = redactSensitiveText(record.resultText || "");
  const persistedDetailText = redactSensitiveText(record.resultDetailText || "");
  // Truncated means the agent's report was cut (or an unstructured text exceeded the limit); a
  // patch preview the bridge kept apart is not a truncation.
  const resultCut = Boolean(record.resultReportTruncated) || Boolean(record.resultTextTruncated)
    || persistedResultText.length > CONFIG.queueResultMaxChars;
  const essentialResultTruncated = record.status === "completed" && resultCut;
  return sanitizePersistedValue({
    jobId: record.jobId,
    parentJobId: record.parentJobId || "",
    idempotencyKey: record.idempotencyKey || "",
    requestFingerprint: record.requestFingerprint || "",
    requeuedFrom: record.requeuedFrom || "",
    requeuedAs: record.requeuedAs || "",
    requeueSequence: record.requeueSequence || 0,
    requeuedAt: record.requeuedAt || "",
    // Q-007: the retry policy's counters, the attempts so far and a retry's start time.
    retryAttempt: record.retryAttempt || 0,
    maxAttempts: record.maxAttempts || 0,
    attemptHistory: Array.isArray(record.attemptHistory) ? record.attemptHistory.map(String).slice(-RETRY_POLICY_HISTORY_MAX) : [],
    startAfter: record.startAfter || "",
    // B-080: "provider_pause" when startAfter waits for provider/model pauses to end; any bridge
    // process releases such a wait as soon as none of the job's models is paused any more.
    startAfterReason: record.startAfter ? record.startAfterReason || "" : "",
    slotWaitRequeues: record.slotWaitRequeues || 0,
    // B-078: requeues after a slot refusal for a paused provider/model (not attempts), and the
    // pause end such a refusal reported (set only when the agent never started).
    pauseWaitRequeues: record.pauseWaitRequeues || 0,
    providerRefusedUntil: record.providerRefusedUntil || "",
    // Q-010: what the bridge did with an autoIntegrate job's patch; B-069: whether it asked for it
    // (a restart reschedules completed jobs that asked and are not integrated yet).
    autoIntegration: record.autoIntegration || null,
    autoIntegrateRequested: Boolean(record.autoIntegrateRequested),
    agent: record.agent,
    taskSha256: createHash("sha256").update(String(record.task || "")).digest("hex"),
    taskChars: String(record.task || "").length,
    cwd: record.cwd || "",
    mode: record.mode,
    scopeContract: record.scopeContract || null,
    sanitizedWorkspace: record.sanitizedWorkspace || null,
    sanitizedWorkspaceVerification: record.sanitizedWorkspaceVerification || null,
    lockMode: record.lockMode,
    lockedPaths: record.lockedPaths || [],
    allowedEdits: record.allowedEdits || [],
    worktreePath: record.worktreePath || "",
    worktreeBranch: record.worktreeBranch || "",
    worktreeBaseCommit: record.worktreeBaseCommit || "",
    worktreeBaseTree: record.worktreeBaseTree || "",
    worktreePatchSha256: record.worktreePatchSha256 || "",
    worktreeSourceStateSha256: record.worktreeSourceStateSha256 || "",
    status: record.status,
    runStage: queueRunStage(record),
    createdAt: record.createdAt,
    startedAt: record.startedAt || "",
    agentStartedAt: record.agentStartedAt || "",
    finishedAt: record.finishedAt || "",
    durationMs: record.durationMs || 0,
    ...queueAgentTiming(record),
    providerWaitMs: record.providerWaitMs || 0,
    providerRetryWarningCount: record.providerRetryWarningCount || 0,
    usage: record.usage || null,
    heavyToolCalls: record.heavyToolCalls || null,
    validationFixPass: record.validationFixPass || null,
    selfCheck: record.selfCheck || null,
    phaseTimings: record.phaseTimings || null,
    readOnlyHeadMove: record.readOnlyHeadMove || null,
    retryCount: record.retryCount || 0,
    maxRetries: record.maxRetries || 0,
    errorType: record.errorType || "",
    errorReason: record.errorReason || "",
    dependencyRequest: record.dependencyRequest || null,
    completionOutcome: record.completionOutcome || (essentialResultTruncated ? "completed_with_truncated_output" : ""),
    changedFiles: record.changedFiles || [],
    noChanges: Boolean(record.noChanges),
    dirtyFiles: record.dirtyFiles || [],
    overlappingFiles: record.overlappingFiles || [],
    disjointFiles: record.disjointFiles || [],
    validationResult: record.validationResult || null,
    configuredProvider: record.configuredProvider || "",
    configuredModel: record.configuredModel || "",
    configuredVariant: record.configuredVariant || "",
    runtimeObservedProvider: record.runtimeObservedProvider || "",
    runtimeObservedModel: record.runtimeObservedModel || "",
    actualProvider: record.actualProvider || "",
    actualModel: record.actualModel || "",
    actualModelEvidence: record.actualModelEvidence || "",
    cancellationRequested: Boolean(record.cancellationRequested),
    cancellationRequestedAt: record.cancellationRequestedAt || "",
    // B-156: the running job's hard lock (released by the recovery pass when the owner dies).
    lockId: record.lockId || "",
    // B-152: how often the job waited for its workspace (uncommitted files in its scope, the
    // worktree cap, a moving HEAD) before it ran.
    queueWorkspaceWaits: record.queueWorkspaceWaits || 0,
    ownerInstanceId: record.ownerInstanceId || "",
    ownerProcessId: record.ownerProcessId || 0,
    ownerGeneration: record.ownerGeneration || "",
    heartbeatAt: record.heartbeatAt || "",
    leaseExpiresAt: record.leaseExpiresAt || "",
    childProcessId: record.childProcessId || 0,
    childProcessStartedAt: record.childProcessStartedAt || "",
    childProcessRole: record.childProcessRole || "",
    childContainmentIdentity: record.childContainmentIdentity || "",
    containmentQuarantined: Boolean(record.containmentQuarantined),
    orphanChildProcessId: record.orphanChildProcessId || 0,
    orphanChildProcessStartedAt: record.orphanChildProcessStartedAt || "",
    orphanChildProcessAlive: Boolean(record.orphanChildProcessAlive),
    revision: record.revision || 0,
    resultText: includeResult ? truncateResultText(persistedResultText, CONFIG.queueResultMaxChars) : "",
    resultTextChars: includeResult ? Math.max(persistedResultText.length, Number(record.resultFullChars) || 0, Number(record.resultTextChars) || 0) : 0,
    resultTextSha256: includeResult ? createHash("sha256").update(persistedResultText).digest("hex") : "",
    resultTextTruncated: includeResult ? resultCut : false,
    resultDetailText: includeResult ? truncateText(persistedDetailText, CONFIG.queueResultMaxChars) : "",
    resultDetailTextChars: includeResult ? persistedDetailText.length : 0,
  });
}

function queuePrivateDetails(record) {
  const resultText = redactSensitiveText(record.resultText || "");
  const resultDetailText = redactSensitiveText(record.resultDetailText || "");
  const details = sanitizePersistedValue({
    resultText: truncateResultText(resultText, CONFIG.queueResultMaxChars),
    // A record read back keeps the original length and the truncation it was stored with.
    resultTextChars: Math.max(resultText.length, Number(record.resultFullChars) || 0, Number(record.resultTextChars) || 0),
    resultTextSha256: createHash("sha256").update(resultText).digest("hex"),
    resultTextTruncated: Boolean(record.resultReportTruncated) || Boolean(record.resultTextTruncated) || resultText.length > CONFIG.queueResultMaxChars,
    resultDetailText: truncateText(resultDetailText, CONFIG.queueResultMaxChars),
    resultDetailTextChars: resultDetailText.length,
    errorReason: truncateText(String(record.errorReason || ""), 12000),
    validationResult: record.validationResult || null,
    sanitizedWorkspaceVerification: record.sanitizedWorkspaceVerification || null,
    actualModelEvidence: record.actualModelEvidence || "",
    dependencyRequest: record.dependencyRequest || null,
  });
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, "utf8") <= CONFIG.maxSnapshotFileBytes) return details;
  return sanitizePersistedValue({
    resultText: details.resultText || "",
    resultTextChars: details.resultTextChars || 0,
    resultTextSha256: details.resultTextSha256 || "",
    resultTextTruncated: Boolean(details.resultTextTruncated),
    resultDetailText: details.resultDetailText || "",
    resultDetailTextChars: details.resultDetailTextChars || 0,
    errorReason: details.errorReason || "",
    validationResult: {
      truncated: true,
      chars: JSON.stringify(details.validationResult || null).length,
      sha256: createHash("sha256").update(JSON.stringify(details.validationResult || null)).digest("hex"),
    },
    sanitizedWorkspaceVerification: null,
    actualModelEvidence: details.actualModelEvidence || "",
    dependencyRequest: details.dependencyRequest || null,
  });
}

function queueRecordDurableSummary(record) {
  const hasRawTask = Object.prototype.hasOwnProperty.call(record || {}, "task");
  const hasRawPrivateDetails = [
    "resultText",
    "resultDetailText",
    "errorReason",
    "validationResult",
    "sanitizedWorkspaceVerification",
    "actualModelEvidence",
  ].some((key) => Object.prototype.hasOwnProperty.call(record || {}, key));
  const preservePrivateMetadata = !hasRawPrivateDetails && Boolean(record?.privateDetailsSha256);
  const summary = queueRecordSnapshot(record, false);
  const privateDetails = queuePrivateDetails(record);
  const privateJson = JSON.stringify(privateDetails);
  delete summary.resultText;
  delete summary.resultDetailText;
  delete summary.errorReason;
  delete summary.validationResult;
  delete summary.sanitizedWorkspaceVerification;
  delete summary.actualModelEvidence;
  summary.scopeContract = scopeContractDurableSummary(record.scopeContract);
  summary.resultTextChars = Number(privateDetails.resultTextChars || 0);
  summary.resultTextSha256 = privateDetails.resultTextSha256 || "";
  summary.resultTextTruncated = Boolean(privateDetails.resultTextTruncated);
  summary.resultDetailTextChars = Number(privateDetails.resultDetailTextChars || 0);
  summary.errorReasonChars = String(privateDetails.errorReason || "").length;
  summary.errorReasonSha256 = createHash("sha256").update(String(privateDetails.errorReason || "")).digest("hex");
  summary.validationResultSha256 = createHash("sha256")
    .update(JSON.stringify(privateDetails.validationResult || null))
    .digest("hex");
  if (!hasRawTask) {
    summary.taskSha256 = String(record.taskSha256 || summary.taskSha256 || "");
    summary.taskChars = Number(record.taskChars || 0);
  }
  if (preservePrivateMetadata) {
    summary.resultTextChars = Number(record.resultTextChars || 0);
    summary.resultTextSha256 = String(record.resultTextSha256 || "");
    summary.resultTextTruncated = Boolean(record.resultTextTruncated);
    summary.resultDetailTextChars = Number(record.resultDetailTextChars || 0);
    summary.errorReasonChars = Number(record.errorReasonChars || 0);
    summary.errorReasonSha256 = String(record.errorReasonSha256 || "");
    summary.validationResultSha256 = String(record.validationResultSha256 || "");
  }
  return sanitizePersistedValue({
    ...summary,
    privateDetailsChars: preservePrivateMetadata ? Number(record.privateDetailsChars || 0) : privateJson.length,
    privateDetailsSha256: preservePrivateMetadata
      ? String(record.privateDetailsSha256 || "")
      : createHash("sha256").update(privateJson).digest("hex"),
  });
}

async function encryptQueuePrivateDetails(record) {
  return encryptIntegrationJournalBytes(
    Buffer.from(JSON.stringify(queuePrivateDetails(record)), "utf8"),
    `queue-result\0${record.jobId}`
  );
}

async function decryptQueuePrivateDetails(envelope, jobId) {
  if (!envelope) return {};
  return JSON.parse((await decryptIntegrationJournalBytes(envelope, `queue-result\0${jobId}`)).toString("utf8"));
}

function enforceQueueResultEvidence(record) {
  const persistedResultText = redactSensitiveText(record.resultText || "");
  const completedWithoutFinal = record.status === "completed" && !persistedResultText.trim();
  // A writer whose verified worktree diff was empty (noChanges) legitimately has no changed
  // files or patch hash: the empty worktree is removed and there is nothing to integrate.
  // Failing it here made a successful "nothing needed" run fail its pipeline.
  const completedWriteWithoutEvidence = record.status === "completed"
    && record.mode === "write"
    && !record.noChanges
    && !(record.changedFiles || []).length
    && !record.worktreePatchSha256;
  if (completedWithoutFinal || completedWriteWithoutEvidence) {
    Object.assign(record, {
      status: "failed",
      errorType: completedWithoutFinal ? "completion_evidence_missing" : "write_completion_evidence_missing",
      errorReason: completedWithoutFinal
        ? "A completed job must include a non-empty verified final response."
        : "A completed write job must include changed-file or patch evidence.",
    });
  } else if (record.status === "completed" && (record.resultReportTruncated || persistedResultText.length > CONFIG.queueResultMaxChars)) {
    // Only a cut report (or an unstructured text over the limit) is truncated output; the patch
    // preview kept apart in resultDetailText is not.
    record.completionOutcome = "completed_with_truncated_output";
  } else if (record.status === "completed" && record.mode === "write" && record.noChanges && !record.completionOutcome) {
    // Still a success ("nothing needed" is legitimate), but a writer that changed nothing is
    // flagged so a list of finished batch jobs does not hide it among the real outputs.
    record.completionOutcome = "completed_no_changes";
  } else if (record.status === "failed" && record.mode === "write" && !record.completionOutcome
    && (record.errorType === "agent_timeout" || record.errorType === "agent_idle_timeout") && (record.changedFiles || []).length) {
    // B-044: failed, but not empty-handed: the worktree holds changes to inspect or integrate.
    record.completionOutcome = "timed_out_with_changes";
  }
  return record;
}

function persistedQueueRecordFromRow(row) {
  let snapshot = {};
  try {
    snapshot = row?.record_json ? JSON.parse(row.record_json) : {};
  } catch {
    snapshot = {};
  }
  return {
    ...snapshot,
    status: row ? row.status : snapshot.status || "",
    startedAt: row ? row.started_at || "" : snapshot.startedAt || "",
    finishedAt: row ? row.finished_at || "" : snapshot.finishedAt || "",
    ownerInstanceId: row ? row.owner_instance_id || "" : snapshot.ownerInstanceId || "",
    ownerProcessId: row ? row.owner_process_id || 0 : snapshot.ownerProcessId || 0,
    ownerGeneration: row ? row.owner_generation || "" : snapshot.ownerGeneration || "",
    heartbeatAt: row ? row.heartbeat_at || "" : snapshot.heartbeatAt || "",
    leaseExpiresAt: row ? row.lease_expires_at || "" : snapshot.leaseExpiresAt || "",
    cancellationRequested: row ? Boolean(row.cancellation_requested_at) : Boolean(snapshot.cancellationRequestedAt),
    cancellationRequestedAt: row ? row.cancellation_requested_at || "" : snapshot.cancellationRequestedAt || "",
    childProcessId: row ? row.child_process_id || 0 : snapshot.childProcessId || 0,
    childProcessStartedAt: row ? row.child_process_started_at || "" : snapshot.childProcessStartedAt || "",
    revision: row ? row.revision || 0 : snapshot.revision || 0,
    idempotencyKey: row ? row.idempotency_key || snapshot.idempotencyKey || "" : snapshot.idempotencyKey || "",
  };
}

function loadPersistedQueueRecord(record, row) {
  if (row) {
    Object.assign(record, persistedQueueRecordFromRow(row));
  }
  return record;
}

const DURABLE_CANCELLATION_REASON = "Cancellation won the durable terminal-write race.";

function applyDurableCancellationOutcome(record, requestedAt = "") {
  return {
    ...record,
    status: "cancelled",
    cancellationRequested: true,
    cancellationRequestedAt: requestedAt || record.cancellationRequestedAt || "",
    errorType: "agent_cancelled",
    // B-126: the reason a specific stop gave (the queue worker's --now) outlives the race.
    errorReason: record.cancellationReason || DURABLE_CANCELLATION_REASON,
    resultText: "",
    resultDetailText: "",
    resultReportTruncated: false,
    resultFullChars: 0,
    resultTextChars: 0,
    resultTextTruncated: false,
    validationResult: null,
    sanitizedWorkspaceVerification: null,
    actualModelEvidence: "",
  };
}

async function cancelPersistedQueueJob(db, jobId, maxAttempts = 8) {
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted", "not_resumable"]);
  const preExecutionStatuses = new Set(["held", "pending", "planned", "blocked"]);
  const activeStatuses = new Set(["running", "validating", "reviewing", "testing"]);
  const selectCurrent = db.prepare(`
    SELECT job_id, status, started_at, finished_at, owner_instance_id, owner_process_id, owner_generation,
           heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id,
           child_process_started_at, revision, idempotency_key, request_encrypted, result_encrypted, record_json
    FROM opencode_jobs WHERE job_id = ?
  `);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const row = selectCurrent.get(jobId);
    if (!row) return { ok: false, outcome: "missing", status: "missing" };
    if (terminalStatuses.has(row.status)) {
      return { ok: true, outcome: "already_terminal", status: row.status };
    }
    if (!preExecutionStatuses.has(row.status) && !activeStatuses.has(row.status)) {
      return { ok: false, outcome: "unsupported_status", status: row.status };
    }

    const requestedAt = row.cancellation_requested_at || new Date().toISOString();
    const currentRecord = {
      ...persistedQueueRecordFromRow(row),
      jobId,
      revision: Number(row.revision || 0),
    };
    const preExecution = preExecutionStatuses.has(row.status);
    const nextRecord = preExecution
      ? {
          ...applyDurableCancellationOutcome(currentRecord, requestedAt),
          status: "cancelled",
          finishedAt: requestedAt,
          heartbeatAt: "",
          leaseExpiresAt: "",
          childProcessId: 0,
          childProcessStartedAt: "",
          revision: Number(row.revision || 0) + 1,
        }
      : {
          ...currentRecord,
          cancellationRequested: true,
          cancellationRequestedAt: requestedAt,
          revision: Number(row.revision || 0) + 1,
        };
    const recordJson = JSON.stringify(queueRecordDurableSummary(nextRecord));
    const encryptedDetails = preExecution ? await encryptQueuePrivateDetails(nextRecord) : null;
    const queueCancellationTestHook = getQueueCancellationTestHook();
    if (typeof queueCancellationTestHook === "function") {
      await queueCancellationTestHook({ attempt, row: { ...row }, nextRecord: { ...nextRecord } });
    }
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const changed = preExecution
        ? db.prepare(`
            UPDATE opencode_jobs
            SET status = 'cancelled', finished_at = ?, cancellation_requested_at = ?, updated_at = ?,
                heartbeat_at = '', lease_expires_at = '', child_process_id = 0, child_process_started_at = '',
                record_json = ?, result_encrypted = ?, revision = revision + 1
            WHERE job_id = ? AND status = ? AND revision = ?
              AND COALESCE(owner_instance_id, '') = ? AND COALESCE(owner_generation, '') = ?
          `).run(
            requestedAt,
            requestedAt,
            requestedAt,
            recordJson,
            encryptedDetails,
            jobId,
            row.status,
            Number(row.revision || 0),
            row.owner_instance_id || "",
            row.owner_generation || ""
          )
        : db.prepare(`
            UPDATE opencode_jobs
            SET cancellation_requested_at = CASE
                  WHEN cancellation_requested_at IS NULL OR cancellation_requested_at = '' THEN ?
                  ELSE cancellation_requested_at
                END,
                updated_at = ?, record_json = ?, revision = revision + 1
            WHERE job_id = ? AND status = ? AND revision = ?
              AND COALESCE(owner_instance_id, '') = ? AND COALESCE(owner_generation, '') = ?
          `).run(
            requestedAt,
            requestedAt,
            recordJson,
            jobId,
            row.status,
            Number(row.revision || 0),
            row.owner_instance_id || "",
            row.owner_generation || ""
          );
      const pipelinePropagation = Number(changed.changes || 0) === 1 && preExecution
        ? propagatePipelineTerminalInTransaction(db, jobId, "cancelled", requestedAt)
        : null;
      db.exec("COMMIT");
      transactionOpen = false;
      if (Number(changed.changes || 0) === 1) {
        return {
          ok: true,
          outcome: preExecution ? "cancelled" : "cancellation_requested",
          status: preExecution ? "cancelled" : row.status,
          requestedAt,
          revision: Number(row.revision || 0) + 1,
          pipelinePropagation,
        };
      }
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the cancellation error. */ }
      }
      throw error;
    }
  }
  const current = selectCurrent.get(jobId);
  return {
    ok: false,
    outcome: "contention",
    status: current?.status || "missing",
  };
}

// Lease renewal bumps the row revision without touching record_json. A terminal commit
// built from a copy taken before that bump used to lose its exact-revision compare, mark
// ownership lost and drop the job from QUEUE_JOBS, so it stayed "running" forever while
// the owning bridge lived. A bump that only a heartbeat made is not a competing write.
function heartbeatOnlyQueueAdvance(current, record, attemptedRevision) {
  if (!current
    || current.owner_instance_id !== BRIDGE_INSTANCE_ID
    || !record.ownerGeneration
    || String(current.owner_generation || "") !== String(record.ownerGeneration)
    || Number(current.revision || 0) <= attemptedRevision) return false;
  try {
    const summary = JSON.parse(current.record_json || "{}");
    const summaryRevision = Number(summary.revision ?? -1);
    return summaryRevision >= 0 && summaryRevision <= attemptedRevision && String(summary.status || "") === current.status;
  } catch {
    return false;
  }
}

function persistTerminalQueueRecord(db, record) {
  const activeStatuses = "'running', 'validating', 'reviewing', 'testing'";
  let attemptedRevision = Number(record.revision || 0);
  const attemptedOwnerGeneration = String(record.ownerGeneration || "");
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
    if (heartbeatOnlyQueueAdvance(current, record, attemptedRevision)) attemptedRevision = Number(current.revision || 0);
    const terminalRecord = {
      ...record,
      ownerInstanceId: current?.owner_instance_id || record.ownerInstanceId || "",
      ownerProcessId: current?.owner_process_id || record.ownerProcessId || 0,
      ownerGeneration: current?.owner_generation || record.ownerGeneration || "",
      revision: attemptedRevision + 1,
    };
    if (current
      && ["held", "pending", "planned", "blocked"].includes(current.status)
      && current.owner_instance_id === BRIDGE_INSTANCE_ID
      && String(current.owner_generation || "") === String(record.ownerGeneration || "")
      && ["failed", "cancelled"].includes(record.status)) {
      Object.assign(terminalRecord, {
        finishedAt: terminalRecord.finishedAt || new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
        childProcessId: 0,
        childProcessStartedAt: "",
      });
      if (current.cancellation_requested_at) {
        Object.assign(terminalRecord, applyDurableCancellationOutcome(terminalRecord, current.cancellation_requested_at));
      }
      const preExecutionChange = db.prepare(`
        UPDATE opencode_jobs
        SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, heartbeat_at = '', lease_expires_at = '',
            child_process_id = 0, child_process_started_at = '', record_json = ?, result_encrypted = ?, revision = revision + 1
        WHERE job_id = ? AND status = ? AND revision = ?
          AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
      `).run(
        terminalRecord.status,
        terminalRecord.startedAt || "",
        terminalRecord.finishedAt,
        new Date().toISOString(),
        JSON.stringify(queueRecordDurableSummary(terminalRecord)),
        terminalRecord.status === "cancelled"
          ? record.cancellationResultEncrypted || null
          : record.resultEncrypted || null,
        terminalRecord.jobId,
        current.status,
        attemptedRevision,
        BRIDGE_INSTANCE_ID,
        attemptedOwnerGeneration
      );
      if (Number(preExecutionChange.changes || 0) === 1) {
        record.pipelinePropagation = propagatePipelineTerminalInTransaction(
          db,
          terminalRecord.jobId,
          terminalRecord.status,
          terminalRecord.finishedAt || new Date().toISOString()
        );
        db.exec("COMMIT");
        transactionOpen = false;
        Object.assign(record, terminalRecord);
        return { persisted: true, status: terminalRecord.status, cancellationWon: terminalRecord.status === "cancelled" };
      }
      current = selectCurrent.get(record.jobId);
    }
    // No lease predicate: a lapsed lease is not a lost one. A takeover always writes a new
    // generation and every foreign write bumps the revision, so generation + revision fence a
    // stale owner; requiring an unexpired lease left a finished job "running" forever after
    // its lease lapsed (the owner instance stays alive, so recovery never reclaimed it).
    const terminalCommitAt = new Date().toISOString();
    const terminalChange = db.prepare(`
      UPDATE opencode_jobs
      SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
          child_process_id = ?, child_process_started_at = ?, record_json = ?, result_encrypted = ?, revision = revision + 1
      WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ?
        AND owner_generation <> ''
        AND revision = ?
        AND status IN (${activeStatuses})
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
        AND EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      terminalRecord.status,
      terminalRecord.startedAt || "",
      terminalRecord.finishedAt || "",
      new Date().toISOString(),
      terminalRecord.heartbeatAt || "",
      terminalRecord.leaseExpiresAt || "",
      terminalRecord.childProcessId || 0,
      terminalRecord.childProcessStartedAt || "",
      JSON.stringify(queueRecordDurableSummary(terminalRecord)),
      record.resultEncrypted || null,
      terminalRecord.jobId,
      BRIDGE_INSTANCE_ID,
      attemptedOwnerGeneration,
      attemptedRevision,
      terminalCommitAt
    );
    if (Number(terminalChange.changes || 0) === 1) {
      record.pipelinePropagation = propagatePipelineTerminalInTransaction(
        db,
        terminalRecord.jobId,
        terminalRecord.status,
        terminalRecord.finishedAt || new Date().toISOString()
      );
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, terminalRecord);
      return { persisted: true, status: terminalRecord.status, cancellationWon: false };
    }

    current = selectCurrent.get(record.jobId);
    const ownsCurrentGeneration = current
      && current.owner_instance_id === BRIDGE_INSTANCE_ID
      && String(current.owner_generation || "") === attemptedOwnerGeneration;
    if (ownsCurrentGeneration
      && ["running", "validating", "reviewing", "testing"].includes(current.status)
      && current.cancellation_requested_at) {
      const cancelledRecord = {
        ...applyDurableCancellationOutcome(record, current.cancellation_requested_at),
        finishedAt: record.finishedAt || new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
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
            child_process_id = 0, child_process_started_at = '', record_json = ?, result_encrypted = ?, revision = revision + 1
        WHERE job_id = ? AND owner_instance_id = ? AND owner_generation = ?
          AND owner_generation <> ''
          AND revision = ?
          AND status IN (${activeStatuses})
          AND cancellation_requested_at IS NOT NULL AND cancellation_requested_at <> ''
      `).run(
        cancelledRecord.startedAt || "",
        cancelledRecord.finishedAt,
        new Date().toISOString(),
        JSON.stringify(queueRecordDurableSummary(cancelledRecord)),
        record.cancellationResultEncrypted || null,
        cancelledRecord.jobId,
        BRIDGE_INSTANCE_ID,
        attemptedOwnerGeneration,
        Number(current.revision || 0)
      );
      if (Number(cancellationChange.changes || 0) === 1) {
        record.pipelinePropagation = propagatePipelineTerminalInTransaction(
          db,
          cancelledRecord.jobId,
          cancelledRecord.status,
          cancelledRecord.finishedAt || new Date().toISOString()
        );
        db.exec("COMMIT");
        transactionOpen = false;
        Object.assign(record, cancelledRecord);
        return { persisted: true, status: "cancelled", cancellationWon: true };
      }
      current = selectCurrent.get(record.jobId);
    }

    db.exec("COMMIT");
    transactionOpen = false;
    const ownershipLost = Boolean(current) && (
      current.owner_instance_id !== BRIDGE_INSTANCE_ID
      || String(current.owner_generation || "") !== attemptedOwnerGeneration
      || Number(current.revision || 0) !== attemptedRevision
    );
    loadPersistedQueueRecord(record, current);
    return {
      persisted: false,
      status: current?.status || "missing",
      cancellationWon: Boolean(current?.cancellation_requested_at),
      ownershipLost,
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the terminal persistence error. */ }
    }
    throw error;
  }
}

async function persistQueueRecord(record) {
  enforceQueueResultEvidence(record);
  const queuePersistTestHook = getQueuePersistTestHook();
  if (typeof queuePersistTestHook === "function") await queuePersistTestHook(record);
  if (effectiveQueueMode() !== "sqlite") {
    record.revision = Number(record.revision || 0) + 1;
    return { persisted: true, status: record.status };
  }

  record.resultEncrypted = await encryptQueuePrivateDetails(record);
  record.cancellationResultEncrypted = await encryptQueuePrivateDetails(applyDurableCancellationOutcome(record));

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
      const capacity = stateCapacityError(db);
      if (capacity) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { persisted: false, ...capacity };
      }
      try {
        db.prepare(`
        INSERT INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
         owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at, cancellation_requested_at,
         child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted, result_encrypted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.jobId,
        record.cwd || "",
        record.status,
        record.agent,
        record.mode,
        record.createdAt,
        record.startedAt || "",
        record.finishedAt || "",
        JSON.stringify(queueRecordDurableSummary(record)),
        record.ownerInstanceId || "",
        record.ownerProcessId || 0,
        record.ownerGeneration || "",
        new Date().toISOString(),
        record.heartbeatAt || "",
        record.leaseExpiresAt || "",
        record.cancellationRequestedAt || "",
        record.childProcessId || 0,
        record.childProcessStartedAt || "",
        Number(record.revision || 0),
        record.idempotencyKey || null,
        record.requestEncrypted || null,
        record.resultEncrypted || null
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

    let currentRevision = Number(current.revision || 0);
    const sameOwner = current.owner_instance_id === BRIDGE_INSTANCE_ID
      && String(current.owner_generation || "") === String(record.ownerGeneration || "")
      && Boolean(record.ownerGeneration);
    const currentTerminal = ["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(current.status);
    let currentSummaryRevision = -1;
    let currentSummaryStatus = "";
    try {
      const currentSummary = JSON.parse(current.record_json || "{}");
      currentSummaryRevision = Number(currentSummary.revision ?? -1);
      currentSummaryStatus = String(currentSummary.status || "");
    } catch { /* Fail closed below. */ }
    const attemptedRevision = Number(record.revision || 0);
    const heartbeatOnlyAdvance = sameOwner
      && currentRevision > attemptedRevision
      && currentSummaryRevision >= 0
      && currentSummaryRevision <= attemptedRevision
      && currentSummaryStatus === current.status;
    if (heartbeatOnlyAdvance) {
      Object.assign(record, {
        revision: currentRevision,
        heartbeatAt: current.heartbeat_at || record.heartbeatAt || "",
        leaseExpiresAt: current.lease_expires_at || record.leaseExpiresAt || "",
      });
    }
    if (currentTerminal || !sameOwner || (currentRevision !== attemptedRevision && !heartbeatOnlyAdvance)) {
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
    const updateAt = new Date().toISOString();
    const changed = db.prepare(`
      UPDATE opencode_jobs
      SET cwd = ?, status = ?, agent = ?, mode = ?, started_at = ?, finished_at = ?, record_json = ?,
          owner_instance_id = ?, owner_process_id = ?, owner_generation = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
          cancellation_requested_at = CASE
            WHEN cancellation_requested_at IS NULL OR cancellation_requested_at = '' THEN ?
            ELSE cancellation_requested_at
          END,
          child_process_id = ?, child_process_started_at = ?, result_encrypted = ?, revision = revision + 1
      WHERE job_id = ? AND status = ? AND revision = ?
        AND owner_instance_id = ? AND owner_generation = ? AND owner_generation <> ''
        AND lease_expires_at > ?
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
        AND EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      nextRecord.cwd || "",
      nextRecord.status,
      nextRecord.agent,
      nextRecord.mode,
      nextRecord.startedAt || "",
      nextRecord.finishedAt || "",
      JSON.stringify(queueRecordDurableSummary(nextRecord)),
      nextRecord.ownerInstanceId || "",
      nextRecord.ownerProcessId || 0,
      nextRecord.ownerGeneration || "",
      updateAt,
      nextRecord.heartbeatAt || "",
      nextRecord.leaseExpiresAt || "",
      nextRecord.cancellationRequestedAt || "",
      nextRecord.childProcessId || 0,
      nextRecord.childProcessStartedAt || "",
      record.resultEncrypted || null,
      nextRecord.jobId,
      current.status,
      currentRevision,
      BRIDGE_INSTANCE_ID,
      record.ownerGeneration || "",
      updateAt,
      updateAt
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
  const candidate = { ...record, ...patch };
  const result = await persistQueueRecord(candidate);
  const runtimeState = {
    abortController: record.abortController,
    executionPromise: record.executionPromise,
    queueLeaseFenceTimer: record.queueLeaseFenceTimer,
    queueOwnershipLost: record.queueOwnershipLost,
  };
  if (Number(record.revision || 0) > Number(candidate.revision || 0)
    && record.ownerGeneration === candidate.ownerGeneration) {
    candidate.revision = record.revision;
    candidate.heartbeatAt = record.heartbeatAt;
    candidate.leaseExpiresAt = record.leaseExpiresAt;
  }
  Object.assign(record, candidate);
  Object.assign(record, runtimeState);
  return result;
}

async function readPersistedQueueRecord(jobId, cwd = "") {
  if (effectiveQueueMode() !== "sqlite") {
    return null;
  }

  const db = await openLockDb(cwd);
  try {
    const row = db.prepare(`
      SELECT status, finished_at, heartbeat_at, lease_expires_at, cancellation_requested_at,
             child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted,
             result_encrypted, record_json
      FROM opencode_jobs WHERE job_id = ?
    `).get(jobId);
    if (!row?.record_json) return null;
    const privateDetails = row.result_encrypted
      ? await decryptQueuePrivateDetails(row.result_encrypted, jobId)
      : {};
    return {
      ...JSON.parse(row.record_json),
      ...privateDetails,
      privateDetailsAvailable: Boolean(row.result_encrypted),
      status: row.status,
      finishedAt: row.finished_at || "",
      heartbeatAt: row.heartbeat_at || "",
      leaseExpiresAt: row.lease_expires_at || "",
      cancellationRequested: Boolean(row.cancellation_requested_at),
      cancellationRequestedAt: row.cancellation_requested_at || "",
      childProcessId: row.child_process_id || 0,
      childProcessStartedAt: row.child_process_started_at || "",
      revision: row.revision || 0,
    };
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

async function authoritativeQueueRecord(jobId, cwd = "") {
  if (effectiveQueueMode() !== "sqlite") return QUEUE_JOBS.get(jobId) || null;
  return await readPersistedQueueRecord(jobId, cwd);
}

  return { queueRecordSnapshot, queuePrivateDetails, queueRecordDurableSummary, encryptQueuePrivateDetails, decryptQueuePrivateDetails, enforceQueueResultEvidence, persistedQueueRecordFromRow, loadPersistedQueueRecord, applyDurableCancellationOutcome, cancelPersistedQueueJob, heartbeatOnlyQueueAdvance, persistTerminalQueueRecord, persistQueueRecord, updateQueueRecordDurable, readPersistedQueueRecord, listPersistedQueueRecords, authoritativeQueueRecord };
}
