import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createHardLockService } from "../../src/v2/persistence/hard-locks.js";
import { closeDb } from "../../src/v2/persistence/sqlite-utils.js";

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "hard-lock-worker.js");
const DEFAULT_LOCK_TTL_MS = 1000 * 60 * 30;

function initializeDb(db) {
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

function createOpener(stateDirectory, observedCwds = []) {
  const dbPath = path.join(stateDirectory, "hard-locks.sqlite");
  mkdirSync(stateDirectory, { recursive: true });
  return {
    dbPath,
    openLockDb: async (cwd = "") => {
      observedCwds.push(cwd);
      return initializeDb(new DatabaseSync(dbPath));
    },
  };
}

function createService(stateDirectory, projectRoot, dependencies = {}) {
  const observedCwds = dependencies.observedCwds || [];
  const { dbPath, openLockDb } = createOpener(stateDirectory, observedCwds);
  return {
    dbPath,
    observedCwds,
    service: createHardLockService({
      openLockDb,
      resolveProjectStateRoot: async (cwd) => path.resolve(cwd || projectRoot),
      defaultLockTtlMs: DEFAULT_LOCK_TTL_MS,
      ...dependencies,
      observedCwds: undefined,
    }),
  };
}

async function withTemporaryProject(run) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codex-hard-locks-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const stateDirectory = path.join(temporaryRoot, "state");
  mkdirSync(path.join(projectRoot, "src", "nested"), { recursive: true });
  mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  try {
    await run({ temporaryRoot, projectRoot, stateDirectory });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

function waitForChildMessage(child, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for hard-lock worker. stderr: ${stderr}`)), timeoutMs);
    const onStderr = (chunk) => { stderr += String(chunk); };
    const onMessage = (message) => {
      if (message?.type === "error") finish(new Error(message.error));
      else if (predicate(message)) finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(`Hard-lock worker exited early (code=${code}, signal=${signal}). stderr: ${stderr}`));
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
      reject(new Error("Timed out waiting for hard-lock worker to exit."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", reject);
  });
}

let idleOpenCalls = 0;
let idleRootCalls = 0;
const idleService = createHardLockService({
  openLockDb: async () => {
    idleOpenCalls += 1;
    throw new Error("must not open");
  },
  resolveProjectStateRoot: async () => {
    idleRootCalls += 1;
    throw new Error("must not resolve");
  },
});
assert.equal(idleOpenCalls, 0, "Constructing the service must not open SQLite state.");
assert.equal(idleRootCalls, 0, "Constructing the service must not resolve a project root.");
assert.deepEqual(Object.keys(idleService), [
  "recordChangedFiles",
  "conflictsWithActiveLock",
  "cleanupExpiredLocks",
  "listLocks",
  "acquireHardLock",
  "releaseHardLock",
  "startHardLockHeartbeat",
]);

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  const { service } = createService(stateDirectory, projectRoot);
  const first = await service.acquireHardLock({
    owner: "owner one",
    agent: "agent one",
    origin: "manual",
    task: "do not persist this raw task",
    cwd: projectRoot,
    lockType: "write",
    paths: ["src/shared.js"],
  });
  assert.equal(first.ok, true);
  assert.equal(first.lock.origin, "manual");
  assert.match(first.lock.id, /^owner-one-agent-one-\d+-[a-z0-9]{1,6}$/);
  assert.match(first.lock.token, /^[a-f0-9]{64}$/);
  assert.equal(first.lock.taskSha256, createHash("sha256").update("do not persist this raw task").digest("hex"));
  assert.equal(first.lock.pid, process.pid);

  const overlapping = await service.acquireHardLock({
    cwd: projectRoot,
    lockType: "write",
    paths: ["src/shared.js/nested"],
  });
  assert.equal(overlapping.ok, false);
  assert.equal(overlapping.error, "Write lock conflict on: src/shared.js/nested");
  assert.equal(overlapping.conflict.lockId, first.lock.id);
  assert.deepEqual(overlapping.conflict.overlap, ["src/shared.js/nested", "src/shared.js"]);

  const disjoint = await service.acquireHardLock({
    cwd: projectRoot,
    lockType: "write",
    paths: ["docs/readme.md"],
  });
  assert.equal(disjoint.ok, true);
  assert.equal((await service.listLocks(projectRoot)).length, 2);

  const db = new DatabaseSync(path.join(stateDirectory, "hard-locks.sqlite"));
  try {
    const persisted = db.prepare("SELECT token, task, acquisition_origin FROM locks WHERE run_id = ?").get(first.lock.id);
    assert.equal(persisted.token, `sha256:${createHash("sha256").update(first.lock.token).digest("hex")}`);
    assert.equal(persisted.task, `sha256:${first.lock.taskSha256}`);
    assert.equal(persisted.acquisition_origin, "manual");
    assert.doesNotMatch(JSON.stringify(persisted), /do not persist this raw task/);
    assert.doesNotMatch(JSON.stringify(await service.listLocks(projectRoot)), new RegExp(first.lock.token));
  } finally {
    closeDb(db);
  }

  await service.releaseHardLock(first.lock.id, first.lock.token, first.lock.paths, projectRoot);
  await service.releaseHardLock(disjoint.lock.id, disjoint.lock.token, disjoint.lock.paths, projectRoot);
});

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  const { service } = createService(stateDirectory, projectRoot);
  const readerOne = await service.acquireHardLock({ cwd: projectRoot, lockType: "read", paths: ["src"] });
  const readerTwo = await service.acquireHardLock({ cwd: projectRoot, lockType: "read", paths: ["src/nested"] });
  assert.equal(readerOne.ok, true);
  assert.equal(readerTwo.ok, true, "Overlapping read locks must coexist.");
  const blockedWriter = await service.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["src/nested/file.js"] });
  assert.equal(blockedWriter.ok, false);
  assert.equal(blockedWriter.conflict.lockType, "read");
  await service.releaseHardLock(readerOne.lock.id, readerOne.lock.token, readerOne.lock.paths, projectRoot);
  await service.releaseHardLock(readerTwo.lock.id, readerTwo.lock.token, readerTwo.lock.paths, projectRoot);

  const writer = await service.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["src/a.js"] });
  assert.equal(writer.ok, true);
  const serialAfterWriter = await service.acquireHardLock({ cwd: projectRoot, lockType: "serial-integration", paths: ["docs/b.md"] });
  assert.equal(serialAfterWriter.ok, false, "Serial integration must conflict with a disjoint writer.");
  assert.deepEqual(serialAfterWriter.conflict.overlap, ["docs/b.md", "src/a.js"]);
  await service.releaseHardLock(writer.lock.id, writer.lock.token, writer.lock.paths, projectRoot);

  const serial = await service.acquireHardLock({ cwd: projectRoot, lockType: "serial_integration", paths: ["docs/b.md"] });
  assert.equal(serial.ok, true);
  const writerAfterSerial = await service.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["src/a.js"] });
  assert.equal(writerAfterSerial.ok, false, "A writer must conflict with an existing disjoint serial integration lock.");
  assert.deepEqual(writerAfterSerial.conflict.overlap, ["src/a.js", "docs/b.md"]);
  await service.releaseHardLock(serial.lock.id, serial.lock.token, serial.lock.paths, projectRoot);
});

await withTemporaryProject(async ({ projectRoot, stateDirectory, temporaryRoot }) => {
  const { service } = createService(stateDirectory, projectRoot);
  const relative = await service.acquireHardLock({ cwd: projectRoot, paths: ["src\\nested\\file.js", "src/nested/file.js/"] });
  assert.equal(relative.ok, true);
  assert.deepEqual(relative.lock.paths, ["src/nested/file.js"]);

  const absolute = path.join(projectRoot, "src", "nested", "file.js");
  const absoluteConflict = await service.acquireHardLock({ cwd: projectRoot, paths: [absolute] });
  assert.equal(absoluteConflict.ok, false);
  assert.equal(absoluteConflict.error, "Write lock conflict on: src/nested/file.js");

  if (process.platform === "win32") {
    const caseConflict = await service.acquireHardLock({ cwd: projectRoot, paths: ["SRC/NESTED/FILE.JS"] });
    assert.equal(caseConflict.ok, false, "Windows lock conflicts must be case-insensitive.");
  }
  await service.releaseHardLock(relative.lock.id, relative.lock.token, relative.lock.paths, projectRoot);

  assert.deepEqual(await service.acquireHardLock({ cwd: projectRoot, lockType: "exclusive", paths: ["src/a.js"] }), {
    ok: false,
    error: "Invalid lockType \"exclusive\". Use read, write, or serial_integration.",
  });
  assert.deepEqual(await service.acquireHardLock({ cwd: projectRoot, paths: [] }), {
    ok: false,
    error: "Write lock rejected: paths are required.",
  });
  assert.match((await service.acquireHardLock({ cwd: projectRoot, paths: ["../outside"] })).error, /includes parent traversal/);
  assert.match((await service.acquireHardLock({ cwd: projectRoot, paths: [projectRoot] })).error, /resolves outside the allowed root/);
  assert.match((await service.acquireHardLock({ cwd: projectRoot, paths: [temporaryRoot] })).error, /resolves outside the allowed root/);
  assert.deepEqual(await service.acquireHardLock({ cwd: projectRoot, paths: ["src/*.js"] }), {
    ok: false,
    error: "Write lock rejected: wildcard or ambiguous paths are not allowed.",
  });
});

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  const { service, dbPath } = createService(stateDirectory, projectRoot);
  assert.deepEqual(await service.releaseHardLock("", "token", [], projectRoot), {
    ok: false,
    released: false,
    error: "lockId is required.",
  });
  assert.deepEqual(await service.releaseHardLock("lock", "", [], projectRoot), {
    ok: false,
    released: false,
    error: "Lock release token is required.",
  });

  const acquired = await service.acquireHardLock({ cwd: projectRoot, paths: ["src/a.js", "docs/b.md"] });
  assert.equal(acquired.ok, true);
  assert.deepEqual(await service.releaseHardLock(acquired.lock.id, "wrong-token", acquired.lock.paths, projectRoot), {
    ok: false,
    released: false,
    error: "No active lock matched that run_id and token.",
  });
  const partial = await service.releaseHardLock(acquired.lock.id, acquired.lock.token, ["src/a.js"], projectRoot);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.activeLocks[0].paths, ["docs/b.md"]);
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(acquired.lock.id)?.status, "released", "Partial release preserves the legacy run-status quirk.");
    assert.deepEqual(
      db.prepare("SELECT normalized_path FROM locks WHERE run_id = ? ORDER BY normalized_path").all(acquired.lock.id).map((row) => ({ ...row })),
      [{ normalized_path: "docs/b.md" }]
    );
  } finally {
    closeDb(db);
  }
  assert.equal((await service.releaseHardLock(acquired.lock.id, acquired.lock.token, ["docs/b.md"], projectRoot)).released, true);
});

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  let now = 1000;
  const { service, dbPath } = createService(stateDirectory, projectRoot, {
    clockNow: () => now,
    random: () => 0.5,
    randomBytes: () => Buffer.alloc(32, 7),
    getProcessId: () => 4242,
  });
  const acquired = await service.acquireHardLock({
    owner: "owner!",
    agent: "agent?",
    task: "task secret",
    cwd: projectRoot,
    paths: ["src/a.js"],
    ttlMs: 1,
  });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.lock.id, "owner-agent-1000-i");
  assert.equal(acquired.lock.token, Buffer.alloc(32, 7).toString("hex"));
  assert.equal(acquired.lock.pid, 4242);
  assert.equal(acquired.lock.expiresAt, 2000, "The one-second minimum TTL must be preserved.");
  now = 2000;
  assert.deepEqual(await service.listLocks(projectRoot), []);
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM locks").get().count, 0);
    assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(acquired.lock.id)?.status, "running");
  } finally {
    closeDb(db);
  }

  now = 3000;
  const expiring = await service.acquireHardLock({ cwd: projectRoot, paths: ["docs/a.md"], ttlMs: 1000 });
  assert.equal(expiring.ok, true);
  now = 4000;
  await service.cleanupExpiredLocks(projectRoot);
  assert.deepEqual(await service.listLocks(projectRoot), []);
});

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  let now = 1000;
  let heartbeatCallback = null;
  let configuredInterval = 0;
  let unrefCalled = false;
  let clearedTimer = null;
  const timer = { unref: () => { unrefCalled = true; } };
  const events = [];
  const { service, dbPath } = createService(stateDirectory, projectRoot, {
    clockNow: () => now,
    random: () => 0.75,
    randomBytes: () => Buffer.alloc(32, 9),
    setIntervalFn: (callback, intervalMs) => {
      heartbeatCallback = callback;
      configuredInterval = intervalMs;
      return timer;
    },
    clearIntervalFn: (value) => { clearedTimer = value; },
    logEvent: (level, event, data) => events.push({ level, event, data }),
  });
  const acquired = await service.acquireHardLock({ cwd: projectRoot, paths: ["src/a.js"], ttlMs: 9000 });
  assert.equal(acquired.ok, true);
  const stopHeartbeat = service.startHardLockHeartbeat(acquired.lock, 9000);
  assert.equal(configuredInterval, 3000);
  assert.equal(unrefCalled, true);

  now = 5000;
  await heartbeatCallback();
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE run_id = ?").get(acquired.lock.id)?.expires_at, 14000);
    db.prepare("DELETE FROM locks WHERE run_id = ?").run(acquired.lock.id);
  } finally {
    closeDb(db);
  }
  now = 6000;
  await heartbeatCallback();
  assert.deepEqual(events, [{ level: "warn", event: "lock.heartbeat_lost", data: { lockId: acquired.lock.id } }]);
  stopHeartbeat();
  assert.equal(clearedTimer, timer);

  assert.equal(typeof service.startHardLockHeartbeat({}, 9000), "function");
});

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  const { service, dbPath } = createService(stateDirectory, projectRoot);
  await service.recordChangedFiles("run-a", projectRoot, ["src\\a.js", "src/a.js", "docs/b.md"], ["docs\\b.md"]);
  const db = new DatabaseSync(dbPath);
  try {
    assert.deepEqual(db.prepare("SELECT run_id, path, allowed FROM changed_files ORDER BY path").all().map((row) => ({ ...row })), [
      { run_id: "run-a", path: "docs/b.md", allowed: 0 },
      { run_id: "run-a", path: "src/a.js", allowed: 1 },
    ]);
    db.exec(`
      CREATE TRIGGER fail_changed_file_insert
      BEFORE INSERT ON changed_files
      WHEN NEW.path = 'src/bad.js'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);
  } finally {
    closeDb(db);
  }

  await assert.rejects(
    service.recordChangedFiles("run-b", projectRoot, ["src/good.js", "src/bad.js"]),
    /forced audit failure/
  );
  const auditDb = new DatabaseSync(dbPath);
  try {
    assert.equal(auditDb.prepare("SELECT COUNT(*) AS count FROM changed_files WHERE run_id = ?").get("run-b").count, 0, "Changed-file persistence must roll back atomically.");
  } finally {
    closeDb(auditDb);
  }
});

{
  const sentinelRootError = new Error("root resolution sentinel");
  const sentinelOpenError = new Error("database opener sentinel");
  const rootFailure = createHardLockService({
    resolveProjectStateRoot: async () => { throw sentinelRootError; },
    openLockDb: async () => { throw new Error("must not open"); },
  });
  await assert.rejects(
    rootFailure.acquireHardLock({ cwd: "root-input", paths: ["src/a.js"] }),
    (error) => error === sentinelRootError
  );

  const openedCwds = [];
  const existingResolvedRoot = path.resolve(process.cwd());
  const openFailure = createHardLockService({
    resolveProjectStateRoot: async (cwd) => {
      assert.equal(cwd, "acquire-input");
      return existingResolvedRoot;
    },
    openLockDb: async (cwd) => {
      openedCwds.push(cwd);
      throw sentinelOpenError;
    },
  });
  await assert.rejects(openFailure.acquireHardLock({ cwd: "acquire-input", paths: ["src/a.js"] }), (error) => error === sentinelOpenError);
  await assert.rejects(openFailure.releaseHardLock("id", "token", [], "release-input"), (error) => error === sentinelOpenError);
  await assert.rejects(openFailure.listLocks("list-input"), (error) => error === sentinelOpenError);
  await assert.rejects(openFailure.cleanupExpiredLocks("cleanup-input"), (error) => error === sentinelOpenError);
  await assert.rejects(openFailure.recordChangedFiles("run", "audit-input", ["src/a.js"]), (error) => error === sentinelOpenError);
  const beforeNoRun = openedCwds.length;
  await openFailure.recordChangedFiles("", "ignored", ["src/a.js"]);
  assert.equal(openedCwds.length, beforeNoRun, "An empty run id must not open the database.");
  assert.deepEqual(openedCwds, [existingResolvedRoot, "release-input", "list-input", "cleanup-input", "audit-input"]);

  let heartbeatCallback = null;
  const heartbeatEvents = [];
  const heartbeatFailure = createHardLockService({
    resolveProjectStateRoot: async () => "unused",
    openLockDb: async () => { throw sentinelOpenError; },
    setIntervalFn: (callback) => {
      heartbeatCallback = callback;
      return { unref() {} };
    },
    logEvent: (level, event, data) => heartbeatEvents.push({ level, event, data }),
  });
  heartbeatFailure.startHardLockHeartbeat({ id: "lock-a", token: "token-a", cwd: "heartbeat-input" }, 3000);
  await heartbeatCallback();
  assert.deepEqual(heartbeatEvents, [{
    level: "warn",
    event: "lock.heartbeat_failed",
    data: { lockId: "lock-a", error: "database opener sentinel" },
  }]);
}

await withTemporaryProject(async ({ projectRoot, stateDirectory }) => {
  const parent = createService(stateDirectory, projectRoot).service;
  assert.deepEqual(await parent.listLocks(projectRoot), []);
  const worker = fork(workerPath, [stateDirectory, projectRoot, "src/shared.js"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let released = false;
  try {
    const acquiredMessage = await waitForChildMessage(worker, (message) => message?.type === "acquired");
    assert.equal(acquiredMessage.result.ok, true);
    const samePath = await parent.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["src/shared.js"] });
    assert.equal(samePath.ok, false, "A writer in another process must block the same path.");
    assert.equal(samePath.conflict.agent, "worker-agent");

    const disjointPath = await parent.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["docs/disjoint.md"] });
    assert.equal(disjointPath.ok, true, "A disjoint writer must remain available across processes.");
    await parent.releaseHardLock(disjointPath.lock.id, disjointPath.lock.token, disjointPath.lock.paths, projectRoot);

    worker.send({ type: "release" });
    const releaseMessage = await waitForChildMessage(worker, (message) => message?.type === "released");
    assert.equal(releaseMessage.result.released, true);
    released = true;
    await waitForChildExit(worker);

    const afterRelease = await parent.acquireHardLock({ cwd: projectRoot, lockType: "write", paths: ["src/shared.js"] });
    assert.equal(afterRelease.ok, true);
    await parent.releaseHardLock(afterRelease.lock.id, afterRelease.lock.token, afterRelease.lock.paths, projectRoot);
  } finally {
    if (!released && worker.connected) worker.send({ type: "release" });
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
  }
});

console.log("V2 hard-lock persistence tests passed.");
