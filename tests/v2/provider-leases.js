import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createProviderLeaseService } from "../../src/v2/persistence/provider-leases.js";
import { closeDb, ensureTableColumn } from "../../src/v2/persistence/sqlite-utils.js";

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "provider-lease-worker.js");
const DEFAULT_CONFIG = Object.freeze({
  providerConcurrencyLimit: 1,
  providerLeasePollMs: 10,
  providerLeaseMs: 10000,
  providerHeartbeatMs: 1000,
  providerConcurrencyKey: "test-provider",
});

function createService(stateDirectory, {
  bridgeInstanceId = "instance-a",
  config = DEFAULT_CONFIG,
  ...dependencies
} = {}) {
  return createProviderLeaseService({
    config,
    getStateDirectory: () => stateDirectory,
    bridgeInstanceId,
    ...dependencies,
  });
}

async function withTemporaryState(run) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "codex-provider-leases-"));
  try {
    await run(stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function normalizeSql(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function waitForChildMessage(child, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for provider lease worker. stderr: ${stderr}`)), timeoutMs);
    const onStderr = (chunk) => { stderr += String(chunk); };
    const onMessage = (message) => {
      if (predicate(message)) finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(`Provider lease worker exited before the expected message (code=${code}, signal=${signal}). stderr: ${stderr}`));
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stderr?.off("data", onStderr);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    child.stderr?.on("data", onStderr);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for provider lease worker to exit."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

let idleStateDirectoryReads = 0;
const idleService = createProviderLeaseService({
  config: DEFAULT_CONFIG,
  getStateDirectory: () => {
    idleStateDirectoryReads += 1;
    return "unused";
  },
  bridgeInstanceId: "idle-instance",
});
assert.equal(idleStateDirectoryReads, 0, "Constructing the service must not perform filesystem or database I/O.");
assert.deepEqual(Object.keys(idleService), [
  "acquireProviderLease",
  "startProviderLeaseHeartbeat",
  "releaseProviderLease",
  "providerCapacitySnapshot",
]);

await withTemporaryState(async (stateDirectory) => {
  const service = createService(stateDirectory);
  assert.equal((await service.providerCapacitySnapshot()).ok, true);
  const db = new DatabaseSync(path.join(stateDirectory, "provider-concurrency.sqlite"));
  try {
    assert.deepEqual(
      db.prepare("PRAGMA table_info(provider_leases)").all().map((column) => [column.name, column.type, column.notnull, column.pk]),
      [
        ["lease_id", "TEXT", 0, 1],
        ["provider_key", "TEXT", 1, 0],
        ["owner_instance_id", "TEXT", 1, 0],
        ["owner_pid", "INTEGER", 1, 0],
        ["created_at", "INTEGER", 1, 0],
        ["heartbeat_at", "INTEGER", 0, 0],
        ["expires_at", "INTEGER", 1, 0],
      ]
    );
    assert.deepEqual(
      db.prepare("PRAGMA table_info(provider_capacities)").all().map((column) => [column.name, column.type, column.notnull, column.pk]),
      [
        ["provider_key", "TEXT", 0, 1],
        ["capacity", "INTEGER", 1, 0],
        ["updated_at", "INTEGER", 1, 0],
      ]
    );
    assert.equal(
      normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get("provider_leases")?.sql),
      "CREATE TABLE provider_leases ( lease_id TEXT PRIMARY KEY, provider_key TEXT NOT NULL, owner_instance_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, created_at INTEGER NOT NULL, heartbeat_at INTEGER, expires_at INTEGER NOT NULL )"
    );
    assert.equal(
      normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get("provider_capacities")?.sql),
      "CREATE TABLE provider_capacities ( provider_key TEXT PRIMARY KEY, capacity INTEGER NOT NULL, updated_at INTEGER NOT NULL )"
    );
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get("provider_leases_key_expiry_idx");
    assert.equal(
      normalizeSql(index?.sql),
      "CREATE INDEX provider_leases_key_expiry_idx ON provider_leases (provider_key, expires_at)"
    );
    assert.deepEqual(
      db.prepare("PRAGMA index_info(provider_leases_key_expiry_idx)").all().map((column) => column.name),
      ["provider_key", "expires_at"]
    );
    assert.equal(String(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase(), "wal");
    assert.equal(Number(db.prepare("PRAGMA synchronous").get()?.synchronous), 2);
  } finally {
    closeDb(db);
  }
});

await withTemporaryState(async (stateDirectory) => {
  await mkdir(stateDirectory, { recursive: true });
  const dbPath = path.join(stateDirectory, "provider-concurrency.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE provider_leases (
      lease_id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL,
      owner_instance_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  closeDb(legacyDb);

  assert.equal((await createService(stateDirectory).providerCapacitySnapshot()).ok, true);
  const migratedDb = new DatabaseSync(dbPath);
  try {
    const heartbeatColumn = migratedDb.prepare("PRAGMA table_info(provider_leases)").all().find((column) => column.name === "heartbeat_at");
    assert.deepEqual(
      { name: heartbeatColumn?.name, type: heartbeatColumn?.type, notnull: heartbeatColumn?.notnull },
      { name: "heartbeat_at", type: "INTEGER", notnull: 0 }
    );
    ensureTableColumn(migratedDb, "provider_leases", "heartbeat_at", "INTEGER");
    assert.equal(migratedDb.prepare("PRAGMA table_info(provider_leases)").all().filter((column) => column.name === "heartbeat_at").length, 1);
  } finally {
    closeDb(migratedDb);
  }
});

await withTemporaryState(async (stateDirectory) => {
  const first = createService(stateDirectory, { bridgeInstanceId: "instance-one" });
  const acquired = await first.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 });
  assert.equal(acquired.ok, true);
  assert.match(acquired.lease.id, /^instance-one-[a-f0-9]{12}$/);
  assert.equal(acquired.lease.providerKey, DEFAULT_CONFIG.providerConcurrencyKey);
  assert.equal(acquired.waitedMs >= 0, true);

  const changedConfig = Object.freeze({ ...DEFAULT_CONFIG, providerConcurrencyLimit: 2 });
  const second = createService(stateDirectory, { bridgeInstanceId: "instance-two", config: changedConfig });
  assert.deepEqual(
    await second.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 }),
    {
      ok: false,
      errorType: "provider_concurrency_config_mismatch",
      error: `Provider concurrency key ${DEFAULT_CONFIG.providerConcurrencyKey} is active with capacity 1, but this process requested 2.`,
    }
  );

  await second.releaseProviderLease(acquired.lease);
  const stillOwned = await first.providerCapacitySnapshot();
  assert.equal(stillOwned.ok, true);
  assert.equal(stillOwned.leases.length, 1, "A different bridge instance must not release the lease.");
  assert.equal(stillOwned.leases[0].ownerInstanceId, "instance-one");

  await first.releaseProviderLease(acquired.lease);
  const reacquired = await second.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 });
  assert.equal(reacquired.ok, true);
  const capacityDb = new DatabaseSync(path.join(stateDirectory, "provider-concurrency.sqlite"));
  try {
    assert.equal(
      capacityDb.prepare("SELECT capacity FROM provider_capacities WHERE provider_key = ?").get(DEFAULT_CONFIG.providerConcurrencyKey)?.capacity,
      2
    );
  } finally {
    closeDb(capacityDb);
  }
  await second.releaseProviderLease(reacquired.lease);
});

await withTemporaryState(async (stateDirectory) => {
  const aborted = new AbortController();
  aborted.abort();
  const service = createService(stateDirectory);
  assert.deepEqual(
    await service.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000, signal: aborted.signal }),
    { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." }
  );

  const deadlineClockValues = [0, 0, 2];
  const deadlineService = createService(stateDirectory, {
    clockNow: () => deadlineClockValues.shift() ?? 2,
  });
  assert.deepEqual(
    await deadlineService.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1 }),
    {
      ok: false,
      errorType: "provider_concurrency_timeout",
      error: "Provider concurrency database initialization exceeded the caller deadline.",
    }
  );

  class FailingDatabase {
    constructor() {
      throw new Error("Authorization: Bearer provider-secret-token");
    }
  }
  const failing = createService(stateDirectory, { Database: FailingDatabase });
  const failedAcquire = await failing.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 });
  assert.equal(failedAcquire.ok, false);
  assert.equal(failedAcquire.errorType, "provider_concurrency_failed");
  assert.doesNotMatch(failedAcquire.error, /provider-secret-token/);
  assert.match(failedAcquire.error, /\[redacted\]/);
  const failedSnapshot = await failing.providerCapacitySnapshot();
  assert.equal(failedSnapshot.ok, false);
  assert.doesNotMatch(failedSnapshot.error, /provider-secret-token/);
  assert.match(failedSnapshot.error, /\[redacted\]/);
});

await withTemporaryState(async (stateDirectory) => {
  let currentTime = 1000;
  let heartbeatCallback = null;
  let configuredInterval = null;
  let unrefCalled = false;
  let clearedTimer = null;
  const events = [];
  const timer = { unref: () => { unrefCalled = true; } };
  const service = createService(stateDirectory, {
    clockNow: () => currentTime,
    randomBytes: () => Buffer.from("010203040506", "hex"),
    setIntervalFn: (callback, intervalMs) => {
      heartbeatCallback = callback;
      configuredInterval = intervalMs;
      return timer;
    },
    clearIntervalFn: (value) => { clearedTimer = value; },
    logEvent: (level, event, data) => events.push({ level, event, data }),
  });
  const acquired = await service.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.lease.id, "instance-a-010203040506");
  const stopHeartbeat = service.startProviderLeaseHeartbeat(acquired.lease);
  assert.equal(configuredInterval, 1000);
  assert.equal(unrefCalled, true);

  currentTime = 2000;
  await heartbeatCallback();
  assert.equal(acquired.lease.expiresAt, 12000);
  const heartbeatDb = new DatabaseSync(path.join(stateDirectory, "provider-concurrency.sqlite"));
  try {
    const row = heartbeatDb.prepare("SELECT heartbeat_at, expires_at FROM provider_leases WHERE lease_id = ?").get(acquired.lease.id);
    assert.deepEqual({ heartbeatAt: row?.heartbeat_at, expiresAt: row?.expires_at }, { heartbeatAt: 2000, expiresAt: 12000 });
    heartbeatDb.prepare("UPDATE provider_leases SET owner_instance_id = ? WHERE lease_id = ?").run("instance-other", acquired.lease.id);
  } finally {
    closeDb(heartbeatDb);
  }

  currentTime = 3000;
  await heartbeatCallback();
  assert.equal(acquired.lease.expiresAt, 12000, "Lost ownership must not update the in-memory lease expiry.");
  assert.deepEqual(events, [{
    level: "warn",
    event: "provider.lease_heartbeat_lost",
    data: { leaseId: acquired.lease.id },
  }]);
  stopHeartbeat();
  assert.equal(clearedTimer, timer);

  const cleanupDb = new DatabaseSync(path.join(stateDirectory, "provider-concurrency.sqlite"));
  try {
    cleanupDb.prepare("DELETE FROM provider_leases WHERE lease_id = ?").run(acquired.lease.id);
  } finally {
    closeDb(cleanupDb);
  }
});

await withTemporaryState(async (stateDirectory) => {
  const firstWorker = fork(workerPath, [stateDirectory, "worker-one", DEFAULT_CONFIG.providerConcurrencyKey, "2000"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let firstReleased = false;
  try {
    const firstMessage = await waitForChildMessage(firstWorker, (message) => message?.type === "acquired");
    assert.equal(firstMessage.result.ok, true);

    const blockedWorker = fork(workerPath, [stateDirectory, "worker-two", DEFAULT_CONFIG.providerConcurrencyKey, "150"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const blockedMessage = await waitForChildMessage(blockedWorker, (message) => message?.type === "acquired");
    assert.deepEqual(blockedMessage.result, {
      ok: false,
      errorType: "provider_concurrency_timeout",
      error: "Timed out waiting for the operator-configured provider/account concurrency limit.",
    });
    await waitForChildExit(blockedWorker);

    firstWorker.send({ type: "release" });
    await waitForChildMessage(firstWorker, (message) => message?.type === "released");
    firstReleased = true;
    await waitForChildExit(firstWorker);

    const parent = createService(stateDirectory, { bridgeInstanceId: "parent-instance" });
    const afterRelease = await parent.acquireProviderLease({ providerKey: DEFAULT_CONFIG.providerConcurrencyKey, timeoutMs: 1000 });
    assert.equal(afterRelease.ok, true, "Capacity must become available after the owning process releases its lease.");
    await parent.releaseProviderLease(afterRelease.lease);
  } finally {
    if (!firstReleased && firstWorker.connected) firstWorker.send({ type: "release" });
    if (firstWorker.exitCode === null && firstWorker.signalCode === null) firstWorker.kill();
  }
});

console.log("V2 provider lease persistence tests passed.");
