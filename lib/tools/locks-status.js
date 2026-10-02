// MCP tools: agent locks, workspace verification, agent listing, bridge status and diagnosis, delegation plans, single runs and queue listing.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { createDirectRunAudit } from "../../bin/direct-run-audit.js";
import { integrationQuarantineStatusLine } from "../integration.js";
import { redactSensitiveText, sanitizePersistedValue } from "../redaction.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerLockAndStatusTools({ BRIDGE_INSTANCE_ID, BRIDGE_PROCESS_STARTED_AT, BRIDGE_RUNTIME_DIR, BRIDGE_SOURCE_SHA256, CONFIG, DEFAULT_LOCK_TTL_MS, DEFAULT_SUBAGENT_PROXY_AGENT, GLOBALLY_REQUIRED_MANAGED_AGENTS, GLOBAL_BRIDGE_STATE_DIR, MAX_LOCK_TTL_MS, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, MCP_SANITIZED_READER_AGENT, OPENCODE_AGENT_DIR, OPENCODE_EXE, OPENCODE_SKILL_DIR, QUEUE_JOBS, VALIDATION_PREFLIGHT_FIX, acquireHardLock, agentIdleTimeoutStatusLine, agentMetadataPolicyOptions, allowlistedModelOverride, applyModelOverrideToMetadata, assessQueuePlan, attestContractorNestedAgents, availableAgentLabels, bridgeSourceFreshness, bridgeSourceFreshnessLines, clearAttestationCache, closeDb, commandShape, compactQueueJobLines, conflictPathsFromConflict, conflictsWithActiveLock, contractorAuthorizationToken, decryptIntegrationJournalBytes, describeConcurrencyLimits, diagnoseJobView, dirtyCheckpointDetails, effectiveContractorAuthorizationSha256, effectiveQueueMode, effectiveQueueWriteConflictPolicy, effectiveReadOnlyMetadataError, encryptIntegrationJournalBytes, enqueueQueueJob, executeOpenCodeJob, formatAgentLockList, formatLockExpiry, formatRejectedExecution, hardLockPathsForPlan, integrationJournalDiagnosis, jobAgentRuntime, jobInputShape, listAvailableAgents, listLocks, listPersistedPipelineRecords, listPersistedQueueRecords, listRetainedWorktreeArtifacts, makeQueueJobId, managedSkillSourceEvidence, normalizeJobCwd, nowMs, openLockDb, parallelBatchCapacityError, parallelProviderKeys, pipelineOwnedByThisInstance, providerCapacitySnapshot, queueAgentActivity, queueCapacityReport, queueMemoryGate, queueMemoryStatusLines, queueMemoryWaitingJobs, queueOnlyOptionsError, queueRecordSnapshot, readAgentDebugMetadata, readOnlyRoutingPolicyError, recordMatchesProject, refreshRuntimeConcurrency, releaseHardLock, reservedLockAgentError, resolveProjectStateRoot, retainedWorktreeView, runCommand, safeOpenCodeCommand, sanitizedAgentMetadataError, sanitizedDiscoveryContext, sanitizedRoutingPolicyError, sanitizedWorkspaceSchema, server, summarizeStderr, timeoutForAgent, userAuthorizedOrchestrator, validateParallelWritePlan, validateSingleLockPlan, validationCommandPreflightError, verifyExternalPluginPolicy, verifyJobWorkspaceReadiness, verifySanitizedJobsBeforeDiscovery, verifySanitizedWorkspace, externalRunnerStatusLines = () => [] }) {
function directRunAuditStore() {
  return createDirectRunAudit({
    openDb: openLockDb,
    closeDb,
    resolveProjectRoot: resolveProjectStateRoot,
    redact: redactSensitiveText,
    retentionDays: CONFIG.auditRetentionDays,
    instanceId: BRIDGE_INSTANCE_ID,
    processId: process.pid,
    // L-025: a run's result text is kept like a queue job's, encrypted with the queue's key and
    // bound to the run id, and capped by the same setting.
    sealText: (text, runId) => encryptIntegrationJournalBytes(Buffer.from(text, "utf8"), `direct-run-result\0${runId}`),
    openText: async (sealed, runId) => (await decryptIntegrationJournalBytes(sealed, `direct-run-result\0${runId}`)).toString("utf8"),
    maxResultChars: CONFIG.queueResultMaxChars,
  });
}

















function abortSignalErrorType(signal, fallback = "agent_cancelled") {
  return signal?.aborted && typeof signal.reason?.errorType === "string"
    ? signal.reason.errorType
    : fallback;
}

function combineAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}



function validateDelegationPlanInputs(jobs) {
  if (!Array.isArray(jobs) || jobs.length < 1) {
    return {
      error: "At least one delegation job is required.",
      lockPlans: [],
      conflictingPaths: [],
      executionMode: "none",
    };
  }

  if (jobs.length === 1) {
    const { error, errorType, suggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(jobs[0]);
    return {
      error,
      errorType,
      suggestedFix,
      lockPlans: [lockPlan],
      conflictingPaths: [],
      serialOnlyMatches,
      executionMode: "single",
    };
  }

  const { error, errorType, suggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
  return {
    error,
    errorType,
    suggestedFix,
    lockPlans,
    conflictingPaths,
    serialOnlyMatches,
    executionMode: "parallel",
  };
}

async function findActiveLockConflict(lockPlans) {
  for (const plan of lockPlans) {
    if (plan.lockType === "read") {
      continue;
    }

    const active = await listLocks(plan.cwd);
    const conflict = active
      .map((lock) =>
        conflictsWithActiveLock(
          {
            lockType: plan.lockType,
            paths: hardLockPathsForPlan(plan),
          },
          lock
        )
      )
      .find(Boolean);

    if (conflict) {
      return { plan, conflict };
    }
  }

  return null;
}

function formatDelegationPlanJob({ index, job, lockPlan, resolution }) {
  const timeoutMs = timeoutForAgent(resolution?.actualAgent || lockPlan.agent, lockPlan, lockPlan.timeoutMs);
  const modelOverride = allowlistedModelOverride(lockPlan.scopeContract?.modelRequirement, resolution?.actualAgent || lockPlan.agent);
  const effectiveMetadata = applyModelOverrideToMetadata(resolution?.agentMetadata || null, modelOverride);
  return [
    `JOB ${index + 1}`,
    `Requested agent: ${resolution?.requestedAgent || lockPlan.agent}`,
    `Requested agent mode: ${resolution?.requestedAgentMode || "unknown"}`,
    ...(lockPlan.scopeContract?.modelRequirement ? [
      `Required provider: ${lockPlan.scopeContract.modelRequirement.provider}`,
      `Required model: ${lockPlan.scopeContract.modelRequirement.model}`,
      `Required variant: ${lockPlan.scopeContract.modelRequirement.variant || "not specified"}`,
      `Runtime model evidence required: ${lockPlan.scopeContract.modelRequirement.requireRuntimeEvidence ? "yes" : "no"}`,
    ] : []),
    `Actual agent: ${resolution?.actualAgent || "none"}`,
    `Actual agent mode: ${resolution?.actualAgentMode || resolution?.requestedAgentMode || "unknown"}`,
    `Fallback used: ${resolution?.fallbackUsed ? "yes" : "no"}`,
    resolution?.fallbackReason ? `Fallback reason: ${resolution.fallbackReason}` : null,
    `Subagent proxy used: ${resolution?.proxyUsed ? "yes" : "no"}`,
    `Subagent strategy: ${resolution?.subagentStrategy || job.subagentStrategy || "reject"}`,
    resolution?.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Configured provider: ${resolution?.agentMetadata?.provider || "unknown"}`,
    `Configured model: ${resolution?.agentMetadata?.model || "unknown"}`,
    `Configured variant: ${resolution?.agentMetadata?.variant || "unknown"}`,
    `Model selection: ${modelOverride ? `operator_allowlist_override (${modelOverride.provider}/${modelOverride.model}${modelOverride.variant ? `, variant ${modelOverride.variant}` : ""})` : "managed_profile"}`,
    "Silent model fallback: disabled",
    `Effective edit permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canEdit ? "enabled" : "denied") : "unattested"}`,
    `Effective task permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canDelegate ? "enabled" : "denied") : "unattested"}`,
    `Effective external-directory permission denied: ${resolution?.agentMetadata?.externalDirectoryDenied ? "yes" : "no/unattested"}`,
    `Would run: ${resolution?.actualAgent ? commandShape(resolution.actualAgent, effectiveMetadata) : "no"}`,
    "Would acquire consistency lock: yes (shared for reads, exclusive for writes/integration)",
    `Lock mode: ${lockPlan.lockMode}${lockPlan.requestedLockMode ? ` (requested ${lockPlan.requestedLockMode}; parallel writers always use ${lockPlan.lockMode})` : ""}`,
    `Lock type: ${lockPlan.lockType}`,
    lockPlan.orchestratorMode ? `Orchestrator mode: ${lockPlan.orchestratorMode}` : null,
    lockPlan.orchestratorMode === "contractor" ? `User-authorized contractor: ${lockPlan.userAuthorizedOrchestrator ? "yes" : "no"}` : null,
    `Timeout ms: ${timeoutMs}`,
    `Lock granted: ${lockPlan.lockedPaths.length ? lockPlan.lockedPaths.join(", ") : "not specified"}`,
    `Allowed edits: ${lockPlan.allowedEdits.length ? lockPlan.allowedEdits.join(", ") : "none"}`,
    `Forbidden edits: ${lockPlan.forbiddenEdits.length ? lockPlan.forbiddenEdits.join(", ") : "none specified"}`,
    `Shared files frozen: ${lockPlan.sharedFiles.length ? lockPlan.sharedFiles.join(", ") : "none specified"}`,
    `Validation command: ${lockPlan.validationCommand || "not specified"}`,
  ].filter(Boolean).join("\n");
}

server.tool(
  "acquire_agent_lock",
  "Acquire a temporary file/path lock for exceptional delegated-agent coordination.",
  {
    owner: z.string().optional().describe("Lock owner, usually Codex."),
    agent: z.string().optional().describe("Agent receiving the lock."),
    task: z.string().optional().describe("Short task description."),
    cwd: z.string().min(1).describe("Canonical repository path."),
    lockType: z.enum(["read", "write", "serial_integration"]).optional(),
    paths: z.array(z.string()).min(1).describe("Concrete files or directories to lock."),
    ttlMs: z.number().int().positive().max(MAX_LOCK_TTL_MS).optional().describe("Lease duration in milliseconds. Defaults to 30 minutes; at most 24 hours."),
  },
  async ({ owner = "codex", agent = "opencode", task = "", cwd = "", lockType = "write", paths, ttlMs = DEFAULT_LOCK_TTL_MS }) => {
    const reservedAgentError = reservedLockAgentError(agent) || reservedLockAgentError(owner);
    const result = reservedAgentError
      ? { ok: false, error: reservedAgentError }
      : await acquireHardLock({ owner, agent, origin: "manual", task, cwd, lockType, paths, ttlMs });
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                "Temporary lock acquired.",
                "",
                `Lock id: ${result.lock.id}`,
                `Release token: ${result.lock.token}`,
                `Owner: ${result.lock.owner}`,
                `Agent: ${result.lock.agent}`,
                `Type: ${result.lock.lockType}`,
                `Paths: ${result.lock.paths.join(", ")}`,
                `Expires at: ${formatLockExpiry(result.lock.expiresAt)}`,
              ].join("\n")
            : [
                "Temporary lock rejected.",
                "",
                result.error,
                result.conflict ? `Conflict: ${JSON.stringify(result.conflict, null, 2)}` : "",
              ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "release_agent_lock",
  "Release a temporary agent lock by id.",
  {
    lockId: z.string().describe("Lock id returned by acquire_agent_lock or an OpenCode run result."),
    token: z.string().optional().describe("Release token returned by acquire_agent_lock."),
    cwd: z.string().min(1).describe("Canonical repository path for the lock registry."),
  },
  async ({ lockId, token = "", cwd = "" }) => {
    const result = await releaseHardLock(lockId, token, [], cwd);
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                result.released ? "Temporary lock released." : "No active temporary lock matched that id.",
                "",
                `Lock id: ${lockId}`,
                `Active locks remaining: ${result.activeLocks.length}`,
              ].join("\n")
            : ["Temporary lock release failed.", "", result.error].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_agent_locks",
  "List active temporary agent locks.",
  {
    cwd: z.string().min(1).describe("Canonical repository path for the lock registry."),
  },
  async ({ cwd = "" }) => {
    const locks = await listLocks(cwd);

    return {
      content: [
        {
          type: "text",
          text: formatAgentLockList(locks),
        },
      ],
    };
  }
);

server.tool(
  "verify_sanitized_workspace",
  "Verify an exact, hash-pinned sanitized workspace before or after an agent wave. This is file-level integrity, not row-level filtering or an OS sandbox.",
  {
    contract: sanitizedWorkspaceSchema,
    phase: z.enum(["manual", "before_wave", "after_wave"]).optional(),
  },
  async ({ contract, phase = "manual" }) => {
    const result = await verifySanitizedWorkspace(contract, phase);
    return {
      content: [{
        type: "text",
        text: [
          result.ok ? "Sanitized workspace verification passed." : "Sanitized workspace verification failed.",
          JSON.stringify(sanitizePersistedValue(result), null, 2),
          "Boundary note: exact file manifests do not enforce row/column filtering, archive contents, database queries, network isolation, or reads elsewhere on the host.",
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "list_opencode_agents",
  "List available OpenCode agents and subagents.",
  {
    cwd: z.string().min(1),
  },
  async ({ cwd }) => {
    const discovery = await listAvailableAgents(cwd);
    const agents = [...discovery.agents.entries()].map(([name, mode]) => ({ name, mode })).sort((left, right) => left.name.localeCompare(right.name));

    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode agents:",
            "",
            discovery.result.exitCode === 0
              ? JSON.stringify(agents, null, 2)
              : `Agent discovery failed: ${summarizeStderr(discovery.result.stderr)}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_opencode_bridge_status",
  "Check OpenCode, Git, agent discovery, and the bridge's effective safety configuration. Quick mode is the daily default; deep mode re-attests every managed role for activation and audits.",
  {
    cwd: z.string().min(1).describe("Canonical repository path used for command and agent discovery checks."),
    deep: z.boolean().optional().describe("Run slow full managed-role attestation. Defaults to false; actual agent execution always re-attests its role before spawn."),
  },
  async ({ cwd, deep = false }) => {
    if (deep) clearAttestationCache();
    const [pluginPolicy, openCodeVersion, gitVersion, agentDiscovery, safeOrchestratorMetadata, contractorOrchestratorMetadata, contractorNestedAttestation, sanitizedReaderMetadata, managedSkillEvidence, providerCapacity] = await Promise.all([
      verifyExternalPluginPolicy(cwd),
      safeOpenCodeCommand(["--version"], cwd, 1000 * 30),
      runCommand("git", ["--version"], cwd, 1000 * 30),
      listAvailableAgents(cwd),
      deep ? readAgentDebugMetadata(MCP_ORCHESTRATOR_AGENT, cwd || process.cwd()) : Promise.resolve(null),
      deep ? readAgentDebugMetadata(MCP_CONTRACTOR_ORCHESTRATOR_AGENT, cwd || process.cwd()) : Promise.resolve(null),
      deep ? attestContractorNestedAgents(cwd || process.cwd()) : Promise.resolve({ ok: true, skipped: true }),
      deep ? readAgentDebugMetadata(MCP_SANITIZED_READER_AGENT, cwd || process.cwd(), { forcePure: true }) : Promise.resolve(null),
      managedSkillSourceEvidence(),
      providerCapacitySnapshot(),
    ]);
    const sourceFreshness = await bridgeSourceFreshness();
    const queueCapacity = queueCapacityReport();
    const journal = await resolveProjectStateRoot(cwd || process.cwd())
      .then((root) => integrationJournalDiagnosis(root, { limit: 20 }))
      .catch((error) => ({ error: error?.message || String(error) }));
    if (!pluginPolicy.ok) {
      return { content: [{ type: "text", text: `OpenCode MCP bridge status: attention required.\n\nPlugin policy: rejected\nReason: ${pluginPolicy.error}` }] };
    }
    const availableAgents = availableAgentLabels(agentDiscovery.agents);
    const missingRequiredAgents = GLOBALLY_REQUIRED_MANAGED_AGENTS.filter((agent) => !agentDiscovery.agents.has(agent));
    const sanitizedReaderPolicyError = sanitizedAgentMetadataError(sanitizedReaderMetadata, path.resolve(cwd || process.cwd()));
    const safeOrchestratorPolicy = safeOrchestratorMetadata?.metadata || null;
    const safeOrchestratorEnforced = safeOrchestratorMetadata?.ok
      && safeOrchestratorPolicy?.name === MCP_ORCHESTRATOR_AGENT
      && safeOrchestratorPolicy?.canEdit === false
      && safeOrchestratorPolicy?.canDelegate === false;
    const contractorOrchestratorPolicy = contractorOrchestratorMetadata?.metadata || null;
    const contractorOrchestratorEnforced = contractorOrchestratorMetadata?.ok
      && contractorOrchestratorPolicy?.name === MCP_CONTRACTOR_ORCHESTRATOR_AGENT
      && contractorOrchestratorPolicy?.canEdit === false
      && contractorOrchestratorPolicy?.canDelegate === true
      && contractorOrchestratorPolicy?.bashDenied === true
      && contractorOrchestratorPolicy?.skillDenied === true;
    const contractorSubagentAllowlistEnforced = contractorOrchestratorPolicy?.taskDelegationAllowlistSafe === true;
    const baseHealthy = openCodeVersion.exitCode === 0
      && gitVersion.exitCode === 0
      && agentDiscovery.result.exitCode === 0
      && missingRequiredAgents.length === 0
      && managedSkillEvidence.ok
      && !sourceFreshness.stale;
    const deepHealthy = safeOrchestratorEnforced
      && contractorOrchestratorEnforced
      && contractorSubagentAllowlistEnforced
      && contractorNestedAttestation.ok
      && !sanitizedReaderPolicyError;
    const healthy = baseHealthy && (!deep || deepHealthy);

    return {
      content: [
        {
          type: "text",
          text: [
            healthy ? "OpenCode MCP bridge status: healthy." : "OpenCode MCP bridge status: attention required.",
            "",
            `OpenCode executable: ${OPENCODE_EXE}`,
            `OpenCode version: ${(openCodeVersion.stdout || openCodeVersion.stderr || "unavailable").trim()}`,
            `Bridge source SHA-256 at startup: ${BRIDGE_SOURCE_SHA256}`,
            `Bridge process started: ${BRIDGE_PROCESS_STARTED_AT}`,
            ...bridgeSourceFreshnessLines(sourceFreshness),
            `Bridge release root: ${BRIDGE_RUNTIME_DIR}`,
            `Bridge release manifest pin: ${String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "not pinned")}`,
            `Health depth: ${deep ? "deep managed-role attestation" : "quick daily check"}`,
            `Execution-time role attestation: always enabled`,
            `Node runtime: ${process.version}`,
            "Provider readiness: not tested by health (no model request sent)",
            "Project OpenCode config: disabled; use a reviewed managed profile, not the personal/project default",
            `Runtime model evidence required by operator: ${CONFIG.requireRuntimeModelEvidence ? "yes" : "no"}`,
            ...(CONFIG.requireRuntimeModelEvidence ? [
              "Warning: OpenCode 1.17.13 emits no runtime provider/model identity in `run --format json`, so every non-dry agent run will end with opencode_model_evidence_required while CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=true. Set it to false and use per-job modelRequirement.requireRuntimeEvidence when exact identity matters more than completing the run.",
            ] : []),
            `Source dirt policy: ${CONFIG.sourceDirtPolicy}`,
            `Model allowlist: ${CONFIG.modelOverrideAllowlist.length ? CONFIG.modelOverrideAllowlist.join(", ") : "none (managed profiles only)"}`,
            // Q-012: nothing is printed while no external runner, per-provider limit or quota group is set.
            ...externalRunnerStatusLines(),
            `OpenCode check exit code: ${openCodeVersion.exitCode}`,
            `Git version: ${(gitVersion.stdout || gitVersion.stderr || "unavailable").trim()}`,
            `Git check exit code: ${gitVersion.exitCode}`,
            `Agent directory: ${OPENCODE_AGENT_DIR}`,
            `Managed skill source directory: ${OPENCODE_SKILL_DIR}`,
            `Managed skill source file count: ${managedSkillEvidence.fileCount}`,
            `Managed skill source names: ${managedSkillEvidence.names.length ? managedSkillEvidence.names.join(", ") : "none"}`,
            `Managed skill source aggregate SHA-256: ${managedSkillEvidence.sha256 || "unavailable"}`,
            `Managed skill source error: ${managedSkillEvidence.error || "none"}`,
            `MCP orchestrator execution agent: ${MCP_ORCHESTRATOR_AGENT}`,
            `MCP orchestrator edit permission denied: ${deep ? (safeOrchestratorPolicy?.canEdit === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP orchestrator nested task permission denied: ${deep ? (safeOrchestratorPolicy?.canDelegate === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor orchestrator execution agent: ${MCP_CONTRACTOR_ORCHESTRATOR_AGENT}`,
            `MCP contractor direct edit permission denied: ${deep ? (contractorOrchestratorPolicy?.canEdit === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested task permission enabled: ${deep ? (contractorOrchestratorPolicy?.canDelegate === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor shell permission denied: ${deep ? (contractorOrchestratorPolicy?.bashDenied === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor skill permission denied: ${deep ? (contractorOrchestratorPolicy?.skillDenied === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor subagent allowlist enforced: ${deep ? (contractorSubagentAllowlistEnforced ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested agent profiles attested: ${deep ? (contractorNestedAttestation.ok ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested agent policy error: ${deep && !contractorNestedAttestation.ok ? contractorNestedAttestation.error : "none"}`,
            `MCP sanitized reader isolated policy attested: ${deep ? (sanitizedReaderPolicyError ? "no" : "yes") : "not checked in quick mode"}`,
            `MCP sanitized reader policy error: ${deep ? (sanitizedReaderPolicyError?.error || "none") : "none"}`,
            `Agent discovery exit code: ${agentDiscovery.result.exitCode}`,
            `Available agents: ${availableAgents.length ? availableAgents.join(", ") : "none discovered"}`,
            `Missing required managed agents: ${missingRequiredAgents.length ? missingRequiredAgents.join(", ") : "none"}`,
            integrationQuarantineStatusLine(journal),
            "",
            `Worktree mode: ${CONFIG.worktreeMode}`,
            `Worktree root: ${CONFIG.worktreeRoot}`,
            `Worktree cleanup: ${CONFIG.worktreeCleanup}`,
            `Queue mode: ${effectiveQueueMode()}`,
            `Queue write conflict policy: ${effectiveQueueWriteConflictPolicy()}`,
            `Queue blocked poll ms: ${CONFIG.queueBlockedPollMs}`,
            `Queue stale after ms: ${CONFIG.queueStaleAfterMs}`,
            `Deferred recovery idle max ms: ${CONFIG.deferredRecoveryIdleMaxMs}`,
            `Read lock mode: ${CONFIG.defaultReadLockMode}`,
            `Write lock mode: ${CONFIG.defaultWriteLockMode}`,
            `Parallel write lock mode: ${CONFIG.defaultParallelWriteLockMode}`,
            `Contractor orchestrator timeout ms: ${CONFIG.contractorOrchestratorTimeoutMs}`,
            `Bridge state directory: ${GLOBAL_BRIDGE_STATE_DIR}`,
            `OpenCode external plugins: ${CONFIG.allowExternalPlugins ? "enabled (exact allowlist and pinned tree verified)" : "disabled (--pure)"}`,
            `External plugin manifest SHA-256: ${pluginPolicy.manifestSha256 || "not applicable"}`,
            `Provider/account concurrency limit: ${describeConcurrencyLimits().provider}${CONFIG.providerConcurrencyKeyExplicit ? "" : " per configured provider"}`,
            // Q-014b: runtime (set_opencode_concurrency providerLimits) and env (CODEX_OPENCODE_PROVIDER_LIMITS).
            ...(describeConcurrencyLimits().perProvider ? [`Per-provider slot limits: ${describeConcurrencyLimits().perProvider}`] : []),
            `Queue parallel limit (CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT): ${queueCapacity.queueParallelLimit} job(s) at once per bridge process${queueCapacity.queueMode === "off" ? " (queue mode is off)" : ""}; ${describeConcurrencyLimits().queue}`,
            `Parallel call job limit (CODEX_OPENCODE_PARALLEL_LIMIT): ${queueCapacity.parallelCallLimit} job(s) per run_opencode_parallel call (does not bound the queue)`,
            ...(queueCapacity.warning ? [queueCapacity.warning] : []),
            ...queueMemoryStatusLines(),
            agentIdleTimeoutStatusLine(),
            `Global worker limit (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT, all providers and bridge processes): ${describeConcurrencyLimits().global}; workers running now: ${Number(providerCapacity.allLeaseCount || 0)}`,
            `Provider active leases: ${providerCapacity.leases.length}`,
            // Slots are counted per provider key; one total against one limit read as over capacity.
            ...(providerCapacity.keys || []).map((item) => `- ${item.providerKey}: ${item.leases} of ${item.capacity} slot(s) held${item.quarantined ? ` (${item.quarantined} quarantined for an unconfirmed process tree)` : ""}`),
            ...providerCapacity.leases.map((lease) => `- provider lease ${lease.leaseId} (${lease.providerKey}): pid=${lease.ownerProcessId}, ${lease.quarantined ? "quarantined" : `remainingMs=${lease.remainingMs}`}, heartbeat=${lease.heartbeatAt || "none"}`),
            `Paused providers: ${(providerCapacity.cooldowns || []).length ? "" : "none"}`,
            ...(providerCapacity.cooldowns || []).map((item) => `- ${item.providerKey}: paused until ${item.until} (${item.errorType}${item.reason ? `: ${item.reason}` : ""}); new jobs fail at once instead of starting; resume_opencode_provider ends it early`),
            `Bridge instance id: ${BRIDGE_INSTANCE_ID}`,
            "Default OpenCode orchestrator mode: planning-only",
            `Explicit user-authorized OpenCode contractor mode: ${/^[a-f0-9]{64}$/.test(effectiveContractorAuthorizationSha256()) ? "capability configured" : "disabled (capability not configured)"}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "diagnose_opencode_bridge",
  "Show correlated queue, pipeline, lock, provider-capacity, preservation, retry-safety, and recovery information for one repository.",
  {
    cwd: z.string().describe("Repository path to diagnose."),
  },
  async ({ cwd }) => {
    const projectRoot = await resolveProjectStateRoot(cwd);
    const [jobs, pipelines, locks, provider, directRunAudit, integrationOperations, retainedArtifacts] = await Promise.all([
      listPersistedQueueRecords(projectRoot),
      listPersistedPipelineRecords(projectRoot),
      listLocks(projectRoot),
      providerCapacitySnapshot(),
      directRunAuditStore().snapshot(projectRoot),
      // Queue records blocked on integration_recovery_pending point here; show the journal.
      integrationJournalDiagnosis(projectRoot, { limit: 20 }).catch((error) => ({ error: error?.message || String(error) })),
      listRetainedWorktreeArtifacts(projectRoot).catch((error) => ({ error: error?.message || String(error) })),
    ]);
    const queueJobByWorktree = new Map(jobs.filter((job) => job.worktreePath).map((job) => [path.resolve(job.worktreePath), job]));
    const runByJobId = new Map(directRunAudit.records.filter((run) => run.jobId || run.runId).map((run) => [run.jobId || run.runId, run]));
    const retainedWorktrees = Array.isArray(retainedArtifacts)
      ? retainedArtifacts.map((artifact) => retainedWorktreeView(artifact, {
        queueJob: queueJobByWorktree.get(path.resolve(artifact.worktreePath)) || null,
        run: runByJobId.get(artifact.jobId) || null,
      }))
      : retainedArtifacts;
    const nonterminal = jobs.filter((job) => !["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    const failed = jobs.filter((job) => ["failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    // The report goes into the caller's context. After a long run it listed every audit row
    // and job (up to thousands); summary counts stay complete, detail keeps every unfinished
    // item plus the most recent ones.
    const DIAGNOSE_DETAIL_LIMIT = 25;
    const newestFirst = (list, key) => [...list].sort((left, right) => String(right[key] || "").localeCompare(String(left[key] || "")));
    const unfinishedJobs = new Set(nonterminal.map((job) => job.jobId));
    const detailJobs = [...nonterminal, ...newestFirst(jobs.filter((job) => !unfinishedJobs.has(job.jobId)), "createdAt").slice(0, DIAGNOSE_DETAIL_LIMIT)];
    const detailDirectRuns = [
      ...directRunAudit.records.filter((run) => run.status === "started"),
      ...newestFirst(directRunAudit.records.filter((run) => run.status !== "started"), "startedAt").slice(0, DIAGNOSE_DETAIL_LIMIT),
    ];
    // Pipelines follow the same rule (R-138): every unfinished one plus the newest finished ones.
    const pipelineFinished = (pipeline) => ["completed", "failed", "cancelled"].includes(pipeline.status);
    let finishedPipelinesShown = 0;
    const detailPipelines = newestFirst(pipelines, "createdAt")
      .filter((pipeline) => !pipelineFinished(pipeline) || (finishedPipelinesShown += 1) <= DIAGNOSE_DETAIL_LIMIT);
    const queueCapacity = queueCapacityReport();
    const memoryGate = queueMemoryGate();
    const report = {
      generatedAt: new Date().toISOString(),
      cwd: projectRoot,
      bridgeProcess: await bridgeSourceFreshness(),
      summary: {
        jobs: jobs.length,
        nonterminalJobs: nonterminal.length,
        failedJobs: failed.length,
        directRuns: directRunAudit.records.length,
        failedDirectRuns: directRunAudit.records.filter((run) => ["failed", "rejected", "abandoned"].includes(run.status)).length,
        unfinishedDirectRuns: directRunAudit.records.filter((run) => run.status === "started").length,
        pipelines: pipelines.length,
        nonterminalPipelines: pipelines.filter((item) => !pipelineFinished(item)).length,
        locks: locks.length,
        unresolvedIntegrationOperations: integrationOperations.unresolvedCount ?? "unavailable",
        retainedWorktrees: Array.isArray(retainedWorktrees) ? retainedWorktrees.filter((item) => item.present && !item.inFlight).length : "unavailable",
        inFlightWorktrees: Array.isArray(retainedWorktrees) ? retainedWorktrees.filter((item) => item.present && item.inFlight).length : "unavailable",
        providerCapacity: provider.capacity,
        providerSlotsByKey: (provider.keys || []).map((item) => `${item.providerKey}=${item.leases}/${item.capacity}`),
        providerActiveLeases: provider.leases.length,
        // B-042: the queue cap that decides how many of those slots a bridge process can fill.
        queueParallelLimit: queueCapacity.queueParallelLimit,
        parallelCallLimit: queueCapacity.parallelCallLimit,
        providerConcurrencyLimit: queueCapacity.providerConcurrencyLimit,
        ...(queueCapacity.warning ? { queueCapacityWarning: queueCapacity.warning } : {}),
        // B-045: the free-memory floor for starting queue jobs (0 = disabled) and what the machine has now.
        minFreeMemoryMb: memoryGate.floorMb,
        freeMemoryMb: memoryGate.freeMb,
        queueJobsHeldForMemory: memoryGate.blocked ? queueMemoryWaitingJobs.size : 0,
      },
      directRuns: detailDirectRuns,
      diagnosticCoverage: {
        jobs: "queued_jobs_only",
        directRuns: directRunAudit.coverage,
        retainedWorktrees: "every bridge-created worktree still registered (queued, direct and parallel jobs); owner says which",
        detail: `every unfinished item plus the ${DIAGNOSE_DETAIL_LIMIT} most recent finished jobs, direct runs and pipelines; counts in summary cover all`,
      },
      jobs: detailJobs.map((job) => diagnoseJobView(job)),
      retainedWorktrees,
      pipelines: detailPipelines.map((pipeline) => ({
        pipelineId: pipeline.pipelineId,
        status: pipeline.status,
        ownerInstanceId: pipeline.ownerInstanceId || "",
        ownerLeaseExpiresAt: pipeline.ownerLeaseExpiresAt || "",
        recoverableByThisInstance: pipelineOwnedByThisInstance(pipeline) || Date.parse(pipeline.ownerLeaseExpiresAt || "") <= Date.now(),
        pendingIntegrations: (pipeline.integrationQueue || []).filter((item) => item.status === "pending").length,
        errors: pipeline.errors || [],
      })),
      locks: locks.map((lock) => ({ ...lock, expires: formatLockExpiry(lock.expiresAt) })),
      integrationOperations,
      provider,
    };
    return { content: [{ type: "text", text: JSON.stringify(sanitizePersistedValue(report), null, 2) }] };
  }
);

server.tool(
  "validate_delegation_plan",
  "Preflight a single or parallel OpenCode delegation plan without running OpenCode agents or acquiring locks.",
  { jobs: z.array(z.object(jobInputShape)).min(1) },
  async ({ jobs }) => {
    jobs = await Promise.all(jobs.map((job) => normalizeJobCwd(job)));
    const toolStarted = nowMs();
    const { error: planError, errorType: planErrorType, suggestedFix: planSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [], executionMode } = validateDelegationPlanInputs(jobs);
    const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "unknown";
    const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";

    if (planError) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: planErrorType || (executionMode === "parallel" ? "parallel_plan_rejected" : "lock_plan_rejected"),
              reason: planError,
              requestedAgent: requestedAgents,
              actualAgent: "none",
              lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths,
              serialOnlyMatches,
              suggestedFix: planSuggestedFix || "Adjust agents, lockMode, lockedPaths, allowedEdits, or split overlapping write work into serial steps.",
            }),
          },
        ],
      };
    }

    const sanitizedPlanPreflight = await verifySanitizedJobsBeforeDiscovery(jobs, "delegation_plan_preflight_before_discovery");
    if (!sanitizedPlanPreflight.ok) {
      const index = sanitizedPlanPreflight.index;
      const verification = sanitizedPlanPreflight.verification;
      return {
        content: [{
          type: "text",
          text: formatRejectedExecution({
            headline: "Delegation plan sanitized-workspace preflight rejected before OpenCode discovery.",
            errorType: verification.errorType,
            reason: verification.error,
            requestedAgent: lockPlans[index]?.agent || jobs[index]?.agent || "unknown",
            actualAgent: "none",
            lockMode: lockPlans[index]?.lockMode || "off",
            durationMs: nowMs() - toolStarted,
            conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Rebuild the exact sanitized workspace from its trusted manifest before retrying the delegation preflight.",
          }),
        }],
      };
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const readiness = await verifyJobWorkspaceReadiness(jobs[index], lockPlans[index]);
      if (!readiness.ok) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Delegation plan workspace preflight rejected before OpenCode discovery.",
          errorType: readiness.errorType,
          reason: readiness.error,
          requestedAgent: lockPlans[index].agent,
          actualAgent: "none",
          lockMode: lockPlans[index].lockMode,
          durationMs: nowMs() - toolStarted,
          ...dirtyCheckpointDetails(readiness),
          suggestedFix: readiness.suggestedFix,
        }) }] };
      }
    }

    const activeConflict = await findActiveLockConflict(lockPlans);
    if (activeConflict) {
      const conflictPaths = conflictPathsFromConflict(activeConflict.conflict);
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: "write_lock_conflict",
              reason: `Write lock conflict on: ${conflictPaths[0] || "unknown"}`,
              requestedAgent: activeConflict.plan.agent,
              actualAgent: "none",
              lockMode: activeConflict.plan.lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths: conflictPaths,
              suggestedFix: "Wait for the active lock to expire, release it if it is stale, or choose a non-overlapping lockedPaths scope.",
            }),
          },
        ],
      };
    }

    const queueAssessment = await assessQueuePlan(lockPlans);
    const plannedJobs = [];
    const plannedResolutions = [];
    const plannedMetadata = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const validationPreflight = await validationCommandPreflightError(lockPlan.validationCommand, { sanitized: Boolean(job.sanitizedWorkspace) });
      if (validationPreflight) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
                errorType: validationPreflight.errorType,
                reason: `JOB ${index + 1} validation command cannot run: ${validationPreflight.error}`,
                requestedAgent: job.agent,
                actualAgent: "none",
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: VALIDATION_PREFLIGHT_FIX,
              }),
            },
          ],
        };
      }
      const discoveryContext = sanitizedDiscoveryContext(job);
      const resolution = await jobAgentRuntime().resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "reject",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT,
        lockPlan.orchestratorMode,
        discoveryContext
      );

      if (resolution.error) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
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
            },
          ],
        };
      }

      const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
      if (routingPolicyError) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
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
        };
      }

      const metadata = await jobAgentRuntime().readAgentDebugMetadata(
        resolution.actualAgent,
        discoveryContext.discoveryCwd,
        { forcePure: discoveryContext.forcePure }
      );
      const metadataPolicyError = effectiveReadOnlyMetadataError(metadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
      const contractorNestedAttestation = lockPlan.orchestratorMode === "contractor"
        ? await attestContractorNestedAgents(discoveryContext.discoveryCwd, { forcePure: discoveryContext.forcePure })
        : { ok: true };
      const contractorNestedError = contractorNestedAttestation.ok ? null : contractorNestedAttestation;
      const sanitizedMetadataError = job.sanitizedWorkspace ? sanitizedAgentMetadataError(metadata, job.sanitizedWorkspace.root) : null;
      const sanitizedRoutingError = sanitizedRoutingPolicyError(job, resolution, discoveryContext.discoveryCwd);
      if (metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError) {
        const policyError = metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError;
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Delegation plan effective agent policy rejected.",
          errorType: policyError.errorType,
          reason: policyError.error,
          requestedAgent: resolution.requestedAgent,
          actualAgent: resolution.actualAgent,
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: "Use a directly runnable role whose effective OpenCode debug policy matches the requested contract.",
        }) }] };
      }
      resolution.agentMetadata = metadata.metadata || null;
      plannedResolutions[index] = resolution;
      plannedMetadata[index] = metadata;

      plannedJobs.push(formatDelegationPlanJob({ index, job, lockPlan, resolution }));
    }

    // run_opencode_parallel rejects a batch above the per-provider slot limit; the preflight
    // must not accept what the run would refuse.
    if (executionMode === "parallel") await refreshRuntimeConcurrency();
    const capacityError = executionMode === "parallel"
      ? parallelBatchCapacityError(jobs, parallelProviderKeys(plannedResolutions, plannedMetadata, lockPlans))
      : null;
    if (capacityError) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Delegation plan rejected.",
        errorType: capacityError.errorType,
        reason: capacityError.error,
        requestedAgent: requestedAgents,
        actualAgent: "none",
        lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: capacityError.suggestedFix,
      }) }] };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "Delegation plan accepted.",
            "",
            `Execution mode: ${executionMode}`,
            `Jobs: ${jobs.length}`,
            `Queue status: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
            `Queue conflicting paths: ${queueAssessment.conflictingPaths.length ? queueAssessment.conflictingPaths.join(", ") : "none"}`,
            "OpenCode agents will not run during this preflight.",
            "Temporary locks were not acquired.",
            "",
            ...plannedJobs,
          ].join("\n\n"),
        },
      ],
    };
  }
);

server.tool(
  "run_opencode_agent",
  "Run one OpenCode agent/subagent with a task prompt.",
  jobInputShape,
  async ({
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "reject",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    orchestratorMode,
    userAuthorizedOrchestrator,
    contractorAuthorizationToken,
    role,
    mode,
    scope,
    actions,
    validation: scopeValidation,
    timeoutPolicy,
    scopeContract,
    sanitizedWorkspace,
    dryRun = false,
    write,
    lockType,
    lockMode,
    timeoutMs,
    lockedPaths,
    ownedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    validationCommand,
    validationFixPasses,
    selfCheckPasses,
    delegation,
    models,
    maxAttempts,
    autoIntegrate,
  }) => {
    const toolStarted = nowMs();
    const queueOnly = queueOnlyOptionsError({ models, maxAttempts, autoIntegrate });
    if (queueOnly) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Execution rejected.",
        errorType: queueOnly.errorType,
        reason: queueOnly.error,
        requestedAgent: agent,
        actualAgent: "none",
        suggestedFix: queueOnly.suggestedFix,
      }) }] };
    }
    const requestedJob = {
      agent,
      task,
      cwd,
      // executeOpenCodeJob routes with these; dropping them made its own advice to set
      // allowFallbackToBuild impossible to follow.
      allowFallbackToBuild,
      subagentStrategy,
      proxyAgent,
      dryRun,
      orchestratorMode,
      userAuthorizedOrchestrator,
      contractorAuthorizationToken,
      role,
      mode,
      scope,
      actions,
      validation: scopeValidation,
      timeoutPolicy,
      scopeContract,
      sanitizedWorkspace,
      write,
      lockMode,
      lockType,
      timeoutMs,
      lockedPaths,
      ownedPaths,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      validationFixPasses,
      selfCheckPasses,
      delegation,
    };
    const directRunId = makeQueueJobId(agent);
    return directRunAuditStore().run(requestedJob, async ({ onChildSpawn }) =>
      executeOpenCodeJob(await normalizeJobCwd(requestedJob), { toolStarted, onChildSpawn, jobId: directRunId })
    , { runId: directRunId, kind: "direct", jobId: directRunId });
  }
);

server.tool(
  "enqueue_opencode_job",
  "Enqueue one OpenCode job for MCP-managed scheduling. Uses the same validation as run_opencode_agent.",
  {
    parentJobId: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional().describe("Stable caller key; repeating it returns the original job instead of duplicating work."),
    ...jobInputShape,
  },
  async ({ parentJobId = "", ...job }) => {
    const started = nowMs();
    const enqueued = await enqueueQueueJob(job, parentJobId);
    if (!enqueued.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Queue job rejected.",
              errorType: enqueued.errorType || "queue_rejected",
              reason: enqueued.error,
              requestedAgent: job.agent,
              actualAgent: "none",
              lockMode: enqueued.lockPlan?.lockMode || job.lockMode || "unknown",
              durationMs: nowMs() - started,
              serialOnlyMatches: enqueued.serialOnlyMatches || [],
              suggestedFix: enqueued.suggestedFix || "Fix the job contract and enqueue again.",
            }),
          },
        ],
      };
    }

    // The read scope keeps a reader from counting as the whole repository, and the job id keeps
    // a writer the scheduler already claimed from conflicting with itself.
    const queueAssessment = await assessQueuePlan([{
      jobId: enqueued.record.jobId,
      lockType: enqueued.record.mode === "read" ? "read" : "write",
      cwd: enqueued.record.cwd,
      lockedPaths: enqueued.record.lockedPaths,
      allowedEdits: enqueued.record.allowedEdits,
      scopeContract: enqueued.record.scopeContract,
    }]);
    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode job enqueued.",
            `Job ID: ${enqueued.record.jobId}`,
            `Deduplicated: ${enqueued.deduplicated ? "yes" : "no"}`,
            `Status: ${enqueued.record.status}`,
            `Agent: ${enqueued.record.agent}`,
            `Mode: ${enqueued.record.mode}`,
            `Lock mode: ${enqueued.record.lockMode}`,
            `Locked paths: ${enqueued.record.lockedPaths.length ? enqueued.record.lockedPaths.join(", ") : "none"}`,
            `Allowed edits: ${enqueued.record.allowedEdits.length ? enqueued.record.allowedEdits.join(", ") : "none"}`,
            `Queue mode: ${effectiveQueueMode()}`,
            `Queue assessment: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_opencode_jobs",
  "List queued OpenCode jobs and their current state.",
  {
    cwd: z.string().min(1).describe("Canonical repository path for project-scoped job listing."),
    status: z.enum(["pending", "planned", "blocked", "running", "validating", "reviewing", "testing", "completed", "failed", "cancelled", "interrupted", "not_resumable"]).optional(),
    detail: z.boolean().optional().describe("Full job records (scope contracts, hashes, lease and containment fields). Default: one compact line per job."),
    limit: z.number().int().positive().max(500).optional().describe("Newest jobs to show; default 20."),
  },
  async ({ cwd = "", status = "", detail = false, limit = 20 }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const records = (effectiveQueueMode() === "sqlite"
      ? await listPersistedQueueRecords(projectRoot || cwd, status)
      : [...QUEUE_JOBS.values()]
        .filter((record) => recordMatchesProject(record, projectRoot))
        .map((record) => queueRecordSnapshot(record, false))
        .filter((record) => !status || record.status === status)
    ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const shown = records.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: [
            `Queue mode: ${effectiveQueueMode()}`,
            `Jobs: ${records.length}${shown.length < records.length ? ` (showing the newest ${shown.length})` : ""}`,
            detail ? JSON.stringify(shown.map((record) => ({ ...record, ...queueAgentActivity(record) })), null, 2) : compactQueueJobLines(shown),
          ].join("\n"),
        },
      ],
    };
  }
);
  return { directRunAuditStore, abortSignalErrorType, combineAbortSignals, validateDelegationPlanInputs, findActiveLockConflict, formatDelegationPlanJob };
}
