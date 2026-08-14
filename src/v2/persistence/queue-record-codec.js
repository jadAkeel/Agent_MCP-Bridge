import { createHash } from "node:crypto";

import {
  redactSensitiveText as defaultRedactSensitiveText,
  sanitizePersistedValue as defaultSanitizePersistedValue,
} from "../security/redaction.js";

function defaultTruncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

const QUEUE_RECORD_SNAPSHOT_KEYS = Object.freeze([
  "jobId",
  "parentJobId",
  "idempotencyKey",
  "requestFingerprint",
  "agent",
  "taskSha256",
  "taskChars",
  "cwd",
  "mode",
  "scopeContract",
  "sanitizedWorkspace",
  "sanitizedWorkspaceVerification",
  "lockMode",
  "lockedPaths",
  "allowedEdits",
  "worktreePath",
  "worktreeBranch",
  "worktreeBaseCommit",
  "worktreeBaseTree",
  "worktreePatchSha256",
  "worktreeSourceStateSha256",
  "status",
  "createdAt",
  "startedAt",
  "finishedAt",
  "durationMs",
  "retryCount",
  "maxRetries",
  "errorType",
  "errorReason",
  "completionOutcome",
  "changedFiles",
  "noChanges",
  "dirtyFiles",
  "overlappingFiles",
  "disjointFiles",
  "validationResult",
  "configuredProvider",
  "configuredModel",
  "configuredVariant",
  "runtimeObservedProvider",
  "runtimeObservedModel",
  "actualProvider",
  "actualModel",
  "actualModelEvidence",
  "cancellationRequested",
  "cancellationRequestedAt",
  "ownerInstanceId",
  "ownerProcessId",
  "ownerGeneration",
  "heartbeatAt",
  "leaseExpiresAt",
  "childProcessId",
  "childProcessStartedAt",
  "revision",
  "resultText",
  "resultTextChars",
  "resultTextSha256",
  "resultTextTruncated",
  "orphanChildProcessId",
  "orphanChildProcessStartedAt",
  "orphanChildProcessAlive",
]);

function defineEnumerableDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createQueueRecordCodec({
  config,
  redactSensitiveText = defaultRedactSensitiveText,
  sanitizePersistedValue = defaultSanitizePersistedValue,
  truncateText = defaultTruncateText,
} = {}) {
  const CONFIG = config;

  function queueRecordSnapshot(record, includeResult = true) {
    const persistedResultText = redactSensitiveText(record.resultText || "");
    const essentialResultTruncated = record.status === "completed"
      && persistedResultText.length > CONFIG.queueResultMaxChars;
    return sanitizePersistedValue({
      jobId: record.jobId,
      parentJobId: record.parentJobId || "",
      idempotencyKey: record.idempotencyKey || "",
      requestFingerprint: record.requestFingerprint || "",
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
      createdAt: record.createdAt,
      startedAt: record.startedAt || "",
      finishedAt: record.finishedAt || "",
      durationMs: record.durationMs || 0,
      retryCount: record.retryCount || 0,
      maxRetries: record.maxRetries || 0,
      errorType: record.errorType || "",
      errorReason: record.errorReason || "",
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
      ownerInstanceId: record.ownerInstanceId || "",
      ownerProcessId: record.ownerProcessId || 0,
      ownerGeneration: record.ownerGeneration || "",
      heartbeatAt: record.heartbeatAt || "",
      leaseExpiresAt: record.leaseExpiresAt || "",
      childProcessId: record.childProcessId || 0,
      childProcessStartedAt: record.childProcessStartedAt || "",
      revision: record.revision || 0,
      resultText: includeResult ? truncateText(persistedResultText, CONFIG.queueResultMaxChars) : "",
      resultTextChars: includeResult ? persistedResultText.length : 0,
      resultTextSha256: includeResult ? createHash("sha256").update(persistedResultText).digest("hex") : "",
      resultTextTruncated: includeResult ? persistedResultText.length > CONFIG.queueResultMaxChars : false,
    });
  }

  function enforceQueueResultEvidence(record) {
    const persistedResultText = redactSensitiveText(record.resultText || "");
    const completedWithoutFinal = record.status === "completed" && !persistedResultText.trim();
    const completedWriteWithoutEvidence = record.status === "completed"
      && record.mode === "write"
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
    } else if (record.status === "completed" && persistedResultText.length > CONFIG.queueResultMaxChars) {
      record.completionOutcome = "completed_with_truncated_output";
    }
    return record;
  }

  function tryPersistedQueueRecordFromRow(row) {
    let decoded = null;
    let ok = false;
    try {
      decoded = row?.record_json ? JSON.parse(row.record_json) : null;
      ok = isPlainRecord(decoded);
    } catch {
      decoded = null;
    }

    const selected = {};
    if (ok) {
      for (const key of QUEUE_RECORD_SNAPSHOT_KEYS) {
        if (Object.hasOwn(decoded, key)) {
          defineEnumerableDataProperty(selected, key, decoded[key]);
        }
      }
    }
    const sanitized = sanitizePersistedValue(selected);
    const record = {};
    for (const [key, value] of Object.entries(sanitized)) {
      defineEnumerableDataProperty(record, key, value);
    }

    const hasColumn = (column) => Boolean(row && Object.hasOwn(row, column));
    if (hasColumn("job_id")) defineEnumerableDataProperty(record, "jobId", row.job_id || "");
    if (hasColumn("cwd")) defineEnumerableDataProperty(record, "cwd", row.cwd || "");
    if (hasColumn("agent")) defineEnumerableDataProperty(record, "agent", row.agent || "");
    if (hasColumn("mode")) defineEnumerableDataProperty(record, "mode", row.mode || "");
    if (hasColumn("created_at")) defineEnumerableDataProperty(record, "createdAt", row.created_at || "");
    defineEnumerableDataProperty(record, "status", hasColumn("status") ? row.status || "" : record.status || "");
    defineEnumerableDataProperty(record, "startedAt", hasColumn("started_at") ? row.started_at || "" : record.startedAt || "");
    defineEnumerableDataProperty(record, "finishedAt", hasColumn("finished_at") ? row.finished_at || "" : record.finishedAt || "");
    defineEnumerableDataProperty(record, "ownerInstanceId", hasColumn("owner_instance_id") ? row.owner_instance_id || "" : record.ownerInstanceId || "");
    defineEnumerableDataProperty(record, "ownerProcessId", hasColumn("owner_process_id") ? row.owner_process_id || 0 : record.ownerProcessId || 0);
    defineEnumerableDataProperty(record, "ownerGeneration", hasColumn("owner_generation") ? row.owner_generation || "" : record.ownerGeneration || "");
    defineEnumerableDataProperty(record, "heartbeatAt", hasColumn("heartbeat_at") ? row.heartbeat_at || "" : record.heartbeatAt || "");
    defineEnumerableDataProperty(record, "leaseExpiresAt", hasColumn("lease_expires_at") ? row.lease_expires_at || "" : record.leaseExpiresAt || "");
    defineEnumerableDataProperty(record, "cancellationRequested", hasColumn("cancellation_requested_at")
      ? Boolean(row.cancellation_requested_at)
      : Boolean(record.cancellationRequestedAt));
    defineEnumerableDataProperty(record, "cancellationRequestedAt", hasColumn("cancellation_requested_at")
      ? row.cancellation_requested_at || ""
      : record.cancellationRequestedAt || "");
    defineEnumerableDataProperty(record, "childProcessId", hasColumn("child_process_id") ? row.child_process_id || 0 : record.childProcessId || 0);
    defineEnumerableDataProperty(record, "childProcessStartedAt", hasColumn("child_process_started_at")
      ? row.child_process_started_at || ""
      : record.childProcessStartedAt || "");
    defineEnumerableDataProperty(record, "revision", hasColumn("revision") ? row.revision || 0 : record.revision || 0);
    defineEnumerableDataProperty(record, "idempotencyKey", hasColumn("idempotency_key")
      ? row.idempotency_key || record.idempotencyKey || ""
      : record.idempotencyKey || "");
    return { ok, record };
  }

  function persistedQueueRecordFromRow(row) {
    return tryPersistedQueueRecordFromRow(row).record;
  }

  function loadPersistedQueueRecord(record, row) {
    if (row) {
      for (const [key, value] of Object.entries(persistedQueueRecordFromRow(row))) {
        defineEnumerableDataProperty(record, key, value);
      }
    }
    return record;
  }

  return {
    queueRecordSnapshot,
    enforceQueueResultEvidence,
    tryPersistedQueueRecordFromRow,
    persistedQueueRecordFromRow,
    loadPersistedQueueRecord,
  };
}
