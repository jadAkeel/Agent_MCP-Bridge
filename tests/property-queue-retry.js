import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { RETRY_POLICY_HISTORY_MAX } from "../lib/queue.js";
import { retryFixture } from "./helpers/queue-retry-fixture.js";
import { MAX_AGENT_TIMEOUT_MS } from "../lib/scope-contract.js";

const options = { seed: Number(process.env.FC_SEED || 20261014),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}), numRuns: 100 };
async function property(t, arbitrary, body) {
  let generated = 0;
  await fc.assert(fc.asyncProperty(arbitrary, async sample => { generated++; await body(sample); }), options);
  t.diagnostic(`generated runs: ${generated}; seed: ${options.seed}`);
}
const repeats = fc.integer({ min: 2, max: 8 });

test("generated overlapping dispatch identities coalesce only equal cwd/job pairs and release after failure", async t => {
  await property(t, fc.record({ repeats, roots: fc.integer({ min: 2, max: 4 }), jobs: fc.integer({ min: 2, max: 4 }) }), async sample => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const f = retryFixture({ resolveRoot: async cwd => { calls.push(cwd); await gate; throw new Error("synthetic lookup IO"); } });
    const pending = [];
    try {
      for (let r = 0; r < sample.roots; r++) for (let j = 0; j < sample.jobs; j++) {
        const first = f.runtime.scheduleQueueRetryPolicy(`root-${r}`, `job-${j}`);
        pending.push(first);
        for (let n = 1; n < sample.repeats; n++) assert.strictEqual(f.runtime.scheduleQueueRetryPolicy(`root-${r}`, `job-${j}`), first);
      }
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), sample.roots * sample.jobs);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, sample.roots * sample.jobs);
      release();
      assert.ok((await Promise.all(pending)).every(result => result.action === "failed"));
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      assert.equal((await f.runtime.scheduleQueueRetryPolicy("root-0", "job-0")).action, "failed");
      assert.equal(calls.length, sample.roots * sample.jobs + 1);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { release(); await Promise.all(pending); f.close(); }
  });
});

test("generated slot/pause budget boundaries preserve execution budget and settle repeated dispatch", async t => {
  // Independent table of operational outcomes, including exact finite wait caps.
  const cases = fc.constantFrom(
    { errorType: "provider_slot_wait_timeout", counter: "slotWaitRequeues", cap: 12 },
    { errorType: "provider_paused", counter: "pauseWaitRequeues", cap: 24 },
  );
  await property(t, fc.record({ kind: cases, atCap: fc.boolean(), attempt: fc.integer({ min: 1, max: 10 }), headroom: fc.boolean(), repeats }), async s => {
    const waits = s.kind.cap - (s.atCap ? 0 : 1);
    const summary = { errorType: s.kind.errorType, retryAttempt: s.attempt, [s.kind.counter]: waits,
      ...(s.kind.counter === "pauseWaitRequeues" ? { providerRefusedUntil: "2099-01-01T00:00:00.000Z" } : {}) };
    const hasHeadroom = s.headroom && s.attempt < 10;
    const f = retryFixture({ summary, maxAttempts: s.attempt + (hasHeadroom ? 1 : 0) });
    try {
      await Promise.all(Array.from({ length: s.repeats }, () => f.runtime.scheduleQueueRetryPolicy("root", "old")));
      const expectedChildren = !s.atCap || hasHeadroom ? 1 : 0;
      assert.equal(f.children().length, expectedChildren);
      if (expectedChildren) {
        const child = f.children()[0];
        assert.equal(child.retryAttempt, s.attempt + (s.atCap ? 1 : 0));
        assert.equal(child[s.kind.counter], waits + (s.atCap ? 0 : 1));
        assert.equal(child[s.kind.counter === "slotWaitRequeues" ? "pauseWaitRequeues" : "slotWaitRequeues"], 0);
        assert.equal(child.attemptHistory.length, 1);
        assert.equal(f.read().requeuedAs, child.jobId);
      }
      assert.equal(f.read().retryDecisionOutcome, expectedChildren ? "requeued" : "gave_up");
      assert.equal(f.read().retryDecisionPendingAt, "");
      assert.equal(f.read().retryAttempt, s.attempt);
      const receipt = f.read();
      for (let n = 0; n < s.repeats; n++) await f.runtime.scheduleQueueRetryPolicy("root", "old");
      assert.deepEqual(f.read(), receipt);
      assert.equal(f.children().length, expectedChildren);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { f.close(); }
  });
});

test("generated receipt failures retain intent and recover one admitted successor without spending slot-wait budget twice", async t => {
  await property(t, fc.record({ repeats, attempt: fc.integer({ min: 1, max: 10 }), waits: fc.integer({ min: 0, max: 11 }) }), async s => {
    const f = retryFixture({ failMark: true, maxAttempts: s.attempt,
      summary: { errorType: "provider_slot_wait_timeout", retryAttempt: s.attempt, slotWaitRequeues: s.waits } });
    try {
      for (let n = 0; n < s.repeats; n++) {
        assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "failed");
        assert.deepEqual(f.read(), f.original);
        assert.equal(f.children().length, 1);
        assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      }
      f.repairMark();
      const result = await f.runtime.scheduleQueueRetryPolicy("root", "old");
      assert.equal(result.action, "requeued");
      const [child] = f.children();
      assert.equal(child.retryAttempt, s.attempt);
      assert.equal(child.slotWaitRequeues, s.waits + 1);
      assert.equal(child.attemptHistory.length, 1);
      assert.equal(f.read().requeuedAs, child.jobId);
      assert.equal(f.read().retryDecisionPendingAt, "");
      assert.equal(f.read().retryDecisionOutcome, "requeued");
      assert.equal(f.children().length, 1);
    } finally { f.close(); }
  });
});

test("generated counted retries preserve recent history and durably stop at the execution limit", async t => {
  await property(t, fc.record({ attempt: fc.integer({ min: 1, max: 10 }), headroom: fc.boolean(),
    historyLength: fc.constantFrom(0, 1, RETRY_POLICY_HISTORY_MAX - 1, RETRY_POLICY_HISTORY_MAX),
    errorType: fc.constantFrom("agent_timeout", "agent_exit_nonzero", "validation_command_failed"), repeats }), async s => {
    const hasHeadroom = s.headroom && s.attempt < 10;
    const history = Array.from({ length: s.historyLength }, (_, n) => `earlier-attempt-${n}`);
    const f = retryFixture({ maxAttempts: s.attempt + (hasHeadroom ? 1 : 0),
      summary: { retryAttempt: s.attempt, errorType: s.errorType, attemptHistory: history } });
    try {
      const result = await f.runtime.scheduleQueueRetryPolicy("root", "old");
      assert.equal(result.action, hasHeadroom ? "requeued" : "gave_up");
      if (!hasHeadroom) {
        assert.equal(result.attempts, s.attempt);
        assert.deepEqual(result.history, f.read().attemptHistory, "the result exposes the durable terminal history");
      }
      assert.equal(f.children().length, hasHeadroom ? 1 : 0);
      const recorded = hasHeadroom ? f.children()[0] : f.read();
      assert.equal(recorded.attemptHistory.length, Math.min(history.length + 1, RETRY_POLICY_HISTORY_MAX));
      assert.deepEqual(recorded.attemptHistory.slice(0, -1), history.slice(-(RETRY_POLICY_HISTORY_MAX - 1)));
      assert.ok(recorded.attemptHistory.at(-1).includes("old"), "history identifies the failed job");
      assert.ok(recorded.attemptHistory.at(-1).includes(s.errorType), "history retains the failure category");
      if (hasHeadroom) {
        assert.equal(recorded.retryAttempt, s.attempt + 1);
        assert.equal(recorded.maxAttempts, s.attempt + 1);
      } else assert.equal(recorded.completionOutcome, "gave_up");
      assert.equal(f.read().retryAttempt, s.attempt);
      assert.equal(f.read().retryDecisionPendingAt, "");
      assert.equal(f.read().retryDecisionOutcome, result.action);
      const receipt = f.read();
      for (let n = 0; n < s.repeats; n++) assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "none");
      assert.deepEqual(f.read(), receipt);
      assert.equal(f.children().length, hasHeadroom ? 1 : 0);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { f.close(); }
  });
});

test("generated incomplete successor receipts cannot report success; refused marks remain recoverable", async t => {
  await property(t, fc.record({ fault: fc.constantFrom("refused", "successor", "pending", "outcome"),
    attempt: fc.integer({ min: 1, max: 10 }), waits: fc.integer({ min: 0, max: 11 }), repeats }), async s => {
    const events = [];
    const f = retryFixture({ receiptFault: s.fault, maxAttempts: s.attempt,
      summary: { errorType: "provider_slot_wait_timeout", retryAttempt: s.attempt, slotWaitRequeues: s.waits },
      logEvent: (_level, event) => events.push(event) });
    try {
      const result = await f.runtime.scheduleQueueRetryPolicy("root", "old");
      assert.equal(result.action, "failed", "admission alone is not a completed retry decision");
      assert.equal(result.errorType, "retry_decision_persistence_failed");
      assert.equal(events.includes("queue.job_retried"), false);
      assert.equal(f.children().length, 1);
      const [child] = f.children();
      assert.equal(child.retryAttempt, s.attempt);
      assert.equal(child.slotWaitRequeues, s.waits + 1);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      if (s.fault === "refused") {
        assert.deepEqual(f.read(), f.original);
        f.repairReceipt();
        assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "requeued");
        assert.equal(f.read().requeuedAs, child.jobId);
        assert.equal(f.read().retryDecisionPendingAt, "");
        assert.equal(f.read().retryDecisionOutcome, "requeued");
        for (let n = 0; n < s.repeats; n++) await f.runtime.scheduleQueueRetryPolicy("root", "old");
        assert.deepEqual(f.children(), [child]);
      }
    } finally { f.close(); }
  });
});

test("generated detached failures contain logging errors, preserve error categories and release dispatch for recovery", async t => {
  await property(t, fc.record({ tagged: fc.boolean(), nullError: fc.boolean(), loggingFails: fc.boolean(), repeats }), async s => {
    let lookups = 0;
    const error = s.nullError ? null : Object.assign(new Error("synthetic lookup failure"), s.tagged ? { errorType: "SQLITE_BUSY" } : {});
    const f = retryFixture({ resolveRoot: async cwd => { if (++lookups === 1) throw error; return cwd; },
      logEvent: (_level, event) => { if (s.loggingFails && event === "queue.retry_policy_failed") throw new Error("synthetic logging failure"); } });
    try {
      const first = f.runtime.scheduleQueueRetryPolicy("root", "old");
      for (let n = 1; n < s.repeats; n++) assert.strictEqual(f.runtime.scheduleQueueRetryPolicy("root", "old"), first);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 1);
      assert.deepEqual(await first, { action: "failed", errorType: !s.nullError && s.tagged ? "SQLITE_BUSY" : "retry_policy_failed" });
      assert.deepEqual(f.read(), f.original);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      const next = f.runtime.scheduleQueueRetryPolicy("root", "old");
      assert.notStrictEqual(next, first);
      assert.equal((await next).action, "requeued");
      assert.equal(f.children().length, 1);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { f.close(); }
  });
});

const retryModels = ["fixture-a/model-a@high", "fixture-b/model-b", "fixture-c/model-c"];
const retryPins = [{ provider: "fixture-a", model: "model-a", variant: "high" },
  { provider: "fixture-b", model: "model-b" }, { provider: "fixture-c", model: "model-c" }];

test("generated rate-limit retries count every kind of produced work and bound silent pause waits", async t => {
  await property(t, fc.record({ errorType: fc.constantFrom("provider_rate_limited", "opencode_rate_limited", "opencode_quota_exhausted"),
    attempt: fc.integer({ min: 1, max: 10 }), headroom: fc.boolean(), waits: fc.constantFrom(0, 23, 24),
    outputCount: fc.integer({ min: 1, max: 1000 }), allPaused: fc.boolean() }), async s => {
    // Each signal alone is sufficient to make a started run count. In contrast,
    // a silent rate limit spends pause-wait budget until the finite cap is reached.
    const outcomes = [
      { fields: { usage: { outputCount: 0 }, assistantFinalResponseDetected: false, changedFiles: [] }, counted: false },
      { fields: { usage: { outputCount: s.outputCount } }, counted: true },
      { fields: { assistantFinalResponseDetected: true }, counted: true },
      { fields: { changedFiles: ["src/synthetic.txt"] }, counted: true },
    ];
    const pauses = new Map([["fixture-a", Date.parse("2099-01-01T00:20:00.000Z")],
      ["fixture-c", Date.parse("2099-01-01T00:05:00.000Z")],
      ...(s.allPaused ? [["fixture-b", Date.parse("2099-01-01T00:10:00.000Z")]] : [])]);
    for (const { fields, counted } of outcomes) {
      const chargesAttempt = counted || s.waits === 24;
      const hasHeadroom = s.headroom && s.attempt < 10;
      const admitted = !chargesAttempt || hasHeadroom;
      const f = retryFixture({ models: retryModels, modelRequirement: retryPins[0], pauses,
        maxAttempts: s.attempt + (hasHeadroom ? 1 : 0),
        summary: { errorType: s.errorType, retryAttempt: s.attempt, pauseWaitRequeues: s.waits, ...fields } });
      try {
        assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, admitted ? "requeued" : "gave_up");
        assert.equal(f.children().length, admitted ? 1 : 0);
        if (admitted) {
          const [child] = f.children();
          assert.equal(child.retryAttempt, s.attempt + Number(chargesAttempt));
          assert.equal(child.pauseWaitRequeues, s.waits + Number(!chargesAttempt));
          assert.equal(child.slotWaitRequeues, 0);
          assert.equal(child.infraRetryRequeues, 0);
          assert.deepEqual(child.scopeContract.modelRequirement, retryPins[s.allPaused ? 2 : 1],
            "use the available alternative, or hold for the earliest paused alternative");
          assert.equal(child.startAfter, s.allPaused ? "2099-01-01T00:05:00.000Z" : "");
          assert.equal(child.startAfterReason, s.allPaused ? "provider_pause" : "");
        } else assert.equal(f.read().completionOutcome, "gave_up");
        assert.equal(f.read().retryAttempt, s.attempt);
        assert.equal(f.read().retryDecisionPendingAt, "");
        const receipt = f.read();
        assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "none");
        assert.deepEqual(f.read(), receipt);
        assert.equal(f.children().length, admitted ? 1 : 0);
        assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      } finally { f.close(); }
    }
  });
});

test("generated infrastructure retries preserve the stored model and execution budget, back off, then stop at their own limit", async t => {
  await property(t, fc.record({ errorType: fc.constantFrom("agent_metadata_unavailable", "managed_skill_integrity_failed", "external_plugin_integrity_failed"),
    attempt: fc.integer({ min: 1, max: 10 }), modelIndex: fc.integer({ min: 0, max: 2 }),
    slotWaits: fc.integer({ min: 0, max: 12 }), pauseWaits: fc.integer({ min: 0, max: 24 }) }), async s => {
    // The operational backoff contract is 45s, 90s, 180s; no fourth automatic
    // infrastructure retry, even though it did not consume execution attempts.
    for (const [priorRetries, delayMs] of [[0, 45_000], [1, 90_000], [2, 180_000], [3, null]]) {
      const f = retryFixture({ models: retryModels, modelRequirement: retryPins[s.modelIndex], maxAttempts: s.attempt,
        pauses: new Map(retryPins.map(pin => [pin.provider, Date.parse("2099-01-01T00:00:00.000Z")])),
        summary: { errorType: s.errorType, retryAttempt: s.attempt, infraRetryRequeues: priorRetries,
          slotWaitRequeues: s.slotWaits, pauseWaitRequeues: s.pauseWaits } });
      try {
        const before = Date.now();
        const result = await f.runtime.scheduleQueueRetryPolicy("root", "old");
        const after = Date.now();
        assert.equal(result.action, delayMs === null ? "not_eligible" : "requeued");
        assert.equal(f.children().length, delayMs === null ? 0 : 1);
        if (delayMs !== null) {
          const [child] = f.children();
          assert.equal(child.retryAttempt, s.attempt);
          assert.equal(child.infraRetryRequeues, priorRetries + 1);
          assert.equal(child.slotWaitRequeues, s.slotWaits);
          assert.equal(child.pauseWaitRequeues, s.pauseWaits);
          assert.deepEqual(child.scopeContract.modelRequirement, retryPins[s.modelIndex], "attestation failure does not rotate the stored model");
          assert.equal(child.startAfterReason, "infrastructure_retry");
          const start = Date.parse(child.startAfter);
          assert.ok(start >= before + delayMs && start <= after + delayMs, "persist the contracted backoff without sleeping or borrowing a provider cooldown");
        }
        assert.equal(f.read().retryAttempt, s.attempt);
        assert.equal(f.read().retryDecisionPendingAt, "");
        const receipt = f.read();
        assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "none");
        assert.deepEqual(f.read(), receipt);
        assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
      } finally { f.close(); }
    }
  });
});

test("generated slot and pause waits rotate the candidate ring and persist the earliest all-paused deadline", async t => {
  await property(t, fc.record({ kind: fc.constantFrom("slot", "pause"), attempt: fc.integer({ min: 1, max: 10 }),
    slotWaits: fc.integer({ min: 0, max: 11 }), pauseWaits: fc.integer({ min: 0, max: 23 }),
    order: fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
    allPaused: fc.boolean(), selected: fc.integer({ min: 0, max: 2 }), deadlineOffset: fc.integer({ min: 1, max: 1000 }) }), async s => {
    // Model the scheduling order as a ring of tickets. Each prior execution or
    // wait moves one ticket to the back, independent of execution budget.
    const ring = [...s.order];
    for (let step = 0; step < s.attempt + s.slotWaits + s.pauseWaits; step++) ring.push(ring.shift());
    const earliest = Date.parse("2099-01-01T00:00:00.000Z") + s.deadlineOffset * 1000;
    const pauses = new Map();
    if (s.allPaused) {
      for (let index = 0; index < 3; index++) pauses.set(retryPins[index].provider, earliest + (index === s.selected ? 0 : 60_000));
    } else {
      // Block a prefix of the rotated order; the first free ticket must win.
      for (const index of ring.slice(0, s.selected)) pauses.set(retryPins[index].provider, earliest);
    }
    const expectedIndex = s.allPaused ? s.selected : ring[s.selected];
    const f = retryFixture({ models: s.order.map(index => retryModels[index]), modelRequirement: retryPins[s.order[0]],
      pauses, maxAttempts: s.attempt, summary: { errorType: s.kind === "slot" ? "provider_slot_wait_timeout" : "provider_paused",
        retryAttempt: s.attempt, slotWaitRequeues: s.slotWaits, pauseWaitRequeues: s.pauseWaits,
        ...(s.kind === "pause" ? { providerRefusedUntil: new Date(earliest).toISOString() } : {}) } });
    try {
      assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "requeued");
      const [child] = f.children();
      assert.equal(f.children().length, 1);
      assert.deepEqual(child.scopeContract.modelRequirement, retryPins[expectedIndex]);
      assert.equal(child.retryAttempt, s.attempt, "waiting must not consume the exhausted execution budget");
      assert.equal(child.slotWaitRequeues, s.slotWaits + Number(s.kind === "slot"));
      assert.equal(child.pauseWaitRequeues, s.pauseWaits + Number(s.kind === "pause"));
      assert.equal(child.startAfter, s.allPaused ? new Date(earliest).toISOString() : "");
      assert.equal(child.startAfterReason, s.allPaused ? "provider_pause" : "");
      assert.equal(f.read().requeuedAs, child.jobId);
      const receipt = f.read();
      assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "none");
      assert.deepEqual(f.read(), receipt);
    } finally { f.close(); }
  });
});

test("generated infrastructure failures outrank provider refusal for model pin and backoff", async t => {
  await property(t, fc.record({ errorType: fc.constantFrom("agent_metadata_unavailable", "managed_skill_integrity_failed", "external_plugin_integrity_failed"),
    prior: fc.integer({ min: 0, max: 2 }), modelIndex: fc.integer({ min: 0, max: 2 }),
    attempt: fc.integer({ min: 1, max: 10 }), waits: fc.constantFrom(0, 23, 24) }), async s => {
    const delay = [45_000, 90_000, 180_000][s.prior];
    const f = retryFixture({ models: retryModels, modelRequirement: retryPins[s.modelIndex], maxAttempts: s.attempt,
      pauses: new Map(retryPins.map(pin => [pin.provider, Date.parse("2099-01-01T00:00:00.000Z")])),
      summary: { errorType: s.errorType, retryAttempt: s.attempt, infraRetryRequeues: s.prior,
        pauseWaitRequeues: s.waits, providerRefusedUntil: "2099-01-01T00:00:00.000Z" } });
    try {
      const before = Date.now();
      assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "requeued");
      const after = Date.now(), [child] = f.children();
      assert.equal(child.retryAttempt, s.attempt);
      assert.equal(child.infraRetryRequeues, s.prior + 1);
      assert.deepEqual(child.scopeContract.modelRequirement, retryPins[s.modelIndex]);
      assert.equal(child.startAfterReason, "infrastructure_retry");
      assert.ok(Date.parse(child.startAfter) >= before + delay && Date.parse(child.startAfter) <= after + delay,
        "an inherited provider refusal cannot replace infrastructure backoff with a long provider pause");
      assert.equal(f.read().retryDecisionOutcome, "requeued");
    } finally { f.close(); }
  });
});

test("generated invalid manual requeue arguments refuse before decryption or admission", async t => {
  await property(t, fc.record({ negative: fc.integer({ min: -100000, max: -1 }),
    fraction: fc.integer({ min: 0, max: 1000 }).map(n => n + 0.5),
    tooLarge: fc.integer({ min: 1, max: 100000 }), whitespace: fc.constantFrom("", " ", "\t\n") }), async s => {
    const invalid = [
      ...[null, undefined, 17, {}, s.whitespace].map(jobId => ({ jobId })),
      ...[null, "1000", false, {}, NaN, Infinity, s.negative, 0, s.fraction, MAX_AGENT_TIMEOUT_MS + s.tooLarge]
        .map(timeoutMs => ({ jobId: "old", timeoutMs })),
      ...[null, false, 17, {}, []].map(model => ({ jobId: "old", model })),
    ];
    const f = retryFixture();
    try {
      for (const args of invalid) {
        const result = await f.runtime.requeueQueueJob({ cwd: "root", ...args });
        assert.equal(result.ok, false);
        assert.equal(result.errorType, "requeue_invalid_arguments", `reject ${JSON.stringify(args)}`);
      }
      assert.equal(f.observed.decryptions, 0);
      assert.deepEqual(f.observed.enqueueCalls, []);
      assert.deepEqual(f.children(), []);
      assert.deepEqual(f.read(), f.original);
    } finally { f.close(); }
  });
});

test("generated valid manual requeues preserve stored scope and admit timeout endpoints through the normal boundary", async t => {
  await property(t, fc.record({ timeout: fc.oneof(fc.constant(undefined), fc.constant(1), fc.constant(MAX_AGENT_TIMEOUT_MS),
    fc.integer({ min: 1, max: MAX_AGENT_TIMEOUT_MS })), modelIndex: fc.integer({ min: 0, max: 2 }),
    overrideModel: fc.boolean(), evidence: fc.boolean(), status: fc.constantFrom("failed", "cancelled", "interrupted", "not_resumable") }), async s => {
    const scope = { mode: "read", read: ["src/a.txt"], forbidden: ["secrets/**"],
      validation: { forbiddenFilesMustNotChange: true }, modelRequirement: { ...retryPins[0], requireRuntimeEvidence: s.evidence } };
    const f = retryFixture({ models: retryModels, status: s.status,
      storedRequest: { timeoutMs: 4321, scopeContract: scope, lockMode: "off", validationCommand: "node check.js" } });
    try {
      const result = await f.runtime.requeueQueueJob({ cwd: "root", jobId: "old", timeoutMs: s.timeout,
        ...(s.overrideModel ? { model: retryModels[s.modelIndex] } : {}) });
      assert.equal(result.ok, true);
      assert.equal(result.originalStatus, s.status);
      assert.equal(f.observed.enqueueCalls.length, 1);
      const { job, recordFields } = f.observed.enqueueCalls[0];
      const expectedScope = { ...scope, modelRequirement: { ...(s.overrideModel ? retryPins[s.modelIndex] : retryPins[0]), requireRuntimeEvidence: s.evidence } };
      assert.deepEqual(job.scopeContract, expectedScope);
      assert.equal(job.timeoutMs, s.timeout === undefined ? 4321 : s.timeout);
      assert.equal(job.validationCommand, "node check.js");
      assert.equal(job.lockMode, "off");
      assert.equal(job.agent, "reader");
      assert.equal(job.task, "synthetic");
      assert.deepEqual(job.models, retryModels);
      assert.equal(job.cwd, "root");
      assert.notEqual(job.idempotencyKey, "original-key");
      assert.equal(recordFields.requeuedFrom, "old");
      assert.equal(recordFields.requeueSequence, 1);
      assert.equal(Object.hasOwn(recordFields, "retryAttempt"), false, "manual admission does not inject automatic attempt counters");
      assert.equal(f.read().requeuedAs, result.record.jobId);
      assert.equal(f.read().retryDecisionOutcome, "requeued");
      assert.equal(f.read().retryDecisionPendingAt, "");
      const receipt = f.read();
      assert.equal((await f.runtime.requeueQueueJob({ cwd: "root", jobId: "old" })).errorType, "requeue_already_requeued");
      assert.deepEqual(f.read(), receipt);
      assert.equal(f.children().length, 1);
    } finally { f.close(); }
  });
});

test("generated manual admission and stored-request refusals never create or mark a successor", async t => {
  await property(t, fc.record({ caseIndex: fc.integer({ min: 0, max: 8 }), matches: fc.array(fc.constantFrom("package.json", "src/shared.js"), { maxLength: 3 }) }), async s => {
    const cases = [
      { options: { requestEncrypted: "" }, error: "requeue_request_not_stored", enqueues: 0 },
      { options: { decryptError: new Error("synthetic decryption fault") }, error: "requeue_request_unreadable", enqueues: 0 },
      { options: { storedRequest: { task: 12 } }, error: "requeue_request_invalid", enqueues: 0 },
      { options: { storedRequest: { cwd: "other-root" } }, error: "requeue_request_invalid", enqueues: 0 },
      { options: { storedRequest: { extraUncheckedField: true } }, error: "requeue_request_invalid", enqueues: 0 },
      { options: {}, args: { model: "not-a-model" }, error: "requeue_model_invalid", enqueues: 0 },
      { options: {}, args: { model: "unlisted/model" }, error: "requeue_model_not_allowlisted", enqueues: 0 },
      { options: { admissionResult: { ok: false, errorType: "queue_capacity_exceeded", error: "synthetic capacity fault" } }, error: "queue_capacity_exceeded", enqueues: 1 },
      { options: { admissionResult: { ok: false, errorType: "scope_serial_only", error: "synthetic lock admission refusal", serialOnlyMatches: s.matches } }, error: "scope_serial_only", enqueues: 1 },
    ];
    const c = cases[s.caseIndex], f = retryFixture(c.options);
    try {
      const result = await f.runtime.requeueQueueJob({ cwd: "root", jobId: "old", ...c.args });
      assert.equal(result.ok, false);
      assert.equal(result.errorType, c.error);
      if (s.caseIndex === 8) assert.deepEqual(result.serialOnlyMatches, s.matches);
      assert.equal(f.observed.enqueueCalls.length, c.enqueues);
      assert.deepEqual(f.children(), []);
      assert.deepEqual(f.read(), f.original);
    } finally { f.close(); }
  });
});

test("generated final decisions and cancellation markers are durable automatic-retry barriers", async t => {
  const barriers = [
    { status: "completed" }, { status: "cancelled" }, { status: "running" },
    { cancellationRequestedAt: "2099-01-01T00:00:00.000Z" },
    ...[{ cancellationRequested: true }, { cancellationRequestedAt: "cancelled" }, { parentJobId: "pipeline" },
      { requeuedAs: "existing-successor" }, { completionOutcome: "gave_up" },
      ...["requeued", "gave_up", "none", "not_eligible", "resume_disabled"].map(retryDecisionOutcome => ({ retryDecisionOutcome }))]
      .map(summary => ({ summary })),
  ];
  await property(t, fc.record({ barrier: fc.constantFrom(...barriers), repeats,
    attempt: fc.integer({ min: 1, max: 10 }), waits: fc.integer({ min: 0, max: 11 }) }), async s => {
    const f = retryFixture({ ...s.barrier, summary: { retryAttempt: s.attempt, slotWaitRequeues: s.waits,
      errorType: "provider_slot_wait_timeout", ...s.barrier.summary } });
    try {
      const before = f.db.prepare("SELECT * FROM opencode_jobs WHERE job_id = 'old'").get();
      for (let n = 0; n < s.repeats; n++) assert.equal((await f.runtime.scheduleQueueRetryPolicy("root", "old")).action, "none");
      assert.deepEqual(f.db.prepare("SELECT * FROM opencode_jobs WHERE job_id = 'old'").get(), before);
      assert.equal(f.observed.decryptions, 0);
      assert.deepEqual(f.observed.enqueueCalls, []);
      assert.deepEqual(f.children(), []);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { f.close(); }
  });
});

test("generated loss of terminal eligibility after admission cannot acknowledge a completed retry decision", async t => {
  await property(t, fc.record({ newStatus: fc.constantFrom("running", "pending"), waits: fc.integer({ min: 0, max: 11 }) }), async s => {
    // Inject a real SQL state change between synthetic admission and the real
    // predecessor CAS. This observes receipt loss without faking a policy result.
    const f = retryFixture({ maxAttempts: 1, summary: { errorType: "provider_slot_wait_timeout", slotWaitRequeues: s.waits },
      afterAdmission: db => db.prepare("UPDATE opencode_jobs SET status = ? WHERE job_id = 'old'").run(s.newStatus) });
    try {
      assert.deepEqual(await f.runtime.scheduleQueueRetryPolicy("root", "old"), { action: "failed", errorType: "retry_decision_persistence_failed" });
      assert.equal(f.children().length, 1, "admission exists but its predecessor receipt did not settle");
      assert.deepEqual(f.read(), f.original);
      assert.equal(f.runtime.getQueueRetryPoliciesInFlight(), 0);
    } finally { f.close(); }
  });
});
