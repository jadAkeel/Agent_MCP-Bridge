// Job execution: one agent run end to end (locks, worktree, attestation, self-checks, validation and fix passes, report).
// Extracted from server.js in modularization round M-001.

import { existsSync } from "node:fs";
import { sumOpenCodeUsage } from "../bin/builder-model-fallback.js";
import { REPOSITORY_SCOPE_LOCK_PATH, normalizeLockPathList, unsafePathReason } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";
import { scopeContractPathInputs } from "./scope-contract.js";
import { formatValidationGateResult } from "./validation-command.js";
import { captureWritableScopeFilesystemState, writableScopeFilesystemViolation } from "./writable-scope.js";

// B-113: self-test only. Wraps the validation and self-check gate of a job run, so a test can
// report a process tree that could not be confirmed ended (the supervisor cannot fail on demand).
export const executeJobTestHooks = { validationGate: null };

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createExecuteJobRuntime({ CONFIG, DEFAULT_SUBAGENT_PROXY_AGENT, OPENCODE_EXE, SELF_CHECK_DEFAULT_PASSES, VALIDATION_PREFLIGHT_FIX, abortSignalErrorType, acquireHardLock, agentMetadataPolicyOptions, applyGitControlSurfaceCheck, attestContractorNestedAgents, buildCompactPrompt, buildSubagentProxyPrompt, callerPathSpellings, captureGitHead, changedFileValidationErrorType, changedFilesBetween, changedPathSetEvidence, cleanupWorktree, collectWorktreeDiff, combineAbortSignals, compactJobLines, conflictPathsFromConflict, containmentRecord, createPhaseClock, createWorktreeForJob, directExecutionLockConflictDetails, dirtyCheckpointDetails, effectiveQueueWriteConflictPolicy, effectiveReadOnlyMetadataError, fitRedactedJobResult, formatRejectedExecution, formatSingleResultParts, formatWorktreeSummary, gitChangedFileSnapshot, gitControlSurfaceFingerprint, hardLockPathsForPlan, hardLockSummary, hardLockTtlForPlan, hasWriteIntent, jobAgentRuntime, logEvent, makeQueueJobId, mergeHeavyToolCalls, nowMs, openCodeCommandLineLengthError, openCodeRunArgs, patchPreviewOmittedLine, quarantineHardLock, readAgentDefinition, readOnlyHeadMove, readOnlyRoutingPolicyError, recordChangedFiles, releaseHardLock, runValidationGate, sanitizedAgentMetadataError, sanitizedDiscoveryContext, sanitizedRoutingPolicyError, shouldUseWorktree, startHardLockHeartbeat, timeoutForAgent, truncateText, updateRetainedWorktreeMeasurement, validateChangedFilesForPlan, validateSingleLockPlan, validationCommandPreflightError, verifyJobWorkspaceReadiness, verifySanitizedWorkspace }) {
// Q-004: the validation fix pass. OpenCode's `run` can continue a session (--session <id> or
// --continue, present in OpenCode 1.18), but the spawn path passes neither: it keeps no session
// id for a job (the stream parser knows the root session but the run result does not carry it),
// and --continue resumes the project's last session, which with parallel builders may be another
// job's. Resuming by id is untested against a real model here. The fix pass is therefore a
// second fresh run in the same worktree with the job's own prompt plus the validation output;
// the files the first run wrote are already there.
const VALIDATION_FIX_MIN_REMAINING_MS = 60 * 1000;
const VALIDATION_FIX_OUTPUT_CHARS = 4000;

function jobValidationGate(options) {
  return typeof executeJobTestHooks.validationGate === "function" && process.argv.includes("--self-test")
    ? executeJobTestHooks.validationGate(runValidationGate, options)
    : runValidationGate(options);
}

// Agent process time of one run, without the wait for a provider slot (which is not part of the
// job timeout).
function agentProcessMsOf(agentResult) {
  const started = Number(agentResult?.childStartedAtMs) || 0;
  const finished = Number(agentResult?.childFinishedAtMs) || 0;
  if (started && finished) return Math.max(0, finished - started);
  return Math.max(0, (Number(agentResult?.durationMs) || 0) - (Number(agentResult?.providerConcurrencyWaitMs) || 0));
}

function buildValidationFixPrompt(prompt, validationGate) {
  const clip = (value) => String(value || "").slice(0, VALIDATION_FIX_OUTPUT_CHARS);
  return [
    prompt,
    "",
    "VALIDATION FIX PASS (the second and last run of this job)",
    "Your changes from the first run are in this working tree. The bridge then ran the validation command and it FAILED. You cannot run commands; the bridge runs it again after this pass.",
    "Fix only what the output below shows, with the same Scope Contract and allowed edits as before: do not edit other files, do not widen the scope, do not weaken or skip the check.",
    "If the failure cannot be fixed inside the allowed edits, change nothing and say why in your final report. Answer in the same report format as before.",
    "",
    `Validation command: ${validationGate.command}`,
    `Validation exit code: ${validationGate.exitCode}`,
    validationGate.stdout ? `Validation stdout:\n${clip(validationGate.stdout)}` : null,
    validationGate.stderr ? `Validation stderr:\n${clip(validationGate.stderr)}` : null,
  ].filter((line) => line !== null).join("\n");
}

// B-068: the prompt of a self-check pass: the job's own prompt plus the failing check's output.
function buildSelfCheckFixPrompt(prompt, gate, pass, passesAllowed) {
  const clip = (value) => String(value || "").slice(0, VALIDATION_FIX_OUTPUT_CHARS);
  return [
    prompt,
    "",
    `SELF-CHECK FIX PASS ${pass} of ${passesAllowed}`,
    "Your changes so far are in this working tree. The bridge ran the job's self-check commands and this one FAILED. You cannot run commands; the bridge runs every self-check again after this pass.",
    "Fix only what the output below shows, with the same Scope Contract and allowed edits as before: do not edit other files, do not widen the scope, do not weaken or skip the check.",
    "If the failure cannot be fixed inside the allowed edits, change nothing and say why in your final report. Answer in the same report format as before.",
    "",
    `Self-check command: ${gate.command}`,
    `Self-check exit code: ${gate.exitCode}`,
    gate.stdout ? `Self-check stdout:\n${clip(gate.stdout)}` : null,
    gate.stderr ? `Self-check stderr:\n${clip(gate.stderr)}` : null,
  ].filter((line) => line !== null).join("\n");
}

function selfCheckFailureSummary(gate) {
  return { command: gate.command, exitCode: gate.exitCode, excerpt: truncateText([gate.stderr, gate.stdout].filter(Boolean).join("\n"), 600) };
}

// "" when a failed self-check gets another pass, else why not (as for the Q-004 fix pass).
function selfCheckPassSkipReason({ result, validation, validationGate, aborted = false, remainingMs = 0 }) {
  if (validationGate.errorType !== "self_check_failed") return `the self-check did not run to a result (${validationGate.errorType || validationGate.status})`;
  if (!Number.isInteger(validationGate.exitCode)) return `the self-check ended without an exit code (${validationGate.exitCode})`;
  if (result.errorType !== "self_check_failed" || validation.disallowedFiles.length) return `the run also ended with ${result.errorType !== "self_check_failed" ? result.errorType : "changes outside the allowed edits"}`;
  if (aborted) return "the job was cancelled or lost its lock";
  if (remainingMs < VALIDATION_FIX_MIN_REMAINING_MS) return `only ${Math.max(0, Math.round(remainingMs / 1000))} s of the job timeout are left (a pass needs ${VALIDATION_FIX_MIN_REMAINING_MS / 1000} s)`;
  return "";
}

function formatSelfCheck(selfCheck) {
  if (!selfCheck) return "";
  const head = selfCheck.final === "failed"
    ? `Self-checks: failed (${selfCheck.failedCommand}, exit code ${selfCheck.failedExitCode})`
    : `Self-checks: ${selfCheck.final}`;
  return `${head}; fix passes used ${selfCheck.passesUsed} of ${selfCheck.passesAllowed}${selfCheck.firstFailure ? `; first failure: ${selfCheck.firstFailure.command} exit code ${selfCheck.firstFailure.exitCode}` : ""}${selfCheck.skipped ? `; no further pass: ${selfCheck.skipped}` : ""}`;
}

// "" when the failed validation gets its pass, else why not. A command that never ran, a
// timeout, an agent error of its own, a cancellation or too little time left is not fixable by
// another run.
function validationFixPassSkipReason({ result, validation, validationGate, aborted = false, remainingMs = 0 }) {
  if (validationGate.errorType !== "validation_command_failed") return `the validation command did not run to a result (${validationGate.errorType || validationGate.status})`;
  if (!Number.isInteger(validationGate.exitCode)) return `the validation command ended without an exit code (${validationGate.exitCode})`;
  if (result.errorType !== "validation_command_failed" || validation.disallowedFiles.length) return `the run also ended with ${result.errorType !== "validation_command_failed" ? result.errorType : "changes outside the allowed edits"}`;
  if (aborted) return "the job was cancelled or lost its lock";
  if (remainingMs < VALIDATION_FIX_MIN_REMAINING_MS) return `only ${Math.max(0, Math.round(remainingMs / 1000))} s of the job timeout are left (a pass needs ${VALIDATION_FIX_MIN_REMAINING_MS / 1000} s)`;
  return "";
}

// The two runs of one job reported as one: tokens, provider error lines and durations add up and
// the agent process spans from the first start to the second finish (validation between them is
// inside it), which keeps wait + agent + after-agent equal to the job duration.
function mergeValidationFixRuns(first, second) {
  return {
    ...second,
    durationMs: (Number(first.durationMs) || 0) + (Number(second.durationMs) || 0),
    usage: sumOpenCodeUsage(first.usage, second.usage),
    heavyToolCalls: mergeHeavyToolCalls(first.heavyToolCalls, second.heavyToolCalls),
    providerRetryWarningCount: (first.providerRetryWarningCount || 0) + (second.providerRetryWarningCount || 0),
    providerConcurrencyWaitMs: (Number(first.providerConcurrencyWaitMs) || 0) + (Number(second.providerConcurrencyWaitMs) || 0),
    childExecutionIntervals: [...(first.childExecutionIntervals || []), ...(second.childExecutionIntervals || [])],
    childStartedAtMs: Number(first.childStartedAtMs) || Number(second.childStartedAtMs) || 0,
  };
}

function formatValidationFixPass(info) {
  if (!info) return "";
  const first = `first validation: exit code ${info.firstValidation?.exitCode}${info.firstValidation?.excerpt ? `\n${info.firstValidation.excerpt}` : ""}`;
  return info.used
    ? `Validation fix pass: used ${info.used} of ${info.requested}; ${first}\nFinal validation: ${info.finalValidation}`
    : `Validation fix pass: skipped (${info.skipped}); ${first}`;
}

// True only for a reader whose final pre-spawn attestation passed with edits denied; any other
// reader keeps failing when the checkout changes, because it could have made the change.
function readOnlyEditsDeniedByAttestation(lockPlan, agentMetadata) {
  return lockPlan?.lockType === "read"
    && agentMetadata?.ok !== false
    && Boolean(agentMetadata?.metadata)
    && agentMetadata.metadata.canEdit === false;
}

// Files that changed in the checkout while an edit-denied reader ran. A file that is clean
// again after HEAD moved matches the new HEAD: it was committed, not edited.
function readOnlyWorkspaceDrift(changedFiles, afterSnapshot, headMoved) {
  const committedFiles = headMoved ? changedFiles.filter((file) => !afterSnapshot.has(file)) : [];
  const committed = new Set(committedFiles);
  const files = changedFiles.filter((file) => !committed.has(file));
  return {
    files: files.slice(0, 50),
    fileCount: files.length,
    committedFiles: committedFiles.slice(0, 50),
  };
}

function formatReadOnlyWorkspaceDrift(drift) {
  if (!drift || (!drift.fileCount && !drift.committedFiles?.length)) return null;
  const changed = drift.fileCount
    ? `${drift.fileCount} file(s) changed by another client: ${drift.files.join(", ")}${drift.fileCount > drift.files.length ? ", ..." : ""}`
    : "no uncommitted external changes";
  const committed = drift.committedFiles?.length ? `; committed during the run: ${drift.committedFiles.join(", ")}` : "";
  return `Checkout changed during this read-only run (the attested agent cannot edit; result kept): ${changed}${committed}. The review may describe the older version of these files.`;
}

async function executeOpenCodeJob(requestedJob, {
  toolStarted = nowMs(),
  jobId = null,
  fromQueue = false,
  signal = null,
  onChildSpawn = null,
  onWorktreePrepared = null,
  assertDurableOwnership = null,
  renewDurableOwnership = null,
} = {}) {
  const {
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "reject",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    dryRun = false,
    delegation,
  } = requestedJob;
  const effectiveJobId = jobId || makeQueueJobId(agent);
  const phaseClock = createPhaseClock();
  const { error: lockPlanError, errorType: lockPlanErrorType, suggestedFix: lockPlanSuggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(requestedJob);

  if (lockPlanError || (hasWriteIntent(requestedJob) && lockPlan.lockType === "read")) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              errorType: lockPlanErrorType || "lock_plan_rejected",
              reason: lockPlanError || `Write-capable agent "${agent}" requires lockedPaths so the bridge can create a temporary write lock.`,
              requestedAgent: agent,
              actualAgent: "none",
              lockMode: lockPlan?.lockMode || "unknown",
              durationMs: nowMs() - toolStarted,
              lockedPaths: lockPlan?.lockedPaths || [],
              allowedEdits: lockPlan?.allowedEdits || [],
              serialOnlyMatches,
              suggestedFix: lockPlanSuggestedFix || "Pass lockedPaths and allowedEdits to run_opencode_agent; do not pre-acquire locks manually.",
            }),
          },
        ],
      },
      result: {
        errorType: lockPlanErrorType || "lock_plan_rejected",
        changedFiles: [],
      },
      lockPlan,
    };
  }

  if (fromQueue && !dryRun && lockPlan.lockType !== "read" && !shouldUseWorktree(requestedJob, lockPlan)) {
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Durable queued writer rejected without isolation.",
        errorType: "queue_write_requires_worktree",
        reason: "A queued writer can outlive its bridge owner after a crash, so it must run in a retained Git worktree rather than the target checkout.",
        requestedAgent: agent,
        actualAgent: "none",
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: "Set CODEX_OPENCODE_WORKTREE_MODE=write or all and re-enqueue the job.",
      }) }] },
      result: { errorType: "queue_write_requires_worktree", changedFiles: [] },
      lockPlan,
    };
  }

  const validationPreflight = await validationCommandPreflightError(lockPlan.validationCommand, {
    dryRun,
    sanitized: Boolean(requestedJob.sanitizedWorkspace),
  });
  if (validationPreflight) {
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Validation command rejected before execution.",
        errorType: validationPreflight.errorType,
        reason: `The validation command cannot run, so no agent was started: ${validationPreflight.error}`,
        requestedAgent: agent,
        actualAgent: "none",
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: VALIDATION_PREFLIGHT_FIX,
      }) }] },
      result: {
        errorType: validationPreflight.errorType,
        changedFiles: [],
        validationGate: {
          status: "failed",
          command: validationPreflight.command,
          exitCode: validationPreflight.errorType === "validation_command_parse_error" ? "parse_error" : "not_authorized",
          durationMs: 0,
          stdout: "",
          stderr: validationPreflight.error,
          errorType: validationPreflight.errorType,
        },
      },
      lockPlan,
    };
  }

  const sanitizedPreflight = requestedJob.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "preflight_before_discovery")
    : null;
  if (sanitizedPreflight && !sanitizedPreflight.ok) {
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Sanitized workspace preflight rejected before OpenCode discovery.",
        errorType: sanitizedPreflight.errorType,
        reason: sanitizedPreflight.error,
        requestedAgent: agent,
        actualAgent: "none",
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        conflictingPaths: sanitizedPreflight.discrepancies?.map((item) => item.path) || [],
        suggestedFix: "Rebuild the sanitized workspace from its trusted manifest; do not allow OpenCode to inspect it until verification passes.",
      }) }] },
      result: { errorType: sanitizedPreflight.errorType, changedFiles: [] },
      lockPlan,
      sanitizedWorkspace: { preflight: sanitizedPreflight, before: null, after: null },
    };
  }

  {
    const gitState = await verifyJobWorkspaceReadiness(requestedJob, lockPlan);
    if (!gitState.ok) {
      return {
        response: {
          content: [{
            type: "text",
            text: formatRejectedExecution({
              headline: "Protected execution rejected.",
              errorType: gitState.errorType,
              reason: gitState.error,
              requestedAgent: agent,
              actualAgent: "none",
              lockMode: lockPlan.lockMode,
              durationMs: nowMs() - toolStarted,
              ...dirtyCheckpointDetails(gitState),
              suggestedFix: gitState.suggestedFix,
            }),
          }],
        },
        result: { errorType: gitState.errorType, changedFiles: [] },
        lockPlan,
      };
    }
  }

  phaseClock.mark("preflight");
  const discoveryContext = sanitizedDiscoveryContext({ ...requestedJob, cwd: cwd || process.cwd() });
  const { forcePure, discoveryCwd } = discoveryContext;
  const resolution = await jobAgentRuntime().resolveAgent(
    agent,
    cwd,
    allowFallbackToBuild,
    subagentStrategy,
    proxyAgent,
    lockPlan.orchestratorMode,
    discoveryContext
  );
  if (resolution.error) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "OpenCode agent routing failed.",
                errorType: "agent_routing_error",
                reason: resolution.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: "none",
                fallback: resolution.fallbackUsed,
                fallbackReason: resolution.fallbackReason,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
              }),
              "",
              `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
              `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
              `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
              `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
              `Discovery exit code: ${resolution.discoveryExitCode}`,
              `Available agents parsed: ${resolution.availableAgents.join(", ") || "none parsed"}`,
            ].join("\n"),
          },
        ],
      },
      result: {
        errorType: "agent_routing_error",
        changedFiles: [],
      },
      lockPlan,
      resolution,
    };
  }

  const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
  if (routingPolicyError) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "OpenCode agent routing rejected.",
              errorType: routingPolicyError.errorType,
              reason: routingPolicyError.error,
              requestedAgent: resolution.requestedAgent,
              actualAgent: resolution.actualAgent,
              lockMode: lockPlan.lockMode,
              durationMs: nowMs() - toolStarted,
              suggestedFix: routingPolicyError.suggestedFix,
            }),
          },
        ],
      },
      result: {
        errorType: routingPolicyError.errorType,
        changedFiles: [],
      },
      lockPlan,
      resolution,
    };
  }

  let agentMetadata = await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, discoveryCwd, { forcePure });
  const metadataPolicyError = effectiveReadOnlyMetadataError(agentMetadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
  const contractorNestedAttestation = lockPlan.orchestratorMode === "contractor"
    ? await attestContractorNestedAgents(discoveryCwd, { forcePure })
    : { ok: true };
  const contractorNestedError = contractorNestedAttestation.ok ? null : contractorNestedAttestation;
  phaseClock.mark("discovery");
  const sanitizedMetadataError = requestedJob.sanitizedWorkspace ? sanitizedAgentMetadataError(agentMetadata, requestedJob.sanitizedWorkspace.root) : null;
  const sanitizedRoutingError = sanitizedRoutingPolicyError(requestedJob, resolution, discoveryCwd);
  if (metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError) {
    const policyError = metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError;
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Effective OpenCode agent policy rejected.",
        errorType: policyError.errorType,
        reason: policyError.error,
        requestedAgent: resolution.requestedAgent,
        actualAgent: resolution.actualAgent,
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: "Use a directly runnable managed read-only agent whose exact-cwd effective debug policy denies editing, delegation, external-directory access, shell execution, and web/network tools.",
      }) }] },
      result: { errorType: policyError.errorType, changedFiles: [] },
      lockPlan,
      resolution,
    };
  }
  resolution.agentMetadata = agentMetadata.metadata || null;

  const normalizedDelegation = {
    ...delegation,
    lockMode: lockPlan.lockMode,
    lockType: lockPlan.lockType,
    orchestratorMode: lockPlan.orchestratorMode,
    userAuthorizedOrchestrator: lockPlan.userAuthorizedOrchestrator,
    lockedPaths: lockPlan.lockedPaths,
    allowedEdits: lockPlan.allowedEdits,
    forbiddenEdits: lockPlan.forbiddenEdits,
    sharedFiles: lockPlan.sharedFiles,
    scopeContract: lockPlan.scopeContract,
    validationCommand: lockPlan.validationCommand,
    pathSpellings: callerPathSpellings(requestedJob),
  };

  let prompt = buildCompactPrompt(resolution.requestedAgent, task, normalizedDelegation);
  if (resolution.proxyUsed) {
    prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
  }

  let acquiredLock = null;
  let stopLockHeartbeat = () => {};
  let executionSignal = signal;
  let worktree = null;
  let worktreeDiff = null;
  let worktreeCleanup = null;
  let emptyWorktreeRemoved = false;
  let containmentQuarantined = false;
  let containmentEvidence = "";
  // Stopping the heartbeat and releasing (or quarantining) the lock come first and happen once:
  // a later failure (measuring the retained worktree) must not leave the heartbeat renewing
  // the path lock until the process exits, and the report states what actually happened.
  let lockReleaseOutcome = null;
  const releaseAcquiredLock = async () => {
    if (lockReleaseOutcome) return lockReleaseOutcome;
    // Wait for an in-flight renewal: it must not run after the release or quarantine below.
    await stopLockHeartbeat();
    if (!acquiredLock) {
      lockReleaseOutcome = { needed: false, released: false, text: "not needed" };
      return lockReleaseOutcome;
    }
    try {
      if (containmentQuarantined) {
        const quarantined = await quarantineHardLock(acquiredLock, containmentEvidence);
        if (!quarantined.ok) {
          logEvent("error", "lock.containment_quarantine_unconfirmed", { lockId: acquiredLock.id });
        }
        lockReleaseOutcome = { needed: true, released: false, quarantined: Boolean(quarantined.ok), text: `no (containment quarantined${quarantined.ok ? "" : "; quarantine unconfirmed"})` };
      } else {
        const released = await releaseHardLock(acquiredLock.id, acquiredLock.token, acquiredLock.paths, acquiredLock.cwd);
        if (!released?.ok) {
          logEvent("warn", "lock.release_failed", { lockId: acquiredLock.id, error: released?.error || "" });
        }
        lockReleaseOutcome = released?.ok
          ? { needed: true, released: true, text: "yes" }
          : { needed: true, released: false, text: `no (${redactSensitiveText(released?.error || "release failed")}; the lock expires with its TTL)` };
      }
    } catch (error) {
      logEvent("error", "lock.release_failed", { lockId: acquiredLock.id, error: error?.message || String(error) });
      lockReleaseOutcome = { needed: true, released: false, text: `no (${redactSensitiveText(error?.message || String(error))}; the lock expires with its TTL)` };
    }
    return lockReleaseOutcome;
  };
  const shouldAcquireLock = !dryRun;
  let executionCwd = cwd || process.cwd();
  let sanitizedBefore = null;

  try {
    if (shouldAcquireLock) {
      const requestedLockPaths = hardLockPathsForPlan(lockPlan);
      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: resolution.requestedAgent,
        task,
        cwd: cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: requestedLockPaths,
        repositoryScope: requestedLockPaths.length === 1 && requestedLockPaths[0] === REPOSITORY_SCOPE_LOCK_PATH,
        ttlMs: hardLockTtlForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        const queueConflict = fromQueue && effectiveQueueWriteConflictPolicy() === "wait";
        const conflictDetails = directExecutionLockConflictDetails(lockResult, { queueConflict, lockType: lockPlan.lockType });
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: conflictDetails.headline,
                  errorType: conflictDetails.errorType,
                  reason: lockResult.error,
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: conflictDetails.suggestedFix,
                }),
              },
            ],
          },
          result: {
            errorType: conflictDetails.errorType,
            changedFiles: [],
          },
          lockPlan,
          resolution,
        };
      }

      acquiredLock = lockResult.lock;
      stopLockHeartbeat = startHardLockHeartbeat(acquiredLock, hardLockTtlForPlan(lockPlan));
      executionSignal = combineAbortSignals([signal, stopLockHeartbeat.signal]);
    }
    phaseClock.mark("lock");

    if (shouldUseWorktree(requestedJob, lockPlan)) {
      const worktreeResult = await createWorktreeForJob({
        cwd: cwd || process.cwd(),
        agent: resolution.requestedAgent,
        jobId: effectiveJobId,
        lockedPaths: lockPlan.lockedPaths,
        allowedEdits: lockPlan.allowedEdits,
        scopeContract: lockPlan.scopeContract,
      });

      if (!worktreeResult.ok) {
        const dirtyDetails = dirtyCheckpointDetails(worktreeResult);
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: "Worktree setup failed.",
                  errorType: worktreeResult.errorType || "worktree_create_failed",
                  reason: worktreeResult.error || "Could not create a Git worktree for this job.",
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  lockedPaths: lockPlan.lockedPaths,
                  allowedEdits: lockPlan.allowedEdits,
                  conflictingPaths: worktreeResult.conflictingPaths || dirtyDetails.conflictingPaths,
                  dirtyFiles: dirtyDetails.dirtyFiles,
                  overlappingFiles: dirtyDetails.overlappingFiles,
                  disjointFiles: dirtyDetails.disjointFiles,
                  suggestedFix: worktreeResult.suggestedFix || "Create/select a clean reproducible checkpoint, choose a safe worktree root, and ensure this cwd is a Git repository with git available.",
                }),
              },
            ],
          },
          result: {
            errorType: worktreeResult.errorType || "worktree_create_failed",
            changedFiles: [],
            dirtyFiles: dirtyDetails.dirtyFiles,
            overlappingFiles: dirtyDetails.overlappingFiles,
            disjointFiles: dirtyDetails.disjointFiles,
            conflictingPaths: dirtyDetails.conflictingPaths,
          },
          lockPlan,
          resolution,
          worktree: worktreeResult,
        };
      }

      worktree = worktreeResult;
      executionCwd = worktree.path;
      if (typeof onWorktreePrepared === "function") await onWorktreePrepared(worktree);
      phaseClock.mark("worktreeSetup");
    }

    const manifestProtected = Boolean(requestedJob.sanitizedWorkspace);
    if (manifestProtected && !dryRun) {
      sanitizedBefore = await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "before_wave");
      if (!sanitizedBefore.ok) {
        return {
          response: { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Sanitized workspace changed between preflight and execution.",
            errorType: sanitizedBefore.errorType,
            reason: sanitizedBefore.error,
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: nowMs() - toolStarted,
            conflictingPaths: sanitizedBefore.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Retain the workspace for investigation and rebuild it from its trusted manifest before retrying.",
          }) }] },
          result: { errorType: sanitizedBefore.errorType, changedFiles: [] },
          lockPlan,
          resolution,
          sanitizedWorkspace: { preflight: sanitizedPreflight, before: sanitizedBefore, after: null },
        };
      }
    }
    const finalAgentMetadata = dryRun
      ? agentMetadata
      : await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, executionCwd, {
        forcePure,
        worktreeIdentity: worktree ? { repoRoot: worktree.repoRoot, baseTree: worktree.baseTree } : null,
      });
    const finalMetadataPolicyError = effectiveReadOnlyMetadataError(
      finalAgentMetadata,
      lockPlan,
      agentMetadataPolicyOptions(resolution, lockPlan, agentMetadata.metadata)
    );
    const finalContractorNestedAttestation = dryRun
      ? contractorNestedAttestation
      : lockPlan.orchestratorMode === "contractor"
      ? await attestContractorNestedAgents(executionCwd, { forcePure })
      : { ok: true };
    const finalContractorNestedError = finalContractorNestedAttestation.ok ? null : finalContractorNestedAttestation;
    phaseClock.mark(worktree ? "worktreeAttestation" : "discovery");
    const finalSanitizedMetadataError = manifestProtected ? sanitizedAgentMetadataError(finalAgentMetadata, requestedJob.sanitizedWorkspace.root) : null;
    const finalSanitizedRoutingError = sanitizedRoutingPolicyError(requestedJob, resolution, executionCwd);
    if (finalMetadataPolicyError || finalContractorNestedError || finalSanitizedMetadataError || finalSanitizedRoutingError) {
      const policyError = finalMetadataPolicyError || finalContractorNestedError || finalSanitizedMetadataError || finalSanitizedRoutingError;
      return {
        response: { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Final pre-spawn OpenCode agent policy rejected.",
          errorType: policyError.errorType,
          reason: policyError.error,
          requestedAgent: resolution.requestedAgent,
          actualAgent: resolution.actualAgent,
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: worktree
            ? `Inspect the retained worktree ${worktree.path}; its effective agent definition differs from the attested source policy.`
            : "Restore the bridge-managed effective agent definition and retry.",
        }) }] },
        result: { errorType: policyError.errorType, changedFiles: [] },
        lockPlan,
        resolution,
        worktree,
        sanitizedWorkspace: manifestProtected ? { preflight: sanitizedPreflight, before: sanitizedBefore, after: null } : null,
      };
    }
    agentMetadata = finalAgentMetadata;
    resolution.agentMetadata = finalAgentMetadata.metadata;
    if (typeof assertDurableOwnership === "function") {
      const ownership = await assertDurableOwnership();
      if (!ownership?.ok) {
        const ownershipError = ownership?.error || new Error("Durable queue ownership was lost before agent spawn.");
        ownershipError.errorType ||= "queue_ownership_lost";
        return {
          response: { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Durable queue ownership was lost before execution.",
            errorType: ownershipError.errorType,
            reason: ownershipError.message || String(ownershipError),
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: nowMs() - toolStarted,
            suggestedFix: "Inspect the retained worktree and durable queue record; do not resume this execution generation.",
          }) }] },
          result: { errorType: ownershipError.errorType, changedFiles: [] },
          lockPlan,
          resolution,
          worktree,
        };
      }
    }
    // A reader whose attested effective policy denies every edit cannot have changed the
    // checkout, so a difference there is another client's work (a commit, an editor save,
    // coverage/ from a test run): it is reported, not held against the reader.
    const readerEditsDenied = !dryRun && !manifestProtected && readOnlyEditsDeniedByAttestation(lockPlan, agentMetadata);
    const readerSnapshotOptions = readerEditsDenied ? { includeIgnored: false } : {};
    const beforeFiles = dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
    const gitControlBefore = dryRun || manifestProtected || lockPlan.lockType === "read" ? null : await gitControlSurfaceFingerprint(executionCwd);
    const executionHeadBefore = dryRun || manifestProtected ? "" : await captureGitHead(executionCwd);
    const scopeFilesystemBefore = dryRun || manifestProtected || lockPlan.lockType !== "write"
      ? null
      : await captureWritableScopeFilesystemState(executionCwd, lockPlan);
    if (scopeFilesystemBefore && !scopeFilesystemBefore.ok) {
      // No agent ran, so the worktree is empty: keeping it only filled the retained-worktree cap.
      if (worktree) await cleanupWorktree(worktree, "always", true).catch(() => null);
      return {
        response: { content: [{ type: "text", text: formatRejectedExecution({
          headline: "The writable scope could not be recorded before execution.",
          errorType: scopeFilesystemBefore.errorType,
          reason: scopeFilesystemBefore.error,
          requestedAgent: resolution.requestedAgent,
          actualAgent: resolution.actualAgent,
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: "Narrow allowedEdits to the files the job needs, or fix the permissions of the scope, and retry. No agent was started.",
        }) }] },
        result: { errorType: scopeFilesystemBefore.errorType, changedFiles: [] },
        lockPlan,
        resolution,
        worktree: null,
      };
    }
    phaseClock.mark("preAgentSnapshot");
    const persistExecutionSupervisorAuthority = async (spawnIdentity) => {
      const childAuthority = typeof onChildSpawn === "function"
        ? await onChildSpawn(spawnIdentity)
        : { ok: true, deadlineAt: Number.POSITIVE_INFINITY };
      return {
        ok: childAuthority?.ok !== false,
        deadlineAt: Math.min(
          Number(acquiredLock?.expiresAt || Number.POSITIVE_INFINITY),
          Number(childAuthority?.deadlineAt || Number.POSITIVE_INFINITY)
        ),
      };
    };
    const renewExecutionSupervisorAuthority = async () => {
      const lockRenewed = acquiredLock ? await stopLockHeartbeat.pulse() : true;
      if (!lockRenewed) return { ok: false };
      const external = typeof renewDurableOwnership === "function"
        ? await renewDurableOwnership()
        : { ok: true, deadlineAt: Number.POSITIVE_INFINITY };
      return {
        ok: external?.ok !== false,
        deadlineAt: Math.min(
          Number(acquiredLock?.expiresAt || Number.POSITIVE_INFINITY),
          Number(external?.deadlineAt || Number.POSITIVE_INFINITY)
        ),
      };
    };
    const selfCheckCommands = Array.isArray(lockPlan.scopeContract?.selfCheckCommands) && lockPlan.lockType !== "read"
      ? lockPlan.scopeContract.selfCheckCommands.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const runAgent = (agentPrompt, runTimeoutMs) => jobAgentRuntime().runOpenCodeWithPolicy(
      resolution.actualAgent,
      agentPrompt,
      executionCwd,
      dryRun,
      lockPlan,
      runTimeoutMs,
      {
        signal: executionSignal,
        agentMetadata,
        onSpawn: persistExecutionSupervisorAuthority,
        onSupervisorHeartbeat: renewExecutionSupervisorAuthority,
        // Q-012: the checkout the job targets; an external runner's guard watches it.
        targetCwd: cwd || process.cwd(),
      }
    );
    // B-113: a validation or self-check command whose process tree could not be confirmed ended
    // may still write the checkout, so the lock is quarantined as for an unconfirmed agent tree
    // (the integration path does the same) instead of letting the next writer in.
    const quarantineForValidationTree = async (gate) => {
      if (!gate?.processTreeUnconfirmed) return;
      containmentQuarantined = true;
      containmentEvidence = await containmentRecord(gate);
    };
    // Q-004: everything that judges one agent run (changed files against the scope, git control
    // surface, HEAD, scope filesystem state, then the validation command) is one closure, so the
    // validation fix pass judges its second run exactly as the first.
    const evaluateAgentRun = async (result) => {
      phaseClock.mark("openCodeRun");
      containmentQuarantined = result?.errorType === "process_tree_termination_unconfirmed"
        || result?.terminationErrorType === "process_tree_termination_unconfirmed";
      if (containmentQuarantined) containmentEvidence = await containmentRecord(result);
      if (stopLockHeartbeat.signal?.aborted) {
        result.errorType = abortSignalErrorType(stopLockHeartbeat.signal, result.errorType || "write_lock_ownership_lost");
        result.stderr = [result.stderr, stopLockHeartbeat.signal.reason?.message || "Durable lock ownership was lost during execution."].filter(Boolean).join("\n");
      }
      const afterFiles = dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
      // Validation is judged on tracked and untracked files only: ignored build/cache output
      // (__pycache__/, coverage/) written by a test command is not a workspace mutation.
      const afterFilesForValidation = dryRun || manifestProtected || readerEditsDenied
        ? afterFiles
        : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
      const executionHeadAfterAgent = dryRun || manifestProtected ? executionHeadBefore : await captureGitHead(executionCwd);
      const sanitizedAfter = manifestProtected && !dryRun
        ? await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "after_wave")
        : null;
      result.changedFiles = sanitizedAfter && !sanitizedAfter.ok
        ? normalizeLockPathList((sanitizedAfter.discrepancies || []).map((item) => item.path))
        : changedFilesBetween(beforeFiles, afterFiles);
      if (readerEditsDenied && result.changedFiles.length) {
        result.readOnlyWorkspaceDrift = readOnlyWorkspaceDrift(result.changedFiles, afterFiles, executionHeadBefore !== executionHeadAfterAgent);
        result.changedFiles = [];
      }
      if (gitControlBefore) applyGitControlSurfaceCheck(result, gitControlBefore, await gitControlSurfaceFingerprint(executionCwd));
      if (executionHeadAfterAgent !== executionHeadBefore && !result.errorType) {
        const move = result.changedFiles.length ? null : await readOnlyHeadMove(lockPlan, executionCwd, executionHeadBefore, executionHeadAfterAgent);
        if (move) {
          result.readOnlyHeadMove = move;
        } else {
          result.errorType = "repository_head_changed_during_execution";
          result.stderr = [result.stderr, "Repository HEAD changed during OpenCode execution. The change is unattributed and was retained for review."].filter(Boolean).join("\n");
        }
      }
      result.executionHeadBefore = executionHeadBefore;
      result.executionHeadAfter = executionHeadAfterAgent;
      if (sanitizedAfter && !sanitizedAfter.ok && !result.errorType) {
        result.errorType = sanitizedAfter.errorType;
        result.stderr = [result.stderr, sanitizedAfter.error].filter(Boolean).join("\n");
      }
      result.sanitizedWorkspaceVerification = manifestProtected ? { preflight: sanitizedPreflight, before: sanitizedBefore, after: sanitizedAfter } : null;

      let validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
      const postExecutionPathError = dryRun ? "" : unsafePathReason(
        lockPlan.lockedPaths.concat(
          lockPlan.allowedEdits,
          lockPlan.forbiddenEdits,
          lockPlan.sharedFiles,
          scopeContractPathInputs(lockPlan.scopeContract),
          result.changedFiles
        ),
        executionCwd
      );
      if (postExecutionPathError) {
        validation.disallowedFiles = normalizeLockPathList(validation.disallowedFiles.concat(result.changedFiles));
        result.errorType ||= "unsafe_path_after_execution";
        result.stderr = [result.stderr, postExecutionPathError].filter(Boolean).join("\n");
      }
      const scopeFilesystemViolation = scopeFilesystemBefore
        ? writableScopeFilesystemViolation(scopeFilesystemBefore, await captureWritableScopeFilesystemState(executionCwd, lockPlan))
        : null;
      if (scopeFilesystemViolation) {
        validation.disallowedFiles = normalizeLockPathList(validation.disallowedFiles.concat(scopeFilesystemViolation.paths));
        result.unsafeFilesystemPaths = scopeFilesystemViolation.paths;
        result.errorType ||= scopeFilesystemViolation.errorType;
        result.stderr = [result.stderr, scopeFilesystemViolation.error].filter(Boolean).join("\n");
      }
      phaseClock.mark("postAgentChecks");
      // B-068: the bridge runs the job's self-check commands first, like validationCommand (same
      // trust rules, same supervisor and timeout); the first failing one stands in for the
      // validation gate, so the self-check pass below can hand its output to the agent.
      if (selfCheckCommands.length && !dryRun && !manifestProtected && !validation.disallowedFiles.length && !result.errorType) {
        result.selfChecksRan = true;
        for (const command of selfCheckCommands) {
          const check = await jobValidationGate({ command, cwd: executionCwd, dryRun, timeoutMs: CONFIG.validationCommandTimeoutMs, signal: executionSignal });
          if (check.status !== "passed") {
            const selfCheckGate = { ...check, selfCheck: true, errorType: check.errorType === "validation_command_failed" ? "self_check_failed" : check.errorType || "self_check_failed" };
            result.errorType = selfCheckGate.errorType;
            await quarantineForValidationTree(selfCheckGate);
            phaseClock.mark("validation");
            return { result, afterFiles, afterFilesForValidation, executionHeadAfterAgent, validation, validationGate: selfCheckGate };
          }
        }
      }
      const validationGate = manifestProtected
        ? { status: sanitizedAfter?.ok ? "passed_manifest" : "failed_manifest", command: "", exitCode: sanitizedAfter?.ok ? 0 : 1, durationMs: 0, stdout: "", stderr: sanitizedAfter?.error || "", errorType: sanitizedAfter?.ok ? null : sanitizedAfter?.errorType }
        : !validation.disallowedFiles.length && !result.errorType
        ? await jobValidationGate({ command: lockPlan.validationCommand, cwd: executionCwd, dryRun, timeoutMs: CONFIG.validationCommandTimeoutMs, signal: executionSignal })
        : {
            status: lockPlan.validationCommand ? "skipped_due_to_prior_failure" : "skipped",
            command: lockPlan.validationCommand || "",
            exitCode: "not_run",
            durationMs: 0,
            stdout: "",
            stderr: "",
            errorType: null,
          };
      if (validationGate.errorType && !result.errorType) {
        result.errorType = validationGate.errorType;
      }
      await quarantineForValidationTree(validationGate);
      phaseClock.mark("validation");
      return { result, afterFiles, afterFilesForValidation, executionHeadAfterAgent, validation, validationGate };
    };
    let { result, afterFiles, afterFilesForValidation, executionHeadAfterAgent, validation, validationGate } = await evaluateAgentRun(await runAgent(prompt, lockPlan.timeoutMs));
    // B-068: a failed self-check gives the agent another run in the same worktree with the check's
    // output, up to selfCheckPasses (default 2); every run is judged by the same checks, and the
    // self-checks (then validationCommand) run again after each.
    if (selfCheckCommands.length && !dryRun) {
      const passesAllowed = Number.isInteger(requestedJob.selfCheckPasses) ? requestedJob.selfCheckPasses : SELF_CHECK_DEFAULT_PASSES;
      const firstFailure = validationGate.selfCheck ? selfCheckFailureSummary(validationGate) : null;
      let passesUsed = 0;
      let skipped = "";
      while (validationGate.selfCheck && validationGate.status === "failed" && passesUsed < passesAllowed) {
        const remainingMs = Math.floor(timeoutForAgent(resolution.actualAgent, lockPlan, lockPlan.timeoutMs) - agentProcessMsOf(result));
        const fixPrompt = buildSelfCheckFixPrompt(prompt, validationGate, passesUsed + 1, passesAllowed);
        skipped = selfCheckPassSkipReason({ result, validation, validationGate, aborted: Boolean(executionSignal?.aborted), remainingMs })
          || openCodeCommandLineLengthError(OPENCODE_EXE, openCodeRunArgs(resolution.actualAgent, fixPrompt, null));
        if (skipped) break;
        const fixedRun = await runAgent(fixPrompt, remainingMs);
        ({ result, afterFiles, afterFilesForValidation, executionHeadAfterAgent, validation, validationGate } = await evaluateAgentRun(mergeValidationFixRuns(result, fixedRun)));
        passesUsed += 1;
      }
      result.selfCheck = {
        commands: selfCheckCommands,
        passesAllowed,
        passesUsed,
        firstFailure,
        final: validationGate.selfCheck ? "failed" : result.selfChecksRan ? "passed" : "not_run",
        ...(validationGate.selfCheck ? { failedCommand: validationGate.command, failedExitCode: validationGate.exitCode } : {}),
        ...(skipped ? { skipped } : {}),
      };
    }
    // Q-004: a builder cannot run its own checks, so a job that asked for validationFixPasses: 1
    // gets one more run in the same worktree when its validation command failed, with the
    // validation output, inside what is left of the job timeout. The second run is judged by the
    // same checks and the validation command runs again; the job fails as before if it still fails.
    if (Number(requestedJob.validationFixPasses) === 1 && !dryRun && validationGate.status === "failed" && !validationGate.selfCheck) {
      const firstValidation = {
        exitCode: validationGate.exitCode,
        durationMs: validationGate.durationMs || 0,
        excerpt: truncateText([validationGate.stderr, validationGate.stdout].filter(Boolean).join("\n"), 600),
      };
      const remainingMs = Math.floor(timeoutForAgent(resolution.actualAgent, lockPlan, lockPlan.timeoutMs) - agentProcessMsOf(result));
      const fixPrompt = buildValidationFixPrompt(prompt, validationGate);
      const skipReason = validationFixPassSkipReason({ result, validation, validationGate, aborted: Boolean(executionSignal?.aborted), remainingMs })
        || openCodeCommandLineLengthError(OPENCODE_EXE, openCodeRunArgs(resolution.actualAgent, fixPrompt, null));
      if (skipReason) {
        result.validationFixPass = { requested: 1, used: 0, skipped: skipReason, firstValidation };
      } else {
        const fixedRun = await runAgent(fixPrompt, remainingMs);
        ({ result, afterFiles, afterFilesForValidation, executionHeadAfterAgent, validation, validationGate } = await evaluateAgentRun(mergeValidationFixRuns(result, fixedRun)));
        result.validationFixPass = { requested: 1, used: 1, firstValidation, finalValidation: validationGate.status };
      }
    }

    const afterValidationFiles = dryRun || manifestProtected ? afterFiles : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
    if (gitControlBefore && lockPlan.validationCommand) {
      applyGitControlSurfaceCheck(result, gitControlBefore, await gitControlSurfaceFingerprint(executionCwd), "validation");
    }
    const executionHeadAfterValidation = dryRun || manifestProtected ? executionHeadAfterAgent : await captureGitHead(executionCwd);
    phaseClock.mark("postValidationChecks");
    const validationMutationFiles = dryRun || manifestProtected ? [] : changedFilesBetween(afterFilesForValidation, afterValidationFiles);
    if (executionHeadAfterValidation !== executionHeadBefore) {
      const move = result.errorType || validationMutationFiles.length || result.changedFiles.length
        ? null
        : await readOnlyHeadMove(lockPlan, executionCwd, executionHeadBefore, executionHeadAfterValidation);
      if (move) {
        result.readOnlyHeadMove = move;
      } else {
        result.errorType ||= "repository_head_changed_during_execution";
        result.stderr = [result.stderr, "Repository HEAD changed before execution validation completed. The change is unattributed and was retained for review."].filter(Boolean).join("\n");
      }
      result.executionHeadAfter = executionHeadAfterValidation;
    }
    if (validationMutationFiles.length) {
      result.changedFiles = normalizeLockPathList(result.changedFiles.concat(validationMutationFiles));
      validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
      result.validationMutationFiles = validationMutationFiles;
      result.errorType ||= "validation_mutated_workspace";
      result.stderr = [result.stderr, `Validation changed workspace paths after agent execution: ${validationMutationFiles.join(", ")}. The changes were retained as unattributed external state.`].filter(Boolean).join("\n");
      const postValidationPathError = unsafePathReason(
        lockPlan.lockedPaths.concat(
          lockPlan.allowedEdits,
          lockPlan.forbiddenEdits,
          lockPlan.sharedFiles,
          scopeContractPathInputs(lockPlan.scopeContract),
          result.changedFiles
        ),
        executionCwd
      );
      if (postValidationPathError) {
        validation.disallowedFiles = normalizeLockPathList(validation.disallowedFiles.concat(validationMutationFiles));
        result.stderr = [result.stderr, postValidationPathError].filter(Boolean).join("\n");
      }
    }

    const unresolvedValidationFiles = normalizeLockPathList(validation.disallowedFiles.concat(validationMutationFiles));
    const rollbackResult = unresolvedValidationFiles.length && !dryRun && !manifestProtected
      ? {
          rollback: "not_attempted_unattributed_changes",
          rollbackFiles: [],
          unresolvedFiles: unresolvedValidationFiles,
          reason: worktree
            ? "Rejected output was retained in the bridge-owned worktree for exact inspection; the bridge cannot distinguish a concurrent external edit by path alone."
            : "The bridge did not overwrite or delete changes in the user's workspace because path-only evidence cannot attribute them to OpenCode or validation rather than a concurrent user or process.",
        }
      : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };

    if (worktree) {
      worktreeDiff = await collectWorktreeDiff(worktree);
      phaseClock.mark("patchCollect");
      if (worktreeDiff?.errorType && !result.errorType) {
        result.errorType = worktreeDiff.errorType;
        result.stderr = [result.stderr, worktreeDiff.error].filter(Boolean).join("\n");
      }
      if (!worktreeDiff?.errorType) {
        const representablePaths = changedPathSetEvidence(result.changedFiles, worktreeDiff?.changedFiles || []);
        const unrepresentableFiles = normalizeLockPathList(representablePaths.missingFiles.concat(representablePaths.unexpectedFiles));
        if (unrepresentableFiles.length) {
          result.changedFiles = normalizeLockPathList(result.changedFiles.concat(worktreeDiff?.changedFiles || []));
          validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
          result.errorType ||= "worktree_output_unrepresentable";
          result.unrepresentableFiles = unrepresentableFiles;
          result.stderr = [
            result.stderr,
            `Execution output and the integratable Git patch differ at: ${unrepresentableFiles.join(", ")}. Ignored, committed-during-run, or otherwise unrepresentable output was retained in the worktree and cannot be reported as successful.`,
          ].filter(Boolean).join("\n");
          rollbackResult.rollback = "not_attempted_unattributed_changes";
          rollbackResult.unresolvedFiles = normalizeLockPathList(rollbackResult.unresolvedFiles.concat(unrepresentableFiles));
        }
      }
      // A job that changed nothing (most failures: provider errors, early timeouts) leaves
      // nothing to review or integrate. Keeping those worktrees filled the retained-worktree
      // cap (worktree_capacity_exceeded) over a long run, and GC cannot run while any
      // bridge is alive. Only a verified empty diff is removed.
      const producedNothing = worktreeDiff
        && !worktreeDiff.errorType
        && !(worktreeDiff.changedFiles || []).length
        && !(result.changedFiles || []).length
        && !(result.unrepresentableFiles || []).length
        && !validation.disallowedFiles.length;
      worktreeCleanup = producedNothing
        // A failed removal of an empty worktree is reported, never turned into a job failure.
        ? { ...(await cleanupWorktree(worktree, "always", true)), errorType: undefined, reason: "the job changed no files, so there was nothing to retain" }
        : {
          cleanup: "retained_for_review",
          reason: result.errorType || validation.disallowedFiles.length
            ? "failed or rejected write output is retained for diagnosis and recovery"
            : "successful write output is retained until reviewed integration and a passing validation gate",
        };
      // Once the empty worktree is gone its path names nothing: reporting it made the queue
      // record and the pipeline offer a removed worktree for integration forever.
      emptyWorktreeRemoved = producedNothing && ["success", "partial"].includes(worktreeCleanup.cleanup);
      if (producedNothing) result.noChanges = true;
      result.worktree = {
        path: emptyWorktreeRemoved ? "" : worktree.path,
        branch: emptyWorktreeRemoved ? "" : worktree.branch,
        baseCommit: worktree.baseCommit,
        baseTree: worktree.baseTree,
        patchSha256: worktreeDiff?.patchSha256 || "",
        sourceStateSha256: worktreeDiff?.sourceStateSha256 || "",
        cleanup: worktreeCleanup.cleanup,
        removed: emptyWorktreeRemoved,
        removedPath: emptyWorktreeRemoved ? worktree.path : "",
        changedFiles: worktreeDiff?.changedFiles || [],
        diffStat: worktreeDiff?.diffStat || "",
      };
      if (worktreeCleanup.errorType && !result.errorType) {
        result.errorType = worktreeCleanup.errorType;
      }
    }

    await recordChangedFiles(acquiredLock?.id, cwd, result.changedFiles, validation.disallowedFiles);
    const validationErrorType = validation.disallowedFiles.length && worktree && changedFileValidationErrorType(validation) === "changed_file_validation_error"
      ? "worktree_changed_file_validation_error"
      : changedFileValidationErrorType(validation);
    const lockViolation = validation.disallowedFiles.length
      ? [
          "",
          "Write lock verification:",
          formatRejectedExecution({
            headline: "OpenCode result rejected.",
            errorType: validationErrorType,
            reason: "The OpenCode result changed files outside the granted allowedEdits or Scope Contract, touched forbidden/shared paths, or a read-only agent edited files.",
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: result.durationMs ?? nowMs() - toolStarted,
            conflictingPaths: validation.disallowedFiles,
            lockedPaths: lockPlan.lockedPaths,
            allowedEdits: lockPlan.allowedEdits,
            runId: acquiredLock?.id || "",
            rollback: rollbackResult.rollback,
            disallowedFiles: validation.disallowedFiles,
            serialOnlyMatches: validation.serialOnlyMatches,
            rollbackFiles: rollbackResult.rollbackFiles,
            unresolvedFiles: rollbackResult.unresolvedFiles,
            suggestedFix: "Inspect any unresolved files, then rerun with explicit lockedPaths and allowedEdits or handle the work serially.",
          }),
        ].join("\n")
      : ["", "Write lock verification:", "Accepted. Detected changed files stayed inside allowedEdits and did not touch forbidden/shared paths."].join("\n");
    const nativeFallbackViolation = result.openCodeFallbackDetected
      ? [
          "",
          "OpenCode native fallback verification:",
          "Rejected. The requested role may not have executed because OpenCode fell back internally.",
        ].join("\n")
      : ["", "OpenCode native fallback verification:", "Accepted. No native fallback detected."].join("\n");
    const apiErrorViolation = result.openCodeApiErrorDetected
      ? [
          "",
          "OpenCode API error verification:",
          "Rejected. OpenCode returned an API error event even though the process may have exited successfully.",
        ].join("\n")
      : ["", "OpenCode API error verification:", "Accepted. No OpenCode API error detected."].join("\n");
    const finalResponseViolation = !dryRun && !result.assistantFinalResponseDetected
      ? ["", "OpenCode final response verification:", "Rejected. OpenCode did not emit a non-empty terminal assistant text event."].join("\n")
      : ["", "OpenCode final response verification:", dryRun ? "Skipped for dry run." : "Accepted. A terminal assistant response was detected."].join("\n");
    // L-026: the patch preview is the largest part of a writer's result and the integration dry
    // run shows the same patch, so the stored text leaves it out (a pointer line says how to get
    // it) and keeps it apart as detail; the direct response still carries it.
    const patchPreview = worktreeDiff?.patchPreview || "";
    const worktreeReviewWith = (patchLine) => (worktree
      ? [
          "",
          "Worktree review:",
          formatWorktreeSummary(worktree, worktreeCleanup),
          `Worktree changed files: ${(worktreeDiff?.changedFiles || []).length ? worktreeDiff.changedFiles.join(", ") : "none detected"}`,
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : "Worktree diff stat: none",
          patchLine,
        ].join("\n")
      : ["", "Worktree review:", "Worktree: not used"].join("\n"));
    const worktreeReview = worktreeReviewWith(patchPreview ? `Worktree patch preview:\n${patchPreview}` : "Worktree patch preview: none");
    const worktreeReviewWithoutPatch = worktreeReviewWith(patchPreview ? patchPreviewOmittedLine(patchPreview.length) : "Worktree patch preview: none");

    // The job's work is done; the lock is released before the report so the report can say
    // whether it really was.
    phaseClock.mark("cleanup");
    const lockRelease = await releaseAcquiredLock();
    result.lockRelease = { needed: lockRelease.needed, released: lockRelease.released };
    phaseClock.mark("report");
    result.phaseTimings = phaseClock.summary(result);
    const lockLines = [`Temporary lock acquired: ${hardLockSummary(acquiredLock)}`, `Temporary lock released: ${lockRelease.text}`];
    const singleParts = formatSingleResultParts({ resolution, result, cwd: executionCwd, lockPlan });
    const driftLine = formatReadOnlyWorkspaceDrift(result.readOnlyWorkspaceDrift);
    const validationGateText = [formatSelfCheck(result.selfCheck), formatValidationFixPass(result.validationFixPass), formatValidationGateResult(validationGate)].filter(Boolean).join("\n");
    // Stored view (queue result text, run audit): the same text without the patch preview, fitted
    // to the result limit report-first. The lock lines are safety evidence, so they stay in the
    // shortened stand-in for the preamble.
    const fitted = fitRedactedJobResult({
      head: [...lockLines, singleParts.preamble].join("\n"),
      headStandIn: [...lockLines, ...compactJobLines({ resolution, result, unsafeFiles: validation.disallowedFiles })].join("\n"),
      report: singleParts.report,
      tail: [
        singleParts.stderr,
        driftLine,
        worktreeReviewWithoutPatch,
        nativeFallbackViolation,
        apiErrorViolation,
        finalResponseViolation,
        validationGateText,
        lockViolation,
      ].filter((line) => line !== null).join("\n"),
    });
    return {
      response: {
        content: [
          {
            type: "text",
            text: [
              ...lockLines,
              [singleParts.preamble, singleParts.report, singleParts.stderr].join("\n"),
              driftLine,
              worktreeReview,
              nativeFallbackViolation,
              apiErrorViolation,
              finalResponseViolation,
              validationGateText,
              lockViolation,
            ].filter((line) => line !== null).join("\n"),
          },
        ],
      },
      resultRecord: {
        text: fitted.text,
        detailText: [fitted.movedHead, patchPreview ? `Worktree patch preview:\n${patchPreview}` : ""].filter(Boolean).join("\n\n"),
        chars: fitted.chars,
        reportTruncated: fitted.reportTruncated,
      },
      result,
      lockPlan,
      resolution,
      validation,
      worktree: emptyWorktreeRemoved ? null : worktree,
      worktreeCleanup,
      sanitizedWorkspace: result.sanitizedWorkspaceVerification || null,
    };
  } catch (error) {
    // An empty worktree that was already removed is not retained work.
    if (emptyWorktreeRemoved) worktree = null;
    let retainedDiff = null;
    if (worktree) {
      try { retainedDiff = await collectWorktreeDiff(worktree); } catch { retainedDiff = null; }
    }
    const lockRelease = await releaseAcquiredLock();
    const worktreeDetails = worktree ? {
      path: worktree.path,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      baseTree: worktree.baseTree,
      patchSha256: retainedDiff?.patchSha256 || "",
      sourceStateSha256: retainedDiff?.sourceStateSha256 || "",
      cleanup: "retained_for_review",
      changedFiles: retainedDiff?.changedFiles || [],
      diffStat: retainedDiff?.diffStat || "",
    } : null;
    const errorText = redactSensitiveText(error.message || String(error));
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "OpenCode job infrastructure failed closed.",
        errorType: "job_infrastructure_failed",
        reason: `${errorText}${worktree ? " The isolated worktree and branch were retained for recovery." : " No broad rollback was attempted because concurrent or pre-existing user changes cannot be distinguished safely after this infrastructure fault."}`,
        requestedAgent: resolution.requestedAgent,
        actualAgent: resolution.actualAgent,
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        unresolvedFiles: worktreeDetails?.changedFiles || [],
        suggestedFix: "Inspect the retained worktree or target checkout before retrying; do not discard recovery evidence.",
      }) + `\nTemporary lock released: ${lockRelease.text}` }] },
      result: {
        errorType: "job_infrastructure_failed",
        error: errorText,
        changedFiles: worktreeDetails?.changedFiles || [],
        worktree: worktreeDetails,
        lockRelease: { needed: lockRelease.needed, released: lockRelease.released },
      },
      lockPlan,
      resolution,
      worktree,
      worktreeCleanup: worktree ? { cleanup: "retained_for_review", reason: "infrastructure failure" } : null,
    };
  } finally {
    // Release first (idempotent: the report paths above already did), then measure; a failed
    // measurement is logged and never replaces the job result.
    await releaseAcquiredLock();
    if (worktree?.path && existsSync(worktree.path)) {
      try {
        await updateRetainedWorktreeMeasurement(worktree);
      } catch (error) {
        logEvent("warn", "worktree.measurement_failed", {
          worktreePath: worktree.path,
          error: redactSensitiveText(error?.message || String(error)),
        });
      }
    }
  }
}
  return { VALIDATION_FIX_MIN_REMAINING_MS, VALIDATION_FIX_OUTPUT_CHARS, agentProcessMsOf, buildValidationFixPrompt, buildSelfCheckFixPrompt, selfCheckFailureSummary, selfCheckPassSkipReason, formatSelfCheck, validationFixPassSkipReason, mergeValidationFixRuns, formatValidationFixPass, readOnlyEditsDeniedByAttestation, readOnlyWorkspaceDrift, formatReadOnlyWorkspaceDrift, executeOpenCodeJob };
}
