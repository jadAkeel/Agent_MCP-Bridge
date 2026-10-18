import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fc from "fast-check";
import { lockFixture } from "./helpers/lock-fixture.js";

const seed = Number(process.env.FC_SEED || 20261016);
const options = { seed, ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
const paths = ["src/a.txt", "src/b.txt", "src/nested/c.txt", "src/nested", "docs/a.md", "docs-extra/a.md"];
const selection = fc.uniqueArray(fc.constantFrom(...paths), { minLength: 1, maxLength: 3 });
const type = fc.constantFrom("read", "write", "serial_integration");

async function property(t, arbitrary, runs, body) {
  let samples = 0;
  await fc.assert(fc.asyncProperty(arbitrary, async sample => {
    samples++;
    await body(sample);
  }), { ...options, numRuns: runs });
  t.diagnostic(`generated runs: ${samples}; seed: ${seed}`);
}

// An independent segment-tree oracle: descendants share an ancestor, while
// lexical siblings (docs vs docs-extra) don't. No production normalizer is used.
function intersects(left, right) {
  return left.some(a => right.some(b => {
    const aa = a.split("/"), bb = b.split("/");
    return aa.slice(0, Math.min(aa.length, bb.length)).every((part, i) => part === bb[i]);
  }));
}

function compatible(request, held) {
  if (request.kind === "read" && held.kind === "read") return true;
  const pair = [request, held];
  if (pair.some(lock => lock.kind === "serial_integration")) {
    const other = pair.find(lock => lock.kind !== "serial_integration");
    if (!other || other.kind !== "write" || other.checkout) return false;
  }
  return !intersects(request.paths, held.paths);
}

test("the complete lock compatibility matrix and legacy rows retain repository serialization", () => {
  const f = lockFixture();
  try {
    let assertions = 0;
    for (const requested of ["read", "write", "serial_integration"]) {
      for (const active of ["read", "write", "serial_integration"]) {
        for (const checkout of [true, false]) {
          for (const relation of ["same", "ancestor", "disjoint"]) {
            const request = { lockType: requested, paths: ["src/nested/a.txt"], editsCheckout: checkout };
            const held = { id: "held", lockType: active, paths: [relation === "same" ? "src/nested/a.txt"
              : relation === "ancestor" ? "src" : "docs/a.txt"], editsCheckout: checkout };
            // Explicit admission table, independent of the generated sequence oracle.
            const rules = {
              "read/read": "never", "read/write": "overlap", "read/serial_integration": "repository",
              "write/read": "overlap", "write/write": "overlap", "write/serial_integration": checkout ? "repository" : "overlap",
              "serial_integration/read": "repository", "serial_integration/write": checkout ? "repository" : "overlap",
              "serial_integration/serial_integration": "repository",
            };
            const rule = rules[`${requested}/${active}`];
            const expected = rule === "repository" || rule === "overlap" && relation !== "disjoint";
            for (const mode of ["on", "off"]) {
              assert.equal(Boolean(f.runtime(mode).conflictsWithActiveLock(request, held)), expected);
              assert.equal(Boolean(f.runtime(mode).conflictsWithActiveLock(held, request)), expected);
              assertions += 2;
            }
          }
        }
      }
    }
    const integration = { lockType: "serial_integration", paths: ["docs/a.md"] };
    const legacy = f.runtime().rowsToLocks([{ run_id: "legacy-writer", lock_mode: "write", normalized_path: "src/a.txt",
      acquisition_origin: "internal", edits_checkout: null, created_at: 1, expires_at: Number.MAX_SAFE_INTEGER }])[0];
    assert.equal(legacy.editsCheckout, true);
    for (const mode of ["on", "off"]) assert.ok(f.runtime(mode).conflictsWithActiveLock(integration, legacy));
    assert.equal(assertions, 216);
    // An in-memory request without a persisted flag follows the originating
    // bridge's mode; a loaded legacy row above has already been made conservative.
    for (const [mode, origin, expected] of [["on", "internal", false], ["on", "manual", true],
      ["on", undefined, false], ["off", "internal", true], ["off", "manual", true], ["off", undefined, true]]) {
      const writer = { id: "unpersisted", lockType: "write", paths: ["src/a.txt"], ...(origin ? { origin } : {}) };
      assert.equal(Boolean(f.runtime(mode).conflictsWithActiveLock(integration, writer)), expected);
      assert.equal(Boolean(f.runtime(mode).conflictsWithActiveLock(writer, integration)), expected);
    }
  } finally { f.close(); }
});

test("generated acquire/release/expiry sequences preserve conflict exclusion and token ownership", async t => {
  const action = fc.oneof(
    fc.record({ op: fc.constant("acquire"), kind: type, paths: selection,
      checkout: fc.boolean(), mode: fc.constantFrom("on", "off") }),
    fc.record({ op: fc.constantFrom("release", "foreign"), index: fc.nat({ max: 30 }) }),
    fc.record({ op: fc.constant("advance"), ms: fc.constantFrom(999, 1000, 1001, 2001) }),
  );
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await property(t, fc.array(action, { minLength: 8, maxLength: 30 }), 100, async actions => {
    const f = lockFixture(), held = new Map();
    try {
      for (const entry of actions) {
        if (entry.op === "advance") {
          now += entry.ms;
          f.runtime().expireLocksFromDb(f.db, now);
          for (const [id, lock] of held) if (lock.expiresAt <= now) held.delete(id);
        } else if (entry.op === "acquire") {
          const expected = [...held.values()].every(lock => compatible(entry, lock));
          const result = await f.acquire({ lockType: entry.kind, paths: entry.paths,
            editsCheckout: entry.checkout, ttlMs: 1000 }, entry.mode);
          assert.equal(result.ok, expected, JSON.stringify({ entry, held: [...held.values()] }));
          if (result.ok) {
            held.set(result.lock.id, { ...entry, ...result.lock });
            assert.equal(result.lock.expiresAt, now + 1000);
          }
        } else if (held.size) {
          const lock = [...held.values()][entry.index % held.size];
          const before = f.rows();
          const result = await f.release(lock, entry.op === "foreign" ? { token: "unrelated-token" } : {});
          assert.equal(result.ok, entry.op === "release");
          if (entry.op === "release") held.delete(lock.id);
          else assert.deepEqual(f.rows(), before, "a foreign token cannot change any lock row");
        }
        const actual = await f.runtime().listLocks(f.root);
        assert.deepEqual(actual.map(lock => lock.id).sort(), [...held.keys()].sort());
        for (const lock of actual) {
          assert.deepEqual([...lock.paths].sort(), [...held.get(lock.id).paths].sort());
          assert.equal(lock.editsCheckout, held.get(lock.id).checkout);
        }
      }
    } finally { f.close(); }
  });
});

test("generated partial release keeps the run and queue association until the final owned path", async t => {
  await property(t, fc.uniqueArray(fc.constantFrom(...paths), { minLength: 2, maxLength: 5 }), 70, async scope => {
    const f = lockFixture();
    try {
      const acquired = await f.acquire({ paths: scope });
      assert.equal(acquired.ok, true);
      const lock = acquired.lock;
      f.db.prepare("INSERT INTO queue_job_locks VALUES (?, 'job-1', 'generation-1')").run(lock.id);
      const tokenDigest = `sha256:${createHash("sha256").update(lock.token).digest("hex")}`;
      assert.ok(f.rows().every(row => row.token === tokenDigest && !row.task.includes("synthetic private task")));
      for (let index = 0; index < scope.length; index++) {
        const result = await f.release(lock, { paths: [scope[index]] });
        assert.equal(result.ok, true);
        const remains = index + 1 < scope.length;
        assert.equal(f.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status, remains ? "running" : "released");
        assert.equal(Boolean(f.db.prepare("SELECT 1 FROM queue_job_locks WHERE lock_id = ?").get(lock.id)), remains);
        assert.equal(f.rows().length, scope.length - index - 1);
      }
      assert.equal((await f.release(lock)).ok, false, "a stale release receipt does not release again");
    } finally { f.close(); }
  });
});

test("generated persisted writer location governs integration across bridges with different modes", async t => {
  await property(t, fc.record({ holderMode: fc.constantFrom("on", "off"), requesterMode: fc.constantFrom("on", "off"),
    manual: fc.boolean(), explicit: fc.constantFrom(undefined, true, false), overlap: fc.boolean() }), 100, async s => {
    const f = lockFixture();
    try {
      const writer = await f.acquire({ paths: ["src/a.txt"], origin: s.manual ? "manual" : "internal",
        ...(s.explicit === undefined ? {} : { editsCheckout: s.explicit }) }, s.holderMode);
      assert.equal(writer.ok, true);
      const writesCheckout = s.explicit ?? (s.manual || s.holderMode === "off");
      assert.equal(f.rows()[0].edits_checkout, writesCheckout ? 1 : 0);
      const integration = await f.acquire({ lockType: "serial_integration",
        paths: [s.overlap ? "src/a.txt" : "docs/a.md"] }, s.requesterMode);
      assert.equal(integration.ok, !writesCheckout && !s.overlap);
    } finally { f.close(); }
  });
});

test("generated queue generation and cancellation refusals leave no acquired rows or associations", async t => {
  await property(t, fc.record({ state: fc.constantFrom("running", "validating", "reviewing", "testing", "cancelled", "completed", "pending"),
    sameInstance: fc.boolean(), sameGeneration: fc.boolean(), blankGeneration: fc.boolean(), cancelled: fc.boolean(), manual: fc.boolean() }), 100, async s => {
    const f = lockFixture();
    try {
      f.db.prepare("INSERT INTO opencode_jobs VALUES ('job-1', 'owner-1', ?, ?, ?)")
        .run(s.blankGeneration ? "" : "generation-1", s.state, s.cancelled ? "cancel-now" : "");
      const expected = ["running", "validating", "reviewing", "testing"].includes(s.state)
        && s.sameInstance && s.sameGeneration && !s.blankGeneration && !s.cancelled && !s.manual;
      const result = await f.acquire({ paths: ["src/a.txt", "src/b.txt"], origin: s.manual ? "manual" : "internal",
        queueOwner: { jobId: "job-1", ownerInstanceId: s.sameInstance ? "owner-1" : "owner-other",
          ownerGeneration: s.sameGeneration ? "generation-1" : "generation-other" } });
      assert.equal(result.ok, expected);
      assert.equal(f.rows().length, expected ? 2 : 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, expected ? 1 : 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM queue_job_locks").get().n, expected ? 1 : 0);
      if (!expected) assert.equal(result.errorType, "queue_ownership_lost");
    } finally { f.close(); }
  });
});

test("generated recovery barriers reserve bypass for explicit internal authority", async t => {
  await property(t, fc.record({ barrier: fc.constantFrom("memory", "durable"), kind: type,
    manual: fc.boolean(), authority: fc.boolean() }), 70, async s => {
    const f = lockFixture();
    try {
      if (s.barrier === "memory") f.blocked.add(f.root);
      else f.db.prepare("INSERT INTO integration_operations VALUES ('operation-1', ?, 'prepared', 'now')").run(f.root);
      const result = await f.acquire({ lockType: s.kind, paths: ["src/a.txt"],
        agent: "integration_recovery", origin: s.manual ? "manual" : "internal", integrationRecoveryAuthority: s.authority });
      const expected = s.kind === "read" || s.authority && !s.manual;
      assert.equal(result.ok, expected);
      if (!expected) {
        assert.equal(result.errorType, "integration_recovery_pending");
        assert.equal(f.rows().length, 0);
      }
    } finally { f.close(); }
  });
});

test("each resolved integration journal status admits normal work without recovery authority", async () => {
  for (const status of ["committed", "rolled_back", "recovered_noop", "recovered_verified", "resolved_by_operator"]) {
    for (const lockType of ["read", "write", "serial_integration"]) {
      const f = lockFixture();
      try {
        f.db.prepare("INSERT INTO integration_operations VALUES ('operation-1', ?, ?, 'now')").run(f.root, status);
        assert.equal((await f.acquire({ paths: ["src/a.txt"], lockType })).ok, true, `${status}/${lockType}`);
      } finally { f.close(); }
    }
  }
});

test("generated quarantine restores pruned scope and heartbeat cannot turn it back into an expiring lease", async t => {
  await property(t, fc.record({ scope: selection, prune: fc.nat({ max: 4 }) }), 70, async s => {
    const f = lockFixture();
    let stop;
    try {
      const { ok, lock } = await f.acquire({ paths: s.scope });
      assert.equal(ok, true);
      const remove = s.prune % (s.scope.length + 1);
      for (const file of s.scope.slice(0, remove)) f.db.prepare("DELETE FROM locks WHERE run_id = ? AND normalized_path = ?").run(lock.id, file);
      stop = f.runtime().startHardLockHeartbeat(lock, 60_000);
      assert.equal((await f.runtime().quarantineHardLock(lock, '{"complete":false,"pids":[]}')).ok, true);
      assert.equal(await stop.pulse(), true);
      assert.equal(stop.signal.aborted, false);
      const rows = f.rows();
      assert.deepEqual(rows.map(row => row.normalized_path).sort(), [...s.scope].sort());
      assert.ok(rows.every(row => row.expires_at === Number.MAX_SAFE_INTEGER));
      f.runtime().expireLocksFromDb(f.db, Date.now() + 86_400_000);
      assert.equal(f.rows().length, s.scope.length);
      const contender = await f.acquire({ paths: s.scope, lockType: "write" });
      assert.equal(contender.ok, false);
      assert.equal(f.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status, "quarantined");
      assert.match(f.runtime().formatAgentLockList(await f.runtime().listLocks(f.root)), /quarantined \(no expiry\)/);
    } finally { if (stop) await stop(); f.close(); }
  });
});

test("generated foreign-token or partial-row lease loss aborts the old owner without touching another run", async t => {
  await property(t, fc.record({ scope: fc.uniqueArray(fc.constantFrom(...paths), { minLength: 2, maxLength: 4 }),
    fault: fc.constantFrom("token", "missing-path", "expired") }), 70, async s => {
    const f = lockFixture();
    let stop;
    try {
      const { lock } = await f.acquire({ paths: s.scope });
      const unrelated = await f.acquire({ paths: ["unrelated/safe.txt"] });
      assert.equal(unrelated.ok, true);
      const otherRows = f.rows().filter(row => row.run_id === unrelated.lock.id);
      stop = f.runtime().startHardLockHeartbeat(lock, 60_000);
      if (s.fault === "token") f.db.prepare("UPDATE locks SET token = 'sha256:another-owner' WHERE run_id = ?").run(lock.id);
      if (s.fault === "missing-path") f.db.prepare("DELETE FROM locks WHERE run_id = ? AND normalized_path = ?").run(lock.id, s.scope[0]);
      if (s.fault === "expired") f.db.prepare("UPDATE locks SET expires_at = 1 WHERE run_id = ?").run(lock.id);
      const before = f.rows();
      assert.equal(await stop.pulse(), false);
      assert.equal(stop.signal.aborted, true);
      assert.equal(stop.assertOwned().errorType, "write_lock_ownership_lost");
      if (s.fault !== "missing-path") assert.deepEqual(f.rows(), before, "an invalid owner cannot renew any row");
      assert.equal(await stop.pulse(), false);
      assert.equal(f.events.filter(event => event.event === "lock.ownership_lost").length, 1);
      assert.deepEqual(f.rows().filter(row => row.run_id === unrelated.lock.id), otherRows);
    } finally { if (stop) await stop(); f.close(); }
  });
});

test("generated successful heartbeat renews the complete owned scope while leaving another run unchanged", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await property(t, fc.record({ scope: selection, kind: type, ttl: fc.constantFrom(1000, 5000, 60_000),
    pulses: fc.integer({ min: 1, max: 5 }) }), 70, async s => {
    const f = lockFixture();
    let stop;
    try {
      const other = await f.acquire({ paths: ["unrelated/safe.txt"], editsCheckout: false });
      const acquired = await f.acquire({ paths: s.scope, lockType: s.kind, editsCheckout: false, ttlMs: s.ttl });
      assert.equal(other.ok, true);
      assert.equal(acquired.ok, true);
      const otherRows = f.rows().filter(row => row.run_id === other.lock.id);
      stop = f.runtime().startHardLockHeartbeat(acquired.lock, s.ttl);
      now += Math.floor(s.ttl / 8);
      assert.deepEqual(await Promise.all(Array.from({ length: s.pulses }, () => stop.pulse())), Array(s.pulses).fill(true));
      assert.equal(stop.assertOwned(), null);
      assert.equal(acquired.lock.expiresAt, now + s.ttl);
      const ownedRows = f.rows().filter(row => row.run_id === acquired.lock.id);
      assert.equal(ownedRows.length, s.scope.length);
      assert.ok(ownedRows.every(row => row.expires_at === now + s.ttl));
      assert.deepEqual(f.rows().filter(row => row.run_id === other.lock.id), otherRows);
      await stop();
      assert.equal(await stop.pulse(), false);
    } finally { if (stop) await stop(); f.close(); }
  });
});

test("generated database failures preserve the confirmed lease only until its exact guarded deadline", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await property(t, fc.record({ budget: fc.constantFrom([1000, 250], [4000, 1000], [60_000, 15_000]), kind: type }), 50, async s => {
    const f = lockFixture();
    let stop;
    try {
      const [ttl, guard] = s.budget;
      const { lock } = await f.acquire({ paths: ["src/a.txt", "src/b.txt"], lockType: s.kind, ttlMs: ttl });
      const before = f.rows();
      stop = f.runtime().startHardLockHeartbeat(lock, ttl);
      f.failOpen(true);
      now = lock.expiresAt - guard - 1;
      assert.equal(await stop.pulse(), true, "a transient open failure does not discard a still-confirmed lease");
      assert.equal(stop.signal.aborted, false);
      assert.deepEqual(f.rows(), before, "failed persistence does not extend the durable lease");
      now++;
      assert.equal(await stop.pulse(), false, "equality at the guard cannot authorize more work");
      assert.equal(stop.signal.aborted, true);
      assert.equal(stop.assertOwned().errorType, { read: "read_lock_ownership_lost", write: "write_lock_ownership_lost",
        serial_integration: "integration_lock_ownership_lost" }[s.kind]);
      assert.deepEqual(f.rows(), before);
      assert.equal(f.events.filter(event => event.event === "lock.ownership_lost").length, 1);
    } finally { if (stop) await stop(); f.close(); }
  });
});

test("stopping a heartbeat drains in-flight opens and neither renews nor aborts after stop", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const failOpen of [false, true]) {
    const f = lockFixture();
    let stop;
    let held;
    try {
      const acquired = await f.acquire({ paths: ["src/a.txt"] });
      assert.equal(acquired.ok, true);
      const { lock } = acquired;
      const before = f.rows();
      stop = f.runtime().startHardLockHeartbeat(lock, 60_000);
      now += 1000;
      f.failOpen(failOpen);
      held = f.holdNextOpen();
      const pending = stop.pulse();
      assert.equal(await Promise.race([
        held.started.then(() => true),
        pending.then(() => false),
      ]), true, "pulse completed without entering the held database open");
      let settled = false;
      const drained = stop().then(() => { settled = true; });
      // A complete event-loop turn drains runnable promise reactions without a
      // timing sleep. stop must still wait for the deliberately held DB open.
      await new Promise(setImmediate);
      assert.equal(settled, false, "stop returned before the in-flight database open completed");
      held.release();
      assert.equal(await pending, false);
      await drained;
      assert.equal(settled, true);
      assert.equal(stop.signal.aborted, false);
      assert.deepEqual(f.rows(), before);
      assert.equal(f.events.filter(event => event.event === "lock.ownership_lost").length, 0);
    } finally { held?.release(); if (stop) await stop(); f.close(); }
  }
});

test("generated exact expiry boundaries retain quarantined paths and their crash-window association", async t => {
  await property(t, fc.record({ ttl: fc.constantFrom(1000, 1001, 60_000), boundary: fc.constantFrom(-1, 0, 1), held: fc.boolean() }), 70, async s => {
    const f = lockFixture();
    try {
      const { lock } = await f.acquire({ paths: ["src/a.txt", "src/b.txt"], ttlMs: s.ttl });
      f.db.prepare("INSERT INTO queue_job_locks VALUES (?, 'job-1', 'generation-1')").run(lock.id);
      if (s.held) f.db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ? AND normalized_path = 'src/b.txt'")
        .run(Number.MAX_SAFE_INTEGER, lock.id);
      f.runtime().expireLocksFromDb(f.db, lock.expiresAt + s.boundary);
      const expired = s.boundary >= 0;
      const count = expired ? (s.held ? 1 : 0) : 2;
      assert.equal(f.rows().length, count);
      assert.equal(f.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.id).status,
        count ? "running" : "expired");
      assert.equal(Boolean(f.db.prepare("SELECT 1 FROM queue_job_locks WHERE lock_id = ?").get(lock.id)), count > 0);
    } finally { f.close(); }
  });
});

test("generated finalizer protection refuses readers, restores exact receipts and retains altered ownership", async t => {
  await property(t, fc.record({ blocker: fc.boolean(), tamper: fc.constantFrom("none", "token", "containment", "agent") }), 70, async s => {
    const f = lockFixture();
    try {
      const acquired = await f.acquire({ lockType: "read", repositoryScope: true, agent: "pipeline_finalizer" });
      assert.equal(acquired.ok, true);
      const { lock } = acquired;
      let blocker;
      if (s.blocker) {
        blocker = await f.acquire({ paths: ["docs/a.md"], lockType: "read" });
        assert.equal(blocker.ok, true);
      }
      const containment = JSON.stringify({ complete: false, pids: [], recordedAt: Date.now() });
      const before = f.rows();
      let protectedResult = await f.runtime().beginFinalizerValidationProtection(lock, { containment });
      if (s.blocker) {
        assert.equal(protectedResult.ok, false);
        assert.equal(protectedResult.errorType, "pipeline_finalization_lock_conflict");
        assert.deepEqual(f.rows(), before);
        await f.release(blocker.lock);
        protectedResult = await f.runtime().beginFinalizerValidationProtection(lock, { containment });
      }
      assert.equal(protectedResult.ok, true);
      assert.equal(lock.lockType, "serial_integration");
      assert.equal((await f.acquire({ paths: ["docs/a.md"], lockType: "read" })).ok, false);
      assert.ok(f.rows().every(row => row.expires_at === Number.MAX_SAFE_INTEGER));
      if (s.tamper === "token") f.db.prepare("UPDATE locks SET token = 'foreign-token' WHERE run_id = ?").run(lock.id);
      if (s.tamper === "containment") f.db.prepare("UPDATE runs SET containment = 'other-evidence' WHERE run_id = ?").run(lock.id);
      if (s.tamper === "agent") f.db.prepare("UPDATE locks SET owner_agent = 'other-agent' WHERE run_id = ?").run(lock.id);
      const protectedRows = f.rows();
      const restored = await f.runtime().restoreFinalizerReadLease(lock, protectedResult.receipt);
      assert.equal(restored.ok, s.tamper === "none");
      if (s.tamper === "none") {
        assert.equal(lock.lockType, "read");
        assert.ok(f.rows().every(row => row.lock_mode === "read" && row.expires_at < Number.MAX_SAFE_INTEGER));
        assert.equal((await f.acquire({ paths: ["docs/a.md"], lockType: "read" })).ok, true);
      } else {
        assert.equal(restored.protectionIntact, false);
        assert.deepEqual(f.rows(), protectedRows, "a mismatched receipt never restores/replaces another owner");
      }
    } finally { f.close(); }
  });
});

test("a database-open failure cannot turn release cleanup into a thrown exception", async () => {
  const f = lockFixture();
  try {
    const { lock } = await f.acquire({ paths: ["src/a.txt"] });
    const before = f.rows();
    f.failOpen(true);
    const refused = await f.release(lock);
    assert.equal(refused.ok, false);
    assert.equal(refused.released, false);
    assert.match(refused.error, /synthetic database open failure/);
    assert.deepEqual(f.rows(), before);
    f.failOpen(false);
    assert.equal((await f.release(lock)).ok, true);
  } finally { f.close(); }
});

test("an insert failure midway through a scope rolls back all lock and run rows", async () => {
  const f = lockFixture();
  try {
    f.db.exec(`CREATE TRIGGER refuse_second BEFORE INSERT ON locks
      WHEN NEW.normalized_path = 'src/b.txt' BEGIN SELECT RAISE(ABORT, 'synthetic second-path failure'); END;`);
    const result = await f.acquire({ paths: ["src/a.txt", "src/b.txt"] });
    assert.equal(result.ok, false);
    assert.equal(f.rows().length, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
    f.db.exec("DROP TRIGGER refuse_second");
    assert.equal((await f.acquire({ paths: ["src/a.txt", "src/b.txt"] })).ok, true);
  } finally { f.close(); }
});

test("unsafe relative paths cannot acquire a lock or publish a run", async t => {
  await property(t, fc.constantFrom("../outside", "src/../outside", "src\\..\\outside", ".",
    ...(process.platform === "win32" ? ["file.txt:stream"] : []), "src/a\n.txt", "~/secret"), 40, async unsafe => {
    const f = lockFixture();
    try {
      const result = await f.acquire({ paths: [unsafe] });
      assert.equal(result.ok, false);
      assert.equal(f.rows().length, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
    } finally { f.close(); }
  });
  if (process.platform !== "win32") {
    const f = lockFixture();
    try { assert.equal((await f.acquire({ paths: ["file.txt:stream"] })).ok, true, "colon is a plain filename on POSIX"); }
    finally { f.close(); }
  }
});
