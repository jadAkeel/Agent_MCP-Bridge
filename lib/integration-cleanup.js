// B-194: durable, deferred removal of a validated integration's recovery source.
// Only identities/path names are persisted; patch bytes and validation output are not.
import { existsSync } from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";

export function createIntegrationCleanupRuntime({
  CONFIG, openLockDb, closeDb, acquireHardLock, releaseHardLock, assertIntegrationLockOwned,
  startHardLockHeartbeat, cleanupIntegratedWorktreeWhileLocked, runCommand,
  captureIntegrationTargetState, exactIntegrationFileSnapshot, snapshotIdentitySha256, logEvent,
  foregroundIntegrationActive = () => false, collectIntegrationPatch, cleanupWorktree,
}) {
  const running = new Map();
  const timers = new Map();
  const verifyOwnership = async (cwd, lock) => {
    const db = await openLockDb(cwd);
    try { assertIntegrationLockOwned(db, cwd, lock); }
    finally { closeDb(db); }
  };
  let schedulingDisabled = false;
  function setDeferredCleanupSchedulingDisabled(value) { schedulingDisabled = Boolean(value); }
  function schedule(cwd, delayMs = 50) {
    if (schedulingDisabled || timers.has(cwd)) return;
    const timer = setTimeout(async () => {
      timers.delete(cwd);
      try {
        const outcomes = await drainDeferredWorktreeCleanup(cwd);
        if (outcomes.some(outcome => outcome.cleanup === "pending" || outcome.cleanup === "failed" || outcome.cleanup === "partial")) schedule(cwd, 5000);
      } catch (error) {
        logEvent("warn", "integration.deferred_cleanup_failed", { summary: redactSensitiveText(error?.message || String(error)) });
        schedule(cwd, 5000);
      }
    }, delayMs);
    timer.unref?.();
    timers.set(cwd, timer);
  }
  async function enqueueIntegrationCleanup({ cwd, worktreePath, result, committed = false }) {
    if (!result?.ok || result.status !== "applied" || result.validationGate?.status !== "passed" || !worktreePath) return null;
    cwd = path.resolve(cwd);
    worktreePath = path.resolve(worktreePath);
    let targetStateSha256 = result.integratedTargetStateSha256;
    let trackedStateSha256 = result.integratedTrackedStateSha256;
    const committedCommit = committed && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.afterApply?.commit || "")
      ? result.afterApply.commit : "";
    if (committed) {
      // The engine's commit legitimately moved HEAD/index. Its files must still
      // be the exact validated bytes before accepting that new cleanup baseline.
      const currentFiles = await exactIntegrationFileSnapshot(cwd, result.changedFiles);
      if (snapshotIdentitySha256(currentFiles) !== result.integratedFilesStateSha256) {
        return { cleanup: "retained_for_review", reason: "integration_target_changed_before_cleanup" };
      }
      const current = committedCommit ? null : await captureIntegrationTargetState(cwd);
      if (!committedCommit && !current.ok) return { cleanup: "retained_for_review", reason: "integration_target_unreadable_before_cleanup" };
      if (current) {
        targetStateSha256 = current.targetStateSha256;
        trackedStateSha256 = current.trackedStateSha256;
      }
    }
    const sourceBranch = await runCommand("git", ["branch", "--show-current"], worktreePath, 15_000);
    if (sourceBranch.exitCode !== 0 || !sourceBranch.stdout.trim()) {
      return { cleanup: "retained_for_review", reason: "source_branch_identity_unverified" };
    }
    const branch = sourceBranch.stdout.trim();
    const payload = {
      ok: true, status: "applied", validationGate: { status: "passed" },
      patchSha256: result.patchSha256, sourceStateSha256: result.sourceStateSha256,
      sourceBaseCommit: result.sourceBaseCommit, sourceHead: result.sourceHead, committedCommit,
      changedFiles: result.changedFiles, integratedTargetStateSha256: targetStateSha256,
      integratedTrackedStateSha256: trackedStateSha256,
    };
    const db = await openLockDb(cwd);
    try {
      db.exec("BEGIN IMMEDIATE");
      const artifact = db.prepare("SELECT status FROM worktree_artifacts WHERE worktree_path = ?").get(worktreePath);
      if (artifact?.status === "in_use") {
        db.exec("ROLLBACK");
        return { cleanup: "retained_for_review", reason: "worktree_in_use" };
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO integration_worktree_cleanup (worktree_path, cwd, branch, payload_json, status, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(worktree_path) DO UPDATE SET cwd = excluded.cwd, branch = excluded.branch,
          payload_json = excluded.payload_json, status = 'pending', updated_at = excluded.updated_at`).run(worktreePath, cwd, branch, JSON.stringify(payload), now);
      db.prepare(`INSERT INTO worktree_artifacts (worktree_path, cwd, branch, job_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'cleanup_pending', ?, ?)
        ON CONFLICT(worktree_path) DO UPDATE SET status = 'cleanup_pending', updated_at = excluded.updated_at
        WHERE worktree_artifacts.status IN ('retained', 'cleanup_failed', 'cleanup_pending')`)
        .run(worktreePath, cwd, branch, result.operationId || "reviewed-integration", now, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Keep original persistence error. */ }
      throw error;
    } finally { closeDb(db); }
    schedule(cwd);
    return { cleanup: "pending", reason: "durable cleanup scheduled after the integration reply" };
  }
  async function drainDeferredWorktreeCleanup(cwd) {
    cwd = path.resolve(cwd);
    if (running.has(cwd)) return running.get(cwd);
    const operation = drain(cwd);
    running.set(cwd, operation);
    try {
      const results = await operation;
      if (!results.some(item => ["pending", "failed", "partial"].includes(item.cleanup))) {
        clearTimeout(timers.get(cwd));
        timers.delete(cwd);
      }
      return results;
    }
    finally { if (running.get(cwd) === operation) running.delete(cwd); }
  }
  async function drain(cwd) {
    const db = await openLockDb(cwd);
    let rows;
    try { rows = db.prepare("SELECT * FROM integration_worktree_cleanup WHERE cwd = ? AND status = 'pending' ORDER BY updated_at").all(cwd); }
    finally { closeDb(db); }
    if (!rows.length) return [];
    // Cleanup is background work; an active auto-integration chain keeps priority.
    if (foregroundIntegrationActive(cwd)) return rows.map(row => ({ path: row.worktree_path,
      cleanup: "pending", reason: "foreground_auto_integration_active" }));
    const ttlMs = Math.max(600_000, CONFIG.gitHeavyTimeoutMs * 4);
    const claimed = await acquireHardLock({ owner: "codex", agent: "merge_manager", task: "Deferred reviewed worktree cleanup",
      cwd, lockType: "serial_integration", paths: ["."], repositoryScope: true, ttlMs });
    if (!claimed.ok) return rows.map(row => ({ path: row.worktree_path, cleanup: "pending", reason: claimed.errorType }));
    const heartbeat = startHardLockHeartbeat(claimed.lock, ttlMs);
    const results = [];
    try {
      for (const row of rows) {
        if (heartbeat.signal.aborted) break;
        const check = await openLockDb(cwd);
        let artifact, currentTask;
        try {
          currentTask = check.prepare("SELECT payload_json, status FROM integration_worktree_cleanup WHERE worktree_path = ?").get(row.worktree_path);
          artifact = check.prepare("SELECT status FROM worktree_artifacts WHERE worktree_path = ?").get(row.worktree_path); }
        finally { closeDb(check); }
        if (currentTask?.status !== "pending" || currentTask.payload_json !== row.payload_json) continue;
        if (artifact?.status === "in_use") {
          results.push({ path: row.worktree_path, cleanup: "pending", reason: "worktree_in_use" });
          continue;
        }
        let outcome;
        try {
          const result = JSON.parse(row.payload_json);
          const beforeRemoval = async () => {
            if (heartbeat.signal.aborted) throw heartbeat.signal.reason || new Error("Cleanup lease lost.");
            if (foregroundIntegrationActive(cwd)) throw new Error("Foreground auto-integration has priority; retry cleanup later.");
            await verifyOwnership(cwd, claimed.lock);
          };
          // B-154 already permits cleanup after the engine commit remains in
          // HEAD's history, even when later commits changed other target paths.
          // Keep that policy for auto-integration, with exact reviewed source and
          // branch proofs added before deletion; manual applies retain full-target gating.
          const committedInTarget = result.committedCommit
            ? await runCommand("git", ["merge-base", "--is-ancestor", result.committedCommit, "HEAD"], cwd, 60_000)
            : null;
          const ref = await runCommand("git", ["show-ref", "--hash", "--verify", `refs/heads/${row.branch}`], cwd, 15_000);
          const branchMatches = ref.exitCode === 0 && ref.stdout.trim() === result.sourceHead;
          if (!existsSync(row.worktree_path)) {
            // A crash after directory removal can leave only the branch. Its ref
            // must still be the reviewed tip; never delete a branch that moved.
            const target = result.committedCommit ? null : await captureIntegrationTargetState(cwd);
            if ((result.committedCommit ? committedInTarget.exitCode === 0
              : target.ok && target.trackedStateSha256 === result.integratedTrackedStateSha256)
              && (branchMatches || ref.exitCode !== 0)) {
              const absent = ref.exitCode !== 0
                ? await runCommand("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`], cwd, 15_000) : null;
              await verifyOwnership(cwd, claimed.lock);
              const deleted = branchMatches
                ? await runCommand("git", ["update-ref", "-d", `refs/heads/${row.branch}`, result.sourceHead], cwd, 30_000)
                : { exitCode: absent?.exitCode === 0 && !absent.stdout.trim() ? 0 : 1 };
              outcome = { cleanup: deleted.exitCode === 0 ? "success" : "failed" };
            } else outcome = { cleanup: "retained_for_review", reason: "cleanup_identity_changed" };
          } else if (!branchMatches) {
            outcome = { cleanup: "retained_for_review", reason: "source_branch_identity_changed" };
          } else if (result.committedCommit) {
            const source = await collectIntegrationPatch({ cwd, worktreePath: row.worktree_path,
              sourceBaseCommit: result.sourceBaseCommit });
            if (committedInTarget.exitCode !== 0 || !source.ok
              || source.patchSha256 !== result.patchSha256 || source.sourceStateSha256 !== result.sourceStateSha256) {
              outcome = { cleanup: "retained_for_review", reason: "committed_cleanup_identity_changed" };
            } else {
              // Re-read ancestry after collection, immediately before removal.
              const current = await runCommand("git", ["merge-base", "--is-ancestor", result.committedCommit, "HEAD"], cwd, 60_000);
              if (current.exitCode !== 0) outcome = { cleanup: "retained_for_review", reason: "integration_commit_not_in_target" };
              else {
                await beforeRemoval();
                outcome = await cleanupWorktree({ path: row.worktree_path, repoRoot: cwd,
                  branch: row.branch, expectedBranchOid: source.sourceHead }, "always", true);
              }
            }
          } else {
            await cleanupIntegratedWorktreeWhileLocked({ result, cwd, worktreePath: row.worktree_path, beforeRemoval });
            outcome = result.sourceCleanup || { cleanup: "failed" };
          }
        } catch (error) {
          outcome = { cleanup: "failed", error: redactSensitiveText(error?.message || String(error)) };
        }
        const update = await openLockDb(cwd);
        try {
          update.exec("BEGIN IMMEDIATE");
          assertIntegrationLockOwned(update, cwd, claimed.lock);
          if (outcome.cleanup === "success") {
            update.prepare("DELETE FROM integration_worktree_cleanup WHERE worktree_path = ? AND payload_json = ?").run(row.worktree_path, row.payload_json);
            update.prepare("DELETE FROM worktree_artifacts WHERE worktree_path = ? AND status IN ('cleanup_pending', 'cleaned', 'cleaned_branch_retained', 'cleanup_failed')").run(row.worktree_path);
          } else {
            const retained = outcome.cleanup === "retained_for_review";
            update.prepare("UPDATE integration_worktree_cleanup SET status = ?, updated_at = ? WHERE worktree_path = ? AND payload_json = ?")
              .run(retained ? "retained" : "pending", new Date().toISOString(), row.worktree_path, row.payload_json);
            update.prepare("UPDATE worktree_artifacts SET status = ?, updated_at = ? WHERE worktree_path = ? AND status <> 'in_use'")
              .run(retained ? "retained" : "cleanup_pending", new Date().toISOString(), row.worktree_path);
          }
          update.exec("COMMIT");
        } catch (error) {
          try { update.exec("ROLLBACK"); } catch { /* Keep durable pending evidence. */ }
          throw error;
        } finally { closeDb(update); }
        results.push({ path: row.worktree_path, ...outcome });
      }
    } finally {
      await heartbeat();
      await releaseHardLock(claimed.lock.id, claimed.lock.token, claimed.lock.paths, cwd);
    }
    return results;
  }
  return { enqueueIntegrationCleanup, drainDeferredWorktreeCleanup, setDeferredCleanupSchedulingDisabled,
    deferredWorktreeCleanupRunning: () => running.size > 0 || timers.size > 0 };
}
