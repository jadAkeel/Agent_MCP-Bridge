// MCP tool run_opencode_parallel: parallel agent jobs under strict locks, with per-job blocks and stored results.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { REPOSITORY_SCOPE_LOCK_PATH, normalizeLockPathList, unsafeChangedFiles, unsafePathReason } from "../paths.js";
import { redactSensitiveText } from "../redaction.js";
import { scopeContractPathInputs } from "../scope-contract.js";
import { formatValidationGateResult } from "../validation-command.js";
import { captureWritableScopeFilesystemState, writableScopeFilesystemViolation } from "../writable-scope.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerParallelTool({ CONFIG, DEFAULT_SUBAGENT_PROXY_AGENT, VALIDATION_PREFLIGHT_FIX, acquireHardLock, agentMetadataPolicyOptions, applyGitControlSurfaceCheck, buildCompactPrompt, buildSubagentProxyPrompt, callerPathSpellings, captureGitHead, changedFilesBetween, changedPathSetEvidence, cleanupWorktree, collectWorktreeDiff, compactFileList, compactJobLines, conflictPathsFromConflict, createPhaseClock, createWorktreeForJob, directRunAuditStore, dirtyCheckpointDetails, effectiveReadOnlyMetadataError, fitRedactedJobResult, formatReadOnlyWorkspaceDrift, formatRejectedExecution, formatSingleResultParts, formatWorktreeSummary, gitChangedFileSnapshot, gitControlSurfaceFingerprint, hardLockPathsForPlan, hardLockSummary, hardLockTtlForPlan, inspectSourceCheckpointState, jobAgentRuntime, jobInputShape, labelParallelRunId, makeQueueJobId, normalizeJobCwd, nowMs, parallelBatchCapacityError, parallelExecutionOverlapEvidence, parallelGroupDeadlineMs, parallelGroupScopeReport, parallelProviderKeys, readAgentDefinition, readOnlyEditsDeniedByAttestation, readOnlyHeadMove, readOnlyRoutingPolicyError, readOnlyWorkspaceDrift, refreshRuntimeConcurrency, releaseHardLock, runValidationGate, sanitizedAgentMetadataError, sanitizedDiscoveryContext, sanitizedRoutingPolicyError, server, settleIndependentParallelJobs, shouldUseWorktree, startHardLockHeartbeat, validateChangedFilesForPlan, validateParallelWritePlan, validationCommandPreflightError, verifyJobWorkspaceReadiness, verifyParallelLockResults, verifySanitizedWorkspace }) {
server.tool(
  "run_opencode_parallel",
  "Run multiple OpenCode agents in parallel. Use only for safe independent tasks. Each job's block is compact (Run id, outcome, timing, token usage, changed files, worktree, warnings, then the agent's report) and its result text is stored under the Run id: get_opencode_job returns it again if this response is lost.",
  {
    jobs: z.array(z.object(jobInputShape)).min(1),
    detail: z.boolean().optional().describe("Append each job's bridge detail (lock and scope echo, model evidence, phase timing split, tool outcomes) to its block. Default: compact blocks; get_opencode_job with detail: true returns the same detail later."),
  },
  async ({ jobs, detail = false }) => {
    jobs = await Promise.all(jobs.map((job) => normalizeJobCwd(job)));
    const toolStarted = nowMs();
    // Provider capacity is checked per provider key once every route is attested (below),
    // before any lock, worktree or agent; each key's leases are limited separately.
    const { error: writePlanError, errorType: writePlanErrorType, suggestedFix: writePlanSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
    if (writePlanError) {
      const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "multiple";
      const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: writePlanErrorType || "parallel_plan_rejected",
                reason: writePlanError,
                requestedAgent: requestedAgents,
                actualAgent: "none",
                lockMode,
                durationMs: nowMs() - toolStarted,
                conflictingPaths,
                serialOnlyMatches,
                suggestedFix: writePlanSuggestedFix || "Read-only jobs use lockMode off. Write jobs need non-overlapping lockedPaths and explicit allowedEdits.",
              }),
          },
        ],
      };
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const validationPreflight = await validationCommandPreflightError(lockPlans[index].validationCommand, {
        dryRun: Boolean(jobs[index].dryRun),
        sanitized: Boolean(jobs[index].sanitizedWorkspace),
      });
      if (validationPreflight) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel OpenCode execution rejected before any agent started.",
          errorType: validationPreflight.errorType,
          reason: `JOB ${index + 1} validation command cannot run: ${validationPreflight.error}`,
          requestedAgent: lockPlans[index].agent,
          actualAgent: "none",
          lockMode: lockPlans[index].lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: VALIDATION_PREFLIGHT_FIX,
        }) }] };
      }
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const gitState = await verifyJobWorkspaceReadiness(jobs[index], lockPlans[index]);
      if (!gitState.ok) {
        return {
          content: [{
            type: "text",
            text: formatRejectedExecution({
              headline: "Parallel protected execution rejected.",
              errorType: gitState.errorType,
              reason: gitState.error,
              requestedAgent: lockPlans[index].agent,
              actualAgent: "none",
              lockMode: lockPlans[index].lockMode,
              durationMs: nowMs() - toolStarted,
              ...dirtyCheckpointDetails(gitState),
              suggestedFix: gitState.suggestedFix,
            }),
          }],
        };
      }
    }

    const writeWithoutIsolation = jobs.find((job, index) => !job.dryRun && lockPlans[index].lockType === "write" && !shouldUseWorktree(job, lockPlans[index]));
    if (writeWithoutIsolation) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Parallel OpenCode execution rejected.",
        errorType: "parallel_write_requires_worktrees",
        reason: "Direct parallel writers require isolated worktrees so changes can be attributed, retained, reviewed, and integrated serially.",
        requestedAgent: writeWithoutIsolation.agent,
        actualAgent: "none",
        suggestedFix: "Enable CODEX_OPENCODE_WORKTREE_MODE=write or all, then retry. Queue/pipeline execution remains available for cancellation and durable status.",
      }) }] };
    }

    const parallelResolutions = [];
    const parallelAgentMetadata = [];
    const parallelSanitizedPreflight = [];
    const parallelSanitizedBefore = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const discoveryContext = sanitizedDiscoveryContext({ ...job, cwd: job.cwd || process.cwd() });
      const { forcePure, discoveryCwd } = discoveryContext;
      if (forcePure && !job.dryRun) {
        const verification = await verifySanitizedWorkspace(job.sanitizedWorkspace, "preflight_before_discovery");
        if (!verification.ok) {
          return { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Parallel sanitized-workspace preflight rejected before OpenCode discovery.",
            errorType: verification.errorType,
            reason: verification.error,
            requestedAgent: job.agent,
            actualAgent: "none",
            conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Rebuild the exact sanitized workspace from its trusted manifest before retrying the wave.",
          }) }] };
        }
        parallelSanitizedPreflight[index] = verification;
      }
      const resolution = await jobAgentRuntime().resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "reject",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT,
        lockPlan.orchestratorMode,
        discoveryContext
      );
      const routingError = resolution.error ? { errorType: "agent_routing_error", error: resolution.error } : readOnlyRoutingPolicyError(resolution, lockPlan);
      const metadata = resolution.error ? null : await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, discoveryCwd, { forcePure });
      const metadataError = resolution.error ? null : effectiveReadOnlyMetadataError(metadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
      const sanitizedMetadataError = resolution.error || !job.sanitizedWorkspace ? null : sanitizedAgentMetadataError(metadata, job.sanitizedWorkspace.root);
      const sanitizedError = sanitizedRoutingPolicyError(job, resolution, discoveryCwd);
      const preflightError = routingError || metadataError || sanitizedMetadataError || sanitizedError;
      if (preflightError) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel route preflight rejected before locks or filesystem side effects.",
          errorType: preflightError.errorType,
          reason: preflightError.error,
          requestedAgent: resolution.requestedAgent || job.agent,
          actualAgent: resolution.actualAgent || "none",
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: "Choose an installed primary/all role with an effective policy matching the requested read/write contract.",
        }) }] };
      }
      resolution.agentMetadata = metadata?.metadata || null;
      parallelResolutions[index] = resolution;
      parallelAgentMetadata[index] = metadata;
    }

    await refreshRuntimeConcurrency();
    const capacityError = parallelBatchCapacityError(jobs, parallelProviderKeys(parallelResolutions, parallelAgentMetadata, lockPlans));
    if (capacityError) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Parallel OpenCode execution rejected.",
        errorType: capacityError.errorType,
        reason: capacityError.error,
        requestedAgent: lockPlans.map((plan) => plan.agent).filter(Boolean).join(", ") || "multiple",
        actualAgent: "none",
        lockMode: lockPlans.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown",
        durationMs: nowMs() - toolStarted,
        suggestedFix: capacityError.suggestedFix,
      }) }] };
    }

    const acquiredLocks = [];
    const acquiredLockHeartbeats = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const shouldAcquireLock = !job.dryRun;

      if (!shouldAcquireLock) {
        acquiredLocks[index] = null;
        continue;
      }

      const requestedLockPaths = hardLockPathsForPlan(lockPlan);
      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: lockPlan.agent,
        task: lockPlan.task,
        cwd: job.cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: requestedLockPaths,
        repositoryScope: requestedLockPaths.length === 1 && requestedLockPaths[0] === REPOSITORY_SCOPE_LOCK_PATH,
        ttlMs: hardLockTtlForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        return {
          content: [
            {
              type: "text",
              text: [
                formatRejectedExecution({
                  headline: "Parallel OpenCode execution rejected.",
                  errorType: lockPlan.lockType === "read" ? "read_lock_conflict" : "write_lock_conflict",
                  reason: lockResult.error,
                  requestedAgent: lockPlan.agent,
                  actualAgent: "none",
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: "Release the existing lock or wait for it to expire, then retry with non-overlapping lockedPaths.",
                }),
                "",
                "No OpenCode jobs were started after this write-lock rejection.",
              ].join("\n"),
            },
          ],
        };
      }

      acquiredLocks[index] = lockResult.lock;
      acquiredLockHeartbeats[index] = startHardLockHeartbeat(lockResult.lock, hardLockTtlForPlan(lockPlan));
    }

    for (let index = 0; index < jobs.length; index += 1) {
      if (!shouldUseWorktree(jobs[index], lockPlans[index])) continue;
      const checkpoint = await inspectSourceCheckpointState(jobs[index].cwd || process.cwd(), {
        lockedPaths: lockPlans[index].lockedPaths,
        allowedEdits: lockPlans[index].allowedEdits,
        scopeContract: lockPlans[index].scopeContract,
      });
      if (!checkpoint.ok) {
        const dirtyDetails = dirtyCheckpointDetails(checkpoint);
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel writer checkpoint preflight rejected before any worktree was created.",
          errorType: checkpoint.errorType,
          reason: checkpoint.error,
          requestedAgent: lockPlans[index].agent,
          actualAgent: parallelResolutions[index]?.actualAgent || "none",
          lockMode: lockPlans[index].lockMode,
          conflictingPaths: dirtyDetails.conflictingPaths,
          dirtyFiles: dirtyDetails.dirtyFiles,
          overlappingFiles: dirtyDetails.overlappingFiles,
          disjointFiles: dirtyDetails.disjointFiles,
          suggestedFix: "Create or select an external checkpoint for the complete source checkout; the bridge will not stash, reset, or commit it.",
        }) }] };
      }
    }

    const parallelWorktrees = [];
    // Each job gets a run id up front (writers already used one for their worktree name), so the
    // coordinator's ledger can name reviewer runs too. It is not a queue id: get_opencode_job finds
    // it in the direct-run audit (kind "parallel"); the queue still owns durable cancellation.
    const parallelRunIds = lockPlans.map((plan) => makeQueueJobId(plan.agent));
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      if (!shouldUseWorktree(job, lockPlan)) {
        parallelWorktrees[index] = null;
        continue;
      }

      const worktreeResult = await createWorktreeForJob({
        cwd: job.cwd || process.cwd(),
        agent: lockPlan.agent,
        jobId: parallelRunIds[index],
        lockedPaths: lockPlan.lockedPaths,
        allowedEdits: lockPlan.allowedEdits,
        scopeContract: lockPlan.scopeContract,
      });

      if (!worktreeResult.ok) {
        const dirtyDetails = dirtyCheckpointDetails(worktreeResult);
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        await Promise.all(parallelWorktrees.filter(Boolean).map((worktree) => cleanupWorktree(worktree, "always", true)));
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: worktreeResult.errorType || "worktree_create_failed",
                reason: worktreeResult.error || "Could not create a Git worktree for this parallel job.",
                requestedAgent: lockPlan.agent,
                actualAgent: "none",
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
        };
      }

      parallelWorktrees[index] = worktreeResult;
    }

    const executionCwdForIndex = (index) => parallelWorktrees[index]?.path || jobs[index].cwd || process.cwd();
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const resolution = parallelResolutions[index];
      const executionCwd = executionCwdForIndex(index);
      const { forcePure } = sanitizedDiscoveryContext({ ...job, cwd: job.cwd || process.cwd() });
      const finalMetadata = await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, executionCwd, { forcePure });
      const metadataError = effectiveReadOnlyMetadataError(
        finalMetadata,
        lockPlan,
        agentMetadataPolicyOptions(resolution, lockPlan, parallelAgentMetadata[index]?.metadata || null)
      );
      const sanitizedMetadataError = job.sanitizedWorkspace ? sanitizedAgentMetadataError(finalMetadata, job.sanitizedWorkspace.root) : null;
      const sanitizedRoutingError = sanitizedRoutingPolicyError(job, resolution, executionCwd);
      if (metadataError || sanitizedMetadataError || sanitizedRoutingError) {
        const policyError = metadataError || sanitizedMetadataError || sanitizedRoutingError;
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        return { content: [{ type: "text", text: [
          formatRejectedExecution({
            headline: "Parallel final pre-spawn agent policy rejected.",
            errorType: policyError.errorType,
            reason: policyError.error,
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            suggestedFix: "Inspect any retained worktree and restore the exact bridge-managed effective agent definition before retrying.",
          }),
          ...parallelWorktrees.filter(Boolean).map((item) => `Retained worktree: ${item.path} (base ${item.baseCommit})`),
        ].join("\n") }] };
      }
      parallelAgentMetadata[index] = finalMetadata;
      resolution.agentMetadata = finalMetadata.metadata;
    }
    const cwdKeys = [...new Set(jobs.map((_, index) => path.resolve(executionCwdForIndex(index))))];
    const parallelSnapshottedCwds = new Set();
    const parallelBefore = new Map();
    const parallelHeadBefore = new Map();
    // A checkout used only by readers whose attested policy denies edits changes only through
    // another client, so its group check reports that drift instead of rejecting the batch.
    const parallelDriftToleratedCwds = new Set(cwdKeys.filter((cwdKey) => {
      const indexes = jobs.map((_, index) => index).filter((index) => path.resolve(executionCwdForIndex(index)) === cwdKey && !jobs[index].dryRun);
      return indexes.length > 0 && indexes.every((index) => !jobs[index].sanitizedWorkspace && readOnlyEditsDeniedByAttestation(lockPlans[index], parallelAgentMetadata[index]));
    }));
    const parallelRemovedWorktrees = new Set();
    try {
      for (const cwdKey of cwdKeys) {
        const needsGitSnapshot = jobs.some((job, index) => path.resolve(executionCwdForIndex(index)) === cwdKey && !job.dryRun && !job.sanitizedWorkspace);
        if (needsGitSnapshot) parallelSnapshottedCwds.add(cwdKey);
        parallelBefore.set(cwdKey, needsGitSnapshot ? await gitChangedFileSnapshot(cwdKey, parallelDriftToleratedCwds.has(cwdKey) ? { includeIgnored: false } : {}) : new Map());
        parallelHeadBefore.set(cwdKey, needsGitSnapshot ? await captureGitHead(cwdKey) : "");
      }
    } catch (error) {
      acquiredLockHeartbeats.forEach((stop) => stop?.());
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
      return { content: [{ type: "text", text: [
        formatRejectedExecution({
          headline: "Parallel snapshot preflight failed closed.",
          errorType: error?.errorType || "snapshot_safety_limit_exceeded",
          reason: redactSensitiveText(error?.message || String(error)),
          requestedAgent: jobs.map((job) => job.agent).join(", "),
          actualAgent: parallelResolutions.map((item) => item.actualAgent).join(", "),
          suggestedFix: "Reduce the workspace/snapshot scope or raise reviewed bounded limits; all created writer worktrees were retained.",
        }),
        ...parallelWorktrees.filter(Boolean).map((worktree) => `Retained worktree: ${worktree.path} (base ${worktree.baseCommit})`),
      ].join("\n") }] };
    }

    let results;
    const parallelRollbackReports = [];
    const groupController = new AbortController();
    for (const heartbeat of acquiredLockHeartbeats.filter(Boolean)) {
      const abortGroupForLostLock = () => {
        if (!groupController.signal.aborted) groupController.abort(heartbeat.signal.reason);
      };
      if (heartbeat.signal?.aborted) abortGroupForLostLock();
      else heartbeat.signal?.addEventListener("abort", abortGroupForLostLock, { once: true });
    }
    // Locks, worktrees and discovery attestation for all jobs happened before this point. The audit
    // start records are written before the group deadline is armed (they fail open, never throw).
    const parallelSharedSetupMs = Math.round(nowMs() - toolStarted);
    const parallelAudit = directRunAuditStore();
    const parallelAuditHandles = await Promise.all(jobs.map((job, index) => parallelAudit.start(
      { agent: lockPlans[index].agent, cwd: job.cwd || process.cwd(), dryRun: Boolean(job.dryRun) },
      { runId: parallelRunIds[index], kind: "parallel", jobId: parallelRunIds[index] }
    )));
    const parallelChildSpawned = jobs.map(() => false);
    const groupDeadlineMs = parallelGroupDeadlineMs(lockPlans);
    let groupDeadlineExpired = false;
    const groupDeadlineTimer = setTimeout(() => {
      groupDeadlineExpired = true;
      groupController.abort("parallel_group_deadline");
    }, groupDeadlineMs);
    try {
      const executionPromises = jobs.map(async (job, index) => {
        const lockPlan = lockPlans[index];
        const jobStartedAtMs = nowMs();
        const phaseClock = createPhaseClock();
        const resolution = parallelResolutions[index];
        if (resolution.error) {
          return {
            index,
            lockPlan,
            result: { changedFiles: [], exitCode: "not run", errorType: "agent_routing_error", openCodeFallbackDetected: false },
            text: [
            `JOB ${index + 1}`,
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
            `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
            `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
            `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
            `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
            resolution.error,
            ].join("\n"),
          };
        }

        const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
        if (routingPolicyError) {
          return {
            index,
            lockPlan,
            result: {
              changedFiles: [],
              exitCode: "not run",
              errorType: routingPolicyError.errorType,
              openCodeFallbackDetected: false,
            },
            text: [
              `JOB ${index + 1}`,
              formatRejectedExecution({
                headline: "OpenCode agent routing rejected.",
                errorType: routingPolicyError.errorType,
                reason: routingPolicyError.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: routingPolicyError.suggestedFix,
              }),
            ].join("\n"),
          };
        }

        const executionCwd = executionCwdForIndex(index);
        const manifestProtected = Boolean(job.sanitizedWorkspace);
        if (manifestProtected && !job.dryRun) {
          const verification = await verifySanitizedWorkspace(job.sanitizedWorkspace, "before_wave");
          parallelSanitizedBefore[index] = verification;
          if (!verification.ok) {
            return {
              index,
              lockPlan,
              result: {
                changedFiles: normalizeLockPathList((verification.discrepancies || []).map((item) => item.path)),
                exitCode: "not_run",
                errorType: verification.errorType,
                sanitizedWorkspaceVerification: {
                  preflight: parallelSanitizedPreflight[index] || null,
                  before: verification,
                  after: null,
                },
              },
              startedAtMs: jobStartedAtMs,
              finishedAtMs: nowMs(),
              // The JOB label is what the report keys the Run id on.
              text: [
                `JOB ${index + 1}`,
                formatRejectedExecution({
                  headline: "Sanitized workspace changed between preflight and the parallel wave.",
                  errorType: verification.errorType,
                  reason: verification.error,
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
                  suggestedFix: "Retain the workspace for investigation and rebuild it from the trusted manifest.",
                }),
              ].join("\n"),
            };
          }
        }
        const readerEditsDenied = !job.dryRun && !manifestProtected && readOnlyEditsDeniedByAttestation(lockPlan, parallelAgentMetadata[index]);
        const readerSnapshotOptions = readerEditsDenied ? { includeIgnored: false } : {};
        const beforeFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
        const gitControlBefore = job.dryRun || manifestProtected || lockPlan.lockType === "read" ? null : await gitControlSurfaceFingerprint(executionCwd);
        const scopeFilesystemBefore = job.dryRun || manifestProtected || lockPlan.lockType !== "write"
          ? null
          : await captureWritableScopeFilesystemState(executionCwd, lockPlan);
        if (scopeFilesystemBefore && !scopeFilesystemBefore.ok) {
          // No agent ran, so the worktree is empty: keeping it only filled the retained-worktree cap.
          if (parallelWorktrees[index]) {
            await cleanupWorktree(parallelWorktrees[index], "always", true).catch(() => null);
            parallelWorktrees[index] = null;
          }
          return {
            index,
            lockPlan,
            result: { changedFiles: [], exitCode: "not_run", errorType: scopeFilesystemBefore.errorType },
            startedAtMs: jobStartedAtMs,
            finishedAtMs: nowMs(),
            text: [
              `JOB ${index + 1}`,
              formatRejectedExecution({
                headline: "The writable scope could not be recorded before execution.",
                errorType: scopeFilesystemBefore.errorType,
                reason: scopeFilesystemBefore.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Narrow allowedEdits to the files the job needs, or fix the permissions of the scope, and retry. No agent was started.",
              }),
            ].join("\n"),
          };
        }
        const delegation = {
          scope: job.delegation?.scope,
          lockMode: lockPlan.lockMode,
          lockType: lockPlan.lockType,
          orchestratorMode: lockPlan.orchestratorMode,
          userAuthorizedOrchestrator: lockPlan.userAuthorizedOrchestrator,
          lockedPaths: lockPlan.lockedPaths,
          allowedEdits: lockPlan.allowedEdits,
          forbiddenEdits: lockPlan.forbiddenEdits,
          sharedFiles: lockPlan.sharedFiles,
          scopeContract: lockPlan.scopeContract,
          permissions: job.delegation?.permissions || (lockPlan.lockType === "write" ? "write allowed only inside Lock granted; bash ask" : "read-only; no edits; bash ask"),
          validationCommand: lockPlan.validationCommand,
          returnFormat: job.delegation?.returnFormat,
          pathSpellings: callerPathSpellings(job),
        };

        let prompt = buildCompactPrompt(resolution.requestedAgent, job.task, delegation);
        if (resolution.proxyUsed) {
          prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
        }
        phaseClock.mark("preAgentSnapshot");
        const result = await jobAgentRuntime().runOpenCodeWithPolicy(
          resolution.actualAgent,
          prompt,
          executionCwd,
          job.dryRun || false,
          lockPlan,
          lockPlan.timeoutMs,
          {
            signal: groupController.signal,
            agentMetadata: parallelAgentMetadata[index],
            onSpawn: () => {
              parallelChildSpawned[index] = true;
              return { ok: true };
            },
          }
        );
        phaseClock.mark("openCodeRun");
        const afterFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
        const afterFilesForValidation = job.dryRun || manifestProtected || readerEditsDenied
          ? afterFiles
          : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
        const executionHeadAfterAgent = job.dryRun || manifestProtected ? "" : await captureGitHead(executionCwd);
        const sanitizedAfter = manifestProtected && !job.dryRun
          ? await verifySanitizedWorkspace(job.sanitizedWorkspace, "after_wave")
          : null;
        result.changedFiles = sanitizedAfter && !sanitizedAfter.ok
          ? normalizeLockPathList((sanitizedAfter.discrepancies || []).map((item) => item.path))
          : changedFilesBetween(beforeFiles, afterFiles);
        const expectedExecutionHead = parallelHeadBefore.get(path.resolve(executionCwd)) || "";
        if (readerEditsDenied && result.changedFiles.length) {
          result.readOnlyWorkspaceDrift = readOnlyWorkspaceDrift(result.changedFiles, afterFiles, Boolean(executionHeadAfterAgent && executionHeadAfterAgent !== expectedExecutionHead));
          result.changedFiles = [];
        }
        if (gitControlBefore) applyGitControlSurfaceCheck(result, gitControlBefore, await gitControlSurfaceFingerprint(executionCwd));
        if (executionHeadAfterAgent && executionHeadAfterAgent !== expectedExecutionHead) {
          const move = result.changedFiles.length || result.errorType ? null : await readOnlyHeadMove(lockPlan, executionCwd, expectedExecutionHead, executionHeadAfterAgent);
          if (move) {
            result.readOnlyHeadMove = move;
          } else {
            result.errorType ||= "repository_head_changed_during_execution";
            result.stderr = [result.stderr, "Repository HEAD changed during parallel execution. The change is unattributed and the worktree/output was retained."].filter(Boolean).join("\n");
          }
        }
        result.executionHeadBefore = expectedExecutionHead;
        result.executionHeadAfter = executionHeadAfterAgent;
        if (sanitizedAfter && !sanitizedAfter.ok && !result.errorType) result.errorType = sanitizedAfter.errorType;
        result.sanitizedWorkspaceVerification = manifestProtected
          ? { preflight: parallelSanitizedPreflight[index] || null, before: parallelSanitizedBefore[index] || null, after: sanitizedAfter }
          : null;
        let unsafeFiles = lockPlan.lockType === "write" ? unsafeChangedFiles(result.changedFiles, lockPlan.allowedEdits, executionCwd) : result.changedFiles;
        const postExecutionPathError = job.dryRun ? "" : unsafePathReason(
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
          unsafeFiles = normalizeLockPathList(unsafeFiles.concat(result.changedFiles));
          result.errorType ||= "unsafe_path_after_execution";
          result.stderr = [result.stderr, postExecutionPathError].filter(Boolean).join("\n");
        }
        const scopeFilesystemViolation = scopeFilesystemBefore
          ? writableScopeFilesystemViolation(scopeFilesystemBefore, await captureWritableScopeFilesystemState(executionCwd, lockPlan))
          : null;
        if (scopeFilesystemViolation) {
          unsafeFiles = normalizeLockPathList(unsafeFiles.concat(scopeFilesystemViolation.paths));
          result.unsafeFilesystemPaths = scopeFilesystemViolation.paths;
          result.errorType ||= scopeFilesystemViolation.errorType;
          result.stderr = [result.stderr, scopeFilesystemViolation.error].filter(Boolean).join("\n");
        }
        const validationGate = !unsafeFiles.length && !result.errorType
          ? await runValidationGate({ command: lockPlan.validationCommand, cwd: executionCwd, dryRun: job.dryRun || false, timeoutMs: CONFIG.validationCommandTimeoutMs, signal: groupController.signal })
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
        const afterValidationFiles = job.dryRun || manifestProtected ? afterFiles : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
        const executionHeadAfterValidation = job.dryRun || manifestProtected ? executionHeadAfterAgent : await captureGitHead(executionCwd);
        const validationMutationFiles = job.dryRun || manifestProtected ? [] : changedFilesBetween(afterFilesForValidation, afterValidationFiles);
        if (executionHeadAfterValidation && executionHeadAfterValidation !== expectedExecutionHead) {
          const move = result.errorType || validationMutationFiles.length || result.changedFiles.length
            ? null
            : await readOnlyHeadMove(lockPlan, executionCwd, expectedExecutionHead, executionHeadAfterValidation);
          if (move) result.readOnlyHeadMove = move;
          else result.errorType ||= "repository_head_changed_during_execution";
          result.executionHeadAfter = executionHeadAfterValidation;
        }
        if (validationMutationFiles.length) {
          result.changedFiles = normalizeLockPathList(result.changedFiles.concat(validationMutationFiles));
          const postValidation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: true });
          unsafeFiles = normalizeLockPathList(postValidation.disallowedFiles.concat(validationMutationFiles, result.unsafeFilesystemPaths || []));
          result.validationMutationFiles = validationMutationFiles;
          result.errorType ||= "validation_mutated_workspace";
          result.stderr = [result.stderr, `Validation changed workspace paths after agent execution: ${validationMutationFiles.join(", ")}. The changes were retained as unattributed external state.`].filter(Boolean).join("\n");
        }
        const worktree = parallelWorktrees[index];
        const worktreeDiff = worktree ? await collectWorktreeDiff(worktree) : null;
        if (worktreeDiff?.errorType && !result.errorType) {
          result.errorType = worktreeDiff.errorType;
          result.stderr = [result.stderr, worktreeDiff.error].filter(Boolean).join("\n");
        }
        if (worktree && !worktreeDiff?.errorType) {
          const representablePaths = changedPathSetEvidence(result.changedFiles, worktreeDiff?.changedFiles || []);
          const unrepresentableFiles = normalizeLockPathList(representablePaths.missingFiles.concat(representablePaths.unexpectedFiles));
          if (unrepresentableFiles.length) {
            result.changedFiles = normalizeLockPathList(result.changedFiles.concat(worktreeDiff?.changedFiles || []));
            const representableValidation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: true });
            unsafeFiles = normalizeLockPathList(unsafeFiles.concat(representableValidation.disallowedFiles, unrepresentableFiles));
            result.errorType ||= "worktree_output_unrepresentable";
            result.unrepresentableFiles = unrepresentableFiles;
            result.stderr = [result.stderr, `Execution output and the integratable Git patch differ at: ${unrepresentableFiles.join(", ")}. The worktree was retained and cannot be reported as successful.`].filter(Boolean).join("\n");
          }
        }
        // Same rule as a single job: a writer whose verified diff is empty has nothing to
        // review, so its worktree is removed instead of filling the retained-worktree cap.
        const producedNothing = Boolean(worktree && worktreeDiff)
          && !worktreeDiff.errorType
          && !(worktreeDiff.changedFiles || []).length
          && !(result.changedFiles || []).length
          && !(result.unrepresentableFiles || []).length
          && !unsafeFiles.length;
        const worktreeCleanup = producedNothing
          ? { ...(await cleanupWorktree(worktree, "always", true)), errorType: undefined, reason: "the job changed no files, so there was nothing to retain" }
          : null;
        const worktreeRemoved = producedNothing && ["success", "partial"].includes(worktreeCleanup.cleanup);
        if (worktreeRemoved) parallelRemovedWorktrees.add(path.resolve(worktree.path));
        if (producedNothing) result.noChanges = true;
        phaseClock.mark("postAgentChecks");
        result.phaseTimings = { ...phaseClock.summary(result), sharedSetupMs: parallelSharedSetupMs };
        if (worktree) {
          result.worktree = {
            path: worktreeRemoved ? "" : worktree.path,
            branch: worktreeRemoved ? "" : worktree.branch,
            baseCommit: worktree.baseCommit,
            baseTree: worktree.baseTree,
            patchSha256: worktreeDiff?.patchSha256 || "",
            sourceStateSha256: worktreeDiff?.sourceStateSha256 || "",
            cleanup: worktreeCleanup?.cleanup || "retained_for_review",
            removed: worktreeRemoved,
            removedPath: worktreeRemoved ? worktree.path : "",
            changedFiles: worktreeDiff?.changedFiles || [],
            diffStat: worktreeDiff?.diffStat || "",
          };
        }
        // L-025: the block is compact: everything a caller decides on comes before the report,
        // and the long bridge preamble is `detailText` (stored with the run, shown on request).
        const singleParts = formatSingleResultParts({ resolution, result, cwd: executionCwd, lockPlan });
        const head = [
          `JOB ${index + 1}`,
          ...compactJobLines({ resolution, result, unsafeFiles }),
          formatReadOnlyWorkspaceDrift(result.readOnlyWorkspaceDrift),
          worktree ? formatWorktreeSummary(worktree, worktreeCleanup) : null,
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : null,
          validationGate.status === "skipped" ? null : formatValidationGateResult(validationGate),
          `Unsafe changed files: ${unsafeFiles.length ? compactFileList(unsafeFiles) : "none detected"}`,
        ].filter(Boolean).join("\n");
        const tail = String(result.stderr || "").trim() ? singleParts.stderr.replace(/^\n/, "") : "";
        return {
          index,
          lockPlan,
          result,
          unsafeFiles,
          worktreeCleanup,
          startedAtMs: jobStartedAtMs,
          finishedAtMs: nowMs(),
          parts: { head, report: singleParts.report, tail },
          text: [head, singleParts.report, tail].filter(Boolean).join("\n"),
          detailText: [`Temporary lock acquired: ${hardLockSummary(acquiredLocks[index])}`, singleParts.preamble.trimEnd()].join("\n"),
        };
        });
      const settled = await settleIndependentParallelJobs(executionPromises);
      results = settled.map((entry, index) => entry.status === "fulfilled" ? entry.value : ({
        index,
        lockPlan: lockPlans[index],
        result: {
          changedFiles: [],
          exitCode: "infrastructure_failure",
          errorType: "parallel_job_infrastructure_failure",
          stderr: redactSensitiveText(entry.reason?.message || String(entry.reason)),
        },
        startedAtMs: 0,
        finishedAtMs: nowMs(),
        text: `JOB ${index + 1}\n${formatRejectedExecution({
          headline: "Parallel job failed at the bridge infrastructure layer.",
          errorType: "parallel_job_infrastructure_failure",
          reason: redactSensitiveText(entry.reason?.message || String(entry.reason)),
          requestedAgent: jobs[index].agent,
          actualAgent: parallelResolutions[index]?.actualAgent || "none",
          lockMode: lockPlans[index].lockMode,
          suggestedFix: "Inspect the retained sibling worktrees and retry through the queue/pipeline if cancellation or durable status is required.",
        })}`,
      }));
      // Every block names its Run id (rejection blocks too: the JOB label is what the report keys
      // it on) before the text is stored under that id.
      results.forEach((entry, position) => {
        const runId = parallelRunIds[Number.isInteger(entry.index) ? entry.index : position];
        if (!runId) return;
        entry.text = labelParallelRunId(entry.text, runId);
        if (entry.parts) entry.parts = { ...entry.parts, head: labelParallelRunId(entry.parts.head, runId) };
      });
      const parallelAudits = await Promise.all(results.map((entry, position) => {
        const index = Number.isInteger(entry.index) ? entry.index : position;
        // L-025: the result is stored under the Run id, report-first when it must be shortened.
        const fitted = entry.parts ? fitRedactedJobResult(entry.parts) : null;
        return parallelAudit.finish(parallelAuditHandles[index], {
          execution: { result: entry.result || {} },
          childStarted: parallelChildSpawned[index],
          errorType: entry.result?.errorType || (entry.unsafeFiles?.length ? "changed_file_validation_error" : ""),
          stored: fitted
            ? { text: fitted.text, detailText: entry.detailText || "", chars: fitted.chars, reportTruncated: fitted.reportTruncated }
            : { text: entry.text, detailText: entry.detailText || "" },
        });
      }));
      results.forEach((entry, position) => {
        entry.auditNotice = parallelAudit.notice(parallelAudits[position]);
      });
      for (const cwdKey of cwdKeys) {
        if (!parallelSnapshottedCwds.has(cwdKey)) continue;
        // A writer worktree that produced nothing was removed; there is no group state left there.
        if (parallelRemovedWorktrees.has(cwdKey)) continue;
        const indexesForCwd = lockPlans.map((_, index) => index).filter((index) => path.resolve(executionCwdForIndex(index)) === cwdKey);
        // A snapshot or git failure here (limit exceeded, git error) fails this workspace's
        // check closed; it must not discard every job result and Run id with it.
        try {
          parallelRollbackReports.push(await parallelGroupScopeReport({
            cwdKey,
            lockPlans,
            indexesForCwd,
            results,
            before: parallelBefore.get(cwdKey) || new Map(),
            expectedHead: parallelHeadBefore.get(cwdKey) || "",
            driftTolerated: parallelDriftToleratedCwds.has(cwdKey),
          }));
        } catch (error) {
          const errorType = error?.errorType || "parallel_group_snapshot_failed";
          const reason = redactSensitiveText(error?.message || String(error));
          for (const index of indexesForCwd) {
            const jobResult = results[index];
            if (!jobResult?.result) continue;
            jobResult.result.errorType ||= errorType;
            jobResult.result.stderr = [jobResult.result.stderr, `Group-scope check of ${cwdKey} failed closed: ${reason}`].filter(Boolean).join("\n");
          }
          parallelRollbackReports.push({
            cwd: cwdKey,
            headChanged: false,
            expectedHead: parallelHeadBefore.get(cwdKey) || "",
            actualHead: "unknown",
            changedFiles: [],
            disallowedFiles: [],
            serialOnlyMatches: [],
            externalDriftFiles: [],
            checkFailed: true,
            errorType,
            error: reason,
            rollback: "not_attempted_check_failed",
            rollbackFiles: [],
            unresolvedFiles: [],
          });
        }
      }
    } finally {
      clearTimeout(groupDeadlineTimer);
      acquiredLockHeartbeats.forEach((stop) => stop?.());
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
    }

    const lockViolations = verifyParallelLockResults(results);
    const parallelSuccess = !lockViolations.length
      && !parallelRollbackReports.some((report) => report.disallowedFiles.length || report.checkFailed)
      && !results.some((jobResult) => jobResult.result?.errorType);
    const executionOverlap = parallelExecutionOverlapEvidence(results);
    const ranConcurrently = executionOverlap.ranConcurrently;
    const groupStatus = parallelSuccess
      ? "completed"
      : results.some((item) => !item.result?.errorType) ? "partial_failed" : groupDeadlineExpired ? "cancelled_or_timed_out" : "failed";
    const parallelWorktreeCleanupReports = parallelWorktrees
      .map((worktree, index) => ({ worktree, index }))
      .filter(({ worktree }) => Boolean(worktree))
      .map(({ worktree, index }) => {
        const cleanup = results[index]?.worktreeCleanup || null;
        return cleanup
          ? {
              index,
              path: worktree.path,
              branch: worktree.branch,
              cleanup: cleanup.cleanup,
              reason: cleanup.reason || "",
              error: cleanup.error || "",
            }
          : {
              index,
              path: worktree.path,
              branch: worktree.branch,
              cleanup: "retained_for_review",
              reason: parallelSuccess
                ? "successful output awaits reviewed serial integration"
                : "partial or failed batch output is retained for diagnosis and recovery",
            };
      });
    const retainedWorktreeCount = parallelWorktreeCleanupReports.filter((report) => report.cleanup === "retained_for_review" || report.cleanup === "failed").length;
    const verification = [
      "Parallel lock verification:",
      lockViolations.length
        ? "Rejected. Do not accept these parallel results; move to serial integration/recovery."
        : "Accepted. All detected changed files stayed inside assigned locks.",
      lockViolations.length ? lockViolations.map((violation) => `- ${violation}`).join("\n") : "- No lock violations detected.",
    ].join("\n");
    const rollbackVerification = [
      "Parallel rollback verification:",
      parallelRollbackReports.some((report) => report.checkFailed)
        ? "Rejected. A group-scope check could not complete; the affected jobs failed closed and their output was retained."
        : parallelRollbackReports.some((report) => report.disallowedFiles.length)
        // The bridge never rolls back parallel output: path-only evidence cannot attribute it.
        ? "Rejected. Disallowed changed files were detected; no rollback was attempted and the changes and worktrees were retained for inspection."
        : "Accepted. No disallowed changed files detected at group scope.",
      ...parallelRollbackReports.map((report) =>
        [
          `Workspace: ${report.cwd}`,
          report.checkFailed ? `Group check failed: ${report.errorType}: ${report.error}` : null,
          `Changed files: ${report.changedFiles.length ? report.changedFiles.join(", ") : "none detected"}`,
          report.externalDriftFiles?.length ? `External changes (another client; the attested readers cannot edit): ${report.externalDriftFiles.join(", ")}` : null,
          `HEAD changed: ${report.headChanged ? `yes (${report.expectedHead} -> ${report.actualHead})` : "no"}`,
          `Disallowed files: ${report.disallowedFiles.length ? report.disallowedFiles.join(", ") : "none detected"}`,
          `Serial-only matches: ${report.serialOnlyMatches.length ? report.serialOnlyMatches.join(", ") : "none detected"}`,
          `Rollback: ${report.rollback}`,
          `Rollback files: ${report.rollbackFiles.length ? report.rollbackFiles.join(", ") : "none"}`,
          `Unresolved files: ${report.unresolvedFiles.length ? report.unresolvedFiles.join(", ") : "none"}`,
        ].filter(Boolean).join("\n")
      ),
    ].join("\n");
    const worktreeCleanupVerification = [
      "Parallel worktree cleanup:",
      !parallelWorktreeCleanupReports.length
        ? "No worktrees used."
        : retainedWorktreeCount === parallelWorktreeCleanupReports.length
        ? "All writer worktrees were retained for review."
        : `${retainedWorktreeCount} of ${parallelWorktreeCleanupReports.length} writer worktrees were retained; writers that changed nothing had their empty worktree removed.`,
      ...parallelWorktreeCleanupReports.map((report) =>
        [
          `JOB ${report.index + 1}`,
          `Path: ${report.path}`,
          `Branch: ${report.branch}`,
          `Cleanup: ${report.cleanup}`,
          report.reason ? `Reason: ${report.reason}` : null,
          report.error ? `Error: ${report.error}` : null,
        ].filter(Boolean).join("\n")
      ),
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: [
            `Parallel group status: ${groupStatus}`,
            `Group deadline ms: ${groupDeadlineMs} (longest agent budget plus validation timeout, plus margin)${groupDeadlineExpired ? "; the deadline expired and aborted the remaining work" : ""}`,
            `Ran concurrently (OpenCode child interval overlap): ${ranConcurrently ? "yes" : "no"}`,
            `Concurrent execution pairs: ${executionOverlap.pairs.length ? executionOverlap.pairs.map(([left, right]) => `JOB ${left + 1} + JOB ${right + 1}`).join(", ") : "none"}`,
            "Cancellation: this synchronous tool has no durable operation id; use queue/pipeline tools when cancellation or restart-safe status is required.",
            verification,
            rollbackVerification,
            worktreeCleanupVerification,
            ...results.map((entry) => [
              entry.text,
              detail && entry.detailText ? `Bridge detail (get_opencode_job with detail: true returns it later):\n${entry.detailText}` : null,
              entry.auditNotice,
            ].filter(Boolean).join("\n")),
          ].join("\n\n====================\n\n"),
        },
      ],
    };
  }
);
}
