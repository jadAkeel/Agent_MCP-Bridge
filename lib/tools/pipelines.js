// MCP tools: multi-agent pipelines (create, run, get, abandon, finalize, list) and quarantine resolution.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { normalizeFilesystemCase } from "../paths.js";
import { pipelineRecordSnapshot } from "../pipelines.js";
import { MAX_AGENT_TIMEOUT_MS, scopeContractSchema, scopePathSetSchema, scopeValidationSchema } from "../scope-contract.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerPipelineTools({ INTEGRATION_QUARANTINE_RESOLUTION_MODES, OPERATOR_CLI_ENV, PIPELINE_RUNS, VALIDATION_PREFLIGHT_FIX, activatePipelineBatch, authoritativePipelineRecord, claimPersistedPipeline, createPipelinePlan, effectiveQueueMode, enqueueQueueJob, finalizePipelineRecord, formatIntegrationQuarantineResolution, formatRejectedExecution, listPersistedPipelineRecords, loadProjectAgentPolicy, normalizeJobCwd, persistPipelineRecord, pipelineOwnedByThisInstance, pipelineOwnerRejection, readPersistedPipelineChildren, recordMatchesProject, refreshPipelineRecord, resolveIntegrationQuarantine, resolveProjectStateRoot, sanitizedWorkspaceSchema, scheduleQueue, server, updatePipelineRecord, validationCommandPreflightError, verifySanitizedWorkspace }) {
server.tool(
  "create_multi_agent_pipeline",
  "Create a multi-agent execution pipeline with ownership, worktree, integration, and final-validation policy checks.",
  {
    name: z.string().optional(),
    cwd: z.string().min(1),
    usePolicy: z.boolean().optional().describe("Load and apply .mcp/agent-policy.json by default."),
    policyPath: z.string().optional().describe("Repo-relative policy path. Defaults to .mcp/agent-policy.json."),
    trustedPolicySha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Deprecated diagnostic echo only. Policy trust is anchored exclusively in CODEX_OPENCODE_TRUSTED_POLICY_SHA256."),
    sanitizedWorkspace: sanitizedWorkspaceSchema.optional().describe("Optional exact workspace contract for read-only pipeline waves."),
    requiresWorktrees: z.boolean().optional().describe("Require isolated worktrees for write jobs. Defaults to true."),
    finalValidationCommand: z.string().optional().describe("Coordinator-level validation command required for write pipelines."),
    reviewerJob: z.object({ agent: z.string(), task: z.string() }).optional(),
    testerJob: z.object({ agent: z.string(), task: z.string() }).optional(),
    jobs: z.array(
      z.object({
        agent: z.string(),
        owner: z.string().optional().describe("Optional policy owner label. Defaults to role or agent."),
        role: z.string().optional(),
        task: z.string(),
        cwd: z.string().optional(),
        write: z.boolean().optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        lockedPaths: z.array(z.string()).optional(),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        sanitizedWorkspace: sanitizedWorkspaceSchema.optional(),
        timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
        scope: scopePathSetSchema.optional(),
        validation: scopeValidationSchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        allowFallbackToBuild: z.boolean().optional(),
        // "direct" is not offered: a subagent run as `--agent <subagent>` falls back to the default
        // agent, which the bridge cannot attest as the requested role (see resolveAgent).
        subagentStrategy: z.enum(["proxy", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        dryRun: z.boolean().optional(),
        delegation: z.any().optional(),
      })
    ).min(1),
  },
  async ({
    name = "multi-agent-pipeline",
    cwd = "",
    usePolicy = true,
    policyPath = ".mcp/agent-policy.json",
    sanitizedWorkspace = null,
    jobs,
    requiresWorktrees = true,
    finalValidationCommand = "",
    reviewerJob = null,
    testerJob = null,
  }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline rejected.",
        errorType: "pipeline_requires_sqlite_queue",
        reason: "Durable pipelines require one SQLite transaction for their pipeline row, child manifest, encrypted requests, and queue release.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server. Memory mode remains available for standalone queue jobs only.",
      }) }] };
    }
    if (sanitizedWorkspace && (usePolicy || String(finalValidationCommand || "").trim() || jobs.some((job) => String(job.validationCommand || job.scopeContract?.validationCommand || job.delegation?.validationCommand || "").trim()))) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Sanitized multi-agent pipeline rejected.",
        errorType: "sanitized_workspace_command_forbidden",
        reason: "Sanitized pipelines may not load project policy or execute repository validation commands. Their trust boundary is the exact manifest verification before and after every wave.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        suggestedFix: "Set usePolicy=false, remove validation commands, and perform any domain validation in a separate externally trusted environment.",
      }) }] };
    }
    const targetCwd = sanitizedWorkspace
      ? path.resolve(sanitizedWorkspace.root)
      : await resolveProjectStateRoot(cwd || jobs[0]?.cwd || process.cwd());
    // A job without its own cwd belongs to the pipeline's repository, not to the bridge's
    // working directory (which made every such pipeline "multi-repository").
    const pipelineJobs = sanitizedWorkspace
      ? jobs.map((job) => ({ ...job, cwd: targetCwd, sanitizedWorkspace, subagentStrategy: "reject", write: false, lockType: "read", lockMode: "off" }))
      : jobs.map((job) => ({ ...job, cwd: job.cwd || targetCwd }));
    const normalizedJobs = await Promise.all(pipelineJobs.map((job) => normalizeJobCwd(job)));
    // Children are inserted into the pipeline's own state database, so a child that resolves to
    // another project would be run and recorded elsewhere while the parent waits for it forever.
    const foreignJob = normalizedJobs.find((job) => normalizeFilesystemCase(path.resolve(job.cwd), targetCwd) !== normalizeFilesystemCase(path.resolve(targetCwd), targetCwd));
    if (foreignJob) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: "pipeline_multi_repository_unsupported",
              reason: `Pipeline job "${foreignJob.agent}" resolves to a different repository: ${foreignJob.cwd}.`,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Create one pipeline per Git repository and keep every job cwd inside that repository.",
            }),
          },
        ],
      };
    }
    const policyLoad = usePolicy ? await loadProjectAgentPolicy(targetCwd, policyPath) : { ok: true, path: "", policy: null, sha256: "" };
    if (!policyLoad.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: policyLoad.errorType,
              reason: policyLoad.error,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Fix or remove the project agent policy file, or call create_multi_agent_pipeline with usePolicy=false.",
            }),
          },
        ],
      };
    }
    const sanitizedPreflight = sanitizedWorkspace
      ? await verifySanitizedWorkspace(sanitizedWorkspace, "before_wave")
      : null;
    if (sanitizedPreflight && !sanitizedPreflight.ok) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline sanitized-workspace preflight rejected.",
        errorType: sanitizedPreflight.errorType,
        reason: sanitizedPreflight.error,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        conflictingPaths: sanitizedPreflight.discrepancies?.map((item) => item.path) || [],
        suggestedFix: "Rebuild and re-pin the sanitized workspace before creating the pipeline.",
      }) }] };
    }
    const plan = createPipelinePlan({
      name,
      cwd: targetCwd,
      jobs: normalizedJobs,
      requiresWorktrees,
      finalValidationCommand,
      reviewerJob,
      testerJob,
      policy: policyLoad.policy,
      policyPath: policyLoad.policy ? policyPath : "",
      policySha256: policyLoad.sha256 || "",
      policyTrustedForAuthority: Boolean(policyLoad.trustedForAuthority),
      sanitizedWorkspace,
      sanitizedPreflight,
    });
    if (!plan.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: plan.errorType,
              reason: plan.error,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              lockMode: plan.lockPlans?.map((lockPlan) => lockPlan.lockMode).join(", ") || "unknown",
              conflictingPaths: plan.conflictingPaths || [],
              serialOnlyMatches: plan.serialOnlyMatches || [],
              suggestedFix: plan.suggestedFix,
            }),
          },
        ],
      };
    }

    const pipelineValidationCommands = [
      ...(plan.record.finalValidationSource === "caller" ? [{ label: "finalValidationCommand", command: plan.record.finalValidationCommand }] : []),
      ...(plan.record.lockPlans || []).map((lockPlan, index) => ({ label: `JOB ${index + 1} validationCommand`, command: lockPlan.validationCommand })),
    ];
    for (const { label, command } of pipelineValidationCommands) {
      const validationPreflight = await validationCommandPreflightError(command, { sanitized: Boolean(sanitizedWorkspace) });
      if (validationPreflight) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Multi-agent pipeline rejected before any job was queued.",
          errorType: validationPreflight.errorType,
          reason: `${label} cannot run: ${validationPreflight.error}`,
          requestedAgent: "pipeline_coordinator",
          actualAgent: "none",
          suggestedFix: VALIDATION_PREFLIGHT_FIX,
        }) }] };
      }
    }

    PIPELINE_RUNS.set(plan.record.pipelineId, plan.record);
    await persistPipelineRecord(plan.record);
    return {
      content: [
        {
          type: "text",
          text: [
            "Multi-agent pipeline created.",
            "",
            JSON.stringify(pipelineRecordSnapshot(plan.record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "run_multi_agent_pipeline",
  "Start a previously created multi-agent pipeline by enqueueing its bounded jobs through the MCP queue.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
  },
  async ({ pipelineId, cwd = "" }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: "pipeline_requires_sqlite_queue",
              reason: "run_multi_agent_pipeline requires the SQLite queue so batch activation is atomic and restart-recoverable.",
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server.",
            }),
          },
        ],
      };
    }

    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }

    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "start") }] };
    }

    if (record.status !== "planned" || record.queueJobIds?.length) {
      return {
        content: [
          {
            type: "text",
            text: [
              "Multi-agent pipeline not started.",
              "",
              `Pipeline id: ${pipelineId}`,
              `Current status: ${record.status}`,
              `Queue jobs: ${record.queueJobIds?.join(", ") || "none"}`,
            ].join("\n"),
          },
        ],
      };
    }

    const preparedRecords = [];
    const errors = [];
    for (const job of record.jobs || []) {
      const prepared = await enqueueQueueJob(
        { ...job, cwd: job.cwd || record.cwd },
        pipelineId,
        { schedule: false, initialStatus: "held", persist: false }
      );
      if (!prepared.ok) {
        errors.push({
          agent: job.agent,
          errorType: prepared.errorType,
          error: prepared.error,
          suggestedFix: prepared.suggestedFix,
        });
        continue;
      }
      preparedRecords.push(prepared.record);
    }

    if (errors.length) {
      await updatePipelineRecord(record, {
        status: "failed",
        batchState: "aborted",
        errors,
        finishedAt: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: "text",
            text: [
              "Multi-agent pipeline failed before start.",
              "",
              JSON.stringify(pipelineRecordSnapshot(record), null, 2),
            ].join("\n"),
          },
        ],
      };
    }

    const activation = await activatePipelineBatch(record, preparedRecords);
    if (!activation.ok) {
      return {
        content: [{
          type: "text",
          text: formatRejectedExecution({
            headline: "Multi-agent pipeline activation rejected.",
            errorType: activation.errorType,
            reason: activation.error,
            requestedAgent: "pipeline_coordinator",
            actualAgent: "none",
            lockMode: "atomic_sqlite_batch",
            suggestedFix: "Inspect the durable pipeline revision and retry only if it remains planned with no child manifest.",
          }),
        }],
      };
    }

    scheduleQueue();
    return {
      content: [
        {
          type: "text",
          text: [
            "Multi-agent pipeline started.",
            "",
            JSON.stringify(pipelineRecordSnapshot(record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_multi_agent_pipeline",
  "Get one multi-agent pipeline, including queue job status and integration queue.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
  },
  async ({ pipelineId, cwd = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }

    if (!pipelineOwnedByThisInstance(record)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...pipelineRecordSnapshot(record),
            readOnlyForeignOwner: true,
          }, null, 2),
        }],
      };
    }

    if (!PIPELINE_RUNS.has(pipelineId)) {
      PIPELINE_RUNS.set(pipelineId, record);
    }
    await refreshPipelineRecord(record);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(pipelineRecordSnapshot(record), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "abandon_multi_agent_pipeline",
  "Explicitly abandon an inactive durable pipeline while retaining every unintegrated worktree for separate review or cleanup.",
  {
    pipelineId: z.string().min(1),
    cwd: z.string().min(1),
    confirmation: z.string().min(1).describe("Must exactly equal pipelineId. Prevents accidental abandonment."),
    reason: z.string().max(500).optional(),
  },
  async ({ pipelineId, cwd = "", confirmation, reason = "Operator abandoned an obsolete pipeline." }) => {
    if (confirmation !== pipelineId) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_abandon_confirmation_mismatch",
        reason: "The confirmation value must exactly equal the pipeline id.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Inspect the pipeline first, then repeat with confirmation set to the exact pipelineId. Abandonment retains all worktrees.",
      }) }] };
    }
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_requires_sqlite_queue",
        reason: "Only durable SQLite pipelines can be abandoned through this recovery operation.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server.",
      }) }] };
    }

    const projectRoot = await resolveProjectStateRoot(cwd);
    const record = await authoritativePipelineRecord(pipelineId, projectRoot);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }
    if (record.status === "cancelled" && (record.events || []).some((event) => event.type === "pipeline_abandoned")) {
      return { content: [{ type: "text", text: [
        "Multi-agent pipeline already abandoned; retained sources were not modified.",
        "",
        JSON.stringify(pipelineRecordSnapshot(record), null, 2),
      ].join("\n") }] };
    }
    if (["completed", "failed", "cancelled"].includes(record.status)) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_already_terminal",
        reason: `Pipeline status is already ${record.status}.`,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Keep the terminal audit record; normal retention will remove it after the configured retention period.",
      }) }] };
    }
    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "abandonment") }] };
    }

    const children = record.status === "planned" && record.batchState === "unstarted"
      ? { ok: true, snapshots: [] }
      : await readPersistedPipelineChildren(record);
    if (!children.ok) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_child_record_missing",
        reason: "The durable child manifest is incomplete, so inactivity cannot be proven safely.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Run diagnose_opencode_bridge and preserve the state database for recovery analysis.",
      }) }] };
    }
    const activeStatuses = new Set(["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"]);
    const activeChildren = children.snapshots.filter((child) => activeStatuses.has(child.status));
    if (activeChildren.length) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_abandon_active_jobs",
        reason: `The pipeline still has active jobs: ${activeChildren.map((child) => child.jobId).join(", ")}.`,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Cancel the active queue jobs first, wait for terminal status, then abandon the pipeline.",
      }) }] };
    }
    if ((record.integrationQueue || []).some((item) => item.status === "integrating")) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_integration_in_progress",
        reason: "An integration journal operation is still in progress or awaiting recovery.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Run diagnose_opencode_bridge and finish integration recovery before abandoning the pipeline.",
      }) }] };
    }

    const abandonedAt = new Date().toISOString();
    try {
      await updatePipelineRecord(record, (current) => {
        // Finalization removes source worktrees that abandonment promises to retain.
        if (["finalizing", "cleanup_pending"].includes(current.status)) {
          const error = new Error("The pipeline is being finalized.");
          error.errorType = "pipeline_finalization_in_progress";
          throw error;
        }
        // An integration may have reserved an item since the check above.
        if ((current.integrationQueue || []).some((item) => item.status === "integrating")) {
          const error = new Error("An integration reserved an item of this pipeline while it was being abandoned.");
          error.errorType = "pipeline_integration_in_progress";
          throw error;
        }
        return {
          status: "cancelled",
          finishedAt: abandonedAt,
          cleanupPending: false,
          cleanupState: "abandoned_sources_retained",
          events: (current.events || []).concat({
            type: "pipeline_abandoned",
            at: abandonedAt,
            reason,
            retainedWorktrees: (current.integrationQueue || []).filter((item) => item.worktreePath).map((item) => item.worktreePath),
          }),
        };
      });
    } catch (error) {
      if (!["pipeline_integration_in_progress", "pipeline_concurrent_update", "pipeline_finalization_in_progress"].includes(error?.errorType)) throw error;
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: error.errorType,
        reason: error.errorType === "pipeline_integration_in_progress"
          ? "An integration journal operation started while the pipeline was being abandoned."
          : error.errorType === "pipeline_finalization_in_progress"
            ? "The pipeline is being finalized; abandoning it now would let finalization remove the source worktrees abandonment retains."
            : "The pipeline changed in another process while it was being abandoned.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Nothing was cancelled. Wait for the integration or finalization to finish (get_multi_agent_pipeline), then abandon again if it is still needed.",
      }) }] };
    }
    return { content: [{ type: "text", text: [
      "Multi-agent pipeline abandoned. Unintegrated worktrees were retained and no project files were deleted.",
      "",
      JSON.stringify(pipelineRecordSnapshot(record), null, 2),
    ].join("\n") }] };
  }
);

server.tool(
  "resolve_integration_quarantine",
  "Close a quarantined integration journal operation that recovery does not clear on its own. verify_restored closes it only when HEAD, the index entries and the bytes of every affected path are back at the recorded pre-integration state; accept_current records that an operator inspected the checkout and accepts it as it is (needs reason and confirmation). Refused while any job holds a lock in the repository; journal rows and pre-images are kept.",
  {
    cwd: z.string().min(1).describe("The repository the quarantine is in."),
    operationId: z.string().min(1).describe("From the integrationOperations section of diagnose_opencode_bridge."),
    mode: z.enum(INTEGRATION_QUARANTINE_RESOLUTION_MODES),
    reason: z.string().max(500).optional().describe("Required for accept_current: what was inspected and why the current state is accepted."),
    confirmation: z.string().optional().describe("Required for accept_current: must exactly equal operationId."),
  },
  async ({ cwd, operationId, mode, reason = "", confirmation = "" }) => {
    // Who and how are set here, never by the caller: the operator is the OS user running this
    // bridge, and "cli" only for the bridge bin/pipeline-admin.js starts for a person at a terminal.
    const via = process.env[OPERATOR_CLI_ENV] === "1" ? "cli" : "mcp";
    const result = await resolveIntegrationQuarantine({ cwd, operationId, mode, reason, confirmation, via });
    return { content: [{ type: "text", text: formatIntegrationQuarantineResolution(result) }] };
  }
);

server.tool(
  "finalize_multi_agent_pipeline",
  "Finalize a multi-agent pipeline after all integrations by running final validation and optional read-only reviewer/tester gates.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
    skipReviewers: z.boolean().optional().describe("Skip configured reviewer/tester gates and run only final validation."),
    dryRun: z.boolean().optional().describe("Check finalization preconditions only: no final validation, no reviewer/tester agents, and no pipeline status change."),
  },
  async ({ pipelineId, cwd = "", skipReviewers = false, dryRun = false }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }


    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "finalization") }] };
    }

    if (!PIPELINE_RUNS.has(pipelineId)) {
      PIPELINE_RUNS.set(pipelineId, record);
    }

    const result = await finalizePipelineRecord(record, { skipReviewers, dryRun });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Multi-agent pipeline finalization rejected.",
                errorType: result.errorType,
                reason: result.error,
                requestedAgent: "pipeline_coordinator",
                actualAgent: "none",
                lockMode: "finalization",
                suggestedFix: "Integrate all pending worktrees, fix validation failures, or inspect reviewer/tester gate output before retrying.",
              }),
              "",
              JSON.stringify(pipelineRecordSnapshot(record), null, 2),
            ].join("\n"),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            result.dryRun
              ? `Multi-agent pipeline finalization dry run: preconditions pass. Would run final validation ${result.wouldRun.finalValidationCommand ? `"${result.wouldRun.finalValidationCommand}"` : "(none)"} and gates: ${result.wouldRun.gates.join(", ") || "none"}. Nothing was run or changed.`
              : result.alreadyFinalized
                ? "Multi-agent pipeline was already finalized; its recorded gate results stand and nothing was rerun."
                : "Multi-agent pipeline finalized.",
            "",
            JSON.stringify(pipelineRecordSnapshot(record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_multi_agent_pipelines",
  "List multi-agent pipelines from memory and persisted state.",
  {
    cwd: z.string().min(1),
    status: z.enum(["planned", "running", "awaiting_integration", "awaiting_finalization", "finalizing", "integrating", "cleanup_pending", "cleanup_failed", "completed", "failed", "cancelled"]).optional(),
    limit: z.number().int().positive().max(200).optional().describe("Newest pipelines to show; default 20. The count line always covers every pipeline."),
  },
  async ({ cwd = "", status = "", limit = 20 }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const records = (effectiveQueueMode() === "sqlite"
      ? await listPersistedPipelineRecords(projectRoot || cwd, status)
      : [...PIPELINE_RUNS.values()]
        .filter((record) => recordMatchesProject(record, projectRoot))
        .map((record) => pipelineRecordSnapshot(record))
        .filter((record) => !status || record.status === status)
    ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const shown = records.slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: [
            `Pipelines: ${records.length}${shown.length < records.length ? ` (showing the newest ${shown.length})` : ""}`,
            JSON.stringify(shown, null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);
}
