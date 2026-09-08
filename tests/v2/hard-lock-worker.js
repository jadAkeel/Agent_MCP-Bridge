import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createHardLockService } from "../../src/v2/persistence/hard-locks.js";

const [stateDirectory, projectRoot, requestedPath = "src/shared.js"] = process.argv.slice(2);
const dbPath = path.join(stateDirectory, "hard-locks.sqlite");

function openLockDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
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
  `);
  return db;
}

const service = createHardLockService({
  openLockDb,
  resolveProjectStateRoot: async () => path.resolve(projectRoot),
  defaultLockTtlMs: 10000,
});

let acquiredLock = null;

try {
  const result = await service.acquireHardLock({
    owner: "worker-owner",
    agent: "worker-agent",
    task: "cross-process task",
    cwd: projectRoot,
    lockType: "write",
    paths: [requestedPath],
    ttlMs: 10000,
  });
  if (result.ok) acquiredLock = result.lock;
  process.send?.({ type: "acquired", result });
} catch (error) {
  process.send?.({ type: "error", error: error.message || String(error) });
  process.exitCode = 1;
}

process.on("message", async (message) => {
  if (message?.type !== "release") return;
  try {
    const result = acquiredLock
      ? await service.releaseHardLock(acquiredLock.id, acquiredLock.token, acquiredLock.paths, acquiredLock.cwd)
      : { ok: false, released: false };
    process.send?.({ type: "released", result });
    process.exit(0);
  } catch (error) {
    process.send?.({ type: "error", error: error.message || String(error) });
    process.exit(1);
  }
});
