// Pipeline snapshots, persistence keys, and integration outcome classification.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { normalizeFilesystemCase } from "./paths.js";
import { sanitizePersistedValue } from "./redaction.js";

export function pipelineRecordSnapshot(record) {
  const finalValidationSource = record.finalValidationSource
    || (record.policy?.path && record.finalValidationCommand ? "legacy_unknown" : "none");
  return sanitizePersistedValue({
    pipelineId: record.pipelineId,
    revision: Number(record.revision || 0),
    ownerInstanceId: record.ownerInstanceId || "",
    ownerGeneration: record.ownerGeneration || "",
    ownerHeartbeatAt: record.ownerHeartbeatAt || "",
    ownerLeaseExpiresAt: record.ownerLeaseExpiresAt || "",
    name: record.name || "",
    cwd: record.cwd || "",
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt || "",
    finishedAt: record.finishedAt || "",
    strategy: record.strategy || "queue",
    requiresWorktrees: Boolean(record.requiresWorktrees),
    policy: record.policy || null,
    jobs: record.jobs || [],
    lockPlans: record.lockPlans || [],
    queueJobIds: record.queueJobIds || [],
    expectedChildCount: Number(record.expectedChildCount || 0),
    batchState: record.batchState || "unstarted",
    cleanupState: record.cleanupState || "none",
    queueMode: record.queueMode || "legacy",
    integrationQueue: record.integrationQueue || [],
    finalValidationCommand: record.finalValidationCommand || "",
    finalValidationSource,
    finalValidationSpec: record.finalValidationSpec || null,
    finalValidationResult: record.finalValidationResult || null,
    reviewerJob: record.reviewerJob || null,
    reviewerResult: record.reviewerResult || null,
    testerJob: record.testerJob || null,
    testerResult: record.testerResult || null,
    sourceCleanupResults: record.sourceCleanupResults || [],
    cleanupPending: Boolean(record.cleanupPending),
    events: record.events || [],
    errors: record.errors || [],
    sanitizedWorkspace: record.sanitizedWorkspace || null,
    sanitizedWorkspaceAttestation: record.sanitizedWorkspaceAttestation || null,
  });
}

export function pipelineReplayRequest(record) {
  return {
    jobs: record.jobs || [],
    reviewerJob: record.reviewerJob || null,
    testerJob: record.testerJob || null,
    finalValidationCommand: record.finalValidationCommand || "",
  };
}

export function pipelinePersistenceKey(record) {
  return JSON.stringify([record.cwd || "", record.pipelineId]);
}

export function pipelineConcurrentUpdateError(snapshot, authoritative = null) {
  const error = new Error(`Pipeline ${snapshot.pipelineId} changed in another process; the stale update was rejected.`);
  error.code = "pipeline_concurrent_update";
  error.errorType = "pipeline_concurrent_update";
  error.authoritative = authoritative;
  return error;
}

export function pipelineRecordJson(snapshot) {
  const { requestEncrypted, detailsEncrypted, ...summary } = snapshot;
  return JSON.stringify(sanitizePersistedValue(summary));
}

export function pipelineTerminalError(record) {
  const error = new Error(`Pipeline ${record?.pipelineId || "unknown"} is ${record?.status}; it does not integrate any more.`);
  error.code = "pipeline_terminal";
  error.errorType = "pipeline_terminal";
  return error;
}

// Pipeline items are named by their retained worktree or branch. On a case-insensitive
// filesystem the caller may spell the same worktree with different case or slashes.
export function pipelineIntegrationItemMatches(record, item, { worktreePath = "", branch = "" } = {}) {
  const cwd = record?.cwd || "";
  const sameWorktree = Boolean(worktreePath && item?.worktreePath)
    && normalizeFilesystemCase(path.resolve(item.worktreePath), cwd) === normalizeFilesystemCase(path.resolve(worktreePath), cwd);
  const sameBranch = Boolean(branch) && item?.branch === branch;
  return sameWorktree || sameBranch;
}

export const PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES = new Set([
  "forbidden_file_changed",
  "changed_file_validation_error",
  "shared_file_parallel_write",
  "serial_only_parallel_write",
]);

// Only a result that says this exact source can never be integrated rejects its item: the
// source changed after the writer completed, its patch conflicts with the target, or the
// patch itself touches paths outside its contract. The same scope types after an apply
// (appliedFiles present) mean another process wrote the checkout during it, which a retry
// can clear, as can every lock, dirty-target, stale-preview, review, validation and journal
// outcome.
function pipelineIntegrationFailureIsDefinitive(result) {
  const errorType = String(result?.errorType || "");
  if (["pipeline_source_identity_changed", "integration_merge_conflict", "empty_allowed_edits"].includes(errorType)) return true;
  return PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES.has(errorType) && !Array.isArray(result?.appliedFiles);
}

export function nextPipelineIntegrationItemStatus(item, result, { dryRun = false } = {}) {
  // A dry run never prepares a journal operation, so it cannot change what the item is.
  if (dryRun) return item.status;
  if (result?.ok && ["applied", "no_changes"].includes(result.status)) return "integrated";
  if (result?.ok) return item.status === "integrating" ? "pending" : item.status;
  if (result?.errorType === "integration_recovery_quarantined") {
    const quarantinedOperations = [result.operationId, ...(result.operationIds || [])].filter(Boolean);
    return item.operationId && quarantinedOperations.includes(item.operationId) ? "quarantined" : "pending";
  }
  return pipelineIntegrationFailureIsDefinitive(result) ? "rejected" : "pending";
}

export function pipelineHasPendingIntegrations(record) {
  const queue = record.integrationQueue || [];
  return queue.some((item) => item.status !== "integrated");
}
