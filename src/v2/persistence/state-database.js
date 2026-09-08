import { createHash } from "node:crypto";
import { mkdir as mkdirFs } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { closeDb as defaultCloseDb, ensureTableColumn as defaultEnsureTableColumn } from "./sqlite-utils.js";

export function createStateDatabase({
  config,
  getStateDirectory,
  projectStateKey,
  resolveProjectStateRoot,
  bridgeInstanceId,
  afterOpen = () => {},
  Database = DatabaseSync,
  mkdir = mkdirFs,
  ensureTableColumn = defaultEnsureTableColumn,
  closeDb = defaultCloseDb,
  clockNow = () => Date.now(),
  getProcessId = () => process.pid,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const CONFIG = config;
  const BRIDGE_INSTANCE_ID = bridgeInstanceId;

  function stateDbPath(cwd = "") {
    const root = cwd ? path.resolve(cwd) : "";
    const stateRoot = getStateDirectory();
    if (root && root !== path.parse(root).root) {
      return path.join(stateRoot, "projects", `${projectStateKey(root)}.sqlite`);
    }
    return path.join(stateRoot, "bridge-state.sqlite");
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
    if (lockTableHasCompositePrimaryKey(db)) {
      return;
    }

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

  function ensureQueueLeaseSchema(db) {
    ensureTableColumn(db, "opencode_jobs", "owner_instance_id", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "owner_process_id", "INTEGER");
    ensureTableColumn(db, "opencode_jobs", "owner_generation", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "updated_at", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "heartbeat_at", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "lease_expires_at", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "cancellation_requested_at", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "child_process_id", "INTEGER");
    ensureTableColumn(db, "opencode_jobs", "child_process_started_at", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "revision", "INTEGER NOT NULL DEFAULT 0");
    ensureTableColumn(db, "opencode_jobs", "idempotency_key", "TEXT");
    ensureTableColumn(db, "opencode_jobs", "request_encrypted", "TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS opencode_jobs_idempotency_idx ON opencode_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';");
  }

  function ensurePipelineRevisionSchema(db) {
    ensureTableColumn(db, "opencode_pipelines", "revision", "INTEGER NOT NULL DEFAULT 0");
    ensureTableColumn(db, "opencode_pipelines", "request_encrypted", "TEXT");
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
    await mkdir(path.dirname(dbPath), { recursive: true });
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let db = null;
      try {
        db = new Database(dbPath);
        db.exec("PRAGMA busy_timeout = 5000;");
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
            request_encrypted TEXT
          );
          CREATE TABLE IF NOT EXISTS opencode_pipelines (
            pipeline_id TEXT PRIMARY KEY,
            cwd TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            record_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            request_encrypted TEXT
          );
          CREATE TABLE IF NOT EXISTS bridge_instances (
            instance_id TEXT PRIMARY KEY,
            process_id INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL
          );
        `);
        ensureLockTableSchema(db);
        ensureTableColumn(db, "locks", "acquisition_origin", "TEXT NOT NULL DEFAULT 'legacy'");
        ensureQueueLeaseSchema(db);
        ensurePipelineRevisionSchema(db);
        scrubLegacyLockSecrets(db);
        const heartbeatAt = new Date(clockNow()).toISOString();
        const leaseExpiresAt = new Date(clockNow() + CONFIG.queueLeaseMs).toISOString();
        db.prepare(`
          INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(instance_id) DO UPDATE SET
            process_id = excluded.process_id,
            heartbeat_at = excluded.heartbeat_at,
            lease_expires_at = excluded.lease_expires_at
        `).run(BRIDGE_INSTANCE_ID, getProcessId(), heartbeatAt, heartbeatAt, leaseExpiresAt);
        db.exec("CREATE INDEX IF NOT EXISTS locks_expires_at_idx ON locks (expires_at)");
        db.exec("CREATE INDEX IF NOT EXISTS opencode_jobs_lease_idx ON opencode_jobs (status, lease_expires_at)");
        afterOpen(db, dbPath);
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
        await sleep(delayMs);
      }
    }

    throw new Error("SQLite lock database could not be opened.");
  }

  return {
    stateDbPath,
    lockTableHasCompositePrimaryKey,
    ensureLockTableSchema,
    ensureQueueLeaseSchema,
    scrubLegacyLockSecrets,
    openLockDb,
  };
}
