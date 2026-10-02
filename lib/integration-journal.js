// Integration journal: durable integration operations, their transitions, recovery and quarantine.
// Extracted from server.js in modularization round M-001.

import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { integrationFingerprintMode, integrationJournalAad, integrationJournalFingerprintSha256, integrationJournalTargetPath, integrationOperationDiagnosisView, integrationOperationResult, integrationPathspecs, integrationRecoveryErrorIsTransient } from "./integration.js";
import { normalizeLockPathList } from "./paths.js";
import { redactSensitiveText, sanitizePersistedValue } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createIntegrationJournalRuntime({ BRIDGE_INSTANCE_ID, CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, INTEGRATION_RESOLVED_SQL, INTEGRATION_RESOLVED_STATUSES, captureIntegrationTargetState, closeDb, decryptIntegrationJournalBytes, durableFileMode, encryptIntegrationJournalBytes, ensureParentDir, exactIntegrationFileSnapshot, gitIndexPathSnapshot, integrationContentMismatches, integrationWorktreeRules, logEvent, openLockDb, removeRollbackLeaf, replaceRollbackLeaf, runGitReadOnlyCommand, safeRollbackParent, stateCapacityError, truncateText }) {
async function captureIntegrationJournalEvidence({ cwd, files, expectedPostSnapshot, operationId }) {
  if (!(expectedPostSnapshot instanceof Map)) {
    throw new Error("Integration journal requires an exact expected post-apply snapshot.");
  }
  const evidence = [];
  let totalBytes = 0;
  for (const [ordinal, file] of normalizeLockPathList(files).entries()) {
    const target = integrationJournalTargetPath(cwd, file);
    let preKind = "missing";
    let preMode = 0;
    let preContent = Buffer.alloc(0);
    try {
      const details = await lstat(target);
      if (details.isSymbolicLink()) {
        preKind = "link";
        preContent = Buffer.from(await readlink(target), "utf8");
      } else if (details.isFile()) {
        if (details.size > CONFIG.maxSnapshotFileBytes) {
          const error = new Error("Integration journal preimage exceeds the per-file safety limit.");
          error.errorType = "snapshot_safety_limit_exceeded";
          throw error;
        }
        preKind = "file";
        preMode = durableFileMode(details);
        preContent = await readFile(target);
      } else {
        const error = new Error("Integration journal cannot capture a non-file path.");
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    totalBytes += preContent.length;
    if (totalBytes > CONFIG.maxSnapshotTotalBytes) {
      const error = new Error("Integration journal preimages exceed the total snapshot safety limit.");
      error.errorType = "snapshot_safety_limit_exceeded";
      throw error;
    }

    const postFingerprint = expectedPostSnapshot.get(file);
    if (typeof postFingerprint !== "string") {
      throw new Error("Integration journal expected post-apply evidence is incomplete.");
    }
    evidence.push({
      ordinal,
      path: file,
      preKind,
      preMode,
      preSha256: createHash("sha256").update(preKind === "missing" ? Buffer.from("missing") : preContent).digest("hex"),
      preEncrypted: preKind === "missing"
        ? null
        : await encryptIntegrationJournalBytes(preContent, integrationJournalAad(operationId, file, "pre")),
      postSha256: integrationJournalFingerprintSha256(postFingerprint),
      postEncrypted: await encryptIntegrationJournalBytes(
        Buffer.from(postFingerprint, "utf8"),
        integrationJournalAad(operationId, file, "post")
      ),
    });
  }
  return evidence;
}

function assertIntegrationLockOwned(db, cwd, lock) {
  if (!lock) return;
  const now = Date.now();
  const tokenSha256 = `sha256:${createHash("sha256").update(String(lock.token || "")).digest("hex")}`;
  const owned = db.prepare(`
    SELECT 1 FROM locks
    WHERE run_id = ? AND token = ? AND cwd = ? AND lock_mode = 'serial_integration' AND expires_at > ?
    LIMIT 1
  `).get(lock.id || "", tokenSha256, path.resolve(cwd), now);
  if (!owned) {
    const error = new Error("The durable serial integration lock is no longer owned.");
    error.errorType = "integration_lock_ownership_lost";
    throw error;
  }
}

async function prepareIntegrationOperation({
  cwd,
  pipelineId = "",
  pipelineJobId = "",
  targetState,
  patch,
  contractSha256,
  expectedPostSnapshot,
  integrationLock = null,
}) {
  const operationId = `integration-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const ownerGeneration = randomBytes(16).toString("hex");
  const affectedPaths = normalizeLockPathList(patch.changedFiles || []);
  if (!affectedPaths.length) {
    // An operation without file rows has nothing for recovery to verify: it would be closed
    // recovered_noop while a non-empty patch stayed applied.
    const error = new Error("Integration journal refused an operation with no affected paths; the patch file list is unknown.");
    error.errorType = "integration_journal_paths_missing";
    throw error;
  }
  const evidence = await captureIntegrationJournalEvidence({
    cwd,
    files: affectedPaths,
    expectedPostSnapshot,
    operationId,
  });
  const preIndexEntries = await gitIndexPathSnapshot(cwd, affectedPaths);
  const createdAt = new Date().toISOString();
  const db = await openLockDb(cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    assertIntegrationLockOwned(db, cwd, integrationLock);
    const quarantine = db.prepare(`
      SELECT operation_id FROM integration_operations
      WHERE cwd = ? AND status = 'quarantined'
      ORDER BY updated_at LIMIT 1
    `).get(path.resolve(cwd));
    if (quarantine) {
      const error = new Error("A quarantined integration operation blocks further repository mutation.");
      error.errorType = "integration_recovery_quarantined";
      error.operationId = quarantine.operation_id;
      throw error;
    }
    const capacity = stateCapacityError(db);
    if (capacity) {
      const error = new Error(capacity.error);
      error.errorType = capacity.errorType;
      throw error;
    }
    db.prepare(`
      INSERT INTO integration_operations
        (operation_id, cwd, pipeline_id, pipeline_job_id, owner_instance_id, owner_generation,
         revision, status, target_head, target_state_sha256, pre_index_sha256, patch_sha256,
         source_base_commit, source_state_sha256, contract_sha256, affected_paths_json,
         result_json, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL)
    `).run(
      operationId,
      path.resolve(cwd),
      String(pipelineId || ""),
      String(pipelineJobId || ""),
      BRIDGE_INSTANCE_ID,
      ownerGeneration,
      targetState.targetHead,
      targetState.targetStateSha256,
      targetState.indexSha256,
      patch.patchSha256,
      patch.sourceBaseCommit,
      patch.sourceStateSha256,
      contractSha256,
      JSON.stringify(affectedPaths),
      createdAt,
      createdAt
    );
    const insertFile = db.prepare(`
      INSERT INTO integration_operation_files
        (operation_id, ordinal, path, pre_kind, pre_mode, pre_sha256, pre_encrypted, post_sha256, post_encrypted, pre_index_entry_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of evidence) {
      insertFile.run(
        operationId,
        item.ordinal,
        item.path,
        item.preKind,
        item.preMode,
        item.preSha256,
        item.preEncrypted,
        item.postSha256,
        item.postEncrypted,
        integrationJournalFingerprintSha256(preIndexEntries.get(item.path) ?? "")
      );
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return { operationId, ownerGeneration };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the journal error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

const INTEGRATION_JOURNAL_TERMINAL = new Set([...INTEGRATION_RESOLVED_STATUSES, "quarantined"]);

async function transitionIntegrationOperation(cwd, operationId, expectedStatuses, status, result = {}, authority = null) {
  const allowed = [...new Set((Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses]).filter(Boolean))];
  if (!allowed.length) throw new Error("Integration journal transition requires an expected status.");
  const updatedAt = new Date().toISOString();
  const finishedAt = INTEGRATION_JOURNAL_TERMINAL.has(status) ? updatedAt : null;
  const safeResult = JSON.stringify(sanitizePersistedValue(result || {}));
  const placeholders = allowed.map(() => "?").join(", ");
  const db = await openLockDb(cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    assertIntegrationLockOwned(db, cwd, authority?.lock || null);
    let current = db.prepare(`
      SELECT revision, status, owner_instance_id, owner_generation
      FROM integration_operations WHERE operation_id = ? AND cwd = ?
    `).get(operationId, path.resolve(cwd));
    if (!current) throw new Error("Integration journal operation is missing.");
    if (authority?.ownerGeneration
      && (current.owner_instance_id !== BRIDGE_INSTANCE_ID || current.owner_generation !== authority.ownerGeneration)) {
      if (!authority.allowTakeover) {
        const error = new Error("Integration journal ownership generation changed before transition.");
        error.errorType = "integration_journal_cas_rejected";
        throw error;
      }
      const claimed = db.prepare(`
        UPDATE integration_operations
        SET owner_instance_id = ?, owner_generation = ?, updated_at = ?, revision = revision + 1
        WHERE operation_id = ? AND cwd = ? AND revision = ? AND status = ?
      `).run(
        BRIDGE_INSTANCE_ID,
        authority.ownerGeneration,
        updatedAt,
        operationId,
        path.resolve(cwd),
        Number(current.revision || 0),
        current.status
      );
      if (Number(claimed.changes || 0) !== 1) {
        const error = new Error("Integration journal recovery ownership claim was lost.");
        error.errorType = "integration_journal_cas_rejected";
        throw error;
      }
      current = { ...current, revision: Number(current.revision || 0) + 1, owner_instance_id: BRIDGE_INSTANCE_ID, owner_generation: authority.ownerGeneration };
    }
    if (current.status === status) {
      db.exec("COMMIT");
      transactionOpen = false;
      return { ok: true, status, revision: Number(current.revision || 0) };
    }
    if (!allowed.includes(current.status)) {
      const error = new Error(`Integration journal transition rejected from ${current.status} to ${status}.`);
      error.errorType = "integration_journal_cas_rejected";
      throw error;
    }
    const changed = db.prepare(`
      UPDATE integration_operations
      SET status = ?, result_json = ?, updated_at = ?, finished_at = ?, revision = revision + 1
      WHERE operation_id = ? AND cwd = ? AND revision = ? AND status IN (${placeholders})
        AND (? = '' OR (owner_instance_id = ? AND owner_generation = ?))
    `).run(
      status,
      safeResult,
      updatedAt,
      finishedAt,
      operationId,
      path.resolve(cwd),
      Number(current.revision || 0),
      ...allowed,
      authority?.ownerGeneration || "",
      BRIDGE_INSTANCE_ID,
      authority?.ownerGeneration || ""
    );
    if (Number(changed.changes || 0) !== 1) {
      const error = new Error("Integration journal compare-and-swap was lost.");
      error.errorType = "integration_journal_cas_rejected";
      throw error;
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return { ok: true, status, revision: Number(current.revision || 0) + 1 };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the journal error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

async function readIntegrationJournalFileEvidence(operation, row) {
  let preContent = Buffer.alloc(0);
  if (row.pre_kind !== "missing") {
    preContent = await decryptIntegrationJournalBytes(
      row.pre_encrypted,
      integrationJournalAad(operation.operation_id, row.path, "pre")
    );
  }
  const expectedPreSha256 = createHash("sha256")
    .update(row.pre_kind === "missing" ? Buffer.from("missing") : preContent)
    .digest("hex");
  if (expectedPreSha256 !== row.pre_sha256) throw new Error("Integration journal preimage hash mismatch.");
  const postFingerprint = (await decryptIntegrationJournalBytes(
    row.post_encrypted,
    integrationJournalAad(operation.operation_id, row.path, "post")
  )).toString("utf8");
  if (integrationJournalFingerprintSha256(postFingerprint) !== row.post_sha256) {
    throw new Error("Integration journal post-state hash mismatch.");
  }
  const preFingerprint = row.pre_kind === "missing"
    ? "missing"
    : row.pre_kind === "link"
      ? `link:${preContent.toString("utf8")}`
      : `file:${integrationFingerprintMode(Number(row.pre_mode || 0), await integrationWorktreeRules(operation.cwd))}:${createHash("sha256").update(preContent).digest("hex")}`;
  return { ...row, preContent, preFingerprint, postFingerprint };
}

async function restoreIntegrationJournalFile(cwd, evidence) {
  const target = integrationJournalTargetPath(cwd, evidence.path);
  if (evidence.pre_kind === "missing") {
    await safeRollbackParent(cwd, target);
    if (!await removeRollbackLeaf(target)) throw new Error("Integration journal rollback target is a directory.");
    return;
  }
  await ensureParentDir(target);
  const restored = await replaceRollbackLeaf({
    cwd,
    target,
    kind: evidence.pre_kind,
    content: evidence.pre_kind === "link" ? evidence.preContent.toString("utf8") : evidence.preContent,
    mode: Number(evidence.pre_mode || 0),
  });
  if (!restored) throw new Error("Integration journal could not restore an exact preimage.");
}

async function quarantineIntegrationOperation(cwd, operationId, expectedStatuses, reason, authority = null, details = {}) {
  try {
    await transitionIntegrationOperation(cwd, operationId, expectedStatuses, "quarantined", {
      ...details,
      outcome: "quarantined",
      reason: String(reason || "integration_recovery_ambiguous"),
    }, authority);
    return true;
  } catch (error) {
    logEvent("error", "integration.journal_quarantine_failed", {
      operationId,
      errorType: error?.errorType || "integration_journal_persistence_failed",
    });
    return false;
  }
}

function integrationRecoveryErrorText(error) {
  return truncateText(redactSensitiveText(String(error?.message || error || "unknown error")), 500);
}


// Decides whether HEAD and the real Git index still hold the state the operation was prepared
// on. With per-path index evidence in the journal only the affected paths count: their index
// entries must be unchanged, and a HEAD that moved is accepted when no commit since the
// recorded HEAD touched them (Codex committing or staging unrelated work while an operation is
// unresolved used to quarantine the repository permanently). Rows written by older bridges have
// only the whole-index identity and keep the whole-index rule; this never fails open.
// Returns { ok: true } | { ok: false, proven: true, details } | { ok: false, proven: false, errorType, error }.
async function integrationRecoveryBaseline(cwd, operation, fileRows, affectedPaths) {
  const unavailable = (errorType, error) => ({
    ok: false,
    proven: false,
    errorType: errorType || "integration_recovery_evidence_unavailable",
    error: integrationRecoveryErrorText(error),
  });
  try {
    const perPath = fileRows.length > 0
      && fileRows.every((row) => /^[a-f0-9]{64}$/.test(String(row.pre_index_entry_sha256 || "")));
    if (!perPath) {
      const state = await captureIntegrationTargetState(cwd);
      if (!state.ok) return unavailable(state.errorType || "integration_target_state_failed", state.error);
      const headMoved = state.targetHead !== operation.target_head;
      const indexChanged = state.indexSha256 !== operation.pre_index_sha256;
      if (headMoved || indexChanged) {
        return { ok: false, proven: true, details: { evidence: "whole_index", headMoved, indexChanged } };
      }
      return {
        ok: true,
        evidence: "whole_index",
        headMoved: false,
        externalDriftOutsidePatch: state.targetStateSha256 !== operation.target_state_sha256,
      };
    }
    const head = await runGitReadOnlyCommand(["rev-parse", "--verify", "HEAD^{commit}"], cwd, 1000 * 15);
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      return unavailable("integration_target_state_failed", head.stderr || head.stdout || "Could not resolve the target HEAD.");
    }
    const currentHead = head.stdout.trim();
    const index = await gitIndexPathSnapshot(cwd, affectedPaths);
    const indexMismatches = fileRows
      .filter((row) => integrationJournalFingerprintSha256(index.get(row.path) ?? "") !== row.pre_index_entry_sha256)
      .map((row) => row.path);
    const headMoved = currentHead !== operation.target_head;
    let committedChanges = [];
    if (headMoved) {
      const diff = await runGitReadOnlyCommand(
        ["diff", "--name-only", "--no-renames", "-z", operation.target_head, currentHead, "--", ...integrationPathspecs(affectedPaths)],
        cwd,
        1000 * 30
      );
      if (diff.exitCode !== 0) {
        const recorded = await runGitReadOnlyCommand(["cat-file", "-e", `${operation.target_head}^{commit}`], cwd, 1000 * 15);
        if (typeof recorded.exitCode === "number" && recorded.exitCode !== 0) {
          // The recorded HEAD is gone from the repository, so nothing can show the affected
          // paths' committed content is unchanged.
          return { ok: false, proven: true, details: { evidence: "affected_paths", headMoved, recordedHeadMissing: true, indexMismatches } };
        }
        return unavailable("integration_target_state_failed", diff.stderr || diff.stdout || "Could not compare the recorded and current HEAD.");
      }
      committedChanges = normalizeLockPathList(diff.stdout.split("\0"));
    }
    if (indexMismatches.length || committedChanges.length) {
      return { ok: false, proven: true, details: { evidence: "affected_paths", headMoved, indexMismatches, committedChanges } };
    }
    return { ok: true, evidence: "affected_paths", headMoved, currentHead };
  } catch (error) {
    return unavailable(error?.errorType || "integration_recovery_evidence_unavailable", error);
  }
}

async function recoverSingleIntegrationOperationWhileLocked(cwd, operation, fileRows, authority = null) {
  const recoverableStatuses = [
    "prepared",
    "applying",
    "applied_unvalidated",
    "validating",
    "validated",
    "rolling_back",
    "recovering",
  ];
  const operationId = operation.operation_id;
  let currentStatus = operation.status;
  // Quarantine only on proven mismatch or corrupt evidence; the reason and the error text go to
  // result_json so diagnose_opencode_bridge can show why the repository is blocked.
  const quarantine = async (reason, details = {}) => {
    const persisted = await quarantineIntegrationOperation(
      cwd,
      operationId,
      [currentStatus, "recovering", "rolling_back"],
      reason,
      authority,
      details
    );
    if (!persisted) {
      return {
        ok: false,
        retryable: true,
        operationId,
        status: currentStatus,
        errorType: "integration_journal_persistence_failed",
        error: `The quarantine (${reason}) could not be recorded; the operation stays ${currentStatus} and recovery retries it.`,
        pendingReason: reason,
      };
    }
    return { ok: false, operationId, status: "quarantined", reason };
  };
  // Evidence unavailable: leave the operation nonterminal (recovering, or rolling_back after a
  // partial restore; both are starting states here) so the next recovery pass retries it.
  const retry = (errorType, error) => {
    const message = integrationRecoveryErrorText(error);
    logEvent("warn", "integration.recovery_retryable", { operationId, status: currentStatus, errorType, error: message });
    return { ok: false, retryable: true, operationId, status: currentStatus, errorType, error: message };
  };

  if (!recoverableStatuses.includes(operation.status)) {
    return await quarantine("journal_status_unknown", { status: String(operation.status || "") });
  }
  if (operation.status !== "recovering") {
    try {
      await transitionIntegrationOperation(cwd, operationId, operation.status, "recovering", {
        outcome: "recovery_started",
      }, authority);
      currentStatus = "recovering";
    } catch (error) {
      return retry(error?.errorType || "integration_journal_persistence_failed", error);
    }
  }

  let normalizedPaths;
  try {
    const expectedPaths = JSON.parse(operation.affected_paths_json || "[]");
    normalizedPaths = normalizeLockPathList(expectedPaths);
    if (!Array.isArray(expectedPaths)
      || !normalizedPaths.length
      || normalizedPaths.length !== expectedPaths.length
      || fileRows.length !== normalizedPaths.length
      || fileRows.some((row, ordinal) => row.ordinal !== ordinal || row.path !== normalizedPaths[ordinal])) {
      throw new Error("Integration journal path cardinality is inconsistent.");
    }
  } catch (error) {
    return await quarantine("journal_evidence_inconsistent", { error: integrationRecoveryErrorText(error) });
  }
  const evidence = [];
  try {
    for (const row of fileRows) evidence.push(await readIntegrationJournalFileEvidence(operation, row));
  } catch (error) {
    if (integrationRecoveryErrorIsTransient(error)) return retry("integration_journal_evidence_unavailable", error);
    return await quarantine("journal_evidence_unreadable", { error: integrationRecoveryErrorText(error) });
  }

  const baseline = await integrationRecoveryBaseline(cwd, operation, fileRows, normalizedPaths);
  if (!baseline.ok) {
    return baseline.proven
      ? await quarantine("target_head_or_index_drift", baseline.details)
      : retry(baseline.errorType, baseline.error);
  }

  const classifications = new Map();
  try {
    const currentSnapshot = await exactIntegrationFileSnapshot(cwd, normalizedPaths);
    for (const item of evidence) {
      const current = currentSnapshot.get(item.path);
      if (current === item.preFingerprint) {
        classifications.set(item.path, "pre");
        continue;
      }
      const postMismatches = await integrationContentMismatches(
        cwd,
        new Map([[item.path, item.postFingerprint]]),
        new Map([[item.path, current]]),
        [item.path]
      );
      classifications.set(item.path, postMismatches.length ? "third" : "post");
    }
  } catch (error) {
    // A directory or an over-limit file at an affected path is neither the preimage nor the
    // bridge's post-image (both were captured within the limits).
    if (error?.errorType === "snapshot_safety_limit_exceeded") {
      return await quarantine("affected_path_drift", { error: integrationRecoveryErrorText(error) });
    }
    return retry("integration_recovery_evidence_unavailable", error);
  }
  const thirdPaths = [...classifications].filter(([, value]) => value === "third").map(([file]) => file);
  if (thirdPaths.length) {
    return await quarantine("affected_path_drift", { paths: thirdPaths.slice(0, 20) });
  }

  if ([...classifications.values()].every((value) => value === "pre")) {
    // HEAD, the index and every affected path are at their preimage, so the patch left no
    // trace. Other drift (an ignored file another process rewrote, an edit outside the patch)
    // is not the bridge's and used to quarantine the repository, blocking every writer.
    try {
      await transitionIntegrationOperation(cwd, operationId, "recovering", "recovered_noop", {
        outcome: "pre_state_verified",
        evidence: baseline.evidence,
        headMoved: Boolean(baseline.headMoved),
        ...(baseline.evidence === "whole_index" ? { externalDriftOutsidePatch: baseline.externalDriftOutsidePatch } : {}),
      }, authority);
    } catch (error) {
      return retry(error?.errorType || "integration_journal_persistence_failed", error);
    }
    return { ok: true, operationId, status: "recovered_noop" };
  }

  try {
    await transitionIntegrationOperation(cwd, operationId, "recovering", "rolling_back", {
      outcome: "exact_preimage_rollback_started",
    }, authority);
    currentStatus = "rolling_back";
  } catch (error) {
    return retry(error?.errorType || "integration_journal_persistence_failed", error);
  }
  for (const item of evidence) {
    if (classifications.get(item.path) !== "post") continue;
    try {
      await restoreIntegrationJournalFile(cwd, item);
    } catch (error) {
      // Restored paths are at their preimage and the rest still at the post-image, so a retry
      // classifies and restores again; only a restore that cannot succeed is quarantined.
      if (integrationRecoveryErrorIsTransient(error)) return retry("integration_recovery_restore_failed", error);
      return await quarantine("rollback_restore_failed", { path: item.path, error: integrationRecoveryErrorText(error) });
    }
  }
  let restoreMismatches;
  try {
    const restoredSnapshot = await exactIntegrationFileSnapshot(cwd, normalizedPaths);
    restoreMismatches = evidence.filter((item) => restoredSnapshot.get(item.path) !== item.preFingerprint).map((item) => item.path);
  } catch (error) {
    if (error?.errorType === "snapshot_safety_limit_exceeded") {
      return await quarantine("rollback_verification_failed", { error: integrationRecoveryErrorText(error) });
    }
    return retry("integration_recovery_evidence_unavailable", error);
  }
  if (restoreMismatches.length) {
    return await quarantine("rollback_verification_failed", { paths: restoreMismatches.slice(0, 20) });
  }
  const restoredBaseline = await integrationRecoveryBaseline(cwd, operation, fileRows, normalizedPaths);
  if (!restoredBaseline.ok) {
    return restoredBaseline.proven
      ? await quarantine("target_head_or_index_drift", { ...restoredBaseline.details, phase: "after_rollback" })
      : retry(restoredBaseline.errorType, restoredBaseline.error);
  }
  try {
    await transitionIntegrationOperation(cwd, operationId, "rolling_back", "rolled_back", {
      outcome: "exact_pre_state_restored",
      evidence: restoredBaseline.evidence,
      headMoved: Boolean(restoredBaseline.headMoved),
      ...(restoredBaseline.evidence === "whole_index" ? { externalDriftOutsidePatch: restoredBaseline.externalDriftOutsidePatch } : {}),
    }, authority);
  } catch (error) {
    return retry(error?.errorType || "integration_journal_persistence_failed", error);
  }
  return { ok: true, operationId, status: "rolled_back" };
}

// Quarantines left by the older whole-repository rules (repository_state_drift, and
// target_head_or_index_drift for a HEAD or index change on paths outside the patch) are
// re-checked under the integration lock with the per-path rule and closed as recovered_noop
// when HEAD, the index entries and every affected path prove the preimage; anything else stays
// quarantined.
const REQUALIFIABLE_INTEGRATION_QUARANTINES = new Set(["repository_state_drift", "target_head_or_index_drift"]);

async function requalifyStateDriftQuarantine(cwd, operation, fileRows, authority) {
  let reason = "";
  try { reason = JSON.parse(operation.result_json || "{}").reason || ""; } catch {}
  if (!REQUALIFIABLE_INTEGRATION_QUARANTINES.has(reason)) return false;
  try {
    const expectedPaths = normalizeLockPathList(JSON.parse(operation.affected_paths_json || "[]"));
    if (!expectedPaths.length
      || fileRows.length !== expectedPaths.length
      || fileRows.some((row, ordinal) => row.ordinal !== ordinal || row.path !== expectedPaths[ordinal])) {
      return false;
    }
    const baseline = await integrationRecoveryBaseline(cwd, operation, fileRows, expectedPaths);
    if (!baseline.ok) return false;
    const currentSnapshot = await exactIntegrationFileSnapshot(cwd, expectedPaths);
    for (const row of fileRows) {
      const evidence = await readIntegrationJournalFileEvidence(operation, row);
      if (currentSnapshot.get(evidence.path) !== evidence.preFingerprint) return false;
    }
    await transitionIntegrationOperation(cwd, operation.operation_id, "quarantined", "recovered_noop", {
      outcome: "pre_state_verified",
      requalifiedFrom: reason,
      evidence: baseline.evidence,
      headMoved: Boolean(baseline.headMoved),
      externalDriftOutsidePatch: true,
    }, authority);
    logEvent("info", "integration.quarantine_requalified", { operationId: operation.operation_id, reason });
    return true;
  } catch {
    return false;
  }
}

async function recoverIntegrationOperationsWhileLocked(cwd, { operationId = "", integrationLock = null } = {}) {
  const canonicalCwd = path.resolve(cwd || process.cwd());
  const recoveryAuthority = integrationLock ? {
    lock: integrationLock,
    ownerGeneration: randomBytes(16).toString("hex"),
    allowTakeover: true,
  } : null;
  const db = await openLockDb(canonicalCwd);
  let operations;
  let files;
  try {
    const filter = operationId ? "AND operation_id = ?" : "";
    const args = operationId ? [canonicalCwd, operationId] : [canonicalCwd];
    operations = db.prepare(`
      SELECT * FROM integration_operations
      WHERE cwd = ? ${filter}
        AND status NOT IN (${INTEGRATION_RESOLVED_SQL})
      ORDER BY created_at, operation_id
    `).all(...args);
    const ids = operations.map((row) => row.operation_id);
    files = ids.length
      ? db.prepare(`
          SELECT * FROM integration_operation_files
          WHERE operation_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY operation_id, ordinal
        `).all(...ids)
      : [];
  } finally {
    closeDb(db);
  }

  for (const operation of operations.filter((row) => row.status === "quarantined")) {
    const requalified = await requalifyStateDriftQuarantine(
      canonicalCwd,
      operation,
      files.filter((row) => row.operation_id === operation.operation_id),
      recoveryAuthority
    );
    if (requalified) operation.status = "recovered_noop";
  }
  operations = operations.filter((row) => row.status !== "recovered_noop");
  const existingQuarantine = operations.filter((row) => row.status === "quarantined");
  if (existingQuarantine.length) {
    return {
      ok: false,
      errorType: "integration_recovery_quarantined",
      operationIds: existingQuarantine.map((row) => row.operation_id),
      recovered: [],
    };
  }
  const recovered = [];
  for (const operation of operations) {
    const result = await recoverSingleIntegrationOperationWhileLocked(
      canonicalCwd,
      operation,
      files.filter((row) => row.operation_id === operation.operation_id),
      recoveryAuthority
    );
    recovered.push(result);
    if (!result.ok) {
      // A retryable result left the operation nonterminal (evidence was unavailable, nothing
      // was proven); the deferred recovery pass or the next integration retries it.
      return result.retryable
        ? {
            ok: false,
            retryable: true,
            errorType: "integration_recovery_retryable",
            causeErrorType: result.errorType || "",
            error: result.error || "",
            operationIds: [result.operationId],
            recovered,
          }
        : {
            ok: false,
            errorType: "integration_recovery_quarantined",
            operationIds: [result.operationId],
            reason: result.reason || "",
            recovered,
          };
    }
  }
  return { ok: true, recovered };
}

async function readIntegrationOperationSummary(cwd, operationId) {
  if (!operationId) return null;
  const db = await openLockDb(cwd);
  try {
    const row = db.prepare(`
      SELECT operation_id, pipeline_id, pipeline_job_id, status, patch_sha256,
             source_state_sha256, contract_sha256, result_json, created_at, updated_at, finished_at
      FROM integration_operations
      WHERE operation_id = ? AND cwd = ?
    `).get(operationId, path.resolve(cwd || process.cwd()));
    return row ? {
      operationId: row.operation_id,
      pipelineId: row.pipeline_id || "",
      pipelineJobId: row.pipeline_job_id || "",
      status: row.status,
      reason: integrationOperationResult(row).reason || "",
      patchSha256: row.patch_sha256,
      sourceStateSha256: row.source_state_sha256,
      contractSha256: row.contract_sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at || "",
    } : null;
  } finally {
    closeDb(db);
  }
}



// The integration journal as diagnose_opencode_bridge shows it: every unresolved operation
// (these block writers; quarantined ones until resolved) up to the limit, the most recent
// finished ones, and the roots the in-memory recovery pass currently blocks.
async function integrationJournalDiagnosis(cwd, { limit = 20 } = {}) {
  const canonicalCwd = path.resolve(cwd || process.cwd());
  const db = await openLockDb(canonicalCwd);
  try {
    const columns = "operation_id, cwd, pipeline_id, status, affected_paths_json, result_json, created_at, updated_at";
    const unresolvedCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM integration_operations
      WHERE cwd = ? AND status NOT IN (${INTEGRATION_RESOLVED_SQL})
    `).get(canonicalCwd)?.count || 0);
    const unresolved = db.prepare(`
      SELECT ${columns} FROM integration_operations
      WHERE cwd = ? AND status NOT IN (${INTEGRATION_RESOLVED_SQL})
      ORDER BY updated_at DESC, operation_id LIMIT ?
    `).all(canonicalCwd, limit);
    const recent = db.prepare(`
      SELECT ${columns} FROM integration_operations
      WHERE cwd = ? AND status IN (${INTEGRATION_RESOLVED_SQL})
      ORDER BY updated_at DESC, operation_id LIMIT ?
    `).all(canonicalCwd, limit);
    return {
      unresolvedCount,
      writersBlocked: unresolvedCount > 0 || INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(canonicalCwd),
      unresolved: unresolved.map(integrationOperationDiagnosisView),
      recentTerminal: recent.map(integrationOperationDiagnosisView),
      blockedRoots: [...INTEGRATION_RECOVERY_BLOCKED_ROOTS].slice(0, limit),
      blockedRootCount: INTEGRATION_RECOVERY_BLOCKED_ROOTS.size,
    };
  } finally {
    closeDb(db);
  }
}
  return { captureIntegrationJournalEvidence, assertIntegrationLockOwned, prepareIntegrationOperation, INTEGRATION_JOURNAL_TERMINAL, transitionIntegrationOperation, readIntegrationJournalFileEvidence, restoreIntegrationJournalFile, quarantineIntegrationOperation, integrationRecoveryErrorText, integrationRecoveryBaseline, recoverSingleIntegrationOperationWhileLocked, REQUALIFIABLE_INTEGRATION_QUARANTINES, requalifyStateDriftQuarantine, recoverIntegrationOperationsWhileLocked, readIntegrationOperationSummary, integrationJournalDiagnosis };
}
