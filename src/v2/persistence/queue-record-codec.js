import { createHash } from "node:crypto";

import {
  redactSensitiveText as defaultRedactSensitiveText,
  sanitizePersistedValue as defaultSanitizePersistedValue,
} from "../security/redaction.js";

function defaultTruncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
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

  return {
    queueRecordSnapshot,
    enforceQueueResultEvidence,
    persistedQueueRecordFromRow,
    loadPersistedQueueRecord,
  };
}
