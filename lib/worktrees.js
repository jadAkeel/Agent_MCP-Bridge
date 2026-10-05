// Worktree creation, durable artifact ownership and cleanup.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { lstat, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { detachWorktreeLinks } from "../bin/worktree-links.js";
import { diffStatFromPatch } from "./git-patch.js";
import { redactSensitiveText } from "./redaction.js";
import { normalizeLockPath, normalizeLockPathList, mergePathLists, overlaps, isPathInside, isWithinAnyPath } from "./paths.js";
import { scopeContractPathInputs, scopeContractWritePathInputs } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createWorktreeRuntime({
  CONFIG,
  effectiveBridgeStateDirectory,
  projectStateKey,
  safeNamePart,
  runCommand,
  buildValidationEnv,
  openLockDb,
  closeDb,
  logEvent,
  stateCapacityError,
  inspectRepositoryGitControlSurface,
  inspectRepositoryOperationState,
  createPatchFromWorkingTree,
  truncateText,
  integrationTimed,
  processIsAlive,
}) {
let worktreeCleanupTestHook = null;
let worktreeCreateTestHook = null;

// Default integration cleanup removes only worktrees the bridge created; a worktree path
// the caller made by hand keeps its branch and history unless cleanup is asked for.
function isBridgeGeneratedWorktree(cwd, worktreePath) {
  if (!worktreePath) return false;
  const configured = String(CONFIG.worktreeRoot || "").trim();
  const root = configured.toLowerCase() === "global"
    ? path.join(effectiveBridgeStateDirectory(), "worktrees")
    : generatedWorktreeRootForCwd(cwd);
  return Boolean(root) && isPathInside(path.resolve(root), path.resolve(worktreePath));
}

function generatedWorktreeRootForCwd(cwd) {
  const base = cwd || process.cwd();
  const configured = String(CONFIG.worktreeRoot || "").trim();
  if (!configured) {
    return "";
  }

  if (configured.toLowerCase() === "global") {
    return path.join(effectiveBridgeStateDirectory(), "worktrees", projectStateKey(base));
  }

  return path.resolve(path.isAbsolute(configured) ? configured : path.join(base, configured));
}

function filterGeneratedWorktreeFiles(files, cwd) {
  const root = generatedWorktreeRootForCwd(cwd);
  const filtered = normalizeLockPathList(files);
  if (!root || !isPathInside(cwd || process.cwd(), root)) {
    return filtered;
  }

  const relativeRoot = normalizeLockPath(path.relative(path.resolve(cwd || process.cwd()), root));
  return filtered.filter((file) => !isWithinAnyPath(file, [relativeRoot], cwd));
}

function resolveWorktreeRoot(repoRoot) {
  const configured = String(CONFIG.worktreeRoot || "global").trim();
  if (!configured || /[\x00-\x1F\x7F]/.test(configured) || configured.startsWith("~")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Unsafe worktree root: ${JSON.stringify(configured)}`,
    };
  }

  const normalized = configured.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Worktree root must not contain parent traversal: ${JSON.stringify(configured)}`,
    };
  }

  const resolved = configured.toLowerCase() === "global"
    ? path.join(effectiveBridgeStateDirectory(), "worktrees", projectStateKey(repoRoot))
    : path.resolve(path.isAbsolute(configured) ? configured : path.join(repoRoot, configured));
  if (resolved === path.parse(resolved).root) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Worktree root resolved to a filesystem root.",
    };
  }

  return { ok: true, root: resolved };
}

function shouldUseWorktree(job, lockPlan, worktreeMode = CONFIG.worktreeMode) {
  if (job.dryRun || !lockPlan) {
    return false;
  }

  if (job.sanitizedWorkspace || lockPlan.sanitizedWorkspace) {
    return false;
  }

  // Internal only (pipeline gates; tool schemas strip unknown keys): a reader of the checkout.
  if (job.noWorktree === true && lockPlan.lockType === "read") return false;

  if (lockPlan.orchestratorMode === "contractor") {
    return true;
  }

  if (worktreeMode === "all") {
    return true;
  }

  return worktreeMode === "write" && lockPlan.lockType === "write";
}

function makeWorktreeBranchName(agent, jobId) {
  return [
    safeNamePart(CONFIG.worktreeBranchPrefix, "agent"),
    safeNamePart(agent, "agent"),
    safeNamePart(jobId, "job"),
  ].join("/");
}

async function inspectSourceCheckpointState(cwd, { lockedPaths = [], allowedEdits = [], scopeContract = null, policy = CONFIG.sourceDirtPolicy } = {}) {
  const result = await runCommand("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], cwd, 1000 * 30, buildValidationEnv());
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "dirty_worktree_preflight_failed",
      error: result.stderr || result.stdout || "Could not inspect the source checkout before worktree creation.",
      dirtyEntries: [],
      dirtyFiles: [],
      overlappingFiles: [],
      disjointFiles: [],
      conflictingPaths: [],
    };
  }
  const tokens = String(result.stdout || "").split("\0").filter(Boolean);
  const dirtyEntries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const file = normalizeLockPath(token.slice(3));
    if (!file) continue;
    dirtyEntries.push({ status, file });
    if (/[RC]/.test(status) && tokens[index + 1]) {
      const original = normalizeLockPath(tokens[index + 1]);
      if (original) dirtyEntries.push({ status: `${status}:source`, file: original });
      index += 1;
    }
  }
  const dirtyFiles = normalizeLockPathList(dirtyEntries.map((entry) => entry.file));
  // B-151: unrelated_ok protects the paths the job may change (locked, allowed, write, shared,
  // serial-only). Twenty-seven jobs once failed at once because two untracked files sat under a
  // directory of their READ scope: the agent reads HEAD's version in its worktree in any case,
  // so such a file is tolerated and reported (toleratedReadScopeFiles), not a blocker.
  const scopePaths = mergePathLists(lockedPaths, allowedEdits, scopeContractWritePathInputs(scopeContract));
  const readScopePaths = scopeContract ? normalizeLockPathList(scopeContract.scope?.read || []) : [];
  const overlappingFiles = dirtyFiles.filter((file) => Boolean(overlaps([file], scopePaths)));
  const disjointFiles = dirtyFiles.filter((file) => !overlappingFiles.includes(file));
  const readScopeFiles = disjointFiles.filter((file) => Boolean(overlaps([file], readScopePaths)));
  const conflictingPaths = overlappingFiles.length ? overlappingFiles : dirtyFiles;
  const toleratesUnrelated = policy === "unrelated_ok" && scopePaths.length > 0;
  const blockingFiles = toleratesUnrelated ? overlappingFiles : dirtyFiles;
  return {
    ok: blockingFiles.length === 0,
    errorType: blockingFiles.length ? "dirty_worktree_requires_checkpoint" : null,
    error: blockingFiles.length
      ? (toleratesUnrelated
        ? `The source checkout has uncommitted changes inside this job's locked/allowed scope (${overlappingFiles.join(", ")}). A HEAD-based worktree would omit that state. The bridge will not stash, reset, commit, or overlay it; checkpoint or revert those files and retry. Unrelated changes are tolerated under CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok.`
        : "The source checkout contains staged, unstaged, untracked, conflicted, or submodule changes. A HEAD-based worktree would omit that state. The bridge will not stash, reset, commit, or overlay it; create or select an external checkpoint and retry. Unrelated dirt is also rejected because the base must be fully reproducible (set CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok to tolerate changes outside the job scope).")
      : "",
    sourceDirtPolicy: toleratesUnrelated ? "unrelated_ok" : "strict",
    toleratedDisjointFiles: toleratesUnrelated ? disjointFiles : [],
    toleratedReadScopeFiles: toleratesUnrelated ? readScopeFiles : [],
    dirtyEntries,
    dirtyFiles,
    overlappingFiles,
    disjointFiles,
    conflictingPaths,
  };
}

function dirtyCheckpointDetails(checkpoint = {}) {
  const dirtyFiles = normalizeLockPathList(checkpoint.dirtyFiles || []);
  const overlappingFiles = normalizeLockPathList(checkpoint.overlappingFiles || []);
  const disjointFiles = normalizeLockPathList(checkpoint.disjointFiles || []);
  const conflictingPaths = overlappingFiles.length ? overlappingFiles : dirtyFiles;
  return { dirtyFiles, overlappingFiles, disjointFiles, conflictingPaths };
}

const RETAINED_WORKTREE_STATUSES = Object.freeze(["creating", "retained", "cleanup_failed", "in_use"]);

// Q-018: a claim survives crashes, but only an active job may keep it exclusive.
function worktreeClaimOwnerAlive(db, jobId) {
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (hasTable("opencode_jobs") && db.prepare(`
    SELECT 1 FROM opencode_jobs WHERE job_id = ?
      AND status IN ('pending', 'planned', 'running', 'validating', 'reviewing', 'testing', 'blocked')
  `).get(jobId)) return true;
  if (!hasTable("opencode_direct_runs") || !hasTable("bridge_instances")) return false;
  const owner = db.prepare(`
    SELECT instance.process_id FROM opencode_direct_runs AS run
    JOIN bridge_instances AS instance ON instance.instance_id = run.owner_instance_id
    WHERE run.job_id = ? AND run.status = 'started' AND instance.lease_expires_at > ?
      AND run.owner_process_id = instance.process_id
  `).get(jobId, new Date().toISOString());
  return Boolean(owner && processIsAlive(Number(owner.process_id)));
}

async function recoverStaleWorktreeClaims(cwdOrDb) {
  const ownsDb = typeof cwdOrDb === "string";
  const db = ownsDb ? await openLockDb(cwdOrDb) : cwdOrDb;
  let transactionOpen = false;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_artifacts'").get()) return [];
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const recovered = [];
    const now = new Date().toISOString();
    for (const row of db.prepare("SELECT worktree_path, cwd, job_id FROM worktree_artifacts WHERE status = 'in_use'").all()) {
      if (worktreeClaimOwnerAlive(db, row.job_id)) continue;
      const changed = db.prepare(`UPDATE worktree_artifacts SET status = 'retained', updated_at = ?
        WHERE worktree_path = ? AND cwd = ? AND status = 'in_use' AND job_id = ?
      `).run(now, row.worktree_path, row.cwd, row.job_id);
      if (Number(changed.changes) === 1) recovered.push(row.worktree_path);
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return recovered;
  } catch (error) {
    if (transactionOpen) { try { db.exec("ROLLBACK"); } catch { /* Preserve recovery error. */ } }
    throw error;
  } finally {
    if (ownsDb) closeDb(db);
  }
}

async function worktreeArtifactStatus({ cwd, worktreePath }) {
  const db = await openLockDb(cwd);
  try {
    return db.prepare("SELECT status FROM worktree_artifacts WHERE worktree_path = ? AND cwd = ?")
      .get(path.resolve(worktreePath), path.resolve(cwd))?.status || "";
  } finally { closeDb(db); }
}

async function claimRetainedWorktree({ cwd, worktreePath, jobId, dryRun = false }) {
  const db = await openLockDb(cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const canonicalCwd = path.resolve(cwd);
    const canonicalPath = path.resolve(worktreePath);
    // Q-018: serial integration and claiming the same source must not race after collection.
    const integrating = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='locks'").get()
      && db.prepare("SELECT 1 FROM locks WHERE cwd = ? AND lock_mode = 'serial_integration' AND expires_at > ? LIMIT 1")
        .get(canonicalCwd, Date.now());
    if (integrating) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, errorType: "worktree_in_use", error: "An integration is using this repository's worktrees.",
        suggestedFix: "Wait for the integration to finish, then retry the continued job." };
    }
    const row = db.prepare("SELECT * FROM worktree_artifacts WHERE worktree_path = ? AND cwd = ?").get(canonicalPath, canonicalCwd);
    const stale = row?.status === "in_use" && !worktreeClaimOwnerAlive(db, row.job_id);
    const usable = row && (row.status === "retained" || stale) && existsSync(canonicalPath);
    let claimed = usable;
    const now = new Date().toISOString();
    if (usable && !dryRun) {
      // Recover only this dead owner, then retry the retained CAS once in this transaction.
      if (stale) db.prepare(`UPDATE worktree_artifacts SET status = 'retained', updated_at = ?
        WHERE worktree_path = ? AND cwd = ? AND status = 'in_use' AND job_id = ?
      `).run(now, canonicalPath, canonicalCwd, row.job_id);
      claimed = Number(db.prepare(`UPDATE worktree_artifacts SET status = 'in_use', job_id = ?, updated_at = ?
        WHERE worktree_path = ? AND cwd = ? AND status = 'retained'
      `).run(jobId, now, canonicalPath, canonicalCwd).changes) === 1;
    }
    db.exec("COMMIT");
    transactionOpen = false;
    if (!claimed) {
      const inUse = row?.status === "in_use" && !stale;
      return { ok: false, errorType: inUse ? "worktree_in_use" : "worktree_not_retained",
        error: inUse ? "A job is running in this worktree." : "The path is not a present retained worktree registered for this repository.",
        suggestedFix: inUse ? "Wait for the owning job to finish, then retry." : "Use the Worktree path of a finished job in this repository." };
    }
    return { ok: true, continuedFrom: row.job_id, branch: row.branch, row };
  } catch (error) {
    if (transactionOpen) { try { db.exec("ROLLBACK"); } catch { /* Preserve claim error. */ } }
    throw error;
  } finally { closeDb(db); }
}

async function releaseRetainedWorktreeClaim({ cwd, worktreePath, jobId }) {
  const db = await openLockDb(cwd);
  try {
    // An old owner's finally must never release a newer owner's claim.
    db.prepare(`UPDATE worktree_artifacts SET status = 'retained', updated_at = ?
      WHERE worktree_path = ? AND cwd = ? AND job_id = ? AND status = 'in_use'
    `).run(new Date().toISOString(), path.resolve(worktreePath), path.resolve(cwd), jobId);
  } finally { closeDb(db); }
}

async function reconcileWorktreeArtifactRegistry(cwd) {
  const canonicalCwd = path.resolve(cwd || process.cwd());
  const knownDb = await openLockDb(canonicalCwd);
  let knownPaths;
  try {
    // Any active row counts as known, whichever cwd registered it: a directory another
    // checkout owns was re-walked on every reservation because the insert below never
    // replaces an active row.
    knownPaths = new Set(
      knownDb.prepare(`
        SELECT worktree_path FROM worktree_artifacts
        WHERE status IN ('creating', 'retained', 'cleanup_failed', 'in_use')
      `)
        .all()
        .map((row) => path.resolve(row.worktree_path))
    );
  } finally {
    closeDb(knownDb);
  }
  const root = generatedWorktreeRootForCwd(canonicalCwd);
  const discovered = [];
  if (root) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const absolute = path.resolve(root, entry.name);
        if (!isPathInside(root, absolute)) continue;
        if (knownPaths.has(absolute)) continue;
        try {
          const details = await lstat(absolute);
          if (details.isDirectory() && !details.isSymbolicLink()) {
            discovered.push({
              path: absolute,
              status: "retained",
              measuredBytes: await measureRetainedWorktreeBytes(absolute),
            });
          } else if (details.isSymbolicLink()) {
            discovered.push({
              path: absolute,
              status: "cleanup_failed",
              measuredBytes: CONFIG.retainedWorktreeMaxBytes + 1,
            });
          }
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          // An entry that cannot be measured (EPERM/EBUSY on Windows) is recorded as a
          // capacity-full cleanup failure instead of failing this job's reservation.
          logEvent("warn", "worktree.registry_measure_failed", { path: absolute, error: error?.message || String(error) });
          discovered.push({
            path: absolute,
            status: "cleanup_failed",
            measuredBytes: CONFIG.retainedWorktreeMaxBytes + 1,
          });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const db = await openLockDb(canonicalCwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO worktree_artifacts
        (worktree_path, cwd, branch, job_id, status, measured_bytes, created_at, updated_at, cleaned_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(worktree_path) DO UPDATE SET
        cwd = excluded.cwd,
        job_id = excluded.job_id,
        status = excluded.status,
        measured_bytes = excluded.measured_bytes,
        updated_at = excluded.updated_at,
        cleaned_at = NULL
      WHERE worktree_artifacts.status IN ('cleaned', 'cleaned_branch_retained')
    `);
    for (const item of discovered) {
      insert.run(item.path, canonicalCwd, path.basename(item.path), item.status, item.measuredBytes, now, now);
    }
    const activeRows = db.prepare(`
      SELECT worktree_path FROM worktree_artifacts
      WHERE cwd = ? AND status IN ('creating', 'retained', 'cleanup_failed', 'in_use')
    `).all(canonicalCwd);
    const markMissing = db.prepare(`
      UPDATE worktree_artifacts
      SET status = 'cleaned', cleaned_at = ?, updated_at = ?
      WHERE worktree_path = ? AND cwd = ?
    `);
    for (const row of activeRows) {
      if (!existsSync(row.worktree_path)) markMissing.run(now, now, row.worktree_path, canonicalCwd);
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the registry error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

async function reserveWorktreeArtifact({ cwd, worktreePath, branch, jobId }) {
  await reconcileWorktreeArtifactRegistry(cwd);
  const db = await openLockDb(cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const stateCapacity = stateCapacityError(db);
    if (stateCapacity) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, ...stateCapacity };
    }
    const placeholders = RETAINED_WORKTREE_STATUSES.map(() => "?").join(", ");
    const capacity = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(measured_bytes), 0) AS bytes
      FROM worktree_artifacts
      WHERE cwd = ? AND status IN (${placeholders})
    `).get(path.resolve(cwd), ...RETAINED_WORKTREE_STATUSES);
    if (Number(capacity?.count || 0) >= CONFIG.retainedWorktreeMaxCount
      || Number(capacity?.bytes || 0) >= CONFIG.retainedWorktreeMaxBytes) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        ok: false,
        errorType: "worktree_capacity_exceeded",
        error: "Retained worktree recovery evidence reached its configured count or measured-byte capacity.",
      };
    }
    const now = new Date().toISOString();
    // B-150: a path whose earlier worktree was cleaned (the same job's creation retried after
    // HEAD moved) is reserved again; an active row still refuses the path.
    const inserted = db.prepare(`
      INSERT INTO worktree_artifacts
        (worktree_path, cwd, branch, job_id, status, measured_bytes, created_at, updated_at, cleaned_at)
      VALUES (?, ?, ?, ?, 'creating', 0, ?, ?, NULL)
      ON CONFLICT(worktree_path) DO UPDATE SET
        cwd = excluded.cwd,
        branch = excluded.branch,
        job_id = excluded.job_id,
        status = 'creating',
        measured_bytes = 0,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        cleaned_at = NULL
      WHERE worktree_artifacts.status IN ('cleaned', 'cleaned_branch_retained')
    `).run(path.resolve(worktreePath), path.resolve(cwd), branch, jobId, now, now);
    if (Number(inserted.changes || 0) !== 1) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        ok: false,
        errorType: "worktree_identity_conflict",
        error: "The generated worktree path already has durable artifact ownership.",
      };
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return { ok: true };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the reservation error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

async function markWorktreeArtifactState(worktree, status, measuredBytes = null) {
  if (!worktree?.path || !worktree?.repoRoot) return;
  const db = await openLockDb(worktree.repoRoot);
  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE worktree_artifacts
      SET status = ?, measured_bytes = COALESCE(?, measured_bytes), updated_at = ?,
          cleaned_at = CASE WHEN ? IN ('cleaned', 'cleaned_branch_retained') THEN ? ELSE cleaned_at END
      WHERE worktree_path = ? AND cwd = ?
    `).run(
      status,
      measuredBytes === null ? null : Math.max(0, Math.trunc(measuredBytes)),
      now,
      status,
      now,
      path.resolve(worktree.path),
      path.resolve(worktree.repoRoot)
    );
  } finally {
    closeDb(db);
  }
}

async function releaseFailedWorktreeReservation(worktree) {
  if (!worktree?.path || !worktree?.repoRoot) return;
  if (existsSync(worktree.path)) {
    await updateRetainedWorktreeMeasurement(worktree);
    return;
  }
  const db = await openLockDb(worktree.repoRoot);
  try {
    db.prepare(`
      DELETE FROM worktree_artifacts
      WHERE worktree_path = ? AND cwd = ? AND status = 'creating'
    `).run(path.resolve(worktree.path), path.resolve(worktree.repoRoot));
  } finally {
    closeDb(db);
  }
}

async function measureRetainedWorktreeBytes(worktreePath) {
  const root = path.resolve(worktreePath);
  const rootDetails = await lstat(root);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error("Retained worktree root is not a real directory.");
  const stack = [root];
  let bytes = 0;
  let entriesSeen = 0;
  const maxEntries = Math.max(CONFIG.maxSnapshotFiles * 4, 100000);
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > maxEntries) return CONFIG.retainedWorktreeMaxBytes + 1;
      const absolute = path.resolve(directory, entry.name);
      if (!isPathInside(root, absolute)) return CONFIG.retainedWorktreeMaxBytes + 1;
      const details = await lstat(absolute);
      if (details.isDirectory() && !details.isSymbolicLink()) stack.push(absolute);
      else bytes += Number(details.size || 0);
      if (bytes > CONFIG.retainedWorktreeMaxBytes) return bytes;
    }
  }
  return bytes;
}

async function updateRetainedWorktreeMeasurement(worktree) {
  if (!worktree?.path || !worktree?.repoRoot || !existsSync(worktree.path)) return;
  try {
    const bytes = await measureRetainedWorktreeBytes(worktree.path);
    await markWorktreeArtifactState(worktree, "retained", bytes);
  } catch {
    await markWorktreeArtifactState(worktree, "cleanup_failed", CONFIG.retainedWorktreeMaxBytes + 1);
  }
}

async function createWorktreeForJob({ cwd, agent, jobId, lockedPaths = [], allowedEdits = [], scopeContract = null }) {
  const baseCwd = cwd || process.cwd();
  const gitVersion = await runCommand("git", ["--version"], baseCwd, 1000 * 15);
  if (gitVersion.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: gitVersion.stderr || "git is not available.",
    };
  }

  const repoRootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], baseCwd, 1000 * 15);
  if (repoRootResult.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: repoRootResult.stderr || "Current working directory is not inside a Git repository.",
    };
  }

  const repoRoot = path.resolve(repoRootResult.stdout.trim());
  const gitControlSurface = await inspectRepositoryGitControlSurface(repoRoot);
  if (!gitControlSurface.ok) return gitControlSurface;
  const operationState = await inspectRepositoryOperationState(repoRoot);
  if (!operationState.ok) return operationState;
  const checkpointState = await inspectSourceCheckpointState(repoRoot, { lockedPaths, allowedEdits, scopeContract });
  if (!checkpointState.ok) {
    return checkpointState;
  }
  const rootResult = resolveWorktreeRoot(repoRoot);
  if (!rootResult.ok) {
    return rootResult;
  }

  const branch = makeWorktreeBranchName(agent, jobId);
  const worktreePath = path.resolve(rootResult.root, `${safeNamePart(agent, "agent")}-${safeNamePart(jobId, "job")}`);
  if (!isPathInside(rootResult.root, worktreePath) || path.resolve(worktreePath) === repoRoot) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Generated worktree path is outside the configured worktree root or matches the main repository.",
    };
  }

  // B-150: with autoIntegrate and parallel writers, a commit in the target (an auto-integration,
  // the operator's own commit) lands between the HEAD read and the post-creation check as a
  // matter of routine; it used to fail the job (worktree_source_checkpoint_changed), and the
  // queue did not retry it. A move whose commits touch nothing in the job's scope is accepted
  // (the worktree's base is a few commits older, which integration handles like any other base);
  // one that touches the scope recreates the worktree from the new HEAD, a few times.
  let headMovedDuringCreation = null;
  let recreated = 0;
  for (let attempt = 0; ; attempt += 1) {
  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15);
  if (baseCommitResult.exitCode !== 0 || !baseCommitResult.stdout.trim()) {
    return {
      ok: false,
      errorType: "worktree_base_invalid",
      error: baseCommitResult.stderr || "Could not capture the repository HEAD before creating the worktree.",
    };
  }
  const baseCommit = baseCommitResult.stdout.trim();
  const baseTreeResult = await runCommand("git", ["rev-parse", `${baseCommit}^{tree}`], repoRoot, 1000 * 15);
  if (baseTreeResult.exitCode !== 0 || !baseTreeResult.stdout.trim()) {
    return {
      ok: false,
      errorType: "worktree_base_invalid",
      error: baseTreeResult.stderr || "Could not capture the repository base tree.",
    };
  }

  const reservation = await reserveWorktreeArtifact({
    cwd: repoRoot,
    worktreePath,
    branch,
    jobId,
  });
  if (!reservation.ok) return reservation;

  await mkdir(rootResult.root, { recursive: true });
  const branchExists = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repoRoot, 1000 * 15);
  if (branchExists.exitCode === 0) {
    await releaseFailedWorktreeReservation({ repoRoot, path: worktreePath, branch });
    return {
      ok: false,
      errorType: "worktree_checkout_failed",
      error: `Worktree branch already exists: ${branch}`,
    };
  }

  const created = await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot, CONFIG.gitHeavyTimeoutMs);
  if (created.exitCode !== 0) {
    await releaseFailedWorktreeReservation({ repoRoot, path: worktreePath, branch });
    // B-028: git creates the branch before it creates the worktree, so a failed add ("'$GIT_DIR'
    // too big" or "Filename too long" on Windows, an unwritable .git/worktrees) left an
    // agent/... branch behind on every attempt. The branch did not exist before this call
    // (checked above); it is deleted only while it still points at the base commit, and
    // git branch -D refuses a branch that some worktree has checked out.
    let branchCleanup = "not_created";
    const leftover = await runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot, 1000 * 15);
    if (leftover.exitCode === 0) {
      const removed = leftover.stdout.trim() === baseCommit
        ? await runCommand("git", ["branch", "-D", "--", branch], repoRoot, 1000 * 15)
        : { exitCode: 1 };
      branchCleanup = removed.exitCode === 0 ? "deleted" : "retained";
    }
    return {
      ok: false,
      errorType: "worktree_create_failed",
      error: `${created.stderr || created.stdout || "git worktree add failed."}${branchCleanup === "retained" ? ` The branch ${branch} that git created was retained; delete it with git branch -D once nothing uses it.` : ""}`,
      repoRoot,
      branch,
      branchCleanup,
      path: worktreePath,
    };
  }

  // Tests move HEAD here, between the add and the check.
  if (typeof worktreeCreateTestHook === "function") await worktreeCreateTestHook({ repoRoot, worktreePath, branch, baseCommit, attempt });

  const [postCheckpointState, postHead, createdWorktreeState] = await Promise.all([
    inspectSourceCheckpointState(repoRoot, { lockedPaths, allowedEdits, scopeContract }),
    runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15, buildValidationEnv()),
    inspectSourceCheckpointState(worktreePath, { policy: "strict" }),
  ]);
  const headMovedOnly = postCheckpointState.ok && createdWorktreeState.ok && postHead.exitCode === 0 && postHead.stdout.trim() !== baseCommit;
  if (headMovedOnly) {
    const newHead = postHead.stdout.trim();
    const move = await classifyHeadMoveDuringCreation(repoRoot, baseCommit, newHead, { lockedPaths, allowedEdits, scopeContract });
    if (move.accepted) {
      headMovedDuringCreation = { from: baseCommit, to: newHead, changedFiles: move.changedFiles.length, recreated };
      logEvent("info", "worktree.head_moved_accepted", {
        jobId,
        from: baseCommit.slice(0, 12),
        to: newHead.slice(0, 12),
        changedFiles: move.changedFiles.length,
        summary: `Repository HEAD moved during worktree creation (${baseCommit.slice(0, 12)}..${newHead.slice(0, 12)}, ${move.changedFiles.length} file(s), none in the job's scope); the worktree keeps its base.`,
      });
    } else if (attempt < WORKTREE_CREATE_HEAD_MOVE_ATTEMPTS - 1) {
      const removed = await cleanupWorktree({ repoRoot, path: worktreePath, branch }, "always", true);
      if (removed.cleanup === "success") {
        recreated += 1;
        logEvent("info", "worktree.recreated_after_head_move", {
          jobId,
          from: baseCommit.slice(0, 12),
          to: newHead.slice(0, 12),
          attempt: attempt + 1,
          summary: `Repository HEAD moved during worktree creation and touched the job's scope (${move.reason}); the worktree is created again from the new HEAD (attempt ${attempt + 2} of ${WORKTREE_CREATE_HEAD_MOVE_ATTEMPTS}).`,
        });
        continue;
      }
      // The cleanup could not remove the new worktree: fall through to the failure below.
      await releaseFailedWorktreeReservation({ repoRoot, path: worktreePath, branch });
      return {
        ok: false,
        errorType: "worktree_source_checkpoint_changed",
        error: `Repository HEAD changed during worktree creation and touched the job's scope (${move.reason}); the stale worktree could not be removed (${removed.error || removed.cleanup}), so no agent was started.`,
        repoRoot,
        path: worktreePath,
        branch,
        baseCommit,
        preExecutionCleanup: removed,
      };
    }
  }
  if (!headMovedDuringCreation && (!postCheckpointState.ok || postHead.exitCode !== 0 || postHead.stdout.trim() !== baseCommit || !createdWorktreeState.ok)) {
    let preExecutionCleanup = { cleanup: "retained", reason: "new worktree was not proven clean" };
    if (createdWorktreeState.ok) {
      preExecutionCleanup = await cleanupWorktree({ repoRoot, path: worktreePath, branch }, "always", true);
    }
    if (preExecutionCleanup.cleanup !== "success") {
      await releaseFailedWorktreeReservation({ repoRoot, path: worktreePath, branch });
    }
    return {
      ok: false,
      errorType: !postCheckpointState.ok
        ? postCheckpointState.errorType
        : !createdWorktreeState.ok
          ? "worktree_created_dirty"
          : "worktree_source_checkpoint_changed",
      error: !postCheckpointState.ok
        ? `${postCheckpointState.error} The source changed during worktree creation, so no agent was started.`
        : !createdWorktreeState.ok
          ? "The new worktree was not clean immediately after creation. It was retained as evidence and no agent was started."
        : `Repository HEAD changed during worktree creation ${WORKTREE_CREATE_HEAD_MOVE_ATTEMPTS} times in a row and touched the job's scope each time, so the new worktree no longer represents the current source checkpoint.`,
      dirtyEntries: (!createdWorktreeState.ok ? createdWorktreeState : postCheckpointState).dirtyEntries || [],
      dirtyFiles: (!createdWorktreeState.ok ? createdWorktreeState : postCheckpointState).dirtyFiles || [],
      overlappingFiles: (!createdWorktreeState.ok ? createdWorktreeState : postCheckpointState).overlappingFiles || [],
      disjointFiles: (!createdWorktreeState.ok ? createdWorktreeState : postCheckpointState).disjointFiles || [],
      conflictingPaths: dirtyCheckpointDetails(!createdWorktreeState.ok ? createdWorktreeState : postCheckpointState).conflictingPaths,
      repoRoot,
      path: worktreePath,
      branch,
      baseCommit,
      preExecutionCleanup,
    };
  }

  await markWorktreeArtifactState({ repoRoot, path: worktreePath, branch }, "retained", 0);

  return {
    ok: true,
    repoRoot,
    path: worktreePath,
    branch,
    baseCommit,
    baseTree: baseTreeResult.stdout.trim(),
    cleanup: "not_attempted",
    sourceDirtPolicy: checkpointState.sourceDirtPolicy || "strict",
    toleratedDisjointFiles: checkpointState.toleratedDisjointFiles || [],
    toleratedReadScopeFiles: checkpointState.toleratedReadScopeFiles || [],
    headMovedDuringCreation,
    recreatedAfterHeadMove: recreated,
  };
  }
}

const WORKTREE_CREATE_HEAD_MOVE_ATTEMPTS = 3;

// B-150: what the commits between the base the worktree got and the HEAD the target has now
// changed, against the job's whole scope (read paths too: a reader of a file those commits
// changed would otherwise work on the older version without knowing). Accepted when they are
// disjoint; anything unreadable counts as touching the scope.
async function classifyHeadMoveDuringCreation(repoRoot, baseCommit, newHead, { lockedPaths = [], allowedEdits = [], scopeContract = null } = {}) {
  const diff = await runCommand("git", ["diff", "--name-only", "-z", `${baseCommit}`, `${newHead}`], repoRoot, 1000 * 60, buildValidationEnv());
  if (diff.exitCode !== 0) return { accepted: false, changedFiles: [], reason: `git diff ${baseCommit.slice(0, 12)}..${newHead.slice(0, 12)} failed: ${(diff.stderr || "").trim().slice(0, 200)}` };
  const changedFiles = normalizeLockPathList(String(diff.stdout || "").split("\0").filter(Boolean));
  const scopePaths = mergePathLists(lockedPaths, allowedEdits, scopeContractPathInputs(scopeContract));
  if (!scopePaths.length) return { accepted: false, changedFiles, reason: "the job has no scope paths to compare against" };
  const hit = overlaps(changedFiles, scopePaths);
  if (hit) return { accepted: false, changedFiles, reason: `${hit[0]} is in the job's scope` };
  return { accepted: true, changedFiles, reason: "" };
}

async function collectWorktreeDiff(worktree) {
  if (!worktree?.path) {
    return null;
  }
  const patch = await createPatchFromWorkingTree(worktree.path, worktree.baseCommit || "HEAD", { rejectIgnoredSource: true });
  if (!patch.ok) {
    return {
      changedFiles: [],
      diffStat: "",
      patchPreview: "",
      patchSha256: "",
      errorType: patch.errorType,
      error: patch.error,
    };
  }
  return {
    changedFiles: patch.changedFiles,
    diffStat: diffStatFromPatch(patch.patch),
    patchPreview: truncateText(redactSensitiveText(patch.patch)),
    patchSha256: patch.patchSha256,
    sourceStateSha256: patch.sourceStateSha256,
    sourceBaseCommit: patch.baseCommit,
    sourceHead: patch.sourceHead,
    errorType: null,
    error: "",
  };
}

function cleanupWorktree(...args) {
  return integrationTimed("worktreeRemove", () => cleanupWorktreeUntimed(...args));
}

async function cleanupWorktreeUntimed(worktree, cleanupMode, success) {
  if (!worktree?.path || cleanupMode === "never") {
    return {
      cleanup: "skipped",
      reason: cleanupMode === "never" ? "configured never" : "no worktree",
    };
  }

  if (cleanupMode === "on_success" && !success) {
    return {
      cleanup: "skipped",
      reason: "job did not finish successfully",
    };
  }

  const removeArgs = ["worktree", "remove"];
  if (cleanupMode === "always" || cleanupMode === "on_success") {
    removeArgs.push("--force");
  }
  removeArgs.push(worktree.path);

  const branchRef = worktree.branch && worktree.branch !== "HEAD"
    ? `refs/heads/${worktree.branch}`
    : "";
  const expectedBranch = branchRef
    ? await runCommand("git", ["show-ref", "--hash", "--verify", branchRef], worktree.repoRoot, 1000 * 15)
    : null;
  const expectedBranchOid = expectedBranch?.exitCode === 0 ? expectedBranch.stdout.trim() : "";

  // B-030: git would delete through a junction into its target (a source checkout's
  // node_modules/); the links go first, and a link that cannot be detached keeps the worktree.
  try {
    await detachWorktreeLinks(worktree.path);
  } catch (error) {
    await updateRetainedWorktreeMeasurement(worktree);
    await markWorktreeArtifactState(worktree, "cleanup_failed");
    return {
      cleanup: "failed",
      errorType: "worktree_cleanup_failed",
      error: `Could not detach links before removing the worktree: ${error?.message || error}`,
    };
  }
  const removed = await runCommand("git", removeArgs, worktree.repoRoot, CONFIG.gitHeavyTimeoutMs);
  if (removed.exitCode !== 0) {
    await updateRetainedWorktreeMeasurement(worktree);
    await markWorktreeArtifactState(worktree, "cleanup_failed");
    return {
      cleanup: "failed",
      errorType: "worktree_cleanup_failed",
      error: removed.stderr || removed.stdout || "git worktree remove failed.",
    };
  }

  if (!worktree.branch || worktree.branch === "HEAD") {
    await markWorktreeArtifactState(worktree, "cleaned");
    return {
      cleanup: "success",
      branchCleanup: "skipped",
      reason: "worktree had no removable local branch",
    };
  }

  if (!expectedBranchOid) {
    // show-ref failed: either the branch is already gone (nothing to clean) or its identity
    // really could not be read (keep reporting that as retained).
    const listed = await runCommand("git", ["for-each-ref", "--format=%(refname)", branchRef], worktree.repoRoot, 1000 * 15);
    if (listed.exitCode === 0 && !listed.stdout.split(/\r?\n/).map((line) => line.trim()).includes(branchRef)) {
      await markWorktreeArtifactState(worktree, "cleaned");
      return {
        cleanup: "success",
        branchCleanup: "already_absent",
        reason: "the worktree's local branch no longer existed",
      };
    }
  }

  if (typeof worktreeCleanupTestHook === "function") {
    await worktreeCleanupTestHook({ worktree, branchRef, expectedBranchOid });
  }

  const deletedBranch = expectedBranchOid
    ? await runCommand("git", ["update-ref", "-d", branchRef, expectedBranchOid], worktree.repoRoot, 1000 * 30)
    : { exitCode: 1, stdout: "", stderr: "The source branch identity could not be captured before worktree removal." };
  await markWorktreeArtifactState(
    worktree,
    deletedBranch.exitCode === 0 ? "cleaned" : "cleaned_branch_retained"
  );
  return {
    cleanup: deletedBranch.exitCode === 0 ? "success" : "partial",
    branchCleanup: deletedBranch.exitCode === 0 ? "success" : "failed",
    error: deletedBranch.exitCode === 0 ? "" : deletedBranch.stderr || deletedBranch.stdout || "git branch cleanup failed.",
  };
}

function formatWorktreeSummary(worktree, cleanupResult = null) {
  if (!worktree) {
    return "Worktree: not used";
  }

  return [
    "Worktree: used",
    `Worktree path: ${worktree.path}`,
    `Worktree branch: ${worktree.branch}`,
    worktree.toleratedDisjointFiles?.length
      ? `Worktree tolerated unrelated source changes (${worktree.sourceDirtPolicy}): ${worktree.toleratedDisjointFiles.join(", ")}`
      : null,
    worktree.toleratedReadScopeFiles?.length
      ? `Worktree read scope had uncommitted changes (the agent read HEAD's version): ${worktree.toleratedReadScopeFiles.join(", ")}`
      : null,
    worktree.headMovedDuringCreation
      ? `Worktree base: repository HEAD moved during creation (${worktree.headMovedDuringCreation.from.slice(0, 12)}..${worktree.headMovedDuringCreation.to.slice(0, 12)}, ${worktree.headMovedDuringCreation.changedFiles} file(s) outside the job's scope); the base ${worktree.baseCommit.slice(0, 12)} was kept`
      : worktree.recreatedAfterHeadMove
        ? `Worktree base: created again ${worktree.recreatedAfterHeadMove} time(s) after repository HEAD moved during creation`
        : null,
    `Worktree cleanup: ${cleanupResult?.cleanup || "not attempted"}`,
    cleanupResult?.reason ? `Worktree cleanup reason: ${cleanupResult.reason}` : null,
    cleanupResult?.error ? `Worktree cleanup error: ${cleanupResult.error}` : null,
  ].filter(Boolean).join("\n");
}

  // Keep the test hook live when the server changes it after initialization.
  const worktreeTestHooks = {
    get cleanup() { return worktreeCleanupTestHook; },
    set cleanup(value) { worktreeCleanupTestHook = value; },
    get create() { return worktreeCreateTestHook; },
    set create(value) { worktreeCreateTestHook = value; },
  };

  return { claimRetainedWorktree, releaseRetainedWorktreeClaim, recoverStaleWorktreeClaims, worktreeArtifactStatus, isBridgeGeneratedWorktree, generatedWorktreeRootForCwd, filterGeneratedWorktreeFiles, resolveWorktreeRoot, shouldUseWorktree, makeWorktreeBranchName, inspectSourceCheckpointState, dirtyCheckpointDetails, reconcileWorktreeArtifactRegistry, reserveWorktreeArtifact, markWorktreeArtifactState, releaseFailedWorktreeReservation, measureRetainedWorktreeBytes, updateRetainedWorktreeMeasurement, createWorktreeForJob, collectWorktreeDiff, cleanupWorktree, cleanupWorktreeUntimed, formatWorktreeSummary, RETAINED_WORKTREE_STATUSES, worktreeTestHooks };
}
