// MCP tools: job views, get/inspect/cancel/requeue jobs, concurrency and provider pause/resume.
// Extracted from server.js in modularization round M-001.

import { existsSync } from "node:fs";
import path from "node:path";
import { queueAgentTiming, queueStartAfterPending } from "../queue.js";
import { sanitizePersistedValue } from "../redaction.js";
import { MAX_AGENT_TIMEOUT_MS } from "../scope-contract.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerJobTools({ BRIDGE_INSTANCE_ID, CONFIG, MAX_GLOBAL_WORKER_LIMIT, MAX_RUNTIME_CONCURRENCY_LIMIT, QUEUE_JOBS, RETAINED_WORKTREE_STATUSES, assessQueuePlan, authoritativeQueueRecord, cancelPersistedQueueJob, closeDb, describeConcurrencyLimits, directRunAuditStore, effectiveBridgeStateDirectory, effectiveQueueMode, formatIdleDuration, formatOpenCodeUsage, logEvent, nowMs, openLockDb, pauseProvider, persistQueueRecord, processIsAlive, queueAgentActivity, queueRecordSnapshot, queueRunStage, readPersistedQueueRecord, reconcileParentPipelineAfterQueueTerminal, reconcileStaleQueueRecords, recordMatchesProject, requeueQueueJob, resolveProjectStateRoot, resumeProvider, scheduleQueue, server, setRuntimeConcurrency, timedOutWriterNote }) {
// Polling four jobs with full records cost ~20k characters of coordinator context per poll.
// The compact form keeps what a coordinator acts on; detail: true or get_opencode_job has the rest.
// One diagnose row. A completed writer whose worktree no longer exists was integrated (or removed),
// so it is not offered for integration again.
// B-020: every bridge-created worktree (queued, direct or parallel) is in worktree_artifacts;
// diagnose read only queue records, so parallel writers' retained patches were invisible.
async function listRetainedWorktreeArtifacts(projectRoot, { jobId = "" } = {}) {
  const db = await openLockDb(projectRoot);
  try {
    const placeholders = RETAINED_WORKTREE_STATUSES.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT worktree_path AS worktreePath, cwd, branch, job_id AS jobId, status,
        measured_bytes AS measuredBytes, created_at AS createdAt, updated_at AS updatedAt
      FROM worktree_artifacts
      WHERE status IN (${placeholders})${jobId ? " AND job_id = ?" : ""}
      ORDER BY created_at DESC
    `).all(...RETAINED_WORKTREE_STATUSES, ...(jobId ? [jobId] : []));
    return rows.map((row) => ({ ...row, present: existsSync(row.worktreePath) }));
  } finally {
    closeDb(db);
  }
}

const QUEUE_JOB_RUNNING_STATUSES = new Set(["pending", "planned", "running", "validating", "reviewing", "testing", "blocked"]);

function retainedWorktreeView(artifact, { queueJob = null, run = null } = {}) {
  const owner = queueJob ? "queue" : run ? run.kind || "direct" : "unrecorded";
  // A worktree is registered "retained" when it is created, so a running agent's worktree looks
  // retained too; it must not be offered for integration or removal while an agent may write to it.
  const inFlight = Boolean(queueJob ? QUEUE_JOB_RUNNING_STATUSES.has(queueJob.status) : run?.status === "started");
  return {
    worktreePath: artifact.worktreePath,
    branch: artifact.branch,
    jobId: artifact.jobId,
    owner,
    ownerStatus: queueJob?.status || run?.status || "",
    registryStatus: artifact.status,
    present: artifact.present,
    inFlight,
    createdAt: artifact.createdAt,
    measuredBytes: artifact.measuredBytes,
    recoveryAction: inFlight
      ? "None yet: its job is still running (or its bridge stopped before recording the outcome; check the owner status). Do not integrate or remove it while an agent may be writing."
      : !artifact.present
      ? "None on disk: the directory is gone; the next worktree reservation reconciles the registry row."
      : artifact.status === "creating"
      ? "Creation did not finish: inspect it, then remove it with git worktree remove if it holds no work."
      : `Review: git -C "${artifact.worktreePath}" status --short and git diff; integrate with integrate_opencode_worktree (dry run first) or remove it.`,
  };
}

function directRunView(run, artifacts = [], { detail = false } = {}) {
  const usage = run.usageSteps === null || run.usageSteps === undefined ? null : {
    steps: run.usageSteps,
    inputCount: run.inputCount,
    outputCount: run.outputCount,
    reasoningCount: run.reasoningCount,
    cacheReadCount: run.cacheReadCount,
    cacheWriteCount: run.cacheWriteCount,
    cost: run.cost,
  };
  // L-025: the result text stored under the Run id (redacted, sealed on disk, capped like a queue
  // result); a run from before this, or one whose text could not be sealed, has none.
  const stored = run.result && !run.result.unreadable ? run.result : null;
  const resultView = stored
    ? {
      resultText: stored.text,
      resultTextChars: stored.chars,
      resultTextTruncated: stored.reportTruncated,
      resultDetailTextChars: stored.detailText.length,
      ...(detail ? { resultDetailText: stored.detailText, resultDetailTextTruncated: stored.detailTruncated } : {}),
    }
    : {};
  const resultNote = stored
    ? `The result text stored under this Run id is in resultText${stored.detailText ? (detail ? " and resultDetailText" : "; pass detail: true for resultDetailText (a writer's patch preview, a parallel job's bridge preamble)") : ""}.`
    : run.result?.unreadable
    ? "A result text was stored for this run but could not be opened (its encryption key changed or the record is damaged)."
    : run.status === "started"
    ? "The run has not finished (or its bridge stopped before recording the outcome); its result text is stored when it does."
    : "No result text was stored for this run (it ran before results were kept, or the audit could not store it).";
  return {
    kind: run.kind === "parallel" ? "parallel_run" : "direct_run",
    runId: run.runId,
    agent: run.agent,
    status: run.status,
    errorType: run.errorType || "",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || "",
    durationMs: run.durationMs,
    waitBeforeAgentMs: run.startupMs,
    agentRunMs: run.agentRunMs,
    providerWaitMs: run.providerWaitMs,
    providerRetryWarningCount: run.providerRetryWarnings,
    usage,
    ...(usage?.steps ? { usageSummary: formatOpenCodeUsage(usage) } : {}),
    configuredModel: run.configuredModel || "",
    worktrees: artifacts.map((artifact) => retainedWorktreeView(artifact, { run })),
    ...resultView,
    note: `Not a queue job: this ${run.kind === "parallel" ? "run_opencode_parallel" : "run_opencode_agent"} run cannot be cancelled or replayed. ${resultNote} A worktree listed here is retained work.`,
  };
}

function diagnoseJobView(job) {
  const worktreePresent = Boolean(job.worktreePath) && existsSync(job.worktreePath);
  return {
    jobId: job.jobId,
    pipelineId: job.parentJobId || "",
    status: job.status,
    stage: queueRunStage(job),
    ...queueAgentActivity(job),
    errorType: job.errorType || "",
    failureReason: job.errorReason || "",
    requestedAgent: job.agent || "",
    actualModel: job.actualModel || job.runtimeObservedModel || "",
    childProcessId: job.childProcessId || job.orphanChildProcessId || 0,
    worktreePath: job.worktreePath || "",
    workPreserved: worktreePresent,
    retrySafe: job.mode === "read" && !["running", "validating", "reviewing", "testing"].includes(job.status),
    // Healthy jobs used to get "inspect preserved work before retrying", which reads as if
    // something had gone wrong; only jobs that stopped short get recovery steps.
    recoveryAction: ["pending", "planned", "running", "validating", "reviewing", "testing"].includes(job.status)
      ? `None: the job is ${queueRunStage(job)}.`
      : job.status === "completed"
      ? (worktreePresent && job.mode === "write"
        ? "None: review the patch and integrate it with integrate_opencode_worktree (dry run first)."
        : job.worktreePath && job.mode === "write"
        ? "None: the worktree is gone (integrated and cleaned up, or removed)."
        : "None: the job completed.")
      : worktreePresent
      ? `Inspect preserved work: git -C "${job.worktreePath}" status --short and git diff --binary before retrying.`
      : job.status === "not_resumable"
      ? "Re-enqueue with a stable idempotencyKey; legacy records without encrypted requests cannot be replayed."
      : job.status === "interrupted"
      ? "Inspect the target repository and recorded child identity before retrying with the same idempotencyKey."
      : "No manual SQLite edit is required; follow the stable error type and wait for active leases/locks to expire or complete.",
  };
}

const ESSENTIAL_QUEUE_JOB_FIELDS = [
  "jobId", "idempotencyKey", "requeuedFrom", "requeuedAs", "retryAttempt", "maxAttempts", "attemptHistory", "startAfter", "autoIntegration", "agent", "mode", "status", "runStage", "createdAt", "startedAt",
  "agentStartedAt", "lastActivityAt", "idleMs", "finishedAt", "durationMs", "agentRunMs", "waitBeforeAgentMs", "afterAgentMs", "providerWaitMs",
  "providerRetryWarningCount", "usage", "usageSummary", "heavyToolCalls", "validationFixPass", "selfCheck", "phaseTimings",
  "errorType", "errorReason", "completionOutcome", "changedFiles", "worktreePath", "worktreeBranch",
  "dependencyRequest", "readOnlyHeadMove", "resultTextChars", "resultTextTruncated", "resultText", "resultDetailTextChars",
];

// The fields a caller polling or reading one job acts on; `detail: true` returns the full record.
function essentialQueueJobView(snapshot) {
  const view = {};
  for (const field of ESSENTIAL_QUEUE_JOB_FIELDS) {
    const value = snapshot?.[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (field === "resultDetailTextChars" && !value) continue;
    view[field] = value;
  }
  view.omitted = "Pass detail: true for the scope contract, hashes, lease, owner and containment fields, and for the stored worktree patch preview (resultDetailText); the result text leaves the patch out (integrate_opencode_worktree with dryRun: true shows it too).";
  return view;
}

function queueTimedOutWriterNote(record) {
  if (record?.status !== "failed" || record.mode !== "write") return "";
  return timedOutWriterNote({ errorType: record.errorType, changedFiles: record.changedFiles, worktreeRetained: Boolean(record.worktreePath) });
}

function compactQueueJobLines(records) {
  if (!records.length) return "(no jobs)";
  return records.map((record) => {
    const stage = queueRunStage(record);
    const timing = queueAgentTiming(record);
    const activity = queueAgentActivity(record);
    const parts = [
      record.jobId,
      record.idempotencyKey ? `key=${record.idempotencyKey}` : "",
      record.requeuedFrom ? `requeuedFrom=${record.requeuedFrom}` : "",
      record.requeuedAs ? `requeuedAs=${record.requeuedAs}` : "",
      record.maxAttempts ? `attempt=${record.retryAttempt || 1}/${record.maxAttempts}` : "",
      record.maxAttempts && record.scopeContract?.modelRequirement?.model ? `model=${record.scopeContract.modelRequirement.provider}/${record.scopeContract.modelRequirement.model}` : "",
      queueStartAfterPending(record) ? `startAfter=${record.startAfter}` : "",
      `agent=${record.agent || "?"}`,
      `status=${record.status || "?"}`,
      stage && stage !== record.status ? `stage=${stage}` : "",
      timing.waitBeforeAgentMs ? `waitBeforeAgentMs=${timing.waitBeforeAgentMs}` : "",
      timing.agentRunMs ? `agentRunMs=${timing.agentRunMs}` : "",
      activity.idleMs !== undefined ? `idle ${formatIdleDuration(activity.idleMs)}` : "",
      timing.afterAgentMs ? `afterAgentMs=${timing.afterAgentMs}` : "",
      record.providerWaitMs ? `providerWaitMs=${record.providerWaitMs}` : "",
      record.usage?.steps ? `tokens=${record.usage.inputCount}in/${record.usage.outputCount}out` : "",
      record.usage?.steps && record.usage.cacheReadCount ? `cacheRead=${record.usage.cacheReadCount}` : "",
      record.validationFixPass ? `fixPass=${record.validationFixPass.used ? `used(${record.validationFixPass.finalValidation})` : "skipped"}` : "",
      record.selfCheck ? `selfCheck=${record.selfCheck.final}(${record.selfCheck.passesUsed}/${record.selfCheck.passesAllowed})` : "",
      record.providerRetryWarningCount ? `providerErrorLines=${record.providerRetryWarningCount}` : "",
      record.readOnlyHeadMove ? `headMoved=${record.readOnlyHeadMove.readScopeTouched?.length ? "read-scope" : "outside-read-scope"}` : "",
      record.durationMs ? `durationMs=${record.durationMs}` : "",
      record.errorType ? `error=${record.errorType}` : "",
      record.completionOutcome ? `outcome=${record.completionOutcome}` : "",
      record.autoIntegration?.status ? `autoIntegration=${record.autoIntegration.status}${record.autoIntegration.commit ? `@${String(record.autoIntegration.commit).slice(0, 12)}` : ""}` : "",
      (record.changedFiles || []).length ? `changed=${record.changedFiles.join(",")}` : "",
      queueTimedOutWriterNote(record) ? `note="${queueTimedOutWriterNote(record)}"` : "",
    ].filter(Boolean);
    return `- ${parts.join(" ")}`;
  }).join("\n");
}

server.tool(
  "get_opencode_job",
  "Get one OpenCode job by id: a queued job (with result text), or a run_opencode_agent / run_opencode_parallel Run id (status, timing, usage, retained worktree and the stored result text).",
  {
    jobId: z.string(),
    cwd: z.string().min(1).describe("Canonical repository path for project-scoped job lookup."),
    detail: z.boolean().optional().describe("Full record (scope contract, hashes, lease, owner and containment fields) plus the stored detail text: a writer's worktree patch preview, a parallel job's bridge preamble. Default: status, timing, changed files, worktree and result text (without the patch preview)."),
  },
  async ({ jobId, cwd = "", detail = false }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const authoritative = await authoritativeQueueRecord(jobId, projectRoot || cwd);
    const persisted = authoritative
      ? (effectiveQueueMode() === "sqlite" ? authoritative : queueRecordSnapshot(authoritative))
      : null;
    // record_json keeps the stage and timings of its last write; a running job's are derived now.
    const snapshot = persisted
      ? {
        ...persisted,
        runStage: queueRunStage(persisted),
        ...queueAgentTiming(persisted),
        ...queueAgentActivity(persisted),
        // One readable line next to the usage counts: the totals a job read, so a very heavy one is noticed.
        ...(persisted.usage?.steps ? { usageSummary: formatOpenCodeUsage(persisted.usage) } : {}),
      }
      : null;
    if (!snapshot) {
      const lookupRoot = projectRoot || await resolveProjectStateRoot(process.cwd());
      const [run, artifacts] = await Promise.all([
        directRunAuditStore().get(lookupRoot, jobId, { includeResult: true }),
        listRetainedWorktreeArtifacts(lookupRoot, { jobId }).catch(() => []),
      ]);
      if (run || artifacts.length) {
        const view = run
          ? directRunView(run, artifacts, { detail })
          : {
            kind: "worktree_only",
            runId: jobId,
            worktrees: artifacts.map((artifact) => retainedWorktreeView(artifact)),
            note: "No queue record or run audit record has this id (older than the audit, or pruned); the worktree registry still has its retained worktree.",
          };
        return { content: [{ type: "text", text: JSON.stringify(sanitizePersistedValue(view), null, 2) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `OpenCode job not found: ${jobId}. Neither the queue, the direct/parallel run audit, nor the worktree registry of this repository has that id.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(detail ? snapshot : essentialQueueJobView(snapshot), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "inspect_opencode_queue_recovery",
  "Inspect queue ownership/lease state and optionally reconcile only confirmed expired records. Audit history is retained.",
  {
    cwd: z.string().describe("Repository path for the sqlite-backed queue state."),
    reconcileExpired: z.boolean().optional().describe("Set true to mark only confirmed expired records interrupted/not_resumable. Defaults to read-only inspection."),
  },
  async ({ cwd, reconcileExpired = false }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: "Queue recovery inspection requires CODEX_OPENCODE_QUEUE_MODE=sqlite." }] };
    }
    const db = await openLockDb(cwd);
    try {
      const now = Date.now();
      const rows = db.prepare(`
        SELECT job_id, status, owner_instance_id, owner_process_id, owner_generation,
               heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id,
               child_process_started_at, revision, created_at, started_at
        FROM opencode_jobs
        WHERE status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
        ORDER BY created_at
      `).all().map((row) => {
        const active = ["running", "validating", "reviewing", "testing"].includes(row.status);
        const leaseMs = Date.parse(row.lease_expires_at || "");
        const ownerAlive = processIsAlive(Number(row.owner_process_id || 0));
        return sanitizePersistedValue({
          jobId: row.job_id,
          status: row.status,
          ownerInstanceId: row.owner_instance_id || "",
          ownerProcessId: row.owner_process_id || 0,
          ownerGeneration: row.owner_generation || "",
          heartbeatAt: row.heartbeat_at || "",
          leaseExpiresAt: row.lease_expires_at || "",
          leaseExpired: active ? Number.isFinite(leaseMs) && leaseMs <= now : false,
          ownerProcessAlive: ownerAlive,
          cancellationRequestedAt: row.cancellation_requested_at || "",
          childProcessId: row.child_process_id || 0,
          childProcessStartedAt: row.child_process_started_at || "",
          childProcessAlive: processIsAlive(Number(row.child_process_id || 0)),
          revision: row.revision || 0,
        });
      });
      const reconciled = reconcileExpired ? reconcileStaleQueueRecords(db, now) : [];
      return {
        content: [{
          type: "text",
          text: [
            `Queue recovery mode: ${reconcileExpired ? "confirmed expired reconciliation" : "read-only inspection"}`,
            `Bridge instance: ${BRIDGE_INSTANCE_ID}`,
            `Nonterminal records: ${rows.length}`,
            `Reconciled records: ${reconciled.length ? reconciled.join(", ") : "none"}`,
            JSON.stringify(rows, null, 2),
          ].join("\n"),
        }],
      };
    } finally {
      closeDb(db);
    }
  }
);

server.tool(
  "cancel_opencode_job",
  "Cancel a queued OpenCode job. Pending and blocked jobs are cancelled immediately; active jobs terminate their exact OpenCode process tree.",
  {
    jobId: z.string(),
    cwd: z.string().min(1).describe("Canonical repository path for the project-scoped cancellation."),
  },
  async ({ jobId, cwd = "" }) => {
    const projectRoot = await resolveProjectStateRoot(cwd);
    let record = QUEUE_JOBS.get(jobId) || null;
    if (record && !recordMatchesProject(record, projectRoot)) record = null;
    if (effectiveQueueMode() === "sqlite") {
      const durable = await readPersistedQueueRecord(jobId, projectRoot);
      const exactLocalOwner = durable && record
        && Number(record.revision || 0) === Number(durable.revision || 0)
        && record.ownerInstanceId === durable.ownerInstanceId
        && String(record.ownerGeneration || "") === String(durable.ownerGeneration || "");
      if (exactLocalOwner) Object.assign(record, durable);
      else record = null;
    }
    if (!record) {
      if (effectiveQueueMode() === "sqlite" && cwd) {
        const db = await openLockDb(projectRoot);
        try {
          const cancelled = await cancelPersistedQueueJob(db, jobId);
          if (cancelled.outcome === "cancelled") {
            if (cancelled.pipelinePropagation?.pipelineId) {
              await reconcileParentPipelineAfterQueueTerminal({
                jobId,
                parentJobId: cancelled.pipelinePropagation.pipelineId,
                pipelinePropagation: cancelled.pipelinePropagation,
                cwd: projectRoot,
              });
            }
            return { content: [{ type: "text", text: `OpenCode job ${jobId} was cancelled atomically before execution.` }] };
          }
          if (cancelled.outcome === "cancellation_requested") {
            return { content: [{ type: "text", text: `Cross-process cancellation requested for OpenCode job ${jobId}; the owning bridge heartbeat will terminate its exact child process tree.` }] };
          }
          if (cancelled.outcome === "already_terminal") {
            return { content: [{ type: "text", text: `OpenCode queue job ${jobId} is already ${cancelled.status}.` }] };
          }
          if (cancelled.outcome === "contention") {
            return { content: [{ type: "text", text: `OpenCode queue job ${jobId} changed repeatedly while cancellation was attempted; retry against its current status ${cancelled.status}.` }] };
          }
        } finally {
          closeDb(db);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job not found: ${jobId}`,
          },
        ],
      };
    }

    if (["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job ${jobId} is already ${record.status}.`,
          },
        ],
      };
    }

    if (["running", "validating", "reviewing", "testing"].includes(record.status)) {
      Object.assign(record, {
        cancellationRequested: true,
        cancellationRequestedAt: new Date().toISOString(),
        errorReason: "Cancellation requested; terminating the active OpenCode process tree.",
      });
      await persistQueueRecord(record);
      record.abortController?.abort();
      return {
        content: [
          {
            type: "text",
            text: `Cancellation requested and process termination started for OpenCode job ${jobId}.`,
          },
        ],
      };
    }

    Object.assign(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      cancellationRequested: true,
      cancellationRequestedAt: new Date().toISOString(),
      errorType: "agent_cancelled",
      errorReason: "Cancelled before execution.",
      heartbeatAt: "",
      leaseExpiresAt: "",
    });
    const persisted = await persistQueueRecord(record);
    scheduleQueue();
    if (!persisted?.persisted) {
      // The durable row moved first (claimed, finished, or owned elsewhere); persistQueueRecord
      // reloaded it, so report what the job durably is instead of a cancellation that did not land.
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job ${jobId} was not cancelled: its durable status is ${persisted?.status || record.status || "unknown"}.${persisted?.ownershipLost ? " Another bridge generation owns it now." : ""}`,
          },
        ],
      };
    }
    if (record.parentJobId || record.pipelinePropagation?.pipelineId) {
      try {
        await reconcileParentPipelineAfterQueueTerminal(record);
      } catch (error) {
        logEvent("warn", "pipeline.child_terminal_reconciliation_failed", {
          pipelineId: record.parentJobId || record.pipelinePropagation?.pipelineId || "",
          jobId,
          errorType: error?.errorType || "pipeline_child_terminal_reconciliation_failed",
        });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `OpenCode queue job cancelled: ${jobId} (durable status: ${persisted.status || record.status}).`,
        },
      ],
    };
  }
);

// A short refusal for the queue-management tools (not an agent job, so no lock or worktree lines).
function formatToolRefusal({ headline, errorType, reason, suggestedFix }) {
  return [headline, "", `errorType: ${errorType}`, `reason: ${reason}`, `suggestedFix: ${suggestedFix}`].join("\n");
}

function formatConcurrencyChange(change) {
  const described = describeConcurrencyLimits();
  return [
    change.reset ? "OpenCode concurrency limits reset to the environment values." : "OpenCode concurrency limits updated.",
    `Provider slots per provider: ${described.provider}; was ${change.previous.providerLimit}`,
    `Queue parallel limit (this process): ${described.queue}; was ${change.previous.queueParallelLimit}`,
    `Global worker limit (all providers and bridge processes): ${described.global}; was ${change.previousGlobalWorkerLimit === 0 ? "0 (no cap)" : change.previousGlobalWorkerLimit}`,
    // Q-014b: the providers with their own limit (runtime providerLimits, else CODEX_OPENCODE_PROVIDER_LIMITS).
    `Per-provider slot limits: ${described.perProvider || "none"}${Object.keys(change.previousProviderLimits || {}).length ? `; runtime was ${Object.entries(change.previousProviderLimits).map(([provider, limit]) => `${provider}=${limit}`).join(", ")}` : ""}`,
    // L3: providerLimit does not reach a provider that has its own limit.
    ...(change.providerLimitSet && (change.ownLimitProviders || []).length ? [`providerLimit does not apply to ${change.ownLimitProviders.join(", ")}: they keep their own limit (change it with providerLimits, or clear a runtime one with null).`] : []),
    "Running jobs keep their slots; a lower limit only holds back new starts until enough jobs have finished.",
    `Persisted in ${path.join(effectiveBridgeStateDirectory(), "provider-concurrency.sqlite")}: other bridge processes pick it up at their next scheduler pass or slot request, and a restart keeps it until reset: true.`,
  ].join("\n");
}

server.tool(
  "requeue_opencode_job",
  "Re-run a failed, cancelled, interrupted or not_resumable queue job as a NEW job built from its stored request (agent, task, model pin, Scope Contract, locks, validationCommand, timeout). The request goes through the normal enqueue validation again; the new job gets its own id and a derived idempotency key (<original key>:requeue:<n>), and the two jobs reference each other (requeuedFrom / requeuedAs). Completed and unfinished jobs are refused. Optional overrides: model (must be in CODEX_OPENCODE_MODEL_ALLOWLIST) and timeoutMs.",
  {
    cwd: z.string().min(1).describe("Canonical repository path of the project that owns the job."),
    jobId: z.string().min(1).describe("The failed, cancelled, interrupted or not_resumable job to run again."),
    model: z.string().optional().describe("Run the new job on this model instead: provider/model[@variant], an entry of CODEX_OPENCODE_MODEL_ALLOWLIST."),
    timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional().describe("Agent run timeout in ms for the new job (at most 24 h)."),
  },
  async ({ cwd, jobId, model, timeoutMs }) => {
    const started = nowMs();
    const requeued = await requeueQueueJob({ cwd, jobId, model, timeoutMs });
    if (!requeued.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Requeue refused.",
          errorType: requeued.errorType,
          reason: requeued.error,
          suggestedFix: requeued.suggestedFix || "Fix the cause above and call requeue_opencode_job again.",
        }) }],
      };
    }
    const record = requeued.record;
    const queueAssessment = await assessQueuePlan([{
      jobId: record.jobId,
      lockType: record.mode === "read" ? "read" : "write",
      cwd: record.cwd,
      lockedPaths: record.lockedPaths,
      allowedEdits: record.allowedEdits,
      scopeContract: record.scopeContract,
    }]);
    return {
      content: [{
        type: "text",
        text: [
          "OpenCode job requeued.",
          `New job ID: ${record.jobId}`,
          `Requeued from: ${requeued.originalJobId} (was ${requeued.originalStatus}${requeued.originalErrorType ? `, ${requeued.originalErrorType}` : ""})`,
          `Idempotency key: ${requeued.idempotencyKey}`,
          `Deduplicated: ${requeued.deduplicated ? "yes (the same requeue already created this job)" : "no"}`,
          `Overrides: ${requeued.overrides.length ? requeued.overrides.join(", ") : "none"}`,
          `Status: ${record.status}`,
          `Agent: ${record.agent}`,
          `Mode: ${record.mode}`,
          `Lock mode: ${record.lockMode}`,
          `Locked paths: ${(record.lockedPaths || []).length ? record.lockedPaths.join(", ") : "none"}`,
          `Allowed edits: ${(record.allowedEdits || []).length ? record.allowedEdits.join(", ") : "none"}`,
          `Queue mode: ${effectiveQueueMode()}`,
          `Queue assessment: ${queueAssessment.status}`,
          `Queue reason: ${queueAssessment.reason}`,
          requeued.originalWorktreePath ? `The previous attempt's worktree is untouched: ${requeued.originalWorktreePath}` : null,
          ...requeued.warnings.map((warning) => `Warning: ${warning}`),
          `Duration ms: ${Math.round(nowMs() - started)}`,
        ].filter((line) => line !== null).join("\n"),
      }],
    };
  }
);

server.tool(
  "set_opencode_concurrency",
  `Change the provider slot limit (CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT), the slot limits of single providers (CODEX_OPENCODE_PROVIDER_LIMITS), the queue parallel limit (CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT) and/or the global worker cap over all providers (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT, 0 = none) of the running bridge without a restart, so running jobs are not interrupted. Values are 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT} (global 0 to ${MAX_GLOBAL_WORKER_LIMIT}). The change is persisted until reset: true returns to the environment values. Lowering never kills running jobs; it only holds back new starts.`,
  {
    providerLimit: z.number().int().min(1).max(MAX_RUNTIME_CONCURRENCY_LIMIT).optional().describe("Simultaneous model calls per provider, across all bridge processes. A provider with its own limit (providerLimits or CODEX_OPENCODE_PROVIDER_LIMITS) keeps that one."),
    providerLimits: z.record(z.string(), z.number().int().min(1).max(MAX_RUNTIME_CONCURRENCY_LIMIT).nullable()).optional().describe(`Slots of single providers, e.g. { "codex": 5, "agy": 2 }; null clears that provider's runtime limit (its CODEX_OPENCODE_PROVIDER_LIMITS entry, else providerLimit, applies again). Wins over CODEX_OPENCODE_PROVIDER_LIMITS; 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT}.`),
    queueParallelLimit: z.number().int().min(1).max(MAX_RUNTIME_CONCURRENCY_LIMIT).optional().describe("Queue jobs this bridge process runs at once (the provider limit still caps model calls)."),
    globalWorkerLimit: z.number().int().min(0).max(MAX_GLOBAL_WORKER_LIMIT).optional().describe("Agents running at once on ALL providers across all bridge processes (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT); 0 removes the cap."),
    reset: z.boolean().optional().describe("Clear every runtime override and return to the environment values. Do not combine with a limit."),
  },
  async ({ providerLimit, queueParallelLimit, globalWorkerLimit, providerLimits, reset = false }) => {
    const change = await setRuntimeConcurrency({ providerLimit, queueParallelLimit, globalWorkerLimit, providerLimits, reset });
    if (!change.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Concurrency change rejected.",
          errorType: change.errorType,
          reason: change.error,
          suggestedFix: `Pass providerLimit and/or queueParallelLimit as integers from 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT}, providerLimits as { "<provider>": 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT} or null }, globalWorkerLimit from 0 to ${MAX_GLOBAL_WORKER_LIMIT}, or reset: true.`,
        }) }],
      };
    }
    return { content: [{ type: "text", text: formatConcurrencyChange(change) }] };
  }
);

// Q-005: runtime pause of a provider or one of its models (orch/pause.json of the round-6
// orchestrator). Stored with the automatic pauses in provider-concurrency.sqlite, so every bridge
// process honours it at its next slot request and it survives a restart.
server.tool(
  "pause_opencode_provider",
  "Pause a provider (\"opencode\") or one model (\"opencode/muse-spark-1.3-contributor-free\") until a time or for some minutes, in every bridge process. Running jobs keep going; new jobs on it fail at once with provider_paused (a job with a models list moves to its next model). Replaces any pause already on that key, shorter or longer. resume_opencode_provider ends it early.",
  {
    provider: z.string().min(1).describe("provider or provider/model, as in CODEX_OPENCODE_MODEL_ALLOWLIST without the @variant."),
    until: z.string().optional().describe("ISO time the pause ends (at most 24 h ahead). Give until or minutes."),
    minutes: z.number().int().min(1).max(24 * 60).optional().describe("Pause length in minutes. Give until or minutes."),
    reason: z.string().max(200).optional().describe("Shown in get_opencode_bridge_status and in the error new jobs get."),
  },
  async ({ provider, until, minutes, reason = "" }) => {
    const paused = await pauseProvider({ provider, until, minutes, reason });
    if (!paused.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Provider pause rejected.",
          errorType: paused.errorType,
          reason: paused.error,
          suggestedFix: "Pass provider as provider or provider/model and exactly one of until (ISO time, at most 24 h ahead) or minutes (1 to 1440).",
        }) }],
      };
    }
    return { content: [{ type: "text", text: [
      `Provider paused: ${paused.key}`,
      `Until: ${paused.until}`,
      paused.target.model ? `Scope: model ${paused.target.provider}/${paused.target.model} only` : `Scope: every model of ${paused.target.provider}${CONFIG.providerConcurrencyKeyExplicit ? ` (CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY is set, so every provider shares this key and this pause covers them all)` : ""}`,
      "Running jobs keep their slots; new jobs on this key fail at once with provider_paused until then, in every bridge process.",
    ].join("\n") }] };
  }
);

server.tool(
  "resume_opencode_provider",
  "End the pause of a provider or provider/model early, whether an operator set it (pause_opencode_provider) or the bridge did (a quota reset time, a detected rate limit). For a whole provider it also clears the pauses of its models and their rate-limit backoff.",
  {
    provider: z.string().min(1).describe("provider or provider/model."),
  },
  async ({ provider }) => {
    const resumed = await resumeProvider({ provider });
    if (!resumed.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Provider resume rejected.",
          errorType: resumed.errorType,
          reason: resumed.error,
          suggestedFix: "Pass provider as provider or provider/model.",
        }) }],
      };
    }
    return { content: [{ type: "text", text: [
      `Provider resumed: ${resumed.key}`,
      `Pauses removed: ${resumed.removed.length ? resumed.removed.map((item) => `${item.providerKey} (was until ${item.until}, ${item.errorType})`).join("; ") : "none (nothing was paused)"}`,
    ].join("\n") }] };
  }
);
  return { listRetainedWorktreeArtifacts, QUEUE_JOB_RUNNING_STATUSES, retainedWorktreeView, directRunView, diagnoseJobView, ESSENTIAL_QUEUE_JOB_FIELDS, essentialQueueJobView, queueTimedOutWriterNote, compactQueueJobLines, formatToolRefusal, formatConcurrencyChange };
}
