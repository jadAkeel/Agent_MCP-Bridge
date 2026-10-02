// MCP tools: integrate one worktree or a batch of worktrees (dry run, receipt, apply).
// Extracted from server.js in modularization round M-001.

import { integrationBatchItemSchema, integrationPreviewReceiptSchema } from "../integration.js";
import { mergePathLists, normalizeLockPathList } from "../paths.js";
import { nextPipelineIntegrationItemStatus, pipelineIntegrationItemMatches, pipelineTerminalError } from "../pipelines.js";
import { formatValidationGateResult } from "../validation-command.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function registerIntegrationTools({ INTEGRATION_BATCH_MAX_ITEMS, PIPELINE_INTEGRATION_CLOSED_STATUSES, PIPELINE_RUNS, authoritativePipelineRecord, claimPersistedPipeline, formatIntegrationTargetMove, formatIntegrationTimings, formatRejectedExecution, integratePatchSerially, integrationTimingStorage, isBridgeGeneratedWorktree, loadProjectAgentPolicy, nowMs, pipelineOwnedByThisInstance, pipelineOwnerRejection, reconcilePipelineIntegrationOperationStates, refreshPipelineRecord, resolveProjectStateRoot, server, updatePipelineRecord }) {
server.tool(
  "integrate_opencode_worktree",
  "Serially integrate one OpenCode worktree or branch after ownership, patch, conflict, and validation checks. A dry run returns a previewReceipt that the apply must present; the receipt survives a target HEAD that only moved forward past commits touching none of the patched paths between the two calls, and is otherwise integration_preview_stale. To land several disjoint worktrees in one dry run and one apply, use integrate_opencode_worktrees.",
  {
    cwd: z.string().min(1).describe("Canonical target repository path where the patch should be checked or applied."),
    pipelineId: z.string().optional().describe("Optional pipeline id to append this integration result to its audit trail."),
    worktreePath: z.string().optional().describe("OpenCode worktree path containing uncommitted changes to integrate."),
    branch: z.string().optional().describe("Branch containing committed changes to integrate. Use worktreePath for uncommitted worktree output."),
    allowedEdits: z.array(z.string()).min(1).describe("Exact file or directory paths this integration may change."),
    forbiddenEdits: z.array(z.string()).optional().describe("Paths that must not change."),
    sharedFiles: z.array(z.string()).optional().describe("Shared/frozen paths that must not change during this integration."),
    serialOnly: z.array(z.string()).optional().describe("Serial-only paths. A single integration is already serial, so they refuse nothing here; integrate_opencode_worktrees refuses a batch of two or more items that changes one."),
    validationCommand: z.string().optional().describe("Command to run after applying the patch. Parsed without a shell."),
    dryRun: z.boolean().optional().describe("Check source paths and merge conflicts without applying the patch."),
    reviewed: z.boolean().optional().describe("Required true for non-dry-run integration after Codex reviews the patch preview."),
    previewReceipt: integrationPreviewReceiptSchema.optional().describe("Exact identity receipt returned by the reviewed dry run. Required for apply."),
    cleanupAfterSuccess: z.boolean().optional().describe("Remove the source worktree and its local branch only after reviewed integration and a passing validationCommand. Defaults to true for worktrees the bridge created; pass false to keep the source."),
    allowDirtyTarget: z.boolean().optional().describe("Allow integration into a target repo that already has changes. Defaults to false."),
    acceptFlaggedSecretLines: z.boolean().optional().describe("Dry run only: issue the receipt even though the secret gate flagged patch lines, after you inspected those lines in the worktree and found no real credential. Defaults to false."),
    acceptBinaryHunks: z.boolean().optional().describe("Dry run only: issue the receipt although the patch has binary hunks for files without a known binary extension, after you inspected those files in the worktree. Defaults to false."),
    previewMode: z.enum(["full", "stat"]).optional().describe("Dry run output: full (default) prints the whole patch; stat prints per-file line counts and the patch SHA-256, for callers that already read the diff in the worktree. The receipt is the same."),
  },
  async ({
    cwd = "",
    pipelineId = "",
    worktreePath = "",
    branch = "",
    allowedEdits,
    forbiddenEdits = [],
    sharedFiles = [],
    serialOnly = [],
    validationCommand = "",
    dryRun = false,
    reviewed = false,
    previewReceipt = null,
    cleanupAfterSuccess = undefined,
    allowDirtyTarget = false,
    acceptFlaggedSecretLines = false,
    acceptBinaryHunks = false,
    previewMode = "full",
  }) => {
    const started = nowMs();
    let pipeline = null;
    let pipelineItem = null;
    let validationTrustedSpec = null;
    let validationPolicyTrust = null;
    if (pipelineId) {
      const requestedProjectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
      pipeline = await authoritativePipelineRecord(pipelineId, requestedProjectRoot || cwd);
      if (!pipeline) {
        return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
      }
      if (!pipelineOwnedByThisInstance(pipeline)) {
        const claim = await claimPersistedPipeline(pipeline);
        if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(pipeline, "integration") }] };
      }
      if (!PIPELINE_RUNS.has(pipelineId)) PIPELINE_RUNS.set(pipelineId, pipeline);
      await refreshPipelineRecord(pipeline);
      await reconcilePipelineIntegrationOperationStates(pipeline);
      if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(pipeline.status)) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_terminal",
          reason: `The pipeline is ${pipeline.status}; an abandoned, failed or completed pipeline does not integrate any more.`,
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Nothing was applied. To use this worktree's change anyway, integrate it without pipelineId after reviewing it, or start a new pipeline.",
        }) }] };
      }
      const candidates = (pipeline.integrationQueue || []).filter((item) => pipelineIntegrationItemMatches(pipeline, item, { worktreePath, branch }));
      if (candidates.length !== 1 || !["pending", "integrating"].includes(candidates[0].status)) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_integration_item_invalid",
          reason: candidates.length !== 1
            ? "The source did not identify exactly one planned pipeline integration item."
            : `The matched integration item is ${candidates[0].status}, not pending or durably recovering.`,
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Use the exact retained worktree/branch reported by the completed pipeline queue item and do not replay an integration.",
        }) }] };
      }
      pipelineItem = candidates[0];
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pipelineItem.sourceBaseCommit || "")
        || !/^[a-f0-9]{64}$/i.test(pipelineItem.patchSha256 || "")
        || !/^[a-f0-9]{64}$/i.test(pipelineItem.sourceStateSha256 || "")) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_source_identity_unattested",
          reason: "The completed queue item lacks an exact base/patch/source-state identity.",
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Re-run this writer with the hardened bridge; legacy or incomplete records are audit-only and cannot be integrated.",
        }) }] };
      }
      cwd = pipeline.cwd;
      allowedEdits = [...(pipelineItem.allowedEdits || [])];
      forbiddenEdits = mergePathLists(pipelineItem.forbiddenEdits, pipeline.policy?.path);
      sharedFiles = [...(pipelineItem.sharedFiles || [])];
      serialOnly = [...(pipelineItem.serialOnly || [])];
      validationCommand = String(pipelineItem.validationCommand || "").trim();
      validationTrustedSpec = pipelineItem.validationSpec || null;
      const validationSource = String(pipelineItem.validationSource || "");
      const validationSourceValid = ["job", "caller", "policy"].includes(validationSource);
      if ((validationCommand && !validationSourceValid)
        || (!validationCommand && validationSource && validationSource !== "none")
        || (validationSource === "policy" && (!pipeline.policy?.path || !validationTrustedSpec))) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "policy_validation_command_untrusted",
          reason: "This integration item has missing, unknown, or inconsistent validation-command provenance. Policy commands also require their exact trusted executable/vector attestation. Legacy records are audit-only.",
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Create a new pipeline with the hardened bridge; the existing worktree was retained.",
        }) }] };
      }
      if (validationTrustedSpec) {
        const currentPolicy = pipeline.policy?.path ? await loadProjectAgentPolicy(pipeline.cwd, pipeline.policy.path) : { ok: false };
        const trustedNow = currentPolicy.ok
          && currentPolicy.sha256 === pipeline.policy?.sha256
          && currentPolicy.policy?.finalValidationSpec?.commandSha256 === validationTrustedSpec.commandSha256;
        if (!trustedNow) {
          return { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Pipeline integration rejected.",
            errorType: "policy_validation_command_untrusted",
            reason: currentPolicy.error || "Project policy trust, bytes, executable hash, or exact validation vector changed before integration.",
            requestedAgent: "merge_manager",
            actualAgent: "none",
            suggestedFix: "Re-approve the exact policy and executable hashes, then create a new pipeline. The existing source was retained.",
          }) }] };
        }
        validationPolicyTrust = {
          path: pipeline.policy.path,
          sha256: pipeline.policy.sha256,
          commandSha256: validationTrustedSpec.commandSha256,
        };
      }
    }
    const effectiveCleanupAfterSuccess = cleanupAfterSuccess ?? isBridgeGeneratedWorktree(cwd || process.cwd(), worktreePath);
    const integrationTimings = {};
    const integrationStarted = nowMs();
    const result = await integrationTimingStorage.run(integrationTimings, () => integratePatchSerially({
      cwd: cwd || process.cwd(),
      worktreePath,
      branch,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      validationTrustedSpec,
      validationPolicyTrust,
      dryRun,
      reviewed,
      previewReceipt,
      allowDirtyTarget,
      acceptFlaggedSecretLines,
      acceptBinaryHunks,
      previewMode,
      cleanupAfterSuccess: effectiveCleanupAfterSuccess,
      deferCleanup: Boolean(pipelineId),
      pipelineId,
      pipelineJobId: pipelineItem?.jobId || "",
      onIntegrationPrepared: pipeline ? async ({ operationId }) => {
        await updatePipelineRecord(pipeline, (current) => {
          // Thrown before the patch is written: the prepared journal operation is recovered as
          // a no-op by the integration's finally block.
          if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status)) throw pipelineTerminalError(current);
          return {
          integrationQueue: (current.integrationQueue || []).map((item) => pipelineIntegrationItemMatches(current, item, { worktreePath, branch })
            ? { ...item, status: "integrating", operationId }
            : item),
          events: (current.events || []).concat({
            type: "integration_prepared",
            at: new Date().toISOString(),
            operationId,
            jobId: pipelineItem?.jobId || "",
          }),
          };
        });
        pipelineItem = (pipeline.integrationQueue || []).find((item) => item.operationId === operationId) || pipelineItem;
      } : null,
      expectedSourceIdentity: pipelineItem ? {
        sourceBaseCommit: pipelineItem.sourceBaseCommit,
        patchSha256: pipelineItem.patchSha256,
        sourceStateSha256: pipelineItem.sourceStateSha256,
      } : null,
    }));
    result.timings = { totalMs: Math.round(nowMs() - integrationStarted), phases: { ...integrationTimings } };
    if (pipelineId) {
      if (pipeline && result.errorType !== "pipeline_terminal") {
        // Computed from the record as it stands when the write runs, so a concurrent
        // integration of another item on this pipeline keeps its own item update.
        await updatePipelineRecord(pipeline, (current) => {
          const integrated = !dryRun && Boolean(result.ok && ["applied", "no_changes"].includes(result.status));
          const integrationQueue = (current.integrationQueue || []).map((item) => {
            // A dry run changes nothing about the item: its outcome is only an event.
            if (dryRun || !pipelineIntegrationItemMatches(current, item, { worktreePath, branch })) return item;
            return {
              ...item,
              status: nextPipelineIntegrationItemStatus(item, result),
              errorType: result.errorType || "",
              operationId: result.operationId || item.operationId || "",
              noChanges: result.ok && result.status === "no_changes" ? true : Boolean(item.noChanges),
              cleanupRequested: Boolean(result.ok && result.status === "applied" && result.validationGate?.status === "passed" && effectiveCleanupAfterSuccess && worktreePath),
              // A failed attempt returns only part of the source identity; the item keeps the
              // attested identity a retry is checked against.
              sourceBaseCommit: result.sourceBaseCommit || item.sourceBaseCommit || "",
              patchSha256: result.patchSha256 || item.patchSha256 || "",
              sourceStateSha256: result.sourceStateSha256 || item.sourceStateSha256 || "",
            };
          });
          const allIntegrated = integrationQueue.length && integrationQueue.every((item) => item.status === "integrated");
          const reopen = integrated && allIntegrated && !PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status);
          return {
            status: reopen ? "awaiting_finalization" : current.status,
            finishedAt: reopen ? "" : current.finishedAt,
            integrationQueue,
            events: (current.events || []).concat({
              type: "integration",
              at: new Date().toISOString(),
              ok: Boolean(result.ok),
              dryRun: Boolean(dryRun),
              status: result.status || "rejected",
              errorType: result.errorType || "",
              sourceType: result.sourceType || (worktreePath ? "worktree" : branch ? "branch" : "unknown"),
              source: result.source || worktreePath || branch || "",
              changedFiles: result.changedFiles || [],
              appliedFiles: result.appliedFiles || [],
              operationId: result.operationId || pipelineItem?.operationId || "",
            }),
            errors: result.ok ? current.errors || [] : (current.errors || []).concat({
              type: "integration",
              errorType: result.errorType || "integration_rejected",
              error: result.error || "",
              dryRun: Boolean(dryRun),
            }),
          };
        });
      }
    }

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Serial integration rejected.",
                errorType: result.errorType || "integration_rejected",
                reason: result.error || "Integration failed.",
                requestedAgent: "merge_manager",
                actualAgent: "none",
                lockMode: "serial_integration",
                durationMs: nowMs() - started,
                conflictingPaths: result.conflictingPaths || result.disallowedFiles || result.changedFiles || [],
                allowedEdits,
                rollback: result.rollback?.rollback || "",
                rollbackFiles: result.rollback?.rollbackFiles || [],
                unresolvedFiles: result.rollback?.unresolvedFiles || [],
                suggestedFix: result.suggestedFix || "Resolve conflicts, narrow allowedEdits, move shared/global files to a serial contract step, or rerun with a passing validation command.",
              }),
              result.validationGate ? formatValidationGateResult(result.validationGate) : null,
              formatIntegrationTimings(result.timings),
            ].filter(Boolean).join("\n\n"),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "Serial integration accepted.",
            "",
            `Status: ${result.status}`,
            `Source type: ${result.sourceType || "unknown"}`,
            `Source: ${result.source || "not specified"}`,
            `Dry run: ${result.dryRun ? "yes" : "no"}`,
            result.targetMovedSincePreview ? formatIntegrationTargetMove(result.targetMovedSincePreview) : null,
            `Changed files from source: ${result.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
            `Applied files: ${result.appliedFiles?.length ? result.appliedFiles.join(", ") : "none"}`,
            `Pre-existing target changes: ${result.preExistingTargetChanges?.length ? result.preExistingTargetChanges.join(", ") : "none"}`,
            `Dirty target explicitly allowed: ${result.allowDirtyTarget ? "yes (rollback cannot cover unrelated external mutations)" : "no"}`,
            result.patchSha256 ? `Patch SHA-256: ${result.patchSha256}` : null,
            result.sourceBaseCommit ? `Source base commit: ${result.sourceBaseCommit}` : null,
            result.sourceStateSha256 ? `Source state SHA-256: ${result.sourceStateSha256}` : null,
            result.targetStateSha256 ? `Target state SHA-256: ${result.targetStateSha256}` : null,
            result.contractSha256 ? `Integration contract SHA-256: ${result.contractSha256}` : null,
            result.previewReceipt ? `Preview receipt: ${JSON.stringify(result.previewReceipt)}` : null,
            // A dry run printed the whole patch every time (6-13k characters per job) even when
            // the caller had read the diff in the worktree already; stat mode prints line counts.
            previewMode === "stat" && result.patchStat ? `Patch stat (previewMode stat; the receipt covers the full patch):\n${result.patchStat}` : null,
            previewMode !== "stat" && result.patchPreviewMaskedLines?.length ? `Patch preview masks the flagged values on patch lines ${result.patchPreviewMaskedLines.slice(0, 10).join(", ")}${result.patchPreviewMaskedLines.length > 10 ? ", ..." : ""} (acceptFlaggedSecretLines); the receipt covers the full unmasked patch SHA-256.` : null,
            previewMode !== "stat" && result.patchPreview ? `Patch preview:\n${result.patchPreview}` : null,
            previewMode !== "stat" && result.patchPreviewTruncated ? "Patch preview truncated: yes (apply remains blocked on the full patch SHA-256)" : null,
            `Allowed edits: ${normalizeLockPathList(allowedEdits).join(", ")}`,
            `Forbidden edits: ${normalizeLockPathList(forbiddenEdits).length ? normalizeLockPathList(forbiddenEdits).join(", ") : "none specified"}`,
            `Shared files frozen: ${normalizeLockPathList(sharedFiles).length ? normalizeLockPathList(sharedFiles).join(", ") : "none specified"}`,
            result.sourceCleanup ? `Source worktree cleanup: ${result.sourceCleanup.cleanup}` : "Source worktree cleanup: not requested",
            result.sourceCleanup?.branchCleanup ? `Source branch cleanup: ${result.sourceCleanup.branchCleanup}` : null,
            result.sourceCleanup?.reason ? `Source worktree cleanup reason: ${result.sourceCleanup.reason}` : null,
            result.cleanupWarning ? `Cleanup warning: ${result.cleanupWarning}` : null,
            formatValidationGateResult(result.validationGate),
            formatIntegrationTimings(result.timings),
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

function formatIntegrationBatchSummary(result, allowedEditsByItem = []) {
  const items = Array.isArray(result.batchItems) ? result.batchItems : [];
  const itemLines = items.map((item) => {
    const cleanup = item.sourceCleanup ? ` [cleanup: ${item.sourceCleanup.cleanup}${item.sourceCleanup.reason ? ` (${item.sourceCleanup.reason})` : ""}]` : "";
    return `  ${item.index}. ${item.source}: ${item.changedFiles.join(", ")} (patch ${item.patchSha256.slice(0, 12)})${cleanup}`;
  });
  return {
    itemLines,
    scopeLine: `Allowed edits per item: ${allowedEditsByItem.map((edits, index) => `${index + 1}: ${normalizeLockPathList(edits).join(", ")}`).join("; ")}`,
  };
}

server.tool(
  "integrate_opencode_worktrees",
  `Serially integrate SEVERAL disjoint OpenCode worktrees or branches (at most ${INTEGRATION_BATCH_MAX_ITEMS}) as ONE all-or-nothing operation with one receipt. dryRun: true collects and checks every item (scope per item, no two items touching the same path, the combined patch applies) and returns one previewReceipt bound to all of them; the apply passes the same items and arguments plus reviewed: true and that receipt, and either lands every item as one journaled operation (one validationCommand run after all are applied, one rollback if it fails) or applies none. forbiddenEdits, sharedFiles, serialOnly, validationCommand, allowDirtyTarget and cleanupAfterSuccess apply to the whole batch; allowedEdits is per item. A source that changed nothing, or two items writing the same path, refuses the batch. A target HEAD that moves past commits touching none of the patched paths between the dry run and the apply does not invalidate the receipt. Not available for pipeline items (use integrate_opencode_worktree with pipelineId).`,
  {
    cwd: z.string().min(1).describe("Canonical target repository path where the patches should be checked or applied."),
    items: z.array(integrationBatchItemSchema).min(1).max(INTEGRATION_BATCH_MAX_ITEMS).describe(`The worktrees/branches to integrate, in the order they are reviewed (the receipt binds the order). 1 to ${INTEGRATION_BATCH_MAX_ITEMS} items, pairwise disjoint paths.`),
    forbiddenEdits: z.array(z.string()).optional().describe("Paths that must not change in any item."),
    sharedFiles: z.array(z.string()).optional().describe("Shared/frozen paths that must not change in any item."),
    serialOnly: z.array(z.string()).optional().describe("Serial-only paths (globs allowed) that must not be integrated as part of a batch: a batch of two or more items that changes one is refused (serial_only_parallel_write); integrate that item alone."),
    validationCommand: z.string().optional().describe("Command run ONCE after every item is applied. Parsed without a shell. If it fails, no item stays applied."),
    dryRun: z.boolean().optional().describe("Check every item and the combined patch without applying anything; returns the batch previewReceipt."),
    reviewed: z.boolean().optional().describe("Required true for non-dry-run integration after the patches were reviewed."),
    previewReceipt: integrationPreviewReceiptSchema.optional().describe("Exact receipt returned by the batch dry run. Required for apply; valid only for the same items, in the same order, with the same arguments."),
    cleanupAfterSuccess: z.boolean().optional().describe("Remove each source worktree and its local branch after the batch passed a validationCommand. Defaults to true for the worktrees the bridge created; pass false to keep all."),
    allowDirtyTarget: z.boolean().optional().describe("Allow integration into a target repo that already has changes (none of them on the batch's paths). Defaults to false."),
    acceptFlaggedSecretLines: z.boolean().optional().describe("Dry run only: issue the receipt although the secret gate flagged patch lines, after you inspected those lines in the named item's worktree and found no real credential. Defaults to false."),
    acceptBinaryHunks: z.boolean().optional().describe("Dry run only: issue the receipt although the combined patch has binary hunks for files without a known binary extension, after you inspected those files. Defaults to false."),
    previewMode: z.enum(["full", "stat"]).optional().describe("Dry run output: full (default) prints the whole combined patch, subject to the preview size cap; stat prints per-file line counts and the patch SHA-256. The receipt is the same."),
  },
  async ({
    cwd = "",
    items = [],
    forbiddenEdits = [],
    sharedFiles = [],
    serialOnly = [],
    validationCommand = "",
    dryRun = false,
    reviewed = false,
    previewReceipt = null,
    cleanupAfterSuccess = undefined,
    allowDirtyTarget = false,
    acceptFlaggedSecretLines = false,
    acceptBinaryHunks = false,
    previewMode = "full",
  }) => {
    const started = nowMs();
    const targetCwd = cwd || process.cwd();
    const batchItems = (Array.isArray(items) ? items : []).map((item) => ({
      worktreePath: item?.worktreePath || "",
      branch: item?.branch || "",
      allowedEdits: item?.allowedEdits || [],
      cleanup: cleanupAfterSuccess ?? isBridgeGeneratedWorktree(targetCwd, item?.worktreePath),
    }));
    const integrationTimings = {};
    const integrationStarted = nowMs();
    const result = await integrationTimingStorage.run(integrationTimings, () => integratePatchSerially({
      cwd: targetCwd,
      batch: { items: batchItems },
      allowedEdits: batchItems.flatMap((item) => item.allowedEdits),
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      dryRun,
      reviewed,
      previewReceipt,
      allowDirtyTarget,
      acceptFlaggedSecretLines,
      acceptBinaryHunks,
      previewMode,
    }));
    result.timings = { totalMs: Math.round(nowMs() - integrationStarted), phases: { ...integrationTimings } };
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Serial batch integration rejected.",
                errorType: result.errorType || "integration_rejected",
                reason: result.error || "Integration failed.",
                requestedAgent: "merge_manager",
                actualAgent: "none",
                lockMode: "serial_integration",
                durationMs: nowMs() - started,
                conflictingPaths: result.overlappingPaths?.map((conflict) => conflict.path) || result.conflictingPaths || result.disallowedFiles || result.changedFiles || [],
                allowedEdits: normalizeLockPathList(batchItems.flatMap((item) => item.allowedEdits)),
                rollback: result.rollback?.rollback || "",
                rollbackFiles: result.rollback?.rollbackFiles || [],
                unresolvedFiles: result.rollback?.unresolvedFiles || [],
                suggestedFix: result.suggestedFix || "Fix or remove the item named in the reason and dry-run the batch again; nothing was applied unless the reason says an operation needs recovery.",
              }),
              result.batchItemNumbers?.length ? `Batch item number(s) involved: ${result.batchItemNumbers.join(", ")}` : null,
              result.validationGate ? formatValidationGateResult(result.validationGate) : null,
              formatIntegrationTimings(result.timings),
            ].filter(Boolean).join("\n\n"),
          },
        ],
      };
    }

    const summary = formatIntegrationBatchSummary(result, batchItems.map((item) => item.allowedEdits));
    return {
      content: [
        {
          type: "text",
          text: [
            "Serial batch integration accepted.",
            "",
            `Status: ${result.status}`,
            `Items: ${result.batchItems?.length || 0}`,
            `Dry run: ${result.dryRun ? "yes" : "no"}`,
            result.targetMovedSincePreview ? formatIntegrationTargetMove(result.targetMovedSincePreview) : null,
            ...summary.itemLines,
            `Changed files from all items: ${result.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
            `Applied files: ${result.appliedFiles?.length ? result.appliedFiles.join(", ") : "none"}`,
            `Pre-existing target changes: ${result.preExistingTargetChanges?.length ? result.preExistingTargetChanges.join(", ") : "none"}`,
            `Dirty target explicitly allowed: ${result.allowDirtyTarget ? "yes (rollback cannot cover unrelated external mutations)" : "no"}`,
            result.patchSha256 ? `Combined patch SHA-256: ${result.patchSha256}` : null,
            result.sourceBaseCommit ? `Source base commit: ${result.sourceBaseCommit}` : null,
            result.sourceStateSha256 ? `Source state SHA-256 (all items): ${result.sourceStateSha256}` : null,
            result.targetStateSha256 ? `Target state SHA-256: ${result.targetStateSha256}` : null,
            result.contractSha256 ? `Integration contract SHA-256: ${result.contractSha256}` : null,
            result.operationId ? `Integration operation: ${result.operationId} (${result.journalStatus || "unknown"})` : null,
            result.previewReceipt ? `Preview receipt: ${JSON.stringify(result.previewReceipt)}` : null,
            previewMode === "stat" && result.patchStat ? `Patch stat (previewMode stat; the receipt covers the full combined patch):\n${result.patchStat}` : null,
            previewMode !== "stat" && result.patchPreviewMaskedLines?.length ? `Patch preview masks the flagged values on combined patch lines ${result.patchPreviewMaskedLines.slice(0, 10).join(", ")}${result.patchPreviewMaskedLines.length > 10 ? ", ..." : ""} (acceptFlaggedSecretLines); the receipt covers the full unmasked patch SHA-256.` : null,
            previewMode !== "stat" && result.patchPreview ? `Patch preview:\n${result.patchPreview}` : null,
            summary.scopeLine,
            `Forbidden edits: ${normalizeLockPathList(forbiddenEdits).length ? normalizeLockPathList(forbiddenEdits).join(", ") : "none specified"}`,
            `Shared files frozen: ${normalizeLockPathList(sharedFiles).length ? normalizeLockPathList(sharedFiles).join(", ") : "none specified"}`,
            result.sourceCleanup ? `Source worktree cleanup: ${result.sourceCleanup.cleanup} (${result.sourceCleanup.removed} of ${result.sourceCleanup.requested} removed)` : "Source worktree cleanup: not requested",
            result.cleanupWarning ? `Cleanup warning: ${result.cleanupWarning}` : null,
            formatValidationGateResult(result.validationGate),
            formatIntegrationTimings(result.timings),
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);
  return { formatIntegrationBatchSummary };
}
