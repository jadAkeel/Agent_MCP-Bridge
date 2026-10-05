// Serial integration: the repository integration lock, recovery under it and quarantine resolution.
// Extracted from server.js in modularization round M-001.

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { integrationOperationResult, integrationRecoveryErrorIsTransient } from "./integration.js";
import { REPOSITORY_SCOPE_LOCK_PATH, normalizeLockPathList, normalizeLockPathListForCwd } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createIntegrationSerialRuntime({ worktreeArtifactStatus, CONFIG, DEFAULT_LOCK_TTL_MS, INTEGRATION_RECOVERY_BLOCKED_ROOTS, INTEGRATION_RESOLVED_STATUSES, abortSignalErrorType, acquireHardLock, cleanupIntegratedBatchWorktreesWhileLocked, cleanupIntegratedWorktreeWhileLocked, closeDb, conflictPathsFromConflict, exactIntegrationFileSnapshot, integratePatchWithoutSerialLock, integrationJournalDiagnosis, integrationRecoveryBaseline, integrationRecoveryErrorText, logEvent, openLockDb, readIntegrationJournalFileEvidence, readIntegrationOperationSummary, recoverIntegrationOperationsWhileLocked, releaseHardLock, runCommand, startHardLockHeartbeat, transitionIntegrationOperation, truncateText }) {
async function integratePatchSerially(options) {
  const requestedCwd = path.resolve(options.cwd || process.cwd());
  const targetRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], requestedCwd, 1000 * 15);
  if (targetRoot.exitCode !== 0 || !targetRoot.stdout.trim()) {
    return {
      ok: false,
      errorType: "integration_target_invalid",
      error: targetRoot.stderr || "Integration target is not inside a Git repository.",
    };
  }

  const targetCwd = path.resolve(targetRoot.stdout.trim());
  // I-002: a batch's items carry their own scopes, normalized against the target like
  // allowedEdits; the serial lock and the combined plan cover their union.
  if (options.batch) {
    const batchItems = (Array.isArray(options.batch.items) ? options.batch.items : []).map((item) => ({
      worktreePath: item?.worktreePath ? path.resolve(item.worktreePath) : "",
      branch: String(item?.branch || ""),
      allowedEdits: normalizeLockPathListForCwd(item?.allowedEdits, targetCwd),
      cleanup: Boolean(item?.cleanup),
      // Q-017: an auto-integrated item carries the identity its queue job finished with (B-114);
      // the batch collector checks it per item. The integrate_opencode_worktrees tool passes none.
      ...(item?.expectedSourceIdentity ? { expectedSourceIdentity: item.expectedSourceIdentity } : {}),
    }));
    options = {
      ...options,
      batch: { ...options.batch, items: batchItems },
      allowedEdits: batchItems.flatMap((item) => item.allowedEdits),
      worktreePath: "",
      branch: "",
      cleanupAfterSuccess: false,
    };
  }
  // Q-018: name an in-use source before a path-lock conflict; collection rechecks under the lock.
  const sources = options.batch ? options.batch.items : [{ worktreePath: options.worktreePath }];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index].worktreePath;
    if (source && await worktreeArtifactStatus({ cwd: targetCwd, worktreePath: source }) === "in_use") {
      return { ok: false, errorType: "worktree_in_use", error: `The source worktree ${source} is in use by a job and cannot be integrated.`,
        suggestedFix: "Wait for the job using this worktree to finish, then preview and integrate its total patch.",
        ...(options.batch ? { batchItemNumbers: [index + 1] } : {}) };
    }
  }
  const normalizedAllowed = normalizeLockPathListForCwd(options.allowedEdits, targetCwd);
  if (!normalizedAllowed.length) {
    return integratePatchWithoutSerialLock({ ...options, cwd: targetCwd });
  }

  const acquireIntegrationLock = () => acquireHardLock({
    owner: "codex",
    agent: "merge_manager",
    task: "Serial worktree/branch integration",
    cwd: targetCwd,
    lockType: "serial_integration",
    paths: normalizedAllowed,
    ttlMs: Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10),
  });
  let lockResult = await acquireIntegrationLock();
  let pendingRecovery = null;
  if (!lockResult.ok && lockResult.errorType === "integration_recovery_pending") {
    // The lock refuses every writer while a journal operation is unresolved, so the recovery
    // this integration would run under its own lock is unreachable; run it once under the
    // repository-wide recovery lock and retry.
    pendingRecovery = await recoverIntegrationRepositorySerially(targetCwd);
    lockResult = await acquireIntegrationLock();
  }
  if (!lockResult.ok) {
    if (lockResult.errorType === "integration_recovery_pending") {
      const blocking = lockResult.operationId
        ? await readIntegrationOperationSummary(targetCwd, lockResult.operationId).catch(() => null)
        : (await integrationJournalDiagnosis(targetCwd, { limit: 1 }).catch(() => null))?.unresolved?.[0] || null;
      const operationId = lockResult.operationId || blocking?.operationId || "";
      const operationStatus = lockResult.operationStatus || blocking?.status || "";
      const reason = blocking?.reason || pendingRecovery?.reason || pendingRecovery?.causeErrorType || "";
      return {
        ok: false,
        errorType: "integration_recovery_pending",
        error: `Serial integration is blocked by an unresolved integration journal operation${operationId ? ` ${operationId}` : ""}${operationStatus ? ` (status ${operationStatus}${reason ? `, reason ${reason}` : ""})` : ""}. ${pendingRecovery?.errorType === "integration_recovery_lock_conflict"
          ? "Recovery could not start because other jobs hold locks on this checkout; it runs once they finish."
          : pendingRecovery?.retryable
            ? "Recovery ran but its evidence was temporarily unavailable; the operation stays unresolved and is retried."
            : "Recovery ran and could not prove the pre-integration state, so the operation stays quarantined."}`,
        operationId,
        operationStatus,
        reason,
        recovery: pendingRecovery
          ? { ok: Boolean(pendingRecovery.ok), errorType: pendingRecovery.errorType || "", retryable: Boolean(pendingRecovery.retryable) }
          : null,
        conflictingPaths: [],
        suggestedFix: operationStatus === "quarantined"
          ? "Run diagnose_opencode_bridge for this repository: its integrationOperations section shows the quarantined operation, its reason and affected paths. A target_head_or_index_drift quarantine is re-checked and closed automatically once those paths and their index entries are back at their pre-integration state. For any other reason use resolve_integration_quarantine (or `node bin/pipeline-admin.js resolve-quarantine <operationId>`): mode verify_restored after you put the affected paths back (it names any path still wrong and changes nothing), or, once the user has inspected the checkout and accepts it as it is, ask them to run `node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repository> --accept-current --reason \"...\"` (accept_current is operator-only, not an MCP mode). See \"A quarantine that does not clear\" in docs/USER_GUIDE.md."
          : "Run diagnose_opencode_bridge for this repository and read its integrationOperations section; the deferred recovery pass retries operations whose evidence was temporarily unavailable. Waiting for other jobs does not clear this.",
      };
    }
    return {
      ok: false,
      errorType: "integration_lock_conflict",
      error: `Serial integration could not acquire the repository lock: ${lockResult.error}`,
      conflictingPaths: conflictPathsFromConflict(lockResult.conflict),
      suggestedFix: "Wait for active readers/writers/integrations in this repository to finish, then retry the reviewed integration.",
    };
  }

  const integrationLockTtlMs = Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10);
  const stopIntegrationHeartbeat = startHardLockHeartbeat(lockResult.lock, integrationLockTtlMs);
  try {
    const recovery = await recoverIntegrationOperationsWhileLocked(targetCwd, { integrationLock: lockResult.lock });
    let result = recovery.ok
      ? await integratePatchWithoutSerialLock({
          ...options,
          cwd: targetCwd,
          allowedEdits: normalizedAllowed,
          signal: stopIntegrationHeartbeat.signal,
          integrationLock: lockResult.lock,
        })
      : recovery.retryable
        ? {
            ok: false,
            errorType: "integration_recovery_pending",
            error: `A prior integration operation could not be recovered yet because its evidence was temporarily unavailable (${recovery.causeErrorType || "unknown"}: ${recovery.error || "no detail"}). It stays unresolved and is retried; the patch was not applied.`,
            operationIds: recovery.operationIds || [],
            operationId: recovery.operationIds?.[0] || "",
            suggestedFix: "Retry the integration shortly, or run diagnose_opencode_bridge to see the unresolved operation.",
          }
        : {
            ok: false,
            errorType: recovery.errorType || "integration_recovery_quarantined",
            error: "A prior integration has ambiguous durable recovery evidence. The repository is quarantined from further bridge mutation until the recorded operation is inspected.",
            operationIds: recovery.operationIds || [],
            suggestedFix: "Run diagnose_opencode_bridge for this repository and read its integrationOperations section for the quarantined operation and its reason; resolve_integration_quarantine closes it (see \"A quarantine that does not clear\" in docs/USER_GUIDE.md).",
          };
    if (recovery.recovered?.length) result.recoveredIntegrationOperations = recovery.recovered;
    if (stopIntegrationHeartbeat.signal.aborted && result.ok && result.journalStatus !== "committed") {
      result = {
        ...result,
        ok: false,
        status: "ownership_lost",
        errorType: abortSignalErrorType(stopIntegrationHeartbeat.signal, "integration_lock_ownership_lost"),
        error: stopIntegrationHeartbeat.signal.reason?.message || "The serial integration lease was lost before completion could be accepted.",
      };
    }
    // B-069: an auto-integration's commit hooks, inside this lock, after the journal operation
    // committed and validation passed: prepare before the cleanup (it reads the source worktree),
    // commit after it (the cleanup checks that the target is still exactly as integrated).
    // Q-017: a batch too (one commit for every item); its per-item cleanup also runs before the commit.
    const afterApplyEligible = Boolean(options.afterApply) && result.ok && result.status === "applied"
      && result.journalStatus === "committed" && result.validationGate?.status === "passed";
    let afterApplyPrepared = null;
    if (afterApplyEligible) {
      afterApplyPrepared = await options.afterApply.prepare(result, { targetCwd })
        .catch((error) => ({ ok: false, errorType: "auto_integration_prepare_failed", error: redactSensitiveText(error?.message || String(error)) }));
    }
    if (result.ok && options.cleanupAfterSuccess && options.worktreePath) {
      await cleanupIntegratedWorktreeWhileLocked({
        result,
        cwd: targetCwd,
        worktreePath: options.worktreePath,
        deferCleanup: Boolean(options.deferCleanup),
        beforeCleanupHook: options.beforeCleanupHook,
      });
    }
    if (result.ok && result.status === "applied" && options.batch) {
      await cleanupIntegratedBatchWorktreesWhileLocked({
        result,
        cwd: targetCwd,
        items: options.batch.items,
        beforeCleanupHook: options.beforeCleanupHook,
      });
    }
    if (afterApplyEligible) {
      // B-074: the journal operation committed, so result.ok stays true when the lease is lost
      // afterwards; a commit made without the lock could race another integration, so none is made.
      result.afterApply = stopIntegrationHeartbeat.signal.aborted
        ? { ok: false, errorType: "integration_lease_lost", error: "The serial integration lease was lost after the patch was applied; the files are in the checkout but were not committed." }
        : await options.afterApply.commit(result, { targetCwd, prepared: afterApplyPrepared })
          .catch((error) => ({ ok: false, errorType: "auto_integration_commit_failed", error: redactSensitiveText(error?.message || String(error)) }));
    }
    result.integrationLock = {
      id: lockResult.lock.id,
      type: lockResult.lock.lockType,
      paths: lockResult.lock.paths,
    };
    return result;
  } finally {
    // Cleanup never replaces the integration result (which may already be committed) with an
    // exception; an unreleased lease expires on its own.
    try {
      await stopIntegrationHeartbeat();
      const released = await releaseHardLock(
        lockResult.lock.id,
        lockResult.lock.token,
        lockResult.lock.paths,
        lockResult.lock.cwd
      );
      if (!released.ok) {
        logEvent("warn", "integration.lock_release_failed", {
          lockId: lockResult.lock.id,
          error: released.error,
        });
      }
    } catch (error) {
      logEvent("warn", "integration.lock_release_failed", {
        lockId: lockResult.lock.id,
        error: error?.message || String(error),
      });
    }
  }
}

async function recoverIntegrationRepositorySerially(cwd) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const lockResult = await acquireHardLock({
    owner: "codex",
    agent: "integration_recovery",
    task: "Recover durable integration journal",
    cwd: targetCwd,
    lockType: "serial_integration",
    paths: [REPOSITORY_SCOPE_LOCK_PATH],
    repositoryScope: true,
    integrationRecoveryAuthority: true,
    ttlMs: Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10),
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      errorType: "integration_recovery_lock_conflict",
      error: "Durable integration recovery could not acquire the repository-wide serial lock.",
    };
  }
  const stopHeartbeat = startHardLockHeartbeat(
    lockResult.lock,
    Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10)
  );
  try {
    const recovery = await recoverIntegrationOperationsWhileLocked(targetCwd, { integrationLock: lockResult.lock });
    // Keep the in-memory writer block in step with what this recovery proved, as the deferred
    // recovery pass does.
    if (recovery.ok) INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(targetCwd);
    else INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(targetCwd);
    return recovery;
  } finally {
    try {
      await stopHeartbeat();
      const released = await releaseHardLock(
        lockResult.lock.id,
        lockResult.lock.token,
        lockResult.lock.paths,
        lockResult.lock.cwd
      );
      if (!released.ok) {
        logEvent("warn", "integration.recovery_lock_release_failed", {
          lockId: lockResult.lock.id,
          errorType: "integration_recovery_lock_release_failed",
        });
      }
    } catch (error) {
      logEvent("warn", "integration.recovery_lock_release_failed", {
        lockId: lockResult.lock.id,
        errorType: "integration_recovery_lock_release_failed",
        error: error?.message || String(error),
      });
    }
  }
}

// G-01: the supported way out of a quarantine that recovery does not clear on its own
// (affected_path_drift, rollback_restore_failed, journal_status_unknown, unreadable or
// inconsistent evidence). The MCP tool resolve_integration_quarantine and
// `bin/pipeline-admin.js resolve-quarantine` both end here. It runs under the repository-wide
// serial recovery lock, so it is refused while any job holds a lock in the repository, and it
// never deletes a journal row, a pre-image, the key or a database.
//   verify_restored: the operator put the affected paths back. HEAD, their index entries and
//     their exact bytes must be the recorded pre-integration state; the operation is closed
//     recovered_verified. Otherwise every mismatch is named and nothing changes.
//   accept_current: the operator inspected the checkout and accepts it as it is. The operation
//     is closed resolved_by_operator with who, when and why, and the current state of each path.
const INTEGRATION_QUARANTINE_RESOLUTION_MODES = Object.freeze(["verify_restored", "accept_current"]);

async function verifyQuarantinedOperationRestored(cwd, operation, fileRows) {
  let paths = [];
  try { paths = normalizeLockPathList(JSON.parse(operation.affected_paths_json || "[]")); } catch { /* Checked below. */ }
  if (!paths.length
    || fileRows.length !== paths.length
    || fileRows.some((row, ordinal) => row.ordinal !== ordinal || row.path !== paths[ordinal])) {
    return { ok: false, evidenceProblem: "The journal's affected paths and its file rows do not match, so the pre-integration state cannot be verified." };
  }
  const evidence = [];
  try {
    for (const row of fileRows) evidence.push(await readIntegrationJournalFileEvidence(operation, row));
  } catch (error) {
    if (integrationRecoveryErrorIsTransient(error)) return { ok: false, unavailable: true, error: integrationRecoveryErrorText(error) };
    return { ok: false, evidenceProblem: `The recorded pre-integration evidence cannot be read (${integrationRecoveryErrorText(error)}), so nothing can be compared with it.` };
  }
  const baseline = await integrationRecoveryBaseline(cwd, operation, fileRows, paths);
  if (!baseline.ok && !baseline.proven) return { ok: false, unavailable: true, error: baseline.error };
  let snapshot;
  try {
    snapshot = await exactIntegrationFileSnapshot(cwd, paths);
  } catch (error) {
    if (error?.errorType !== "snapshot_safety_limit_exceeded") return { ok: false, unavailable: true, error: integrationRecoveryErrorText(error) };
    snapshot = new Map(paths.map((file) => [file, `unreadable: ${integrationRecoveryErrorText(error)}`]));
  }
  // Fingerprints read "missing", "link:<target>" or "file:<mode>:<sha256 of the bytes>".
  const mismatches = evidence
    .filter((item) => snapshot.get(item.path) !== item.preFingerprint)
    .map((item) => ({ path: item.path, expected: item.preFingerprint, current: snapshot.get(item.path) ?? "missing" }));
  const drift = baseline.ok ? {} : baseline.details || {};
  return {
    ok: baseline.ok && !mismatches.length,
    evidence: baseline.ok ? baseline.evidence : drift.evidence || "",
    headMoved: Boolean(baseline.ok ? baseline.headMoved : drift.headMoved),
    mismatches,
    indexMismatches: drift.indexMismatches || [],
    committedChanges: drift.committedChanges || [],
    ...(drift.recordedHeadMissing ? { recordedHeadMissing: true } : {}),
    ...(drift.evidence === "whole_index" ? { wholeIndexChanged: Boolean(drift.indexChanged) } : {}),
  };
}

function integrationQuarantineOperator(operator) {
  const given = String(operator || "").trim();
  if (given) return truncateText(given, 200);
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

async function resolveIntegrationQuarantine({ cwd, operationId, mode, reason = "", confirmation = "", operator = "", via = "mcp" }) {
  const reject = (errorType, error, suggestedFix, details = {}) => ({ ok: false, errorType, error, suggestedFix, ...details });
  if (!INTEGRATION_QUARANTINE_RESOLUTION_MODES.includes(mode)) {
    return reject("integration_quarantine_mode_invalid", `Unknown mode "${mode}".`, "Use mode verify_restored or accept_current.");
  }
  const operatorReason = String(reason || "").trim();
  if (mode === "accept_current" && !operatorReason) {
    return reject("integration_quarantine_reason_required", "accept_current needs a reason: what was inspected and why the checkout is accepted as it is.", "Repeat with reason set, for example \"Inspected src/a.ts; the drift is my own edit, keeping it.\"");
  }
  if (mode === "accept_current" && confirmation !== operationId) {
    return reject("integration_quarantine_confirmation_mismatch", "accept_current needs confirmation set to the exact operation id.", "Repeat with confirmation equal to operationId.");
  }
  // accept_current releases the lock that protects the checkout on a person's word alone, so an
  // MCP client (an agent) cannot give it; verify_restored proves the state and stays open to it.
  if (mode === "accept_current" && via !== "cli") {
    return reject(
      "integration_quarantine_accept_requires_operator",
      "accept_current is available only from the operator command line, not to an MCP client.",
      `Ask the user to inspect the checkout and, if they accept it as it is, run: node bin/pipeline-admin.js resolve-quarantine ${operationId} --cwd <repository> --accept-current --reason "<what was inspected and why>". If the affected paths can be put back instead, do that and use mode verify_restored.`,
    );
  }
  const requestedCwd = path.resolve(cwd || process.cwd());
  const top = await runCommand("git", ["rev-parse", "--show-toplevel"], requestedCwd, 1000 * 15);
  if (top.exitCode !== 0 || !top.stdout.trim()) {
    return reject("integration_target_invalid", top.stderr || "cwd is not inside a Git repository.", "Pass the repository the quarantine is in, as diagnose_opencode_bridge shows it.");
  }
  const targetCwd = path.resolve(top.stdout.trim());
  const readOperation = async () => {
    const db = await openLockDb(targetCwd);
    try {
      const operation = db.prepare("SELECT * FROM integration_operations WHERE operation_id = ? AND cwd = ?").get(operationId, targetCwd);
      const files = operation
        ? db.prepare("SELECT * FROM integration_operation_files WHERE operation_id = ? ORDER BY ordinal").all(operationId)
        : [];
      return { operation, files };
    } finally {
      closeDb(db);
    }
  };
  const notQuarantined = (operation) => (operation
    ? reject("integration_operation_not_quarantined", `Operation ${operationId} is ${operation.status}, not quarantined.`, INTEGRATION_RESOLVED_STATUSES.includes(operation.status)
      ? "Nothing to resolve; it no longer blocks writers."
      : "Recovery handles an operation that is not quarantined; run diagnose_opencode_bridge and wait for the deferred recovery pass.")
    : reject("integration_operation_not_found", `No integration operation ${operationId} in ${targetCwd}.`, "Copy the operation id from the integrationOperations section of diagnose_opencode_bridge for this repository."));
  const first = await readOperation();
  if (first.operation?.status !== "quarantined") return notQuarantined(first.operation);

  const lockTtlMs = Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10);
  const lockResult = await acquireHardLock({
    owner: "codex",
    agent: "integration_recovery",
    task: `Resolve integration quarantine ${operationId} (${mode})`,
    cwd: targetCwd,
    lockType: "serial_integration",
    paths: [REPOSITORY_SCOPE_LOCK_PATH],
    repositoryScope: true,
    integrationRecoveryAuthority: true,
    ttlMs: lockTtlMs,
  });
  if (!lockResult.ok) {
    return reject(
      "integration_quarantine_resolution_busy",
      `Another job or recovery holds a lock in this repository, so nothing may be resolved now (${lockResult.error || lockResult.errorType || "lock refused"}).`,
      "Wait until list_opencode_jobs and list_agent_locks show nothing running in this repository, then repeat."
    );
  }
  const stopHeartbeat = startHardLockHeartbeat(lockResult.lock, lockTtlMs);
  const authority = { lock: lockResult.lock, ownerGeneration: randomBytes(16).toString("hex"), allowTakeover: true };
  try {
    const { operation, files } = await readOperation();
    if (operation?.status !== "quarantined") return notQuarantined(operation);
    const quarantine = integrationOperationResult(operation);
    const resolvedAt = new Date().toISOString();
    const record = {
      quarantineReason: quarantine.reason || "",
      quarantine,
      quarantinedAt: operation.updated_at,
      resolvedAt,
      resolvedBy: integrationQuarantineOperator(operator),
      via: via === "cli" ? "cli" : "mcp",
    };
    let status;
    if (mode === "verify_restored") {
      const check = await verifyQuarantinedOperationRestored(targetCwd, operation, files);
      if (check.unavailable) {
        return reject("integration_quarantine_evidence_unavailable", `The state could not be read right now (${check.error}); nothing was changed.`, "Close editors or scanners holding the files, then repeat.");
      }
      if (check.evidenceProblem) {
        return reject("integration_quarantine_unverifiable", `${check.evidenceProblem} Nothing was changed.`, "verify_restored cannot close this operation. Inspect the affected paths yourself, then use accept_current with a reason.");
      }
      if (!check.ok) {
        const hints = [
          ...(check.mismatches.length ? ["Put each listed path back to the expected state (the file as it was just before the integration started; if that was the committed version, `git checkout -- <path>` restores it)."] : []),
          ...(check.indexMismatches.length ? ["Unstage the listed index paths (`git restore --staged <path>`)."] : []),
          ...(check.committedChanges.length || check.recordedHeadMissing ? ["A commit since the integration started touched these paths, so their pre-state cannot be proven; inspect them and use accept_current with a reason."] : []),
          ...(check.wholeIndexChanged !== undefined ? ["This operation has only whole-index evidence: HEAD and the whole index must be back at their recorded state, or use accept_current."] : []),
        ];
        return reject(
          "integration_quarantine_not_restored",
          "The affected paths are not at their recorded pre-integration state; nothing was changed.",
          hints.join(" ") || "Inspect the affected paths, or use accept_current with a reason.",
          { mismatches: check.mismatches, indexMismatches: check.indexMismatches, committedChanges: check.committedChanges, headMoved: check.headMoved }
        );
      }
      status = "recovered_verified";
      await transitionIntegrationOperation(targetCwd, operationId, "quarantined", status, {
        ...record,
        outcome: "operator_verified_restored",
        evidence: check.evidence,
        headMoved: check.headMoved,
      }, authority);
    } else {
      let paths = [];
      try { paths = normalizeLockPathList(JSON.parse(operation.affected_paths_json || "[]")); } catch { /* Recorded as unavailable. */ }
      let acceptedState;
      try {
        acceptedState = Object.fromEntries(await exactIntegrationFileSnapshot(targetCwd, paths));
      } catch (error) {
        acceptedState = { unavailable: integrationRecoveryErrorText(error) };
      }
      status = "resolved_by_operator";
      await transitionIntegrationOperation(targetCwd, operationId, "quarantined", status, {
        ...record,
        outcome: "operator_accepted_current_state",
        operatorReason: truncateText(operatorReason, 500),
        acceptedState,
      }, authority);
    }
    logEvent("warn", "integration.quarantine_resolved", { operationId, status, quarantineReason: record.quarantineReason, via: record.via });
    // Other unresolved operations of this repository are recovered (or stay blocked) as the
    // deferred pass would; the writer block follows what that proves.
    const recovery = await recoverIntegrationOperationsWhileLocked(targetCwd, { integrationLock: lockResult.lock });
    if (recovery.ok) INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(targetCwd);
    else INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(targetCwd);
    return {
      ok: true,
      operationId,
      status,
      cwd: targetCwd,
      quarantineReason: record.quarantineReason,
      resolvedBy: record.resolvedBy,
      resolvedAt,
      writersUnblocked: recovery.ok,
      stillBlockedBy: recovery.ok ? [] : recovery.operationIds || [],
    };
  } finally {
    try {
      await stopHeartbeat();
      const released = await releaseHardLock(lockResult.lock.id, lockResult.lock.token, lockResult.lock.paths, lockResult.lock.cwd);
      if (!released.ok) logEvent("warn", "integration.recovery_lock_release_failed", { lockId: lockResult.lock.id, errorType: "integration_recovery_lock_release_failed" });
    } catch (error) {
      logEvent("warn", "integration.recovery_lock_release_failed", { lockId: lockResult.lock.id, error: error?.message || String(error) });
    }
  }
}

function formatIntegrationQuarantineResolution(result) {
  if (result.ok) {
    return [
      "Integration quarantine resolved.",
      `Operation: ${result.operationId}`,
      `Closed as: ${result.status}`,
      `Quarantine reason was: ${result.quarantineReason || "unknown"}`,
      `Resolved by: ${result.resolvedBy} at ${result.resolvedAt}`,
      `Writers unblocked: ${result.writersUnblocked ? "yes" : `no, still blocked by ${result.stillBlockedBy.join(", ") || "an unresolved operation"} (see diagnose_opencode_bridge)`}`,
      "Journal rows and pre-images are kept.",
    ].join("\n");
  }
  const { ok, errorType, error, suggestedFix, ...details } = result;
  return [
    "Integration quarantine resolution rejected.",
    `Error type: ${errorType}`,
    `Reason: ${error}`,
    `Suggested fix: ${suggestedFix}`,
    ...(Object.keys(details).length ? ["", JSON.stringify(details, null, 2)] : []),
  ].join("\n");
}
  return { integratePatchSerially, recoverIntegrationRepositorySerially, INTEGRATION_QUARANTINE_RESOLUTION_MODES, verifyQuarantinedOperationRestored, integrationQuarantineOperator, resolveIntegrationQuarantine, formatIntegrationQuarantineResolution };
}
