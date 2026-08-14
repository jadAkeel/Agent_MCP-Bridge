import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

import { unsafePathReason } from "../policy/path-boundary.js";
import {
  hasAmbiguousPathPattern,
  normalizeLockPath,
  normalizeLockPathList,
  normalizeLockPathListForCwd,
  overlaps,
} from "../policy/paths.js";
import { redactSensitiveText as defaultRedactSensitiveText } from "../security/redaction.js";
import { closeDb } from "./sqlite-utils.js";

const PARALLEL_LOCK_TYPES = new Set(["read", "write", "serial_integration"]);

export function createHardLockService({
  openLockDb,
  resolveProjectStateRoot,
  defaultLockTtlMs = 1000 * 60 * 30,
  logEvent = () => {},
  redactSensitiveText = defaultRedactSensitiveText,
  clockNow = () => Date.now(),
  random = () => Math.random(),
  randomBytes = cryptoRandomBytes,
  getProcessId = () => process.pid,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  function operationalErrorText(error) {
    return redactSensitiveText(error?.message || String(error));
  }

  function sanitizedOperationalError(error) {
    return new Error(operationalErrorText(error));
  }

  function safeLogEvent(level, event, data) {
    try {
      logEvent(level, event, data);
    } catch {
      // Lock ownership and timer callbacks must not depend on telemetry availability.
    }
  }

  function reportPostCommitSnapshotFailure(operation, lockId, error) {
    safeLogEvent("warn", "lock.post_commit_snapshot_failed", {
      operation,
      lockId,
      error: operationalErrorText(error),
    });
  }

  async function openHardLockDb(cwd) {
    try {
      return await openLockDb(cwd);
    } catch (error) {
      throw sanitizedOperationalError(error);
    }
  }

  async function recordChangedFiles(runId, cwd, changedFiles, disallowedFiles = []) {
    if (!runId) {
      return;
    }

    const db = await openHardLockDb(cwd);
    try {
      db.exec("BEGIN IMMEDIATE");
      const disallowed = new Set(normalizeLockPathList(disallowedFiles));
      const insert = db.prepare("INSERT INTO changed_files (run_id, path, allowed) VALUES (?, ?, ?)");
      for (const file of normalizeLockPathList(changedFiles)) {
        insert.run(runId, file, disallowed.has(file) ? 0 : 1);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original audit persistence error. */ }
      throw sanitizedOperationalError(error);
    } finally {
      closeDb(db);
    }
  }

  function lockPaths(lock) {
    return normalizeLockPathList(lock.paths || lock.lockedPaths || lock.allowedEdits || []);
  }

  function conflictsWithActiveLock(request, activeLock) {
    const requestType = request.lockType;
    const activeType = activeLock.lockType;

    if (requestType === "read" && activeType === "read") {
      return null;
    }

    const requestPaths = lockPaths(request);
    const activePaths = lockPaths(activeLock);
    const requiresRepositorySerialization = requestType === "serial_integration" || activeType === "serial_integration";
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
    return `${safeOwner}-${safeAgent}-${clockNow()}-${random().toString(36).slice(2, 8)}`;
  }

  function makeLockToken() {
    return randomBytes(32).toString("hex");
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
      };
      lock.paths.push(row.normalized_path);
      grouped.set(key, lock);
    }
    return [...grouped.values()].map((lock) => ({ ...lock, paths: normalizeLockPathList(lock.paths) }));
  }

  function listLocksFromDb(db, now = clockNow()) {
    db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(now);
    return rowsToLocks(db.prepare("SELECT * FROM locks WHERE expires_at > ? ORDER BY created_at, run_id, normalized_path").all(now));
  }

  async function cleanupExpiredLocks(cwd = "") {
    const db = await openHardLockDb(cwd);
    try {
      db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(clockNow());
    } catch (error) {
      throw sanitizedOperationalError(error);
    } finally {
      closeDb(db);
    }
  }

  async function listLocks(cwd = "") {
    const db = await openHardLockDb(cwd);
    try {
      return listLocksFromDb(db);
    } catch (error) {
      throw sanitizedOperationalError(error);
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
    ttlMs = defaultLockTtlMs,
  }) {
    const normalizedLockType = String(lockType || "write").trim().toLowerCase().replace(/[-\s]+/g, "_");
    const normalizedOrigin = origin === "manual" ? "manual" : "internal";
    let projectRoot;
    try {
      projectRoot = await resolveProjectStateRoot(cwd || process.cwd());
    } catch (error) {
      throw sanitizedOperationalError(error);
    }
    const unsafeReason = unsafePathReason(paths, projectRoot);
    const lockPathsRequested = normalizeLockPathListForCwd(paths, projectRoot);

    if (!PARALLEL_LOCK_TYPES.has(normalizedLockType)) {
      return {
        ok: false,
        error: `Invalid lockType "${lockType}". Use read, write, or serial_integration.`,
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

    if (hasAmbiguousPathPattern(lockPathsRequested)) {
      return {
        ok: false,
        error: "Write lock rejected: wildcard or ambiguous paths are not allowed.",
      };
    }

    const db = await openHardLockDb(projectRoot);
    const now = clockNow();
    const runId = makeLockId(owner, agent);
    const token = makeLockToken();
    const tokenSha256 = `sha256:${createHash("sha256").update(token).digest("hex")}`;
    const taskSha256 = createHash("sha256").update(String(task || "")).digest("hex");
    const expiresAt = now + Math.max(1000, Number(ttlMs) || defaultLockTtlMs);
    const request = { lockType: normalizedLockType, paths: lockPathsRequested };
    let transactionOpen = false;

    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const keptLocks = listLocksFromDb(db, now);
      const conflict = keptLocks.map((lock) => conflictsWithActiveLock(request, lock)).find(Boolean);
      if (conflict) {
        db.exec("ROLLBACK");
        transactionOpen = false;
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
        "INSERT INTO locks (normalized_path, owner_agent, acquisition_origin, run_id, token, lock_mode, expires_at, created_at, cwd, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const requestedPath of lockPathsRequested) {
        insert.run(requestedPath, agent || owner, normalizedOrigin, runId, tokenSha256, normalizedLockType, expiresAt, now, projectRoot, `sha256:${taskSha256}`);
      }
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
        pid: getProcessId(),
      };
      db.exec("COMMIT");
      transactionOpen = false;
      try {
        return { ok: true, lock, activeLocks: listLocksFromDb(db) };
      } catch (error) {
        reportPostCommitSnapshotFailure("acquire", lock.id, error);
        return { ok: true, lock, activeLocks: [], activeLocksUnavailable: true };
      }
    } catch (error) {
      if (transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors after failed begin/commit.
        }
      }
      return { ok: false, error: `Write lock rejected: ${operationalErrorText(error)}` };
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

    const db = await openHardLockDb(cwd);
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const requestedPaths = normalizeLockPathList(paths);
      const tokenSha256 = `sha256:${createHash("sha256").update(String(token)).digest("hex")}`;
      const rows = requestedPaths.length
        ? db.prepare(`SELECT * FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).all(lockId, tokenSha256, ...requestedPaths)
        : db.prepare("SELECT * FROM locks WHERE run_id = ? AND token = ?").all(lockId, tokenSha256);
      if (!rows.length) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, released: false, error: "No active lock matched that run_id and token." };
      }

      if (requestedPaths.length) {
        db.prepare(`DELETE FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).run(lockId, tokenSha256, ...requestedPaths);
      } else {
        db.prepare("DELETE FROM locks WHERE run_id = ? AND token = ?").run(lockId, tokenSha256);
      }
      db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?").run("released", clockNow(), lockId);
      db.exec("COMMIT");
      transactionOpen = false;
      try {
        return { ok: true, released: true, activeLocks: listLocksFromDb(db) };
      } catch (error) {
        reportPostCommitSnapshotFailure("release", lockId, error);
        return { ok: true, released: true, activeLocks: [], activeLocksUnavailable: true };
      }
    } catch (error) {
      if (transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors after failed begin/commit.
        }
      }
      return { ok: false, released: false, error: operationalErrorText(error) };
    } finally {
      closeDb(db);
    }
  }

  function startHardLockHeartbeat(lock, ttlMs) {
    if (!lock?.id || !lock?.token) return () => {};
    const intervalMs = Math.max(1000, Math.min(1000 * 30, Math.floor(ttlMs / 3)));
    const timer = setIntervalFn(async () => {
      try {
        const db = await openHardLockDb(lock.cwd);
        try {
          const expiresAt = clockNow() + ttlMs;
          const tokenSha256 = `sha256:${createHash("sha256").update(String(lock.token)).digest("hex")}`;
          const updated = db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ? AND token = ?").run(expiresAt, lock.id, tokenSha256);
          if (Number(updated.changes || 0) === 0) {
            safeLogEvent("warn", "lock.heartbeat_lost", { lockId: lock.id });
          }
        } finally {
          closeDb(db);
        }
      } catch (error) {
        safeLogEvent("warn", "lock.heartbeat_failed", { lockId: lock.id, error: operationalErrorText(error) });
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearIntervalFn(timer);
  }

  return {
    recordChangedFiles,
    conflictsWithActiveLock,
    cleanupExpiredLocks,
    listLocks,
    acquireHardLock,
    releaseHardLock,
    startHardLockHeartbeat,
  };
}
