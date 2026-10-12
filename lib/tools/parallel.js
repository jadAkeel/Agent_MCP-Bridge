// MCP tool run_opencode_parallel: parallel agent jobs under strict locks, with per-job blocks and stored results.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { parallelChangedFileKey, createParallelCoordinator } from "../parallel-coordinator.js";
import { redactSensitiveText } from "../redaction.js";
import { fitResultParts } from "../result-text.js";
import { formatValidationGateResult } from "../validation-command.js";
import { providerWaitBudget } from "../provider-wait.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerParallelTool({ providerSlotWaitStorage = null, providerSlotWaitingJobs = null, CONFIG, compactFileList,
  compactJobLines, directRunAuditStore, executeOpenCodeJob, fitRedactedJobResult,
  formatReadOnlyWorkspaceDrift, formatRejectedExecution, formatSingleResultParts,
  formatWorktreeSummary, hardLockSummary, jobInputShape, labelParallelRunId, makeQueueJobId,
  normalizeJobCwd, nowMs, parallelExecutionOverlapEvidence, parallelGroupDeadlineMs,
  parallelGroupScopeReport, prepareDelegationJobs, server, settleIndependentParallelJobs,
  validateParallelWritePlan, verifyParallelLockResults, withProjectRootCache = (operation) => operation(),
}) {
server.tool(
  "run_opencode_parallel",
  "Run multiple OpenCode agents in parallel. Use only for safe independent tasks. Each job's block is compact (Run id, outcome, timing, token usage, changed files, worktree, warnings, then the agent's report) and its result text is stored under the Run id: get_opencode_job returns it again if this response is lost.",
  {
    jobs: z.array(z.object(jobInputShape)).min(1),
    detail: z.boolean().optional().describe("Append each job's bridge detail (lock and scope echo, model evidence, phase timing split, tool outcomes) to its block. Default: compact blocks; get_opencode_job with detail: true returns the same detail later."),
  },
  async ({ jobs, detail = false }, extra = {}) => withProjectRootCache(async () => {
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

    const admission = await prepareDelegationJobs(jobs, { lockPlans, parallel: true, toolStarted });
    if (admission.response) return admission.response;
    const parallelResolutions = admission.prepared.map(item => item.resolution);
    const parallelWorktrees = [];
    const parallelRunIds = lockPlans.map((plan) => makeQueueJobId(plan.agent));
    const parallelAudit = directRunAuditStore();
    const parallelAuditHandles = await Promise.all(jobs.map((job, index) => parallelAudit.start(
      { agent: lockPlans[index].agent, cwd: job.cwd || process.cwd(), dryRun: Boolean(job.dryRun) },
      { runId: parallelRunIds[index], kind: "parallel", jobId: parallelRunIds[index] }
    )));
    const parallelChildSpawned = jobs.map(() => false);
    const plannedDeadlineMs = parallelGroupDeadlineMs(lockPlans, jobs);
    const jobBudgets = jobs.map((job, index) => {
      const waitMs = providerWaitBudget(CONFIG.providerWaitMaxMs, job.maxWaitMs).effectiveMaxWaitMs;
      return { waitMs, executionMs: parallelGroupDeadlineMs([lockPlans[index]], [job]) - waitMs };
    });
    const coordinator = createParallelCoordinator({ jobs, lockPlans, signal: extra.signal, toolStarted, nowMs,
      groupDeadlineMs: plannedDeadlineMs, parallelGroupScopeReport,
      jobIds: parallelRunIds, providerWaitingJobs: providerSlotWaitingJobs, jobBudgets });
    const executionCwdForIndex = (index) => parallelWorktrees[index]?.path || jobs[index].cwd || process.cwd();
    let results;
    try {
      const executionPromises = jobs.map(async (job, index) => {
        try {
          const jobStartedAtMs = nowMs();
          const execute = () => executeOpenCodeJob(job, {
            toolStarted: jobStartedAtMs, jobId: parallelRunIds[index], prepared: admission.prepared[index],
            signal: coordinator.signal, parallel: coordinator.job(index),
            onChildSpawn: () => { parallelChildSpawned[index] = true; coordinator.agentSpawned(index); return { ok: true }; },
            onWorktreePrepared: (worktree) => { parallelWorktrees[index] = worktree; },
          });
          const execution = await (providerSlotWaitStorage
            ? providerSlotWaitStorage.run({ jobId: parallelRunIds[index] }, execute) : execute());
          const { result, resolution = parallelResolutions[index], validation, worktreeCleanup } = execution;
          if (result.phaseTimings) result.phaseTimings.sharedSetupMs = coordinator.sharedSetupMs;
          const lockPlan = lockPlans[index];
          const unsafeFiles = validation?.disallowedFiles || [];
          const worktree = parallelWorktrees[index];
          if (!coordinator.snapshots[index]) return {
            index, lockPlan, result, unsafeFiles, worktreeCleanup,
            initialErrorType: result.errorType || "", startedAtMs: jobStartedAtMs, finishedAtMs: nowMs(),
            text: `JOB ${index + 1}\n${execution.response?.content?.map(item => item.text || "").join("\n") || ""}`,
          };
          const validationGate = coordinator.snapshots[index]?.validationGate || { status: "skipped" };
          const singleParts = formatSingleResultParts({ resolution, result, cwd: executionCwdForIndex(index), lockPlan });
          const head = [
            `JOB ${index + 1}`,
            ...compactJobLines({ resolution, result, unsafeFiles }),
            formatReadOnlyWorkspaceDrift(result.readOnlyWorkspaceDrift),
            worktree ? formatWorktreeSummary(worktree, worktreeCleanup) : null,
            result.worktree?.diffStat ? `Worktree diff stat:\n${result.worktree.diffStat}` : null,
            validationGate.status === "skipped" ? null : formatValidationGateResult(validationGate),
            `Unsafe changed files: ${unsafeFiles.length ? compactFileList(unsafeFiles) : "none detected"}`,
          ].filter(Boolean).join("\n");
          const tail = String(result.stderr || "").trim() ? singleParts.stderr.replace(/^\n/, "") : "";
          return { index, lockPlan, result, unsafeFiles, worktreeCleanup,
            initialErrorType: coordinator.initialErrorTypes[index] || "",
            worktreeDetail: worktree ? formatWorktreeSummary(worktree, worktreeCleanup, { compactPaths: false }) : "",
            startedAtMs: jobStartedAtMs, finishedAtMs: nowMs(),
            parts: { head, report: singleParts.report, tail },
            text: [head, singleParts.report, tail].filter(Boolean).join("\n"),
            detailText: [`Temporary lock acquired: ${hardLockSummary(coordinator.locks[index])}`, singleParts.preamble.trimEnd()].join("\n"),
          };
        } finally { await coordinator.job(index).finalize(null); }
      });
      const settled = await settleIndependentParallelJobs(executionPromises);
      results = settled.map((entry, index) => entry.status === "fulfilled" ? entry.value : ({
        index, lockPlan: lockPlans[index], result: { changedFiles: [], exitCode: "infrastructure_failure",
          errorType: "parallel_job_infrastructure_failure", stderr: redactSensitiveText(entry.reason?.message || String(entry.reason)) },
        text: `JOB ${index + 1}\n${formatRejectedExecution({
          headline: "Parallel job failed at the bridge infrastructure layer.", errorType: "parallel_job_infrastructure_failure",
          reason: redactSensitiveText(entry.reason?.message || String(entry.reason)), requestedAgent: jobs[index].agent,
          actualAgent: parallelResolutions[index]?.actualAgent || "none", lockMode: lockPlans[index].lockMode,
          suggestedFix: "Inspect the retained sibling worktrees and retry through the queue/pipeline if cancellation or durable status is required.",
        })}`,
      }));
      results.forEach((entry, index) => {
        entry.text = labelParallelRunId(entry.text, parallelRunIds[index]);
        if (entry.parts) entry.parts.head = labelParallelRunId(entry.parts.head, parallelRunIds[index]);
      });
    } finally {
      coordinator.dispose();
    }
    const parallelRollbackReports = coordinator.reports;
    const acquiredLocks = coordinator.locks;
    const parallelLockReleases = acquiredLocks.filter(Boolean).map((lock) => results[acquiredLocks.indexOf(lock)]?.result?.lockRelease);
    const groupDeadlineExpired = coordinator.deadlineExpired;
    const groupDeadlineMs = coordinator.deadlineMs;
    const lockViolations = verifyParallelLockResults(results);
    const changedFileOwners = new Map();
    results.forEach((entry, position) => {
      for (const file of entry.result?.changedFiles || []) {
        const key = parallelChangedFileKey(entry.lockPlan, file);
        if (!changedFileOwners.has(key)) changedFileOwners.set(key, new Set());
        changedFileOwners.get(key).add(position);
      }
    });
    const parallelAudits = await Promise.all(results.map((entry, position) => {
      const index = Number.isInteger(entry.index) ? entry.index : position;
      const cwd = path.resolve(executionCwdForIndex(index));
      const groupReport = parallelRollbackReports.find(report => report.cwd === cwd);
      const individualViolations = verifyParallelLockResults([entry]);
      const overlap = (entry.result?.changedFiles || []).some(file => changedFileOwners.get(parallelChangedFileKey(entry.lockPlan, file))?.size > 1);
      const lockRelease = parallelLockReleases[acquiredLocks.filter(Boolean).indexOf(acquiredLocks[index])];
      const groupRejected = !entry.initialErrorType && Boolean(groupReport?.disallowedFiles.length || groupReport?.checkFailed || individualViolations.length || overlap
        || (entry.result?.errorType && entry.result.errorType !== entry.initialErrorType));
      if (groupRejected) {
        entry.result.groupRejected = true;
        entry.result.errorType ||= groupReport?.errorType || (groupReport?.disallowedFiles.length ? "parallel_group_scope_violation" : "parallel_lock_violation");
      }
      const evidence = [
        groupRejected ? `Group check: rejected; error type: ${entry.result.errorType}` : "",
        groupReport?.headChanged ? `HEAD changed: yes (${groupReport.expectedHead} -> ${groupReport.actualHead})` : "",
        groupReport?.disallowedFiles.length ? `Disallowed files: ${compactFileList(groupReport.disallowedFiles)}; Rollback: ${groupReport.rollback}` : "",
        groupReport?.checkFailed ? `Group check failed: ${groupReport.errorType}: ${groupReport.error}` : "",
        individualViolations.length ? `Lock verification: ${individualViolations.join("; ")}` : "",
        overlap ? "Lock verification: multiple parallel jobs changed the same file." : "",
        acquiredLocks[index] ? `Temporary lock released: ${lockRelease?.released ? "yes" : `no${lockRelease?.error ? ` (${lockRelease.error})` : ""}`}` : "",
      ].filter(Boolean).join("\n");
      if (entry.parts) {
        const status = compactJobLines({ resolution: parallelResolutions[index], result: entry.result, unsafeFiles: entry.unsafeFiles || [] }).find(line => line.startsWith("Status:"));
        entry.parts.head = entry.parts.head.replace(/^Status:.*$/m, status);
        entry.parts.tail = [entry.parts.tail, evidence].filter(Boolean).join("\n");
        entry.detailText = [`Temporary lock acquired: ${hardLockSummary(acquiredLocks[index])}`,
          formatSingleResultParts({ resolution: parallelResolutions[index], result: entry.result, cwd, lockPlan: entry.lockPlan }).preamble.trimEnd(),
          entry.worktreeDetail, evidence, groupRejected && groupReport ? `Group check detail: ${JSON.stringify(groupReport)}` : ""].filter(Boolean).join("\n");
      }
      const fitted = fitRedactedJobResult(entry.parts || { head: entry.text, report: "", tail: evidence });
      entry.parts = fitted.parts;
      entry.text = fitted.text;
      return parallelAudit.finish(parallelAuditHandles[index], {
        execution: { result: entry.result || {} }, childStarted: parallelChildSpawned[index],
        errorType: entry.result?.errorType || (entry.unsafeFiles?.length ? "changed_file_validation_error" : ""),
        stored: { text: fitted.text, detailText: entry.detailText || "", chars: fitted.chars, reportTruncated: fitted.reportTruncated },
        signal: extra.signal,
      });
    }));
    results.forEach((entry, position) => { entry.auditNotice = parallelAudit.notice(parallelAudits[position]); });
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
          `Changed files: ${report.changedFiles.length ? compactFileList(report.changedFiles) : "none detected"}`,
          report.externalDriftFiles?.length ? `External changes (another client; the attested readers cannot edit): ${compactFileList(report.externalDriftFiles)}` : null,
          `HEAD changed: ${report.headChanged ? `yes (${report.expectedHead} -> ${report.actualHead})` : "no"}`,
          `Disallowed files: ${report.disallowedFiles.length ? compactFileList(report.disallowedFiles) : "none detected"}`,
          `Serial-only matches: ${report.serialOnlyMatches.length ? compactFileList(report.serialOnlyMatches) : "none detected"}`,
          `Rollback: ${report.rollback}`,
          `Rollback files: ${report.rollbackFiles.length ? compactFileList(report.rollbackFiles) : "none"}`,
          `Unresolved files: ${report.unresolvedFiles.length ? compactFileList(report.unresolvedFiles) : "none"}`,
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

    const separator = "\n\n====================\n\n";
    const summary = fitRedactedJobResult({ head: [
      `Parallel group status: ${groupStatus}`,
      `Group deadline ms: ${groupDeadlineMs} (longest agent budget plus validation timeout, plus margin)${groupDeadlineExpired ? "; the deadline expired and aborted the remaining work" : ""}`,
      `Ran concurrently (OpenCode child interval overlap): ${ranConcurrently ? "yes" : "no"}`,
      `Concurrent execution pairs: ${executionOverlap.pairs.length ? executionOverlap.pairs.map(([left, right]) => `JOB ${left + 1} + JOB ${right + 1}`).join(", ") : "none"}`,
      "Cancellation: this synchronous tool has no durable operation id; use queue/pipeline tools when cancellation or restart-safe status is required.",
      "Parallel response limit: 60000 characters; get_opencode_job with each job's Run id retrieves its stored result and any retained detail.",
    ].join("\n"), report: "", tail: [verification, rollbackVerification, worktreeCleanupVerification].join(separator) }, 12000).text;
    const jobBudget = Math.max(0, Math.floor((60000 - summary.length - separator.length * results.length) / results.length));
    const blocks = results.map(entry => fitResultParts({ ...entry.parts,
      tail: redactSensitiveText([entry.parts.tail, detail && entry.detailText ? `Bridge detail (get_opencode_job with detail: true returns any retained detail later):\n${entry.detailText}` : "", entry.auditNotice].filter(Boolean).join("\n")),
    }, Math.min(CONFIG.queueResultMaxChars, jobBudget)).text);
    return {
      content: [
        {
          type: "text",
          text: [summary, ...blocks].join(separator),
        },
      ],
    };
  })
);
}
