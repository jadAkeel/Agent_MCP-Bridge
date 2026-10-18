import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { queueLeaseFixture, LEASE_NOW, leaseIso } from "./helpers/queue-lease-fixture.js";

const seed = Number(process.env.FC_SEED || 20261016);
const options = { seed, numRuns: 80, ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
function property(t, arbitrary, body, numRuns = options.numRuns) {
  const inputs = [];
  fc.assert(fc.property(arbitrary, sample => { inputs.push(sample); body(sample); }), { ...options, numRuns });
  t.diagnostic(`generated runs: ${inputs.length}; seed: ${seed}; path: ${process.env.FC_PATH || "<initial>"}`);
  if (process.env.FC_LEASE_TRACE === "1") t.diagnostic(`inputs: ${JSON.stringify(inputs)}`);
}
const active = ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"];
const terminal = ["completed", "failed", "cancelled", "interrupted", "not_resumable"];
const generation = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);

function preservedExcept(before, after, changes) {
  assert.deepEqual({ ...after }, { ...before, ...changes });
}
function localSnapshot(record) {
  return { ...record, aborted: record.abortController.signal.aborted,
    abortReason: record.abortController.signal.reason };
}
function seedRows(f, row = {}, instanceExpiry = leaseIso(1000)) {
  // Fixture setup commits once, before any method under test observes it.
  f.db.exec("BEGIN");
  try {
    f.insert(row);
    f.insert({ job_id: "unrelated", owner_instance_id: "foreign", owner_generation: "foreign-gen", revision: 91 });
    f.instance(instanceExpiry);
    f.instance(leaseIso(2000), "foreign");
    f.db.exec("COMMIT");
  } catch (error) { f.db.exec("ROLLBACK"); throw error; }
}

// Outcomes are contract examples, not an executable replica of SQL predicates.
const ownershipCases = [
  { name: "unchanged", row: {}, local: {}, renew: true, reacquire: true },
  { name: "replacement generation", row: { owner_generation: "replacement" }, local: {}, renew: false, reacquire: false },
  { name: "wrong local generation", row: {}, local: { ownerGeneration: "wrong" }, renew: false, reacquire: false },
  { name: "replacement instance", row: { owner_instance_id: "foreign" }, local: {}, renew: false, reacquire: false },
  { name: "blank local generation", row: {}, local: { ownerGeneration: "" }, renew: false, reacquire: false },
  { name: "blank durable generation", row: { owner_generation: "" }, local: {}, renew: false, reacquire: false },
  { name: "legacy matching blanks", row: { owner_generation: "" }, local: { ownerGeneration: "" }, renew: true, reacquire: false },
  { name: "null durable generation", row: { owner_generation: null }, local: {}, renew: false, reacquire: false },
  { name: "foreign revision", row: { revision: 8 }, local: {}, renew: true, reacquire: false },
];

function exerciseWrite(kind, { row = {}, local = {}, instanceExpiry = leaseIso(1000), missing = false, expected }, revision = 7) {
  const f = queueLeaseFixture();
  try {
    seedRows(f, { revision, ...row }, instanceExpiry);
    if (missing) f.db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("job");
    const record = f.local({ revision, ...local });
    const before = f.read(), unrelated = f.read("unrelated"), state = f.snapshot(), localBefore = localSnapshot(record);
    const method = kind === "renew" ? f.runtime.renewPersistedQueueRecordLease : f.runtime.reacquirePersistedQueueRecordLease;
    assert.equal(method(f.db, record, leaseIso(0), leaseIso(5000)), expected, `${kind}: ${JSON.stringify({ row, local, instanceExpiry, missing })}`);
    assert.deepEqual(f.read("unrelated"), unrelated);
    assert.deepEqual(f.snapshot().instances, state.instances);
    if (expected) {
      preservedExcept(before, f.read(), { heartbeat_at: leaseIso(0), lease_expires_at: leaseIso(5000), updated_at: leaseIso(0), revision: before.revision + 1 });
      assert.equal(record.revision, before.revision + 1);
      assert.equal(record.heartbeatAt, leaseIso(0));
      assert.equal(record.leaseExpiresAt, leaseIso(5000));
      assert.equal(record.abortController.signal.aborted, false);
      if (kind === "reacquire") {
        assert.equal(record.queueOwnershipLost, false);
        assert.equal(f.events.filter(e => e.event === "queue.lease_reacquired").length, 1);
      } else assert.ok(record.queueLeaseFenceTimer, "successful active renewal resets the local fence");
    } else {
      assert.deepEqual(f.snapshot(), state, "refused write leaves all durable state untouched");
      assert.deepEqual(localSnapshot(record), localBefore, "a refused CAS cannot revive or rewrite its local owner");
      assert.equal(f.events.length, 0);
    }
  } finally { f.close(); }
}

test("renewal and reacquisition ownership matrix includes legacy blanks and revision conflicts", () => {
  for (const c of ownershipCases) for (const kind of ["renew", "reacquire"]) {
    exerciseWrite(kind, { ...c, expected: c[kind] });
  }
  for (const kind of ["renew", "reacquire"]) exerciseWrite(kind, { missing: true, expected: false });
});

test("every active/terminal status and cancellation form has an explicit write outcome", () => {
  for (const status of active) for (const cancellation_requested_at of [null, ""]) {
    for (const kind of ["renew", "reacquire"]) exerciseWrite(kind, { row: { status, cancellation_requested_at }, expected: true });
  }
  for (const status of [...terminal, "unknown"]) for (const kind of ["renew", "reacquire"]) {
    exerciseWrite(kind, { row: { status }, expected: false });
  }
  for (const status of [...active, ...terminal]) for (const kind of ["renew", "reacquire"]) {
    exerciseWrite(kind, { row: { status, cancellation_requested_at: leaseIso(-1) }, expected: false });
  }
});

test("job and instance leases independently enforce the strict renewal deadline", () => {
  for (const field of ["job", "instance"]) for (const [expiry, allowed] of [
    [leaseIso(-1), false], [leaseIso(0), false], [leaseIso(1), true], ["", false], [null, false],
  ]) {
    const c = field === "job" ? { row: { lease_expires_at: expiry } } : { instanceExpiry: expiry };
    exerciseWrite("renew", { ...c, expected: allowed });
    exerciseWrite("reacquire", { ...c, expected: true, local: { queueOwnershipLost: true } });
  }
  const f = queueLeaseFixture();
  try {
    seedRows(f); f.db.exec("DELETE FROM bridge_instances");
    const record = f.local(), before = f.snapshot();
    assert.equal(f.runtime.renewPersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(5000)), false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.runtime.reacquirePersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(5000)), true);
  } finally { f.close(); }
});

test("generated owner identities and revisions obey the contract matrix", t => {
  property(t, fc.record({ identity: fc.integer({ min: 0, max: ownershipCases.length - 1 }),
    generation, revision: fc.integer({ min: 0, max: 1_000_000 }), kind: fc.constantFrom("renew", "reacquire") }), s => {
    const c = ownershipCases[s.identity];
    // Prefixes keep independently generated identities distinct in all cases.
    const row = { owner_generation: `g-${s.generation}`, ...c.row };
    const local = { ownerGeneration: `g-${s.generation}`, ...c.local };
    if (s.identity === 8) row.revision = s.revision + 1;
    exerciseWrite(s.kind, { row, local, expected: c[s.kind] }, s.revision);
  });
});

function exerciseSleepingRecovery(s) {
  const f = queueLeaseFixture();
  try {
    seedRows(f, { revision: s.revision, owner_generation: s.generation, lease_expires_at: leaseIso(-1) }, leaseIso(-1));
    const record = f.local({ revision: s.revision, ownerGeneration: s.generation, queueOwnershipLost: true });
    const sentinel = f.read("unrelated");
    let elapsed = 0, revision = s.revision;
    for (const delay of s.delays) {
      elapsed += delay + 1000; // Always later than the preceding granted lease; no sleep.
      assert.equal(f.runtime.reacquirePersistedQueueRecordLease(f.db, record, leaseIso(elapsed), leaseIso(elapsed + 1000)), true);
      assert.equal(record.revision, ++revision);
      assert.equal(record.queueOwnershipLost, false);
      assert.equal(record.abortController.signal.aborted, false);
      assert.equal(record.queueLeaseFenceTimer, undefined, "caller owns post-commit fencing after reacquisition");
    }
    const transitions = {
      generation: () => f.db.prepare("UPDATE opencode_jobs SET owner_generation = ?, revision = revision + 1 WHERE job_id = ?").run(`new-${s.generation}`, "job"),
      instance: () => f.db.prepare("UPDATE opencode_jobs SET owner_instance_id = ?, revision = revision + 1 WHERE job_id = ?").run("foreign", "job"),
      revision: () => f.db.prepare("UPDATE opencode_jobs SET revision = revision + 1 WHERE job_id = ?").run("job"),
      cancel: () => f.db.prepare("UPDATE opencode_jobs SET cancellation_requested_at = ? WHERE job_id = ?").run(leaseIso(elapsed), "job"),
      finish: () => f.db.prepare("UPDATE opencode_jobs SET status = ? WHERE job_id = ?").run("completed", "job"),
      delete: () => f.db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("job"),
    };
    transitions[s.transition]();
    const before = f.snapshot(), localBefore = localSnapshot(record);
    for (let n = 0; n < 2; n++) {
      assert.equal(f.runtime.reacquirePersistedQueueRecordLease(f.db, record, leaseIso(elapsed + 2000 + n), leaseIso(elapsed + 5000 + n)), false);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(localSnapshot(record), localBefore);
    }
    assert.deepEqual(f.read("unrelated"), sentinel);
  } finally { f.close(); }
}

test("each sleeping-owner takeover transition is refused deterministically after recovery", () => {
  for (const transition of ["generation", "instance", "revision", "cancel", "finish", "delete"]) {
    exerciseSleepingRecovery({ generation: "original", revision: 0, delays: [1, 100000], transition });
  }
});

test("reacquiring a stopped local record cannot revive its already aborted execution", () => {
  const f = queueLeaseFixture();
  try {
    seedRows(f, { lease_expires_at: leaseIso(-1) }, leaseIso(-1));
    const record = f.local();
    f.runtime.loseQueueOwnership(record, "execution stopped before recovery");
    const reason = record.abortController.signal.reason;
    assert.equal(f.runtime.reacquirePersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(1000)), true);
    assert.equal(record.queueOwnershipLost, false, "lease metadata can be recovered");
    assert.equal(record.abortController.signal.aborted, true, "the old execution remains stopped");
    assert.equal(record.abortController.signal.reason, reason);
    assert.equal(record.queueLeaseFenceTimer, undefined, "reacquisition does not arm a new execution fence");
  } finally { f.close(); }
});

test("generated sleeping-owner recovery cannot cross a later takeover or cancellation", t => {
  property(t, fc.record({ generation, revision: fc.integer({ min: 0, max: 10000 }),
    delays: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }),
    transition: fc.constantFrom("generation", "instance", "revision", "cancel", "finish", "delete") }), exerciseSleepingRecovery);
});

const probeCases = [
  { name: "live", row: {}, expected: "ok" },
  ...["validating", "reviewing", "testing"].map(status => ({ name: status, row: { status }, expected: "ok" })),
  ...["held", "pending", "planned", "blocked", "unknown"].map(status => ({ name: status, row: { status }, expected: "queue_ownership_lost" })),
  { name: "replaced generation", row: { owner_generation: "replacement" }, expected: "queue_ownership_lost" },
  { name: "blank generation", row: { owner_generation: "" }, expected: "queue_ownership_lost" },
  { name: "replaced instance", row: { owner_instance_id: "foreign" }, expected: "queue_ownership_lost" },
  { name: "missing", row: {}, missing: true, expected: "queue_ownership_lost" },
  ...[-1, 0].map(delta => ({ name: `job expiry ${delta}`, row: { lease_expires_at: leaseIso(delta) }, expected: "queue_ownership_lost" })),
  ...[-1, 0].map(delta => ({ name: `instance expiry ${delta}`, row: {}, instanceExpiry: leaseIso(delta), expected: "queue_ownership_lost" })),
  ...["", null, "invalid-date"].map(expiry => ({ name: `invalid job expiry ${expiry}`, row: { lease_expires_at: expiry }, expected: "queue_ownership_lost" })),
  ...["", null, "invalid-date"].map(expiry => ({ name: `invalid instance expiry ${expiry}`, row: {}, instanceExpiry: expiry, expected: "queue_ownership_lost" })),
  { name: "missing instance", row: {}, missingInstance: true, expected: "queue_ownership_lost" },
  { name: "revision alone is not ownership loss", row: { revision: 8 }, expected: "ok" },
  { name: "one millisecond before both deadlines", row: { lease_expires_at: leaseIso(1) }, instanceExpiry: leaseIso(1), expected: "ok" },
  ...terminal.map(status => ({ name: status, row: { status }, expected: status === "cancelled" ? "agent_cancelled" : "queue_job_finished_elsewhere" })),
  { name: "cancel request", row: { cancellation_requested_at: leaseIso(-1), revision: 9 }, expected: "agent_cancelled" },
  { name: "cancel overrides foreign completed row", row: { status: "completed", owner_generation: "replacement", owner_instance_id: "foreign", cancellation_requested_at: leaseIso(-1) }, expected: "agent_cancelled" },
  { name: "finished overrides expired replaced owner", row: { status: "failed", owner_generation: "replacement", lease_expires_at: leaseIso(-1) }, expected: "queue_job_finished_elsewhere" },
];

function checkProbe(f, record, probe, expected) {
  const before = f.snapshot(), localBefore = localSnapshot(record), eventsBefore = f.events.length, wakesBefore = f.wakes;
  if (expected === "ok") {
    assert.doesNotThrow(() => probe.check());
    assert.deepEqual(localSnapshot(record), localBefore, "ownership checks do not extend local leases or replace fences");
    assert.equal(f.events.length, eventsBefore);
    assert.equal(f.wakes, wakesBefore);
  } else {
    assert.throws(() => probe.check(), error => error.errorType === expected);
    assert.equal(record.queueOwnershipLost, true);
    assert.equal(record.abortController.signal.aborted, true);
    assert.equal(record.abortController.signal.reason.errorType, expected);
    assert.equal(Boolean(record.cancellationRequested), expected === "agent_cancelled");
    assert.equal(f.wakes, wakesBefore + (expected === "queue_ownership_lost" ? 0 : 1));
    assert.equal(f.events.at(-1).event, expected === "queue_ownership_lost" ? "queue.ownership_lost" : "queue.ownership_released");
    assert.equal(f.events.at(-1).level, expected === "queue_ownership_lost" ? "error" : "info");
    if (expected === "agent_cancelled") {
      assert.equal(record.revision, f.read().revision);
      assert.equal(record.cancellationRequestedAt, f.read().cancellation_requested_at || "");
    }
    const count = f.events.length, wakes = f.wakes;
    assert.throws(() => probe.check(), error => error.errorType === expected);
    assert.equal(f.events.length, count, "repeated loss/release is locally idempotent");
    assert.equal(f.wakes, wakes);
  }
  assert.deepEqual(f.snapshot(), before, "probe reads must not write jobs, instances, revision, JSON or file bytes");
}

test("read-only wait probe distinguishes cancellation, completion and ownership loss at exact deadlines", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  for (const c of probeCases) {
    const f = queueLeaseFixture({ file: true });
    try {
      seedRows(f, c.row, c.instanceExpiry === undefined ? leaseIso(1000) : c.instanceExpiry);
      if (c.missing) f.db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("job");
      if (c.missingInstance) f.db.prepare("DELETE FROM bridge_instances WHERE instance_id = ?").run("local");
      const record = f.local(), probe = f.probe(record);
      checkProbe(f, record, probe, c.expected);
      probe.close(); probe.close();
      assert.equal(f.probeCloses, 1, c.name);
    } finally { f.close(); }
  }
});

test("generated open probes observe later durable transitions without extending either lease", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  property(t, fc.record({ generation, revision: fc.integer({ min: 1, max: 10000 }),
    transition: fc.integer({ min: 0, max: probeCases.length - 1 }), checks: fc.integer({ min: 1, max: 4 }) }), s => {
    const f = queueLeaseFixture({ file: true });
    try {
      seedRows(f, { owner_generation: `g-${s.generation}`, revision: s.revision });
      const record = f.local({ ownerGeneration: `g-${s.generation}`, revision: s.revision }), probe = f.probe(record);
      for (let n = 0; n < s.checks; n++) checkProbe(f, record, probe, "ok");
      const c = probeCases[s.transition];
      for (const [column, value] of Object.entries(c.row)) f.db.prepare(`UPDATE opencode_jobs SET ${column} = ? WHERE job_id = ?`).run(value, "job");
      if (c.instanceExpiry !== undefined) f.db.prepare("UPDATE bridge_instances SET lease_expires_at = ? WHERE instance_id = ?").run(c.instanceExpiry, "local");
      if (c.missing) f.db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("job");
      if (c.missingInstance) f.db.prepare("DELETE FROM bridge_instances WHERE instance_id = ?").run("local");
      checkProbe(f, record, probe, c.expected);
    } finally { f.close(); }
  }, 40);
});

test("handover classification and local release use the same explicit terminal/cancellation contract", () => {
  for (const c of probeCases) {
    const f = queueLeaseFixture();
    try {
      seedRows(f, c.row);
      if (c.missing) f.db.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("job");
      const record = f.local(), before = f.snapshot();
      const handover = f.runtime.queueOwnershipHandover(f.db, record);
      const released = ["agent_cancelled", "queue_job_finished_elsewhere"].includes(c.expected);
      if (released) {
        assert.equal(handover.errorType, c.expected);
        assert.equal(handover.rowStatus, f.read().status);
        assert.equal(handover.reason, c.expected === "agent_cancelled" ? "cancelled" : "finished");
        f.runtime.releaseQueueOwnership(record, handover);
        f.runtime.releaseQueueOwnership(record, handover);
        f.runtime.loseQueueOwnership(record, "later duplicate loss");
        assert.equal(record.abortController.signal.reason.errorType, c.expected);
        assert.equal(record.queueOwnershipLost, true);
        assert.equal(Boolean(record.cancellationRequested), c.expected === "agent_cancelled");
        assert.equal(f.wakes, 1);
        assert.equal(f.events.length, 1);
        assert.equal(f.events[0].level, "info");
      } else assert.equal(handover, null);
      assert.deepEqual(f.snapshot(), before);
    } finally { f.close(); }
  }
});

test("successful renewal replaces its fence while resetFence false defers changes until caller commit", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: LEASE_NOW });
  const f = queueLeaseFixture();
  try {
    seedRows(f);
    const record = f.local();
    f.runtime.resetQueueLeaseFence(record);
    const initial = record.queueLeaseFenceTimer;
    assert.equal(f.runtime.renewPersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(3000)), true);
    assert.notEqual(record.queueLeaseFenceTimer, initial);
    t.mock.timers.tick(900); // Previous fence deadline; replaced renewal must survive it.
    assert.equal(record.abortController.signal.aborted, false);
    const current = record.queueLeaseFenceTimer;
    assert.equal(f.runtime.renewPersistedQueueRecordLease(f.db, record, leaseIso(900), leaseIso(6000), { resetFence: false }), true);
    assert.equal(record.queueLeaseFenceTimer, current);
    f.runtime.resetQueueLeaseFence(record); // Synthetic after-commit boundary.
    t.mock.timers.tick(4999); // new deadline minus guard minus one
    assert.equal(record.abortController.signal.aborted, false);
    t.mock.timers.tick(1); // Exactly 5900: the fail-closed fence precedes lease expiry.
    assert.equal(record.abortController.signal.aborted, true);
    assert.equal(record.abortController.signal.reason.errorType, "queue_ownership_lost");
  } finally { f.close(); }
});

test("renewal publishes wait metadata without replacing unrelated JSON or emitting ownership writes on refusal", t => {
  property(t, fc.record({ waiting: fc.boolean(), revision: fc.integer({ min: 0, max: 10000 }),
    seconds: fc.integer({ min: 0, max: 600 }), conflict: fc.boolean() }), s => {
    const f = queueLeaseFixture();
    try {
      seedRows(f, { revision: s.revision, ...(s.conflict ? { owner_generation: "replacement" } : {}) });
      const info = { waiting: s.waiting, waitedMs: s.seconds * 1000 };
      const record = f.local({ revision: s.revision, providerWaitInfo: info });
      const before = f.snapshot();
      assert.equal(f.runtime.renewPersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(5000), { resetFence: false }), !s.conflict);
      if (s.conflict) assert.deepEqual(f.snapshot(), before);
      else {
        assert.deepEqual(JSON.parse(f.read().record_json), { sentinel: "preserve", nested: { value: 42 }, ...(s.waiting ? { providerWaitInfo: info } : {}) });
        assert.equal(record.queuePublishedWaitInfo, s.waiting ? JSON.stringify(info) : "");
        assert.equal(f.read().revision, s.revision + 1);
      }
      assert.deepEqual(f.read("unrelated"), before.jobs.find(row => row.job_id === "unrelated"));
      assert.deepEqual(f.snapshot().instances, before.instances);
    } finally { f.close(); }
  });
});

test("reacquisition alone cannot pass a wait probe while its instance lease is expired", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  const f = queueLeaseFixture({ file: true });
  try {
    seedRows(f, { lease_expires_at: leaseIso(-100000) }, leaseIso(-100000));
    const record = f.local({ leaseExpiresAt: leaseIso(-100000) });
    assert.equal(f.runtime.reacquirePersistedQueueRecordLease(f.db, record, leaseIso(0), leaseIso(1000)), true);
    const probe = f.probe(record);
    checkProbe(f, record, probe, "queue_ownership_lost");
    f.instance(leaseIso(1000)); // Synthetic instance registration, owned by the real caller.
    const current = f.local({ revision: record.revision });
    checkProbe(f, current, f.probe(current), "ok");
    assert.equal(record.abortController.signal.aborted, true, "a previously stopped execution is never revived");
  } finally { f.close(); }
});

test("renewal failure fencing is conservative at its exact heartbeat guard and definitive losses are idempotent", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  const f = queueLeaseFixture();
  try {
    for (const [expiry, definitive, lost] of [
      [leaseIso(101), false, false], [leaseIso(100), false, true],
      [leaseIso(99), false, true], [leaseIso(1000), true, true], ["invalid", false, true],
    ]) {
      const record = f.local({ leaseExpiresAt: expiry });
      const before = f.snapshot(), count = f.events.length;
      f.runtime.noteQueueLeaseRenewalFailure(record, { definitive });
      assert.equal(record.queueOwnershipLost, lost);
      assert.equal(record.abortController.signal.aborted, lost);
      assert.equal(f.events.length, count + Number(lost));
      if (lost) {
        const reason = record.abortController.signal.reason;
        f.runtime.loseQueueOwnership(record, "duplicate loss");
        assert.equal(record.abortController.signal.reason, reason);
        assert.equal(f.events.length, count + 1);
      }
      assert.deepEqual(f.snapshot(), before);
    }
  } finally { f.close(); }
});

test("watchdog renewal uses the real SQL gate, stops cancelled owners and never silently reacquires", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: LEASE_NOW });
  for (const c of [
    { row: {}, ok: true },
    { row: { cancellation_requested_at: leaseIso(-1) }, ok: false },
    { row: { owner_generation: "replacement" }, ok: false },
    { row: { lease_expires_at: leaseIso(0) }, ok: false },
  ]) {
    const f = queueLeaseFixture();
    try {
      seedRows(f, c.row);
      const record = f.local(), before = f.snapshot();
      const result = await f.runtime.renewQueueRecordDurableOwnership(record);
      assert.equal(result.ok, c.ok);
      if (c.ok) {
        assert.equal(result.deadlineAt, LEASE_NOW + 1000);
        assert.equal(record.revision, 8);
        assert.equal(record.queueOwnershipLost, false);
      } else {
        assert.equal(record.queueOwnershipLost, true);
        assert.equal(record.abortController.signal.reason.errorType, "queue_ownership_lost");
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.events.some(e => e.event === "queue.lease_reacquired"), false);
      }
      assert.deepEqual(f.read("unrelated"), before.jobs.find(row => row.job_id === "unrelated"));
    } finally { f.close(); }
  }
});

test("a probe preparation failure closes its new read-only handle and later recovery still works", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  const f = queueLeaseFixture({ file: true });
  try {
    seedRows(f);
    const record = f.local(), unrelated = f.read("unrelated");
    f.db.exec("DROP TABLE bridge_instances");
    const changes = f.db.prepare("SELECT total_changes() AS n").get().n;
    assert.throws(() => f.probe(record), /no such table: bridge_instances/);
    assert.equal(f.probeCloses, 1, "a failed prepare must close the separate read-only connection");
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, changes);
    assert.deepEqual(f.read("unrelated"), unrelated, "the fixture's original writable connection remains usable");
    f.db.exec("CREATE TABLE bridge_instances (instance_id TEXT PRIMARY KEY, heartbeat_at TEXT, lease_expires_at TEXT)");
    f.instance();
    const probe = f.probe(record);
    assert.doesNotThrow(() => probe.check());
    probe.close();
    assert.equal(f.probeCloses, 2);
  } finally { f.close(); }
});

test("default renewal-failure options tolerate a transient failure and report a guarded expiry", t => {
  t.mock.method(Date, "now", () => LEASE_NOW);
  const f = queueLeaseFixture();
  try {
    const record = f.local(), before = localSnapshot(record);
    f.runtime.noteQueueLeaseRenewalFailure(record);
    assert.deepEqual(localSnapshot(record), before, "the default is not a definitive ownership loss");
    assert.equal(f.events.length, 0);
    record.leaseExpiresAt = leaseIso(100);
    f.runtime.noteQueueLeaseRenewalFailure(record);
    assert.equal(record.queueOwnershipLost, true);
    assert.equal(record.abortController.signal.reason.errorType, "queue_ownership_lost");
    assert.ok(record.abortController.signal.reason.message.length > 0, "default failure reason remains actionable");
    assert.equal(f.events.length, 1);
  } finally { f.close(); }
});
