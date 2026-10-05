// Single and parallel job planning and scope validation.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { normalizeLockPath, normalizeLockPathList, normalizeLockPathListForCwd, mergePathLists, overlaps, isWithinAnyPath, unsafeChangedFiles, unsafePathReason, windowsStreamSyntax, hasAmbiguousPathPattern, normalizeFilesystemCase } from "./paths.js";
import { normalizeScopeContract, firstNonEmptyList, DEFAULT_FORBIDDEN_EDIT_PATHS, scopeContractTimeout, scopeContractPathInputs, findSerialOnlyMatches } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createLockPlanRuntime({
  CONFIG,
  // Q-012: CODEX_OPENCODE_PROVIDER_LIMITS; without it every key has the configured limit.
  providerLimitForKey = () => CONFIG.providerConcurrencyLimit,
  hasWriteIntent,
  normalizeOrchestratorMode,
  userAuthorizedOrchestrator,
  contractorAuthorizationValid,
  READ_ONLY_PARALLEL_AGENTS,
  PARALLEL_LOCK_TYPES,
  WRITE_CAPABLE_AGENTS,
  hardLockPathsForPlan,
  orchestratorPolicyError,
  validationCommandTrustError,
}) {
function normalizeLockType(lockType, job) {
  const raw = String(lockType || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return hasWriteIntent(job) ? "write" : "read";
  }

  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }

  if (raw === "serial" || raw === "integration" || raw === "serial_integration_lock") {
    return "serial_integration";
  }

  return raw;
}

function normalizeLockMode(lockMode, lockType) {
  const raw = String(lockMode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (lockType === "read") {
    return raw && !["none", "off", "read", "read_only", "readonly"].includes(raw) ? raw : CONFIG.defaultReadLockMode;
  }

  if (!raw) {
    return CONFIG.defaultWriteLockMode;
  }

  if (raw === "none" || raw === "read" || raw === "read_only" || raw === "readonly") {
    return "off";
  }

  if (raw === "auto" || raw === "temporary") {
    return CONFIG.defaultWriteLockMode;
  }

  return raw;
}

function createLockPlan(job, index) {
  const cwd = job.cwd || "";
  const lockType = normalizeLockType(job.lockType || job.delegation?.lockType, job);
  const lockMode = normalizeLockMode(job.lockMode || job.delegation?.lockMode, lockType);
  const scopeContract = normalizeScopeContract(job);
  const hasExplicitScopeContract = Boolean(job.scopeContract || job.delegation?.scopeContract);
  const legacyScopeWriteFallback = hasExplicitScopeContract ? [] : scopeContract?.scope.write;
  const lockedPaths = normalizeLockPathListForCwd(
    firstNonEmptyList(job.lockedPaths, job.ownedPaths, job.delegation?.lockedPaths),
    cwd
  );
  const allowedEdits = normalizeLockPathListForCwd(
    firstNonEmptyList(job.allowedEdits, job.delegation?.allowedEdits, scopeContract?.allowedEdits, legacyScopeWriteFallback),
    cwd
  );
  const forbiddenEdits = normalizeLockPathListForCwd(
    mergePathLists(
      DEFAULT_FORBIDDEN_EDIT_PATHS,
      job.forbiddenEdits,
      job.delegation?.forbiddenEdits,
      scopeContract?.scope.forbidden
    ),
    cwd
  );
  const sharedFiles = normalizeLockPathListForCwd(
    firstNonEmptyList(job.sharedFiles, job.delegation?.sharedFiles, scopeContract?.shared),
    cwd
  );
  const serialOnly = normalizeLockPathListForCwd(
    firstNonEmptyList(job.serialOnly, job.delegation?.serialOnly, scopeContract?.serialOnly),
    cwd
  );
  const orchestratorMode = normalizeOrchestratorMode(job);
  const explicitUserAuthorization = userAuthorizedOrchestrator(job);
  const contractTimeoutMs = scopeContractTimeout(scopeContract, lockType);

  return {
    index,
    agent: job.agent,
    task: job.task,
    cwd,
    lockMode,
    lockType,
    orchestratorMode,
    userAuthorizedOrchestrator: explicitUserAuthorization,
    contractorAuthorizationVerified: orchestratorMode === "contractor" && contractorAuthorizationValid(job),
    lockedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    scopeContract,
    sanitizedWorkspace: job.sanitizedWorkspace || null,
    validationCommand: job.validationCommand || job.delegation?.validationCommand || scopeContract?.validationCommand || "",
    timeoutMs: job.timeoutMs || job.delegation?.timeoutMs || contractTimeoutMs || null,
  };
}

function directExecutionLockConflictDetails(lockResult, { queueConflict = false, lockType = "write" } = {}) {
  if (queueConflict) {
    return {
      headline: "Queued job is waiting for a conflicting consistency lock.",
      errorType: "queue_lock_conflict",
      suggestedFix: "The queue will retry after the conflicting reader/writer lock is released.",
    };
  }
  if (lockResult?.conflict?.origin === "internal") {
    if (lockType === "read") {
      return {
        headline: "Read job is waiting for an active writer.",
        errorType: "read_lock_conflict",
        suggestedFix: "Wait for the overlapping writer to finish, retry later, or provide an explicit disjoint scope.read path.",
      };
    }
    return {
      headline: "Write job is waiting for an active writer.",
      errorType: "write_lock_conflict",
      suggestedFix: "Wait for the active writer to finish, retry later, or choose a non-overlapping lockedPaths scope.",
    };
  }
  return {
    headline: "Manual lock already exists. Do not pre-acquire locks before run_opencode_agent.",
    errorType: "manual_lock_misuse",
    suggestedFix: "Release the existing manual lock or wait for it to expire, then call run_opencode_agent with lockedPaths only.",
  };
}

function validateScopeContract(job, lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  // G-08: stream syntax in any path input is refused before any scope rule compares paths.
  const streamPath = [
    ...scopeContractPathInputs(scopeContract),
    ...(lockPlan.lockedPaths || []),
    ...(lockPlan.allowedEdits || []),
    ...(lockPlan.forbiddenEdits || []),
    ...(lockPlan.sharedFiles || []),
    ...(lockPlan.serialOnly || []),
  ].find((value) => windowsStreamSyntax(normalizeLockPath(value)));
  if (streamPath !== undefined) {
    return {
      errorType: "scope_path_unsafe",
      error: `Unsafe path input: ${unsafePathReason([streamPath])}`,
      suggestedFix: "Name plain files or directories; the bridge cannot scope-check NTFS alternate data streams or drive-relative paths.",
    };
  }
  if (!scopeContract) {
    if (lockPlan.lockType === "write" || job.write === true) {
      return {
        errorType: "missing_scope_contract",
        error: "Every write job must include an explicit Scope Contract. Scope Contract is the source of truth for read, write, allowed, forbidden, shared, serial-only, and validation boundaries.",
        suggestedFix: "Pass scopeContract with mode write, non-empty write and allowedEdits paths, forbidden/shared/serialOnly lists as needed, and validationCommand for risky work.",
      };
    }
    return null;
  }

  if (scopeContract.agent && scopeContract.agent !== lockPlan.agent) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract agent "${scopeContract.agent}" does not match requested agent "${lockPlan.agent}".`,
      suggestedFix: "Use a Scope Contract for the same agent being delegated.",
    };
  }

  if (!["read", "write"].includes(scopeContract.mode)) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract mode "${scopeContract.mode}" is invalid. Use read or write.`,
      suggestedFix: "Set Scope Contract mode to read or write.",
    };
  }

  const unsafeReason = unsafePathReason(scopeContractPathInputs(scopeContract), lockPlan.cwd || process.cwd());
  if (unsafeReason) {
    return {
      errorType: "scope_path_unsafe",
      error: `Scope Contract has unsafe path input: ${unsafeReason}`,
      suggestedFix: "Use repo-relative bounded paths without parent traversal, home shortcuts, control characters, or outside-repo absolute paths.",
    };
  }

  if (scopeContract.mode === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: "Read-only Scope Contract cannot include write paths.",
      suggestedFix: "Remove scope.write for read-only agents, or change the contract mode and job to write with explicit locks.",
    };
  }

  if (READ_ONLY_PARALLEL_AGENTS.has(String(lockPlan.agent || "").trim().toLowerCase()) && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or delegate write work to builder/debugger with explicit locks.",
    };
  }

  if (lockPlan.lockType === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or run a write-capable agent with write true and lockedPaths.",
    };
  }

  if (lockPlan.lockType === "write" && scopeContract.mode !== "write") {
    return {
      errorType: "scope_contract_invalid",
      error: "Write jobs with a Scope Contract must use mode write.",
      suggestedFix: "Set Scope Contract mode to write and provide scope.write paths.",
    };
  }

  if (scopeContract.mode === "write" && !scopeContract.scope.write.length) {
    return {
      errorType: "empty_allowed_edits",
      error: "Write Scope Contract requires non-empty scope.write paths.",
      suggestedFix: "Add bounded scope.write paths and matching allowedEdits.",
    };
  }

  if (scopeContract.mode === "write" && !lockPlan.allowedEdits.length) {
    return {
      errorType: "empty_allowed_edits",
      error: "Write Scope Contract requires non-empty allowedEdits.",
      suggestedFix: "Add explicit allowedEdits; do not rely on lockedPaths as the edit allowlist.",
    };
  }

  if (scopeContract.allowedEdits.length) {
    const outsideScope = scopeContract.scope.write.length
      ? unsafeChangedFiles(scopeContract.allowedEdits, scopeContract.scope.write, lockPlan.cwd)
      : [];
    if (outsideScope.length) {
      return {
        errorType: "scope_write_forbidden",
        error: `Scope Contract allowedEdits contains paths outside scope.write: ${outsideScope.join(", ")}.`,
        conflictingPaths: outsideScope,
        suggestedFix: "Keep allowedEdits inside scope.write, or expand scope.write explicitly.",
      };
    };
  }

  const forbiddenWriteOverlap = overlaps(scopeContract.scope.write, scopeContract.scope.forbidden);
  if (forbiddenWriteOverlap) {
    return {
      errorType: "scope_write_forbidden",
      error: `Scope Contract write path is forbidden: ${forbiddenWriteOverlap[0]} / ${forbiddenWriteOverlap[1]}.`,
      conflictingPaths: forbiddenWriteOverlap,
      suggestedFix: "Remove the forbidden path from scope.write, or narrow the write scope so forbidden paths are excluded.",
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (scopeContract.scope.write.length && !isWithinAnyPath(allowedPath, scopeContract.scope.write, lockPlan.cwd)) {
      return {
        errorType: "scope_write_forbidden",
        error: `Allowed edit path is outside Scope Contract write paths: ${allowedPath}.`,
        conflictingPaths: [allowedPath],
        suggestedFix: "Keep allowedEdits inside scope.write, or expand scope.write explicitly.",
      };
    }
  }

  return null;
}

// B-110: serial_integration is the lock the bridge's own integration takes (acquireHardLock in
// integration-serial.js, never a lock plan). An agent job under it got no Scope Contract, no
// worktree, no stream snapshot and no allowedEdits check, so agent jobs may not request it.
function reservedLockTypeError(lockPlan) {
  if (lockPlan.lockType !== "serial_integration") return null;
  return {
    errorType: "lock_type_reserved",
    error: `OpenCode job for agent "${lockPlan.agent}" requested lockType serial_integration. serial_integration is the bridge's own integration lock; use write.`,
    suggestedFix: "Use lockType write (or write: true) with lockedPaths, allowedEdits and a write Scope Contract; integrate the worktree with integrate_opencode_worktree.",
  };
}

// Q-018: continuation is an explicit single write job in a retained bridge worktree.
function continueWorktreeJobError(job, lockPlan = null) {
  if (job?.continueWorktree === undefined) return null;
  const plan = lockPlan || createLockPlan(job, 0);
  if (job.autoIntegrate || job.sanitizedWorkspace || plan.orchestratorMode === "contractor" || CONFIG.worktreeMode === "off") {
    return {
      errorType: "continue_worktree_not_applicable",
      error: "continueWorktree cannot be used with autoIntegrate, sanitizedWorkspace, contractor mode, or worktree mode off.",
      suggestedFix: "Use a standalone write job with worktrees enabled, then integrate the continued worktree once at the end.",
    };
  }
  if (plan.lockType !== "write") {
    return {
      errorType: "continue_worktree_requires_write_job",
      error: "continueWorktree requires a write job with lockType write.",
      suggestedFix: "Use a write-capable agent with a write lock, or remove continueWorktree for a read-only job.",
    };
  }
  return null;
}

function sanitizedJobPolicyError(job) {
  if (!job?.sanitizedWorkspace) return null;
  if (hasWriteIntent(job) || job.lockType === "write" || job.lockType === "serial_integration") {
    return {
      error: "Sanitized workspace execution is read-only. Writers require a separate Git worktree/output root.",
      errorType: "sanitized_workspace_write_forbidden",
      suggestedFix: "Use a managed read-only agent with lockType read/off, or create a separate Git worktree for output.",
    };
  }
  if (String(job.validationCommand || job.scopeContract?.validationCommand || job.delegation?.validationCommand || "").trim()) {
    return {
      error: "Sanitized workspace jobs may not execute repository validation commands; verification is manifest-based before and after the wave.",
      errorType: "sanitized_workspace_command_forbidden",
      suggestedFix: "Remove validationCommand and use verify_sanitized_workspace plus an externally trusted validation environment.",
    };
  }
  if (job.subagentStrategy && job.subagentStrategy !== "reject") {
    return {
      error: "Sanitized workspace jobs require subagentStrategy=reject so the resolved agent is the directly attested read-only role.",
      errorType: "sanitized_workspace_subagent_forbidden",
      suggestedFix: "Set subagentStrategy to reject and choose a primary/all managed read-only agent.",
    };
  }
  return null;
}

// run_opencode_parallel is one synchronous tool call. Jobs beyond the provider slots wait
// for one (up to their timeout) and then run their full timeout, so the call could take
// twice the agent timeout and outlive Codex's tool_timeout_sec. Pipelines and queued jobs
// take a lease per job and are not limited here. Dry runs take no slot.
// Leases are counted per provider key (providerKeyForMetadata), so once each job's attested
// metadata is known the limit applies to each provider's jobs; without keys every job counts
// against one key, which is the conservative reading.
function parallelBatchCapacityError(jobs, providerKeys = null) {
  const leasedByKey = new Map();
  jobs.forEach((job, index) => {
    if (job.dryRun) return;
    const key = Array.isArray(providerKeys) && providerKeys[index] ? providerKeys[index] : CONFIG.providerConcurrencyKey;
    leasedByKey.set(key, (leasedByKey.get(key) || 0) + 1);
  });
  const [overKey, leasedJobCount] = [...leasedByKey.entries()].find(([key, count]) => count > providerLimitForKey(key)) || [];
  if (!overKey) return null;
  const keyed = Array.isArray(providerKeys) && leasedByKey.size > 1;
  const limit = providerLimitForKey(overKey);
  const limitName = limit === CONFIG.providerConcurrencyLimit ? "the provider slot limit (CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT or its set_opencode_concurrency providerLimit override)" : "its per-provider slot limit (set_opencode_concurrency providerLimits, else CODEX_OPENCODE_PROVIDER_LIMITS)";
  return {
    error: `${leasedJobCount} parallel jobs${keyed ? ` for provider key ${overKey}` : ""} exceed ${limitName} ${limit}; the extra jobs would run in a second wave inside the same tool call.`,
    errorType: "parallel_batch_exceeds_provider_capacity",
    suggestedFix: `Send at most ${limit} jobs per provider per run_opencode_parallel call, or enqueue the rest with enqueue_opencode_job.`,
  };
}

function validateParallelWritePlan(jobs) {
  const lockPlans = jobs.map((job, index) => createLockPlan(job, index));
  // Q-018: even a one-item parallel call must use a fresh worktree per writer.
  if (jobs.some((job) => job?.continueWorktree !== undefined)) {
    return {
      errorType: "continue_worktree_unsupported_in_parallel",
      error: "continueWorktree is not supported in parallel jobs or multi-job plans.",
      suggestedFix: "Continue the previous worktree with run_opencode_agent or enqueue_opencode_job as one standalone write job.",
      lockPlans,
    };
  }
  if (jobs.length > CONFIG.parallelLimit) {
    return {
      error: `Parallel job count ${jobs.length} exceeds CODEX_OPENCODE_PARALLEL_LIMIT ${CONFIG.parallelLimit}.`,
      errorType: "parallel_plan_rejected",
      lockPlans,
    };
  }
  const writePlans = lockPlans.filter((plan) => plan.lockType === "write");
  if (writePlans.length > 1) {
    for (const plan of writePlans) {
      // Parallel writers always lock strictly; record what the caller asked for so the output
      // can say the mode was changed instead of silently printing "strict".
      const requested = String(jobs[plan.index]?.lockMode || "").trim().toLowerCase();
      if (requested && requested !== CONFIG.defaultParallelWriteLockMode) plan.requestedLockMode = requested;
      plan.lockMode = CONFIG.defaultParallelWriteLockMode;
    }
  }

  for (const plan of lockPlans) {
    const job = jobs[plan.index];
    const reservedError = reservedLockTypeError(plan);
    if (reservedError) return { ...reservedError, lockPlans };
    const sanitizedError = sanitizedJobPolicyError(job);
    if (sanitizedError) {
      return { ...sanitizedError, lockPlans };
    }
    const queueOnly = queueOnlyOptionsError(job);
    if (queueOnly) return { ...queueOnly, lockPlans };
    if (job.scopeContract?.selfCheckCommands !== undefined) {
      return {
        error: "selfCheckCommands is not supported by run_opencode_parallel: the self-check passes are implemented for single and queued jobs only.",
        errorType: "self_check_unsupported_in_parallel",
        suggestedFix: "Run the job with run_opencode_agent or enqueue_opencode_job, or remove selfCheckCommands.",
        lockPlans,
      };
    }
    if (job.validationFixPasses) {
      return {
        error: "validationFixPasses is not supported by run_opencode_parallel: the fix pass is implemented for single and queued jobs only.",
        errorType: "validation_fix_pass_unsupported_in_parallel",
        suggestedFix: "Run the job with run_opencode_agent or enqueue_opencode_job, or remove validationFixPasses.",
        lockPlans,
      };
    }
    const planPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.forbiddenEdits, plan.sharedFiles, plan.serialOnly, scopeContractPathInputs(plan.scopeContract));
    const orchestratorError = orchestratorPolicyError(job, plan, "parallel");
    if (orchestratorError) {
      return {
        ...orchestratorError,
        serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
        lockPlans,
      };
    }

    const scopeError = validateScopeContract(job, plan);
    if (scopeError) {
      return {
        ...scopeError,
        conflictingPaths: scopeError.conflictingPaths || [],
        lockPlans,
      };
    }

    if (!PARALLEL_LOCK_TYPES.has(plan.lockType)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockType "${plan.lockType}". Use read or write.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    if (!["off", "simple", "strict"].includes(plan.lockMode)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockMode "${plan.lockMode}". Use off, simple, or strict.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode off for read-only jobs, simple for one writer, and strict for parallel writers.",
        lockPlans,
      };
    }

    const unsafeReason = unsafePathReason(planPathInputs, plan.cwd);
    if (unsafeReason) {
      return {
        error: `Parallel job for agent "${plan.agent}" has unsafe path input: ${unsafeReason}`,
        errorType: "unsafe_path",
        lockPlans,
      };
    }

    if (plan.lockType !== "read" && plan.lockMode === "off") {
      return {
        error: `Parallel write job for agent "${plan.agent}" cannot use lockMode off.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode strict for parallel write jobs.",
        lockPlans,
      };
    }

    if (plan.lockType === "read") {
      if (job.write === true || plan.allowedEdits.length) {
        return {
          error: `Read-only job for agent "${plan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
          lockPlans,
        };
      }
      if (WRITE_CAPABLE_AGENTS.has(String(plan.agent || "").trim().toLowerCase())) {
        return {
          error: `Write-capable agent "${plan.agent}" cannot run against the target repository under a read-only lock.`,
          errorType: "read_only_agent_required",
          suggestedFix: "Use planner, architect, reviewer, tester, or orchestrator for read-only work. Run builder/debugger only as bounded worktree writers.",
          lockPlans,
        };
      }
      continue;
    }

    if (!plan.lockedPaths.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: lockedPaths.`,
        errorType: "missing_locked_paths",
        suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
        lockPlans,
      };
    }

    if (!plan.allowedEdits.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: allowedEdits.`,
        errorType: "empty_allowed_edits",
        suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
        lockPlans,
      };
    }

    const ambiguousPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.sharedFiles, plan.scopeContract?.scope.write || []);
    if (hasAmbiguousPathPattern(ambiguousPathInputs, plan.cwd)) {
      return {
        error: `Parallel write job for agent "${plan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks, or run serially.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    const serialOnlyMatches = findSerialOnlyMatches(plan.lockedPaths.concat(plan.allowedEdits), plan.serialOnly);
    if (serialOnlyMatches.length) {
      return {
        error: "This file or path is global/risky and cannot be edited during parallel execution.",
        errorType: "serial_only_parallel_write",
        suggestedFix: "Run this task serially, then run reviewer/tester validation.",
        serialOnlyMatches,
        lockPlans,
      };
    }

    const sharedOverlap = overlaps(plan.allowedEdits, plan.sharedFiles);
    if (sharedOverlap) {
      return {
        error: `Parallel write job for agent "${plan.agent}" attempts to edit a shared/frozen path: ${sharedOverlap[0]} / ${sharedOverlap[1]}.`,
        errorType: "shared_file_parallel_write",
        suggestedFix: "Move shared/frozen changes to a separate serial writer step reviewed by Codex.",
        conflictingPaths: sharedOverlap,
        lockPlans,
      };
    }

    for (const allowedPath of plan.allowedEdits) {
      if (!isWithinAnyPath(allowedPath, plan.lockedPaths, plan.cwd)) {
        return {
          error: `Parallel write job for agent "${plan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
          errorType: "parallel_plan_rejected",
          lockPlans,
        };
      }
    }

    const forbiddenOverlap = overlaps(plan.allowedEdits, plan.forbiddenEdits);
    const forbiddenAllowedPaths = plan.allowedEdits.filter((allowedPath) =>
      isWithinAnyPath(allowedPath, plan.forbiddenEdits, plan.cwd)
    );
    if (forbiddenOverlap || forbiddenAllowedPaths.length) {
      const conflictingPaths = forbiddenOverlap || forbiddenAllowedPaths;
      return {
        error: `Parallel write job for agent "${plan.agent}" allows a forbidden edit path: ${conflictingPaths.join(" / ")}.`,
        errorType: "parallel_plan_rejected",
        conflictingPaths,
        lockPlans,
      };
    }

  }

  // Paths are repository-relative: the same relative path in two repositories is no overlap.
  const sameProject = (left, right) => !left.cwd || !right.cwd
    || normalizeFilesystemCase(path.resolve(left.cwd), left.cwd) === normalizeFilesystemCase(path.resolve(right.cwd), left.cwd);
  for (let i = 0; i < lockPlans.length; i += 1) {
    for (let j = i + 1; j < lockPlans.length; j += 1) {
      const left = lockPlans[i];
      const right = lockPlans[j];
      if ((left.lockType === "read") === (right.lockType === "read")) continue;
      if (!sameProject(left, right)) continue;
      const overlap = overlaps(hardLockPathsForPlan(left), hardLockPathsForPlan(right), left.cwd || right.cwd);
      if (overlap) {
        return {
          error: `Parallel read/write jobs overlap: "${left.agent}" and "${right.agent}" both require ${overlap[0]} / ${overlap[1]}.`,
          errorType: "parallel_read_write_conflict",
          suggestedFix: "Run the reader after the overlapping writer, or give the reader an explicit disjoint scope.read path.",
          conflictingPaths: overlap,
          lockPlans,
        };
      }
    }
  }

  if (writePlans.length > 1) {
    for (let i = 0; i < writePlans.length; i += 1) {
      for (let j = i + 1; j < writePlans.length; j += 1) {
        if (!sameProject(writePlans[i], writePlans[j])) continue;
        const overlap = overlaps(
          writePlans[i].allowedEdits.concat(writePlans[i].lockedPaths),
          writePlans[j].allowedEdits.concat(writePlans[j].lockedPaths),
          writePlans[i].cwd || writePlans[j].cwd
        );
        if (overlap) {
          return {
            error: `Parallel write jobs overlap: "${writePlans[i].agent}" and "${writePlans[j].agent}" both include ${overlap[0]} / ${overlap[1]}.`,
            errorType: "parallel_plan_rejected",
            conflictingPaths: overlap,
            lockPlans,
          };
        }
      }
    }
  }

  return { error: null, lockPlans };
}

// Q-009, B-068: self-check commands. Builders have no shell beyond git diagnostics, so in round 3 a
// builder could not run `node tools/validate.cjs` on the batch it wrote. A write job's Scope
// Contract may name exact commands that the BRIDGE runs in the worktree after the agent finished
// (before validationCommand, with the same trust rules and the process supervisor); a failing one
// gives the agent another run with its output (selfCheckPasses, default 2, at most 3). The agent
// itself gets no new permission: B-068 removed the first version, which let the agent run these
// commands through exact bash allow rules, because edits are not restricted while the agent runs
// (it could rewrite the script, run it as the bridge user, and put it back). Each command is still
// one plain command (no wildcard, quote, backslash or shell operator) whose executable passes the
// validationCommand rules, and a script an interpreter runs must not be an allowed edit.
const SELF_CHECK_MAX_COMMANDS = 8;

const SELF_CHECK_FORBIDDEN_CHARACTERS = /[*?[\]{}"'`$;&|<>()\\\r\n\t]/;

const SELF_CHECK_INTERPRETERS = new Set(["node", "python", "python3", "py", "bun", "deno"]);

const SELF_CHECK_DEFAULT_PASSES = 2;

const SELF_CHECK_MAX_PASSES = 3;

function selfCheckCommandsError(job, lockPlan) {
  const commands = lockPlan?.scopeContract?.selfCheckCommands ?? job?.scopeContract?.selfCheckCommands;
  const refuse = (errorType, error) => ({ errorType, error, suggestedFix: "List exact commands such as \"node tools/validate.cjs out/x.json\" for a builder or debugger write job, or remove selfCheckCommands." });
  const passes = job?.selfCheckPasses;
  if (passes !== undefined && passes !== null) {
    if (typeof passes !== "number" || !Number.isInteger(passes) || passes < 0 || passes > SELF_CHECK_MAX_PASSES) {
      return refuse("self_check_invalid", `selfCheckPasses must be an integer from 0 to ${SELF_CHECK_MAX_PASSES}; got ${JSON.stringify(passes)}.`);
    }
    if (commands === undefined || commands === null) return refuse("self_check_not_applicable", "selfCheckPasses needs scopeContract.selfCheckCommands: the passes run after a self-check failed.");
  }
  if (commands === undefined || commands === null) return null;
  if (!Array.isArray(commands) || !commands.length || commands.length > SELF_CHECK_MAX_COMMANDS) {
    return refuse("self_check_invalid", `selfCheckCommands must list 1 to ${SELF_CHECK_MAX_COMMANDS} commands.`);
  }
  const agent = String(job?.agent || "").toLowerCase();
  if (lockPlan?.lockType === "read" || job?.sanitizedWorkspace || !WRITE_CAPABLE_AGENTS.has(agent) || job?.orchestratorMode === "contractor") {
    return refuse("self_check_not_applicable", "selfCheckCommands apply to builder and debugger write jobs only (read-only roles and sanitized readers have no shell; a contractor delegates its checks).");
  }
  const allowedEdits = normalizeLockPathList(lockPlan?.allowedEdits || job?.allowedEdits || []);
  // B-112: compare like the changed-file check does (filesystem case of the checkout): allowedEdits
  // were lowercased on a case-insensitive checkout, so a case-sensitive startsWith let
  // `node Tools/Validators/check.cjs` run a script the agent may edit.
  const editable = (candidate) => {
    const normalized = normalizeLockPathList([candidate])[0] || "";
    return Boolean(normalized) && isWithinAnyPath(normalized, allowedEdits, lockPlan?.cwd || job?.cwd || "");
  };
  const seen = new Set();
  for (const raw of commands) {
    const command = String(raw ?? "").trim();
    if (!command || SELF_CHECK_FORBIDDEN_CHARACTERS.test(command) || /\s{2,}/.test(command)) {
      return refuse("self_check_invalid", `Self-check command ${JSON.stringify(command)} must be one plain command with single spaces: no wildcards, quotes, backslashes, shell operators or substitutions.`);
    }
    if (seen.has(command)) return refuse("self_check_invalid", `Self-check command ${JSON.stringify(command)} is listed twice.`);
    seen.add(command);
    const parsed = command.split(" ");
    if (/[\\/]/.test(parsed[0])) return refuse("self_check_untrusted", `Self-check command ${JSON.stringify(command)} must start with a bare executable name from CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST.`);
    const trust = validationCommandTrustError(parsed);
    if (trust) return refuse("self_check_untrusted", `Self-check command ${JSON.stringify(command)}: ${trust}`);
    const executable = parsed[0].toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
    if (SELF_CHECK_INTERPRETERS.has(executable)) {
      const script = parsed.slice(1).find((argument) => !argument.startsWith("-"));
      if (script && editable(script)) {
        return refuse("self_check_script_editable", `Self-check command ${JSON.stringify(command)} runs ${script}, which this job may edit; the agent could change it and run its own code.`);
      }
    }
    if (["npm", "pnpm", "yarn"].includes(executable) && editable("package.json")) {
      return refuse("self_check_script_editable", `Self-check command ${JSON.stringify(command)} runs package.json scripts, and package.json is an allowed edit of this job.`);
    }
  }
  return null;
}

// Q-007: options only the durable queue can honour (it requeues, waits and integrates after the
// run); a direct or parallel run would silently ignore them, so they are refused there.
function queueOnlyOptionsError(job) {
  const named = ["models", "maxAttempts", "autoIntegrate"].filter((key) => job?.[key] !== undefined && job?.[key] !== null);
  if (!named.length) return null;
  return {
    errorType: "queue_only_option",
    error: `${named.join(", ")} ${named.length === 1 ? "is" : "are"} honoured by enqueue_opencode_job only: the queue retries, waits for paused models and integrates after the run; this tool would ignore ${named.length === 1 ? "it" : "them"}.`,
    suggestedFix: "Enqueue the job with enqueue_opencode_job, or remove the option.",
  };
}

// Q-004: validationFixPasses is 0 or 1 and only means something for a write job whose
// validationCommand the bridge runs; anything else would be an option that silently does nothing.
function validationFixPassError(job, lockPlan) {
  const requested = job?.validationFixPasses;
  if (requested === undefined || requested === null || requested === 0) return null;
  if (requested !== 1) {
    return { errorType: "validation_fix_pass_invalid", error: `validationFixPasses must be 0 or 1; got ${JSON.stringify(requested)}.`, suggestedFix: "Use validationFixPasses 0 (default) or 1." };
  }
  if (lockPlan.lockType === "read" || job.sanitizedWorkspace) {
    return { errorType: "validation_fix_pass_not_applicable", error: "validationFixPasses applies to write jobs only; a read-only or sanitized-workspace job has no validation to fix.", suggestedFix: "Remove validationFixPasses." };
  }
  if (!String(lockPlan.validationCommand || "").trim()) {
    return { errorType: "validation_fix_pass_not_applicable", error: "validationFixPasses needs a validationCommand: the fix pass runs after that command fails.", suggestedFix: "Add a validationCommand, or remove validationFixPasses." };
  }
  return null;
}

function validateSingleLockPlan(job) {
  // Q-018: option-specific refusals precede sanitized-workspace and generic scope errors.
  if (job?.continueWorktree !== undefined) {
    const lockPlan = createLockPlan(job, 0);
    const continuationError = continueWorktreeJobError(job, lockPlan);
    if (continuationError) return { ...continuationError, lockPlan };
  }
  const sanitizedError = sanitizedJobPolicyError(job);
  if (sanitizedError) {
    return {
      ...sanitizedError,
      lockPlan: createLockPlan({ ...job, write: false, lockType: "read", lockMode: "off" }, 0),
    };
  }
  const lockPlan = createLockPlan(job, 0);
  const reservedError = reservedLockTypeError(lockPlan);
  if (reservedError) return { ...reservedError, lockPlan };
  const planPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.forbiddenEdits, lockPlan.sharedFiles, lockPlan.serialOnly, scopeContractPathInputs(lockPlan.scopeContract));
  const orchestratorError = orchestratorPolicyError(job, lockPlan, "single");
  if (orchestratorError) {
    return {
      ...orchestratorError,
      serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
      lockPlan,
    };
  }

  const scopeError = validateScopeContract(job, lockPlan);
  if (scopeError) {
    return {
      ...scopeError,
      conflictingPaths: scopeError.conflictingPaths || [],
      lockPlan,
    };
  }

  if (!PARALLEL_LOCK_TYPES.has(lockPlan.lockType)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockType "${lockPlan.lockType}". Use read or write.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  if (!["off", "simple", "strict"].includes(lockPlan.lockMode)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockMode "${lockPlan.lockMode}". Use off, simple, or strict.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode off for read-only jobs and simple/strict for write jobs.",
      lockPlan,
    };
  }

  if (lockPlan.lockType !== "read" && lockPlan.lockMode === "off") {
    return {
      error: `Write job for agent "${lockPlan.agent}" cannot use lockMode off.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode simple for a single writer or strict for coordinated writer work.",
      lockPlan,
    };
  }

  const fixPassError = validationFixPassError(job, lockPlan);
  if (fixPassError) return { ...fixPassError, lockPlan };
  const selfCheckError = selfCheckCommandsError(job, lockPlan);
  if (selfCheckError) return { ...selfCheckError, lockPlan };

  const unsafeReason = unsafePathReason(planPathInputs, lockPlan.cwd);
  if (unsafeReason) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has unsafe path input: ${unsafeReason}`,
      errorType: "unsafe_path",
      lockPlan,
    };
  }

  if (lockPlan.lockType === "read") {
    if (job.write === true || lockPlan.allowedEdits.length) {
      return {
        error: `Read-only job for agent "${lockPlan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
        errorType: "read_only_edit_forbidden",
        lockPlan,
      };
    }
    if (WRITE_CAPABLE_AGENTS.has(String(lockPlan.agent || "").trim().toLowerCase())) {
      return {
        error: `Write-capable agent "${lockPlan.agent}" cannot run against the target repository under a read-only lock.`,
        errorType: "read_only_agent_required",
        suggestedFix: "Use planner, architect, reviewer, tester, or orchestrator for read-only work. Run builder/debugger only as bounded worktree writers.",
        lockPlan,
      };
    }
    return { error: null, lockPlan };
  }

  if (!lockPlan.lockedPaths.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: lockedPaths.`,
      errorType: "missing_locked_paths",
      suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
      lockPlan,
    };
  }

  if (!lockPlan.allowedEdits.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: allowedEdits.`,
      errorType: "empty_allowed_edits",
      suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
      lockPlan,
    };
  }

  const ambiguousPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.sharedFiles, lockPlan.scopeContract?.scope.write || []);
  if (hasAmbiguousPathPattern(ambiguousPathInputs, lockPlan.cwd)) {
    return {
      error: `Write job for agent "${lockPlan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (!isWithinAnyPath(allowedPath, lockPlan.lockedPaths, lockPlan.cwd)) {
      return {
        error: `Write job for agent "${lockPlan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
        errorType: "lock_plan_rejected",
        lockPlan,
      };
    }
  }

  const forbiddenOverlap = overlaps(lockPlan.allowedEdits, lockPlan.forbiddenEdits);
  const forbiddenAllowedPaths = lockPlan.allowedEdits.filter((allowedPath) =>
    isWithinAnyPath(allowedPath, lockPlan.forbiddenEdits, lockPlan.cwd)
  );
  if (forbiddenOverlap || forbiddenAllowedPaths.length) {
    const conflictingPaths = forbiddenOverlap || forbiddenAllowedPaths;
    return {
      error: `Write job for agent "${lockPlan.agent}" allows a forbidden edit path: ${conflictingPaths.join(" / ")}.`,
      errorType: "lock_plan_rejected",
      conflictingPaths,
      lockPlan,
    };
  }

  return { error: null, lockPlan };
}

  return { normalizeLockType, normalizeLockMode, createLockPlan, directExecutionLockConflictDetails, validateScopeContract, continueWorktreeJobError, sanitizedJobPolicyError, parallelBatchCapacityError, validateParallelWritePlan, SELF_CHECK_MAX_COMMANDS, SELF_CHECK_FORBIDDEN_CHARACTERS, SELF_CHECK_INTERPRETERS, SELF_CHECK_DEFAULT_PASSES, SELF_CHECK_MAX_PASSES, selfCheckCommandsError, queueOnlyOptionsError, validationFixPassError, validateSingleLockPlan };
}
