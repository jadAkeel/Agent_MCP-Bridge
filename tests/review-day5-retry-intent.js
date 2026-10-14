#!/usr/bin/env node

// Native encrypted queue/recovery fixtures only; every payload uses the offline executor.
import "./test-env.js";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createQueueRetryRuntime } from "../lib/queue/retry.js";
import { createQueueStartRuntime } from "../lib/queue/start.js";
import { createStateSchema } from "../lib/state/schema.js";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
Object.assign(process.env, { CODEX_OPENCODE_LOG_LEVEL: "warn", CODEX_OPENCODE_OPS_LOG: "off",
  CODEX_OPENCODE_ISSUE_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
  CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false", CODEX_OPENCODE_MIN_FREE_MEMORY_MB: "0",
  CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED: "true" });
const { isolateBridgeStateDir, makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const commitChild = process.argv.includes("--commit-child");
const childMode = commitChild || process.argv.includes("--recovery-child");
const isolatedStateDir = childMode ? process.env.RETRY_FIXTURE_STATE : isolateBridgeStateDir("review-day5-retry-intent");
if (childMode) process.env.CODEX_OPENCODE_STATE_DIR = isolatedStateDir;
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { hooks, internals: I } = __selfTest;
const { assert } = I;
const MODEL = "opencode/muse-spark-1.3-contributor-free@high";
hooks.selfTestModelOverrideAllowlist = [MODEL];

if (childMode) {
  hooks.stateDirectoryOverride = isolatedStateDir;
  hooks.queueModeOverride = "sqlite";
  let payloads = 0;
  hooks.queueJobExecutorTestHook = async () => {
    payloads++;
    return { response: { content: [{ type: "text", text: "REPORT: offline recovery done." }] },
      result: { errorType: "", changedFiles: [], configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" } };
  };
  const ids = JSON.parse(process.env.RETRY_FIXTURE_JOBS);
  const repo = process.env.RETRY_FIXTURE_REPO;
  const read = id => {
    const db = new I.DatabaseSync(I.stateDbPath(repo));
    try { db.exec("PRAGMA busy_timeout = 250");
      const row = db.prepare("SELECT status, record_json FROM opencode_jobs WHERE job_id = ?").get(id);
      return row && { ...JSON.parse(row.record_json), status: row.status }; } finally { I.closeDb(db); }
  };
  if (commitChild) {
    const accepted = await I.enqueueQueueJob({ agent: "reviewer", task: "R08 abrupt terminal-owner exit fixture", cwd: repo,
      write: false, lockMode: "off", scopeContract: { mode: "read", read: ["src/a.txt"] }, models: [MODEL], maxAttempts: 3 }, "", { schedule: false });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal((await I.claimQueueRecord(accepted.record)).ok, true);
    const runtime = createQueueStartRuntime({ ...I, QUEUE_ACTIVE_STATUSES: ["running", "validating", "reviewing", "testing"],
      externalRunnerName: () => "", logEvent: () => {}, scheduleQueueRetryPolicy: () => {
        assert.ok(read(accepted.record.jobId).retryDecisionPendingAt);
        process.stdout.write(`RETRY_RECEIPT ${JSON.stringify({ jobId: accepted.record.jobId, payloads })}\n`);
        // Abruptly end only this fixture's own process, immediately after native commit.
        process.exit(0);
      } });
    await runtime.commitQueueTerminalRecord(accepted.record, { status: "failed", errorType: "agent_timeout", finishedAt: new Date().toISOString() });
    assert.fail("the fixture owner must exit before detached policy execution");
  }
  await I.reconcileQueueStateAtStartup({ busyTimeoutMs: 250 });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !ids.every(id => read(id)?.requeuedAs && read(read(id).requeuedAs)?.status === "completed")) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ids.every(id => read(id)?.requeuedAs && read(read(id).requeuedAs)?.status === "completed"), "fresh runtime must finish every successor");
  process.stdout.write(`RETRY_RECEIPT ${JSON.stringify({ payloads, successors: ids.map(id => read(id).requeuedAs) })}\n`);
  process.exit(0);
}

const { finishSkips } = await import("./skip-gate.js");
const fixture = await makeFlexFixture(__selfTest, "review-day5-retry-intent");
const { repo, readJob, waitFor, execution } = fixture;
const dbPath = I.stateDbPath(repo);
const requests = [];
hooks.queueJobExecutorTestHook = async request => { requests.push(request); return execution({ configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" }); };
const tests = [], test = (name, fn) => tests.push({ name, fn });
let sequence = 0;
const past = new Date(Date.now() - 600_000).toISOString();
function raw(fn) { const db = new I.DatabaseSync(dbPath); try { db.exec("PRAGMA busy_timeout = 250"); return fn(db); } finally { I.closeDb(db); } }
function row(id) { return raw(db => db.prepare("SELECT * FROM opencode_jobs WHERE job_id = ?").get(id)); }
function summary(id) { const r = row(id); return r && { ...JSON.parse(r.record_json), status: r.status }; }
function patch(id, fields, columns = {}) {
  raw(db => {
    const current = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(id);
    const next = { ...JSON.parse(current.record_json), ...fields };
    db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify(next), id);
    for (const [column, value] of Object.entries(columns)) {
      assert.ok(["status", "lease_expires_at", "cancellation_requested_at", "request_encrypted", "owner_generation"].includes(column));
      db.prepare(`UPDATE opencode_jobs SET ${column} = ? WHERE job_id = ?`).run(value, id);
    }
  });
}
function successors(id) { return raw(db => db.prepare(`SELECT job_id, record_json FROM opencode_jobs
  WHERE json_extract(CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END, '$.requeuedFrom') = ?`).all(id)); }
async function enqueue({ policy = true, maxAttempts = 3 } = {}) {
  const result = await I.enqueueQueueJob(readJob({ task: `R08 fixture ${++sequence}`,
    ...(policy ? { models: [MODEL], maxAttempts } : {}) }), "", { schedule: false });
  assert.equal(result.ok, true, result.error);
  return result.record;
}
async function seed({ status = "failed", policy = true, maxAttempts = 3, pending = true, fields = {} } = {}) {
  const record = await enqueue({ policy, maxAttempts });
  I.QUEUE_JOBS.delete(record.jobId);
  raw(db => {
    const r = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(record.jobId);
    const snapshot = { ...JSON.parse(r.record_json), status, startedAt: past, finishedAt: past,
      errorType: status === "interrupted" ? "queue_job_interrupted" : "agent_timeout",
      ownerInstanceId: "r08-expired-owner", ownerProcessId: 0, ownerGeneration: "r08-expired-generation",
      heartbeatAt: "", leaseExpiresAt: status === "running" ? past : "",
      retryDecisionPendingAt: pending ? past : "", retryDecisionOutcome: "", retryDeferredAt: "", ...fields };
    db.prepare(`UPDATE opencode_jobs SET status = ?, started_at = ?, finished_at = ?,
      owner_instance_id = 'r08-expired-owner', owner_process_id = 0, owner_generation = 'r08-expired-generation',
      heartbeat_at = '', lease_expires_at = ?, record_json = ? WHERE job_id = ?`)
      .run(status, past, past, snapshot.leaseExpiresAt, JSON.stringify(snapshot), record.jobId);
  });
  return record.jobId;
}
const scan = () => I.reconcileQueueStateAtStartup({ busyTimeoutMs: 250 });
async function settled() { assert.ok(await waitFor(() => queueWorkerApi.activity().retries === 0), "detached policy must settle"); }
async function successor(id) {
  assert.ok(await waitFor(() => Boolean(summary(id)?.requeuedAs)), "durable successor must exist");
  const next = summary(id).requeuedAs;
  assert.ok(await waitFor(() => summary(next)?.status === "completed"), "offline successor must finish");
  assert.equal(successors(id).length, 1);
  assert.equal(summary(next).retryAttempt, 2);
  assert.equal(summary(id).retryAttempt, 1);
  assert.equal(summary(next).attemptHistory.length, 1);
  assert.equal(summary(id).retryDecisionPendingAt, "");
  assert.equal(summary(id).retryDecisionOutcome, "requeued");
  return next;
}
function retryRuntime(overrides = {}) {
  return createQueueRetryRuntime({ ...I, QUEUE_TERMINAL_STATUSES: ["completed", "failed", "cancelled", "interrupted", "not_resumable"],
    activeModelOverrideAllowlist: () => [MODEL], effectiveQueueMode: () => "sqlite", hasWriteIntent: () => false,
    getAutoResumeInterruptedOverride: () => null, processIsAlive: pid => pid === process.pid, logEvent: () => {}, ...overrides });
}
function terminalRuntime(dispatch) {
  return createQueueStartRuntime({ ...I, QUEUE_ACTIVE_STATUSES: ["running", "validating", "reviewing", "testing"],
    QUEUE_TERMINAL_STATUSES: ["completed", "failed", "cancelled", "interrupted", "not_resumable"],
    externalRunnerName: () => "", logEvent: () => {}, scheduleQueueRetryPolicy: dispatch,
    handleQueueWorkerInfrastructureFailure: async (_record, error) => { throw error; } });
}
async function commitWithoutDispatch() {
  const record = await enqueue();
  assert.equal((await I.claimQueueRecord(record)).ok, true);
  let dispatches = 0;
  const runtime = terminalRuntime(() => {
    dispatches++;
    assert.ok(summary(record.jobId).retryDecisionPendingAt, "intent must be committed before dispatch");
    throw new Error("synthetic administrative dispatch IO failure");
  });
  const result = await runtime.commitQueueTerminalRecord(record, { status: "failed", errorType: "agent_timeout", finishedAt: past });
  assert.equal(result.persisted, true);
  assert.equal(dispatches, 1);
  I.QUEUE_JOBS.delete(record.jobId);
  return record.jobId;
}
function childRecovery(ids, mode = "--recovery-child") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { shell: false, windowsHide: true,
      env: { ...process.env, RETRY_FIXTURE_STATE: fixture.stateDir, RETRY_FIXTURE_REPO: repo, RETRY_FIXTURE_JOBS: JSON.stringify(ids) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", finished = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`bounded recovery child timed out: ${output}`)); }, 20_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-32_768); });
    const finish = (error, receipt) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(receipt); };
    child.once("error", error => finish(error));
    child.once("close", code => {
      const match = /RETRY_RECEIPT (\{[^\n]+\})/.exec(output);
      finish(code === 0 && match ? null : new Error(`recovery child exit ${code}: ${output}`), match && JSON.parse(match[1]));
    });
  });
}

test("normal failed terminal transaction persists intent before a failed administrative dispatch", async () => {
  const id = await commitWithoutDispatch();
  assert.equal(summary(id).status, "failed");
  assert.ok(summary(id).retryDecisionPendingAt);
  assert.equal(summary(id).retryAttempt, 1);
  assert.equal(successors(id).length, 0);
  await scan(); await settled(); await successor(id);
});

test("interruption commits intent before the first policy dispatch fails and unchanged bytes stay revisitable", async () => {
  const id = await seed({ status: "running", pending: false });
  let calls = 0;
  hooks.queueRetryPolicyTestHook = async ({ jobId }) => {
    if (jobId !== id) return;
    calls++;
    assert.equal(summary(id).status, "interrupted");
    assert.ok(summary(id).retryDecisionPendingAt);
    if (calls === 1) throw Object.assign(new Error("synthetic SQLITE_BUSY"), { errorType: "SQLITE_BUSY" });
  };
  try {
    await scan(); await settled();
    assert.equal(calls, 1);
    assert.equal(summary(id).retryAttempt, 1);
    assert.equal(successors(id).length, 0);
    const bytes = await readFile(dbPath), metadata = await stat(dbPath);
    await settled();
    assert.deepEqual(await readFile(dbPath), bytes);
    assert.equal((await stat(dbPath)).mtimeMs, metadata.mtimeMs);
    await scan(); await settled(); await successor(id);
    assert.equal(calls, 2);
  } finally { hooks.queueRetryPolicyTestHook = null; }
});

test("a fresh process recovers committed failed intent before any initial dispatch", async () => {
  const owner = await childRecovery([], "--commit-child");
  assert.equal(owner.payloads, 0);
  const id = owner.jobId;
  assert.ok(summary(id).retryDecisionPendingAt);
  const receipt = await childRecovery([id]);
  assert.equal(receipt.payloads, 1);
  await successor(id);
});

test("two fresh instances race one terminal intent and execute only one idempotent successor", async () => {
  const id = await commitWithoutDispatch();
  const receipts = await Promise.all([childRecovery([id]), childRecovery([id])]);
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.payloads, 0), 1);
  assert.equal(new Set(receipts.flatMap(receipt => receipt.successors)).size, 1);
  await successor(id);
});

for (const status of ["failed", "interrupted"]) test(`legacy unmarked ${status} policy row recovers once`, async () => {
  const id = await seed({ status, pending: false });
  raw(db => {
    const legacy = summary(id);
    delete legacy.retryDecisionPendingAt; delete legacy.retryDecisionOutcome; delete legacy.retryDecisionAt; delete legacy.retryDeferredAt;
    db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify(legacy), id);
  });
  await scan(); await settled(); await successor(id);
  await scan(); await settled(); assert.equal(successors(id).length, 1);
});

test("overlapping scans and initial dispatch share one in-flight policy decision", async () => {
  const id = await seed();
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  hooks.queueRetryPolicyTestHook = async ({ jobId }) => { if (jobId === id) { calls++; await held; } };
  try {
    await scan(); assert.ok(await waitFor(() => calls === 1));
    await scan(); await scan();
    assert.equal(calls, 1); assert.equal(I.deferredRecoveryLastPass().busy, true);
    release(); await settled(); await successor(id);
    await scan(); await settled(); assert.equal(calls, 1);
  } finally { release(); await settled(); hooks.queueRetryPolicyTestHook = null; }
});

for (const [name, options, disabled, outcome] of [
  ["no policy", { policy: false }, false, "none"],
  ["noneligible error", { fields: { errorType: "scope_contract_invalid" } }, false, "not_eligible"],
  ["disabled interrupted resume", { status: "interrupted" }, true, "resume_disabled"],
  ["exhausted execution budget", { maxAttempts: 1 }, false, "gave_up"],
]) test(`${name} settles intent durably and suppresses later decisions`, async () => {
  const id = await seed(options);
  hooks.autoResumeInterruptedOverride = disabled ? false : null;
  let calls = 0;
  hooks.queueRetryPolicyTestHook = async ({ jobId }) => { if (jobId === id) calls++; };
  try {
    await scan(); await settled();
    assert.equal(summary(id).retryDecisionOutcome, outcome);
    assert.equal(summary(id).retryDecisionPendingAt, "");
    assert.ok(summary(id).retryDecisionAt);
    const revision = row(id).revision;
    await scan(); await settled();
    assert.equal(calls, 1); assert.equal(row(id).revision, revision); assert.equal(successors(id).length, 0);
    assert.equal(summary(id).retryAttempt || 0, options.policy === false ? 0 : 1);
  } finally { hooks.queueRetryPolicyTestHook = null; hooks.autoResumeInterruptedOverride = null; }
});

for (const [name, fields, columns] of [
  ["parent child", { parentJobId: "synthetic-parent" }, {}],
  ["cancelled summary", { cancellationRequested: true }, {}],
  ["durable cancellation", {}, { cancellation_requested_at: past }],
  ["completed status", {}, { status: "completed" }],
  ["cancelled status", {}, { status: "cancelled" }],
  ["existing successor", { requeuedAs: "synthetic-existing-successor" }, {}],
  ["already gave up", { completionOutcome: "gave_up" }, {}],
]) test(`${name} is excluded without mutation or dispatch`, async () => {
  const id = await seed(); patch(id, fields, columns);
  const before = row(id);
  let calls = 0;
  hooks.queueRetryPolicyTestHook = async ({ jobId }) => { if (jobId === id) calls++; };
  try { await scan(); await settled(); assert.equal(calls, 0); assert.deepEqual(row(id), before); }
  finally { hooks.queueRetryPolicyTestHook = null; }
});

test("live orphan deferral retains intent and does not spend budget before later exit", async () => {
  const id = await seed({ status: "interrupted", fields: { orphanChildProcessAlive: true, orphanChildProcessId: process.pid } });
  await scan(); await settled(); await scan();
  assert.equal(successors(id).length, 0); assert.equal(summary(id).retryAttempt, 1);
  assert.equal(I.deferredRecoveryLastPass().busy, true);
  patch(id, { orphanChildProcessAlive: false, orphanChildProcessId: 0 });
  await scan(); await settled(); await successor(id);
});

for (const fault of ["returned persistence refusal", "thrown SQLite IO", "request decryption IO"]) test(`${fault} retains intent without changing attempt or history`, async () => {
  const id = await seed();
  const before = row(id);
  const runtime = retryRuntime(fault === "request decryption IO" ? { decryptQueueRequest: async () => { throw new Error("synthetic key IO"); } }
    : { enqueueQueueJob: async () => {
      if (fault === "thrown SQLite IO") throw Object.assign(new Error("synthetic SQLITE_IOERR"), { errorType: "SQLITE_IOERR" });
      return { ok: false, errorType: "queue_persistence_failed", error: "synthetic persistence refusal" };
    } });
  if (fault === "thrown SQLite IO") await assert.rejects(runtime.applyQueueRetryPolicy({ cwd: repo, jobId: id }), /SQLITE_IOERR/);
  else assert.equal((await runtime.applyQueueRetryPolicy({ cwd: repo, jobId: id })).action, "failed");
  assert.deepEqual(row(id), before);
  await scan(); await settled(); await successor(id);
});

test("native successor-mark rollback retains intent and retry deduplicates the admitted successor", async () => {
  const id = await seed();
  raw(db => db.exec(`CREATE TRIGGER r08_reject_mark BEFORE UPDATE ON opencode_jobs
    WHEN OLD.job_id = '${id}' AND json_extract(NEW.record_json, '$.retryDecisionOutcome') = 'requeued'
    BEGIN SELECT RAISE(ABORT, 'synthetic predecessor mark IO'); END;`));
  try {
    await assert.rejects(I.applyQueueRetryPolicy({ cwd: repo, jobId: id }), /predecessor mark IO/);
    assert.ok(summary(id).retryDecisionPendingAt); assert.equal(summary(id).retryAttempt, 1);
    assert.equal(successors(id).length, 1);
  } finally { raw(db => db.exec("DROP TRIGGER r08_reject_mark")); }
  await scan(); await settled(); await successor(id);
});

test("a transient second request lookup retains intent instead of exhausting execution budget", async () => {
  const id = await seed(), before = row(id);
  let lookups = 0;
  const runtime = retryRuntime({ decryptQueueRequest: async (...args) => {
    if (++lookups === 2) throw new Error("synthetic replay lookup IO");
    return await I.decryptQueueRequest(...args);
  } });
  assert.equal((await runtime.applyQueueRetryPolicy({ cwd: repo, jobId: id })).action, "failed");
  assert.equal(lookups, 2); assert.deepEqual(row(id), before);
  await scan(); await settled(); await successor(id);
});

test("native definitive-decision rollback cannot falsely settle pending intent", async () => {
  const id = await seed({ maxAttempts: 1 });
  const before = row(id);
  raw(db => db.exec(`CREATE TRIGGER r08_reject_settle BEFORE UPDATE ON opencode_jobs
    WHEN OLD.job_id = '${id}' AND json_extract(NEW.record_json, '$.retryDecisionOutcome') = 'gave_up'
    BEGIN SELECT RAISE(ABORT, 'synthetic settle IO'); END;`));
  try { await assert.rejects(I.applyQueueRetryPolicy({ cwd: repo, jobId: id }), /settle IO/); assert.deepEqual(row(id), before); }
  finally { raw(db => db.exec("DROP TRIGGER r08_reject_settle")); }
  await scan(); await settled(); assert.equal(summary(id).retryDecisionOutcome, "gave_up");
});

test("native terminal rollback preserves running generation and commits no intent", async () => {
  const record = await enqueue(); assert.equal((await I.claimQueueRecord(record)).ok, true);
  const before = row(record.jobId);
  raw(db => db.exec(`CREATE TRIGGER r08_reject_terminal BEFORE UPDATE ON opencode_jobs
    WHEN OLD.job_id = '${record.jobId}' AND NEW.status = 'failed'
    BEGIN SELECT RAISE(ABORT, 'synthetic terminal IO'); END;`));
  try {
    await assert.rejects(I.updateQueueTerminalRecordDurable(record, { status: "failed", errorType: "agent_timeout", finishedAt: past }), /terminal IO/);
    assert.deepEqual(row(record.jobId), before); assert.equal(summary(record.jobId).retryDecisionPendingAt, "");
  } finally { raw(db => db.exec("DROP TRIGGER r08_reject_terminal")); }
  assert.equal((await I.updateQueueTerminalRecordDurable(record, { status: "failed", errorType: "agent_timeout", finishedAt: past })).persisted, true);
  assert.ok(summary(record.jobId).retryDecisionPendingAt);
  I.QUEUE_JOBS.delete(record.jobId); await scan(); await settled(); await successor(record.jobId);
});

test("replaced generation refuses terminal intent without changing the durable owner", async () => {
  const record = await enqueue(); assert.equal((await I.claimQueueRecord(record)).ok, true);
  patch(record.jobId, { ownerGeneration: "synthetic-replacement" }, { owner_generation: "synthetic-replacement" });
  const before = row(record.jobId);
  const result = await I.updateQueueTerminalRecordDurable(record, { status: "failed", errorType: "agent_timeout" });
  assert.equal(result.persisted, false); assert.equal(result.ownershipLost, true); assert.deepEqual(row(record.jobId), before);
  patch(record.jobId, { status: "cancelled", cancellationRequested: true }, { status: "cancelled" }); I.QUEUE_JOBS.delete(record.jobId);
});

test("both durable owner leases must expire before interrupted intent is admitted", async () => {
  const id = await seed({ status: "running", pending: false });
  const future = new Date(Date.now() + 60_000).toISOString();
  raw(db => db.prepare(`INSERT OR REPLACE INTO bridge_instances(instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
    VALUES ('r08-expired-owner', 0, ?, ?, ?)`).run(past, past, future));
  await scan(); await settled(); assert.equal(summary(id).status, "running"); assert.equal(summary(id).retryDecisionPendingAt, "");
  raw(db => db.prepare("UPDATE bridge_instances SET lease_expires_at = ? WHERE instance_id = 'r08-expired-owner'").run(past));
  patch(id, {}, { lease_expires_at: future });
  await scan(); await settled(); assert.equal(summary(id).status, "running");
  patch(id, {}, { lease_expires_at: past });
  await scan(); await settled(); await successor(id);
});

test("matching partial index handles malformed JSON and excludes unrelated retained history", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("function retryDeferredByOrphans("));
  const query = /const query = db.prepare\(`([\s\S]*?)`\);/.exec(section)?.[1];
  assert.ok(query); assert.match(query, /INDEXED BY opencode_jobs_retry_decision_idx/); assert.match(query, /LIMIT \?/);
  const candidate = await seed();
  raw(db => {
    const r = row(candidate);
    const insert = db.prepare("INSERT INTO opencode_jobs(job_id, cwd, status, agent, mode, created_at, record_json, request_encrypted) VALUES (?, ?, ?, 'reviewer', 'read', ?, ?, ?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let n = 0; n < 512; n++) insert.run(`r08-history-${n}`, repo, "completed", past, JSON.stringify({ retryAttempt: 1, maxAttempts: 3 }), r.request_encrypted);
      insert.run("r08-malformed", repo, "failed", past, "{malformed", r.request_encrypted);
      insert.run("r08-array", repo, "interrupted", past, "[]", r.request_encrypted);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("DROP INDEX opencode_jobs_retry_decision_idx");
    createStateSchema().ensureQueueLeaseSchema(db);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("", 65);
    assert.ok(plan.some(item => /SEARCH.*opencode_jobs_retry_decision_idx.*job_id>/.test(item.detail)), JSON.stringify(plan));
    const rows = db.prepare(query).all("", 65);
    assert.ok(rows.some(item => item.job_id === candidate));
    assert.ok(!rows.some(item => /r08-history|r08-malformed|r08-array/.test(item.job_id)));
    process.stdout.write(`INDEX_PLAN ${JSON.stringify(plan)}\n`);
  });
  await scan(); await settled(); await successor(candidate);
});

test("bounded cursor reaches later eligible work despite a full batch of live orphan deferrals", async () => {
  const live = [];
  for (let n = 0; n < 66; n++) live.push(await seed({ status: "interrupted", fields: { orphanChildProcessAlive: true, orphanChildProcessId: process.pid } }));
  const original = await seed(), id = "zz-r08-later-candidate";
  const encrypted = await I.encryptQueueRequest(await I.decryptQueueRequest(row(original).request_encrypted, original), id);
  raw(db => db.prepare("UPDATE opencode_jobs SET job_id = ?, request_encrypted = ?, record_json = ? WHERE job_id = ?")
    .run(id, encrypted, JSON.stringify({ ...summary(original), jobId: id }), original));
  try {
    for (let pass = 0; pass < 4 && !summary(id).requeuedAs; pass++) { await scan(); await settled(); }
    await successor(id);
    assert.ok(live.every(jobId => successors(jobId).length === 0));
  } finally { for (const jobId of live) patch(jobId, { cancellationRequested: true, retryDecisionPendingAt: "" }); }
});

test("settled database returns to unchanged-file idle memo without rewriting retained rows", async () => {
  await scan(); await settled(); await scan(); await settled();
  const bytes = await readFile(dbPath), fingerprint = createHash("sha256").update(bytes).digest("hex");
  await scan(); await settled();
  assert.equal(I.deferredRecoveryLastPass().openedDbPaths.includes(dbPath), false);
  assert.equal(createHash("sha256").update(await readFile(dbPath)).digest("hex"), fingerprint);
});

await runFlexTests({ file: "tests/review-day5-retry-intent.js", tests, isolatedStateDir, finishSkips, label: "Day5 retry intent",
  cleanup: async () => { hooks.queueRetryPolicyTestHook = null; hooks.autoResumeInterruptedOverride = null;
    hooks.selfTestModelOverrideAllowlist = null; await settled(); await fixture.cleanup(); } });
