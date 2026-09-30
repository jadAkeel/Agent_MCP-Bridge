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

// L-025: the run's result text is kept sealed (never plaintext), redacted and capped.
const sealed = {
  sealText: async (text, runId) => `sealed:${runId}:${Buffer.from(text, "utf8").toString("base64")}`,
  openText: async (envelope, runId) => {
    const prefix = `sealed:${runId}:`;
    if (!envelope.startsWith(prefix)) throw new Error("wrong run id");
    return Buffer.from(envelope.slice(prefix.length), "base64").toString("utf8");
  },
};

test("L-025: a run's result text is stored sealed and redacted, and read back by run id", async (t) => {
  const { audit, root, dbPath } = await fixture(t, sealed);
  const job = { cwd: root, agent: "reviewer" };
  const succeeded = await audit.run(job, async () => ({
    response: { content: [{ type: "text", text: "fallback text that must not win" }] },
    result: {},
    resultRecord: { text: "REPORT with sk-canaryreport and a tail", detailText: "PATCH sk-canarypatch", chars: 4321, reportTruncated: false },
  }));
  const runId = succeeded._meta.directRunAudit.runId;
  assert.equal(succeeded._meta.directRunAudit.persisted, true);
  const record = await audit.get(root, runId, { includeResult: true });
  assert.deepEqual(record.result, {
    text: "REPORT with [REDACTED] and a tail",
    detailText: "PATCH [REDACTED]",
    chars: 4321,
    reportTruncated: false,
    detailTruncated: false,
  });
  // Without includeResult neither the text nor its envelope is returned; a snapshot never has them.
  assert.equal((await audit.get(root, runId)).result, undefined);
  assert.equal(JSON.stringify(await audit.snapshot(root)).includes("REPORT"), false);
  const bytes = (await readFile(dbPath)).toString("latin1");
  assert.equal(bytes.includes("REPORT"), false, "the report is not in the database in plaintext");
  assert.equal(bytes.includes("sk-canary"), false);

  // A run that names no record keeps its response text, which is what a rejection has.
  const rejected = await audit.run(job, async () => ({ response: { content: [{ type: "text", text: "Execution rejected: no git" }] }, result: { errorType: "git_state_required" } }));
  const kept = await audit.get(root, rejected._meta.directRunAudit.runId, { includeResult: true });
  assert.equal(kept.status, "rejected");
  assert.equal(kept.result.text, "Execution rejected: no git");
  assert.equal(kept.result.detailText, "");
});

test("L-025: the stored result is capped, the default text first and the detail with what is left", async (t) => {
  const { audit, root } = await fixture(t, { ...sealed, maxResultChars: 400 });
  const store = async (stored) => {
    const handle = await audit.start({ cwd: root, agent: "builder" }, { runId: `capped-${Math.random().toString(36).slice(2, 8)}` });
    await audit.finish(handle, { execution: { result: {} }, stored });
    return (await audit.get(root, handle.record.runId, { includeResult: true })).result;
  };
  const both = await store({ text: "T".repeat(100), detailText: "D".repeat(1000), chars: 1100 });
  assert.equal(both.text.length, 100);
  assert.ok(both.detailText.length <= 300 && both.detailText.length >= 200 && both.detailText.startsWith("DDDD"), `detail ${both.detailText.length}`);
  assert.match(both.detailText, /characters cut at the end/);
  assert.equal(both.detailTruncated, true);
  assert.equal(both.reportTruncated, false, "cutting the detail does not make the report truncated");
  assert.equal(both.chars, 1100);

  const long = await store({ text: "R".repeat(900), detailText: "patch" });
  assert.ok(long.text.length <= 400, `text ${long.text.length}`);
  assert.ok(long.text.startsWith("RRRR") && /\[\d+ of 900 characters cut at the end/.test(long.text), "the text is cut at its end and says so");
  assert.equal(long.reportTruncated, true);
  assert.equal(long.detailText, "", "no room is left for the detail");
  assert.equal(long.detailTruncated, true);
  assert.equal(long.chars, 905);

  // The runner may already have flagged the report as cut.
  assert.equal((await store({ text: "short", reportTruncated: true })).reportTruncated, true);
});

test("L-025: without a seal function nothing is stored, and a failing seal or open never fails the audit", async (t) => {
  const plain = await fixture(t);
  const ran = await plain.audit.run({ cwd: plain.root, agent: "reviewer" }, async () => ({ response: { content: [{ type: "text", text: "output" }] }, result: {} }));
  assert.equal(ran._meta.directRunAudit.persisted, true);
  assert.equal((await plain.audit.get(plain.root, ran._meta.directRunAudit.runId, { includeResult: true })).result, null);
  assert.equal((await plain.audit.snapshot(plain.root)).coverage.resultText, "not stored");

  const failing = await fixture(t, { sealText: async () => { throw new Error("no key sk-canarykey"); }, openText: sealed.openText });
  const result = await failing.audit.run({ cwd: failing.root, agent: "reviewer" }, async () => ({ response: { content: [{ type: "text", text: "output" }] }, result: {} }));
  assert.equal(result._meta.directRunAudit.persisted, true, "the metadata record does not depend on the text");
  assert.equal((await failing.audit.get(failing.root, result._meta.directRunAudit.runId, { includeResult: true })).result, null);

  const good = await fixture(t, sealed);
  const stored = await good.audit.run({ cwd: good.root, agent: "reviewer" }, async () => ({ response: { content: [{ type: "text", text: "output" }] }, result: {} }));
  const unreadable = createDirectRunAudit({ ...good.options, openText: async () => { throw new Error("key changed"); } });
  assert.deepEqual((await unreadable.get(good.root, stored._meta.directRunAudit.runId, { includeResult: true })).result, { unreadable: true });
  assert.match((await good.audit.snapshot(good.root)).coverage.resultText, /^sealed, redacted, at most \d+ characters per run$/);
});

test("L-025: a table from before the result columns is migrated, and older rows read as having no result", async (t) => {
  const { root, dbPath } = await fixture(t);
  const legacyOpen = async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS opencode_direct_runs (
      run_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, status TEXT NOT NULL, error_type TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, agent TEXT NOT NULL,
      configured_model TEXT NOT NULL DEFAULT '', model_evidence_present INTEGER NOT NULL DEFAULT 0)`);
    return db;
  };
  const legacy = await legacyOpen();
  legacy.prepare("INSERT INTO opencode_direct_runs (run_id, project_key, status, started_at, finished_at, agent) VALUES ('old-run', ?, 'completed', '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z', 'reviewer')").run(root);
  legacy.close();
  const audit = createDirectRunAudit({
    openDb: async () => { const db = await legacyOpen(); ensureDirectRunAuditSchema(db); return db; },
    closeDb: (db) => db.close(), resolveProjectRoot: async () => root, redact: (text) => text, ...sealed,
  });
  const old = await audit.get(root, "old-run", { includeResult: true });
  assert.equal(old.status, "completed");
  assert.equal(old.result, null);
  const handle = await audit.start({ cwd: root, agent: "builder" }, { runId: "new-run" });
  assert.equal((await audit.finish(handle, { execution: { result: {} }, stored: { text: "after the migration" } })).persisted, true);
  assert.equal((await audit.get(root, "new-run", { includeResult: true })).result.text, "after the migration");
});
