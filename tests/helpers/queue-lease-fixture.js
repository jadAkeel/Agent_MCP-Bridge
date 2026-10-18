import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createQueueLeaseRuntime } from "../../lib/queue/leases.js";

export const LEASE_NOW = Date.parse("2026-10-16T12:00:00.000Z");
export const leaseIso = delta => new Date(LEASE_NOW + delta).toISOString();

// Actual exported SQL runtime. Only the columns used by renewal/reacquisition,
// handover and wait/spawn checks exist. Instance registration, project lookup,
// event delivery and scheduling are synthetic boundaries, never bridge startup.
export function queueLeaseFixture({ file = false } = {}) {
  let parent, root, marker;
  if (file) {
    parent = realpathSync(tmpdir());
    const checkout = realpathSync(path.resolve(import.meta.dirname, "../.."));
    const relative = path.relative(checkout, parent);
    // Even the sandbox's 93-character canonical TEMP yields a flat DB path
    // below 150 characters; avoid nesting under the long checkout/evidence root.
    if (!path.isAbsolute(parent) || parent.length > 120 || parent.startsWith("\\\\")
      || relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error("Lease fixture needs a short canonical external local TEMP.");
    }
    root = realpathSync(mkdtempSync(path.join(parent, "ql-")));
    marker = randomUUID();
    writeFileSync(path.join(root, "owner.txt"), marker, { flag: "wx" });
  }
  const dbPath = file ? path.join(root, "state.db") : ":memory:";
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY,
    owner_instance_id TEXT, owner_generation TEXT, status TEXT,
    heartbeat_at TEXT, lease_expires_at TEXT, updated_at TEXT,
    cancellation_requested_at TEXT, revision INTEGER, record_json TEXT);
    CREATE TABLE bridge_instances (instance_id TEXT PRIMARY KEY,
      heartbeat_at TEXT, lease_expires_at TEXT);`);
  const events = [], records = new Set(), probes = new Set();
  let wakes = 0, probeCloses = 0;
  const unexpected = () => { throw new Error("Unexpected out-of-scope lease fixture boundary"); };
  const runtime = createQueueLeaseRuntime({
    BRIDGE_INSTANCE_ID: "local", CONFIG: { queueHeartbeatMs: 100, queueLeaseMs: 1000 },
    KNOWN_STATE_DB_PATHS: new Set(), PIPELINE_RUNS: new Map(), QUEUE_JOBS: new Map(),
    statePruneTimes: new Map(), effectiveQueueMode: () => "sqlite",
    stateDbPath: () => dbPath, openLockDb: async () => db,
    closeDb: handle => { if (handle !== db) { handle.close(); probeCloses++; } },
    logEvent: (level, event, fields) => events.push({ level, event, fields }),
    wakeQueue: () => { wakes++; }, expireLocksFromDb: unexpected,
    propagatePipelineTerminalInTransaction: unexpected, scheduleQueueRetryPolicy: unexpected,
  });
  function insert(overrides = {}) {
    const row = { job_id: "job", owner_instance_id: "local", owner_generation: "gen",
      status: "running", heartbeat_at: leaseIso(-500), lease_expires_at: leaseIso(1000),
      updated_at: leaseIso(-500), cancellation_requested_at: "", revision: 7,
      record_json: JSON.stringify({ sentinel: "preserve", nested: { value: 42 } }), ...overrides };
    db.prepare(`INSERT INTO opencode_jobs (${Object.keys(row).join(",")})
      VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row;
  }
  function local(overrides = {}) {
    const record = { jobId: "job", cwd: root || "synthetic-project", ownerInstanceId: "local",
      ownerGeneration: "gen", revision: 7, status: "running", heartbeatAt: leaseIso(-500),
      leaseExpiresAt: leaseIso(1000), queueOwnershipLost: false,
      abortController: new AbortController(), ...overrides };
    records.add(record);
    return record;
  }
  const read = (id = "job") => db.prepare("SELECT * FROM opencode_jobs WHERE job_id = ?").get(id);
  const snapshot = () => ({
    jobs: db.prepare("SELECT * FROM opencode_jobs ORDER BY job_id").all(),
    instances: db.prepare("SELECT * FROM bridge_instances ORDER BY instance_id").all(),
    ...(file ? { fileSha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex") } : {}),
    changes: db.prepare("SELECT total_changes() AS n").get().n,
  });
  return { db, runtime, events, insert, local, read, snapshot,
    get wakes() { return wakes; }, get probeCloses() { return probeCloses; },
    instance: (expiry = leaseIso(1000), id = "local") => db.prepare(
      "INSERT OR REPLACE INTO bridge_instances VALUES (?, ?, ?)").run(id, leaseIso(-500), expiry),
    probe: record => { const probe = runtime.createQueueWaitOwnershipProbe(record); probes.add(probe); return probe; },
    close() {
      for (const probe of probes) probe.close();
      for (const record of records) runtime.clearQueueLeaseFence(record);
      db.close();
      if (file) {
        if (path.dirname(root) !== parent || !path.basename(root).startsWith("ql-")
          || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root
          || readFileSync(path.join(root, "owner.txt"), "utf8") !== marker) {
          throw new Error("Lease fixture cleanup refused an unexpected owner/root.");
        }
        rmSync(root, { recursive: true, force: false });
      }
    },
  };
}
