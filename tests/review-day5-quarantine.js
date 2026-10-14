#!/usr/bin/env node

// D5-R07: unknown containment evidence cannot authorize either quarantine reclaimer.
// Process inventories are fixture-supplied; the exited root and unrecorded child are real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createProcessTableRuntime } from "../lib/process-table.js";
import { createProviderQuarantineRuntime } from "../lib/provider-quarantine.js";
import { finishSkips } from "./skip-gate.js";

const parent = await realpath(tmpdir());
const scratch = await mkdtemp(path.join(parent, "review-day5-quarantine-"));
assert.equal(path.dirname(await realpath(scratch)), parent);
const tests = [], test = (name, fn) => tests.push({ name, fn });
const old = Date.now() - 60 * 60 * 1000;
const graceMs = 60 * 1000;
const held = Number.MAX_SAFE_INTEGER;
let sequence = 0;
let exitedPid;

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function childFixture(script) {
  const child = spawn(process.execPath, ["-e", script], {
    cwd: scratch, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}
async function stopChild({ child, exited }) {
  if (child.exitCode === null && child.signalCode === null) child.stdin.end("stop\n");
  try { return await bounded(exited, 3000, "fixture child did not stop cooperatively"); }
  catch (error) {
    child.kill(); // Only this suite's own harmless child, never an inventoried process.
    await bounded(exited, 12000, "fixture child did not exit within its own lifetime bound");
    throw error;
  }
}
async function withValidator(fn) {
  const fixture = childFixture("setTimeout(() => process.exit(0), 10000); process.stdin.on('data', () => process.exit(0)); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready\\n');");
  const ready = new Promise((resolve, reject) => {
    fixture.child.stdout.once("data", data => data.toString().includes("ready") ? resolve() : reject(new Error("unexpected child output")));
    fixture.exited.then(() => reject(new Error("validator child exited before observation")), reject);
  });
  try {
    await bounded(ready, 3000, "validator child did not become ready");
    return await fn(fixture.child.pid);
  } finally {
    const result = await stopChild(fixture);
    assert.equal(result.code, 0);
  }
}
function runtime({ lookup = "ok", createdAt = "2" } = {}) {
  const calls = [];
  const value = createProcessTableRuntime({
    BRIDGE_RUNTIME_DIR: scratch, OPENCODE_EXE: "opencode.exe",
    CONFIG: { containmentReleaseGraceMs: graceMs },
    runCommand: async executable => {
      calls.push(executable);
      if (executable === "tasklist") return { exitCode: 0, stdout: '"node.exe","123","Console","1","1 K"\n' };
      if (executable === "pgrep") return { exitCode: 1, stdout: "" };
      assert.ok(["powershell.exe", "ps"].includes(executable), executable);
      if (lookup === "throw") throw new Error("fixture process lookup failed");
      if (lookup === "fail") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: process.platform === "win32"
        ? `${process.pid},${process.ppid},${createdAt}\n`
        : `${process.pid} ${process.ppid} ${createdAt}\n` };
    },
  });
  return { ...value, calls };
}
const evidence = extra => JSON.stringify({ pids: [exitedPid], complete: true, recordedAt: old, ...extra });
function unknownRecords() {
  return [
    ["incomplete", evidence({ complete: false })],
    ["missing", null], ["empty", ""], ["malformed-json", "{"],
    ["primitive", "true"], ["array", "[]"],
    ["missing-completeness", JSON.stringify({ pids: [exitedPid], recordedAt: old })],
    ["nonboolean-completeness", evidence({ complete: "true" })],
    ["missing-roots", JSON.stringify({ complete: true, recordedAt: old })],
    ["empty-roots", evidence({ pids: [] })],
    ["invalid-root-member", evidence({ pids: [exitedPid, null] })],
    ["missing-time", JSON.stringify({ pids: [exitedPid], complete: true })],
    ["invalid-time", evidence({ recordedAt: "not-a-time" })],
    ["invalid-identities", evidence({ processes: {} })],
  ];
}

test("incomplete evidence stays possible after its recorded root and owner have exited", async () => {
  const r = runtime();
  assert.equal(r.containmentProcessExists(exitedPid), false);
  for (const ownerPid of [0, exitedPid, process.pid]) {
    assert.equal(await r.containmentStillPossible(evidence({ complete: false }), ownerPid), true);
  }
});
test("missing, malformed, empty and nonaffirmative evidence cannot authorize release", async () => {
  const r = runtime();
  for (const [name, record] of unknownRecords()) {
    assert.equal(await r.containmentStillPossible(record, exitedPid), true, name);
  }
  for (const record of [undefined, "null", "0", '"evidence"', "{}", evidence({ pids: {} })]) {
    assert.equal(await r.containmentStillPossible(record), true, String(record));
  }
});
test("one invalid PID poisons the entire recorded root collection", async () => {
  for (const pid of [null, true, false, 0, -1, 1.5, "123", "", {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await runtime().containmentStillPossible(evidence({ pids: [exitedPid, pid] })), true, JSON.stringify(pid));
  }
});
test("malformed creation identities and timestamps remain unknown", async () => {
  for (const processes of [null, {}, [null], [{ pid: exitedPid, createdAt: 1 }],
    [{ pid: "123", createdAt: "1" }], [{ pid: exitedPid, createdAt: "" }],
    [{ pid: exitedPid, createdAt: "1" }, { pid: exitedPid, createdAt: "2" }]]) {
    assert.equal(await runtime().containmentStillPossible(evidence({ processes })), true, JSON.stringify(processes));
  }
  for (const recordedAt of [null, 0, -1, 1.5, "123", "not-a-time"]) {
    assert.equal(await runtime().containmentStillPossible(evidence({ recordedAt })), true, String(recordedAt));
  }
});
test("a live recorded PID stays held with PID-only evidence", async () => {
  const r = runtime();
  assert.equal(r.containmentProcessExists(process.pid), true);
  assert.equal(await r.containmentStillPossible(evidence({ pids: [process.pid], pidOnly: true })), true);
  assert.equal(await r.containmentStillPossible(evidence({ pids: [process.pid], processes: [] })), true);
  assert.equal(r.calls.length, 0, "PID-only evidence needs no identity lookup");
});
test("a matching creation identity keeps the live process quarantined", async () => {
  const r = runtime();
  assert.equal(await r.containmentStillPossible(evidence({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "2" }] })), true);
  assert.equal(r.calls.length, 1);
});
test("complete evidence can release a gone identity whose PID was reused", async () => {
  const r = runtime();
  assert.equal(r.containmentProcessExists(process.pid), true);
  assert.equal(await r.containmentStillPossible(evidence({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "1" }] })), false);
  assert.equal(r.calls.length, 1);
});
test("failed and throwing identity lookups keep possible containment", async () => {
  for (const lookup of ["fail", "throw"]) {
    const r = runtime({ lookup });
    assert.equal(await r.containmentStillPossible(evidence({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "1" }] })), true, lookup);
    assert.ok(r.calls.length > 0);
  }
});
test("the release grace still holds complete gone evidence", async () => {
  const r = runtime();
  assert.equal(await r.containmentStillPossible(evidence({ recordedAt: Date.now() })), true);
  assert.equal(await r.containmentStillPossible(evidence({ recordedAt: Date.now() + graceMs })), true);
  assert.equal(await r.containmentStillPossible(evidence()), false);
});
test("complete known-gone PID-only and identity records still release", async () => {
  for (const extra of [{}, { processes: [], pidOnly: true }, { processes: [{ pid: exitedPid, createdAt: "1" }] }]) {
    assert.equal(await runtime().containmentStillPossible(evidence(extra), process.pid), false);
  }
});
test("absent OpenCode and an absent owner do not prove an unrecorded Node child ended", async () => withValidator(async validatorPid => {
  const r = runtime();
  assert.equal(await r.openCodeProcessRunning(), false, "fixture inventory contains only Node");
  assert.equal(r.containmentProcessExists(exitedPid), false);
  assert.equal(r.containmentProcessExists(validatorPid), true);
  assert.equal(await r.containmentStillPossible(evidence({ complete: false }), exitedPid), true);
  assert.equal(r.containmentProcessExists(validatorPid), true);
}));

async function withReclaimers(r, records, fn) {
  const dbPath = path.join(scratch, `reclaim-${++sequence}.sqlite`);
  const db = new DatabaseSync(dbPath);
  const events = [];
  try {
    // Native SQLite tables use the production reclaimer columns and queue association shape.
    db.exec(`PRAGMA synchronous = FULL;
      CREATE TABLE locks (normalized_path TEXT NOT NULL, run_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (normalized_path, run_id));
      CREATE TABLE runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, containment TEXT, finished_at INTEGER);
      CREATE TABLE queue_job_locks (lock_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_generation TEXT NOT NULL);
      CREATE TABLE provider_leases (lease_id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, containment TEXT, expires_at INTEGER NOT NULL);`);
    for (const [id, record] of records) {
      db.prepare("INSERT INTO locks VALUES (?, ?, ?)").run(`scope/${id}`, id, held);
      db.prepare("INSERT INTO runs VALUES (?, 'quarantined', ?, NULL)").run(id, record);
      db.prepare("INSERT INTO queue_job_locks VALUES (?, ?, ?)").run(id, `job-${id}`, "fixture-generation");
      db.prepare("INSERT INTO provider_leases VALUES (?, ?, ?, ?)").run(id, exitedPid, record, held);
    }
    const reclaimers = createProviderQuarantineRuntime({
      BRIDGE_INSTANCE_ID: "d5-r07-fixture", CONFIG: {},
      containmentStillPossible: r.containmentStillPossible,
      openProviderLeaseDb: async () => new DatabaseSync(dbPath), closeDb: handle => handle.close(),
      logEvent: (level, name, details) => events.push({ level, name, details }),
    });
    await fn({ db, events, ...reclaimers });
    assert.equal(events.some(event => event.name.endsWith("reclaim_failed")), false, JSON.stringify(events));
  } finally { db.close(); }
}
function retained(db, id) {
  assert.equal(db.prepare("SELECT expires_at FROM locks WHERE run_id = ?").get(id)?.expires_at, held, `${id} lock`);
  assert.equal(db.prepare("SELECT expires_at FROM provider_leases WHERE lease_id = ?").get(id)?.expires_at, held, `${id} provider`);
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(id)?.status, "quarantined", `${id} status`);
  assert.equal(db.prepare("SELECT finished_at FROM runs WHERE run_id = ?").get(id)?.finished_at, null, `${id} terminal time`);
  assert.ok(db.prepare("SELECT 1 FROM queue_job_locks WHERE lock_id = ?").get(id), `${id} association`);
}
function released(db, id) {
  assert.equal(db.prepare("SELECT 1 FROM locks WHERE run_id = ?").get(id), undefined, `${id} lock`);
  assert.equal(db.prepare("SELECT 1 FROM provider_leases WHERE lease_id = ?").get(id), undefined, `${id} provider`);
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(id)?.status, "quarantine_released", `${id} status`);
  assert.ok(db.prepare("SELECT finished_at FROM runs WHERE run_id = ?").get(id)?.finished_at > 0, `${id} terminal time`);
  assert.equal(db.prepare("SELECT 1 FROM queue_job_locks WHERE lock_id = ?").get(id), undefined, `${id} association`);
}
test("native lock/provider reclaimers retain unknown records while the unrecorded validator is alive", async () => withValidator(async validatorPid => {
  const r = runtime();
  const unknown = unknownRecords();
  assert.equal(await r.openCodeProcessRunning(), false);
  assert.equal(r.containmentProcessExists(validatorPid), true);
  await withReclaimers(r, [...unknown, ["known-gone", evidence()]], async ({ db, reclaimProvenGoneLockQuarantines, reclaimProvenGoneProviderQuarantines }) => {
    assert.equal(await reclaimProvenGoneLockQuarantines(db), 1);
    assert.equal(r.containmentProcessExists(validatorPid), true, "validator alive after lock reclaim");
    assert.equal(await reclaimProvenGoneProviderQuarantines({ force: true }), 1);
    assert.equal(r.containmentProcessExists(validatorPid), true, "validator alive after provider reclaim");
    for (const [id] of unknown) retained(db, id);
    released(db, "known-gone");
    assert.equal(await reclaimProvenGoneLockQuarantines(db), 0);
    assert.equal(await reclaimProvenGoneProviderQuarantines({ force: true }), 0);
    for (const [id] of unknown) retained(db, id);
    process.stdout.write(`observed: validator PID ${validatorPid} alive; ${unknown.length} lock/provider quarantines retained; known-gone released.\n`);
  });
}));
test("native reclaimers preserve grace, live PID-only, identity and lookup-failure decisions", async () => {
  const records = [
    ["grace", evidence({ recordedAt: Date.now() })],
    ["live-pid-only", evidence({ pids: [process.pid] })],
    ["live-identity", evidence({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "2" }] })],
    ["reused-pid", evidence({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "1" }] })],
  ];
  await withReclaimers(runtime(), records, async ({ db, reclaimProvenGoneLockQuarantines, reclaimProvenGoneProviderQuarantines }) => {
    assert.equal(await reclaimProvenGoneLockQuarantines(db), 1);
    assert.equal(await reclaimProvenGoneProviderQuarantines({ force: true }), 1);
    for (const id of ["grace", "live-pid-only", "live-identity"]) retained(db, id);
    released(db, "reused-pid");
  });
  await withReclaimers(runtime({ lookup: "fail" }), [["lookup-failure", records[3][1]]], async ({ db, reclaimProvenGoneLockQuarantines, reclaimProvenGoneProviderQuarantines }) => {
    assert.equal(await reclaimProvenGoneLockQuarantines(db), 0);
    assert.equal(await reclaimProvenGoneProviderQuarantines({ force: true }), 0);
    retained(db, "lookup-failure");
  });
});

let failed = 0;
try {
  const root = childFixture("process.exit(0)");
  try {
    const result = await bounded(root.exited, 3000, "recorded root did not exit");
    assert.equal(result.code, 0);
    exitedPid = root.child.pid;
    assert.ok(Number.isSafeInteger(exitedPid) && exitedPid > 0);
  } finally { await stopChild(root); }
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  assert.equal(path.dirname(await realpath(scratch)), parent);
  assert.ok(path.basename(scratch).startsWith("review-day5-quarantine-"));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-day5-quarantine.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} D5 quarantine tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
