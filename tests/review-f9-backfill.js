#!/usr/bin/env node

// D4-F9-002: native scratch SQLite exercises the production schema entrypoint directly.
// Root's negative control restores only the old schema module and runs this same suite;
// it must fail current-row write/classification assertions, without any fixture adapter.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStateSchema } from "../lib/state/schema.js";
import { finishSkips } from "./skip-gate.js";

const parent = path.resolve(tmpdir());
const scratch = await mkdtemp(path.join(parent, "review-f9-backfill-"));
assert.ok(scratch.startsWith(`${parent}${path.sep}`));
const schema = createStateSchema();
const tests = [], test = (name, fn) => tests.push({ name, fn });
let sequence = 0;
const timestamp = "2026-10-13T00:00:00.000Z";
const owners = {
  ownerInstanceId: "json-owner", ownerGeneration: "json-generation",
  ownerHeartbeatAt: "2026-10-13T01:00:00.000Z", ownerLeaseExpiresAt: "2026-10-13T02:00:00.000Z",
};
const modern = extra => ({ queueMode: "sqlite", queueJobIds: [], ...extra });

async function withDb(fn, { legacy = false, nullable = false } = {}) {
  const db = new DatabaseSync(path.join(scratch, `fixture-${++sequence}.sqlite`));
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE opencode_pipelines (pipeline_id TEXT PRIMARY KEY, cwd TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);`);
    if (nullable) {
      // Existing nullable columns represent an interrupted older upgrade. The production
      // ensure must finish their data mapping without replacing their declarations.
      db.exec(`ALTER TABLE opencode_pipelines ADD COLUMN revision INTEGER;
        ALTER TABLE opencode_pipelines ADD COLUMN request_encrypted TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN details_encrypted TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN owner_instance_id TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN owner_generation TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN owner_heartbeat_at TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN owner_lease_expires_at TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN expected_child_count INTEGER;
        ALTER TABLE opencode_pipelines ADD COLUMN batch_state TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN cleanup_state TEXT;
        ALTER TABLE opencode_pipelines ADD COLUMN queue_mode TEXT;`);
    }
    if (!legacy) schema.ensurePipelineRevisionSchema(db);
    return await fn(db);
  } finally { db.close(); }
}
function insert(db, id, { status = "planned", json = {}, columns = {} } = {}) {
  const values = { pipeline_id: id, cwd: scratch, status, created_at: timestamp,
    updated_at: timestamp, record_json: typeof json === "string" ? json : JSON.stringify(json), ...columns };
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO opencode_pipelines (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...Object.values(values));
}
function job(db, id, json) {
  db.prepare("INSERT INTO opencode_jobs VALUES (?, ?)").run(id, typeof json === "string" ? json : JSON.stringify(json));
}
function row(db, id) {
  return { ...db.prepare("SELECT * FROM opencode_pipelines WHERE pipeline_id = ?").get(id) };
}
function rows(db, table = "opencode_pipelines") {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map(value => ({ ...value }));
}
function changes(db) {
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  schema.ensurePipelineRevisionSchema(db);
  return db.prepare("SELECT total_changes() AS n").get().n - before;
}
function mapping(db, id, expected) {
  const actual = row(db, id);
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `${id}: ${key}`);
}
function unchanged(db) {
  const before = rows(db);
  assert.equal(changes(db), 0, "a completed backfill must not rewrite unchanged rows");
  assert.deepEqual(rows(db), before);
}

test("repeated ensure changes zero fully current modern rows", () => withDb(db => {
  insert(db, "modern-missing-batch", { json: modern(), columns: { queue_mode: "sqlite" } });
  insert(db, "modern-explicit-batch", { json: modern({ batchState: "unstarted" }), columns: { queue_mode: "sqlite" } });
  insert(db, "modern-released", { status: "running", json: modern({ ...owners, queueJobIds: ["a", "b"], batchState: "released" }),
    columns: { queue_mode: "sqlite", batch_state: "released", expected_child_count: 2,
      owner_instance_id: "sql-owner", owner_generation: "sql-generation",
      owner_heartbeat_at: timestamp, owner_lease_expires_at: timestamp } });
  const before = rows(db);
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(changes(db), 0, "current modern rows must not be rewritten");
    assert.deepEqual(rows(db), before);
  }
}));

test("matching and unrelated legacy-looking history do not reclassify modern unstarted plans", () => withDb(db => {
  for (const [id, extra] of [["modern-linked", {}], ["modern-linked-explicit", { batchState: "unstarted" }]]) {
    insert(db, id, { json: modern(extra), columns: { queue_mode: "sqlite" } });
    job(db, `child-${id}`, { parentJobId: id });
  }
  job(db, "unrelated", { parentJobId: "another-pipeline" });
  const before = rows(db), jobsBefore = rows(db, "opencode_jobs");
  const changed = changes(db);
  for (const value of rows(db)) assert.equal(value.batch_state, "unstarted", "linked history must not reclassify a modern plan");
  assert.equal(changed, 0);
  assert.deepEqual(rows(db), before);
  assert.deepEqual(rows(db, "opencode_jobs"), jobsBefore);
}));

test("recognizable modern rows still receive each genuinely missing ownership mapping", () => withDb(db => {
  const fields = [
    ["owner_instance_id", "json-owner"], ["owner_generation", "json-generation"],
    ["owner_heartbeat_at", owners.ownerHeartbeatAt], ["owner_lease_expires_at", owners.ownerLeaseExpiresAt],
  ];
  for (const [missing] of fields) {
    const columns = { queue_mode: "sqlite", owner_instance_id: "sql-owner", owner_generation: "sql-generation",
      owner_heartbeat_at: timestamp, owner_lease_expires_at: timestamp, [missing]: "" };
    insert(db, missing, { json: modern({ ...owners }), columns });
    job(db, `linked-${missing}`, { parentJobId: missing });
  }
  assert.equal(changes(db), fields.length);
  for (const [missing, fallback] of fields) {
    mapping(db, missing, { queue_mode: "sqlite", batch_state: "unstarted", expected_child_count: 0,
      owner_instance_id: missing === "owner_instance_id" ? fallback : "sql-owner",
      owner_generation: missing === "owner_generation" ? fallback : "sql-generation",
      owner_heartbeat_at: missing === "owner_heartbeat_at" ? fallback : timestamp,
      owner_lease_expires_at: missing === "owner_lease_expires_at" ? fallback : timestamp });
  }
  unchanged(db);
}));

test("initial legacy upgrade maps ownership, heartbeat, lease, count and classification", () => withDb(db => {
  insert(db, "legacy-initial", { json: { ...owners, queueJobIds: ["child"] } });
  job(db, "child", { parentJobId: "legacy-initial" });
  const before = row(db, "legacy-initial");
  assert.equal(changes(db), 1);
  mapping(db, "legacy-initial", { owner_instance_id: owners.ownerInstanceId, owner_generation: owners.ownerGeneration,
    owner_heartbeat_at: owners.ownerHeartbeatAt, owner_lease_expires_at: owners.ownerLeaseExpiresAt,
    expected_child_count: 1, batch_state: "legacy", queue_mode: "legacy", revision: 0,
    request_encrypted: null, details_encrypted: null, cleanup_state: "none" });
  for (const [key, value] of Object.entries(before)) assert.equal(row(db, "legacy-initial")[key], value);
  unchanged(db);
}, { legacy: true }));

test("existing columns do not suppress an interrupted legacy backfill", () => withDb(db => {
  insert(db, "partial-owner", { json: { ...owners, queueJobIds: ["a", "b", "c"] },
    columns: { owner_generation: "sql-generation", owner_lease_expires_at: "sql-lease" } });
  insert(db, "positive-count", { json: { ...owners, queueJobIds: ["a", "b"] },
    columns: { owner_instance_id: "sql-owner", owner_generation: "sql-generation",
      owner_heartbeat_at: "sql-heartbeat", owner_lease_expires_at: "sql-lease", expected_child_count: 7, batch_state: "accepted" } });
  assert.equal(changes(db), 1);
  mapping(db, "partial-owner", { owner_instance_id: "json-owner", owner_generation: "sql-generation",
    owner_heartbeat_at: owners.ownerHeartbeatAt, owner_lease_expires_at: "sql-lease", expected_child_count: 3, batch_state: "legacy" });
  mapping(db, "positive-count", { owner_instance_id: "sql-owner", owner_generation: "sql-generation",
    owner_heartbeat_at: "sql-heartbeat", owner_lease_expires_at: "sql-lease", expected_child_count: 7, batch_state: "accepted" });
  unchanged(db);
}));

test("legacy children found only in jobs and running legacy pipelines remain detectable", () => withDb(db => {
  insert(db, "only-in-jobs");
  insert(db, "legacy-running", { status: "running" });
  job(db, "unlisted-child", { parentJobId: "only-in-jobs" });
  assert.equal(changes(db), 2);
  for (const id of ["only-in-jobs", "legacy-running"]) mapping(db, id, { batch_state: "legacy", expected_child_count: 0, queue_mode: "legacy" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM opencode_pipeline_children").get().n, 0,
    "linked history must not invent a child manifest");
  unchanged(db);
}));

test("no-op legacy rows and legacy evidence added after prior ensures remain eligible", () => withDb(db => {
  insert(db, "legacy-quiet");
  unchanged(db);
  unchanged(db);
  job(db, "late-child", { parentJobId: "legacy-quiet" });
  insert(db, "legacy-added-later", { json: { ...owners, queueJobIds: ["listed"] } });
  assert.equal(changes(db), 2);
  mapping(db, "legacy-quiet", { batch_state: "legacy", expected_child_count: 0 });
  mapping(db, "legacy-added-later", { owner_instance_id: "json-owner", expected_child_count: 1, batch_state: "legacy" });
  unchanged(db);
  db.prepare("UPDATE opencode_pipelines SET record_json = ? WHERE pipeline_id = ?")
    .run(JSON.stringify({ ownerInstanceId: "late-json-owner" }), "legacy-quiet");
  assert.equal(changes(db), 1);
  mapping(db, "legacy-quiet", { owner_instance_id: "late-json-owner", batch_state: "legacy", expected_child_count: 0 });
  unchanged(db);
}));

test("invalid pipeline and child JSON cannot abort neighboring valid backfills", () => withDb(db => {
  insert(db, "invalid-pipeline", { status: "running", json: "{" });
  insert(db, "valid-pipeline", { json: { ownerInstanceId: "valid-owner" } });
  insert(db, "valid-scalar", { json: '"scalar"' });
  insert(db, "valid-null", { json: "null" });
  job(db, "invalid-child", "{");
  job(db, "valid-child", { parentJobId: "valid-pipeline" });
  const invalidBefore = row(db, "invalid-pipeline");
  assert.equal(changes(db), 1);
  assert.deepEqual(row(db, "invalid-pipeline"), invalidBefore);
  mapping(db, "valid-pipeline", { owner_instance_id: "valid-owner", batch_state: "legacy" });
  mapping(db, "valid-scalar", { batch_state: "unstarted", expected_child_count: 0 });
  mapping(db, "valid-null", { batch_state: "unstarted", expected_child_count: 0 });
  unchanged(db);
}));

test("partial or contradictory modern evidence retains conservative legacy classification", () => withDb(db => {
  const cases = [
    ["sql-mode-only", {}, { queue_mode: "sqlite" }, "planned", 0],
    ["json-mode-only", modern(), {}, "planned", 0],
    ["missing-child-array", { queueMode: "sqlite" }, { queue_mode: "sqlite" }, "planned", 0],
    ["null-child-array", modern({ queueJobIds: null }), { queue_mode: "sqlite" }, "planned", 0],
    ["listed-children", modern({ queueJobIds: ["a", "b"] }), { queue_mode: "sqlite" }, "planned", 2],
    ["positive-proposed-count", modern(), { queue_mode: "sqlite", expected_child_count: 7 }, "planned", 7],
    ["json-legacy-batch", modern({ batchState: "legacy" }), { queue_mode: "sqlite" }, "planned", 0],
    ["json-null-batch", modern({ batchState: null }), { queue_mode: "sqlite" }, "planned", 0],
    ["running-with-modes", modern(), { queue_mode: "sqlite" }, "running", 0],
  ];
  for (const [id, json, columns, status] of cases) {
    insert(db, id, { json, columns, status });
    job(db, `history-${id}`, { parentJobId: id });
  }
  assert.equal(changes(db), cases.length);
  for (const [id, , , , count] of cases) mapping(db, id, { batch_state: "legacy", expected_child_count: count });
  unchanged(db);
}));

test("nullable existing columns retain original NULL mapping and proposed-count semantics", () => withDb(db => {
  insert(db, "nullable-empty");
  insert(db, "nullable-legacy", { json: { ...owners, queueJobIds: ["a"] } });
  insert(db, "negative-modern-count", { json: modern(), columns: { queue_mode: "sqlite", batch_state: "unstarted", expected_child_count: -1 } });
  job(db, "negative-modern-history", { parentJobId: "negative-modern-count" });
  insert(db, "nullable-modern-batch", { json: modern(), columns: { queue_mode: "sqlite", batch_state: null, expected_child_count: 0 } });
  job(db, "nullable-batch-history", { parentJobId: "nullable-modern-batch" });
  assert.equal(changes(db), 4);
  mapping(db, "nullable-empty", { owner_instance_id: "", owner_generation: "", owner_heartbeat_at: "", owner_lease_expires_at: "",
    expected_child_count: 0, batch_state: null, queue_mode: null, revision: null, cleanup_state: null });
  mapping(db, "nullable-legacy", { owner_instance_id: "json-owner", owner_generation: "json-generation",
    owner_heartbeat_at: owners.ownerHeartbeatAt, owner_lease_expires_at: owners.ownerLeaseExpiresAt, expected_child_count: 1, batch_state: "legacy" });
  mapping(db, "negative-modern-count", { expected_child_count: 0, batch_state: "unstarted" });
  mapping(db, "nullable-modern-batch", { expected_child_count: 0, batch_state: "legacy" });
  unchanged(db);
}, { nullable: true }));

test("private bytes, operational fields, relationships and existing indexes remain exact", () => withDb(db => {
  const json = '{\n  "ownerInstanceId": "json-owner", "queueJobIds": ["related-child"],\n  "events": [{"type":"source_cleanup_authorized","text":"fixture \\u263a"}]\n}\n';
  insert(db, "private-legacy", { json, columns: { revision: 17, request_encrypted: Buffer.from([0, 255, 13, 10, 42]),
    details_encrypted: Buffer.from([254, 0, 128, 99]), cleanup_state: "failed_retryable", owner_generation: "authoritative-generation" } });
  job(db, "related-child", { parentJobId: "private-legacy", fixture: "keep exact" });
  db.prepare("INSERT INTO opencode_pipeline_children VALUES (?, ?, ?, ?)").run("private-legacy", 0, "related-child", timestamp);
  const before = row(db, "private-legacy"), jobsBefore = rows(db, "opencode_jobs"), relationsBefore = rows(db, "opencode_pipeline_children");
  const structure = () => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  const schemaBefore = structure();
  assert.equal(changes(db), 1);
  const after = row(db, "private-legacy");
  for (const field of ["pipeline_id", "cwd", "status", "created_at", "updated_at", "record_json", "revision",
    "request_encrypted", "details_encrypted", "cleanup_state", "queue_mode", "owner_generation"]) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.deepEqual(rows(db, "opencode_jobs"), jobsBefore);
  assert.deepEqual(rows(db, "opencode_pipeline_children"), relationsBefore);
  assert.deepEqual(structure(), schemaBefore);
  unchanged(db);
}));

test("a failed backfill UPDATE rolls ownership, count and classification back together", () => withDb(db => {
  for (const id of ["first", "reject"]) insert(db, id, { json: { ...owners, queueJobIds: ["child"] } });
  const before = rows(db);
  db.exec(`CREATE TRIGGER reject_backfill BEFORE UPDATE OF batch_state ON opencode_pipelines
    WHEN NEW.pipeline_id = 'reject' AND NEW.batch_state = 'legacy'
    BEGIN SELECT RAISE(ABORT, 'fixture backfill rejected'); END;`);
  assert.throws(() => schema.ensurePipelineRevisionSchema(db), /fixture backfill rejected/);
  assert.deepEqual(rows(db), before, "the failed statement must not leave partial owner or count mappings");
  db.exec("DROP TRIGGER reject_backfill");
  assert.equal(changes(db), 2);
  for (const id of ["first", "reject"]) mapping(db, id, { owner_instance_id: "json-owner", expected_child_count: 1, batch_state: "legacy" });
  unchanged(db);
}));

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-f9-backfill.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} F9 backfill tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
