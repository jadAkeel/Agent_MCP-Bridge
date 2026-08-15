import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createStateDatabase } from "../../src/v2/persistence/state-database.js";

const NOW = Date.parse("2026-08-15T16:00:00.000Z");
const CONFIG = Object.freeze({ queueLeaseMs: 60_000 });

function createService(overrides = {}) {
  return createStateDatabase({
    config: CONFIG,
    getStateDirectory: () => path.join(tmpdir(), "state-database-unused"),
    projectStateKey: () => "project-key",
    resolveProjectStateRoot: async (cwd) => path.resolve(cwd || process.cwd()),
    bridgeInstanceId: "state-database-test-instance",
    clockNow: () => NOW,
    getProcessId: () => 4242,
    ...overrides,
  });
}

const idle = createService({
  getStateDirectory: () => { throw new Error("must remain lazy"); },
  projectStateKey: () => { throw new Error("must remain lazy"); },
  resolveProjectStateRoot: async () => { throw new Error("must remain lazy"); },
  Database: class { constructor() { throw new Error("must remain lazy"); } },
});
assert.deepEqual(Object.keys(idle), [
  "stateDbPath",
  "lockTableHasCompositePrimaryKey",
  "ensureLockTableSchema",
  "ensureQueueLeaseSchema",
  "scrubLegacyLockSecrets",
  "openLockDb",
]);

let stateDirectory = path.join(tmpdir(), "state-database-a");
const pathService = createService({
  getStateDirectory: () => stateDirectory,
  projectStateKey: (root) => `key-${path.basename(root)}`,
});
const projectRoot = path.resolve(path.join(tmpdir(), "state-database-project"));
assert.equal(pathService.stateDbPath(), path.join(stateDirectory, "bridge-state.sqlite"));
assert.equal(pathService.stateDbPath(path.parse(projectRoot).root), path.join(stateDirectory, "bridge-state.sqlite"));
assert.equal(pathService.stateDbPath(projectRoot), path.join(stateDirectory, "projects", `key-${path.basename(projectRoot)}.sqlite`));
stateDirectory = path.join(tmpdir(), "state-database-b");
assert.equal(pathService.stateDbPath(projectRoot), path.join(stateDirectory, "projects", `key-${path.basename(projectRoot)}.sqlite`), "The state directory must be resolved dynamically per call.");

const legacyDb = new DatabaseSync(":memory:");
try {
  legacyDb.exec(`
    CREATE TABLE locks (
      normalized_path TEXT PRIMARY KEY,
      owner_agent TEXT NOT NULL,
      run_id TEXT NOT NULL,
      token TEXT NOT NULL,
      lock_mode TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      cwd TEXT,
      task TEXT
    );
    INSERT INTO locks VALUES ('src/a.js', 'builder', 'run-a', 'raw-token', 'write', 2000, 1000, 'C:/repo', 'raw-task');
  `);
  assert.equal(pathService.lockTableHasCompositePrimaryKey(legacyDb), false);
  pathService.ensureLockTableSchema(legacyDb);
  assert.equal(pathService.lockTableHasCompositePrimaryKey(legacyDb), true);
  assert.deepEqual({ ...legacyDb.prepare("SELECT normalized_path, acquisition_origin, run_id, token, task FROM locks").get() }, {
    normalized_path: "src/a.js",
    acquisition_origin: "legacy",
    run_id: "run-a",
    token: "raw-token",
    task: "raw-task",
  });
  pathService.ensureLockTableSchema(legacyDb);
  pathService.scrubLegacyLockSecrets(legacyDb);
  const scrubbed = legacyDb.prepare("SELECT token, task FROM locks").get();
  assert.equal(scrubbed.token, `sha256:${createHash("sha256").update("raw-token").digest("hex")}`);
  assert.equal(scrubbed.task, `sha256:${createHash("sha256").update("raw-task").digest("hex")}`);
  pathService.scrubLegacyLockSecrets(legacyDb);
  assert.deepEqual({ ...legacyDb.prepare("SELECT token, task FROM locks").get() }, { ...scrubbed }, "Secret scrubbing must be idempotent.");
} finally {
  legacyDb.close();
}

const leaseDb = new DatabaseSync(":memory:");
try {
  leaseDb.exec("CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY)");
  pathService.ensureQueueLeaseSchema(leaseDb);
  pathService.ensureQueueLeaseSchema(leaseDb);
  const columns = new Set(leaseDb.prepare("PRAGMA table_info(opencode_jobs)").all().map((column) => column.name));
  for (const column of [
    "owner_instance_id", "owner_process_id", "owner_generation", "updated_at", "heartbeat_at",
    "lease_expires_at", "cancellation_requested_at", "child_process_id", "child_process_started_at",
    "revision", "idempotency_key", "request_encrypted",
  ]) {
    assert.equal(columns.has(column), true, `Missing queue lease column ${column}.`);
  }
  assert.equal(leaseDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'opencode_jobs_idempotency_idx'").get()?.["1"], 1);
} finally {
  leaseDb.close();
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codex-state-database-"));
try {
  const openStateRoot = path.join(temporaryRoot, "state");
  const openProjectRoot = path.join(temporaryRoot, "project");
  const resolvedInputs = [];
  const afterOpenEvents = [];
  const service = createService({
    getStateDirectory: () => openStateRoot,
    resolveProjectStateRoot: async (cwd) => {
      resolvedInputs.push(cwd);
      return openProjectRoot;
    },
    afterOpen(db, dbPath) {
      const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
      const bridge = db.prepare("SELECT instance_id, process_id, heartbeat_at, lease_expires_at FROM bridge_instances").get();
      assert.equal(indexes.has("locks_expires_at_idx"), true);
      assert.equal(indexes.has("opencode_jobs_lease_idx"), true);
      assert.deepEqual({ ...bridge }, {
        instance_id: "state-database-test-instance",
        process_id: 4242,
        heartbeat_at: new Date(NOW).toISOString(),
        lease_expires_at: new Date(NOW + CONFIG.queueLeaseMs).toISOString(),
      });
      afterOpenEvents.push(dbPath);
    },
  });
  const db = await service.openLockDb("input-cwd");
  try {
    const expectedPath = path.join(openStateRoot, "projects", "project-key.sqlite");
    assert.deepEqual(resolvedInputs, ["input-cwd"]);
    assert.deepEqual(afterOpenEvents, [expectedPath], "afterOpen must run exactly once after indexes and bridge identity are established.");
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode.toLowerCase(), "wal");
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'opencode_pipelines'").get()?.["1"], 1);
    const pipelineColumns = new Set(db.prepare("PRAGMA table_info(opencode_pipelines)").all().map((column) => column.name));
    assert.equal(pipelineColumns.has("revision"), true);
    assert.equal(pipelineColumns.has("request_encrypted"), true);
  } finally {
    db.close();
  }

  let attempts = 0;
  const delays = [];
  class RetryDatabase {
    constructor() {
      attempts += 1;
      if (attempts < 3) throw new Error("SQLITE_BUSY injected constructor failure");
      return new DatabaseSync(":memory:");
    }
  }
  const retryService = createService({
    getStateDirectory: () => openStateRoot,
    resolveProjectStateRoot: async () => openProjectRoot,
    Database: RetryDatabase,
    mkdir: async () => {},
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const retryDb = await retryService.openLockDb("retry-input");
  try {
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [25, 50]);
  } finally {
    retryDb.close();
  }

  let callbackAttempts = 0;
  let callbackCloses = 0;
  const callbackDelays = [];
  class CallbackRetryDatabase {
    constructor() {
      return new DatabaseSync(":memory:");
    }
  }
  const callbackRetryService = createService({
    getStateDirectory: () => openStateRoot,
    resolveProjectStateRoot: async () => openProjectRoot,
    Database: CallbackRetryDatabase,
    mkdir: async () => {},
    closeDb(db) {
      callbackCloses += 1;
      db.close();
    },
    afterOpen() {
      callbackAttempts += 1;
      if (callbackAttempts < 3) throw new Error("database is locked in afterOpen");
    },
    sleep: async (delayMs) => { callbackDelays.push(delayMs); },
  });
  const callbackRetryDb = await callbackRetryService.openLockDb("callback-retry-input");
  try {
    assert.equal(callbackAttempts, 3);
    assert.equal(callbackCloses, 2, "Every failed afterOpen attempt must close its database before retrying.");
    assert.deepEqual(callbackDelays, [25, 50]);
  } finally {
    callbackRetryDb.close();
  }

  let nonBusyAttempts = 0;
  const nonBusyService = createService({
    getStateDirectory: () => openStateRoot,
    resolveProjectStateRoot: async () => openProjectRoot,
    Database: class {
      constructor() {
        nonBusyAttempts += 1;
        throw new Error("permission denied");
      }
    },
    mkdir: async () => {},
    sleep: async () => { throw new Error("must not retry"); },
  });
  await assert.rejects(nonBusyService.openLockDb("non-busy-input"), /permission denied/);
  assert.equal(nonBusyAttempts, 1);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}

console.log("V2 state database tests passed.");
