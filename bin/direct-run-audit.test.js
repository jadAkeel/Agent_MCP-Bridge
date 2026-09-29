import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDirectRunAudit, ensureDirectRunAuditSchema } from "./direct-run-audit.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-direct-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.sqlite");
  const openDb = async () => {
    const db = new DatabaseSync(dbPath);
    ensureDirectRunAuditSchema(db);
    return db;
  };
  const options = {
    openDb,
    closeDb: (db) => db.close(),
    resolveProjectRoot: async () => root,
    redact: (text) => text.replace(/sk-canary[a-z0-9]*/gi, "[REDACTED]"),
    ...overrides,
  };
  return { root, dbPath, openDb, options, audit: createDirectRunAudit(options) };
}

const response = (result = {}, extra = {}) => ({
  response: { content: [{ type: "text", text: "provider output sk-canaryresponse" }] },
  result,
  ...extra,
});

test("direct success, provider failure, pre-provider rejection and dry run survive reconnect without output", async (t) => {
  const { audit, options, root, dbPath, openDb } = await fixture(t);
  const job = { cwd: root, agent: "reviewer", task: "sk-canarytask private prompt" };
  const succeeded = await audit.run(job, async ({ onChildSpawn }) => {
    onChildSpawn();
    return response({ configuredProvider: "google", configuredModel: "test-model", runtimeObservedProvider: "google", runtimeObservedModel: "test-model", stdout: "sk-canarystdout", stderr: "sk-canarystderr" });
  });
  const failed = await audit.run(job, async ({ onChildSpawn }) => {
    onChildSpawn();
    return response({ errorType: "provider_auth_error" });
  });
  const rejected = await audit.run(job, async () => response({ errorType: "git_state_required" }));
  const dryRun = await audit.run({ ...job, dryRun: true }, async () => response());
  const snapshot = await createDirectRunAudit(options).snapshot(root);
  assert.equal(snapshot.coverage.available, true);
  assert.equal(snapshot.records.length, 4);
  const byId = new Map(snapshot.records.map((record) => [record.runId, record]));
  assert.equal(byId.get(succeeded._meta.directRunAudit.runId).configuredModel, "google/test-model");
  assert.equal(byId.get(succeeded._meta.directRunAudit.runId).modelEvidencePresent, true);
  assert.equal(byId.get(failed._meta.directRunAudit.runId).status, "failed");
  assert.equal(byId.get(rejected._meta.directRunAudit.runId).status, "rejected");
  assert.equal(byId.get(dryRun._meta.directRunAudit.runId).status, "dry_run");
  assert.equal(snapshot.records.every((item) => item.projectKey === root && item.durationMs >= 0), true);
  assert.equal(succeeded._meta.directRunAudit.persisted, true);
  assert.equal(succeeded.content[0].text, "provider output sk-canaryresponse");
  const db = await openDb();
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opencode_jobs'").get(), undefined);
  db.close();
  assert.equal((await readFile(dbPath)).includes(Buffer.from("sk-canary")), false);
});

test("metadata sanitization and thrown execution errors retain the original exception", async (t) => {
  const { audit, root, dbPath } = await fixture(t);
  const original = new Error("execution failed sk-canaryexception");
  original.code = "ORIGINAL_EXECUTION_ERROR";
  await assert.rejects(audit.run({ cwd: root, agent: "sk-canaryagent" }, async () => { throw original; }), (error) => {
    assert.equal(error, original);
    assert.equal(error.code, "ORIGINAL_EXECUTION_ERROR");
    assert.equal(error.directRunAudit.persisted, true);
    return true;
  });
  const { records } = await audit.snapshot(root);
  assert.equal(records[0].agent, "redacted");
  assert.equal(records[0].status, "rejected");
  assert.equal(records[0].errorType, "direct_run_exception");
  assert.equal((await readFile(dbPath)).includes(Buffer.from("sk-canary")), false);
});

test("audit failure is explicit and never replaces execution failure or success", async (t) => {
  const { root, options } = await fixture(t);
  const audit = createDirectRunAudit({ ...options, openDb: async () => { throw new Error("private storage failure sk-canarydb"); } });
  const result = await audit.run({ cwd: root, agent: "reviewer" }, async () => response({ errorType: "original_failure" }));
  assert.equal(result._meta.directRunAudit.errorType, "direct_run_audit_start_failed");
  assert.equal(result._meta.directRunAudit.persisted, false);
  assert.match(result.content.at(-1).text, /NOT persisted/);
  assert.doesNotMatch(JSON.stringify(result._meta), /sk-canary/);
  const snapshot = await audit.snapshot(root);
  assert.equal(snapshot.coverage.available, false);
  assert.equal(snapshot.coverage.errorType, "direct_run_audit_read_failed");
  const original = new Error("original run error");
  await assert.rejects(audit.run({ cwd: root }, async () => { throw original; }), (error) => error === original && /NOT persisted/.test(error.message));
});

test("failed finish keeps an honest unfinished start record", async (t) => {
  const { root, options, openDb } = await fixture(t);
  let writes = 0;
  const audit = createDirectRunAudit({ ...options, openDb: async () => {
    writes += 1;
    if (writes === 2) throw new Error("cannot finish audit");
    return openDb();
  } });
  const result = await audit.run({ cwd: root, agent: "reviewer" }, async () => response());
  assert.equal(result._meta.directRunAudit.errorType, "direct_run_audit_finish_failed");
  assert.equal(result._meta.directRunAudit.startedPersisted, true);
  assert.equal(result._meta.directRunAudit.persisted, false);
  const snapshot = await audit.snapshot(root);
  assert.equal(snapshot.records[0].status, "started");
  assert.equal(snapshot.records[0].finishedAt, null);
});

test("retention bounds terminal history but never removes unfinished records", async (t) => {
  const { root, audit, openDb } = await fixture(t, { maxRows: 2, retentionDays: 1 });
  for (let index = 0; index < 4; index += 1) {
    const result = await audit.run({ cwd: root, agent: "reviewer" }, async () => response());
    assert.equal(result._meta.directRunAudit.persisted, true);
  }
  assert.equal((await audit.snapshot(root)).records.length, 2);
  const db = await openDb();
  db.prepare("UPDATE opencode_direct_runs SET finished_at = ?").run("2000-01-01T00:00:00.000Z");
  db.close();
  assert.equal((await audit.snapshot(root)).records.length, 0);
  const capacityDb = await openDb();
  for (const id of ["unfinished-1", "unfinished-2"]) {
    // Owned by another, still running bridge process: never closed, never pruned.
    capacityDb.prepare("INSERT INTO opencode_direct_runs (run_id, project_key, status, started_at, agent, owner_instance_id, owner_process_id) VALUES (?, ?, 'started', ?, 'reviewer', 'other-bridge', ?)")
      .run(id, root, "2000-01-01T00:00:00.000Z", process.pid);
  }
  capacityDb.close();
  const overflow = await audit.run({ cwd: root, agent: "reviewer" }, async () => response());
  assert.equal(overflow._meta.directRunAudit.persisted, false);
  assert.equal((await audit.snapshot(root)).records.length, 2);
  assert.equal((await audit.snapshot(root)).records.every((record) => record.status === "started"), true);
});

test("an audit table from before the metric columns is migrated and parallel runs are found by id", async (t) => {
  const { audit, root, dbPath } = await fixture(t, {
    openDb: async () => {
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE IF NOT EXISTS opencode_direct_runs (
        run_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, status TEXT NOT NULL, error_type TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, agent TEXT NOT NULL,
        configured_model TEXT NOT NULL DEFAULT '', model_evidence_present INTEGER NOT NULL DEFAULT 0)`);
      ensureDirectRunAuditSchema(db);
      return db;
    },
  });
  const handle = await audit.start({ cwd: root, agent: "builder" }, { runId: "builder-1-abcd", kind: "parallel", jobId: "builder-1-abcd" });
  const finished = await audit.finish(handle, { execution: { result: {
    childStartedAtMs: 1000, childFinishedAtMs: 4000, providerConcurrencyWaitMs: 12, providerRetryWarningCount: 2,
    usage: { steps: 1, inputCount: 10, outputCount: 2, reasoningCount: 0, cacheReadCount: 0, cacheWriteCount: 0, cost: 0 },
  } } });
  assert.equal(finished.persisted, true);
  const record = await audit.get(root, "builder-1-abcd");
  assert.equal(record.kind, "parallel");
  assert.equal(record.status, "completed");
  assert.equal(record.agentRunMs, 3000);
  assert.equal(record.providerWaitMs, 12);
  assert.equal(record.inputCount, 10);
  assert.equal(record.providerRetryWarnings, 2);
  assert.equal(await audit.get(root, "missing"), null);
  const text = await readFile(dbPath).then((bytes) => bytes.toString("latin1"));
  assert.doesNotMatch(text, /sk-canary/);
});

test("B-029: start records whose bridge process is gone are closed as abandoned; live ones stay open", async (t) => {
  const deadPid = 2 ** 30 + 7;
  const { root, openDb, options } = await fixture(t, { instanceId: "this-bridge", processAlive: (pid) => pid !== deadPid });
  const audit = createDirectRunAudit(options);
  const db = await openDb();
  const insert = db.prepare("INSERT INTO opencode_direct_runs (run_id, project_key, status, started_at, agent, owner_instance_id, owner_process_id) VALUES (?, ?, 'started', ?, 'builder', ?, ?)");
  const recent = new Date().toISOString();
  insert.run("dead-owner", root, recent, "other-bridge", deadPid);
  insert.run("live-owner", root, "2000-01-01T00:00:00.000Z", "other-bridge", process.pid);
  insert.run("this-bridge-running", root, recent, "this-bridge", deadPid);
  insert.run("legacy-old", root, "2000-01-01T00:00:00.000Z", "", null);
  insert.run("legacy-recent", root, recent, "", null);
  db.close();
  const byId = new Map((await audit.snapshot(root)).records.map((record) => [record.runId, record]));
  assert.equal(byId.get("dead-owner").status, "abandoned");
  assert.equal(byId.get("dead-owner").errorType, "direct_run_owner_gone");
  assert.ok(byId.get("dead-owner").finishedAt);
  assert.equal(byId.get("live-owner").status, "started", "a live owner keeps its record open whatever its age");
  assert.equal(byId.get("this-bridge-running").status, "started", "this bridge never closes its own records");
  assert.equal(byId.get("legacy-old").status, "abandoned", "an owner-less record older than a day is closed");
  assert.equal(byId.get("legacy-recent").status, "started");
  // A new start records its owner.
  const handle = await audit.start({ cwd: root, agent: "reviewer" }, { runId: "owned-1" });
  assert.equal(handle.audit.startedPersisted, true);
  const check = await openDb();
  const row = check.prepare("SELECT owner_instance_id AS instance, owner_process_id AS pid FROM opencode_direct_runs WHERE run_id = ?").get("owned-1");
  check.close();
  assert.deepEqual({ ...row }, { instance: "this-bridge", pid: process.pid });
});
