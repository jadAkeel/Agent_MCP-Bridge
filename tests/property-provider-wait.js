import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  providerWaitBudget, interruptProviderOperation, providerWaitProgressStorage,
  formatProviderWait,
} from "../lib/provider-wait.js";

// Fixed by default so mutation comparisons are repeatable. fast-check prints
// seed/path on failure; set FC_SEED and FC_PATH to replay a counterexample.
const options = { numRuns: 300, seed: Number(process.env.FC_SEED || 20261014),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
const positive = fc.integer({ min: 1, max: 2_000_000_000 });

test("caller budget never exceeds either caller or global limit", () => {
  fc.assert(fc.property(positive, positive, (global, caller) => {
    assert.deepEqual(providerWaitBudget(global, caller), {
      requestedMaxWaitMs: caller,
      effectiveMaxWaitMs: Math.min(global, caller),
      maxWaitMsClamped: caller > global,
    });
    assert.deepEqual(providerWaitBudget(global), {
      requestedMaxWaitMs: null, effectiveMaxWaitMs: global, maxWaitMsClamped: false,
    });
  }), options);
});

test("invalid explicit budgets are refused; invalid global budgets retain fallback", () => {
  fc.assert(fc.property(fc.oneof(fc.integer({ max: 0 }), fc.constantFrom(null, NaN,
    Infinity, -Infinity, "10", true, 1.5, Number.MAX_SAFE_INTEGER + 1)), (invalid) => {
    assert.throws(() => providerWaitBudget(100, invalid), RangeError);
  }), options);
  for (const global of [undefined, null, "", NaN, 0, -100]) {
    assert.equal(providerWaitBudget(global).effectiveMaxWaitMs, 1);
  }
  assert.equal(providerWaitBudget(20, 20).maxWaitMsClamped, false);
});

test("successful operations preserve values and failures, and remove listeners", async () => {
  await fc.assert(fc.asyncProperty(fc.jsonValue(), async (value) => {
    const parent = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = {
      get aborted() { return parent.signal.aborted; },
      addEventListener(...args) { added++; parent.signal.addEventListener(...args); },
      removeEventListener(...args) { removed++; parent.signal.removeEventListener(...args); },
    };
    let operationSignal;
    assert.equal(await interruptProviderOperation((inner) => {
      operationSignal = inner;
      assert.equal(inner.aborted, false);
      return value;
    }, { signal, deadlineAt: Date.now() + 60_000 }), value);
    assert.equal(added, 1);
    assert.equal(removed, 1);
    parent.abort();
    assert.equal(operationSignal.aborted, false);
    const error = new Error("operation failure");
    await assert.rejects(interruptProviderOperation(() => { throw error; }), (actual) => actual === error);
  }), { ...options, numRuns: 50 });
});

test("pre-cancelled and expired waits never start work", async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  await assert.rejects(interruptProviderOperation(() => calls++, { signal: parent.signal }),
    { code: "PROVIDER_CONCURRENCY_CANCELLED" });
  await assert.rejects(interruptProviderOperation(() => calls++, { deadlineAt: Date.now() - 1 }),
    { code: "PROVIDER_CONCURRENCY_TIMEOUT" });
  assert.equal(calls, 0);
});

test("active cancellation and deadline abort the operation signal", async () => {
  const parent = new AbortController();
  let inner;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const waiting = interruptProviderOperation((signal) => {
    inner = signal;
    started();
    return new Promise(() => {});
  }, { signal: parent.signal });
  const cancelled = assert.rejects(waiting, { code: "PROVIDER_CONCURRENCY_CANCELLED" });
  await ready;
  parent.abort();
  await cancelled;
  assert.equal(inner.aborted, true);
  assert.equal(inner.reason.code, "PROVIDER_CONCURRENCY_CANCELLED");
  await assert.rejects(interruptProviderOperation((signal) => {
    inner = signal;
    return new Promise(() => {});
  }, { deadlineAt: Date.now() + 20 }), { code: "PROVIDER_CONCURRENCY_TIMEOUT" });
  assert.equal(inner.aborted, true);
  assert.equal(inner.reason.code, "PROVIDER_CONCURRENCY_TIMEOUT");
});

test("parallel progress contexts do not leak across jobs", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 10 }), async (ids) => {
    await Promise.all(ids.map((id) => providerWaitProgressStorage.run({ id }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(providerWaitProgressStorage.getStore().id, id);
    })));
    assert.equal(providerWaitProgressStorage.getStore(), undefined);
  }), { ...options, numRuns: 50 });
});

test("an operation without a deadline stays active until explicitly cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const parent = new AbortController();
  let inner;
  const pending = interruptProviderOperation((signal) => {
    inner = signal;
    return new Promise(() => {});
  }, { signal: parent.signal });
  const cancelled = assert.rejects(pending, { code: "PROVIDER_CONCURRENCY_CANCELLED" });
  try {
    await Promise.resolve();
    t.mock.timers.tick(60_000);
    assert.equal(inner.aborted, false, "no deadline must not become an implicit timer");
    parent.abort();
    await cancelled;
  } finally {
    parent.abort();
    t.mock.timers.reset();
  }
});

test("deadline uses remaining time and cancellation between dispatch and start blocks work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  try {
    let inner;
    const pending = interruptProviderOperation((signal) => {
      inner = signal;
      return new Promise(() => {});
    }, { deadlineAt: 1100 });
    const rejected = assert.rejects(pending, {
      code: "PROVIDER_CONCURRENCY_TIMEOUT", message: "Provider wait deadline expired.",
    });
    await Promise.resolve();
    t.mock.timers.tick(99);
    assert.equal(inner.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(inner.aborted, true);
    let calls = 0;
    await assert.rejects(interruptProviderOperation(() => calls++, { deadlineAt: Date.now() }),
      { code: "PROVIDER_CONCURRENCY_TIMEOUT", message: "Provider wait deadline expired." });
    const parent = new AbortController();
    const raced = interruptProviderOperation(() => calls++, { signal: parent.signal });
    parent.abort();
    await assert.rejects(raced, { code: "PROVIDER_CONCURRENCY_CANCELLED",
      message: "Cancelled while waiting for provider capacity." });
    assert.equal(calls, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("wait diagnostics bound holder detail and distinguish unknown estimates", () => {
  const info = { jobId: "job-1", providerKey: "test/model", holders: 6, capacity: 2,
    globalWorkers: { held: 3, limit: 4 }, expectedWaitMs: null, waitedMs: 12,
    effectiveMaxWaitMs: 100, requestedMaxWaitMs: 200, maxWaitMsClamped: true,
    holderDetailsOmitted: 2, holderDetails: Array.from({ length: 6 }, (_, id) => ({
      instanceId: `holder-${id}`, pid: id + 1, ageMs: 5, expiresInMs: 10,
      quarantined: id === 0, containment: id === 1,
    })) };
  const text = formatProviderWait(info);
  assert.match(text, /^job-1: Waiting for provider slot test\/model; held 6\/2; global 3\/4;/);
  assert.match(text, /holder-0 pid=1 age=5ms quarantined \(no expiry\)/);
  assert.match(text, /holder-1 pid=2 age=5ms quarantined \(no expiry\)/);
  assert.match(text, /holder-2 pid=3 age=5ms expiresIn=10ms/);
  assert.doesNotMatch(text, /holder-4|holder-5/);
  assert.match(text, /\+4 more holders; expected wait: unknown; waited 12ms; budget 100ms \(clamped from 200ms\)/);
  const empty = formatProviderWait({ ...info, jobId: "", globalWorkers: null,
    holderDetails: undefined, holderDetailsOmitted: 0, expectedWaitMs: 50, maxWaitMsClamped: false });
  assert.match(empty, /^Waiting for provider slot/);
  assert.match(empty, /holder identity unavailable/);
  assert.match(empty, /50ms until a blocking lease expires/);
  assert.doesNotMatch(empty, /global |more holders|clamped from/);
});
