import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

import { createStateRetentionService } from "../../src/v2/persistence/state-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let now = Date.parse("2026-08-14T09:00:00.000Z");
const old = new Date(now - 3 * DAY_MS).toISOString();
const recent = new Date(now - DAY_MS).toISOString();

let disabledClockCalls = 0;
const idle = createStateRetentionService({
  config: { queueRetentionDays: 0 },
  queueJobs: new Map([["kept", { status: "completed", createdAt: old }]]),
  pipelineRuns: new Map([["kept", { status: "failed", createdAt: old }]]),
  clockNow: () => {
    disabledClockCalls += 1;
    return now;
  },
});
assert.deepEqual(Object.keys(idle), ["pruneInMemoryState", "prunePersistedState"]);
idle.pruneInMemoryState();
idle.prunePersistedState({ prepare: () => { throw new Error("must not query"); } }, "disabled.sqlite");
assert.equal(disabledClockCalls, 1, "The default pruneInMemoryState timestamp is evaluated before the disabled-retention guard, matching the legacy function.");

const queueJobs = new Map([
  ["old-completed", { status: "completed", createdAt: old }],
  ["old-cancelled", { status: "cancelled", createdAt: old }],
  ["old-running", { status: "running", createdAt: old }],
  ["recent-failed", { status: "failed", createdAt: recent }],
  ["invalid-date", { status: "completed", createdAt: "not-a-date" }],
]);
const pipelineRuns = new Map([
  ["old-interrupted", { status: "interrupted", createdAt: old }],
  ["old-not-resumable", { status: "not_resumable", createdAt: old }],
  ["old-running", { status: "running", createdAt: old }],
  ["recent-completed", { status: "completed", createdAt: recent }],
]);
const retention = createStateRetentionService({
  config: { queueRetentionDays: 2 },
  queueJobs,
  pipelineRuns,
  clockNow: () => now,
});

retention.pruneInMemoryState();
assert.deepEqual([...queueJobs.keys()], ["old-running", "recent-failed", "invalid-date"]);
assert.deepEqual([...pipelineRuns.keys()], ["old-running", "recent-completed"]);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE opencode_pipelines (pipeline_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const insertJob = db.prepare("INSERT INTO opencode_jobs (job_id, status, created_at) VALUES (?, ?, ?)");
  const insertPipeline = db.prepare("INSERT INTO opencode_pipelines (pipeline_id, status, created_at) VALUES (?, ?, ?)");
  insertJob.run("old-terminal", "completed", old);
  insertJob.run("old-active", "running", old);
  insertJob.run("recent-terminal", "failed", recent);
  insertPipeline.run("old-terminal", "not_resumable", old);
  insertPipeline.run("old-active", "testing", old);
  insertPipeline.run("recent-terminal", "cancelled", recent);

  retention.prunePersistedState(db, "state-a.sqlite");
  assert.deepEqual(db.prepare("SELECT job_id FROM opencode_jobs ORDER BY job_id").all().map((row) => row.job_id), ["old-active", "recent-terminal"]);
  assert.deepEqual(db.prepare("SELECT pipeline_id FROM opencode_pipelines ORDER BY pipeline_id").all().map((row) => row.pipeline_id), ["old-active", "recent-terminal"]);

  insertJob.run("throttled-job", "failed", old);
  insertPipeline.run("throttled-pipeline", "completed", old);
  now += 5 * 60 * 1000 - 1;
  retention.prunePersistedState(db, "state-a.sqlite");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE job_id = 'throttled-job'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_pipelines WHERE pipeline_id = 'throttled-pipeline'").get().count, 1);

  retention.prunePersistedState(db, "state-b.sqlite");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE job_id = 'throttled-job'").get().count, 0, "Throttle state must be isolated by database path.");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_pipelines WHERE pipeline_id = 'throttled-pipeline'").get().count, 0);

  insertJob.run("after-window", "interrupted", old);
  now += 1;
  retention.prunePersistedState(db, "state-a.sqlite");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE job_id = 'after-window'").get().count, 0, "The same database must prune again at the exact five-minute boundary.");
} finally {
  db.close();
}

console.log("V2 state retention tests passed.");
