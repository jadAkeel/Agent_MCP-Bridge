import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createQueueSchedulerRuntime } from "../../lib/queue/scheduler.js";
import { createQueueStartRuntime } from "../../lib/queue/start.js";
import { createAgentPolicyRuntime } from "../../lib/agent-policy.js";
import { createProviderQuarantineRuntime } from "../../lib/provider-quarantine.js";
import { createProviderLeaseRuntime } from "../../lib/provider-leases.js";

export const NOW = Date.UTC(2026, 9, 14);
export const ACTIVE = ["running", "validating", "reviewing", "testing"];
export const MODELS = ["alpha/Small", "alpha/Large", "beta/Medium", "gamma/Other"];

// This policy still lives in server.js. Evaluate only its actual function body,
// without importing the server (which would initialize real bridge state).
const serverSource = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const delaySource = serverSource.match(/^function nextQueueScheduleDelay\([^]*?^\}/m)?.[0];
assert.ok(delaySource, "the production wake-delay policy must be present");

export function queueRecord(jobId, patch = {}) {
  return { jobId, cwd: "fixture-repo-0", mode: "read", status: "pending",
    ownerInstanceId: "fixture-owner", ownerGeneration: "generation-0", request: {}, ...patch };
}

// Each caller owns a sequential node:test context. No real timer, filesystem
// state, database, process or provider is used by a generated case.
export async function withScheduler(t, records, settings, body) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  try {
    const jobs = new Map(records.map((record) => [record.jobId, record]));
    const config = { queueParallelLimit: 4, queueBlockedPollMs: 250,
      providerConcurrencyKey: "fixture-account", providerConcurrencyKeyExplicit: false,
      quotaGroups: [], ...settings.config };
    const state = { drain: false, memory: false, mode: "sqlite", policy: "wait",
      pauses: new Map(), pauseReadFails: false, refreshedLimit: config.queueParallelLimit,
      ...settings.state };
    const recovery = new Set(settings.recovery || []);
    const events = { starts: [], attempts: [], writes: [], claims: [], conflicts: [],
      logs: [], memoryHolds: 0, memoryReleases: 0, pauseReads: 0, passes: [],
      entries: [], maxConcurrentPasses: 0 };
    const policy = createAgentPolicyRuntime({ MCP_SANITIZED_READER_AGENT: "sanitized-reader",
      activeModelOverrideAllowlist: () => MODELS });
    const keys = createProviderQuarantineRuntime({ CONFIG: config });
    const { quotaGroupProviderKeys } = createProviderLeaseRuntime({ CONFIG: config,
      providerKeyForMetadata: keys.providerKeyForMetadata });
    const { queueRecordOwnedElsewhere } = createQueueStartRuntime({
      BRIDGE_INSTANCE_ID: "fixture-owner", CONFIG: config });
    const nextDelay = vm.runInNewContext(`(${delaySource})`, { CONFIG: config,
      Date: { now: () => Date.now() } });
    const write = async (record, patch) => {
      events.writes.push({ jobId: record.jobId, patch: structuredClone(patch) });
      Object.assign(record, patch);
      return { persisted: true };
    };
    const fixture = { jobs, config, state, recovery, events, keys };
    const runtime = createQueueSchedulerRuntime({ CONFIG: config, QUEUE_JOBS: jobs,
      INTEGRATION_RECOVERY_BLOCKED_ROOTS: recovery,
      ...policy, providerKeyForMetadata: keys.providerKeyForMetadata,
      modelPauseKeyForMetadata: keys.modelPauseKeyForMetadata, quotaGroupProviderKeys,
      effectiveQueueMode: () => state.mode,
      effectiveQueueWriteConflictPolicy: () => state.policy,
      queueDrainRequested: () => state.drain,
      queueMemoryGate: () => ({ blocked: state.memory }),
      holdQueueForMemory: () => { events.memoryHolds++; },
      releaseQueueMemoryHold: () => { events.memoryReleases++; },
      runningQueueRecords: () => [...jobs.values()].filter((record) => ACTIVE.includes(record.status)),
      refreshRuntimeConcurrency: async () => {
        events.entries.push(Date.now());
        events.maxConcurrentPasses = Math.max(events.maxConcurrentPasses, events.entries.length - events.passes.length);
        if (settings.refresh) await settings.refresh(fixture);
        config.queueParallelLimit = state.refreshedLimit;
      },
      activeProviderPauses: async () => {
        events.pauseReads++;
        if (state.pauseReadFails) throw new Error("fixture pause read failed");
        return new Map(state.pauses);
      },
      findQueueWriteConflict: async (record) => {
        events.conflicts.push(record.jobId);
        return settings.conflict ? await settings.conflict(record, fixture) : null;
      },
      updateQueueRecordDurable: write,
      updateQueueRecordDurableReacquiringLease: async (record, patch) => {
        events.claims.push({ jobId: record.jobId, patch: structuredClone(patch) });
        if (settings.claim) return await settings.claim(record, patch, fixture, write);
        return await write(record, patch);
      },
      queueRecordOwnedElsewhere,
      startQueueRecord: async (record) => {
        events.attempts.push(record.jobId);
        const started = settings.start ? await settings.start(record, fixture) : true;
        if (started) {
          record.status = "running";
          events.starts.push(record.jobId);
        }
        return started;
      },
      logEvent: (level, name, detail) => { events.logs.push({ level, name, detail }); },
      nextQueueScheduleDelay: (rows, capacity, progressed) => {
        const delay = nextDelay(rows, capacity, progressed);
        events.passes.push({ delay, capacity, progressed });
        return delay;
      },
    });
    fixture.runtime = runtime;
    const assertErrors = (expected = []) => {
      assert.deepEqual(events.logs.filter((event) => event.name === "queue.scheduler_failed"), expected,
        "scheduler errors must match the explicitly expected log, with none swallowed");
    };
    // Observe existing timers without requesting another wake. Absolute counts
    // also allow a deliberately suspended external operation to stay in flight.
    fixture.settle = async ({ passes, begun = passes, expectedErrors = [] }) => {
      for (let turn = 0; turn < 256; turn++) await Promise.resolve();
      assert.equal(events.entries.length, begun, "only the expected passes may enter");
      assert.equal(events.passes.length, passes, "only the expected passes may finish");
      assert.ok(events.maxConcurrentPasses <= 1, "scheduler passes must never overlap");
      assertErrors(expectedErrors);
    };
    fixture.tick = async (ms = 0, { passes = 1, begun = passes, expectedErrors = [] } = {}) => {
      const expectedPasses = events.passes.length + passes;
      const expectedEntries = events.entries.length + begun;
      t.mock.timers.tick(ms);
      await fixture.settle({ passes: expectedPasses, begun: expectedEntries, expectedErrors });
    };
    fixture.pass = async (advance = 0) => {
      const before = events.passes.length;
      runtime.scheduleQueue();
      t.mock.timers.tick(advance);
      // All fake external operations settle in microtasks. Bound this drain so
      // an omitted finalizer cannot hang a generated test or a mutation run.
      for (let turn = 0; turn < 256 && events.passes.length === before; turn++) await Promise.resolve();
      assert.equal(events.passes.length, before + 1, "exactly one scheduler pass must finish");
      assertErrors();
    };
    fixture.advance = (ms) => { t.mock.timers.setTime(Date.now() + ms); };
    await body(fixture);
  } finally {
    // Includes the production scheduler's automatically requeued wake. Never
    // runAll(): a genuinely blocked queue is allowed to keep polling forever.
    t.mock.timers.reset();
  }
}
