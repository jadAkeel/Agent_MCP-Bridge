import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { queueStartAfterPending } from "../lib/queue.js";
import { ACTIVE, MODELS, NOW, queueRecord, withScheduler } from "./helpers/queue-scheduler-fixture.js";

// Keep mutation baselines bounded and reproducible. fast-check reports the
// counterexample seed/path; FC_SEED and FC_PATH replay it in the selected test.
const options = { seed: Number(process.env.FC_SEED || 20261014),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
const idle = ["pending", "planned", "blocked"];
const iso = (time) => new Date(time).toISOString();
const index = fc.integer({ min: 0, max: 20 });

async function property(t, arbitrary, runs, body) {
  let generated = 0;
  await fc.assert(fc.asyncProperty(arbitrary, async (sample) => {
    generated++;
    await body(sample);
  }), { ...options, numRuns: runs });
  t.diagnostic(`generated runs: ${generated}; seed: ${options.seed}`);
}

// Independent FIFO oracle: classify the snapshot, select the available slots,
// then apply non-start effects only within the prefix that the slots reach.
// It has no planning, lease, conflict, backoff or timer implementation.
function corePass(model, state, now) {
  const slots = Math.max(0, state.limit - model.filter((row) => ACTIVE.includes(row.status)).length);
  const effect = (row) => {
    if (!idle.includes(row.status)) return "ignore";
    if (row.mode !== "read" && state.recovery.has(row.cwd)) return "recovery";
    if (row.cancellationRequested) return "cancel";
    if (state.memory || state.drain) return "hold";
    if (row.status !== "blocked" && row.readyAt > now) return "hold";
    return "start";
  };
  const selected = model.filter((row) => effect(row) === "start").slice(0, slots);
  const end = !slots ? -1 : selected.length === slots ? model.indexOf(selected.at(-1)) : model.length - 1;
  for (const row of model.slice(0, end + 1)) {
    if (effect(row) === "recovery") {
      row.status = "blocked";
      row.errorType = "integration_recovery_pending";
    } else if (effect(row) === "cancel") row.status = "cancelled";
  }
  for (const row of selected) row.status = "running";
  return selected.map((row) => row.jobId);
}

const rowArb = fc.record({
  status: fc.constantFrom(...idle, ...ACTIVE, "completed", "failed", "cancelled", "held"),
  mode: fc.constantFrom("read", "write"), root: fc.integer({ min: 0, max: 1 }),
  cancellationRequested: fc.boolean(),
  wait: fc.constantFrom("absent", "invalid", "past", "now", "future"),
});
const actionArb = fc.oneof(
  fc.record({ kind: fc.constant("pass"), ms: fc.integer({ min: 0, max: 400 }) }),
  fc.record({ kind: fc.constantFrom("cancel", "finish"), target: index }),
  fc.record({ kind: fc.constantFrom("memory", "drain", "recovery"), value: fc.boolean(), target: index }),
  fc.record({ kind: fc.constant("limit"), value: fc.integer({ min: 1, max: 6 }) }),
);

test("generated queue states and actions obey FIFO capacity, holds, cancellation and recovery", async (t) => {
  await property(t, fc.record({ rows: fc.array(rowArb, { minLength: 1, maxLength: 8 }),
    limit: fc.integer({ min: 1, max: 6 }), memory: fc.boolean(), drain: fc.boolean(),
    recovery: fc.boolean(), actions: fc.array(actionArb, { minLength: 1, maxLength: 18 }) }), 80, async (sample) => {
    const records = sample.rows.map((row, id) => queueRecord(`job-${id}`, {
      status: row.status, mode: row.mode, cwd: `fixture-repo-${row.root}`,
      cancellationRequested: row.cancellationRequested,
      ...(row.wait === "absent" ? {} : { startAfter: row.wait === "invalid" ? "invalid date"
        : iso(NOW + ({ past: -1, now: 0, future: 500 }[row.wait])) }),
    }));
    const model = records.map((record) => ({ ...record, readyAt: Date.parse(record.startAfter || "") }));
    const state = { limit: sample.limit, memory: sample.memory, drain: sample.drain,
      recovery: new Set(sample.recovery ? ["fixture-repo-0"] : []) };
    let now = NOW;
    const started = [];
    await withScheduler(t, records, { config: { queueParallelLimit: state.limit },
      state: { memory: state.memory, drain: state.drain }, recovery: [...state.recovery] }, async (f) => {
      const pass = async (ms = 0) => {
        now += ms;
        const expected = corePass(model, state, now);
        const claimsBefore = f.events.claims.length;
        started.push(...expected);
        await f.pass(ms);
        assert.deepEqual(f.events.starts, started, "exactly the oracle's available FIFO jobs start");
        assert.deepEqual(f.events.claims.slice(claimsBefore).map((claim) => claim.jobId), expected,
          "held, cancelled and recovering jobs are never planned");
        assert.deepEqual([...f.jobs.values()].map((row) => [row.jobId, row.status, row.errorType]),
          model.map((row) => [row.jobId, row.status, row.errorType]));
        assert.equal(Date.now(), now);
      };
      await pass();
      for (const action of sample.actions) {
        const target = model[(action.target || 0) % model.length];
        if (action.kind === "pass") await pass(action.ms);
        else if (action.kind === "cancel") {
          target.cancellationRequested = true;
          f.jobs.get(target.jobId).cancellationRequested = true;
        } else if (action.kind === "finish" && ACTIVE.includes(target.status)) {
          target.status = "completed";
          f.jobs.get(target.jobId).status = "completed";
        } else if (action.kind === "limit") {
          state.limit = action.value;
          // Simulate a limit persisted by another worker. The pass must refresh
          // it before measuring capacity, rather than use the old CONFIG value.
          f.state.refreshedLimit = action.value;
        } else if (action.kind === "memory" || action.kind === "drain") {
          state[action.kind] = action.value;
          f.state[action.kind] = action.value;
        } else if (action.kind === "recovery") {
          for (const roots of [state.recovery, f.recovery]) {
            if (action.value) roots.add(target.cwd);
            else roots.delete(target.cwd);
          }
        }
      }
      state.memory = f.state.memory = false;
      state.drain = f.state.drain = false;
      state.limit = f.state.refreshedLimit = 8;
      state.recovery.clear(); f.recovery.clear();
      await pass(500);
      assert.ok(model.every((row) => !idle.includes(row.status)), "clearing holds eventually drains startable work");
    });
  });
});

test("a drain arriving during planning or conflict IO prevents that job's launch", async (t) => {
  await property(t, fc.record({ count: fc.integer({ min: 1, max: 6 }), stop: index,
    stage: fc.constantFrom("claim", "conflict") }), 60, async ({ count, stop, stage }) => {
    const stopAt = stop % count;
    const records = Array.from({ length: count }, (_, id) => queueRecord(`job-${id}`));
    let stopRequested = false;
    await withScheduler(t, records, { config: { queueParallelLimit: 1 }, state: { refreshedLimit: count },
      claim: async (row, patch, f, write) => {
        const result = await write(row, patch);
        if (stage === "claim" && row.jobId === `job-${stopAt}` && !stopRequested) {
          f.state.drain = true; stopRequested = true;
        }
        return result;
      }, conflict: async (row, f) => {
        if (stage === "conflict" && row.jobId === `job-${stopAt}` && !stopRequested) {
          f.state.drain = true; stopRequested = true;
        }
        return null;
      } }, async (f) => {
      await f.pass();
      assert.deepEqual(f.events.starts, records.slice(0, stopAt).map((row) => row.jobId));
      assert.equal(records[stopAt].status, "planned");
      assert.equal(f.events.claims.length, stopAt + 1);
      f.state.drain = false;
      await f.pass();
      assert.deepEqual(f.events.starts, records.map((row) => row.jobId));
    });
  });
});

test("refused process claims leave capacity for later jobs without duplicate starts", async (t) => {
  await property(t, fc.record({ outcomes: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
    limit: fc.integer({ min: 1, max: 4 }), running: fc.integer({ min: 0, max: 4 }) }), 60,
  async ({ outcomes, limit, running }) => {
    const records = [
      ...Array.from({ length: running }, (_, id) => queueRecord(`active-${id}`, { status: ACTIVE[id] })),
      ...outcomes.map((_, id) => queueRecord(`job-${id}`)),
    ];
    await withScheduler(t, records, { config: { queueParallelLimit: limit },
      start: async (row) => outcomes[Number(row.jobId.slice(4))] }, async (f) => {
      const slots = Math.max(0, limit - running);
      const successes = outcomes.flatMap((ok, id) => ok ? [`job-${id}`] : []).slice(0, slots);
      const last = !slots ? -1 : successes.length === slots ? Number(successes.at(-1).slice(4)) : outcomes.length - 1;
      await f.pass();
      assert.deepEqual(f.events.starts, successes);
      assert.deepEqual(f.events.attempts, outcomes.slice(0, last + 1).map((_, id) => `job-${id}`));
      await f.pass();
      assert.equal(new Set(f.events.starts).size, f.events.starts.length, "running jobs cannot be started again");
      assert.ok(f.events.starts.length <= slots);
    });
  });
});

test("durable refusal and ownership changes never launch or delete a replacement row", async (t) => {
  await property(t, fc.record({ outcome: fc.constantFrom("refused", "owner", "generation", "replacement"),
    status: fc.constantFrom(...idle), generation: fc.constantFrom("", "generation-0"),
    applyPatch: fc.boolean() }), 60, async ({ outcome, status, generation, applyPatch }) => {
    const denied = queueRecord("denied", { status, ownerGeneration: generation });
    const tail = queueRecord("tail");
    const replacement = queueRecord("denied", { status: "held", ownerInstanceId: "other-owner" });
    let refuse = true;
    await withScheduler(t, [denied, tail], { config: { queueParallelLimit: 1 },
      claim: async (row, patch, f, write) => {
        if (row.jobId !== "denied" || !refuse) return await write(row, patch);
        if (applyPatch) Object.assign(row, patch);
        if (outcome === "owner") row.ownerInstanceId = "other-owner";
        if (outcome === "generation") row.ownerGeneration = `${generation}-new`;
        if (outcome === "replacement") {
          row.ownerInstanceId = "other-owner";
          f.jobs.set(row.jobId, replacement);
        }
        return { persisted: false };
      } }, async (f) => {
      await f.pass();
      assert.deepEqual(f.events.attempts, ["tail"], "no refused durable claim reaches the process start");
      assert.equal(f.jobs.get("denied"), outcome === "replacement" ? replacement : outcome === "refused" ? denied : undefined);
      assert.deepEqual(f.events.logs, ["owner", "generation"].includes(outcome)
        ? [{ level: "warn", name: "queue.record_owned_elsewhere", detail: { jobId: "denied", ownerGeneration: generation } }] : []);
      tail.status = "completed";
      refuse = false;
      await f.pass();
      assert.deepEqual(f.events.starts, outcome === "refused" ? ["tail", "denied"] : ["tail"]);
      if (outcome === "replacement") assert.equal(f.jobs.get("denied"), replacement);
    });
  });
});

test("local blockers hold only their active generation and release stale backoff immediately", async (t) => {
  await property(t, fc.record({ status: fc.constantFrom(...ACTIVE),
    release: fc.constantFrom("finish", "remove", "generation"), retryMs: fc.integer({ min: 1, max: 60_000 }) }),
  60, async ({ status, release, retryMs }) => {
    const blocker = queueRecord("blocker", { status });
    const waiting = queueRecord("waiting", { status: "blocked", mode: "write",
      errorType: "write_lock_conflict", errorReason: "held path", queueBlockedOnJobId: blocker.jobId,
      queueBlockedOnGeneration: blocker.ownerGeneration, queueBlockedRetryAt: NOW + retryMs });
    await withScheduler(t, [blocker, waiting], { config: { queueParallelLimit: 2 } }, async (f) => {
      await f.pass(retryMs);
      assert.deepEqual(f.events.conflicts, [], "a live same-generation blocker does not need a database probe");
      assert.deepEqual(f.events.claims, []);
      assert.equal(waiting.status, "blocked");
      if (release === "finish") blocker.status = "completed";
      else if (release === "remove") f.jobs.delete(blocker.jobId);
      else blocker.ownerGeneration = "generation-1";
      // Put the retry in the future again: a disappeared dependency must clear
      // it, even if an earlier backoff would otherwise defer this job.
      waiting.queueBlockedRetryAt = Date.now() + retryMs;
      await f.pass();
      assert.deepEqual(f.events.starts, ["waiting"]);
      for (const field of ["queueBlockedOnJobId", "queueBlockedOnGeneration", "queueBlockedRetryAt"]) {
        assert.equal(Object.hasOwn(waiting, field), false, `${field} must leave with the old dependency`);
      }
    });
  });
});

test("unchanged conflicts back off to the bounded deadline without repeated durable writes", async (t) => {
  await property(t, fc.record({ poll: fc.integer({ min: 1, max: 5_000 }),
    count: fc.integer({ min: 0, max: 20 }) }), 60, async ({ poll, count }) => {
    const record = queueRecord("waiting", { mode: "write", queueBlockedCount: count });
    let held = true;
    const conflict = { source: "external", errorType: "write_lock_conflict", reason: "held path", paths: ["a.txt"] };
    await withScheduler(t, [record], { config: { queueBlockedPollMs: poll },
      conflict: async () => held ? conflict : null }, async (f) => {
      await f.pass();
      const firstDelay = Math.min(60_000, poll * 2 ** count);
      assert.equal(record.status, "blocked");
      assert.equal(record.queueBlockedCount, count + 1);
      assert.equal(record.queueBlockedRetryAt, NOW + firstDelay);
      assert.equal(f.events.passes.at(-1).delay, Math.max(poll, firstDelay));
      const writes = f.events.writes.length;
      const probes = f.events.conflicts.length;
      await f.pass(firstDelay - 1);
      assert.equal(f.events.writes.length, writes);
      assert.equal(f.events.conflicts.length, probes, "no probe before the backoff deadline");
      await f.pass(1);
      const secondDelay = Math.min(60_000, firstDelay * 2);
      assert.equal(record.queueBlockedCount, count + 2);
      assert.equal(record.queueBlockedRetryAt, Date.now() + secondDelay);
      assert.equal(f.events.conflicts.length, probes + 1);
      assert.equal(f.events.writes.length, writes, "an unchanged block is not re-planned or re-persisted");
      held = false;
      await f.pass(secondDelay);
      assert.deepEqual(f.events.starts, ["waiting"], "the deadline permits recovery once the conflict clears");
    });
  });
});

test("conflict policy rejects ordinary writes but keeps integration recovery retryable", async (t) => {
  await property(t, fc.record({ policy: fc.constantFrom("wait", "reject"),
    errorType: fc.constantFrom("write_lock_conflict", "integration_recovery_pending"),
    paths: fc.constantFrom([], ["a.txt"], ["a.txt", "b.txt"]) }), 60, async ({ policy, errorType, paths }) => {
    const record = queueRecord("writer", { mode: "write" });
    let held = true;
    await withScheduler(t, [record], { state: { policy }, conflict: async () => held
      ? { source: "external", errorType, reason: "external holder", paths } : null }, async (f) => {
      await f.pass();
      const reject = policy === "reject" && errorType !== "integration_recovery_pending";
      assert.equal(record.status, reject ? "failed" : "blocked");
      assert.equal(record.errorType, reject ? "write_lock_conflict" : errorType);
      assert.deepEqual(f.events.attempts, []);
      if (reject) {
        assert.equal(record.errorReason, `Write lock conflict on: ${paths[0] || "unknown"}`);
        assert.equal(record.finishedAt, iso(NOW));
      } else assert.equal(record.queueBlockedRetryAt, NOW + 250);
      held = false;
      await f.pass(250);
      assert.deepEqual(f.events.starts, reject ? [] : ["writer"]);
    });
  });
});

// The provider oracle describes a small independent resource graph: a model
// needs its own key, its provider key and all providers sharing its quota.
// It deliberately does not call production key/parsing/pause helpers.
const providerKey = (provider, explicit) => explicit ? "fixture-account" : `fixture-account:${provider}`;
const modelKey = (spec) => `fixture-account:${spec.toLowerCase()}`;
function availableAt(spec, pauses, shared, explicit) {
  const provider = spec.split("/")[0];
  const group = shared && ["alpha", "beta"].includes(provider) && !explicit ? ["alpha", "beta"] : [];
  return Math.max(0, ...[providerKey(provider, explicit), modelKey(spec),
    ...group.map((member) => providerKey(member, explicit))].map((key) => pauses.get(key) || 0));
}
function allPausedUntil(specs, pauses, now, shared, explicit) {
  if (!specs.length) return 0;
  const dates = specs.map((spec) => availableAt(spec, pauses, shared, explicit));
  return dates.some((date) => date <= now) ? 0 : Math.min(...dates);
}
const pauseKeys = ["fixture-account", "fixture-account:alpha", "fixture-account:beta", "fixture-account:gamma",
  ...MODELS.map(modelKey)];
const pausesArb = fc.array(fc.constantFrom(-1, 0, 1, 250, 1_000, 10_000),
  { minLength: pauseKeys.length, maxLength: pauseKeys.length });
const pauseMap = (values, now) => new Map(values.map((value, id) => [pauseKeys[id], now + value]));
const providerConfig = (shared, explicit) => ({ providerConcurrencyKeyExplicit: explicit,
  quotaGroups: shared ? [{ members: ["alpha", "beta"] }] : [] });
const projection = (rows) => rows.map((row) => [row.jobId, row.status, row.startAfter, row.startAfterReason]);

test("pause/resume action sequences preserve waits on read failures and respect model alternatives and quota groups", async (t) => {
  const definition = fc.record({ status: fc.constantFrom("pending", "planned", "blocked", "running", "completed"),
    specs: fc.uniqueArray(fc.constantFrom(...MODELS), { maxLength: 4 }),
    source: fc.constantFrom("models", "request-pin", "record-pin"),
    wait: fc.constantFrom("future", "past", "invalid", "absent"),
    reason: fc.constantFrom("provider_pause", "retry") });
  const action = fc.record({ advance: fc.integer({ min: 0, max: 500 }), force: fc.boolean(),
    fail: fc.boolean(), pauses: pausesArb });
  await property(t, fc.record({ rows: fc.array(definition, { minLength: 1, maxLength: 6 }),
    shared: fc.boolean(), explicit: fc.boolean(), poll: fc.integer({ min: 1, max: 500 }),
    actions: fc.array(action, { minLength: 1, maxLength: 12 }) }), 80, async (sample) => {
    const specsFor = (row) => row.source === "models" ? row.specs : row.specs.slice(0, 1);
    const records = sample.rows.map((row, id) => {
      const specs = specsFor(row);
      const requirement = specs.length ? { provider: specs[0].split("/")[0], model: specs[0].split("/")[1] } : undefined;
      return queueRecord(`wait-${id}`, { status: row.status,
        request: row.source === "models" ? { models: ["invalid", ...specs] }
          : row.source === "request-pin" ? { scopeContract: { modelRequirement: requirement } } : {},
        ...(row.source === "record-pin" ? { scopeContract: { modelRequirement: requirement } } : {}),
        ...(row.wait === "absent" ? {} : { startAfter: row.wait === "invalid" ? "invalid date"
          : iso(NOW + (row.wait === "future" ? 20_000 : -1)) }), startAfterReason: row.reason });
    });
    const model = structuredClone(records);
    let now = NOW;
    let checkedAt = 0;
    await withScheduler(t, records, { config: { ...providerConfig(sample.shared, sample.explicit),
      queueBlockedPollMs: sample.poll } }, async (f) => {
      const release = async ({ advance, force, fail, pauses }) => {
        now += advance;
        f.advance(advance);
        f.state.pauseReadFails = fail;
        f.state.pauses = pauseMap(pauses, now);
        const waiting = model.filter((row) => ["pending", "planned"].includes(row.status)
          && row.startAfterReason === "provider_pause" && Date.parse(row.startAfter || "") > now);
        const read = waiting.length > 0 && (force || now - checkedAt >= Math.max(250, sample.poll));
        let released = 0;
        if (read) {
          checkedAt = now;
          if (!fail) for (const row of waiting) {
            const specs = specsFor(sample.rows[Number(row.jobId.slice(5))]);
            const free = specs.length ? !allPausedUntil(specs, f.state.pauses, now, sample.shared, sample.explicit) : force;
            if (free) { delete row.startAfter; delete row.startAfterReason; released++; }
          }
        }
        const reads = f.events.pauseReads;
        assert.equal(await f.runtime.releaseResumedPauseWaits(now, { force }), released);
        assert.equal(f.events.pauseReads - reads, Number(read), "throttled and empty polls do not reopen persistence");
        assert.deepEqual(projection(records), projection(model));
        assert.deepEqual(f.events.writes, []);
        assert.deepEqual(f.events.attempts, [], "resuming a wait does not itself launch an agent");
      };
      // Guarantee fail-closed coverage before any random resume can free waits.
      await release({ advance: 0, force: true, fail: true, pauses: pauseKeys.map(() => -1) });
      for (const action of sample.actions) await release(action);
      await release({ advance: 0, force: true, fail: false, pauses: pauseKeys.map(() => -1) });
    });
  });
});

test("scheduler pause snapshots hold fresh cohorts durably and release when one candidate becomes free", async (t) => {
  await property(t, fc.record({ specs: fc.uniqueArray(fc.constantFrom(...MODELS), { minLength: 2, maxLength: 4 }),
    shared: fc.boolean(), explicit: fc.boolean(), status: fc.constantFrom("pending", "planned"),
    frames: fc.array(fc.record({ pauses: pausesArb, fail: fc.boolean(),
      advance: fc.integer({ min: 250, max: 1_000 }) }), { minLength: 1, maxLength: 6 }) }), 80, async (sample) => {
    const existing = queueRecord("existing", { status: sample.status, request: { models: sample.specs },
      startAfter: iso(NOW + 20_000), startAfterReason: "provider_pause", retryAttempt: 2, idempotencyKey: "same-request" });
    const model = new Map([[existing.jobId, structuredClone(existing)]]);
    const refs = new Map([[existing.jobId, existing]]);
    let now = NOW;
    let sequence = 0;
    const starts = [];
    await withScheduler(t, [existing], { config: { queueParallelLimit: 32,
      ...providerConfig(sample.shared, sample.explicit) } }, async (f) => {
      const frame = async (pauses, fail, advance) => {
        now += advance;
        f.state.pauses = pauses;
        f.state.pauseReadFails = fail;
        // External enqueues between passes exercise one shared snapshot for
        // releases and multiple fresh holds. No scheduler choices are mocked.
        for (const specs of [sample.specs, sample.specs.slice(0, 1)]) {
          const row = queueRecord(`fresh-${sequence++}`, { status: sample.status, request: { models: ["invalid", ...specs] },
            retryAttempt: 2, idempotencyKey: "same-request" });
          f.jobs.set(row.jobId, row); refs.set(row.jobId, row);
          model.set(row.jobId, { ...structuredClone(row), specs });
        }
        for (const row of model.values()) {
          if (!["pending", "planned"].includes(row.status)) continue;
          const specs = row.specs || sample.specs;
          if (Date.parse(row.startAfter || "") > now) {
            if (fail || allPausedUntil(specs, pauses, now, sample.shared, sample.explicit)) continue;
            delete row.startAfter; delete row.startAfterReason;
          }
          const until = fail ? 0 : allPausedUntil(specs, pauses, now, sample.shared, sample.explicit);
          if (until) { row.startAfter = iso(until); row.startAfterReason = "provider_pause"; }
          else { row.status = "running"; starts.push(row.jobId); }
        }
        const reads = f.events.pauseReads;
        await f.pass(advance);
        assert.equal(f.events.pauseReads - reads, 1, "one pause snapshot serves the entire scheduler pass, including failures");
        assert.deepEqual(f.events.starts, starts);
        assert.deepEqual(projection([...f.jobs.values()]), projection([...model.values()]));
        for (const row of f.jobs.values()) {
          assert.equal(row, refs.get(row.jobId), "a provider hold keeps the same row");
          assert.equal(row.retryAttempt, 2, "a hold is not an execution attempt");
          assert.equal(row.idempotencyKey, "same-request");
          assert.deepEqual(row.request.models.filter((spec) => spec !== "invalid"), model.get(row.jobId).specs || sample.specs);
        }
      };
      // All models paused, then a failed read of an empty snapshot. Previously
      // held rows stay waiting; fresh rows may reach the authoritative lease.
      await frame(new Map(MODELS.map((spec) => [modelKey(spec), NOW + 10_000])), false, 0);
      await frame(new Map(), true, 250);
      for (const part of sample.frames) await frame(pauseMap(part.pauses, now + part.advance), part.fail, part.advance);
      await frame(new Map(), false, 250);
      assert.ok([...f.jobs.values()].every((row) => row.status === "running"), "a successful resume frees all known candidates");
    });
  });
});

test("pause prechecks respect pinned policy, dry runs, sanitized jobs and startAfter boundaries", async (t) => {
  await property(t, fc.record({ kind: fc.constantFrom("models", "request-pin", "record-pin", "disallowed-pin", "unknown", "invalid-models"),
    dryRun: fc.boolean(), sanitized: fc.boolean(),
    offset: fc.constantFrom(-1, 0, 1), malformed: fc.boolean() }), 80, async (sample) => {
    const requirement = { provider: "alpha", model: sample.kind === "disallowed-pin" ? "Disallowed" : "Small" };
    const request = { agent: "reader", dryRun: sample.dryRun,
      ...(sample.sanitized ? { sanitizedWorkspace: { root: "fixture-repo-0" } } : {}),
      ...(sample.kind === "models" ? { models: ["invalid", "alpha/Small@fast"] } : {}),
      ...(sample.kind === "invalid-models" ? { models: ["invalid"] } : {}),
      ...(["request-pin", "disallowed-pin"].includes(sample.kind) ? { scopeContract: { modelRequirement: requirement } } : {}),
    };
    const row = queueRecord("pin", { request,
      ...(sample.kind === "record-pin" ? { scopeContract: { modelRequirement: requirement } } : {}) });
    await withScheduler(t, [row], { state: { pauses: new Map([[modelKey("alpha/Small"), NOW + 1_000]]) } }, async (f) => {
      const known = ["models", "request-pin", "record-pin"].includes(sample.kind);
      const held = known && !sample.dryRun && !sample.sanitized;
      await f.pass();
      assert.deepEqual(f.events.starts, held ? [] : ["pin"]);
      assert.equal(f.events.pauseReads, Number(held));
      assert.equal(row.startAfterReason, held ? "provider_pause" : undefined);
      if (held) assert.equal(row.startAfter, iso(NOW + 1_000));
      const boundary = { startAfter: sample.malformed ? "invalid date" : iso(NOW + sample.offset) };
      assert.equal(queueStartAfterPending(boundary), !sample.malformed && sample.offset > 0);
      assert.equal(queueStartAfterPending(boundary, NOW + sample.offset), false);
      assert.equal(queueStartAfterPending({}), false);
    });
  });
});

// Delays have an independent expected timeline, including the scheduler's
// supported numeric coercions. Keep values bounded; no real clock deadlines.
const immediateDelay = fc.oneof(
  fc.integer({ min: -500, max: 0 }).map((input) => ({ input, after: 0 })),
  fc.constantFrom(undefined, null, NaN, "invalid", {}, [], false).map((input) => ({ input, after: 0 })),
);
const boundedDelay = fc.oneof(immediateDelay,
  fc.integer({ min: 1, max: 500 }).map((input) => ({ input, after: input })),
  fc.integer({ min: 1, max: 500 }).map((after) => ({ input: String(after), after })),
);

test("wake: queue mode off admits no timers or work, then an enabled request can start", async (t) => {
  await property(t, fc.array(boundedDelay, { minLength: 1, maxLength: 8 }), 40, async (requests) => {
    const row = queueRecord("off");
    await withScheduler(t, [row], { state: { mode: "off" } }, async (f) => {
      for (const request of requests) {
        f.runtime.scheduleQueue(request.input);
        await f.tick(600, { passes: 0 });
      }
      assert.deepEqual(f.events.claims, []);
      assert.deepEqual(f.events.attempts, []);
      assert.deepEqual(f.events.writes, []);
      assert.equal(row.status, "pending");
      f.state.mode = "sqlite";
      await f.tick(600, { passes: 0 }); // off requests must not survive as latent wakes
      f.runtime.scheduleQueue();
      await f.tick();
      assert.deepEqual(f.events.starts, ["off"]);
      row.status = "completed";
      await f.tick(1_000, { passes: 0 });
    });
  });
});

test("wake: later and equal requests preserve the earliest wake and coalesce to one pass", async (t) => {
  await property(t, fc.record({ delay: fc.integer({ min: 2, max: 500 }), elapsed: index,
    extras: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 8 }),
    count: fc.integer({ min: 1, max: 4 }) }), 60, async ({ delay, elapsed, extras, count }) => {
    const rows = Array.from({ length: count }, (_, id) => queueRecord(`coalesced-${id}`));
    await withScheduler(t, rows, { config: { queueParallelLimit: count + 1 } }, async (f) => {
      const passed = elapsed % delay;
      f.runtime.scheduleQueue(delay);
      await f.tick(passed, { passes: 0 });
      const remaining = delay - passed;
      // Deadlines, not relative delay magnitudes, decide whether a wake is sooner.
      for (const later of [0, ...extras, 0]) f.runtime.scheduleQueue(remaining + later);
      await f.tick(remaining - 1, { passes: 0 });
      assert.deepEqual(f.events.attempts, []);
      await f.tick(1);
      assert.deepEqual(f.events.entries, [NOW + delay]);
      assert.deepEqual(f.events.starts, rows.map((row) => row.jobId));
      assert.equal(f.events.maxConcurrentPasses, 1);
      assert.equal(f.events.passes[0].delay, null);
      rows.forEach((row) => { row.status = "completed"; });
      await f.tick(2_000, { passes: 0 });
      assert.equal(new Set(f.events.starts).size, count, "coalesced wakes must not launch duplicate work");
    });
  });
});

test("wake: earlier requests advance admission and negative or invalid delays become immediate", async (t) => {
  await property(t, fc.record({ request: boundedDelay, initial: fc.integer({ min: 4, max: 500 }),
    elapsed: index, earlier: index, immediate: fc.boolean(), immediateRequest: immediateDelay }), 60,
  async ({ request, initial, elapsed, earlier, immediate, immediateRequest }) => {
    // Also test normalization when no wake exists: neither synchronous execution
    // nor a spurious later wake is allowed.
    await withScheduler(t, [queueRecord("normalized")], {}, async (f) => {
      f.runtime.scheduleQueue(request.input);
      assert.deepEqual(f.events.entries, [], "request admission itself must not run the pass");
      if (request.after > 0) await f.tick(request.after - 1, { passes: 0 });
      await f.tick(request.after > 0 ? 1 : 0);
      assert.deepEqual(f.events.entries, [NOW + request.after]);
      assert.deepEqual(f.events.starts, ["normalized"]);
      await f.tick(1_000, { passes: 0 });
    });
    await withScheduler(t, [queueRecord("earlier")], {}, async (f) => {
      const passed = elapsed % (initial - 1);
      f.runtime.scheduleQueue(initial);
      await f.tick(passed, { passes: 0 });
      const remaining = initial - passed;
      const advanceBy = immediate ? 0 : 1 + earlier % (remaining - 1);
      const deadline = NOW + passed + advanceBy;
      f.runtime.scheduleQueue(immediate ? immediateRequest.input : advanceBy);
      // Later/equal requests after the advance cannot restore the old wake.
      f.runtime.scheduleQueue(remaining);
      f.runtime.scheduleQueue(advanceBy);
      if (advanceBy > 0) await f.tick(advanceBy - 1, { passes: 0 });
      await f.tick(advanceBy > 0 ? 1 : 0);
      assert.deepEqual(f.events.entries, [deadline]);
      assert.deepEqual(f.events.starts, ["earlier"]);
      await f.tick(initial + 1_000, { passes: 0 });
    });
  });
});

test("wake: requests during awaited passes trigger immediate rechecks only when requested", async (t) => {
  await property(t, fc.record({ stage: fc.constantFrom("refresh", "claim", "start"), immediate: fc.boolean(),
    request: immediateDelay, poll: fc.integer({ min: 1, max: 500 }),
    waited: fc.integer({ min: 0, max: 1_000 }),
    delayed: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 8 }) }), 60, async (sample) => {
    const row = queueRecord("recheck", { status: "planned" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let suspended = false;
    let attempts = 0;
    const suspendOnce = async (stage) => {
      if (stage === sample.stage && !suspended) { suspended = true; await gate; }
    };
    await withScheduler(t, [row], { config: { queueBlockedPollMs: sample.poll },
      refresh: async () => { await suspendOnce("refresh"); },
      claim: async (record, patch, f, write) => {
        await suspendOnce("claim");
        return await write(record, patch);
      }, start: async () => {
        const attempt = ++attempts;
        await suspendOnce("start");
        return attempt > 1;
      } }, async (f) => {
      try {
        f.runtime.scheduleQueue();
        await f.tick(0, { begun: 1, passes: 0 });
        assert.equal(suspended, true, "the requested external operation is actually awaited");
        for (const delay of sample.delayed) f.runtime.scheduleQueue(delay);
        if (sample.immediate) {
          f.runtime.scheduleQueue(sample.request.input);
          f.runtime.scheduleQueue(); // repeated immediate requests still coalesce
        }
        await f.tick(sample.waited, { passes: 0 });
      } finally {
        release(); // also release on an assertion failure; never abandon the pass
        await f.settle({ passes: 1, begun: 1 });
      }
      assert.deepEqual(f.events.starts, []);
      assert.equal(row.status, "planned", "the first refusal produces no status progress");
      const delay = sample.immediate ? 0 : sample.poll;
      assert.equal(f.events.passes[0].delay, delay);
      if (delay) await f.tick(delay - 1, { passes: 0 });
      await f.tick(delay ? 1 : 0);
      assert.deepEqual(f.events.entries, [NOW, NOW + sample.waited + delay]);
      assert.deepEqual(f.events.attempts, ["recheck", "recheck"]);
      assert.deepEqual(f.events.starts, ["recheck"]);
      row.status = "completed";
      await f.tick(2_000, { passes: 0 });
    });
  });
});

test("wake: a real scheduler error is logged, the later poll recovers, and terminal queues stop", async (t) => {
  await property(t, fc.record({ poll: fc.integer({ min: 1, max: 500 }), code: index,
    terminal: fc.constantFrom("completed", "failed", "cancelled", "interrupted", "not_resumable") }), 40,
  async ({ poll, code, terminal }) => {
    const row = queueRecord("recover", { status: "planned" });
    const failure = new Error(`fixture concurrency read failed ${code}`);
    const expectedErrors = [{ level: "warn", name: "queue.scheduler_failed", detail: { error: failure.message } }];
    let fail = true;
    await withScheduler(t, [row], { config: { queueBlockedPollMs: poll }, refresh: async () => {
      if (fail) { fail = false; throw failure; }
    } }, async (f) => {
      f.runtime.scheduleQueue();
      await f.tick(0, { expectedErrors });
      assert.deepEqual(f.events.logs, expectedErrors, "the scheduler must report the actual thrown error once");
      assert.deepEqual(f.events.attempts, []);
      assert.equal(row.status, "planned");
      assert.equal(f.events.passes[0].delay, poll);
      await f.tick(poll - 1, { passes: 0, expectedErrors });
      await f.tick(1, { expectedErrors });
      assert.deepEqual(f.events.entries, [NOW, NOW + poll]);
      assert.deepEqual(f.events.starts, ["recover"]);
      row.status = terminal;
      await f.tick(2_000, { passes: 0, expectedErrors });
      // A manually requested idle pass is allowed, but it must stop rearming.
      f.runtime.scheduleQueue();
      await f.tick(0, { expectedErrors });
      assert.equal(f.events.passes.at(-1).delay, null);
      await f.tick(2_000, { passes: 0, expectedErrors });
      assert.deepEqual(f.events.logs, expectedErrors);
      assert.deepEqual(f.events.attempts, ["recover"]);
    });
  });
});
