// Queue job start: terminal commits, lock-refusal blocking and running one claimed record.
// Extracted from server.js in modularization round M-001.

import { QUEUE_BLOCKED_BACKOFF_MAX_MS, queueHardLockRequestRefusal, queueResultFields } from "../queue.js";
import { failureSummary, redactSensitiveText } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createQueueStartRuntime({ externalRunnerName = () => "", BRIDGE_INSTANCE_ID, CONFIG, QUEUE_ACTIVE_STATUSES, QUEUE_TERMINAL_STATUSES, abandonLocalQueueWorker, assertQueueRecordDurableOwnership, changedFileValidationErrorType, claimQueueRecord, clearQueueLeaseFence, closeDb, delayWithSignal, effectiveQueueMode, effectiveQueueWriteConflictPolicy, executeOpenCodeJob, findQueueWriteConflict, handleQueueWorkerInfrastructureFailure, logEvent, loseQueueOwnership, nowMs, openLockDb, providerSlotWaitStorage, queueOwnershipLossError, reacquirePersistedQueueRecordLease, reconcileParentPipelineAfterQueueTerminal, renewQueueRecordDurableOwnership, resetQueueLeaseFence, scheduleAutoIntegration, scheduleQueue, scheduleQueueRetryPolicy, summarizeStderr, superviseQueueWorker, timedOutWriterEvidence, timedOutWriterNote, truncateText, updateQueueRecordDurable, updateQueueTerminalRecordDurable }) {
let queueJobExecutorTestHook = null;
// Self-test access to the state above (the module owns it since the split).
function getQueueJobExecutorTestHook() { return queueJobExecutorTestHook; }
function setQueueJobExecutorTestHook(value) { queueJobExecutorTestHook = value; }

// Lock refusals of a queued job that clear by themselves; the job waits (blocked) and retries.
const QUEUE_RETRYABLE_LOCK_ERROR_TYPES = new Set(["queue_lock_conflict", "integration_recovery_pending"]);
const QUEUE_TERMINAL_COMMIT_ATTEMPTS = 5;

// Each consecutive block of the same job after a claim doubles its wait (up to 60 s): a job
// that keeps failing its lock no longer re-runs agent discovery and attestation every poll.
function queueBlockedBackoffPatch(record, now = Date.now()) {
  const count = Number(record.queueBlockedCount || 0) + 1;
  const delayMs = Math.min(QUEUE_BLOCKED_BACKOFF_MAX_MS, Math.max(1, CONFIG.queueBlockedPollMs) * 2 ** Math.min(count - 1, 16));
  return { queueBlockedCount: count, queueBlockedRetryAt: now + delayMs };
}

async function reacquireQueueRecordLease(record) {
  if (effectiveQueueMode() !== "sqlite") return false;
  const db = await openLockDb(record.cwd);
  try {
    const heartbeatAt = new Date().toISOString();
    return reacquirePersistedQueueRecordLease(db, record, heartbeatAt, new Date(Date.now() + CONFIG.queueLeaseMs).toISOString());
  } finally {
    closeDb(db);
  }
}

// A non-terminal transition that was refused only because this owner's lease lapsed re-takes
// the lease (same generation and revision) and tries once more.
async function updateQueueRecordDurableReacquiringLease(record, patch) {
  const ownerGeneration = String(record.ownerGeneration || "");
  const result = await updateQueueRecordDurable(record, patch);
  if (result.persisted || !ownerGeneration || effectiveQueueMode() !== "sqlite") return result;
  if (record.ownerInstanceId !== BRIDGE_INSTANCE_ID
    || String(record.ownerGeneration || "") !== ownerGeneration
    || record.cancellationRequested
    || QUEUE_TERMINAL_STATUSES.includes(record.status)) return result;
  if (!(await reacquireQueueRecordLease(record))) return result;
  return await updateQueueRecordDurable(record, patch);
}

function queueRecordOwnedElsewhere(record, ownerGeneration) {
  return record.ownerInstanceId !== BRIDGE_INSTANCE_ID
    || String(record.ownerGeneration || "") !== String(ownerGeneration || "");
}

// The terminal patch is built once and committed with bounded retries: a transient error
// (SQLITE_BUSY after busy_timeout, an encryption failure) no longer turns a finished job into
// a bare failure. If every attempt fails, the failure is recorded with the job's evidence.
async function commitQueueTerminalRecord(record, patch, { attempts = QUEUE_TERMINAL_COMMIT_ATTEMPTS } = {}) {
  let lastError = null;
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delayWithSignal(Math.min(2000, 100 * 2 ** (attempt - 1)));
    try {
      lastResult = await updateQueueTerminalRecordDurable(record, patch);
      lastError = null;
      // B-056: a queued job fails in the background, never as a tool answer, so the transport
      // wrapper cannot see it; its durable failed record is logged here, once.
      if (lastResult.persisted && patch.status === "failed") {
        logEvent("warn", "queue.job_failed", {
          jobId: record.jobId,
          agent: record.agent || "",
          // Q-006: the issue log names the model a failure happened on.
          model: patch.configuredModel ? `${patch.configuredProvider || "?"}/${patch.configuredModel}` : "",
          // Q-012: set only for a job that ran on an enabled external runner (codex, agy).
          ...(externalRunnerName(patch.configuredProvider) ? { runner: externalRunnerName(patch.configuredProvider) } : {}),
          errorType: patch.errorType || "",
          summary: failureSummary(patch.errorReason || patch.errorType || "Queued job failed."),
          durationMs: Number.isFinite(patch.durationMs) ? patch.durationMs : null,
        });
      }
      // Q-007: a job with a retry policy is requeued on its next model (or marked gave_up).
      if (lastResult.persisted && patch.status === "failed" && (record.request?.models || record.request?.maxAttempts || record.retryAttempt)) {
        scheduleQueueRetryPolicy(record.cwd, record.jobId);
      }
      // Q-006: a writer that "completed" without changing a file is the round-6 "no output file":
      // a success for the queue, a failure for the batch. Logged so the issue log shows it.
      if (lastResult.persisted && patch.status === "completed" && record.mode === "write" && patch.noChanges) {
        logEvent("warn", "queue.job_no_output", {
          jobId: record.jobId,
          agent: record.agent || "",
          model: patch.configuredModel ? `${patch.configuredProvider || "?"}/${patch.configuredModel}` : "",
          errorType: "completed_no_changes",
          summary: "The writer completed without changing any file (outcome=completed_no_changes).",
          durationMs: Number.isFinite(patch.durationMs) ? patch.durationMs : null,
        });
      }
      if (lastResult.persisted || lastResult.ownershipLost || !QUEUE_ACTIVE_STATUSES.includes(lastResult.status)) return lastResult;
    } catch (error) {
      lastError = error;
      logEvent("warn", "queue.terminal_commit_retry", {
        jobId: record.jobId,
        attempt: attempt + 1,
        status: patch.status || "",
        error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
      });
    }
  }
  await handleQueueWorkerInfrastructureFailure(
    record,
    lastError || new Error(`The terminal ${patch.status || "unknown"} record was refused ${attempts} times while this bridge still owned the running job.`),
    patch
  );
  return lastResult || { persisted: false, status: record.status };
}


// After a claimed job's lock was refused: name the real cause (an integration operation, a
// direct or manual lock), fail a request the lock layer can never accept, and otherwise
// record `blocked` with a backoff. A blocked state that cannot be persisted must not leave
// the record "running" in memory without a worker (it counted against capacity forever).
async function blockQueueRecordAfterLockRefusal(record, errorType) {
  let cause = null;
  try {
    cause = await findQueueWriteConflict(record);
  } catch (error) {
    logEvent("warn", "queue.lock_refusal_probe_failed", {
      jobId: record.jobId,
      error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
    });
  }
  if (!cause && errorType !== "integration_recovery_pending") {
    const refusal = queueHardLockRequestRefusal(record);
    if (refusal) return { outcome: "failed", errorType: "lock_request_rejected", errorReason: refusal };
  }
  const blockedErrorType = cause?.errorType === "integration_recovery_pending" || errorType === "integration_recovery_pending"
    ? "integration_recovery_pending"
    : "queue_lock_conflict";
  const errorReason = cause?.reason || (blockedErrorType === "integration_recovery_pending"
    ? "Waiting for the repository's unresolved integration operation to finish or be recovered; see diagnose_opencode_bridge."
    : "Waiting for the active cross-process reader/writer consistency lock to be released.");
  const patch = {
    status: "blocked",
    errorType: blockedErrorType,
    errorReason,
    childProcessId: 0,
    childProcessStartedAt: "",
    ...queueBlockedBackoffPatch(record),
  };
  let blocked = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delayWithSignal(100 * 2 ** (attempt - 1));
    try {
      blocked = await updateQueueRecordDurableReacquiringLease(record, patch);
      break;
    } catch (error) {
      logEvent("warn", "queue.blocked_persist_failed", {
        jobId: record.jobId,
        attempt: attempt + 1,
        error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
      });
    }
  }
  if (blocked?.persisted) return { outcome: "blocked" };
  if (record.cancellationRequested) {
    await commitQueueTerminalRecord(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      heartbeatAt: "",
      leaseExpiresAt: "",
      errorType: "agent_cancelled",
      errorReason: "Cancelled by request while the job waited for its lock.",
      childProcessId: 0,
      childProcessStartedAt: "",
    });
    return { outcome: "handled" };
  }
  if (!QUEUE_TERMINAL_STATUSES.includes(record.status)) {
    abandonLocalQueueWorker(record, "The blocked queue state could not be persisted; local lease renewal was stopped for deterministic recovery.");
  }
  return { outcome: "handled" };
}

async function startQueueRecord(record) {
  const claim = await claimQueueRecord(record);
  if (!claim.ok) return false;

  record.abortController = new AbortController();
  record.queueOwnershipLost = false;
  resetQueueLeaseFence(record);
  const workerPromise = (async () => {
    const started = nowMs();
    try {
      if (record.cancellationRequested) {
        await commitQueueTerminalRecord(record, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
        });
        return;
      }

      // Only the execution is caught as a job failure. A transient error while writing the
      // terminal record used to land here too and turn a completed job into a bare
      // queue_job_failed without its result, changed files or patch evidence.
      let execution;
      try {
        execution = await providerSlotWaitStorage.run({ jobId: record.jobId }, () => (typeof queueJobExecutorTestHook === "function" ? queueJobExecutorTestHook : executeOpenCodeJob)(record.request, {
        toolStarted: started,
        jobId: record.jobId,
        fromQueue: true,
        signal: record.abortController.signal,
        assertDurableOwnership: async () => await assertQueueRecordDurableOwnership(record),
        renewDurableOwnership: async () => await renewQueueRecordDurableOwnership(record),
        onWorktreePrepared: async (worktree) => {
          const persisted = await updateQueueRecordDurable(record, {
            worktreePath: worktree.path || "",
            worktreeBranch: worktree.branch || "",
            worktreeBaseCommit: worktree.baseCommit || "",
            worktreeBaseTree: worktree.baseTree || "",
          });
          if (!persisted.persisted) {
            loseQueueOwnership(record, "Durable queue ownership changed while recording the isolated worktree.");
            throw queueOwnershipLossError("Durable queue ownership changed while recording the isolated worktree.");
          }
        },
        onChildSpawn: async ({ pid, startedAt, processRole, containmentIdentity }) => {
          const launchAuthorizedAt = new Date().toISOString();
          const persisted = await updateQueueRecordDurable(record, {
            childProcessId: pid || 0,
            childProcessStartedAt: startedAt || new Date().toISOString(),
            agentStartedAt: record.agentStartedAt || startedAt || new Date().toISOString(),
            childProcessRole: processRole || "supervisor",
            childContainmentIdentity: containmentIdentity || "",
            heartbeatAt: launchAuthorizedAt,
            leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
          });
          if (!persisted.persisted) {
            loseQueueOwnership(record, "Durable queue ownership changed while recording the process supervisor identity.");
            throw queueOwnershipLossError("The payload launch gate could not persist its process supervisor identity.");
          }
          return { ok: true, deadlineAt: Date.parse(record.leaseExpiresAt || "") };
        },
        }));
      } catch (error) {
        await commitQueueTerminalRecord(record, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: "queue_job_failed",
          errorReason: error.message || String(error),
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        return;
      }
      const validationError = execution.validation?.disallowedFiles?.length
        ? changedFileValidationErrorType(execution.validation)
        : "";
      const errorType = execution.result?.errorType || validationError || "";

      let terminalPatch = null;
      if ((record.cancellationRequested || errorType === "agent_cancelled") && errorType !== "process_tree_termination_unconfirmed") {
        terminalPatch = {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: "agent_cancelled",
          errorReason: "Cancelled by request after the OpenCode process tree terminated.",
          changedFiles: execution.result?.changedFiles || [],
          validationResult: execution.validation || null,
          sanitizedWorkspaceVerification: execution.sanitizedWorkspace || execution.result?.sanitizedWorkspaceVerification || null,
          configuredProvider: execution.result?.configuredProvider || "",
          configuredModel: execution.result?.configuredModel || "",
          configuredVariant: execution.result?.configuredVariant || "",
          runtimeObservedProvider: execution.result?.runtimeObservedProvider || "",
          runtimeObservedModel: execution.result?.runtimeObservedModel || "",
          actualProvider: execution.result?.actualProvider || "",
          actualModel: execution.result?.actualModel || "",
          actualModelEvidence: execution.result?.actualModelEvidence || "",
          dependencyRequest: execution.result?.dependencyRequest || null,
          ...queueResultFields(execution),
          worktreePath: execution.worktree?.path || "",
          worktreeBranch: execution.worktree?.branch || "",
          worktreeBaseCommit: execution.worktree?.baseCommit || "",
          worktreeBaseTree: execution.worktree?.baseTree || "",
          worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
          worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
          childProcessId: 0,
          childProcessStartedAt: "",
        };
      } else if (QUEUE_RETRYABLE_LOCK_ERROR_TYPES.has(errorType) && effectiveQueueWriteConflictPolicy() === "wait") {
        const refusal = await blockQueueRecordAfterLockRefusal(record, errorType);
        if (refusal.outcome !== "failed") return;
        terminalPatch = {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: refusal.errorType,
          errorReason: refusal.errorReason,
          ...queueResultFields(execution),
          childProcessId: 0,
          childProcessStartedAt: "",
        };
      }

      const containmentUnconfirmed = errorType === "process_tree_termination_unconfirmed";
      // Q-007: with a retry policy the caller said this job must produce something, so a writer
      // that changed no file is a failure (the round-6 "no output file") and is retried.
      const noOutputFailure = !errorType && record.mode === "write" && Boolean(execution.result?.noChanges)
        && Boolean(record.request?.models || record.request?.maxAttempts);
      const terminalErrorType = noOutputFailure ? "writer_no_changes" : errorType;
      terminalPatch = terminalPatch || {
        status: terminalErrorType ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - started,
        heartbeatAt: "",
        leaseExpiresAt: "",
        errorType: terminalErrorType,
        errorReason: noOutputFailure
          ? "The writer finished without changing any file; with a retry policy (models/maxAttempts) that counts as no output."
          : errorType ? queueFailureReason(execution, errorType) : "",
        changedFiles: execution.result?.changedFiles || [],
        dirtyFiles: execution.result?.dirtyFiles || [],
        overlappingFiles: execution.result?.overlappingFiles || [],
        disjointFiles: execution.result?.disjointFiles || [],
        validationResult: execution.validation || null,
        sanitizedWorkspaceVerification: execution.sanitizedWorkspace || execution.result?.sanitizedWorkspaceVerification || null,
        configuredProvider: execution.result?.configuredProvider || "",
        configuredModel: execution.result?.configuredModel || "",
        configuredVariant: execution.result?.configuredVariant || "",
        runtimeObservedProvider: execution.result?.runtimeObservedProvider || "",
        runtimeObservedModel: execution.result?.runtimeObservedModel || "",
        actualProvider: execution.result?.actualProvider || "",
        actualModel: execution.result?.actualModel || "",
        actualModelEvidence: execution.result?.actualModelEvidence || "",
        dependencyRequest: execution.result?.dependencyRequest || null,
        ...queueResultFields(execution),
        providerWaitMs: execution.result?.providerConcurrencyWaitMs || 0,
        // B-078: the slot request was refused for a paused provider/model; the agent never ran.
        providerRefusedUntil: execution.result?.exitCode === "provider_capacity_unavailable" ? String(execution.result?.providerCooldownUntil || "") : "",
        providerRetryWarningCount: execution.result?.providerRetryWarningCount || 0,
        usage: execution.result?.usage || null,
        heavyToolCalls: execution.result?.heavyToolCalls?.length ? execution.result.heavyToolCalls : null,
        validationFixPass: execution.result?.validationFixPass || null,
        selfCheck: execution.result?.selfCheck || null,
        phaseTimings: execution.result?.phaseTimings || null,
        readOnlyHeadMove: execution.result?.readOnlyHeadMove || null,
        worktreePath: execution.worktree?.path || "",
        noChanges: Boolean(execution.result?.noChanges),
        worktreeBranch: execution.worktree?.branch || "",
        worktreeBaseCommit: execution.worktree?.baseCommit || "",
        worktreeBaseTree: execution.worktree?.baseTree || "",
        worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
        worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
        childProcessId: containmentUnconfirmed ? record.childProcessId : 0,
        childProcessStartedAt: containmentUnconfirmed ? record.childProcessStartedAt : "",
        containmentQuarantined: containmentUnconfirmed,
      };
      const committedTerminal = await commitQueueTerminalRecord(record, terminalPatch);
      // Q-010: a finished writer that asked for it is integrated after its lock is released (the
      // integration's serial lock would otherwise wait on the job's own write lock).
      if (committedTerminal?.persisted && terminalPatch.status === "completed" && record.request?.autoIntegrate === true
        && record.mode === "write" && !record.parentJobId && (terminalPatch.changedFiles || []).length && terminalPatch.worktreePath) {
        scheduleAutoIntegration({
          cwd: record.cwd,
          jobId: record.jobId,
          agent: record.agent || "",
          model: terminalPatch.configuredModel ? `${terminalPatch.configuredProvider || "?"}/${terminalPatch.configuredModel}` : "",
          worktreePath: terminalPatch.worktreePath,
          allowedEdits: record.allowedEdits || [],
          forbiddenEdits: record.request.forbiddenEdits || [],
          sharedFiles: record.request.sharedFiles || [],
          serialOnly: record.request.serialOnly || [],
          validationCommand: String(record.request.validationCommand || record.request.scopeContract?.validationCommand || "").trim(),
          // B-114: the patch identity the job finished with; the integration refuses any other.
          sourceRecord: { worktreeBaseCommit: terminalPatch.worktreeBaseCommit, worktreePatchSha256: terminalPatch.worktreePatchSha256, worktreeSourceStateSha256: terminalPatch.worktreeSourceStateSha256 },
        });
      }
    } finally {
      clearQueueLeaseFence(record);
      if (record.parentJobId && ["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
        try {
          await reconcileParentPipelineAfterQueueTerminal(record);
        } catch (error) {
          logEvent("warn", "pipeline.child_terminal_reconciliation_failed", {
            pipelineId: record.parentJobId,
            jobId: record.jobId,
            errorType: error?.errorType || "pipeline_child_terminal_reconciliation_failed",
          });
        }
      }
      if (["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
        delete record.request;
        delete record.queueBlockedCount;
        delete record.queueBlockedRetryAt;
      }
      delete record.abortController;
      delete record.executionPromise;
      scheduleQueue();
    }
  })();
  superviseQueueWorker(record, workerPromise);
  return true;
}

// The stored reason of a failed queue job: the agent's stderr summary, or the error type when it
// printed nothing. B-044: a timed-out writer that left changed files in a retained worktree says so
// first, so the operator integrates (or inspects) it instead of discarding the job.
function queueFailureReason(execution, errorType) {
  const stderrSummary = summarizeStderr(execution.result?.stderr);
  const note = timedOutWriterNote({
    ...timedOutWriterEvidence(execution.result),
    errorType,
    worktreeRetained: Boolean(execution.worktree?.path),
  });
  return note ? [note, stderrSummary].filter(Boolean).join(". ") : stderrSummary || errorType;
}
  return { QUEUE_RETRYABLE_LOCK_ERROR_TYPES, QUEUE_TERMINAL_COMMIT_ATTEMPTS, queueBlockedBackoffPatch, reacquireQueueRecordLease, updateQueueRecordDurableReacquiringLease, queueRecordOwnedElsewhere, commitQueueTerminalRecord, blockQueueRecordAfterLockRefusal, startQueueRecord, queueFailureReason, getQueueJobExecutorTestHook, setQueueJobExecutorTestHook };
}
