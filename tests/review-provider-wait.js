// B-195: real SQLite slot waits, request progress, public schemas and runner propagation.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createProviderLeaseRuntime } from "../lib/provider-leases.js";
import { createOpenCodeRunRuntime } from "../lib/opencode-run.js";
import { providerWaitBudget, providerWaitProgressStorage } from "../lib/provider-wait.js";
import { registerJobTools } from "../lib/tools/jobs.js";
process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "2";
process.env.CODEX_OPENCODE_PROVIDER_LEASE_POLL_MS = "25";
process.env.CODEX_OPENCODE_GLOBAL_WORKER_LIMIT = "0";
const scratch = await mkdtemp(path.join(tmpdir(), "review-provider-wait-"));
delete process.env.CODEX_OPENCODE_STATE_DIR;
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals;
__selfTest.hooks.stateDirectoryOverride = scratch;
const measurements = {};
const workerProcesses = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const key = "review-provider-wait";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function db(fn) { const handle = await I.openProviderLeaseDb(); try { return fn(handle); } finally { I.closeDb(handle); } }
async function reset() { await db(handle => { handle.exec("DELETE FROM provider_leases; DELETE FROM provider_capacities; DELETE FROM provider_cooldowns; DELETE FROM runtime_settings;"); }); }
async function holders(providerKey = key) {
  const a = await I.acquireProviderLease({ providerKey, timeoutMs: 1000 });
  const b = await I.acquireProviderLease({ providerKey, timeoutMs: 1000 });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const now = Date.now();
  await db(handle => {
    handle.prepare("UPDATE provider_leases SET owner_instance_id = ?, created_at = ?, expires_at = ? WHERE lease_id = ?").run("bridge-A", now - 10000, now + 60000, a.lease.id);
    handle.prepare("UPDATE provider_leases SET owner_instance_id = ?, created_at = ?, expires_at = ? WHERE lease_id = ?").run("bridge-B", now - 20000, now + 90000, b.lease.id);
  });
  return [a.lease, b.lease];
}
function harness({ waitedMs = 0, revalidateAfterMs = 60_000, pluginOk = true, leaseOk = true, agentOk = true, finalMaxAgeMs = 0, reattestHit = true } = {}, overrides = {}) {
  const calls = [];
  const metadata = { name: "builder", mode: "write", provider: "opencode", model: "muse-spark-1.3-contributor-free", variant: "" };
  const okPluginPolicy = { ok: true, mode: "allowlisted", plugins: [] };
  const lease = { id: "lease-1", expiresAt: Date.now() + 60_000 };
  const heartbeat = Object.assign(async () => { calls.push("heartbeat.stop"); }, { signal: null, pulse: async () => ({ ok: true }) });
  const inspection = {
    finalText: "REPORT: done", usage: {}, toolOutcomes: [], heavyToolCalls: [], parsedEvents: 1, invalidLines: 0,
    malformedEventLines: [], streamIntegrity: "ok", permissionDeniedCount: 0, runtimeModelIdentities: [],
    finalResponseDetected: true, finalTextTruncated: false, providerErrorType: "", providerWarningType: "",
    providerRetryWarningCount: 0, recoveredTransientProviderError: false, apiErrorDetected: false, retryAfterMs: 0,
    runtimeObservedProvider: "", runtimeObservedModel: "", runtimeModelConflict: false, modelEvidenceAmbiguous: false,
  };
  const deps = {
    CONFIG: { providerWaitMaxMs: 1000, attestationRevalidateAfterMs: revalidateAfterMs, attestationFinalMaxAgeMs: finalMaxAgeMs, rateLimitHits: 0, requireRuntimeModelEvidence: false },
    // B-171: the server's age-limited cache read; the harness answers with a hit or a fresh read.
    reattestAgentMetadata: async () => {
      calls.push("attest.reuse");
      return { ok: true, metadata, pluginPolicy: okPluginPolicy, attestationKey: "agent-metadata\0builder\0test", attestedAtMs: Date.now(), attestationCacheHit: reattestHit };
    },
    MCP_CONTRACTOR_ORCHESTRATOR_AGENT: "opencode-orchestrator-mcp-contractor",
    OPENCODE_EXE: "opencode",
    acquireProviderLease: async ({ providerKey }) => {
      calls.push(`lease.acquire:${providerKey}`);
      return leaseOk
        ? { ok: true, lease, waitedMs }
        : { ok: false, errorType: "provider_slot_wait_timeout", error: "every slot stayed held", waitedMs, holders: 6, capacity: 6 };
    },
    agentIdleTimeoutForModel: () => 0,
    allowlistedModelOverride: () => null,
    applyModelOverrideToMetadata: (value) => value,
    applyRateLimitOutcome: async () => ({}),
    buildOpenCodeEnv: () => ({}),
    classifyResultError: () => "",
    clearAgentActivity: () => {},
    combineAbortSignals: () => null,
    commandShape: () => "opencode run <prompt>",
    containmentRecord: async () => ({}),
    createIsolatedOpenCodeRuntime: async () => { calls.push("isolated.create"); return { root: "isolated-root", env: {} }; },
    defaultWriteAgentTimeoutMs: 60_000,
    delayWithSignal: async () => {},
    detectsOpenCodeFallback: () => false,
    effectiveReadOnlyMetadataError: (result) => (result?.ok ? null : { errorType: result?.errorType || "agent_metadata_unavailable", error: result?.error || "unavailable" }),
    emptyOpenCodeUsage: () => ({}),
    inspectOpenCodeEventStream: () => inspection,
    isManagedReadOnlyAgent: () => false,
    isTimeoutResult: () => false,
    logEvent: () => {},
    maxReadOnlyAgentRetries: 0,
    mergeHeavyToolCalls: (value) => value,
    modelPauseKeyForMetadata: (value) => `${value.provider}/${value.model}`,
    noteAgentActivity: () => {},
    nowMs: () => Date.now(),
    openCodeCommandLineLengthError: () => "",
    openCodeRunArgs: () => ["run"],
    parseDependencyRequest: () => ({ request: null, error: "" }),
    providerKeyForMetadata: (value) => value.provider,
    providerSlotWaitStorage: { getStore: () => null },
    providerSlotWaitingJobs: new Map(),
    quarantineProviderLease: async () => ({ ok: true }),
    rateLimitPauseReason: () => "",
    readAgentDebugMetadata: async () => ({ ok: true, metadata }),
    readAgentDebugMetadataUncached: async () => {
      calls.push("attest.agent");
      return agentOk ? { ok: true, metadata } : { ok: false, errorType: "agent_metadata_invalid", error: "permission drift", metadata: null };
    },
    recordProviderCooldown: async () => ({}),
    recordRateLimitPause: async () => ({}),
    releaseProviderLease: async () => { calls.push("lease.release"); },
    runSpawnCommand: async () => {
      calls.push("spawn");
      return { stdout: "", stderr: "", exitCode: 0, childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() };
    },
    startProviderLeaseHeartbeat: () => { calls.push("heartbeat.start"); return heartbeat; },
    summarizeStderr: (value) => String(value || ""),
    timeoutForAgent: () => 60_000,
    verifyExternalPluginPolicy: async () => {
      calls.push("attest.plugins");
      return pluginOk ? { ok: true, mode: "allowlisted", plugins: [] } : { ok: false, errorType: "plugin_policy_rejected", error: "plugin drift" };
    },
    wipeIsolatedOpenCodeRuntime: async () => { calls.push("isolated.wipe"); return { ok: true, error: "" }; },
    ...overrides,
  };
  return { calls, deps, metadata, runtime: createOpenCodeRunRuntime(deps) };
}


test("caller budget is separate, clamped, and validates positive safe integers", () => {
  assert.deepEqual(providerWaitBudget(1200000), { requestedMaxWaitMs: null, effectiveMaxWaitMs: 1200000, maxWaitMsClamped: false });
  assert.deepEqual(providerWaitBudget(300, 5000), { requestedMaxWaitMs: 5000, effectiveMaxWaitMs: 300, maxWaitMsClamped: true });
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => providerWaitBudget(1000, value));
});
test("5-second expiry emits real holders immediately; get_job agrees; no spawn or waiter lease", async () => {
  await reset();
  const workerPath = path.join(scratch, "slot-holder.mjs");
  await writeFile(workerPath, `
    import ${JSON.stringify(pathToFileURL(path.resolve("tests/test-env.js")).href)};
    process.argv.push("--self-test");
    const { __selfTest } = await import(${JSON.stringify(pathToFileURL(path.resolve("server.js")).href)});
    const I = __selfTest.internals;
    __selfTest.hooks.stateDirectoryOverride = ${JSON.stringify(scratch)};
    const result = await I.acquireProviderLease({ providerKey: "review-provider-wait", timeoutMs: 1000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
    process.send({ lease: result.lease, pid: process.pid });
    process.on("disconnect", () => process.exit(0));
  `);
  const identities = [];
  const holderEnv = { ...process.env };
  delete holderEnv.CODEX_OPENCODE_STATE_DIR;
  for (let index = 0; index < 2; index++) {
    const child = fork(workerPath, [], { env: holderEnv, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    workerProcesses.push(child);
    const identity = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Slot holder startup timed out")), 10000);
      child.once("message", value => { clearTimeout(timer); resolve(value); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error("Slot holder exited: " + code)); });
    });
    identities.push(identity);
  }
  await db(handle => {
    const rows = handle.prepare("SELECT lease_id, owner_instance_id, owner_pid FROM provider_leases ORDER BY created_at").all();
    assert.equal(rows.length, 2);
    rows.forEach((row, index) => {
      assert.equal(Number(row.owner_pid), identities[index].pid);
      identities[index].instanceId = row.owner_instance_id;
      handle.prepare("UPDATE provider_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() + (index ? 90000 : 60000), row.lease_id);
    });
  });
  const queue = { jobId: "wait-job", status: "running", cwd: scratch };
  const tools = {};
  registerJobTools({ server: { tool: (name, ...args) => { tools[name] = args.at(-1); } },
    CONFIG: I.CONFIG, QUEUE_JOBS: new Map(), providerSlotWaitingJobs: I.providerSlotWaitingJobs,
    resolveProjectStateRoot: async cwd => cwd, authoritativeQueueRecord: async () => queue,
    effectiveQueueMode: () => "sqlite", queueRunStage: () => "waiting_for_provider_slot",
    queueAgentActivity: () => ({}), formatOpenCodeUsage: () => "",
  });
  let first = null; const notifications = []; const started = Date.now();
  const h = harness({ finalMaxAgeMs: 60000 }, {
    acquireProviderLease: async options => I.acquireProviderLease({ ...options, providerKey: key, timeoutMs: 10000 }),
  });
  const run = I.wrapToolHandler("review-wait", () => I.providerSlotWaitStorage.run({
    jobId: queue.jobId, onWait: async info => {
      queue.providerWaitInfo = info;
      if (!first) {
        first = { info, elapsed: Date.now() - started };
        const view = JSON.parse((await tools.get_opencode_job({ jobId: queue.jobId, cwd: scratch })).content[0].text);
        assert.deepEqual(view.providerWaitInfo, info);
        const rows = await db(handle => handle.prepare("SELECT * FROM provider_leases").all());
        assert.equal(rows.length, 2, "a waiting job has no lease");
      }
    },
  }, () => h.runtime.runOpenCode("builder", "work", scratch, false, 120000, {
    maxWaitMs: 5000, agentMetadata: { ok: true, metadata: h.metadata, pluginPolicy: { ok: true }, attestationKey: "recent", attestedAtMs: Date.now() },
  })));
  const result = await run({}, { _meta: { progressToken: "wait-token" }, sendNotification: async value => { notifications.push(value); } });
  measurements.expiry = { elapsedMs: Date.now() - started, firstProgressMs: first?.elapsed, holders: first?.info.holderDetails.length, waitMs: result.providerConcurrencyWaitMs };
  assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
  assert.ok(Date.now() - started >= 4900 && Date.now() - started < 6500);
  assert.ok(first && first.elapsed < 10000);
  assert.equal(first.info.holderDetails.length, 2);
  assert.deepEqual(first.info.holderDetails.map(h => h.instanceId).sort(), identities.map(h => h.instanceId).sort());
  assert.deepEqual(first.info.holderDetails.map(h => h.pid).sort(), identities.map(h => h.pid).sort());
  assert.ok(first.info.holderDetails.every(h => h.pid !== process.pid && h.ageMs >= 0));
  assert.ok(first.info.expectedWaitMs > 55000 && first.info.expectedWaitMs <= 60000);
  assert.ok(notifications[0].params.message.includes(identities[0].instanceId) && notifications[0].params.message.includes("pid=") && notifications[0].params.message.includes("heartbeats may extend"));
  assert.equal(result.timeoutMs, 120000); assert.ok(!h.calls.includes("spawn"));
  assert.equal((await db(handle => handle.prepare("SELECT COUNT(*) AS n FROM provider_leases").get())).n, 2);
  assert.equal(I.providerSlotWaitingJobs.has(queue.jobId), false);
});
test("caller larger than global budget gets distinct expiry plus clamp evidence", async () => {
  await reset(); await holders();
  const result = await I.acquireProviderLease({ providerKey: key, timeoutMs: 180, maxWaitMs: 5000 });
  assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
  assert.equal(result.maxWaitMsClamped, true); assert.equal(result.effectiveMaxWaitMs, 180);
  assert.match(result.error, /clamped.*agent timeout was not spent/);
  assert.equal(result.agentNeverStarted, true); assert.equal(result.agentTimeoutSpentMs, 0);
});
test("absence retains the global timeout error", async () => {
  await reset(); await holders();
  const result = await I.acquireProviderLease({ providerKey: key, timeoutMs: 100 });
  assert.equal(result.errorType, "provider_slot_wait_timeout");
  assert.equal(result.requestedMaxWaitMs, null);
});
test("release during wait grants exactly one slot and reports actual time", async () => {
  await reset(); const [a] = await holders();
  const timer = setTimeout(() => { void db(handle => handle.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(a.id, "bridge-A")); }, 180);
  try {
    const started = Date.now();
    const result = await I.acquireProviderLease({ providerKey: key, timeoutMs: 2000, maxWaitMs: 1000 });
    measurements.freedSlot = { waitedMs: result.waitedMs, elapsedMs: Date.now() - started };
    assert.equal(result.ok, true);
    assert.ok(result.waitedMs >= 150 && result.waitedMs < 600);
    assert.ok(Math.abs(result.waitedMs - (Date.now() - started)) < 30);
    assert.equal(result.waitInfo.waiting, false);
    assert.equal((await db(handle => handle.prepare("SELECT COUNT(*) AS n FROM provider_leases").get())).n, 2);
    await I.releaseProviderLease(result.lease);
  } finally { clearTimeout(timer); }
});
test("global cap names holders on other providers", async () => {
  await reset(); await holders();
  assert.equal((await I.setRuntimeConcurrency({ globalWorkerLimit: 2 })).ok, true);
  try {
    const result = await I.acquireProviderLease({ providerKey: "another-provider", timeoutMs: 2000, maxWaitMs: 100 });
    assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
    assert.equal(result.waitInfo.holders, 0); assert.equal(result.waitInfo.globalWorkers.held, 2);
    assert.equal(result.waitInfo.holderDetails.length, 2);
  } finally { await I.setRuntimeConcurrency({ globalWorkerLimit: 0 }); }
});
test("L-2-F7-2: a quarantined holder never fails the waiter; diagnostics name the quarantine", async () => {
  await reset(); await holders();
  const now = Date.now();
  await db(handle => {
    handle.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at, containment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("quarantine-1", key, "bridge-gone", 2 ** 30, now - 5000, now - 1000, Number.MAX_SAFE_INTEGER,
        JSON.stringify({ complete: false, recordedAt: now }));
  });
  const started = Date.now();
  const result = await I.acquireProviderLease({ providerKey: key, timeoutMs: 2000, maxWaitMs: 500 });
  const elapsed = Date.now() - started;
  assert.notEqual(result.errorType, "provider_concurrency_failed", JSON.stringify(result));
  assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
  assert.ok(elapsed >= 450 && elapsed < 2000, `waited the budget instead of failing at once: ${elapsed} ms`);
  const quarantined = (result.waitInfo.holderDetails || []).filter(holder => holder.quarantined);
  assert.equal(quarantined.length, 1, JSON.stringify(result.waitInfo.holderDetails));
  assert.equal(quarantined[0].expiresAt, "quarantined (no expiry)");
  assert.equal(quarantined[0].expiresInMs, null);
  assert.equal(result.waitInfo.holderCount, 3);
  assert.equal(result.waitInfo.holderDetailsOmitted, 0);
});
test("L-2-F7-2: a quarantine on another provider never fails a waiter under the global cap", async () => {
  await reset(); await holders();
  const now = Date.now();
  await db(handle => {
    handle.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at, containment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("quarantine-global", key, "bridge-gone", 2 ** 30, now - 5000, now - 1000, Number.MAX_SAFE_INTEGER,
        JSON.stringify({ complete: false, recordedAt: now }));
  });
  assert.equal((await I.setRuntimeConcurrency({ globalWorkerLimit: 3 })).ok, true);
  try {
    const result = await I.acquireProviderLease({ providerKey: "another-provider", timeoutMs: 2000, maxWaitMs: 300 });
    assert.notEqual(result.errorType, "provider_concurrency_failed", JSON.stringify(result));
    assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
    assert.ok((result.waitInfo.holderDetails || []).some(holder => holder.quarantined === true), JSON.stringify(result.waitInfo.holderDetails));
  } finally { await I.setRuntimeConcurrency({ globalWorkerLimit: 0 }); }
});
test("L-2-F7-3: maxWaitMs is one job-wide budget shared by every slot wait of the job", async () => {
  await reset(); await holders();
  const waitBudget = {};
  const attempt = () => I.providerSlotWaitStorage.run({ jobId: `job-wide-${Math.random()}` },
    () => I.acquireProviderLease({ providerKey: key, timeoutMs: 2000, maxWaitMs: 1500, waitBudget }));
  const started = Date.now();
  const first = await attempt();
  const second = await attempt();
  const total = Date.now() - started;
  assert.equal(first.errorType, "provider_slot_wait_limit_exceeded");
  assert.equal(second.errorType, "provider_slot_wait_limit_exceeded");
  assert.ok(first.waitedMs >= 1400, `first wait spent the shared budget: ${first.waitedMs} ms`);
  assert.ok(second.waitedMs < 400, `second wait had no budget left: ${second.waitedMs} ms`);
  assert.ok(total >= 1400 && total < 2200, `two waits share one 1,500 ms budget, not two: ${total} ms`);
  console.log(`Two waits with maxWaitMs=1,500 shared one budget: ${total} ms total`);
});
test("L-2-F7-3: without maxWaitMs the provider default is the job-wide budget the same way", async () => {
  await reset(); await holders();
  const waitBudget = {};
  const attempt = () => I.providerSlotWaitStorage.run({ jobId: `job-wide-default-${Math.random()}` },
    () => I.acquireProviderLease({ providerKey: key, timeoutMs: 400, waitBudget }));
  const started = Date.now();
  const first = await attempt();
  const second = await attempt();
  const total = Date.now() - started;
  assert.equal(first.errorType, "provider_slot_wait_timeout");
  assert.equal(second.errorType, "provider_slot_wait_timeout");
  assert.ok(total >= 350 && total < 900, `two waits share one 400 ms default budget, not two: ${total} ms`);
});
test("L-2-F7-4: cancel during quarantine reclaim is honoured within ~100ms", async () => {
  const directory = await mkdtemp(path.join(scratch, "reclaim-cancel-"));
  const runtime = createProviderLeaseRuntime({ ...I, BRIDGE_INSTANCE_ID: "reclaim-cancel",
    CONFIG: { ...I.CONFIG, providerConcurrencyLimit: 1, providerLeasePollMs: 25, globalWorkerLimit: 0 },
    RUNTIME_CONCURRENCY: { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, providerLimits: new Map() },
    effectiveBridgeStateDirectory: () => directory,
    reclaimProvenGoneProviderQuarantines: async () => { await sleep(1500); return 0; },
  });
  // The fill uses a budget longer than the slow reclaim so the slot is held first.
  const held = await runtime.acquireProviderLease({ providerKey: key, timeoutMs: 5000 });
  assert.equal(held.ok, true, JSON.stringify(held));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const started = Date.now();
    const result = await runtime.acquireProviderLease({ providerKey: key, timeoutMs: 10000, maxWaitMs: 10000, signal: controller.signal });
    const elapsed = Date.now() - started;
    console.log(`Cancel during a 1.5 s reclaim honoured after ${elapsed} ms`);
    assert.equal(result.errorType, "agent_cancelled");
    assert.ok(elapsed < 1000, `cancel honoured late: ${elapsed} ms`);
  } finally { clearTimeout(timer); await runtime.releaseProviderLease(held.lease); }
});
test("L-2-F7-4: cancel after the grant never starts the post-grant re-attestation and releases the slot", async () => {
  const controller = new AbortController();
  const h = harness({ waitedMs: 120000, revalidateAfterMs: 60000, finalMaxAgeMs: 60000 }, {
    acquireProviderLease: async () => {
      controller.abort();
      return { ok: true, lease: { id: "lease-1", expiresAt: Date.now() + 60000 }, waitedMs: 120000 };
    },
  });
  const result = await h.runtime.runOpenCode("builder", "work", scratch, false, 120000, { signal: controller.signal,
    agentMetadata: { ok: true, metadata: h.metadata, pluginPolicy: { ok: true }, attestationKey: "recent", attestedAtMs: Date.now() } });
  assert.equal(result.errorType, "agent_cancelled");
  assert.ok(!h.calls.includes("spawn"), "no agent started");
  assert.ok(h.calls.includes("lease.release"), "the granted slot was released");
  assert.equal(h.calls.filter(call => call === "attest.reuse").length, 1, "only the pre-lease attestation ran");
});
test("parallel expiry does not cancel another provider's job", async () => {
  await reset(); await holders();
  const [expired, granted] = await Promise.all([
    I.providerSlotWaitStorage.run({ jobId: "parallel-a" }, () => I.acquireProviderLease({ providerKey: key, timeoutMs: 2000, maxWaitMs: 100 })),
    I.providerSlotWaitStorage.run({ jobId: "parallel-b" }, () => I.acquireProviderLease({ providerKey: "parallel-free", timeoutMs: 2000, maxWaitMs: 1000 })),
  ]);
  assert.equal(expired.errorType, "provider_slot_wait_limit_exceeded");
  assert.equal(granted.ok, true); await I.releaseProviderLease(granted.lease);
});
test("read-only off policy and external runner forward the caller budget", async () => {
  await reset(); await holders();
  const h = harness({}, { acquireProviderLease: async options => {
    assert.equal(options.maxWaitMs, 100);
    return I.acquireProviderLease({ ...options, providerKey: key, timeoutMs: 2000 });
  } });
  const result = await h.runtime.runOpenCodeWithPolicy("explore", "inspect", scratch, false, { lockType: "read", lockMode: "off" }, 120000, { maxWaitMs: 100, agentMetadata: { ok: true, metadata: h.metadata, pluginPolicy: { ok: true } } });
  assert.equal(result.errorType, "provider_slot_wait_limit_exceeded"); assert.ok(!h.calls.includes("spawn"));
  const external = harness({}, {
    externalRunnerSelection: () => ({ runner: "test" }), runExternalCli: async (_selection, options) => {
      assert.equal(options.maxWaitMs, 321); return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    },
  });
  await external.runtime.runOpenCodeWithPolicy("builder", "work", scratch, false, { lockType: "write" }, 1000, { maxWaitMs: 321 });
});
test("run, enqueue, plans and parallel advertise the same schema", () => {
  for (const name of ["run_opencode_agent", "enqueue_opencode_job", "validate_delegation_plan", "run_opencode_parallel"]) {
    const schema = I.server._registeredTools[name].inputSchema;
    const shape = schema.shape;
    const jobShape = shape.maxWaitMs ? shape : shape.jobs.element.shape;
    assert.equal(jobShape.maxWaitMs.parse(5000), 5000);
    assert.equal(jobShape.maxWaitMs.parse(undefined), undefined);
    assert.throws(() => jobShape.maxWaitMs.parse(0));
  }
});

test("public direct/parallel and persisted enqueue keep the caller's field", async () => {
  const cwd = path.join(scratch, "repo");
  await mkdir(cwd);
  for (const args of [["init", "-q"], ["-c", "user.name=Review", "-c", "user.email=review@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"]]) {
    const git = await I.runCommand("git", args, cwd, 30000);
    assert.equal(git.exitCode, 0, git.stderr);
  }
  const received = [];
  __selfTest.hooks.agentRuntimeTestHook = {
    resolveAgent: async agent => ({ requestedAgent: agent, actualAgent: agent, requestedAgentMode: "primary", actualAgentMode: "primary", fallbackUsed: false, proxyUsed: false, availableAgents: [agent], discoveryExitCode: 0 }),
    readAgentDebugMetadata: async agent => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "fixture-model", variant: "",
      canEdit: false, canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: "fixture",
    } }),
    runOpenCodeWithPolicy: async (_agent, _prompt, _cwd, _dryRun, _plan, _timeout, options) => {
      received.push(options.maxWaitMs);
      return { exitCode: 0, stdout: "REPORT: inspected.", stderr: "", errorType: null, durationMs: 1, assistantFinalResponseDetected: true, childExecutionIntervals: [] };
    },
  };
  try {
    const job = { agent: "explore", task: "Inspect", cwd, write: false, lockMode: "off", maxWaitMs: 1234 };
    const response = await I.server._registeredTools.run_opencode_agent.handler(job, {});
    assert.ok(received.includes(1234), JSON.stringify(response));
    const parallel = await I.server._registeredTools.run_opencode_parallel.handler({ jobs: [{ ...job, maxWaitMs: 2345 }, { ...job, maxWaitMs: 3456 }] }, {});
    assert.ok(received.includes(2345) && received.includes(3456), JSON.stringify(parallel));
    const queued = await I.enqueueQueueJob({ ...job, dryRun: true, maxWaitMs: 4567 }, "");
    assert.equal(queued.ok, true, JSON.stringify(queued));
    const record = I.QUEUE_JOBS.get(queued.record?.jobId || queued.jobId);
    assert.equal(record.request.maxWaitMs, 4567);
    const deadline = Date.now() + 20000;
    while (["pending", "running", "planned"].includes(record.status) && Date.now() < deadline) await sleep(25);
    assert.equal(record.status, "completed", JSON.stringify(record));
    const plan = await I.server._registeredTools.validate_delegation_plan.handler({ jobs: [job] }, {});
    assert.ok(!plan.isError, JSON.stringify(plan));
  } finally { __selfTest.hooks.agentRuntimeTestHook = null; }
});

test("finished enqueue/tool requests never emit later job progress", async () => {
  let callback; const events = [];
  const handler = I.wrapToolHandler("progress-lifetime", () => { callback = providerWaitProgressStorage.getStore().onWait; return {}; });
  await handler({}, { _meta: { progressToken: "done-token" }, sendNotification: async event => { events.push(event); } });
  callback({ jobId: "later-queue-job", providerKey: key, waiting: true, holders: 2, capacity: 2, holderDetails: [], expectedWaitMs: null, waitedMs: 1, effectiveMaxWaitMs: 1000 });
  assert.equal(events.length, 0);
});

test("queue progress ownership loss after grant returns the unused lease", async () => {
  await reset(); const [a] = await holders();
  const timer = setTimeout(() => { void db(handle => handle.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(a.id, "bridge-A")); }, 100);
  try {
    await assert.rejects(() => I.providerSlotWaitStorage.run({ jobId: "queue-lost-owner", onWait: async info => {
      if (!info.waiting) throw new Error("queue ownership lost");
    } }, () => I.acquireProviderLease({ providerKey: key, timeoutMs: 2000, maxWaitMs: 1000 })), /queue ownership lost/);
    assert.equal((await db(handle => handle.prepare("SELECT COUNT(*) AS n FROM provider_leases").get())).n, 1);
    assert.equal(I.providerSlotWaitingJobs.has("queue-lost-owner"), false);
  } finally { clearTimeout(timer); }
});

// A dedicated runtime counts only handles owned by the wait, not other callers' reads.
async function measuredLeaseRuntime() {
  const directory = await mkdtemp(path.join(scratch, "measured-"));
  const profile = { enabled: false, opens: 0, closes: 0, looks: [] };
  const handles = new Set();
  let openingAt = 0;
  let fault = "";
  const runtime = createProviderLeaseRuntime({
    ...I,
    BRIDGE_INSTANCE_ID: "measured-wait",
    CONFIG: { ...I.CONFIG, providerConcurrencyLimit: 1, providerLeasePollMs: 250, globalWorkerLimit: 0 },
    RUNTIME_CONCURRENCY: { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, providerLimits: new Map() },
    effectiveBridgeStateDirectory: () => directory,
    assertNoLinkedPath: async (...args) => {
      openingAt = performance.now();
      await I.assertNoLinkedPath(...args);
    },
    ensureTableColumn: (handle, ...args) => {
      I.ensureTableColumn(handle, ...args);
      if (!profile.enabled || handles.has(handle)) return;
      handles.add(handle);
      profile.opens++;
      const exec = handle.exec.bind(handle);
      let lookAt = openingAt;
      handle.exec = sql => {
        if (sql === "BEGIN IMMEDIATE" && !lookAt) lookAt = performance.now();
        if (sql === "BEGIN IMMEDIATE" && fault && fault !== "reclaim") throw new Error(fault);
        const result = exec(sql);
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          if (lookAt) profile.looks.push(performance.now() - lookAt);
          lookAt = 0;
        }
        return result;
      };
    },
    closeDb: handle => {
      if (handles.has(handle)) profile.closes++;
      I.closeDb(handle);
      assert.throws(() => handle.prepare("SELECT 1"), /not open|closed/);
    },
    reclaimProvenGoneProviderQuarantines: async () => {
      if (fault === "reclaim" && profile.opens) throw new Error("fixture reclaim fault");
      return 0;
    },
    logEvent: () => {},
  });
  return { runtime, profile, setFault: value => { fault = value; } };
}
test("15-second held-slot wait opens once, closes once and preserves holder progress", async () => {
  const { runtime, profile } = await measuredLeaseRuntime();
  const held = await runtime.acquireProviderLease({ providerKey: key, timeoutMs: 1000 });
  assert.equal(held.ok, true);
  profile.enabled = true;
  const notifications = [];
  const started = performance.now();
  const result = await I.wrapToolHandler("measured-wait", () => runtime.acquireProviderLease({ providerKey: key, timeoutMs: 15000 }))({}, {
    _meta: { progressToken: "measured-token" }, sendNotification: async value => { notifications.push(value); },
  });
  const sorted = [...profile.looks].sort((a, b) => a - b);
  measurements.held15s = { opens: profile.opens, closes: profile.closes, polls: sorted.length,
    medianLookMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), elapsedMs: Math.round(performance.now() - started) };
  process.stdout.write(`15-second wait: ${JSON.stringify(measurements.held15s)}\n`);
  assert.equal(result.errorType, "provider_slot_wait_timeout");
  assert.equal(result.holders, 1); assert.equal(result.capacity, 1);
  assert.equal(result.agentNeverStarted, true); assert.equal(result.agentTimeoutSpentMs, 0);
  assert.match(result.error, /1 of 1 slots stayed held.*The agent was not started/);
  assert.equal(result.waitInfo.holderDetails[0].leaseId, held.lease.id);
  const messages = notifications.map(value => value.params.message);
  assert.ok(messages.length >= 3, JSON.stringify(messages));
  for (const message of messages) assert.match(message, /measured-wait.*pid=.*heartbeats may extend/);
  assert.equal(profile.closes, profile.opens);
  assert.equal(profile.opens, 1, "one wait owns one database handle");
});
test("wait handle closes on grant, pause, cancellation, query failure and thrown progress", async () => {
  for (const outcome of ["grant", "pause", "cancel", "query", "progress", "busy", "reclaim"]) {
    const { runtime, profile, setFault } = await measuredLeaseRuntime();
    if (outcome !== "grant") {
      const held = await runtime.acquireProviderLease({ providerKey: key, timeoutMs: 5000 });
      assert.equal(held.ok, true);
    }
    if (outcome === "pause") await runtime.recordProviderCooldown({ providerKey: key, durationMs: 60000, errorType: "opencode_quota_exhausted", reason: "fixture" });
    if (outcome === "query") setFault("fixture query fault");
    if (outcome === "busy") setFault("database is locked");
    if (outcome === "reclaim") setFault("reclaim");
    const controller = new AbortController();
    const timer = outcome === "cancel" ? setTimeout(() => controller.abort(), 100) : null;
    profile.enabled = true;
    try {
      // Grant verifies handle ownership, not sub-second database initialization.
      const promise = runtime.providerSlotWaitStorage.run({ jobId: "profile-" + outcome, onWait: () => {
        if (outcome === "progress") throw new Error("fixture progress fault");
      } }, () => runtime.acquireProviderLease({ providerKey: key, timeoutMs: ["grant", "reclaim"].includes(outcome) ? 5000 : 400, signal: controller.signal }));
      if (outcome === "progress" || outcome === "reclaim") await assert.rejects(promise, new RegExp("fixture " + outcome + " fault"));
      else {
        const result = await promise;
        assert.equal(result.ok, outcome === "grant", outcome);
        if (outcome === "pause") { assert.equal(result.errorType, "opencode_quota_exhausted"); assert.equal(result.pausedKey, key); }
        if (outcome === "cancel") assert.equal(result.errorType, "agent_cancelled");
        if (outcome === "query") assert.equal(result.errorType, "provider_concurrency_failed");
        if (outcome === "busy") assert.equal(result.errorType, "provider_slot_wait_timeout");
      }
      assert.equal(profile.opens, 1, outcome);
      assert.equal(profile.closes, 1, outcome);
      assert.equal(runtime.providerSlotWaitingJobs.size, 0, outcome);
    } finally { clearTimeout(timer); }
  }
});

test("L-1-F1b-7/12: terminal supervisor failures quarantine once and preserve evidence", async () => {
  for (const type of ["process_supervisor_exited_without_result", "process_supervisor_watchdog_expired", "process_supervisor_protocol_error"]) {
    let captures = 0;
    const evidence = JSON.stringify({ pids: [123], complete: false });
    const h = harness({}, {
      runSpawnCommand: async () => ({ stdout: "", stderr: "", exitCode: 1, processTreeUnconfirmed: true,
        treeTerminationConfirmed: false, terminationErrorType: type }),
      containmentRecord: async () => { captures++; return evidence; },
      quarantineProviderLease: async (_lease, record) => { assert.equal(record, evidence); return { ok: true }; },
      classifyResultError: value => value.terminationErrorType,
    });
    const result = await h.runtime.runOpenCode("builder", "task", scratch, false, 60000);
    assert.equal(result.errorType, type);
    assert.equal(result.containmentEvidence, evidence);
    assert.equal(result.providerQuarantine.ok, true);
    assert.equal(captures, 1);
    assert.equal(h.calls.includes("lease.release"), false);
  }
});
test("L-1-F1b-11: late admission before or during commit leaves no lease", async () => {
  for (const stage of ["decision", "commit"]) {
    const directory = await mkdtemp(path.join(scratch, `late-${stage}-`));
    const wrapped = new WeakSet();
    const holdPastDeadline = () => { const end = performance.now() + 100; while (performance.now() < end) {} };
    const config = { ...I.CONFIG, globalWorkerLimit: 0 };
    let capacityReads = 0;
    if (stage === "decision") Object.defineProperty(config, "providerConcurrencyLimit", { get: () => {
      if (++capacityReads > 1) holdPastDeadline();
      return 2;
    } });
    const runtime = createProviderLeaseRuntime({ ...I, CONFIG: config, BRIDGE_INSTANCE_ID: `late-${stage}`,
      RUNTIME_CONCURRENCY: { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, providerLimits: new Map() },
      effectiveBridgeStateDirectory: () => directory,
      reclaimProvenGoneProviderQuarantines: async () => 0,
      ensureTableColumn: (handle, ...args) => {
        I.ensureTableColumn(handle, ...args);
        if (stage !== "commit" || wrapped.has(handle)) return;
        wrapped.add(handle);
        const exec = handle.exec.bind(handle);
        handle.exec = sql => { const result = exec(sql); if (sql === "COMMIT") holdPastDeadline(); return result; };
      },
    });
    const result = await runtime.acquireProviderLease({ providerKey: key, timeoutMs: 1000, maxWaitMs: 80 });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.errorType, "provider_slot_wait_limit_exceeded");
    console.log(`Late ${stage} grant: ${result.waitedMs} ms against maxWaitMs=80; refused and released`);
    const handle = await runtime.openProviderLeaseDb();
    try { assert.equal(handle.prepare("SELECT COUNT(*) AS n FROM provider_leases").get().n, 0); }
    finally { I.closeDb(handle); }
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stdout.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  for (const child of workerProcesses) if (child.exitCode === null) child.kill();
  await Promise.all(workerProcesses.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
  __selfTest.hooks.stateDirectoryOverride = "";
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
process.stdout.write(`${tests.length - failed} of ${tests.length} provider wait tests passed; zero skips.\n`);
process.stdout.write(`Provider wait measurements: ${JSON.stringify(measurements)}\n`);
process.exit(failed ? 1 : 0);
