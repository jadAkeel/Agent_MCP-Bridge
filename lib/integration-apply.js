// Integration apply: the locked dry run and apply of a reviewed patch, validation, rollback and worktree cleanup.
// Extracted from server.js in modularization round M-001.

import { rm } from "node:fs/promises";
import path from "node:path";
import { binaryTextFilesInPatch, diffStatFromPatch, patchFileEntries } from "./git-patch.js";
import { integrationBatchItemAtLine, integrationContractSha256, integrationContractValue, integrationRecoveryErrorIsTransient, integrationScopePlan, patchedPathsStateSha256Of } from "./integration.js";
import { normalizeLockPathList, normalizeLockPathListForCwd, overlaps } from "./paths.js";
import { patchLikelySecretLines, redactLikelySecrets, redactSensitiveText } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createIntegrationApplyRuntime({ CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, abortSignalErrorType, applyPatchFile, captureGitHead, captureGitIndexIdentity, captureIntegrationTargetState, captureIntegrationSourceProof, integrationPreviewReuse, capturePatchedPathsState, captureRollbackBaseline, changedFileValidationErrorType, changedFilesBetween, changedPathSetEvidence, checkPatchApplies, cleanupWorktree, closeDb, collectIntegrationBatchPatch, collectIntegrationPatch, exactIntegrationFileSnapshot, filterGeneratedWorktreeFiles, gitChangedFileSnapshot, gitChangedFiles, gitIndexPathSnapshot, inspectRepositoryOperationState, integrationContentMismatches, integrationPreviewReceiptError, integrationRecoveryErrorText, isolatedIndexPreservationEvidence, loadProjectAgentPolicy, logEvent, makeIntegrationPreviewReceipt, openLockDb, prepareIntegrationOperation, quarantineIntegrationOperation, recoverIntegrationOperationsWhileLocked, rollbackVerifiedOwnedChanges, runCommand, runValidationGate, simulateIntegrationPatchSnapshot, snapshotIdentitySha256, snapshotMismatches, transitionIntegrationOperation, validateChangedFilesForPlan, writeTemporaryPatchFile }) {
let integrationScratchCleanupTestHook = null;
// Self-test access to the state above (the module owns it since the split).
function getIntegrationScratchCleanupTestHook() { return integrationScratchCleanupTestHook; }
function setIntegrationScratchCleanupTestHook(value) { integrationScratchCleanupTestHook = value; }

async function integratePatchWithoutSerialLock({
  cwd,
  worktreePath = "",
  branch = "",
  allowedEdits = [],
  forbiddenEdits = [],
  sharedFiles = [],
  serialOnly = [],
  validationCommand = "",
  validationTrustedSpec = null,
  validationPolicyTrust = null,
  dryRun = false,
  allowDirtyTarget = false,
  cleanupAfterSuccess = false,
  acceptFlaggedSecretLines = false,
  acceptBinaryHunks = false,
  reviewed = false,
  previewReceipt = null,
  expectedSourceIdentity = null,
  beforeApplyHook = null,
  beforeValidationHook = null,
  onIntegrationPrepared = null,
  pipelineId = "",
  pipelineJobId = "",
  signal = null,
  integrationLock = null,
  previewMode = "full",
  batch = null,
}) {
  const requestedCwd = path.resolve(cwd || process.cwd());
  const targetRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], requestedCwd, 1000 * 15);
  if (targetRoot.exitCode !== 0 || !targetRoot.stdout.trim()) {
    return {
      ok: false,
      errorType: "integration_target_invalid",
      error: targetRoot.stderr || "Integration target is not inside a Git repository.",
    };
  }
  const targetCwd = path.resolve(targetRoot.stdout.trim());
  // I-002: a batch carries its own items; allowedEdits is then the union the serial lock covers.
  const batchItems = Array.isArray(batch?.items) && batch.items.length ? batch.items : null;
  if (batch && !batchItems) {
    return { ok: false, errorType: "integration_batch_empty", error: "A batch integration needs at least one item." };
  }
  if (signal?.aborted) {
    return {
      ok: false,
      errorType: abortSignalErrorType(signal, "integration_lock_ownership_lost"),
      error: signal.reason?.message || "The serial integration lease was lost before target inspection.",
    };
  }
  // G-10: checked before either capture so a dry run never issues a receipt for such a target.
  const operationState = await inspectRepositoryOperationState(targetCwd);
  if (!operationState.ok) return operationState;

  // B-194: prove source bytes independently of Git's stat cache. A changed or
  // unreadable proof, a different target, or an absent preview uses the full path.
  const sourceOptions = { cwd: targetCwd, worktreePath, batch };
  const sourceProof = (dryRun || reviewed) ? await captureIntegrationSourceProof(sourceOptions) : null;
  const cachedPreview = !dryRun && reviewed ? integrationPreviewReuse(previewReceipt, targetCwd) : null;
  let previewReused = Boolean(sourceProof && cachedPreview?.sourceProof === sourceProof);
  const collectPatch = () => batchItems
    ? collectIntegrationBatchPatch({ cwd: targetCwd, items: batchItems,
        sourceBaseCommit: previewReceipt?.sourceBaseCommit || "", forbiddenEdits, sharedFiles, serialOnly })
    : collectIntegrationPatch({ cwd: targetCwd, worktreePath, branch,
        sourceBaseCommit: expectedSourceIdentity?.sourceBaseCommit || previewReceipt?.sourceBaseCommit || "" });

  // B-026: the target identity and the source patch each rehash a whole tree (12-19 s on a
  // 22,708-file repository). They read different trees and neither writes, so they run together;
  // the target result still decides first, as when they ran one after the other.
  const [targetCapture, patchCapture, pathsCapture] = await Promise.allSettled([
    captureIntegrationTargetState(targetCwd),
    previewReused ? Promise.resolve(cachedPreview.patch) : collectPatch(),
    previewReused
      ? capturePatchedPathsState(targetCwd, cachedPreview.targetState.targetHead, cachedPreview.patch.changedFiles)
      : Promise.resolve(null),
  ]);
  if (targetCapture.status === "rejected") throw targetCapture.reason;
  const targetState = targetCapture.value;
  if (!targetState.ok) return targetState;
  if (patchCapture.status === "rejected") throw patchCapture.reason;
  let patch = patchCapture.value;
  if (previewReused && (targetState.targetHead !== cachedPreview.targetState.targetHead
    || targetState.targetStateSha256 !== cachedPreview.targetState.targetStateSha256
    || pathsCapture.status !== "fulfilled" || !pathsCapture.value?.ok
    || pathsCapture.value.sha256 !== previewReceipt?.patchedPathsStateSha256)) {
    previewReused = false;
    patch = await collectPatch();
  }
  if (!patch.ok) {
    return patch;
  }
  if (expectedSourceIdentity) {
    const sourceMatches = patch.sourceBaseCommit === expectedSourceIdentity.sourceBaseCommit
      && patch.patchSha256 === expectedSourceIdentity.patchSha256
      && patch.sourceStateSha256 === expectedSourceIdentity.sourceStateSha256;
    if (!sourceMatches) {
      return {
        ok: false,
        errorType: "pipeline_source_identity_changed",
        error: "The pipeline worktree changed after its completed queue result. Re-run the writer and review a new pipeline output; the mutated source was not applied.",
        changedFiles: patch.changedFiles,
        expectedSourceIdentity,
        actualSourceIdentity: {
          sourceBaseCommit: patch.sourceBaseCommit,
          patchSha256: patch.patchSha256,
          sourceStateSha256: patch.sourceStateSha256,
        },
      };
    }
  }

  const contract = integrationContractValue({
    cwd: targetCwd,
    worktreePath,
    branch,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    validationCommand,
    allowDirtyTarget,
    cleanupAfterSuccess,
    items: batchItems,
  });
  const contractSha256 = integrationContractSha256(contract);
  const currentPreviewIdentity = {
    patchSha256: patch.patchSha256,
    sourceBaseCommit: patch.sourceBaseCommit,
    sourceStateSha256: patch.sourceStateSha256,
    targetHead: targetState.targetHead,
    targetStateSha256: targetState.targetStateSha256,
    contractSha256,
    contract,
    changedFiles: patch.changedFiles,
  };
  // I-001: filled when the receipt is accepted although the target HEAD moved since the preview.
  const receiptEvidence = {};
  if (!dryRun && reviewed) {
    const earlyReceiptError = await integrationPreviewReceiptError(previewReceipt, currentPreviewIdentity, false, targetCwd, receiptEvidence);
    if (earlyReceiptError) {
      const contractMismatch = earlyReceiptError.startsWith("Integration preview does not match this apply.");
      return {
        ok: false,
        errorType: contractMismatch ? "integration_preview_contract_mismatch" : "integration_preview_stale",
        suggestedFix: contractMismatch
          ? "Run the dry run again with the same allowedEdits, forbiddenEdits, validationCommand and allowDirtyTarget as the apply, then apply with its new previewReceipt."
          : "Run the dry run again to review the current patch and target, then apply with its new previewReceipt.",
        conflictingPaths: [],
        error: earlyReceiptError,
        changedFiles: patch.changedFiles,
        patchSha256: patch.patchSha256,
        targetStateSha256: targetState.targetStateSha256,
      };
    }
  }

  const targetChanges = filterGeneratedWorktreeFiles(await gitChangedFiles(targetCwd), targetCwd);
  if (!allowDirtyTarget && targetChanges.length) {
    return {
      ok: false,
      errorType: "integration_dirty_target",
      error: "Target repository has existing changes. Set allowDirtyTarget only when the coordinator has reviewed them.",
      changedFiles: targetChanges,
    };
  }

  const dirtyOverlap = allowDirtyTarget ? overlaps(targetChanges, patch.changedFiles) : null;
  if (dirtyOverlap) {
    return {
      ok: false,
      errorType: "integration_dirty_target_overlap",
      error: "The integration source overlaps existing target changes; applying it would make rollback unsafe.",
      changedFiles: targetChanges,
      disallowedFiles: dirtyOverlap,
    };
  }

  const normalizedAllowed = normalizeLockPathList(allowedEdits);
  if (!normalizedAllowed.length) {
    return {
      ok: false,
      errorType: "empty_allowed_edits",
      error: "Serial integration requires explicit allowedEdits.",
      changedFiles: patch.changedFiles,
    };
  }

  if (!patch.patch.trim()) {
    return {
      ok: true,
      status: "no_changes",
      sourceType: patch.sourceType,
      source: patch.source,
      changedFiles: [],
      appliedFiles: [],
      dryRun,
      validationGate: { status: "skipped", command: "", exitCode: "not_run", durationMs: 0 },
    };
  }
  if (!normalizeLockPathList(patch.changedFiles || []).length) {
    // A non-empty patch with no known file list would pass scope validation vacuously and
    // journal zero files, which recovery then closes as recovered_noop while the patch stays.
    return {
      ok: false,
      errorType: "integration_patch_paths_unknown",
      error: "The integration patch is not empty but its changed-file list is; the bridge refuses to validate or apply a patch whose paths it cannot list.",
      changedFiles: [],
    };
  }

  const lockPlan = integrationScopePlan({ cwd: targetCwd, allowedEdits: normalizedAllowed, forbiddenEdits, sharedFiles, serialOnly });
  const sourceValidation = validateChangedFilesForPlan({ changedFiles: patch.changedFiles, lockPlan, parallel: false });
  if (sourceValidation.disallowedFiles.length) {
    return {
      ok: false,
      errorType: changedFileValidationErrorType(sourceValidation),
      error: "Integration source contains files outside allowedEdits or inside forbidden/shared paths.",
      changedFiles: patch.changedFiles,
      disallowedFiles: sourceValidation.disallowedFiles,
      serialOnlyMatches: sourceValidation.serialOnlyMatches,
    };
  }

  const { dir, patchFile } = await writeTemporaryPatchFile(patch.patchBytes || patch.patch);
  let rollbackBaseline = null;
  let before = null;
  let patchApplied = false;
  let preApplyExactSnapshot = null;
  let preApplyIndexSnapshot = null;
  let preApplyFullIndexSha256 = "";
  let expectedPostApplySnapshot = null;
  let ownedPostApplySnapshot = null;
  let integrationOperationId = "";
  let integrationOperationCommitted = false;
  let integrationAuthority = null;
  const ownershipLostResult = (phase) => ({
    ok: false,
    status: "ownership_lost",
    errorType: abortSignalErrorType(signal, "integration_lock_ownership_lost"),
    error: signal?.reason?.message || `The serial integration lease was lost ${phase}.`,
    changedFiles: patch.changedFiles,
    operationId: integrationOperationId,
    recoveryRequired: Boolean(integrationOperationId),
  });
  try {
    const applyCheck = previewReused && cachedPreview.analysis?.applyCheck
      ? cachedPreview.analysis.applyCheck
      : await checkPatchApplies({ cwd: targetCwd, patchFile });
    if (!applyCheck.ok) {
      return {
        ok: false,
        errorType: applyCheck.errorType,
        error: applyCheck.stderr || applyCheck.stdout || "Patch does not apply cleanly.",
        changedFiles: patch.changedFiles,
      };
    }

    if (dryRun) {
      const binaryTextFiles = binaryTextFilesInPatch(patch.patch);
      if (binaryTextFiles.length && !acceptBinaryHunks) {
        return {
          ok: false,
          status: "preview_rejected",
          errorType: "integration_preview_unreadable_text_file",
          error: `The patch carries files as binary hunks the reviewer and the secret scan cannot read: ${binaryTextFiles.slice(0, 10).join(", ")}. Only known binary media, font and archive extensions are accepted as binary. Remove NUL bytes or other binary content (or a .gitattributes binary/-diff entry) from those files in the worktree and preview again, or, if you inspected those files in the worktree and they are meant to be binary, preview again with acceptBinaryHunks: true.`,
          changedFiles: patch.changedFiles,
          patchSha256: patch.patchSha256,
          patchPreview: "",
          patchPreviewTruncated: false,
          previewReceipt: null,
        };
      }
      const secretLines = patchLikelySecretLines(patch.patch);
      if (secretLines.length && !acceptFlaggedSecretLines) {
        // In a batch the numbers count lines of the combined patch; name the item and the line in it.
        const flagged = patch.items
          ? secretLines.slice(0, 10).map((line) => {
              const where = integrationBatchItemAtLine(patch, line);
              return where ? `${line} (item ${where.item}, ${where.source}, line ${where.line} of its patch)` : String(line);
            }).join(", ")
          : secretLines.slice(0, 10).join(", ");
        return {
          ok: false,
          status: "preview_rejected",
          errorType: "integration_preview_contains_sensitive_text",
          error: `The patch adds what looks like a real credential (patch lines ${flagged}${secretLines.length > 10 ? ", ..." : ""}). No review receipt was issued because the bridge cannot expose or silently redact essential review evidence. Remove the secret from the worktree and preview again, or, if you inspected those lines in the worktree and they hold no real credential, preview again with acceptFlaggedSecretLines: true.`,
          changedFiles: patch.changedFiles,
          patchSha256: patch.patchSha256,
          patchPreview: "",
          patchPreviewTruncated: false,
          previewReceipt: null,
        };
      }
      // The character cap protects the printed full preview; stat mode prints line counts.
      if (previewMode !== "stat" && patch.patch.length > CONFIG.integrationPreviewMaxChars) {
        return {
          ok: false,
          status: "preview_rejected",
          errorType: "integration_preview_truncated",
          error: `The exact patch is ${patch.patch.length} characters, above CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS=${CONFIG.integrationPreviewMaxChars}. No review receipt was issued because essential evidence would be truncated.`,
          sourceType: patch.sourceType,
          source: patch.source,
          changedFiles: patch.changedFiles,
          appliedFiles: [],
          dryRun: true,
          patchSha256: patch.patchSha256,
          sourceBaseCommit: patch.sourceBaseCommit,
          sourceHead: patch.sourceHead,
          sourceStateSha256: patch.sourceStateSha256,
          targetHead: targetState.targetHead,
          targetTree: targetState.targetTree,
          targetStateSha256: targetState.targetStateSha256,
          contractSha256,
          patchPreview: "",
          patchPreviewTruncated: true,
          previewReceipt: null,
        };
      }
      let generatedReceipt;
      try {
        // I-001: what the patch lands on, kept in the receipt so a later HEAD move that leaves
        // these paths alone does not stale it. If the paths cannot be read (a directory where
        // the patch expects a file, a file over the snapshot limit) the receipt stays strict.
        const patchedPathsState = await capturePatchedPathsState(targetCwd, targetState.targetHead, patch.changedFiles);
        let analysis = null;
        if (sourceProof) {
          // Read-only preparation belongs to the reviewed analysis. Reuse it only
          // when a second full capture still proves the exact same target.
          // A preparation failure only disables reuse; it does not change a dry run.
          try {
            const [simulation, exactSnapshot, indexSnapshot, baseline, changedSnapshot] = await Promise.all([
              simulateIntegrationPatchSnapshot({ cwd: targetCwd, targetHead: targetState.targetHead, patchFile, files: patch.changedFiles }),
              exactIntegrationFileSnapshot(targetCwd, patch.changedFiles),
              gitIndexPathSnapshot(targetCwd, patch.changedFiles),
              captureRollbackBaseline(targetCwd, { files: patch.changedFiles }),
              gitChangedFileSnapshot(targetCwd, { includeIgnored: false }),
            ]);
            const confirmed = await captureIntegrationTargetState(targetCwd);
            if (simulation.ok && confirmed.ok && confirmed.targetStateSha256 === targetState.targetStateSha256) {
              analysis = { applyCheck, simulation, exactSnapshot, indexSnapshot, baseline, changedSnapshot };
            }
          } catch { /* Existing apply preparation will report its original error. */ }
        }
        generatedReceipt = await makeIntegrationPreviewReceipt({
          patch,
          targetState,
          contractSha256,
          contract,
          projectKey: targetCwd,
          patchedPathsStateSha256: patchedPathsState.ok ? patchedPathsState.sha256 : "",
          reuse: analysis && sourceProof && sourceProof === await captureIntegrationSourceProof(sourceOptions)
            ? { sourceProof, patch, targetState, analysis }
            : null,
        });
      } catch (error) {
        return {
          ok: false,
          status: "preview_rejected",
          errorType: error?.errorType || "integration_preview_capacity_exceeded",
          error: error?.message || "The bridge cannot retain another integration preview safely.",
          changedFiles: patch.changedFiles,
          patchSha256: patch.patchSha256,
          previewReceipt: null,
        };
      }
      return {
        ok: true,
        status: "dry_run_passed",
        sourceType: patch.sourceType,
        source: patch.source,
        changedFiles: patch.changedFiles,
        appliedFiles: [],
        dryRun: true,
        patchSha256: patch.patchSha256,
        sourceBaseCommit: patch.sourceBaseCommit,
        sourceHead: patch.sourceHead,
        sourceStateSha256: patch.sourceStateSha256,
        targetHead: targetState.targetHead,
        targetTree: targetState.targetTree,
        targetStateSha256: targetState.targetStateSha256,
        contractSha256,
        // Accepted flagged lines were inspected in the worktree; the printed preview masks their
        // values (the receipt still covers the full patch SHA-256), so the response, and every
        // transcript or log that keeps it, does not carry what the gate took for a credential.
        patchPreview: previewMode === "stat" ? "" : secretLines.length ? redactLikelySecrets(patch.patch) : patch.patch,
        patchPreviewMaskedLines: secretLines,
        patchStat: diffStatFromPatch(patch.patch),
        patchFiles: patchFileEntries(patch.patch).map((file) => ({ path: file.path, created: file.created, deleted: file.deleted, binary: file.binary })),
        patchPreviewTruncated: false,
        preExistingTargetChanges: targetChanges,
        allowDirtyTarget: Boolean(allowDirtyTarget),
        previewReceipt: generatedReceipt,
        validationGate: { status: "skipped_dry_run", command: validationCommand, exitCode: "not_run", durationMs: 0 },
        ...(patch.items ? { batchItems: patch.items } : {}),
      };
    }

    if (!reviewed) {
      return {
        ok: false,
        errorType: "integration_requires_review",
        error: "Serial integration requires an explicit Codex review confirmation before applying a worktree or branch patch.",
        suggestedFix: "Run a dryRun first, inspect the patch preview/changed files, then retry with reviewed: true when Codex approves the integration.",
        changedFiles: patch.changedFiles,
      };
    }


    delete receiptEvidence.targetMoved;
    const receiptError = await integrationPreviewReceiptError(previewReceipt, currentPreviewIdentity, true, targetCwd, receiptEvidence);
    if (receiptError) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        suggestedFix: "Run the dry run again to review the current patch and target, then apply with its new previewReceipt.",
        conflictingPaths: [],
        error: receiptError,
        changedFiles: patch.changedFiles,
        patchSha256: patch.patchSha256,
        targetStateSha256: targetState.targetStateSha256,
      };
    }

    // The receipt check above matched targetState in full (ignored-file metadata included), or,
    // when the target HEAD had moved past commits that left the patched paths alone (I-001),
    // matched the reviewed state of those paths; from here on only non-ignored drift fails the
    // integration. B-026: a second full capture
    // here repeated finalPreApplyState below (same tracked identity, compared to the same
    // targetState, with only read-only work between them) and cost one whole-tree rehash.
    const simulation = previewReused && cachedPreview.analysis?.simulation?.ok
      ? cachedPreview.analysis.simulation
      : await simulateIntegrationPatchSnapshot({
      cwd: targetCwd,
      targetHead: targetState.targetHead,
      patchFile,
      files: patch.changedFiles,
    });
    if (!simulation.ok) {
      return {
        ok: false,
        errorType: simulation.errorType,
        error: `${simulation.error} The target was not modified and the source was retained.`,
        changedFiles: patch.changedFiles,
      };
    }
    expectedPostApplySnapshot = simulation.snapshot;
    preApplyExactSnapshot = previewReused && cachedPreview.analysis?.exactSnapshot
      ? cachedPreview.analysis.exactSnapshot : await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
    preApplyIndexSnapshot = previewReused && cachedPreview.analysis?.indexSnapshot
      ? cachedPreview.analysis.indexSnapshot : await gitIndexPathSnapshot(targetCwd, patch.changedFiles);
    if (receiptEvidence.targetMoved) {
      // I-001: the receipt was carried over a moved HEAD on the strength of a read taken a moment
      // ago. These are the very bytes and index entries the apply below protects (it re-reads the
      // bytes right before the first write), so they must be the reviewed ones; HEAD itself is
      // pinned to targetState by the final-preparation checks that follow.
      const baselinePathsState = patchedPathsStateSha256Of({
        files: patch.changedFiles,
        headEntries: receiptEvidence.targetMoved.headEntries,
        indexSnapshot: preApplyIndexSnapshot,
        workingSnapshot: preApplyExactSnapshot,
      });
      if (baselinePathsState.toLowerCase() !== String(previewReceipt?.patchedPathsStateSha256 || "").toLowerCase()) {
        return {
          ok: false,
          errorType: "integration_preview_stale",
          error: "Integration preview is stale: the patched paths changed while the apply was being prepared (the target HEAD had moved since the preview). The patch was not applied and the source was retained.",
          suggestedFix: "Run the dry run again to review the current patch and target, then apply with its new previewReceipt.",
          changedFiles: patch.changedFiles,
          expectedTargetHead: targetState.targetHead,
        };
      }
    }
    rollbackBaseline = previewReused && cachedPreview.analysis?.baseline
      ? cachedPreview.analysis.baseline : await captureRollbackBaseline(targetCwd, { files: patch.changedFiles });
    before = previewReused && cachedPreview.analysis?.changedSnapshot
      ? cachedPreview.analysis.changedSnapshot : await gitChangedFileSnapshot(targetCwd, { includeIgnored: false });
    const finalPreApplyState = await captureIntegrationTargetState(targetCwd);
    if (!finalPreApplyState.ok
      || rollbackBaseline.baseCommit !== targetState.targetHead
      || finalPreApplyState.trackedStateSha256 !== targetState.trackedStateSha256) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        error: "Integration target changed during final preparation. The patch was not applied and the source was retained.",
        changedFiles: patch.changedFiles,
        expectedTargetHead: targetState.targetHead,
        actualTargetHead: finalPreApplyState.targetHead || rollbackBaseline.baseCommit || "",
      };
    }
    preApplyFullIndexSha256 = finalPreApplyState.indexSha256;
    if (typeof beforeApplyHook === "function") {
      await beforeApplyHook({ targetCwd, patch, targetState: finalPreApplyState });
    }
    // Speed-up option 2 (user decision, 2026-09-29): with no hook between them this capture only
    // repeated finalPreApplyState a moment later; it is kept where a hook runs in between.
    const immediatePreApplyState = typeof beforeApplyHook === "function"
      ? await captureIntegrationTargetState(targetCwd)
      : finalPreApplyState;
    if (!immediatePreApplyState.ok || immediatePreApplyState.trackedStateSha256 !== targetState.trackedStateSha256) {
      let unresolvedFiles = [];
      try {
        unresolvedFiles = changedFilesBetween(before, await gitChangedFileSnapshot(targetCwd, { includeIgnored: false }));
      } catch {
        unresolvedFiles = patch.changedFiles;
      }
      const headChanged = Boolean(
        immediatePreApplyState.targetHead
        && immediatePreApplyState.targetHead !== targetState.targetHead
      );
      if (headChanged) {
        const committedChanges = await runCommand(
          "git",
          ["diff", "--name-only", "-z", "--no-renames", `${targetState.targetHead}..${immediatePreApplyState.targetHead}`, "--"],
          targetCwd,
          1000 * 15,
        );
        unresolvedFiles = normalizeLockPathList(
          unresolvedFiles.concat(committedChanges.exitCode === 0 ? committedChanges.stdout.split("\0") : patch.changedFiles),
        );
      }
      return {
        ok: false,
        errorType: headChanged ? "integration_target_head_changed" : "integration_preview_stale",
        error: "Integration target changed immediately before patch application. The reviewed patch was not applied, external state was retained, and the source remains available.",
        changedFiles: patch.changedFiles,
        unexpectedTargetChanges: unresolvedFiles,
        expectedTargetHead: targetState.targetHead,
        actualTargetHead: immediatePreApplyState.targetHead || "",
        rollback: {
          rollback: headChanged || unresolvedFiles.length ? "not_attempted_unattributed_changes" : "not_needed",
          rollbackFiles: [],
          unresolvedFiles,
          ownershipMismatches: unresolvedFiles,
        },
      };
    }
    // G-10: an operation started after the dry run (git merge --no-commit -s ours leaves no
    // status or index change) is refused here, before any byte of the target is written.
    const preApplyOperationState = await inspectRepositoryOperationState(targetCwd);
    if (!preApplyOperationState.ok) {
      return { ...preApplyOperationState, error: `${preApplyOperationState.error} The patch was not applied and the source was retained.`, changedFiles: patch.changedFiles };
    }
    if (signal?.aborted) {
      return {
        ok: false,
        errorType: abortSignalErrorType(signal, "integration_lock_ownership_lost"),
        error: signal.reason?.message || "The serial integration lease was lost before patch application.",
        changedFiles: patch.changedFiles,
      };
    }
    const preparedOperation = await prepareIntegrationOperation({
      cwd: targetCwd,
      pipelineId,
      pipelineJobId,
      targetState: immediatePreApplyState,
      patch,
      contractSha256,
      expectedPostSnapshot: expectedPostApplySnapshot,
      integrationLock,
    });
    integrationOperationId = preparedOperation.operationId;
    integrationAuthority = {
      lock: integrationLock,
      ownerGeneration: preparedOperation.ownerGeneration,
      allowTakeover: false,
    };
    if (typeof onIntegrationPrepared === "function") {
      await onIntegrationPrepared({
        operationId: integrationOperationId,
        targetCwd,
        patch,
      });
    }
    if (signal?.aborted) return ownershipLostResult("after journal preparation");
    await transitionIntegrationOperation(targetCwd, integrationOperationId, "prepared", "applying", {
      outcome: "patch_apply_started",
    }, integrationAuthority);
    if (signal?.aborted) return ownershipLostResult("before patch application");
    const applied = await applyPatchFile({
      cwd: targetCwd,
      patchFile,
      targetHead: targetState.targetHead,
      files: patch.changedFiles,
      baselineSnapshot: preApplyExactSnapshot,
      signal,
    });
    if (signal?.aborted) return ownershipLostResult("during patch application");
    if (applied.exitCode !== 0) {
      if (applied.worktreeWritten === false && applied.externalChanges?.length) {
        await transitionIntegrationOperation(targetCwd, integrationOperationId, "applying", "recovered_noop", {
          outcome: "target_changed_before_patch_write",
          paths: applied.externalChanges,
        }, integrationAuthority);
        integrationOperationCommitted = true;
        return {
          ok: false,
          errorType: "integration_preview_stale",
          error: "Target paths changed immediately before patch write. The patch was not applied and the source was retained.",
          changedFiles: patch.changedFiles,
          unexpectedTargetChanges: applied.externalChanges,
        };
      }
      const indexReset = await isolatedIndexPreservationEvidence({ cwd: targetCwd, files: patch.changedFiles, baselineSnapshot: preApplyIndexSnapshot });
      let changedSincePreApply = patch.changedFiles;
      try {
        const failedApplySnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
        changedSincePreApply = snapshotMismatches(preApplyExactSnapshot, failedApplySnapshot, patch.changedFiles);
      } catch {
        // Without exact evidence, retain every potentially changed file.
      }
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: changedSincePreApply,
        ownedSnapshot: expectedPostApplySnapshot,
        eolRecords: applied.isolatedEolRecords || null,
      });
      return {
        ok: false,
        errorType: "integration_apply_failed",
        error: `${applied.stderr || applied.stdout || "Patch apply failed."} Only files still matching exact bridge-owned post-patch bytes were eligible for rollback; ambiguous files were retained.`,
        changedFiles: patch.changedFiles,
        indexReset,
        rollback,
      };
    }
    patchApplied = true;

    const postApplyHead = await captureGitHead(targetCwd);
    if (postApplyHead !== targetState.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed during patch application. No rollback or index reset was attempted because ownership is ambiguous; the source was retained.",
        changedFiles: patch.changedFiles,
        expectedTargetHead: targetState.targetHead,
        actualTargetHead: postApplyHead,
        indexReset: { ok: false, resetFiles: [], ownershipMismatches: patch.changedFiles, errors: ["Target HEAD changed; index ownership is ambiguous."] },
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: patch.changedFiles, ownershipMismatches: patch.changedFiles },
      };
    }

    ownedPostApplySnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
    const postApplyContentMismatches = await integrationContentMismatches(
      targetCwd,
      expectedPostApplySnapshot,
      ownedPostApplySnapshot,
      patch.changedFiles,
      { eolRecords: applied.isolatedEolRecords },
    );
    const actualPostApplyIndexSnapshot = await gitIndexPathSnapshot(targetCwd, patch.changedFiles);
    const postApplyIndexMismatches = snapshotMismatches(preApplyIndexSnapshot, actualPostApplyIndexSnapshot, patch.changedFiles);
    if (postApplyContentMismatches.length || postApplyIndexMismatches.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: expectedPostApplySnapshot,
        eolRecords: applied.isolatedEolRecords || null,
      });
      return {
        ok: false,
        errorType: postApplyContentMismatches.length
          ? "integration_post_apply_content_mismatch"
          : "integration_post_apply_index_mismatch",
        error: "Target bytes did not exactly match the reviewed patch or the real Git index changed concurrently. The bridge used an isolated index and never reset the real index; exact bridge-owned worktree state was rolled back while ambiguous external changes were retained.",
        changedFiles: patch.changedFiles,
        contentMismatches: postApplyContentMismatches,
        indexMismatches: postApplyIndexMismatches,
        indexReset,
        rollback,
      };
    }
    await transitionIntegrationOperation(targetCwd, integrationOperationId, "applying", "applied_unvalidated", {
      outcome: "exact_post_state_verified",
    }, integrationAuthority);

    // Ignored entries are left out: git apply never writes them, so an ignored file another
    // process rewrote is not an unexpected path of this patch.
    const after = await gitChangedFileSnapshot(targetCwd, { includeIgnored: false });
    const appliedFiles = changedFilesBetween(before, after);
    const appliedPathEvidence = changedPathSetEvidence(patch.changedFiles, appliedFiles);
    const appliedValidation = validateChangedFilesForPlan({ changedFiles: appliedFiles, lockPlan, parallel: false });
    if (appliedValidation.disallowedFiles.length
      || appliedPathEvidence.missingFiles.length
      || appliedPathEvidence.unexpectedFiles.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({ cwd: targetCwd, baseline: rollbackBaseline, files: patch.changedFiles, ownedSnapshot: ownedPostApplySnapshot });
      return {
        ok: false,
        errorType: appliedValidation.disallowedFiles.length
          ? changedFileValidationErrorType(appliedValidation)
          : "integration_post_apply_path_mismatch",
        error: "The target path set did not exactly match the reviewed patch. Matching bridge-owned state was rolled back; unexpected external paths and the source were retained.",
        suggestedFix: appliedPathEvidence.unexpectedFiles.length || appliedValidation.disallowedFiles.length
          ? `Another process wrote ${normalizeLockPathList(appliedPathEvidence.unexpectedFiles.concat(appliedValidation.disallowedFiles)).join(", ")} in the checkout during the apply (a background loop, a test run, an editor). Stop it, then dry-run again and apply with the new receipt.`
          : "Dry-run again and apply with the new receipt.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        missingFiles: appliedPathEvidence.missingFiles,
        unexpectedFiles: appliedPathEvidence.unexpectedFiles,
        disallowedFiles: appliedValidation.disallowedFiles,
        indexReset,
        rollback,
      };
    }

    if (validationPolicyTrust) {
      const currentPolicy = await loadProjectAgentPolicy(targetCwd, validationPolicyTrust.path);
      const stillTrusted = currentPolicy.ok
        && currentPolicy.sha256 === validationPolicyTrust.sha256
        && currentPolicy.policy?.finalValidationSpec?.commandSha256 === validationPolicyTrust.commandSha256;
      if (!stillTrusted) {
        const indexReset = await isolatedIndexPreservationEvidence({
          cwd: targetCwd,
          files: patch.changedFiles,
          baselineSnapshot: preApplyIndexSnapshot,
        });
        const rollback = await rollbackVerifiedOwnedChanges({
          cwd: targetCwd,
          baseline: rollbackBaseline,
          files: appliedFiles.length ? appliedFiles : patch.changedFiles,
          ownedSnapshot: ownedPostApplySnapshot,
        });
        return {
          ok: false,
          errorType: "policy_validation_command_untrusted",
          error: "Project policy trust changed after patch application and before validation; target rollback was attempted and the source was retained.",
          changedFiles: patch.changedFiles,
          appliedFiles,
          indexReset,
          rollback,
        };
      }
    }

    await transitionIntegrationOperation(targetCwd, integrationOperationId, "applied_unvalidated", "validating", {
      outcome: "validation_started",
    }, integrationAuthority);
    if (typeof beforeValidationHook === "function") {
      await beforeValidationHook({ targetCwd, patch, appliedFiles });
    }
    let validationGate = await runValidationGate({ command: validationCommand, cwd: targetCwd, trustedSpec: validationTrustedSpec, signal });
    // Checked before the abort return: an aborted integration whose validation tree may still run
    // must not be left as a plain validating operation that a later recovery pass rolls back.
    if (validationGate.processTreeUnconfirmed) {
      // Rolling back now could be overwritten by a validation process that is still running, and
      // releasing the lock would let the next writer in. Quarantine: writers stay blocked until
      // an operator has checked that the process tree is gone (resolve_integration_quarantine).
      let quarantined = false;
      for (let attempt = 0; attempt < 4 && !quarantined; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        quarantined = await quarantineIntegrationOperation(targetCwd, integrationOperationId, ["validating"], "validation_process_unconfirmed", integrationAuthority, {
          error: "The validation command's process tree could not be confirmed terminated.",
        });
      }
      if (!quarantined) {
        // No durable record: block writers in this bridge process at least, and say so.
        INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(targetCwd);
        logEvent("error", "integration.validation_containment_unrecorded", { operationId: integrationOperationId });
      }
      integrationOperationCommitted = true;
      return {
        ok: false,
        errorType: "validation_process_tree_unconfirmed",
        error: quarantined
          ? "The validation command timed out or was stopped, and the bridge could not confirm that every process it started has ended. Nothing was rolled back, because a surviving process could still write the checkout; the integration operation is quarantined and writers of this repository are blocked."
          : "The validation command timed out or was stopped, and the bridge could not confirm that every process it started has ended. Nothing was rolled back. The quarantine could NOT be written to the state database, so only this bridge process blocks writers of this repository; do not restart the clients until the validation processes are gone.",
        suggestedFix: "Check that no process started by the validation command is still running (Task Manager or Get-Process), then close the quarantine with resolve_integration_quarantine: verify_restored after putting the affected paths back, or ask the user to run accept_current from bin/pipeline-admin.js.",
        changedFiles: patch.changedFiles,
        operationId: integrationOperationId,
        validationGate,
      };
    }
    if (signal?.aborted) return ownershipLostResult("during validation");
    const afterValidation = await gitChangedFileSnapshot(targetCwd, { includeIgnored: false });
    const postValidationIndex = await captureGitIndexIdentity(targetCwd);
    const validationIndexChanged = !postValidationIndex.ok || postValidationIndex.indexSha256 !== preApplyFullIndexSha256;
    const postValidationFiles = changedFilesBetween(before, afterValidation);
    const validationMutationFiles = changedFilesBetween(after, afterValidation);
    const postValidation = validateChangedFilesForPlan({ changedFiles: postValidationFiles, lockPlan, parallel: false });
    let postValidationContentMismatches = patch.changedFiles;
    try {
      const postValidationExactSnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
      postValidationContentMismatches = snapshotMismatches(ownedPostApplySnapshot, postValidationExactSnapshot, patch.changedFiles);
    } catch {
      // Exact evidence is mandatory for acceptance; retain potentially external content.
    }
    const postValidationHead = await captureGitHead(targetCwd);
    if (postValidationHead !== targetState.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed during validation. No rollback or index reset was attempted because ownership is ambiguous; the source was retained.",
        changedFiles: patch.changedFiles,
        appliedFiles: postValidationFiles,
        expectedTargetHead: targetState.targetHead,
        actualTargetHead: postValidationHead,
        validationGate,
        indexReset: { ok: false, resetFiles: [], ownershipMismatches: patch.changedFiles, errors: ["Target HEAD changed; index ownership is ambiguous."] },
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: normalizeLockPathList(patch.changedFiles.concat(validationMutationFiles)), ownershipMismatches: normalizeLockPathList(patch.changedFiles.concat(validationMutationFiles)) },
      };
    }
    if (validationGate.errorType
      || validationIndexChanged
      || validationMutationFiles.length
      || postValidation.disallowedFiles.length
      || postValidationContentMismatches.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: ownedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: validationIndexChanged
          ? "integration_validation_mutated_unapproved_files"
          : validationMutationFiles.length || postValidation.disallowedFiles.length || postValidationContentMismatches.length
          ? (postValidation.disallowedFiles.length || validationMutationFiles.some((file) => !patch.changedFiles.includes(file))
            ? "integration_validation_mutated_unapproved_files"
            : "integration_validation_mutated_reviewed_files")
          : validationGate.errorType,
        error: validationGate.errorType && !validationIndexChanged && !validationMutationFiles.length && !postValidationContentMismatches.length
          ? "Validation command failed after serial integration; exact bridge-owned state was rolled back and the source was retained."
          : validationIndexChanged
            ? "Validation or concurrent activity changed the exact real Git index. The bridge preserved that external index state, rolled back only exact bridge-owned worktree bytes, and retained the source."
            : "Validation or concurrent activity changed target content after the reviewed patch was applied. Only exact bridge-owned patch state was rolled back; external paths, ambiguous state, and the source were retained.",
        changedFiles: patch.changedFiles,
        appliedFiles: postValidationFiles,
        validationMutationFiles,
        disallowedFiles: postValidation.disallowedFiles,
        contentMismatches: postValidationContentMismatches,
        validationIndexChanged,
        expectedIndexSha256: preApplyFullIndexSha256,
        actualIndexSha256: postValidationIndex.indexSha256 || "",
        indexIdentityError: postValidationIndex.ok ? "" : postValidationIndex.error,
        validationGate,
        indexReset,
        rollback,
      };
    }

    const indexReset = await isolatedIndexPreservationEvidence({
      cwd: targetCwd,
      files: patch.changedFiles,
      baselineSnapshot: preApplyIndexSnapshot,
    });
    if (!indexReset.ok) {
      const rollback = await rollbackVerifiedOwnedChanges({ cwd: targetCwd, baseline: rollbackBaseline, files: patch.changedFiles, ownedSnapshot: ownedPostApplySnapshot });
      return {
        ok: false,
        errorType: "integration_index_changed",
        error: "The real Git index changed concurrently. The bridge never wrote or reset it, rejected the integration, and retained the external staged state and source.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        validationGate,
        indexReset,
        rollback,
      };
    }

    const finalTargetHead = await captureGitHead(targetCwd);
    if (finalTargetHead !== targetState.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed before integration completion. The isolated real index was preserved, no ambiguous rollback was attempted, and the source was retained.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        expectedTargetHead: targetState.targetHead,
        actualTargetHead: finalTargetHead,
        validationGate,
        indexReset,
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: patch.changedFiles, ownershipMismatches: patch.changedFiles },
      };
    }

    const integratedTargetState = await captureIntegrationTargetState(targetCwd);
    if (!integratedTargetState.ok) {
      const error = new Error(integratedTargetState.error || "Could not capture the exact integrated target state before completion.");
      error.errorType = integratedTargetState.errorType || "integration_target_state_failed";
      throw error;
    }
    if (integratedTargetState.indexSha256 !== preApplyFullIndexSha256) {
      const finalIndexEvidence = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: ownedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: "integration_index_changed",
        error: "The exact real Git index changed before integration completion. The bridge preserved the external index state, rolled back only exact bridge-owned worktree bytes, and retained the source.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        validationGate,
        expectedIndexSha256: preApplyFullIndexSha256,
        actualIndexSha256: integratedTargetState.indexSha256,
        indexReset: finalIndexEvidence,
        rollback,
      };
    }

    if (signal?.aborted) return ownershipLostResult("before validation acceptance");
    await transitionIntegrationOperation(targetCwd, integrationOperationId, "validating", "validated", {
      outcome: "validation_passed",
      integratedTargetStateSha256: integratedTargetState.targetStateSha256,
    }, integrationAuthority);
    if (signal?.aborted) return ownershipLostResult("before durable integration commit");
    await transitionIntegrationOperation(targetCwd, integrationOperationId, "validated", "committed", {
      outcome: "integration_committed",
      patchSha256: patch.patchSha256,
      sourceStateSha256: patch.sourceStateSha256,
      integratedTargetStateSha256: integratedTargetState.targetStateSha256,
      contractSha256,
    }, integrationAuthority);
    integrationOperationCommitted = true;

    return {
      ok: true,
      status: "applied",
      sourceType: patch.sourceType,
      source: patch.source,
      changedFiles: patch.changedFiles,
      appliedFiles,
      dryRun: false,
      validationGate,
      patchSha256: patch.patchSha256,
      sourceBaseCommit: patch.sourceBaseCommit,
      sourceStateSha256: patch.sourceStateSha256,
      targetPreviewStateSha256: targetState.targetStateSha256,
      integratedTargetStateSha256: integratedTargetState.targetStateSha256,
      integratedTrackedStateSha256: integratedTargetState.trackedStateSha256,
      contractSha256,
      previewId: previewReceipt.previewId,
      preExistingTargetChanges: targetChanges,
      allowDirtyTarget: Boolean(allowDirtyTarget),
      operationId: integrationOperationId,
      journalStatus: "committed",
      sourceHead: patch.sourceHead,
      integratedFilesStateSha256: snapshotIdentitySha256(ownedPostApplySnapshot),
      previewReused,
      ...(patch.items ? { batchItems: patch.items } : {}),
      ...(receiptEvidence.targetMoved
        ? {
            targetMovedSincePreview: {
              commits: receiptEvidence.targetMoved.commits,
              previewHead: receiptEvidence.targetMoved.previewHead,
              currentHead: receiptEvidence.targetMoved.currentHead,
            },
          }
        : {}),
    };
  } catch (error) {
    if (!patchApplied && error?.errorType === "pipeline_terminal") {
      return {
        ok: false,
        errorType: "pipeline_terminal",
        error: `${error.message} Nothing was applied; the prepared journal operation is closed without changes.`,
        changedFiles: patch.changedFiles,
      };
    }
    let indexReset = null;
    let rollback = null;
    if (patchApplied && rollbackBaseline) {
      try {
        indexReset = await isolatedIndexPreservationEvidence({
          cwd: targetCwd,
          files: patch.changedFiles,
          baselineSnapshot: preApplyIndexSnapshot,
        });
      } catch (resetError) {
        indexReset = { ok: false, error: resetError.message || String(resetError) };
      }
      try {
        rollback = await rollbackVerifiedOwnedChanges({
          cwd: targetCwd,
          baseline: rollbackBaseline,
          files: patch.changedFiles,
          ownedSnapshot: ownedPostApplySnapshot,
        });
      } catch (rollbackError) {
        rollback = { ok: false, unresolvedFiles: patch.changedFiles, errors: [rollbackError.message || String(rollbackError)] };
      }
    }
    return {
      ok: false,
      errorType: "integration_transaction_failed",
      error: `Serial integration encountered an infrastructure error${patchApplied ? " after patch application; rollback was attempted" : " before patch application"}. The source was retained. ${redactSensitiveText(error.message || String(error))}`,
      changedFiles: patch.changedFiles,
      indexReset,
      rollback,
    };
  } finally {
    if (integrationOperationId && !integrationOperationCommitted && !signal?.aborted) {
      try {
        const recovered = await recoverIntegrationOperationsWhileLocked(targetCwd, {
          operationId: integrationOperationId,
          integrationLock,
        });
        if (!recovered.ok) {
          logEvent("error", "integration.journal_quarantined", {
            operationId: integrationOperationId,
            errorType: recovered.errorType || "integration_recovery_quarantined",
          });
        }
      } catch (error) {
        // A busy state database or a locked file leaves the operation nonterminal for the
        // deferred recovery pass; only other failures are quarantined.
        if (!integrationRecoveryErrorIsTransient(error)) {
          await quarantineIntegrationOperation(
            targetCwd,
            integrationOperationId,
            ["prepared", "applying", "applied_unvalidated", "validating", "validated", "rolling_back", "recovering"],
            "recovery_finalizer_failed",
            integrationAuthority,
            { error: integrationRecoveryErrorText(error) }
          );
        }
        logEvent("error", "integration.journal_recovery_failed", {
          operationId: integrationOperationId,
          errorType: error?.errorType || "integration_journal_recovery_failed",
        });
      }
    }
    // The patch scratch directory is temporary; a Windows EBUSY/EPERM on it must not replace an
    // already committed integration result with an exception.
    try {
      if (typeof integrationScratchCleanupTestHook === "function") await integrationScratchCleanupTestHook(dir);
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      logEvent("warn", "integration.patch_scratch_cleanup_failed", { error: error?.message || String(error) });
    }
  }
}

async function integrationCleanupTargetStateError(cwd, expectedTargetStateSha256, expectedTrackedStateSha256 = "") {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedTargetStateSha256 || ""))) {
    return "The integrated target state was not attested; the recovery source was retained.";
  }
  const current = await captureIntegrationTargetState(cwd);
  if (!current.ok) return current.error || "The target state could not be reverified immediately before source cleanup.";
  // With the ignored-free identity recorded, an IDE or dev server touching an ignored file
  // after the integration no longer retains the source worktree forever.
  const tracked = /^[a-f0-9]{64}$/i.test(String(expectedTrackedStateSha256 || ""));
  return (tracked ? current.trackedStateSha256 === expectedTrackedStateSha256 : current.targetStateSha256 === expectedTargetStateSha256)
    ? ""
    : "The target changed after reviewed integration; the recovery source was retained.";
}

async function cleanupIntegratedWorktreeWhileLocked({
  result,
  cwd,
  worktreePath,
  deferCleanup = false,
  beforeCleanupHook = null,
  beforeRemoval = null,
}) {
  if (!result?.ok || result.status !== "applied" || !worktreePath) return;
  if (result.validationGate?.status !== "passed") {
    result.sourceCleanup = {
      cleanup: "retained_for_review",
      reason: "cleanup requires an explicit passing validation gate; skipped validation is not success",
    };
    return;
  }

  let checkedSourceHead = "";
  const sourceMatches = async () => {
    const current = await collectIntegrationPatch({
      cwd,
      worktreePath,
      sourceBaseCommit: result.sourceBaseCommit,
    });
    const matches = current.ok
      && current.patchSha256 === result.patchSha256
      && current.sourceStateSha256 === result.sourceStateSha256;
    checkedSourceHead = matches ? current.sourceHead : "";
    return matches;
  };
  // B-026: without a deferral or a test hook the preliminary source and target checks only
  // repeated the final ones below (two whole-tree rehashes); the final ones still run right
  // before the destructive removal.
  const preliminaryChecks = deferCleanup || typeof beforeCleanupHook === "function";
  if (preliminaryChecks && !await sourceMatches()) {
    result.sourceCleanup = { cleanup: "retained_for_review", reason: "integration_source_changed_after_review" };
    result.cleanupWarning = "The source worktree changed during or after integration validation; it was retained and not force-removed.";
    return;
  }
  if (deferCleanup) {
    result.sourceCleanup = {
      cleanup: "deferred_until_pipeline_finalization",
      reason: "pipeline final validation, reviewer, and tester gates must all pass before deletion",
    };
    return;
  }

  const preliminaryTargetError = preliminaryChecks
    ? await integrationCleanupTargetStateError(cwd, result.integratedTargetStateSha256, result.integratedTrackedStateSha256)
    : "";
  if (preliminaryTargetError) {
    result.sourceCleanup = { cleanup: "retained_for_review", reason: "integration_target_changed_before_cleanup", error: preliminaryTargetError };
    result.cleanupWarning = preliminaryTargetError;
    return;
  }
  if (typeof beforeCleanupHook === "function") {
    await beforeCleanupHook({ targetCwd: cwd, worktreePath, result });
  }

  // The source check runs last, right before the removal, so a change to the source during the
  // target check is still seen; the branch read runs alongside the target check.
  const [sourceBranch, finalTargetError] = await Promise.all([
    runCommand("git", ["branch", "--show-current"], worktreePath, 1000 * 15),
    integrationCleanupTargetStateError(cwd, result.integratedTargetStateSha256, result.integratedTrackedStateSha256),
  ]);
  const finalSourceMatches = !finalTargetError && await sourceMatches();
  if (finalTargetError || !finalSourceMatches || sourceBranch.exitCode !== 0 || !sourceBranch.stdout.trim()) {
    result.sourceCleanup = {
      cleanup: "retained_for_review",
      reason: finalTargetError
        ? "integration_target_changed_before_cleanup"
        : !finalSourceMatches
          ? "integration_source_changed_after_review"
          : "source_branch_identity_unverified",
      error: finalTargetError || (!finalSourceMatches
        ? "The source worktree changed before destructive cleanup."
        : sourceBranch.stderr || "The source branch could not be verified immediately before cleanup."),
    };
    result.cleanupWarning = result.sourceCleanup.error;
    return;
  }

  if (beforeRemoval) await beforeRemoval();
  result.sourceCleanup = await cleanupWorktree(
    {
      path: path.resolve(worktreePath),
      repoRoot: path.resolve(cwd),
      branch: sourceBranch.stdout.trim(),
      expectedBranchOid: checkedSourceHead,
    },
    "always",
    true
  );
  if (["failed", "partial"].includes(result.sourceCleanup.cleanup)) {
    result.cleanupWarning = result.sourceCleanup.error || (result.sourceCleanup.cleanup === "partial"
      ? "The integrated worktree was removed, but its local source branch was retained."
      : "Integrated source worktree could not be removed.");
  }
}

// I-002: after a batch landed (one durable, validated operation) each requested worktree goes
// through the single-item cleanup with its own source identity, so a worktree edited after review
// is retained. One by one: removals share the repository's ref locks. A failure here never
// replaces the committed integration result.
async function cleanupIntegratedBatchWorktreesWhileLocked({ result, cwd, items, beforeCleanupHook = null }) {
  const identities = Array.isArray(result.batchItems) ? result.batchItems : [];
  const warnings = [];
  let removed = 0;
  let requested = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const identity = identities[index];
    if (!identity) continue;
    if (!item.cleanup || !item.worktreePath) {
      identity.sourceCleanup = { cleanup: "not_requested" };
      continue;
    }
    requested += 1;
    const itemResult = {
      ok: true,
      status: "applied",
      validationGate: result.validationGate,
      patchSha256: identity.patchSha256,
      sourceStateSha256: identity.sourceStateSha256,
      sourceBaseCommit: identity.sourceBaseCommit,
      integratedTargetStateSha256: result.integratedTargetStateSha256,
      integratedTrackedStateSha256: result.integratedTrackedStateSha256,
    };
    try {
      await cleanupIntegratedWorktreeWhileLocked({ result: itemResult, cwd, worktreePath: item.worktreePath, deferCleanup: false, beforeCleanupHook });
    } catch (error) {
      itemResult.sourceCleanup = { cleanup: "failed", error: redactSensitiveText(error?.message || String(error)) };
      itemResult.cleanupWarning = itemResult.sourceCleanup.error;
    }
    identity.sourceCleanup = itemResult.sourceCleanup;
    if (itemResult.sourceCleanup?.cleanup === "success") removed += 1;
    if (itemResult.cleanupWarning) warnings.push(`item ${identity.index} (${item.worktreePath}): ${itemResult.cleanupWarning}`);
  }
  if (requested) {
    result.sourceCleanup = { cleanup: removed === requested ? "success" : "partial", requested, removed, retained: requested - removed };
  }
  if (warnings.length) result.cleanupWarning = warnings.join(" ");
}

async function recordChangedFiles(runId, cwd, changedFiles, disallowedFiles = []) {
  if (!runId) {
    return;
  }

  const db = await openLockDb(cwd);
  try {
    db.exec("BEGIN IMMEDIATE");
    const disallowed = new Set(normalizeLockPathListForCwd(disallowedFiles, cwd));
    const insert = db.prepare("INSERT INTO changed_files (run_id, path, allowed) VALUES (?, ?, ?)");
    for (const file of normalizeLockPathListForCwd(changedFiles, cwd)) {
      insert.run(runId, file, disallowed.has(file) ? 0 : 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original audit persistence error. */ }
    throw error;
  } finally {
    closeDb(db);
  }
}
  return { integratePatchWithoutSerialLock, integrationCleanupTargetStateError, cleanupIntegratedWorktreeWhileLocked, cleanupIntegratedBatchWorktreesWhileLocked, recordChangedFiles, getIntegrationScratchCleanupTestHook, setIntegrationScratchCleanupTestHook };
}
