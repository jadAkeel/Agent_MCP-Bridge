// Project state paths, database opening and lock-secret compatibility cleanup.
// Extracted from server.js in modularization round M-001.
// Construction performs no filesystem or database access.

import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, lstat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { normalizeFilesystemCase } from "../paths.js";
import { ensureDirectRunAuditSchema } from "../../bin/direct-run-audit.js";

// Read the host override on each operation: self-test and runtime path changes stay live.
export function createStateDatabase({
  CONFIG,
  GLOBAL_BRIDGE_STATE_DIR,
  getStateDirectoryOverride,
  runCommand,
  assertNoLinkedPath,
  ensureLockTableSchema,
  ensureTableColumn,
  ensureQueueLeaseSchema,
  ensurePipelineRevisionSchema,
  ensureIntegrationJournalSchema,
  ensureIntegrationPreviewReceiptSchema,
  ensureWorktreeArtifactSchema,
  migrateLegacyEncryptedState,
  BRIDGE_INSTANCE_ID,
  KNOWN_STATE_DB_PATHS,
  ensureQueueHeartbeatTimer,
  ensureStateMaintenanceTimer,
  prunePersistedState,
}) {
function projectStateKey(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const normalized = normalizeFilesystemCase(canonical, canonical);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function recordMatchesProject(record, projectRoot = "") {
  if (!projectRoot) {
    return true;
  }

  const normalizedProjectRoot = path.resolve(projectRoot);
  return normalizeFilesystemCase(path.resolve(record?.cwd || process.cwd()), normalizedProjectRoot)
    === normalizeFilesystemCase(normalizedProjectRoot, normalizedProjectRoot);
}

function effectiveBridgeStateDirectory() {
  return getStateDirectoryOverride() || GLOBAL_BRIDGE_STATE_DIR;
}

function stateDbPath(cwd = "") {
  const root = cwd ? path.resolve(cwd) : "";
  const stateRoot = effectiveBridgeStateDirectory();
  if (root && root !== path.parse(root).root) {
    return path.join(stateRoot, "projects", `${projectStateKey(root)}.sqlite`);
  }
  return path.join(stateRoot, "bridge-state.sqlite");
}

// B-168: queue-worker.js --enqueue/--add resolved the same repository root with a `git rev-parse`
// about six times per line (the check, the enqueue, every database open). Inside
// withProjectRootCache (one file's enqueue) each directory is resolved once. The cache closes when
// the call returns, so a timer started inside it resolves afresh afterwards.
const projectRootCacheStorage = new AsyncLocalStorage();

async function withProjectRootCache(fn) {
  const cache = { open: true, roots: new Map() };
  try {
    return await projectRootCacheStorage.run(cache, fn);
  } finally {
    cache.open = false;
    cache.roots.clear();
  }
}

async function resolveProjectStateRoot(cwd = "") {
  const base = path.resolve(cwd || process.cwd());
  const cache = projectRootCacheStorage.getStore();
  if (!cache?.open) return await resolveProjectStateRootUncached(base);
  if (!cache.roots.has(base)) {
    const pending = resolveProjectStateRootUncached(base);
    cache.roots.set(base, pending);
    pending.catch(() => cache.roots.delete(base));
  }
  return await cache.roots.get(base);
}

async function resolveProjectStateRootUncached(base) {
  const repoRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], base, 1000 * 15);
  const resolved = repoRoot.exitCode === 0 && repoRoot.stdout.trim()
    ? path.resolve(repoRoot.stdout.trim())
    : base;
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function scrubLegacyLockSecrets(db) {
  const rows = db.prepare("SELECT rowid, token, task FROM locks").all();
  const update = db.prepare("UPDATE locks SET token = ?, task = ? WHERE rowid = ?");
  for (const row of rows) {
    const token = String(row.token || "");
    const task = String(row.task || "");
    const tokenDigest = /^sha256:[a-f0-9]{64}$/i.test(token)
      ? token.toLowerCase()
      : `sha256:${createHash("sha256").update(token).digest("hex")}`;
    const taskDigest = /^sha256:[a-f0-9]{64}$/i.test(task)
      ? task.toLowerCase()
      : `sha256:${createHash("sha256").update(task).digest("hex")}`;
    if (token !== tokenDigest || task !== taskDigest) update.run(tokenDigest, taskDigest, row.rowid);
  }
}

async function openLockDb(cwd = "") {
  const dbPath = stateDbPath(await resolveProjectStateRoot(cwd));
  await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  await assertNoLinkedPath(path.dirname(dbPath), "Bridge state directory");
  if (existsSync(dbPath)) {
    const details = await lstat(dbPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Bridge state database must be a regular file, not a link or special entry.");
    }
  }
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      const openedDetails = await lstat(dbPath);
      if (openedDetails.isSymbolicLink() || !openedDetails.isFile()) {
        throw new Error("Bridge state database identity changed during open.");
      }
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA synchronous = FULL;");
      db.exec("PRAGMA secure_delete = ON;");
      const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode || "").toLowerCase();
      if (journalMode !== "wal") {
        db.exec("PRAGMA journal_mode = WAL;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS locks (
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
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          status TEXT NOT NULL,
          lock_mode TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS changed_files (
          run_id TEXT NOT NULL,
          path TEXT NOT NULL,
          allowed INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS opencode_jobs (
          job_id TEXT PRIMARY KEY,
          cwd TEXT,
          status TEXT NOT NULL,
          agent TEXT NOT NULL,
          mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          record_json TEXT NOT NULL,
          idempotency_key TEXT,
          request_encrypted TEXT,
          result_encrypted TEXT
        );
        CREATE TABLE IF NOT EXISTS opencode_pipelines (
          pipeline_id TEXT PRIMARY KEY,
          cwd TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          record_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          request_encrypted TEXT,
          details_encrypted TEXT
        );
        CREATE TABLE IF NOT EXISTS bridge_instances (
          instance_id TEXT PRIMARY KEY,
          process_id INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        );
      `);
      ensureDirectRunAuditSchema(db);
      ensureLockTableSchema(db);
      ensureTableColumn(db, "locks", "acquisition_origin", "TEXT NOT NULL DEFAULT 'legacy'");
      ensureTableColumn(db, "runs", "containment", "TEXT NOT NULL DEFAULT ''");
      ensureQueueLeaseSchema(db);
      ensurePipelineRevisionSchema(db);
      ensureIntegrationJournalSchema(db);
      ensureIntegrationPreviewReceiptSchema(db);
      ensureWorktreeArtifactSchema(db);
      await migrateLegacyEncryptedState(db, dbPath);
      scrubLegacyLockSecrets(db);
      const heartbeatAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      db.prepare(`
        INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          process_id = excluded.process_id,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
      `).run(BRIDGE_INSTANCE_ID, process.pid, heartbeatAt, heartbeatAt, leaseExpiresAt);
      db.exec("CREATE INDEX IF NOT EXISTS locks_expires_at_idx ON locks (expires_at)");
      db.exec("CREATE INDEX IF NOT EXISTS runs_retention_idx ON runs (status, finished_at)");
      db.exec("CREATE INDEX IF NOT EXISTS changed_files_run_idx ON changed_files (run_id)");
      db.exec("CREATE INDEX IF NOT EXISTS opencode_jobs_lease_idx ON opencode_jobs (status, lease_expires_at)");
      db.exec("CREATE INDEX IF NOT EXISTS opencode_jobs_retention_idx ON opencode_jobs (status, finished_at)");
      db.exec("CREATE INDEX IF NOT EXISTS opencode_pipelines_retention_idx ON opencode_pipelines (status, updated_at)");
      KNOWN_STATE_DB_PATHS.add(dbPath);
      ensureQueueHeartbeatTimer();
      ensureStateMaintenanceTimer();
      prunePersistedState(db, dbPath);
      return db;
    } catch (error) {
      if (db) {
        closeDb(db);
      }
      const retryable = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error));
      if (!retryable || attempt === maxAttempts - 1) {
        throw error;
      }
      const delayMs = Math.min(1000, 25 * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("SQLite lock database could not be opened.");
}

function closeDb(db) {
  try {
    db.close();
  } catch {
    // Nothing useful to do during cleanup.
  }
}

  return { projectStateKey, recordMatchesProject, effectiveBridgeStateDirectory, stateDbPath, resolveProjectStateRoot, withProjectRootCache, scrubLegacyLockSecrets, openLockDb, closeDb };
}
