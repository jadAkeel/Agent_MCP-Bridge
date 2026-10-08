// B-197: real scratch leases/cooldowns, role permission checks and durable queue results.
// Metadata reads and payload execution are fixtures; no model request or live state access.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenCodeEventRuntime } from "../lib/opencode-events.js";
import { createOpenCodeCommandRuntime } from "../lib/opencode-command.js";
import { createOpenCodeRunRuntime } from "../lib/opencode-run.js";
import { pausedProviderFallbackEligible, roleModelFallbackRequirement, runBuilderModelFallback } from "../bin/builder-model-fallback.js";
import { makeFlexFixture, runFlexTests } from "./flex-fixture.js";
import { finishSkips } from "./skip-gate.js";
process.argv.push("--self-test");
const isolatedStateDir = await mkdtemp(path.join(tmpdir(), "provider-fallback-global-"));
Object.assign(process.env, {
  CODEX_OPENCODE_STATE_DIR: isolatedStateDir, CODEX_OPENCODE_LOG_LEVEL: "off",
  CODEX_OPENCODE_OPS_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
  CODEX_OPENCODE_GLOBAL_WORKER_LIMIT: "0", CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: "2",
  CODEX_OPENCODE_PROVIDER_LEASE_POLL_MS: "25", CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS: "10000",
  CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_WORKTREE_CLEANUP: "never",
});
delete process.env.CODEX_OPENCODE_BUILDER_MODEL_FALLBACK;
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals, hooks = __selfTest.hooks;
const fixture = await makeFlexFixture(__selfTest, "provider-fallback");
const MUSE = { provider: "opencode", model: "muse-spark-1.3-contributor-free", variant: "high" };
const FLASH = roleModelFallbackRequirement("builder");
const allowlist = [`${MUSE.provider}/${MUSE.model}@high`, `${FLASH.provider}/${FLASH.model}@high`];
hooks.selfTestModelOverrideAllowlist = allowlist;
const tests = [], measurements = {};
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function db(fn) { const handle = await I.openProviderLeaseDb(); try { return fn(handle); } finally { I.closeDb(handle); } }
async function reset() {
  hooks.selfTestModelOverrideAllowlist = allowlist;
  delete process.env.CODEX_OPENCODE_BUILDER_MODEL_FALLBACK;
  await db(handle => handle.exec("DELETE FROM provider_leases; DELETE FROM provider_capacities; DELETE FROM provider_cooldowns; DELETE FROM provider_pause_strikes; DELETE FROM runtime_settings;"));
}
const metadataFor = (agent, model = MUSE) => ({ name: agent, mode: "primary", ...model,
  canEdit: ["builder", "debugger"].includes(agent), canDelegate: false,
  externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true,
  protectedEditsDenied: true, permissionProfileSha256: "fixture-permissions",
});
const successStream = model => [
  { type: "step_start", sessionID: "root" },
  { type: "message.updated", properties: { info: { role: "assistant", sessionID: "root", providerID: model.provider, modelID: model.model } } },
  { type: "text", sessionID: "root", part: { type: "text", text: "REPORT: produced by fallback", time: { end: 1 } } },
].map(value => JSON.stringify(value)).join("\n");
function harness(agent = "builder", options = {}) {
  const metadata = metadataFor(agent, options.model || MUSE), calls = [], spawns = [];
  const real = ["acquireProviderLease", "allowlistedModelOverride", "applyModelOverrideToMetadata", "applyRateLimitOutcome",
    "classifyResultError", "commandShape", "effectiveReadOnlyMetadataError",
    "inspectOpenCodeEventStream", "modelPauseKeyForMetadata", "openCodeRunArgs", "parseDependencyRequest",
    "providerKeyForMetadata", "providerSlotWaitStorage", "providerSlotWaitingJobs", "rateLimitPauseReason", "recordProviderCooldown",
    "recordRateLimitPause", "releaseProviderLease", "startProviderLeaseHeartbeat"];
  const deps = Object.fromEntries(real.map(key => { assert.ok(I[key], key); return [key, I[key]]; }));
  Object.assign(deps, {
    acquireProviderLease: async request => {
      const result = await I.acquireProviderLease(request);
      options.afterLease?.(result);
      return result;
    },
    CONFIG: { ...I.CONFIG, providerWaitMaxMs: 2500, attestationFinalMaxAgeMs: 0,
      attestationRevalidateAfterMs: options.revalidateAfterMs ?? 60000, clientDisconnectSignal: options.clientSignal || null },
    ...createOpenCodeEventRuntime({ CONFIG: I.CONFIG }),
    isTimeoutResult: createOpenCodeCommandRuntime({ CONFIG: I.CONFIG }).isTimeoutResult,
    combineAbortSignals: signals => { const present = signals.filter(Boolean); return present.length ? AbortSignal.any(present) : null; },
    MCP_CONTRACTOR_ORCHESTRATOR_AGENT: I.MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
    OPENCODE_EXE: "fixture-opencode", defaultWriteAgentTimeoutMs: 60000,
    nowMs: () => Date.now(), timeoutForAgent: (role, plan, timeout) => timeout || 60000,
    agentIdleTimeoutForModel: () => 0, openCodeCommandLineLengthError: () => "",
    clearAgentActivity: () => {}, noteAgentActivity: () => {}, logEvent: () => {},
    buildOpenCodeEnv: () => ({}), summarizeStderr: value => String(value || ""),
    isManagedReadOnlyAgent: role => ["tester", "reviewer"].includes(role), maxReadOnlyAgentRetries: 2,
    mergeHeavyToolCalls: (a, b) => [...(a || []), ...(b || [])], delayWithSignal: sleep,
    quotaGroupProviderKeys: provider => options.groups?.[provider] || options.groupKeys || [],
    verifyExternalPluginPolicy: async () => { calls.push("plugin"); return { ok: true }; },
    readAgentDebugMetadata: async () => ({ ok: true, metadata }),
    readAgentDebugMetadataUncached: async () => {
      calls.push("agent");
      const value = options.drift && calls.filter(item => item === "agent").length >= options.drift.after
        ? { ...metadata, [options.drift.field]: options.drift.value } : metadata;
      return { ok: true, metadata: value };
    },
    quarantineProviderLease: async () => ({ ok: true }),
    runSpawnCommand: async (command, args, cwd, timeoutMs) => {
      const model = args.find(value => value.startsWith("--model="))?.slice("--model=".length);
      assert.ok(model, "the payload has an exact CLI model pin");
      const started = Date.now(); spawns.push({ model, timeoutMs }); calls.push("spawn:" + model);
      const held = await db(handle => handle.prepare("SELECT provider_key FROM provider_leases").all());
      assert.ok(held.some(row => row.provider_key === I.providerKeyForMetadata(model.startsWith("google/") ? FLASH : metadata)), "the producing provider owns a real lease");
      if (options.spawn) return options.spawn({ model, cwd, timeoutMs, started });
      return { stdout: successStream(model.startsWith("google/") ? FLASH : MUSE), stderr: "", exitCode: 0,
        treeTerminationConfirmed: true, childStartedAtMs: started, childFinishedAtMs: Date.now() + 1 };
    },
  });
  const runtime = createOpenCodeRunRuntime(deps);
  const plan = { lockType: metadata.canEdit ? "write" : "read", scopeContract: {}, ...(options.plan || {}) };
  const run = (extra = {}, cwd = fixture.repo) => runtime.runOpenCodeWithPolicy(agent, "fixture task", cwd, false, plan, 60000, {
    agentMetadata: { ok: true, metadata, pluginPolicy: { ok: true } }, ...extra,
  });
  return { metadata, calls, spawns, runtime, run };
}
async function pause(model = MUSE) {
  return I.recordRateLimitPause({ pauseKey: I.modelPauseKeyForMetadata(model), reason: "fixture pause" });
}
async function holdFallback() {
  const leases = [];
  for (let n = 0; n < 2; n++) {
    const held = await I.acquireProviderLease({ providerKey: I.providerKeyForMetadata(FLASH), timeoutMs: 1000 });
    assert.equal(held.ok, true, held.error); leases.push(held.lease);
  }
  return leases;
}
const zeroHit = started => ({ stdout: "", stderr: "", exitCode: 1, rateLimited: true, rateLimitHits: 2,
  treeTerminationConfirmed: true, childStartedAtMs: started, childFinishedAtMs: Date.now() + 1 });

test("only the configured Muse role policy offers an allowlisted Flash fallback", () => {
  for (const role of ["builder", "debugger", "tester"]) assert.deepEqual(roleModelFallbackRequirement(role), FLASH);
  assert.equal(roleModelFallbackRequirement("reviewer"), null);
  assert.equal(I.allowlistedModelOverride(FLASH, "builder", []), null);
});
test("incomplete/prior text and reasoning remain output even after a provider error", () => {
  for (const type of ["text", "reasoning"]) {
    const stream = [{ type, sessionID: "root", part: { type, text: "partial", time: {} } }, { type: "error", error: { message: "Rate limit exceeded" } }].map(JSON.stringify).join("\n");
    const inspected = I.inspectOpenCodeEventStream(stream);
    assert.equal(inspected.finalResponseDetected, false); assert.equal(inspected.assistantOutputStarted, true);
  }
  for (const message of [{ content: "partial" }, { content: [{ type: "text", text: "partial" }] }, { tokens: { output: 1 } }, { tokens: { reasoning: 1 } }]) {
    const stream = JSON.stringify({ type: "assistant_message", message: { role: "assistant", ...message } });
    assert.equal(I.inspectOpenCodeEventStream(stream).assistantOutputStarted, true);
  }
});
test("started reroutes require zero output and every containment/stream/permission guard", () => {
  const result = { configuredProvider: MUSE.provider, configuredModel: MUSE.model,
    errorType: "provider_rate_limited", streamIntegrity: "valid", treeTerminationConfirmed: true };
  assert.equal(pausedProviderFallbackEligible("debugger", result, { enabled: true }), true);
  for (const patch of [{ stdout: "partial" }, { assistantOutputStarted: true }, { usage: { outputCount: 1 } }, { usage: { reasoningCount: 1 } },
    { changedFiles: ["src/a.txt"] }, { toolOutcomes: [{ tool: "edit" }] }, { cancelled: true }, { timedOut: true },
    { streamIntegrity: "malformed" }, { treeTerminationConfirmed: false }, { rawOutputTruncated: true },
    { assistantResponseTruncated: true }, { assistantFinalResponseDetected: true }, { openCodeFallbackDetected: true },
    { runtimeModelConflict: true }, { modelEvidenceAmbiguous: true }, { permissionDeniedCount: 1 }, { invalidEventLineCount: 1 },
    { terminationErrorType: "process_tree_termination_unconfirmed" }, { configuredModel: "different" }]) {
    assert.equal(pausedProviderFallbackEligible("builder", { ...result, ...patch }, { enabled: true }), false, JSON.stringify(patch));
  }
  for (const policy of [{ enabled: false }, { enabled: true, modelRequirement: MUSE }, { enabled: true, forcePure: true }]) {
    assert.equal(pausedProviderFallbackEligible("builder", result, policy), false);
  }
});
test("a pre-spawn refusal must prove a current pause and no spent payload time", () => {
  const result = { configuredProvider: MUSE.provider, configuredModel: MUSE.model, errorType: "provider_paused",
    exitCode: "provider_capacity_unavailable", agentNeverStarted: true, agentTimeoutSpentMs: 0,
    providerCooldownUntil: new Date(Date.now() + 10000).toISOString() };
  assert.equal(pausedProviderFallbackEligible("tester", result, { enabled: true }), true);
  for (const patch of [{ providerCooldownUntil: "" }, { providerCooldownUntil: new Date(0).toISOString() },
    { agentTimeoutSpentMs: 1 }, { errorType: "agent_cancelled" }, { exitCode: 1 }]) {
    assert.equal(pausedProviderFallbackEligible("tester", { ...result, ...patch }, { enabled: true }), false);
  }
});
test("A paused/B free reroutes all three roles by default with real leases and both attestations", async () => {
  const samples = [];
  for (const role of ["builder", "debugger", "tester"]) {
    await reset(); const initial = await pause(); const h = harness(role), started = Date.now();
    const result = await h.run(); samples.push({ role, elapsedMs: Date.now() - started });
    assert.equal(result.errorType, null, JSON.stringify(result)); assert.equal(result.configuredModel, FLASH.model);
    assert.equal(result.actualModel, FLASH.model); assert.equal(result.modelFallbackReason, "provider_rate_limited");
    assert.equal(result.modelFallbackStarted, true); assert.equal(h.spawns.length, 1);
    assert.ok(h.calls.filter(item => item === "agent").length >= 2);
    assert.equal(h.spawns[0].timeoutMs > 59000, true, "A's pre-spawn pause spent none of the payload timeout");
    const rows = await db(handle => handle.prepare("SELECT strikes, until_at FROM provider_pause_strikes JOIN provider_cooldowns ON pause_key=provider_key").all());
    assert.equal(rows.length, 1); assert.equal(rows[0].strikes, initial.strikes); assert.equal(rows[0].until_at, initial.untilAt);
  }
  measurements.freeFallback = samples;
});
test("B held slots emit B holder information and caller bound without an agent or unused lease", async () => {
  await reset(); await pause(); const holders = await holdFallback(); const h = harness(), waits = [], started = Date.now();
  try {
    const result = await I.providerSlotWaitStorage.run({ jobId: "E-bounded-wait", onWait: info => waits.push(info) }, () => h.run({ maxWaitMs: 250 }));
    assert.equal(result.errorType, "provider_slot_wait_limit_exceeded"); assert.equal(result.configuredModel, FLASH.model);
    assert.equal(result.modelFallbackStarted, false); assert.equal(h.spawns.length, 0);
    assert.ok(waits.length && waits[0].providerKey === I.providerKeyForMetadata(FLASH)); assert.equal(waits[0].holderDetails.length, 2);
    assert.equal(await db(handle => handle.prepare("SELECT COUNT(*) AS count FROM provider_leases").get().count), 2);
    measurements.bound = { elapsedMs: Date.now() - started, waitMs: result.providerConcurrencyWaitMs };
  } finally { for (const lease of holders) await I.releaseProviderLease(lease); }
});
test("a freed B slot repeats its attestation after a long wait and starts only B", async () => {
  await reset(); await pause(); const holders = await holdFallback(); const h = harness("builder", { revalidateAfterMs: 0 });
  const timer = setTimeout(() => void I.releaseProviderLease(holders[0]), 160);
  try {
    const result = await h.run({ maxWaitMs: 1500 }); assert.equal(result.errorType, null);
    assert.ok(result.providerConcurrencyWaitMs >= 100); assert.equal(h.spawns.length, 1);
    assert.ok(h.calls.filter(item => item === "agent").length >= 3, h.calls.join(","));
    measurements.freedSlot = { waitMs: result.providerConcurrencyWaitMs };
  } finally { clearTimeout(timer); for (const lease of holders) await I.releaseProviderLease(lease); }
});
test("permission drift during B's wait refuses payload and releases B's newly acquired lease", async () => {
  await reset(); await pause(); const holders = await holdFallback();
  const h = harness("builder", { revalidateAfterMs: 0, drift: { after: 3, field: "permissionProfileSha256", value: "changed" } });
  const timer = setTimeout(() => void I.releaseProviderLease(holders[0]), 160);
  try {
    const result = await h.run({ maxWaitMs: 1500 }); assert.equal(result.errorType, "agent_metadata_changed");
    assert.equal(h.spawns.length, 0); assert.equal(result.modelFallbackStarted, false);
    assert.equal(await db(handle => handle.prepare("SELECT COUNT(*) AS count FROM provider_leases").get().count), 1);
  } finally { clearTimeout(timer); for (const lease of holders) await I.releaseProviderLease(lease); }
});
test("both models paused returns A's original pause without strikes or payload", async () => {
  await reset(); const a = await pause(); await pause(FLASH); const h = harness();
  const before = await db(handle => handle.prepare("SELECT * FROM provider_pause_strikes ORDER BY pause_key").all());
  const result = await h.run(); assert.equal(result.configuredModel, MUSE.model);
  assert.equal(result.providerCooldownUntil, new Date(a.untilAt).toISOString()); assert.equal(result.modelFallbackUsed, false);
  assert.equal(h.spawns.length, 0); assert.deepEqual(await db(handle => handle.prepare("SELECT * FROM provider_pause_strikes ORDER BY pause_key").all()), before);
});
test("B pausing during its slot wait preserves A's pause and accounts for B's actual wait", async () => {
  await reset(); const a = await pause(); const holders = await holdFallback(); const h = harness();
  const timer = setTimeout(() => void I.recordProviderCooldown({ providerKey: I.providerKeyForMetadata(FLASH), durationMs: 10000, errorType: "provider_paused" }), 160);
  try {
    const result = await I.providerSlotWaitStorage.run({ jobId: "E-late-pause" }, () => h.run({ maxWaitMs: 1500 }));
    assert.equal(result.providerCooldownUntil, new Date(a.untilAt).toISOString());
    assert.equal(result.configuredModel, MUSE.model); assert.equal(result.modelFallbackUsed, false);
    assert.equal(result.modelFallbackStarted, false); assert.equal(h.spawns.length, 0);
    assert.ok(result.providerConcurrencyWaitMs >= 100); assert.equal(result.providerWaitInfo.providerKey, I.providerKeyForMetadata(FLASH));
    assert.equal(result.providerWaitInfo.waiting, false);
  } finally { clearTimeout(timer); for (const lease of holders) await I.releaseProviderLease(lease); }
});
test("pinned jobs, reviewer, no allowlist and explicit opt-out preserve the pause", async () => {
  for (const options of [{ plan: { scopeContract: { modelRequirement: MUSE } } }, { role: "reviewer" }, { allowlist: [] }, { disabled: true }]) {
    await reset(); await pause(); if (options.allowlist) hooks.selfTestModelOverrideAllowlist = options.allowlist;
    if (options.disabled) process.env.CODEX_OPENCODE_BUILDER_MODEL_FALLBACK = "false";
    const h = harness(options.role || "builder", options); const result = await h.run();
    assert.equal(result.configuredModel, MUSE.model); assert.equal(h.spawns.length, 0); assert.equal(Boolean(result.modelFallbackUsed), false);
  }
  await reset(); await pause(FLASH); const h = harness("reviewer", { model: FLASH });
  assert.equal((await h.run()).configuredModel, FLASH.model); assert.equal(h.spawns.length, 0);
});
test("sanitized/pure and contractor policy cannot reroute", async () => {
  const primary = { configuredProvider: MUSE.provider, configuredModel: MUSE.model, errorType: "provider_rate_limited", streamIntegrity: "valid", treeTerminationConfirmed: true };
  let calls = 0;
  await runBuilderModelFallback("builder", async () => { calls++; return primary; }, { pauseRerouteEnabled: true, forcePure: true, timeoutMs: 1000, fallbackRequirement: FLASH });
  assert.equal(calls, 1);
  await reset(); await pause(); const h = harness("debugger", { plan: { orchestratorMode: "contractor" } });
  assert.equal((await h.run()).configuredModel, MUSE.model); assert.equal(h.spawns.length, 0);
});
test("zero-output hit records exactly the plain-pause counters and quota-group holds before reroute", async () => {
  const groupKey = "fixture-shared-quota";
  const runHit = async pinned => {
    await reset();
    const h = harness("builder", { groups: { opencode: [groupKey] }, plan: pinned ? { scopeContract: { modelRequirement: MUSE } } : {},
      spawn: ({ model, started }) => model.startsWith("opencode/") ? zeroHit(started) : {
        stdout: successStream(FLASH), stderr: "", exitCode: 0, treeTerminationConfirmed: true, childStartedAtMs: started, childFinishedAtMs: Date.now() + 1 } });
    const result = await h.run();
    const counters = await db(handle => handle.prepare("SELECT strikes, until_at-set_at AS duration FROM provider_pause_strikes JOIN provider_cooldowns ON pause_key=provider_key").all());
    assert.ok(await db(handle => handle.prepare("SELECT 1 FROM provider_cooldowns WHERE provider_key=?").get(groupKey)));
    return { result, counters, h };
  };
  const plain = await runHit(true), rerouted = await runHit(false);
  assert.deepEqual(rerouted.counters, plain.counters); assert.equal(rerouted.counters[0].strikes, 1);
  assert.equal(rerouted.result.modelFallbackOriginalPause.rateLimitPause.strikes, 1);
  assert.equal(rerouted.result.configuredModel, FLASH.model); assert.equal(rerouted.h.spawns.length, 2);
});
test("partial text, reasoning, tool output and truncation never restart a hit", async () => {
  for (const patch of [
    { stdout: JSON.stringify({ type: "text", sessionID: "root", part: { type: "text", text: "partial", time: {} } }) },
    { stdout: JSON.stringify({ type: "reasoning", sessionID: "root", part: { type: "reasoning", text: "thinking" } }) },
    { stdout: JSON.stringify({ type: "tool_use", sessionID: "root", part: { tool: "edit", state: { status: "running" } } }) },
    { stdoutTruncated: true }, { cancelled: true }, { treeTerminationConfirmed: false },
  ]) {
    await reset(); const h = harness("builder", { spawn: ({ started }) => ({ ...zeroHit(started), ...patch }) });
    const result = await h.run(); assert.equal(h.spawns.length, 1); assert.equal(Boolean(result.modelFallbackUsed), false, JSON.stringify(patch));
  }
});
test("a shared quota pause of B prevents escape through another provider name", async () => {
  await reset(); await I.recordProviderCooldown({ providerKey: "shared-account", durationMs: 10000, errorType: "provider_rate_limited" });
  const h = harness("builder", { groupKeys: ["shared-account"] }); const result = await h.run();
  assert.equal(result.configuredModel, MUSE.model); assert.equal(result.modelFallbackUsed, false); assert.equal(h.spawns.length, 0);
});
test("client cancellation between pause and fallback never starts another payload", async () => {
  await reset(); await pause(); const controller = new AbortController();
  const h = harness("builder", { clientSignal: controller.signal,
    afterLease: result => { if (result.cooldownUntil) controller.abort(); },
  });
  const result = await h.run(); assert.equal(controller.signal.aborted, true);
  assert.equal(result.errorType, "provider_rate_limited"); assert.equal(h.spawns.length, 0);
  assert.equal(h.calls.filter(item => item === "agent").length, 1, "cancellation prevents even B's attestation");
});
test("a real queued writer records B and attributes its retained patch and files to B", async () => {
  await reset(); await pause();
  const h = harness("builder", { spawn: async ({ model, cwd, started }) => {
    assert.ok(model.startsWith("google/")); await writeFile(path.join(cwd, "src", "a.txt"), "fallback-produced bytes\n");
    return { stdout: successStream(FLASH), stderr: "", exitCode: 0, treeTerminationConfirmed: true, childStartedAtMs: started, childFinishedAtMs: Date.now() + 1 };
  } });
  hooks.agentRuntimeTestHook = {
    resolveAgent: async agent => ({ requestedAgent: agent, actualAgent: agent, availableAgents: [agent], requestedAgentMode: "primary", actualAgentMode: "primary", discoveryExitCode: 0 }),
    readAgentDebugMetadata: async () => ({ ok: true, metadata: h.metadata, pluginPolicy: { ok: true } }),
    runOpenCodeWithPolicy: h.runtime.runOpenCodeWithPolicy,
  };
  const queued = await I.enqueueQueueJob(fixture.writeJob("src/a.txt", { task: "fallback writer evidence" }));
  assert.equal(queued.ok, true, JSON.stringify(queued)); I.scheduleQueue();
  assert.equal(await fixture.waitFor(async () => fixture.terminal((await fixture.durable(queued.record.jobId))?.status), 30000), true);
  const record = await fixture.durable(queued.record.jobId);
  assert.equal(record.status, "completed", JSON.stringify(record)); assert.equal(record.configuredModel, FLASH.model);
  assert.equal(record.actualModel, FLASH.model); assert.equal(record.modelFallbackUsed, true); assert.equal(record.modelFallbackStarted, true);
  assert.equal(record.modelFallbackReason, "provider_rate_limited"); assert.deepEqual(record.changedFiles, ["src/a.txt"]);
  assert.equal(await readFile(path.join(record.worktreePath, "src", "a.txt"), "utf8"), "fallback-produced bytes\n");
  assert.equal(await readFile(path.join(fixture.repo, "src", "a.txt"), "utf8"), "a\n");
  const patch = await I.collectIntegrationPatch({ cwd: fixture.repo, worktreePath: record.worktreePath });
  assert.equal(patch.ok, true); assert.match(patch.patch, /fallback-produced bytes/);
  assert.equal(record.worktreePatchSha256, patch.patchSha256);
  assert.equal(record.modelFallbackOriginalPause.providerConcurrencyKey, I.providerKeyForMetadata(MUSE));
  hooks.agentRuntimeTestHook = null;
});

await runFlexTests({ isolatedStateDir, file: "tests/review-provider-fallback.js", tests,
  cleanup: async () => { console.log(JSON.stringify({ measurements })); hooks.selfTestModelOverrideAllowlist = null; await fixture.cleanup(); },
  finishSkips, label: "paused-provider fallback" });
