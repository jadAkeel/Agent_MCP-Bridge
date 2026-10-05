// Parallel plans: pipeline plans, lock-result verification and parallel group deadlines and scope reports.
// Extracted from server.js in modularization round M-001.

import { randomBytes } from "node:crypto";
import { isWithinAnyPath, normalizeLockPathList, normalizePathForCompare, unsafeChangedFiles } from "./paths.js";
import { sanitizePersistedValue } from "./redaction.js";
import { applyProjectPolicyToJobs, findSerialOnlyMatches } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createParallelPlanRuntime({ BRIDGE_INSTANCE_ID, CONFIG, captureGitHead, changedFilesBetween, gitChangedFileSnapshot, isManagedReadOnlyAgent, makePipelineId, readOnlyHeadMove, readOnlyWorkspaceDrift, scopeChangedFileViolations, timeoutForAgent, validateDelegationPlanInputs }) {
function createPipelinePlan({
  name = "multi-agent-pipeline",
  cwd = "",
  jobs = [],
  requiresWorktrees = true,
  finalValidationCommand = "",
  reviewerJob = null,
  testerJob = null,
  policy = null,
  policyPath = "",
  policySha256 = "",
  policyTrustedForAuthority = false,
  sanitizedWorkspace = null,
  sanitizedPreflight = null,
}) {
  // Q-018: continuations are standalone sequential jobs, never pipeline children or gates.
  if ([...jobs, reviewerJob, testerJob].some((job) => job && job.continueWorktree !== undefined)) {
    return { ok: false, errorType: "continue_worktree_unsupported_in_parallel",
      error: "Pipelines cannot continue a retained worktree.",
      suggestedFix: "Run related steps as standalone sequential jobs with continueWorktree, then integrate once." };
  }
  const policyAdjustedJobs = applyProjectPolicyToJobs(
    jobs.map((job) => sanitizedWorkspace ? { ...job, sanitizedWorkspace: job.sanitizedWorkspace || sanitizedWorkspace, subagentStrategy: job.subagentStrategy || "reject" } : job),
    policy,
    { allowOwnershipInference: policyTrustedForAuthority }
  );
  const effectiveRequiresWorktrees = Boolean(requiresWorktrees || policy?.requiresWorktrees);
  const explicitFinalValidationCommand = String(finalValidationCommand || "").trim();
  const effectiveFinalValidationCommand = explicitFinalValidationCommand || String(policy?.finalValidationCommand || "").trim();
  const effectiveFinalValidationSpec = explicitFinalValidationCommand ? null : policy?.finalValidationSpec || null;
  const effectiveFinalValidationSource = explicitFinalValidationCommand ? "caller" : policy?.finalValidationCommand ? "policy" : "none";
  for (const [gateName, gateJob] of [["reviewer", reviewerJob], ["tester", testerJob]]) {
    if (gateJob && !isManagedReadOnlyAgent(gateJob.agent)) {
      return {
        ok: false,
        errorType: "pipeline_gate_agent_not_read_only",
        error: `Pipeline ${gateName} gate requires a managed read-only agent; received "${gateJob.agent}".`,
        suggestedFix: "Use reviewer, tester, architect, planner, or orchestrator for read-only pipeline gates.",
      };
    }
  }
  if (policyAdjustedJobs.length < 2) {
    return {
      ok: false,
      errorType: "pipeline_too_small",
      error: "Pipelines are advanced-only and require at least two jobs or ownership zones. Use validate_delegation_plan and run_opencode_agent for a single bounded task.",
      suggestedFix: "For a small single write, use Level 2: validate_delegation_plan then run_opencode_agent with one explicit Scope Contract.",
      lockPlans: [],
      executionMode: "single",
    };
  }
  const { error, errorType, suggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [], executionMode } = validateDelegationPlanInputs(policyAdjustedJobs);
  if (error) {
    return {
      ok: false,
      errorType: errorType || "pipeline_plan_rejected",
      error,
      suggestedFix: suggestedFix || "Fix ownership zones, lock modes, lockedPaths, allowedEdits, or split shared files into a serial step.",
      lockPlans,
      conflictingPaths,
      serialOnlyMatches,
      executionMode,
    };
  }

  const writePlans = lockPlans.filter((plan) => plan.lockType === "write");
  if (sanitizedWorkspace && writePlans.length) {
    return {
      ok: false,
      errorType: "sanitized_workspace_write_forbidden",
      error: "Sanitized workspace pipelines are read-only. Writer output must use separate Git worktrees.",
      suggestedFix: "Remove write jobs or use a non-sanitized Git repository with isolated worktrees for output.",
      lockPlans,
      executionMode,
    };
  }
  if (effectiveRequiresWorktrees && writePlans.length && CONFIG.worktreeMode === "off") {
    return {
      ok: false,
      errorType: "worktree_required_for_pipeline",
      error: "Multi-agent write pipelines require CODEX_OPENCODE_WORKTREE_MODE=write or all so implementation happens in isolated worktrees.",
      suggestedFix: "Set CODEX_OPENCODE_WORKTREE_MODE=write and restart the MCP server, or create the pipeline with requiresWorktrees=false.",
      lockPlans,
      executionMode,
    };
  }

  if (writePlans.length && !effectiveFinalValidationCommand) {
    return {
      ok: false,
      errorType: "final_validation_required",
      error: "Write pipelines require finalValidationCommand so the combined result has a coordinator-level verification gate.",
      suggestedFix: "Pass a finalValidationCommand such as npm test, npm run typecheck, or a project-specific integration check.",
      lockPlans,
      executionMode,
    };
  }

  const integrationQueue = writePlans.map((plan) => ({
    agent: plan.agent,
    allowedEdits: plan.allowedEdits,
    lockedPaths: plan.lockedPaths,
    forbiddenEdits: plan.forbiddenEdits,
    sharedFiles: plan.sharedFiles,
    serialOnly: plan.serialOnly,
    validationCommand: plan.validationCommand || effectiveFinalValidationCommand,
    validationSpec: plan.validationCommand || effectiveFinalValidationSource !== "policy" ? null : effectiveFinalValidationSpec,
    validationSource: plan.validationCommand ? "job" : effectiveFinalValidationSource,
    status: "planned",
  }));

  const now = new Date().toISOString();
  return {
    ok: true,
    record: {
      pipelineId: makePipelineId(name),
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerGeneration: randomBytes(12).toString("hex"),
      ownerHeartbeatAt: now,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: 0,
      name,
      cwd: cwd || jobs[0]?.cwd || process.cwd(),
      status: "planned",
      createdAt: now,
      updatedAt: now,
      startedAt: "",
      finishedAt: "",
      strategy: "queue",
      requiresWorktrees: effectiveRequiresWorktrees,
      jobs: policyAdjustedJobs.map((job) => ({ ...job })),
      lockPlans,
      queueJobIds: [],
      expectedChildCount: 0,
      batchState: "unstarted",
      cleanupState: "none",
      queueMode: "sqlite",
      integrationQueue,
      finalValidationCommand: effectiveFinalValidationCommand,
      finalValidationSource: effectiveFinalValidationSource,
      finalValidationSpec: effectiveFinalValidationSpec,
      reviewerJob,
      testerJob,
      policy: policy ? {
        path: policyPath || ".mcp/agent-policy.json",
        sha256: policySha256,
        trustedForAuthority: Boolean(policyTrustedForAuthority),
        owners: policy.owners,
        sharedFiles: policy.sharedFiles,
        serialOnly: policy.serialOnly,
        forbiddenEdits: policy.forbiddenEdits,
      } : null,
      sanitizedWorkspace: sanitizedWorkspace ? sanitizePersistedValue(sanitizedWorkspace) : null,
      sanitizedWorkspaceAttestation: sanitizedWorkspace ? { creationPreflight: sanitizedPreflight } : null,
      events: [{
        type: "planned",
        at: now,
        executionMode,
        jobs: jobs.length,
        writeJobs: writePlans.length,
      }],
      errors: [],
    },
  };
}

function verifyParallelLockResults(jobResults) {
  const violations = [];
  const changedByFile = new Map();

  for (const jobResult of jobResults) {
    const { index, lockPlan, result } = jobResult;
    const label = `JOB ${index + 1} (${lockPlan.agent})`;
    const changedFiles = result?.changedFiles || [];

    if (result?.timedOut && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`Agent timeout: ${lockPlan.agent}`);
    } else if (result && result.exitCode !== 0 && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`${label} exited with ${result.exitCode}; do not accept this parallel result without recovery.`);
    }

    if (result?.openCodeFallbackDetected) {
      violations.push(`${label} triggered OpenCode native subagent fallback; do not accept this result because the requested role may not have executed.`);
    }

    if (result?.openCodeApiErrorDetected) {
      violations.push(`${label} returned an OpenCode API error event; do not accept this result without recovery.`);
    }

    if (lockPlan.lockType === "read" && changedFiles.length) {
      violations.push(`${label} was read-only but changed files: ${changedFiles.join(", ")}.`);
    }

    if (lockPlan.lockType === "write") {
      const outsideLock = unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd);
      if (outsideLock.length) {
        violations.push(`${label} changed files outside its allowed edit paths: ${outsideLock.join(", ")}.`);
      }
    }

    const forbiddenChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd));
    if (forbiddenChanged.length) {
      violations.push(`${label} changed forbidden files: ${forbiddenChanged.join(", ")}.`);
    }

    const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);
    if (scopeViolations.outsideWriteScope.length) {
      violations.push(`${label} changed files outside its Scope Contract write paths: ${scopeViolations.outsideWriteScope.join(", ")}.`);
    }
    if (scopeViolations.forbiddenFiles.length) {
      violations.push(`${label} changed Scope Contract forbidden files: ${scopeViolations.forbiddenFiles.join(", ")}.`);
    }
    if (scopeViolations.readOnlyChangedFiles.length) {
      violations.push(`${label} violated a read-only Scope Contract by changing files: ${scopeViolations.readOnlyChangedFiles.join(", ")}.`);
    }

    const sharedChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd));
    if (sharedChanged.length) {
      violations.push(`${label} changed shared/frozen files: ${sharedChanged.join(", ")}.`);
    }

    const restrictedChanged = findSerialOnlyMatches(changedFiles);
    if (restrictedChanged.length) {
      violations.push(`${label} changed serial-only paths: ${restrictedChanged.join(", ")}.`);
    }

    for (const file of changedFiles) {
      const normalized = normalizePathForCompare(file);
      const existing = changedByFile.get(normalized) || [];
      existing.push(label);
      changedByFile.set(normalized, existing);
    }
  }

  for (const [file, labels] of changedByFile.entries()) {
    if (labels.length > 1) {
      violations.push(`Multiple parallel jobs changed the same file "${file}": ${labels.join(", ")}.`);
    }
  }

  return violations;
}

function settleIndependentParallelJobs(executionPromises) {
  return Promise.allSettled(executionPromises);
}

// Every job runs its agent, its read-only retries and its validation command under the one
// group signal, so the deadline covers the longest of those sums; the agent timeout alone
// aborted a validation that started late in a long builder run.
const PARALLEL_GROUP_DEADLINE_MARGIN_MS = 1000 * 60;

function parallelGroupDeadlineMs(lockPlans = []) {
  const budgets = lockPlans.map((plan) => {
    const agentTimeoutMs = timeoutForAgent(plan.agent, plan, plan.timeoutMs);
    // runOpenCodeWithPolicy bounds a reader's attempts by max(retry budget, timeout).
    const agentBudgetMs = plan.lockType === "read"
      ? Math.max(CONFIG.readOnlyRetryMaxElapsedMs, agentTimeoutMs)
      : agentTimeoutMs;
    const validationBudgetMs = String(plan.validationCommand || "").trim() ? CONFIG.validationCommandTimeoutMs : 0;
    return agentBudgetMs + validationBudgetMs;
  });
  return Math.max(0, ...budgets) + PARALLEL_GROUP_DEADLINE_MARGIN_MS;
}

// Group-scope check of one execution workspace after every job of a parallel batch settled.
async function parallelGroupScopeReport({ cwdKey, lockPlans, indexesForCwd, results, before, expectedHead, driftTolerated = false }) {
  const after = await gitChangedFileSnapshot(cwdKey, driftTolerated ? { includeIgnored: false } : {});
  const afterHead = await captureGitHead(cwdKey);
  const headChanged = afterHead !== expectedHead;
  let changedFiles = changedFilesBetween(before, after);
  let externalDriftFiles = [];
  if (driftTolerated && changedFiles.length) {
    // Only edit-denied readers ran here: the change is another client's, reported not rejected.
    const drift = readOnlyWorkspaceDrift(changedFiles, after, headChanged);
    externalDriftFiles = drift.files;
    changedFiles = [];
  }
  const plansForCwd = indexesForCwd.map((index) => lockPlans[index]);
  if (headChanged) {
    const readOnlyCwd = !changedFiles.length && plansForCwd.every((plan) => plan.lockType === "read");
    for (const index of indexesForCwd) {
      const jobResult = results[index];
      if (!jobResult?.result) continue;
      const move = readOnlyCwd && !jobResult.result.errorType
        ? await readOnlyHeadMove(lockPlans[index], cwdKey, expectedHead, afterHead)
        : null;
      if (move) jobResult.result.readOnlyHeadMove = move;
      else jobResult.result.errorType ||= "repository_head_changed_during_execution";
      jobResult.result.executionHeadBefore = expectedHead;
      jobResult.result.executionHeadAfter = afterHead;
    }
  }
  const writePlansForCwd = plansForCwd.filter((plan) => plan.lockType === "write");
  const allowedEditsForCwd = writePlansForCwd.flatMap((plan) => plan.allowedEdits);
  const forbiddenForCwd = plansForCwd.flatMap((plan) => plan.forbiddenEdits.concat(plan.sharedFiles));
  const serialOnlyMatches = findSerialOnlyMatches(changedFiles);
  const disallowedFiles = normalizeLockPathList([
    ...(writePlansForCwd.length ? unsafeChangedFiles(changedFiles, allowedEditsForCwd, cwdKey) : changedFiles),
    ...changedFiles.filter((file) => isWithinAnyPath(file, forbiddenForCwd, cwdKey)),
    ...changedFiles.filter((file) => findSerialOnlyMatches([file]).length),
  ]);
  const rollbackResult = disallowedFiles.length
    ? {
        rollback: "not_attempted_unattributed_changes",
        rollbackFiles: [],
        unresolvedFiles: disallowedFiles,
        reason: "Parallel path-only evidence cannot safely distinguish OpenCode output from concurrent external edits; affected worktrees/output are retained for inspection.",
      }
    : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };
  return {
    cwd: cwdKey,
    headChanged,
    expectedHead,
    actualHead: afterHead,
    changedFiles,
    disallowedFiles,
    serialOnlyMatches,
    externalDriftFiles,
    ...rollbackResult,
  };
}

function parallelExecutionOverlapEvidence(results) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    const leftIntervals = results[leftIndex]?.result?.childExecutionIntervals || [];
    for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
      const rightIntervals = results[rightIndex]?.result?.childExecutionIntervals || [];
      const overlap = leftIntervals.some((left) => rightIntervals.some((right) =>
        left?.startedAtMs && left?.finishedAtMs && right?.startedAtMs && right?.finishedAtMs
        && Math.max(left.startedAtMs, right.startedAtMs) < Math.min(left.finishedAtMs, right.finishedAtMs)
      ));
      if (overlap) pairs.push([leftIndex, rightIndex]);
    }
  }
  return { ranConcurrently: pairs.length > 0, pairs };
}

function labelParallelRunId(text, runId) {
  return String(text || "").replace(/^JOB (\d+)/, (label) => `${label}\nRun id: ${runId} (get_opencode_job finds it; not cancellable like a queue job)`);
}
  return { createPipelinePlan, verifyParallelLockResults, settleIndependentParallelJobs, PARALLEL_GROUP_DEADLINE_MARGIN_MS, parallelGroupDeadlineMs, parallelGroupScopeReport, parallelExecutionOverlapEvidence, labelParallelRunId };
}
