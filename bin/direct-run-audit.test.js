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
    capacityDb.prepare("INSERT INTO opencode_direct_runs (run_id, project_key, status, started_at, agent) VALUES (?, ?, 'started', ?, 'reviewer')")
      .run(id, root, "2000-01-01T00:00:00.000Z");
  }
  capacityDb.close();
  const overflow = await audit.run({ cwd: root, agent: "reviewer" }, async () => response());
  assert.equal(overflow._meta.directRunAudit.persisted, false);
  assert.equal((await audit.snapshot(root)).records.length, 2);
  assert.equal((await audit.snapshot(root)).records.every((record) => record.status === "started"), true);
});
