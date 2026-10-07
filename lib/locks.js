// Durable lock acquisition, release, quarantine and lease renewal.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { normalizeLockPath, normalizeLockPathList, normalizeLockPathListForCwd, overlaps, unsafePathReason, hasAmbiguousPathPattern, REPOSITORY_SCOPE_LOCK_PATH } from "./paths.js";
import { firstNonEmptyList } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createLockRuntime({
  CONFIG,
  DEFAULT_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  PARALLEL_LOCK_TYPES,
  INTEGRATION_RECOVERY_BLOCKED_ROOTS,
  INTEGRATION_RESOLVED_SQL,
  ensureTableColumn,
  openLockDb,
  closeDb,
  resolveProjectStateRoot,
  reclaimLockQuarantinesForRoot,
  logEvent,
  timeoutForAgent,
}) {
function lockPaths(lock) {
  return normalizeLockPathList(lock.paths || lock.lockedPaths || lock.allowedEdits || []);
}

function conflictsWithActiveLock(request, activeLock, worktreeMode = CONFIG.worktreeMode) {
  const requestType = request.lockType;
  const activeType = activeLock.lockType;

  if (requestType === "read" && activeType === "read") {
    return null;
  }

  const requestPaths = lockPaths(request);
  const activePaths = lockPaths(activeLock);
  // Integration changes the real checkout, so it waits for every reader of the checkout and
  // for other integrations. With worktrees on, writers work in their own worktree and only
  // conflict when paths overlap; blocking integration on every running builder meant a
  // reviewed patch could not land while any other builder (from either client) still ran.
  // Manual acquire_agent_lock writers, legacy rows, and CODEX_OPENCODE_WORKTREE_MODE=off
  // writers edit the checkout itself, so they still serialize with integration.
  // Whether a writer edits the checkout is recorded on its lock row by the process that took
  // it (editsCheckout); deciding from this process's CONFIG.worktreeMode was wrong whenever the
  // two bridges (Codex, Claude) ran with different worktree modes. Rows without the flag are
  // legacy and count as editing the checkout; in-memory requests without it keep the mode rule.
  const editsCheckout = (lock) => typeof lock.editsCheckout === "boolean"
    ? lock.editsCheckout
    : !(worktreeMode !== "off" && (lock.origin || "internal") === "internal");
  const involvesIntegration = requestType === "serial_integration" || activeType === "serial_integration";
  const worktreeJobWriter = (lock) => lock.lockType === "write" && !editsCheckout(lock);
  const writerAndIntegration = involvesIntegration
    && (worktreeJobWriter(request) || worktreeJobWriter(activeLock));
  const requiresRepositorySerialization = involvesIntegration && !writerAndIntegration;
  const overlap = requiresRepositorySerialization
    ? overlaps(requestPaths, activePaths) || [requestPaths[0], activePaths[0]]
    : overlaps(requestPaths, activePaths);
  return overlap
    ? {
        lockId: activeLock.id,
        owner: activeLock.owner,
        agent: activeLock.agent,
        origin: activeLock.origin || "legacy",
        lockType: activeLock.lockType,
        paths: activePaths,
        overlap,
        expiresAt: activeLock.expiresAt,
      }
    : null;
}

function makeLockId(owner, agent) {
  const safeOwner = String(owner || "unknown").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  const safeAgent = String(agent || "agent").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${safeOwner}-${safeAgent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeLockToken() {
  return randomBytes(32).toString("hex");
}

function lockTableHasCompositePrimaryKey(db) {
  const primaryKeyColumns = db.prepare("PRAGMA table_info(locks)").all()
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  return primaryKeyColumns.length === 2
    && primaryKeyColumns[0] === "normalized_path"
    && primaryKeyColumns[1] === "run_id";
}

function ensureLockTableSchema(db) {
  if (!lockTableHasCompositePrimaryKey(db)) migrateLegacyLockTable(db);
  // 1 when the lock holder edits the checkout itself, 0 for a writer in its own worktree;
  // NULL rows come from older bridges and are treated as editing the checkout.
  ensureTableColumn(db, "locks", "edits_checkout", "INTEGER");
}

function migrateLegacyLockTable(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!lockTableHasCompositePrimaryKey(db)) {
      db.exec(`
        ALTER TABLE locks RENAME TO locks_legacy_single_path;
        CREATE TABLE locks (
          normalized_path TEXT NOT NULL,
          owner_agent TEXT NOT NULL,
          acquisition_origin TEXT NOT NULL DEFAULT 'legacy',
          run_id TEXT NOT NULL,
          token TEXT NOT NULL,
          lock_mode TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          cwd TEXT,
          task TEXT,
          PRIMARY KEY (normalized_path, run_id)
        );
        INSERT OR IGNORE INTO locks
          (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task)
        SELECT normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task
        FROM locks_legacy_single_path;
        DROP TABLE locks_legacy_single_path;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

function rowsToLocks(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.run_id;
    const lock = grouped.get(key) || {
      id: row.run_id,
      runId: row.run_id,
      owner: row.owner_agent,
      agent: row.owner_agent,
      origin: row.acquisition_origin || "legacy",
      lockType: row.lock_mode,
      lockMode: row.lock_mode,
      paths: [],
      cwd: row.cwd || "",
      taskSha256: String(row.task || "").replace(/^sha256:/i, ""),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      editsCheckout: row.edits_checkout === null || row.edits_checkout === undefined ? true : Number(row.edits_checkout) !== 0,
    };
    lock.paths.push(row.normalized_path);
    grouped.set(key, lock);
  }
  return [...grouped.values()].map((lock) => ({ ...lock, paths: normalizeLockPathList(lock.paths) }));
}

function expireLocksFromDb(db, now = Date.now()) {
  const expiredRunIds = db.prepare("SELECT DISTINCT run_id FROM locks WHERE expires_at <= ?").all(now)
    .map((row) => row.run_id)
    .filter(Boolean);
  db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(now);
  const markExpired = db.prepare(`
    UPDATE runs
    SET status = 'expired', finished_at = COALESCE(finished_at, ?)
    WHERE run_id = ? AND status = 'running'
      AND NOT EXISTS (SELECT 1 FROM locks WHERE locks.run_id = runs.run_id)
  `);
  for (const runId of expiredRunIds) markExpired.run(now, runId);
  return expiredRunIds;
}

function listLocksFromDb(db, now = Date.now()) {
  expireLocksFromDb(db, now);
  return rowsToLocks(db.prepare("SELECT * FROM locks WHERE expires_at > ? ORDER BY created_at, run_id, normalized_path").all(now));
}

async function cleanupExpiredLocks(cwd = "") {
  const db = await openLockDb(cwd);
  try {
    db.exec("BEGIN IMMEDIATE");
    expireLocksFromDb(db, Date.now());
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the cleanup error. */ }
    throw error;
  } finally {
    closeDb(db);
  }
}

async function listLocks(cwd = "") {
  const db = await openLockDb(cwd);
  try {
    return listLocksFromDb(db);
  } finally {
    closeDb(db);
  }
}

async function acquireHardLock({
  owner = "codex",
  agent = "opencode",
  origin = "internal",
  task = "",
  cwd = "",
  lockType = "write",
  paths = [],
  repositoryScope = false,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  editsCheckout = undefined,
  // Internal-only: set by recoverIntegrationRepositorySerially so journal recovery can take its
  // lock while the journal blocks writers. The tool never passes it (the exemption used to key
  // on the caller-controlled agent name).
  integrationRecoveryAuthority = false,
}) {
  const normalizedLockType = String(lockType || "write").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const normalizedOrigin = origin === "manual" ? "manual" : "internal";
  const recoveryAuthority = integrationRecoveryAuthority === true && normalizedOrigin === "internal";
  // A writer edits the checkout unless it is an internal job writer while this process runs
  // writers in worktrees; the flag is persisted so other bridge processes decide from it.
  const lockEditsCheckout = typeof editsCheckout === "boolean"
    ? editsCheckout
    : !(normalizedOrigin === "internal" && normalizedLockType === "write" && CONFIG.worktreeMode !== "off");
  const projectRoot = await resolveProjectStateRoot(cwd || process.cwd());
  const requestedPaths = repositoryScope ? [REPOSITORY_SCOPE_LOCK_PATH] : paths;
  const unsafeReason = repositoryScope ? "" : unsafePathReason(requestedPaths, projectRoot);
  const lockPathsRequested = normalizeLockPathListForCwd(requestedPaths, projectRoot);
  await reclaimLockQuarantinesForRoot(projectRoot);

  if (INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(path.resolve(projectRoot))
    && normalizedLockType !== "read"
    && !recoveryAuthority) {
    return {
      ok: false,
      errorType: "integration_recovery_pending",
      error: "Repository mutation is blocked until the durable integration journal is recovered or explicitly quarantined.",
    };
  }

  if (!PARALLEL_LOCK_TYPES.has(normalizedLockType)) {
    return {
      ok: false,
      error: `Invalid lockType "${lockType}". Use read, write, or serial_integration.`,
    };
  }

  if (repositoryScope && (normalizedOrigin !== "internal" || normalizedLockType === "write")) {
    return {
      ok: false,
      error: "Repository-wide scope is reserved for internal read or serial-integration consistency leases.",
    };
  }

  if (!lockPathsRequested.length) {
    return {
      ok: false,
      error: "Write lock rejected: paths are required.",
    };
  }

  if (unsafeReason) {
    return {
      ok: false,
      error: `Write lock rejected: ${unsafeReason}`,
    };
  }

  // With the project root, a real file named like a pattern (app/[slug]/page.tsx) is accepted
  // here exactly as the plan checks accept it; without it such a job passed its plan and then
  // had every lock refused.
  if (hasAmbiguousPathPattern(lockPathsRequested, projectRoot)) {
    return {
      ok: false,
      error: "Write lock rejected: wildcard or ambiguous paths are not allowed.",
    };
  }

  const db = await openLockDb(projectRoot);
  const now = Date.now();
  const runId = makeLockId(owner, agent);
  const token = makeLockToken();
  const tokenSha256 = `sha256:${createHash("sha256").update(token).digest("hex")}`;
  const taskSha256 = createHash("sha256").update(String(task || "")).digest("hex");
  const expiresAt = now + Math.min(MAX_LOCK_TTL_MS, Math.max(1000, Number(ttlMs) || DEFAULT_LOCK_TTL_MS));
  const request = { lockType: normalizedLockType, paths: lockPathsRequested, origin: normalizedOrigin, editsCheckout: lockEditsCheckout };

  let committed = false;
  let commitAttempted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (normalizedLockType !== "read" && !recoveryAuthority) {
      const unresolvedIntegration = db.prepare(`
        SELECT operation_id, status
        FROM integration_operations
        WHERE cwd = ? AND status NOT IN (${INTEGRATION_RESOLVED_SQL})
        ORDER BY updated_at, operation_id
        LIMIT 1
      `).get(path.resolve(projectRoot));
      if (unresolvedIntegration) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          errorType: "integration_recovery_pending",
          error: "Repository mutation is blocked by an unresolved durable integration operation.",
          operationId: unresolvedIntegration.operation_id,
          operationStatus: unresolvedIntegration.status,
        };
      }
    }
    const keptLocks = listLocksFromDb(db, now);
    const conflict = keptLocks.map((lock) => conflictsWithActiveLock(request, lock)).find(Boolean);
    if (conflict) {
      db.exec("ROLLBACK");
      const conflictPath = normalizeLockPath(conflict.overlap?.[0] || conflict.overlap?.[1] || conflict.paths?.[0] || "");
      return {
        ok: false,
        error: `Write lock conflict on: ${conflictPath || "unknown"}`,
        conflict,
        activeLocks: keptLocks,
      };
    }

    db.prepare(
      "INSERT INTO runs (run_id, agent, status, lock_mode, started_at, finished_at) VALUES (?, ?, ?, ?, ?, NULL)"
    ).run(runId, agent, "running", normalizedLockType, now);
    const insert = db.prepare(
      "INSERT INTO locks (normalized_path, owner_agent, acquisition_origin, run_id, token, lock_mode, expires_at, created_at, cwd, task, edits_checkout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const requestedPath of lockPathsRequested) {
      insert.run(requestedPath, agent || owner, normalizedOrigin, runId, tokenSha256, normalizedLockType, expiresAt, now, projectRoot, `sha256:${taskSha256}`, lockEditsCheckout ? 1 : 0);
    }
    // Read inside the transaction: after COMMIT a SQLITE_BUSY in this listing (it expires
    // rows) reported the acquire as rejected while the lock rows stayed committed with a
    // token nobody had, orphaning the lock for its whole TTL.
    const activeLocks = listLocksFromDb(db, now);
    commitAttempted = true;
    db.exec("COMMIT");
    committed = true;

    const lock = {
      id: runId,
      runId,
      token,
      owner,
      agent,
      origin: normalizedOrigin,
      taskSha256,
      cwd: projectRoot,
      lockType: normalizedLockType,
      lockMode: normalizedLockType,
      paths: lockPathsRequested,
      createdAt: now,
      expiresAt,
      editsCheckout: lockEditsCheckout,
      pid: process.pid,
    };
    return { ok: true, lock, activeLocks };
  } catch (error) {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors after failed begin/commit.
      }
    }
    // COMMIT can report an error after its rows are durable, and anything that throws after it
    // lands here too. This acquire is reported as failed and nobody holds the token, so a row
    // that did commit would stay locked for the whole TTL (up to a day). Remove what this call
    // inserted, identified by its own run id and fresh token, so a failed acquire never leaves
    // a lock. The DELETE is a no-op when the transaction rolled back.
    if (commitAttempted) {
      try {
        db.prepare("DELETE FROM locks WHERE run_id = ? AND token = ?").run(runId, tokenSha256);
        db.prepare("UPDATE runs SET status = 'released', finished_at = ? WHERE run_id = ? AND status = 'running'").run(Date.now(), runId);
      } catch (cleanupError) {
        logEvent("error", "lock.acquire_cleanup_failed", {
          lockId: runId,
          error: cleanupError?.message || String(cleanupError),
        });
      }
    }
    return { ok: false, error: `Write lock rejected: ${error.message || String(error)}` };
  } finally {
    closeDb(db);
  }
}

async function releaseHardLock(lockId, token = "", paths = [], cwd = "") {
  if (!lockId) {
    return { ok: false, released: false, error: "lockId is required." };
  }

  if (!token) {
    return { ok: false, released: false, error: "Lock release token is required." };
  }

  let db;
  try {
    db = await openLockDb(cwd);
  } catch (error) {
    // Callers release in finally blocks; an unopenable state database must not replace their
    // result with an exception. The lease expires on its own.
    return { ok: false, released: false, error: error.message || String(error) };
  }
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const requestedPaths = normalizeLockPathList(paths);
    const tokenSha256 = `sha256:${createHash("sha256").update(String(token)).digest("hex")}`;
    const rows = requestedPaths.length
      ? db.prepare(`SELECT * FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).all(lockId, tokenSha256, ...requestedPaths)
      : db.prepare("SELECT * FROM locks WHERE run_id = ? AND token = ?").all(lockId, tokenSha256);
    if (!rows.length) {
      db.exec("ROLLBACK");
      return { ok: false, released: false, error: "No active lock matched that run_id and token." };
    }

    if (requestedPaths.length) {
      db.prepare(`DELETE FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).run(lockId, tokenSha256, ...requestedPaths);
    } else {
      db.prepare("DELETE FROM locks WHERE run_id = ? AND token = ?").run(lockId, tokenSha256);
    }
    const remaining = db.prepare("SELECT 1 FROM locks WHERE run_id = ? LIMIT 1").get(lockId);
    if (!remaining) {
      db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?").run("released", Date.now(), lockId);
    }
    const activeLocks = listLocksFromDb(db);
    db.exec("COMMIT");
    committed = true;
    return { ok: true, released: true, activeLocks };
  } catch (error) {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors after failed begin/commit.
      }
    }
    return { ok: false, released: false, error: error.message || String(error) };
  } finally {
    closeDb(db);
  }
}

async function quarantineHardLock(lock, containment = "") {
  if (!lock?.id || !lock?.token) return { ok: false };
  const db = await openLockDb(lock.cwd);
  try {
    const now = Date.now();
    const tokenSha256 = `sha256:${createHash("sha256").update(String(lock.token)).digest("hex")}`;
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      UPDATE locks SET expires_at = ?
      WHERE run_id = ? AND token = ?
    `).run(Number.MAX_SAFE_INTEGER, lock.id, tokenSha256);
    // Expired rows may already have been pruned, including only some of the
    // original paths. Restore the complete scope before another writer starts.
    const heldPaths = new Set(db.prepare("SELECT normalized_path FROM locks WHERE run_id = ? AND token = ? AND expires_at = ?")
      .all(lock.id, tokenSha256, Number.MAX_SAFE_INTEGER).map((row) => row.normalized_path));
    if (!heldPaths.size && (!Array.isArray(lock.paths) || !lock.paths.length)) {
      db.exec("ROLLBACK");
      return { ok: false };
    }
    if (Array.isArray(lock.paths) && lock.paths.some((lockPath) => !heldPaths.has(lockPath))) {
      const insert = db.prepare(`
        INSERT INTO locks (normalized_path, owner_agent, acquisition_origin, run_id, token, lock_mode, expires_at, created_at, cwd, task, edits_checkout)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const lockPath of lock.paths) {
        if (heldPaths.has(lockPath)) continue;
        insert.run(lockPath, lock.agent || lock.owner || "opencode", lock.origin || "internal", lock.id,
          tokenSha256, lock.lockType || lock.lockMode || "write", Number.MAX_SAFE_INTEGER,
          Number(lock.createdAt) || now, lock.cwd, `sha256:${lock.taskSha256 || ""}`, lock.editsCheckout === false ? 0 : 1);
      }
    }
    db.prepare(`
      INSERT INTO runs (run_id, agent, status, lock_mode, started_at, finished_at, containment)
      VALUES (?, ?, 'quarantined', ?, ?, NULL, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = 'quarantined', finished_at = NULL, containment = excluded.containment
    `).run(lock.id, lock.agent || lock.owner || "opencode", lock.lockType || lock.lockMode || "write",
      Number(lock.createdAt) || now, String(containment || ""));
    db.exec("COMMIT");
    lock.expiresAt = Number.MAX_SAFE_INTEGER;
    return { ok: true };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the containment error. */ }
    logEvent("error", "lock.containment_quarantine_failed", {
      lockId: lock.id,
      error: error.message || String(error),
    });
    return { ok: false };
  } finally {
    closeDb(db);
  }
}

// A containment quarantine sets expires_at to Number.MAX_SAFE_INTEGER, beyond the largest
// Date, so new Date(...).toISOString() threw RangeError and list_agent_locks failed.
function formatLockExpiry(expiresAt) {
  const value = Number(expiresAt);
  if (value >= Number.MAX_SAFE_INTEGER) return "quarantined (no expiry)";
  const date = new Date(value);
  return Number.isFinite(value) && !Number.isNaN(date.getTime()) ? date.toISOString() : "unknown";
}

function formatAgentLockList(locks = []) {
  return locks.length
    ? [
        "Active temporary locks:",
        "",
        ...locks.map((lock) =>
          [
            `- ${lock.id}`,
            `  owner: ${lock.owner}`,
            `  agent: ${lock.agent}`,
            `  type: ${lock.lockType}`,
            `  paths: ${lock.paths.join(", ")}`,
            `  expires: ${formatLockExpiry(lock.expiresAt)}`,
          ].join("\n")
        ),
      ].join("\n")
    : "No active temporary locks.";
}

// Agent names the bridge's own internal locks use. The recovery bypass used to key on the
// agent name, which acquire_agent_lock takes from the caller.
const RESERVED_LOCK_AGENT_NAMES = new Set(["integration_recovery", "merge_manager", "pipeline_finalizer"]);

function reservedLockAgentError(name) {
  const normalized = String(name || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return RESERVED_LOCK_AGENT_NAMES.has(normalized)
    ? `Lock rejected: "${name}" is reserved for the bridge's internal locks.`
    : "";
}

function hardLockPathsForPlan(lockPlan) {
  if (lockPlan?.lockType === "read") {
    return firstNonEmptyList(lockPlan.lockedPaths, lockPlan.scopeContract?.scope?.read, [REPOSITORY_SCOPE_LOCK_PATH]);
  }
  return firstNonEmptyList(lockPlan.allowedEdits, lockPlan.lockedPaths);
}

function hardLockTtlForPlan(lockPlan) {
  const executionTimeoutMs = timeoutForAgent(lockPlan?.agent, lockPlan, lockPlan?.timeoutMs);
  const safetyMarginMs = CONFIG.validationCommandTimeoutMs + 1000 * 60 * 5;
  return Math.max(DEFAULT_LOCK_TTL_MS, executionTimeoutMs + safetyMarginMs);
}

function lockOwnershipLossError(lock, detail = "Durable lock ownership could not be renewed before expiry.") {
  const error = new Error(detail);
  error.errorType = lock?.lockType === "read"
    ? "read_lock_ownership_lost"
    : lock?.lockType === "serial_integration"
      ? "integration_lock_ownership_lost"
      : "write_lock_ownership_lost";
  error.lockId = lock?.id || "";
  return error;
}

function startHardLockHeartbeat(lock, ttlMs, { intervalMs: requestedIntervalMs = 0, refreshLease = null } = {}) {
  const controller = new AbortController();
  const inertStop = Object.assign(() => {}, {
    signal: controller.signal,
    pulse: async () => false,
    assertOwned: () => null,
  });
  if (!lock?.id || !lock?.token) return inertStop;

  const effectiveTtlMs = Math.max(250, Number(ttlMs) || DEFAULT_LOCK_TTL_MS);
  const intervalMs = requestedIntervalMs > 0
    ? Math.max(20, Math.min(requestedIntervalMs, Math.floor(effectiveTtlMs / 2)))
    : Math.max(100, Math.min(1000 * 30, Math.floor(effectiveTtlMs / 3)));
  const expiryGuardMs = Math.max(20, Math.min(intervalMs, Math.floor(effectiveTtlMs / 4)));
  let lastConfirmedExpiresAt = Number(lock.expiresAt) || Date.now() + effectiveTtlMs;
  let fenceTimer = null;
  let refreshPromise = null;
  let stopped = false;

  const loseOwnership = (detail) => {
    if (controller.signal.aborted || stopped) return;
    const error = lockOwnershipLossError(lock, detail);
    logEvent("error", "lock.ownership_lost", { lockId: lock.id, errorType: error.errorType, detail });
    controller.abort(error);
  };
  const scheduleFence = () => {
    if (fenceTimer) clearTimeout(fenceTimer);
    const delayMs = Math.max(0, lastConfirmedExpiresAt - Date.now() - expiryGuardMs);
    fenceTimer = setTimeout(() => {
      loseOwnership("Durable lock renewal did not complete before the fail-closed lease deadline.");
    }, delayMs);
    fenceTimer.unref?.();
  };

  const pulse = async () => {
    if (stopped || controller.signal.aborted) return false;
    if (refreshPromise) return await refreshPromise;
    refreshPromise = (async () => {
      let db = null;
      try {
        const now = Date.now();
        if (lastConfirmedExpiresAt <= now) {
          loseOwnership("The durable lock expired before its heartbeat could run.");
          return false;
        }
        const expiresAt = now + effectiveTtlMs;
        let renewed = false;
        if (typeof refreshLease === "function") {
          renewed = (await refreshLease({ lock, expiresAt })) !== false;
        } else {
          db = await openLockDb(lock.cwd);
          if (stopped || controller.signal.aborted) return false;
          const tokenSha256 = `sha256:${createHash("sha256").update(String(lock.token)).digest("hex")}`;
          // expires_at = MAX_SAFE_INTEGER is a containment quarantine; a pulse that was already
          // running when quarantineHardLock ran must not renew it back into an expiring lease.
          const updated = db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ? AND token = ? AND expires_at > ? AND expires_at <> ?")
            .run(expiresAt, lock.id, tokenSha256, now, Number.MAX_SAFE_INTEGER);
          renewed = Number(updated.changes || 0) === Math.max(1, lock.paths?.length || 0);
          if (!renewed && Number(updated.changes || 0) === 0) {
            const quarantined = db.prepare("SELECT COUNT(*) AS count FROM locks WHERE run_id = ? AND token = ? AND expires_at = ?")
              .get(lock.id, tokenSha256, Number.MAX_SAFE_INTEGER);
            if (Number(quarantined?.count || 0) > 0) {
              // Held without expiry until containment is resolved; nothing left to renew.
              if (fenceTimer) clearTimeout(fenceTimer);
              fenceTimer = null;
              clearInterval(timer);
              lastConfirmedExpiresAt = Number.MAX_SAFE_INTEGER;
              return true;
            }
          }
        }
        if (!renewed) {
          loseOwnership("The durable lock row or fencing token no longer belongs to this execution.");
          return false;
        }
        lock.expiresAt = expiresAt;
        lastConfirmedExpiresAt = expiresAt;
        scheduleFence();
        return true;
      } catch (error) {
        logEvent("warn", "lock.heartbeat_failed", { lockId: lock.id, error: error.message || String(error) });
        // A transient persistence error proves no loss of ownership. The supervisor
        // may keep running under the last confirmed lease, up to its guarded deadline.
        if (stopped || controller.signal.aborted) return false;
        if (Date.now() < lastConfirmedExpiresAt - expiryGuardMs) return true;
        loseOwnership("The durable lock could not be renewed before its confirmed lease deadline.");
        return false;
      } finally {
        if (db) closeDb(db);
      }
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  };

  scheduleFence();
  const timer = setInterval(pulse, intervalMs);
  timer.unref?.();
  // stop() returns a promise that settles once an in-flight pulse finished, so a caller that
  // awaits it (before releasing or quarantining the lock) never races a renewal; callers that
  // do not await it keep working.
  const stop = Object.assign(() => {
    stopped = true;
    clearInterval(timer);
    if (fenceTimer) clearTimeout(fenceTimer);
    return refreshPromise ? refreshPromise.then(() => undefined, () => undefined) : Promise.resolve();
  }, {
    signal: controller.signal,
    pulse,
    assertOwned: () => controller.signal.aborted ? controller.signal.reason : null,
  });
  return stop;
}

function hardLockSummary(acquiredLock) {
  if (!acquiredLock) {
    return "not acquired";
  }

  return `${acquiredLock.id} (${acquiredLock.lockType}: ${acquiredLock.paths.join(", ")})`;
}

  return { lockPaths, conflictsWithActiveLock, makeLockId, makeLockToken, lockTableHasCompositePrimaryKey, ensureLockTableSchema, migrateLegacyLockTable, rowsToLocks, expireLocksFromDb, listLocksFromDb, cleanupExpiredLocks, listLocks, acquireHardLock, releaseHardLock, quarantineHardLock, formatLockExpiry, formatAgentLockList, reservedLockAgentError, hardLockPathsForPlan, hardLockTtlForPlan, lockOwnershipLossError, startHardLockHeartbeat, hardLockSummary };
}
