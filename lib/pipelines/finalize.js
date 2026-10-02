// Pipeline finalization: read-only gates, source cleanup and finalizing a pipeline under its lease and lock.
// Extracted from server.js in modularization round M-001.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { REPOSITORY_SCOPE_LOCK_PATH, mergePathLists, normalizeFilesystemCase } from "../paths.js";
import { PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES, pipelineHasPendingIntegrations, pipelineTerminalError } from "../pipelines.js";
import { redactSensitiveText } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createPipelineFinalizeRuntime({ CONFIG, DEFAULT_LOCK_TTL_MS, PIPELINE_INTEGRATION_CLOSED_STATUSES, abortSignalErrorType, acquireHardLock, captureIntegrationTargetState, changedFileValidationErrorType, changedFilesBetween, cleanupWorktree, collectIntegrationPatch, combineAbortSignals, conflictPathsFromConflict, conflictsWithActiveLock, executeOpenCodeJob, gitChangedFileSnapshot, isManagedReadOnlyAgent, listLocks, loadProjectAgentPolicy, nowMs, reconcilePipelineIntegrationOperationStates, refreshPipelineRecord, releaseHardLock, resolveProjectStateRoot, runCommand, runValidationGate, startHardLockHeartbeat, trackedTargetStateSha256, truncateResultText, updatePipelineRecord, verifySanitizedWorkspace }) {
let pipelineGateExecutorTestHook = null;
// Self-test access to the state above (the module owns it since the split).
function getPipelineGateExecutorTestHook() { return pipelineGateExecutorTestHook; }
function setPipelineGateExecutorTestHook(value) { pipelineGateExecutorTestHook = value; }

// Gate and final-validation outcomes that judge the result itself end the pipeline; anything
// else (a provider rate limit, a lost lease, a snapshot fault, drift from another client) is
// retried by finalizing again.
const PIPELINE_TERMINAL_GATE_ERROR_TYPES = new Set([
  "pipeline_gate_verdict_fail",
  "pipeline_gate_agent_not_read_only",
  // A gate agent that edited files (changedFileValidationErrorType of its validation).
  ...PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES,
]);
const PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES = new Set([
  "validation_command_failed",
  "validation_command_untrusted",
  "validation_command_parse_error",
  "final_validation_required",
]);

async function deferPipelineFinalization(record, { type, errorType, error, patch = {} }) {
  const at = new Date().toISOString();
  await updatePipelineRecord(record, (current) => PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status) ? {} : ({
    ...patch,
    status: "awaiting_finalization",
    finishedAt: "",
    errors: (current.errors || []).concat({ type, errorType, error, retryable: true }),
    events: (current.events || []).concat({ type: "finalization_deferred", at, errorType }),
  }));
  return {
    ok: false,
    errorType,
    error: `${error} The pipeline stays awaiting_finalization; finalize again once the cause is cleared. Source worktrees were retained.`,
    retryable: true,
    record,
  };
}

// A gate agent that ends cleanly has not therefore approved the result: its verdict is read
// from its own report, and a missing, conflicting, or unreadable verdict fails closed.
const PIPELINE_GATE_VERDICT_INSTRUCTION = [
  "Gate verdict (required): the bridge reads your verdict mechanically from your final report.",
  "The very last line of the report must be exactly GATE_VERDICT: pass or GATE_VERDICT: fail, with nothing after it: put it after any Final Report section, not inside a list, quote, or code block.",
  "Do not write the word GATE_VERDICT anywhere else in the report, not even as an example or a quote.",
  "Write fail if you found any blocking issue, if a check the task asks for fails or could not be run, or if you could not finish the review.",
  "Any other placement or form fails the gate.",
].join("\n");
// Only bold or code emphasis may wrap the verdict; a quote or list marker makes it an example.
const PIPELINE_GATE_VERDICT_LINE = /^[*_`]*GATE_VERDICT[*_`]*:[*_`]* ?[*_`]*(pass|fail)[*_`]*$/i;

function parsePipelineGateVerdict(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mentions = lines.filter((line) => /GATE_VERDICT/i.test(line));
  if (mentions.length > 1) return "ambiguous";
  const match = lines.length ? PIPELINE_GATE_VERDICT_LINE.exec(lines[lines.length - 1]) : null;
  if (!match) return mentions.length ? "misplaced" : "missing";
  return match[1].toLowerCase();
}

const PIPELINE_GATE_VERDICT_ERROR_TYPES = {
  fail: "pipeline_gate_verdict_fail",
  missing: "pipeline_gate_verdict_missing",
  misplaced: "pipeline_gate_verdict_misplaced",
  ambiguous: "pipeline_gate_verdict_ambiguous",
};

async function runPipelineReadOnlyGate(record, gateName, gateJob, signal = null, checkedTargetStateSha256 = "") {
  if (!gateJob) {
    return null;
  }

  if (!isManagedReadOnlyAgent(gateJob.agent)) {
    return {
      gate: gateName,
      status: "failed",
      errorType: "pipeline_gate_agent_not_read_only",
      changedFiles: [],
      text: `Pipeline ${gateName} gate requires a managed read-only agent; received "${gateJob.agent}".`,
    };
  }

  const executeGateJob = typeof pipelineGateExecutorTestHook === "function" ? pipelineGateExecutorTestHook : executeOpenCodeJob;
  // The integrated changes are uncommitted in record.cwd, so a gate must read that checkout:
  // under CODEX_OPENCODE_WORKTREE_MODE=all a fresh worktree from HEAD would review the
  // pre-integration tree. Each attempt gets its own job id (a retried gate reused one).
  const gateAttemptJobId = `${record.pipelineId}-${randomBytes(4).toString("hex")}-${gateName}`;
  const execution = await executeGateJob({
    ...gateJob,
    cwd: record.cwd,
    noWorktree: true,
    write: false,
    lockType: "read",
    lockMode: "off",
    allowedEdits: [],
    forbiddenEdits: mergePathLists(gateJob.forbiddenEdits, record.policy?.forbiddenEdits, record.policy?.sharedFiles, record.policy?.serialOnly),
    sharedFiles: mergePathLists(gateJob.sharedFiles, record.policy?.sharedFiles),
    sanitizedWorkspace: gateJob.sanitizedWorkspace || record.sanitizedWorkspace || undefined,
    subagentStrategy: record.sanitizedWorkspace ? "reject" : (gateJob.subagentStrategy || "reject"),
    task: [
      gateJob.task,
      "",
      `Pipeline id: ${record.pipelineId}`,
      "Review/test the integrated result only. Do not edit files.",
      "",
      PIPELINE_GATE_VERDICT_INSTRUCTION,
    ].filter(Boolean).join("\n"),
  }, { toolStarted: nowMs(), jobId: gateAttemptJobId, signal });

  // An agent that errored or edited files fails on that ground; its verdict is not consulted.
  const runErrorType = execution.result?.errorType
    || (execution.validation?.disallowedFiles?.length ? changedFileValidationErrorType(execution.validation) : "");
  // result.stdout is the agent's own final response, untruncated whenever errorType is empty
  // (a bridge-truncated response is itself the essential_output_truncated error).
  const verdict = runErrorType ? "not_read" : parsePipelineGateVerdict(execution.result?.stdout);
  const errorType = runErrorType || (verdict === "pass" ? "" : PIPELINE_GATE_VERDICT_ERROR_TYPES[verdict]);
  return {
    gate: gateName,
    status: errorType ? "failed" : "passed",
    errorType,
    verdict,
    checkedTargetStateSha256,
    changedFiles: execution.result?.changedFiles || [],
    text: truncateResultText(execution.response?.content?.[0]?.text || "", 12000),
  };
}

function cleanupAuthorizationMatchesItem(record, authorization, item) {
  if (!authorization || !item) return false;
  const cwd = record.cwd || process.cwd();
  const authorizationPath = normalizeFilesystemCase(path.resolve(String(authorization.worktreePath || "")), cwd);
  const itemPath = normalizeFilesystemCase(path.resolve(String(item.worktreePath || "")), cwd);
  return Boolean(authorization.worktreePath && item.worktreePath)
    && authorizationPath === itemPath
    && String(authorization.branch || "") === String(item.branch || "")
    && String(authorization.sourceBaseCommit || "") === String(item.sourceBaseCommit || "")
    && String(authorization.patchSha256 || "") === String(item.patchSha256 || "")
    && String(authorization.sourceStateSha256 || "") === String(item.sourceStateSha256 || "");
}

async function finalizePipelineSourceCleanup(record, {
  dryRun = false,
  authorizeCleanup = null,
  authorizedWorktrees = null,
} = {}) {
  const durableAuthorizations = Array.isArray(authorizedWorktrees) ? authorizedWorktrees : null;
  const cleanupPlan = [];
  for (const item of record.integrationQueue || []) {
    if (!item.cleanupRequested || !item.worktreePath) continue;
    if (durableAuthorizations) {
      const matchingAuthorizations = durableAuthorizations.filter((authorization) => cleanupAuthorizationMatchesItem(record, authorization, item));
      if (matchingAuthorizations.length !== 1) {
        cleanupPlan.push({
          result: {
            worktreePath: item.worktreePath,
            branch: item.branch || "",
            cleanup: "retained_for_review",
            reason: "cleanup_identity_not_durably_authorized",
          },
        });
        continue;
      }
    }
    if (dryRun) {
      cleanupPlan.push({ result: { worktreePath: item.worktreePath, cleanup: "skipped_dry_run" } });
      continue;
    }
    if (!existsSync(item.worktreePath)) {
      const branch = String(item.branch || "").trim();
      const worktrees = await runCommand("git", ["worktree", "list", "--porcelain"], record.cwd, 1000 * 15);
      const branchRef = branch
        ? await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], record.cwd, 1000 * 15)
        : { exitCode: 1 };
      // git prints `worktree C:/Users/...` (forward slashes, its own case); compare resolved,
      // case-normalized paths or a registered worktree reads as already removed on Windows.
      const itemWorktreeKey = normalizeFilesystemCase(path.resolve(item.worktreePath), record.cwd);
      const registered = worktrees.exitCode === 0
        && worktrees.stdout.split(/\r?\n/).some((line) => line.startsWith("worktree ")
          && normalizeFilesystemCase(path.resolve(line.slice("worktree ".length)), record.cwd) === itemWorktreeKey);
      cleanupPlan.push({
        result: !registered && branchRef.exitCode !== 0
          ? { worktreePath: item.worktreePath, branch, cleanup: "success", reason: "recovered_already_removed" }
          : { worktreePath: item.worktreePath, branch, cleanup: "retained_for_review", reason: "cleanup_identity_ambiguous_after_restart" },
      });
      continue;
    }
    const source = await collectIntegrationPatch({
      cwd: record.cwd,
      worktreePath: item.worktreePath,
      sourceBaseCommit: item.sourceBaseCommit || "",
    });
    if (!source.ok || source.patchSha256 !== item.patchSha256 || source.sourceStateSha256 !== item.sourceStateSha256) {
      cleanupPlan.push({
        result: {
          worktreePath: item.worktreePath,
          cleanup: "retained_for_review",
          reason: "integration_source_changed_after_review",
        },
      });
      continue;
    }
    const branch = await runCommand("git", ["branch", "--show-current"], item.worktreePath, 1000 * 15);
    if (branch.exitCode !== 0 || !branch.stdout.trim()) {
      cleanupPlan.push({
        result: {
          worktreePath: item.worktreePath,
          cleanup: "retained_for_review",
          reason: "source_branch_identity_unverified",
        },
      });
      continue;
    }
    cleanupPlan.push({
      item,
      authorization: {
        worktreePath: item.worktreePath,
        branch: branch.stdout.trim(),
        sourceBaseCommit: source.sourceBaseCommit,
        patchSha256: source.patchSha256,
        sourceStateSha256: source.sourceStateSha256,
        cleanup: "authorized",
        authorizedAt: new Date().toISOString(),
      },
    });
  }

  const authorizations = cleanupPlan.filter((entry) => entry.authorization).map((entry) => entry.authorization);
  if (authorizations.length) {
    if (typeof authorizeCleanup !== "function") {
      throw new Error("Pipeline source cleanup requires a durable authorization callback.");
    }
    await authorizeCleanup(cleanupPlan.map((entry) => entry.authorization || entry.result), authorizations);
  }

  const results = [];
  for (const entry of cleanupPlan) {
    if (!entry.authorization) {
      results.push(entry.result);
      continue;
    }
    const source = await collectIntegrationPatch({
      cwd: record.cwd,
      worktreePath: entry.item.worktreePath,
      sourceBaseCommit: entry.item.sourceBaseCommit || "",
    });
    const branch = source.ok
      ? await runCommand("git", ["branch", "--show-current"], entry.item.worktreePath, 1000 * 15)
      : null;
    if (!source.ok
      || source.patchSha256 !== entry.authorization.patchSha256
      || source.sourceStateSha256 !== entry.authorization.sourceStateSha256
      || !branch
      || branch.exitCode !== 0
      || branch.stdout.trim() !== entry.authorization.branch) {
      results.push({
        ...entry.authorization,
        cleanup: "retained_for_review",
        reason: "integration_source_changed_after_cleanup_authorization",
      });
      continue;
    }
    const cleanup = await cleanupWorktree({
      path: path.resolve(entry.item.worktreePath),
      repoRoot: path.resolve(record.cwd),
      branch: entry.authorization.branch,
    }, "always", true);
    results.push({
      ...entry.authorization,
      ...cleanup,
      completedAt: new Date().toISOString(),
    });
  }
  return results;
}

async function resumeAuthorizedPipelineCleanup(record) {
  const authorizationEvent = [...(record.events || [])].reverse().find((event) => event.type === "source_cleanup_authorized");
  const expectedTargetStateSha256 = authorizationEvent?.targetStateSha256 || "";
  const cleanupItems = (record.integrationQueue || []).filter((item) => item.cleanupRequested && item.worktreePath);
  const eventWorktrees = Array.isArray(authorizationEvent?.worktrees) ? authorizationEvent.worktrees : [];
  // Each authorization must name exactly one item and vice versa. An item that finalized as
  // retained/already removed before the crash has a terminal cleanup result and no
  // authorization; requiring one authorization per item kept every authorized worktree.
  const cwd = record.cwd || process.cwd();
  const worktreeKey = (value) => normalizeFilesystemCase(path.resolve(String(value || "")), cwd);
  // "failed" stays retryable; "authorized" is what recovery is for.
  const terminalCleanupResults = (record.sourceCleanupResults || [])
    .filter((result) => result?.worktreePath && ["success", "partial", "retained_for_review"].includes(result.cleanup));
  const terminalCleanupKeys = new Set(terminalCleanupResults.map((result) => worktreeKey(result.worktreePath)));
  const itemsAwaitingCleanup = cleanupItems.filter((item) => !terminalCleanupKeys.has(worktreeKey(item.worktreePath)));
  const authorizedWorktrees = eventWorktrees.filter((authorization) => {
    const matchingItems = itemsAwaitingCleanup.filter((item) => cleanupAuthorizationMatchesItem(record, authorization, item));
    if (matchingItems.length !== 1) return false;
    return eventWorktrees.filter((other) => cleanupAuthorizationMatchesItem(record, other, matchingItems[0])).length === 1;
  });
  const targetState = expectedTargetStateSha256 ? await captureIntegrationTargetState(record.cwd) : null;
  const expectedTrackedTargetStateSha256 = authorizationEvent?.trackedTargetStateSha256 || "";
  const targetStateMatches = expectedTrackedTargetStateSha256
    ? targetState?.ok && trackedTargetStateSha256(targetState) === expectedTrackedTargetStateSha256
    : targetState?.ok && targetState.targetStateSha256 === expectedTargetStateSha256;
  if (!expectedTargetStateSha256 || !targetStateMatches) {
    await updatePipelineRecord(record, {
      status: "completed",
      finishedAt: record.finishedAt || new Date().toISOString(),
      cleanupPending: false,
      cleanupState: "completed_with_retained_sources",
      errors: (record.errors || []).concat({
        type: "source_cleanup",
        errorType: "pipeline_cleanup_target_state_changed",
        error: "The target state no longer matches the durable cleanup authorization; source worktrees were retained.",
      }),
    });
    return { ok: true, retainedSources: true, warningType: "pipeline_cleanup_target_state_changed", record };
  }

  const resumedCleanupResults = await finalizePipelineSourceCleanup({ ...record, integrationQueue: itemsAwaitingCleanup }, {
    authorizeCleanup: async () => {},
    authorizedWorktrees,
  });
  const sourceCleanupResults = terminalCleanupResults.concat(resumedCleanupResults);
  const failures = sourceCleanupResults.filter((result) => result.cleanup === "failed");
  const retained = sourceCleanupResults.filter((result) => ["retained_for_review", "partial"].includes(result.cleanup));
  await updatePipelineRecord(record, {
    status: failures.length ? "cleanup_failed" : "completed",
    finishedAt: failures.length ? "" : (record.finishedAt || new Date().toISOString()),
    sourceCleanupResults,
    cleanupPending: failures.length > 0,
    cleanupState: failures.length ? "failed_retryable" : retained.length ? "completed_with_retained_sources" : "completed",
    events: (record.events || []).concat({
      type: failures.length ? "source_cleanup_recovery_failed" : "source_cleanup_recovered",
      at: new Date().toISOString(),
      retainedSources: retained.length,
    }),
  });
  return failures.length
    ? { ok: false, errorType: "pipeline_cleanup_failed", record }
    : { ok: true, record };
}

// The finalizer's repository lease is shared, so this set is what stops two finalizations of
// one pipeline in this process from running their gates and cleanup side by side.
const FINALIZING_PIPELINE_IDS = new Set();

async function finalizePipelineRecord(record, options = {}) {
  const pipelineKey = record.pipelineId || "";
  if (pipelineKey && FINALIZING_PIPELINE_IDS.has(pipelineKey)) {
    return {
      ok: false,
      errorType: "pipeline_finalization_in_progress",
      error: `Pipeline ${pipelineKey} is already being finalized by this bridge.`,
      record,
    };
  }
  if (pipelineKey) FINALIZING_PIPELINE_IDS.add(pipelineKey);
  try {
    return await finalizePipelineRecordUnderLease(record, options);
  } finally {
    if (pipelineKey) FINALIZING_PIPELINE_IDS.delete(pipelineKey);
  }
}

async function finalizePipelineRecordUnderLease(record, options = {}) {
  const targetCwd = await resolveProjectStateRoot(record.cwd || process.cwd());
  if (options.dryRun) {
    // A dry run reports whether finalization could start now without taking the repository
    // lease, and derives the current status in memory: it never changes the durable record.
    const conflict = (await listLocks(targetCwd))
      .map((lock) => conflictsWithActiveLock({ lockType: "read", paths: [REPOSITORY_SCOPE_LOCK_PATH] }, lock))
      .find(Boolean);
    if (conflict) {
      return {
        ok: false,
        errorType: "pipeline_finalization_lock_conflict",
        error: `Pipeline finalization requires a stable repository snapshot: active ${conflict.lockType} lock ${conflict.lockId} (${conflict.agent || "unknown"}) holds ${conflictPathsFromConflict(conflict).join(", ") || "the repository"}.`,
        conflictingPaths: conflictPathsFromConflict(conflict),
        record,
      };
    }
    const view = {
      ...record,
      integrationQueue: (record.integrationQueue || []).map((item) => ({ ...item })),
      events: [...(record.events || [])],
      errors: [...(record.errors || [])],
    };
    return { ...(await finalizePipelineRecordWhileLocked(view, options)), record };
  }
  const lockTtlMs =Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + CONFIG.readOnlyRetryMaxElapsedMs * 2 + 1000 * 60 * 5);
  const lockResult = await acquireHardLock({
    owner: "codex",
    agent: "pipeline_finalizer",
    task: `Finalize pipeline ${record.pipelineId || "unknown"}`,
    cwd: targetCwd,
    lockType: "read",
    paths: [REPOSITORY_SCOPE_LOCK_PATH],
    repositoryScope: true,
    ttlMs: lockTtlMs,
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      errorType: "pipeline_finalization_lock_conflict",
      error: `Pipeline finalization requires a stable repository snapshot: ${lockResult.error}`,
      conflictingPaths: conflictPathsFromConflict(lockResult.conflict),
      record,
    };
  }
  const heartbeat = startHardLockHeartbeat(lockResult.lock, lockTtlMs);
  try {
    return await finalizePipelineRecordWhileLocked(record, { ...options, signal: combineAbortSignals([options.signal, heartbeat.signal]) });
  } finally {
    heartbeat();
    await releaseHardLock(lockResult.lock.id, lockResult.lock.token, lockResult.lock.paths, lockResult.lock.cwd);
  }
}

async function finalizePipelineRecordWhileLocked(record, { skipReviewers = false, dryRun = false, beforeFinalValidationHook = null, signal = null } = {}) {
  // The journal decides items whose integration committed before a crash (refresh reconciles
  // them too, but returns early for a crashed "finalizing" record).
  await reconcilePipelineIntegrationOperationStates(record, { persist: !dryRun });
  await refreshPipelineRecord(record, { persist: !dryRun });
  const now = new Date().toISOString();
  const events = (record.events || []).concat({
    type: "finalization_started",
    at: now,
    dryRun,
    skipReviewers,
  });
  // A dry run reports what finalization would do; it never persists a rejection or a status.
  const recordRejection = dryRun ? async () => {} : (patch) => updatePipelineRecord(record, patch);

  // A finalized pipeline is terminal: its gates already ran against the state they recorded,
  // and running them again later would judge a different tree under the same result.
  if (record.status === "completed") {
    return { ok: true, alreadyFinalized: true, record };
  }
  if (["cleanup_pending", "cleanup_failed"].includes(record.status)) {
    return {
      ok: false,
      errorType: "pipeline_already_finalized",
      error: `Pipeline gates already passed; status is ${record.status} and source cleanup is resumed by the bridge's cleanup recovery.`,
      record,
    };
  }

  if (["failed", "cancelled"].includes(record.status)) {
    await recordRejection({
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_not_finalizable",
        error: `Pipeline status is ${record.status}.`,
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_not_finalizable",
      error: `Pipeline status is ${record.status}.`,
      record,
    };
  }

  if (pipelineHasPendingIntegrations(record)) {
    await recordRejection({
      status: ["awaiting_finalization", "finalizing"].includes(record.status) ? "awaiting_integration" : record.status,
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_pending_integrations",
        error: "All integrationQueue entries must be integrated before finalization.",
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_pending_integrations",
      error: "All integrationQueue entries must be integrated before finalization.",
      record,
    };
  }

  // refreshPipelineRecord derives awaiting_finalization from the durable children only once
  // every job completed and every integration landed; "finalizing" is a crashed finalization.
  if (!["awaiting_finalization", "finalizing"].includes(record.status)) {
    await recordRejection({
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_jobs_incomplete",
        error: `Pipeline status is ${record.status}; every job must complete before finalization.`,
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_jobs_incomplete",
      error: `Pipeline status is ${record.status}; every job must complete and be integrated before finalization.`,
      record,
    };
  }

  if (skipReviewers && (record.reviewerJob || record.testerJob)) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_configured_gates_required",
        error: "Configured reviewer/tester gates may not be skipped before pipeline completion or cleanup.",
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_configured_gates_required",
      error: "Configured reviewer/tester gates must run and pass; source worktrees were retained.",
      record,
    };
  }

  const finalValidationSource = record.finalValidationSource
    || (record.policy?.path && record.finalValidationCommand ? "legacy_unknown" : "none");
  const finalValidationSourceValid = record.finalValidationCommand
    ? ["caller", "policy"].includes(finalValidationSource)
    : finalValidationSource === "none";
  if (!finalValidationSourceValid) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "policy_validation_command_untrusted",
        error: "Final validation has missing, unknown, or inconsistent command provenance. Legacy records are audit-only.",
      }),
    });
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Final validation provenance is not trusted; source worktrees were retained.",
      record,
    };
  }
  if (["policy", "legacy_unknown"].includes(finalValidationSource) && record.finalValidationCommand && !record.finalValidationSpec) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "policy_validation_command_untrusted",
        error: "A policy-derived validation command lacks its exact trusted executable/argument attestation. Legacy records are audit-only.",
      }),
    });
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Policy validation attestation is missing; source worktrees were retained.",
      record,
    };
  }

  if (finalValidationSource === "legacy_unknown" && record.finalValidationSpec) {
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Legacy validation provenance is ambiguous; source worktrees were retained.",
      record,
    };
  }

  if (finalValidationSource === "policy" && record.policy?.path && record.finalValidationSpec) {
    const currentPolicy = await loadProjectAgentPolicy(record.cwd, record.policy.path);
    const samePolicy = currentPolicy.ok
      && currentPolicy.sha256 === record.policy.sha256
      && currentPolicy.policy?.finalValidationSpec?.commandSha256 === record.finalValidationSpec.commandSha256;
    if (!samePolicy) {
      await recordRejection({
        status: "awaiting_finalization",
        events,
        errors: (record.errors || []).concat({
          type: "finalization",
          errorType: "policy_validation_command_untrusted",
          error: currentPolicy.error || "The project policy approval, bytes, executable pin, or exact validation vector changed before finalization.",
        }),
      });
      return {
        ok: false,
        errorType: "policy_validation_command_untrusted",
        error: "Project policy trust was revoked or changed; source worktrees were retained.",
        record,
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRun: {
        finalValidationCommand: record.sanitizedWorkspace ? "" : record.finalValidationCommand || "",
        gates: skipReviewers ? [] : ["reviewer", "tester"].filter((gateName) => record[`${gateName}Job`]),
      },
      record,
    };
  }

  try {
    await updatePipelineRecord(record, (current) => {
      if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status)) throw pipelineTerminalError(current);
      return { status: "finalizing", events };
    });
  } catch (error) {
    if (error?.errorType !== "pipeline_terminal") throw error;
    return { ok: false, errorType: "pipeline_terminal", error: `${error.message} Nothing was finalized and no source worktree was removed.`, record };
  }
  const sanitizedBeforeFinalGates = record.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(record.sanitizedWorkspace, "pipeline_before_final_gates")
    : null;
  if (sanitizedBeforeFinalGates && !sanitizedBeforeFinalGates.ok) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      sanitizedWorkspaceAttestation: { ...(record.sanitizedWorkspaceAttestation || {}), beforeFinalGates: sanitizedBeforeFinalGates },
      errors: (record.errors || []).concat({ type: "sanitized_workspace", errorType: sanitizedBeforeFinalGates.errorType, error: sanitizedBeforeFinalGates.error }),
    });
    return { ok: false, errorType: sanitizedBeforeFinalGates.errorType, error: "Sanitized workspace changed before final gates.", record };
  }
  let finalValidationBeforeState = null;
  let finalValidationBeforeFiles = new Map();
  let finalValidationEvidenceError = "";
  if (!record.sanitizedWorkspace && !dryRun) {
    try {
      finalValidationBeforeState = await captureIntegrationTargetState(record.cwd);
      if (!finalValidationBeforeState.ok) finalValidationEvidenceError = finalValidationBeforeState.error || "Could not capture pipeline target state before final validation.";
      else finalValidationBeforeFiles = await gitChangedFileSnapshot(record.cwd, { includeIgnored: false });
    } catch (error) {
      finalValidationEvidenceError = redactSensitiveText(error.message || String(error));
    }
  }
  if (!record.sanitizedWorkspace && !dryRun && !finalValidationEvidenceError && typeof beforeFinalValidationHook === "function") {
    await beforeFinalValidationHook({ cwd: record.cwd, record });
  }
  let finalValidationResult = record.sanitizedWorkspace
    ? { status: "manifest_only", command: "", exitCode: "not_applicable", durationMs: 0, stdout: "", stderr: "", errorType: null }
    : finalValidationEvidenceError
      ? { status: "failed", command: record.finalValidationCommand || "", exitCode: "not_run", durationMs: 0, stdout: "", stderr: finalValidationEvidenceError, errorType: "final_validation_snapshot_failed" }
      : await runValidationGate({
          command: record.finalValidationCommand,
          cwd: record.cwd,
          dryRun,
          trustedSpec: record.finalValidationSpec || null,
          signal,
        });
  let finalValidationAfterState = finalValidationBeforeState;
  let finalValidationMutationFiles = [];
  if (!record.sanitizedWorkspace && !dryRun && !finalValidationEvidenceError) {
    try {
      finalValidationAfterState = await captureIntegrationTargetState(record.cwd);
      const finalValidationAfterFiles = await gitChangedFileSnapshot(record.cwd, { includeIgnored: false });
      finalValidationMutationFiles = changedFilesBetween(finalValidationBeforeFiles, finalValidationAfterFiles);
      // Tracked state only: ignored output of the validation command (__pycache__/) is not
      // a change to the reviewed result.
      const stateChanged = !finalValidationAfterState.ok
        || trackedTargetStateSha256(finalValidationAfterState) !== trackedTargetStateSha256(finalValidationBeforeState);
      if (stateChanged || finalValidationMutationFiles.length) {
        finalValidationResult = {
          ...finalValidationResult,
          status: "failed",
          errorType: "final_validation_mutated_workspace",
          stderr: [finalValidationResult.stderr, `Final validation changed unreviewed target state${finalValidationMutationFiles.length ? `: ${finalValidationMutationFiles.join(", ")}` : "."} The changes and source worktrees were retained.`].filter(Boolean).join("\n"),
          mutationFiles: finalValidationMutationFiles,
          beforeTargetStateSha256: finalValidationBeforeState.targetStateSha256,
          afterTargetStateSha256: finalValidationAfterState.targetStateSha256 || "",
        };
      }
    } catch (error) {
      finalValidationResult = {
        ...finalValidationResult,
        status: "failed",
        errorType: "final_validation_snapshot_failed",
        stderr: [finalValidationResult.stderr, redactSensitiveText(error.message || String(error))].filter(Boolean).join("\n"),
      };
    }
  }
  const finalValidationRequired = (record.integrationQueue || []).length > 0;
  if (finalValidationResult.errorType || (finalValidationRequired && finalValidationResult.status !== "passed")) {
    const finalErrorType = finalValidationResult.errorType || "final_validation_required";
    // Only a validation that ran and failed judges the result. A snapshot fault, state drift
    // from another client, or a lost lease (an aborted command) is retried by finalizing again.
    if (signal?.aborted || !PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES.has(finalErrorType)) {
      return deferPipelineFinalization(record, {
        type: "final_validation",
        errorType: signal?.aborted ? abortSignalErrorType(signal, "read_lock_ownership_lost") : finalErrorType,
        error: finalValidationResult.stderr || finalValidationResult.stdout || "Final validation could not be completed.",
        patch: { finalValidationResult },
      });
    }
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      errors: (record.errors || []).concat({
        type: "final_validation",
        errorType: finalErrorType,
        error: finalValidationResult.stderr || finalValidationResult.stdout || "Final validation failed.",
      }),
      events: (record.events || []).concat({
        type: "finalization_failed",
        at: new Date().toISOString(),
        errorType: finalErrorType,
      }),
    });
    return {
      ok: false,
      errorType: finalErrorType,
      error: "Final validation failed.",
      record,
    };
  }

  // Both gates are read-only and inspect the same validated target state, so they run together;
  // the pre-cleanup state check below proves that state did not move while they ran.
  const gateTargetStateSha256 = finalValidationAfterState?.targetStateSha256 || "";
  const gateOutcomes = skipReviewers ? [] : await Promise.allSettled([
    runPipelineReadOnlyGate(record, "reviewer", record.reviewerJob, signal, gateTargetStateSha256),
    runPipelineReadOnlyGate(record, "tester", record.testerJob, signal, gateTargetStateSha256),
  ]);
  const gateRejection = gateOutcomes.find((outcome) => outcome.status === "rejected");
  if (gateRejection) throw gateRejection.reason;
  const [reviewerResult = null, testerResult = null] = gateOutcomes.map((outcome) => outcome.value);
  // GATE_VERDICT: fail (or a gate that is not read-only or edited files) ends the pipeline. A
  // gate that could not deliver a verdict (rate limit, lost read lease, missing or misplaced
  // verdict line) leaves it awaiting_finalization so the gates can run again.
  const failedGates = [["reviewer", reviewerResult], ["tester", testerResult]].filter(([, gateResult]) => gateResult?.status === "failed");
  const terminalGate = failedGates.find(([, gateResult]) => PIPELINE_TERMINAL_GATE_ERROR_TYPES.has(gateResult.errorType));
  const [failedGateName = "", failedGateResult = null] = terminalGate || failedGates[0] || [];
  const failedGateLabel = failedGateName === "tester" ? "Tester" : "Reviewer";
  if (failedGateResult && !terminalGate) {
    return deferPipelineFinalization(record, {
      type: failedGateName,
      errorType: failedGateResult.errorType || `${failedGateName}_gate_failed`,
      error: `${failedGateLabel} gate did not deliver a verdict (${failedGateResult.errorType || "unknown"}).`,
      patch: { finalValidationResult, reviewerResult, testerResult },
    });
  }
  if (failedGateResult) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      testerResult,
      errors: (record.errors || []).concat({
        type: failedGateName,
        errorType: failedGateResult.errorType,
        error: `${failedGateLabel} gate failed.`,
      }),
    });
    return {
      ok: false,
      errorType: failedGateResult.errorType || `${failedGateName}_gate_failed`,
      error: `${failedGateLabel} gate failed.`,
      record,
    };
  }

  const sanitizedFinal = record.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(record.sanitizedWorkspace, "pipeline_after_all_waves")
    : null;
  if (sanitizedFinal && !sanitizedFinal.ok) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      testerResult,
      sanitizedWorkspaceAttestation: {
        ...(record.sanitizedWorkspaceAttestation || {}),
        beforeFinalGates: sanitizedBeforeFinalGates,
        afterAllWaves: sanitizedFinal,
      },
      errors: (record.errors || []).concat({ type: "sanitized_workspace", errorType: sanitizedFinal.errorType, error: sanitizedFinal.error }),
    });
    return { ok: false, errorType: sanitizedFinal.errorType, error: "Sanitized workspace changed during final pipeline gates.", record };
  }

  if (!record.sanitizedWorkspace && !dryRun && finalValidationAfterState?.ok) {
    const beforeCleanupState = await captureIntegrationTargetState(record.cwd);
    // The gates' own test runs write ignored output; only tracked state must be unchanged.
    if (!beforeCleanupState.ok || trackedTargetStateSha256(beforeCleanupState) !== trackedTargetStateSha256(finalValidationAfterState)) {
      return deferPipelineFinalization(record, {
        type: "finalization",
        errorType: "pipeline_target_changed_before_cleanup",
        error: beforeCleanupState.ok
          ? "Pipeline target changed after final validation/gates and before source cleanup."
          : beforeCleanupState.error || "Could not capture the pipeline target state before source cleanup.",
        patch: { finalValidationResult, reviewerResult, testerResult },
      });
    }
  }

  const sanitizedWorkspaceAttestation = record.sanitizedWorkspace ? {
    ...(record.sanitizedWorkspaceAttestation || {}),
    beforeFinalGates: sanitizedBeforeFinalGates,
    afterAllWaves: sanitizedFinal,
  } : null;
  if (signal?.aborted) {
    // Losing the lease says nothing about the result; finalize again under a new one.
    return deferPipelineFinalization(record, {
      type: "finalization",
      errorType: abortSignalErrorType(signal, "read_lock_ownership_lost"),
      error: signal.reason?.message || "Pipeline finalization lost its repository consistency lease.",
      patch: { finalValidationResult, reviewerResult, testerResult },
    });
  }
  const sourceCleanupResults = await finalizePipelineSourceCleanup(record, {
    dryRun,
    authorizeCleanup: async (authorizationResults, authorizations) => {
      await updatePipelineRecord(record, {
        status: "cleanup_pending",
        finishedAt: "",
        finalValidationResult,
        reviewerResult,
        testerResult,
        sanitizedWorkspaceAttestation,
        sourceCleanupResults: authorizationResults,
        cleanupPending: authorizations.length > 0,
        cleanupState: authorizations.length > 0 ? "authorized" : "none",
        events: (record.events || []).concat({
          type: "finalization_gates_passed",
          at: new Date().toISOString(),
          cleanupPending: authorizations.length > 0,
        }, {
          type: "source_cleanup_authorized",
          at: new Date().toISOString(),
          targetStateSha256: finalValidationAfterState?.targetStateSha256 || "",
          trackedTargetStateSha256: trackedTargetStateSha256(finalValidationAfterState),
          worktrees: authorizations.map((authorization) => ({
            worktreePath: authorization.worktreePath,
            branch: authorization.branch,
            sourceBaseCommit: authorization.sourceBaseCommit,
            patchSha256: authorization.patchSha256,
            sourceStateSha256: authorization.sourceStateSha256,
          })),
        }),
      });
    },
  });
  const cleanupFailures = sourceCleanupResults.filter((result) => result.cleanup === "failed");
  const retainedSources = sourceCleanupResults.filter((result) => ["retained_for_review", "partial"].includes(result.cleanup));
  await updatePipelineRecord(record, {
    status: cleanupFailures.length ? "cleanup_failed" : "completed",
    finishedAt: cleanupFailures.length ? "" : (record.finishedAt || new Date().toISOString()),
    finalValidationResult,
    reviewerResult,
    testerResult,
    sanitizedWorkspaceAttestation,
    sourceCleanupResults,
    cleanupPending: cleanupFailures.length > 0,
    cleanupState: cleanupFailures.length
      ? "failed_retryable"
      : retainedSources.length
        ? "completed_with_retained_sources"
        : "completed",
    events: (record.events || []).concat(
      (record.events || []).some((event) => event.type === "finalization_completed") ? [] : [{
        type: "finalization_completed",
        at: new Date().toISOString(),
        cleanupPending: false,
      }],
      [{
        type: "source_cleanup_completed",
        at: new Date().toISOString(),
        retainedSources: retainedSources.length,
      }]
    ),
  });

  return cleanupFailures.length
    ? { ok: false, errorType: "pipeline_cleanup_failed", error: "One or more authorized source worktrees could not be removed safely.", record }
    : { ok: true, record };
}
  return { PIPELINE_TERMINAL_GATE_ERROR_TYPES, PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES, deferPipelineFinalization, PIPELINE_GATE_VERDICT_INSTRUCTION, PIPELINE_GATE_VERDICT_LINE, parsePipelineGateVerdict, PIPELINE_GATE_VERDICT_ERROR_TYPES, runPipelineReadOnlyGate, cleanupAuthorizationMatchesItem, finalizePipelineSourceCleanup, resumeAuthorizedPipelineCleanup, FINALIZING_PIPELINE_IDS, finalizePipelineRecord, finalizePipelineRecordUnderLease, finalizePipelineRecordWhileLocked, getPipelineGateExecutorTestHook, setPipelineGateExecutorTestHook };
}
