import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLockRuntime } from "../../lib/locks.js";
import { createStateSchema } from "../../lib/state/schema.js";

// Real lock SQL and path checks, with a minimal schema for the tables they use.
// Project discovery and quarantine reclamation are external boundaries here;
// native process races/reclamation remain covered by e2e-concurrency and Day5.
export function lockFixture() {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(path.join(parent, "pl-")));
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE locks (
    normalized_path TEXT NOT NULL, owner_agent TEXT NOT NULL,
    acquisition_origin TEXT NOT NULL DEFAULT 'legacy', run_id TEXT NOT NULL,
    token TEXT NOT NULL, lock_mode TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, cwd TEXT, task TEXT, edits_checkout INTEGER,
    PRIMARY KEY (normalized_path, run_id));
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent TEXT NOT NULL,
      status TEXT NOT NULL, lock_mode TEXT, started_at INTEGER NOT NULL,
      finished_at INTEGER, containment TEXT);
    CREATE TABLE integration_operations (operation_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE queue_job_locks (lock_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL);
    CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, owner_instance_id TEXT,
      owner_generation TEXT, status TEXT, cancellation_requested_at TEXT);`);
  const blocked = new Set();
  const events = [];
  const schema = createStateSchema();
  const runtimes = new Map();
  let openFailure = false;
  let nextOpen = null;
  function runtime(mode = "on") {
    if (!runtimes.has(mode)) runtimes.set(mode, createLockRuntime({
      CONFIG: { worktreeMode: mode, validationCommandTimeoutMs: 5000 },
      DEFAULT_LOCK_TTL_MS: 60_000, MAX_LOCK_TTL_MS: 86_400_000,
      PARALLEL_LOCK_TYPES: new Set(["read", "write", "serial_integration"]),
      INTEGRATION_RECOVERY_BLOCKED_ROOTS: blocked,
      INTEGRATION_RESOLVED_SQL: "'committed', 'rolled_back', 'recovered_noop', 'recovered_verified', 'resolved_by_operator'",
      ensureTableColumn: schema.ensureTableColumn,
      openLockDb: async () => {
        const held = nextOpen;
        nextOpen = null;
        if (held) {
          held.entered();
          await held.released;
        }
        if (openFailure) throw new Error("synthetic database open failure");
        return db;
      }, closeDb: () => {}, resolveProjectStateRoot: async () => root,
      reclaimLockQuarantinesForRoot: async () => {},
      logEvent: (level, event, fields) => events.push({ level, event, fields }),
      timeoutForAgent: () => 30_000,
    }));
    return runtimes.get(mode);
  }
  const rows = () => db.prepare("SELECT * FROM locks ORDER BY run_id, normalized_path").all();
  return { root, db, blocked, events, runtime, rows,
    failOpen: value => { openFailure = value; },
    holdNextOpen: () => {
      if (nextOpen) throw new Error("A fixture database open is already held.");
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      nextOpen = { entered, released };
      return { started, release };
    },
    acquire: (request, mode = "on") => runtime(mode).acquireHardLock({
      cwd: root, agent: "fixture-worker", task: "synthetic private task", ...request,
    }),
    release: (lock, overrides = {}) => runtime().releaseHardLock(
      overrides.id ?? lock.id, overrides.token ?? lock.token,
      overrides.paths ?? [], root),
    close: () => {
      db.close();
      if (path.dirname(root) !== parent || !path.basename(root).startsWith("pl-") || realpathSync(root) !== root) {
        throw new Error("Lock fixture cleanup refused an unexpected root.");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
