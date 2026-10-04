// log.md B-161: the uncached pre-spawn attestation (plugin policy + `opencode debug agent`) runs
// before the provider slot is requested, so the slot is not held and the run budget is not spent
// while OpenCode cold-starts; a slot granted only after a long wait repeats the attestation with
// the slot held. The run runtime is driven with stubbed dependencies and the call order is checked.
import { strict as assert } from "node:assert";
import { createOpenCodeRunRuntime } from "../lib/opencode-run.js";

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

// Like executeOpenCodeJob, the caller passes the cached discovery read, whose plugin policy the
// run reuses for its early checks; only the attestation reads below the slot logic spawn OpenCode.
const run = (h, options = {}) => h.runtime.runOpenCode("builder", "write the batch", process.cwd(), false, 60_000, {
  agentMetadata: { ok: true, metadata: h.metadata, pluginPolicy: { ok: true, mode: "allowlisted", plugins: [] }, attestationKey: "agent-metadata\0builder\0test", attestedAtMs: Date.now() },
  ...options,
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("B-161: the attestation runs before the slot request and once; a short wait does not repeat it", async () => {
  const h = harness({ waitedMs: 5_000 });
  const result = await run(h);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(h.calls, ["attest.plugins", "attest.agent", "lease.acquire:opencode", "heartbeat.start", "spawn", "heartbeat.stop", "lease.release"]);
  assert.equal(typeof result.runPhaseTimings.preLeaseAttestationMs, "number");
  assert.equal(result.runPhaseTimings.finalAttestationMs, 0, "nothing was attested with the slot held");
  assert.equal(result.runPhaseTimings.providerWaitMs, 5_000);
});

test("B-161: a slot granted after a wait longer than the threshold is attested again, with the slot held", async () => {
  const h = harness({ waitedMs: 90_000 });
  const result = await run(h);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(h.calls, [
    "attest.plugins", "attest.agent", "lease.acquire:opencode", "heartbeat.start",
    "attest.plugins", "attest.agent", "spawn", "heartbeat.stop", "lease.release",
  ]);
  assert.equal(typeof result.runPhaseTimings.finalAttestationMs, "number");
});

test("B-161: threshold 0 repeats the attestation after any wait", async () => {
  const h = harness({ waitedMs: 1, revalidateAfterMs: 0 });
  await run(h);
  assert.equal(h.calls.filter((call) => call === "attest.agent").length, 2);
});

test("B-161: a plugin-policy failure is refused before any slot is requested", async () => {
  const h = harness({ pluginOk: false });
  const result = await run(h);
  assert.equal(result.exitCode, "plugin_policy_rejected");
  assert.equal(result.errorType, "plugin_policy_rejected");
  assert.deepEqual(h.calls, ["attest.plugins"], "no lease, no heartbeat, no spawn");
});

test("B-161: an agent-metadata failure is refused before any slot is requested", async () => {
  const h = harness({ agentOk: false });
  const result = await run(h);
  assert.equal(result.exitCode, "agent_policy_rejected");
  assert.equal(result.errorType, "agent_metadata_invalid");
  assert.equal(h.calls.includes("lease.acquire:opencode"), false);
});

test("B-161: a re-attestation failure after a long wait gives the slot back and spawns nothing", async () => {
  let pluginReads = 0;
  const h = harness({ waitedMs: 90_000 }, {
    verifyExternalPluginPolicy: async () => {
      pluginReads += 1;
      return pluginReads === 1
        ? { ok: true, mode: "allowlisted", plugins: [] }
        : { ok: false, errorType: "plugin_policy_rejected", error: "plugin drift after the wait" };
    },
  });
  const result = await run(h);
  assert.equal(result.exitCode, "plugin_policy_rejected");
  assert.equal(pluginReads, 2);
  assert.deepEqual(h.calls.slice(-2), ["heartbeat.stop", "lease.release"], "the slot is given back");
  assert.equal(h.calls.includes("spawn"), false);
});

test("B-161: a provider key that changes during the long wait is refused as provider_lease_key_mismatch", async () => {
  let reads = 0;
  const h = harness({ waitedMs: 90_000 }, {
    readAgentDebugMetadataUncached: async () => {
      reads += 1;
      const provider = reads === 1 ? "opencode" : "google";
      return { ok: true, metadata: { name: "builder", mode: "write", provider, model: "m", variant: "" } };
    },
  });
  const result = await run(h);
  assert.equal(result.errorType, "provider_lease_key_mismatch");
  assert.equal(result.providerConcurrencyKey, "opencode");
  assert.deepEqual(h.calls.slice(-2), ["heartbeat.stop", "lease.release"]);
});

test("B-171: a recent attestation is reused before the slot; no OpenCode read runs", async () => {
  const h = harness({ finalMaxAgeMs: 600_000 });
  const result = await run(h);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(h.calls, ["attest.reuse", "lease.acquire:opencode", "heartbeat.start", "spawn", "heartbeat.stop", "lease.release"]);
  assert.equal(result.runPhaseTimings.finalAttestationCached, true);
});

test("B-171: an entry older than the age limit is read again through the cache path", async () => {
  const h = harness({ finalMaxAgeMs: 600_000, reattestHit: false });
  const result = await run(h);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(h.calls[0], "attest.reuse");
  assert.equal(h.calls.includes("attest.plugins"), false, "the cache path verifies the plugin policy inside its fresh read");
  assert.equal(result.runPhaseTimings.finalAttestationCached, false);
});

test("B-171: the setting at 0 keeps the uncached read; a run without an attestation key reads uncached too", async () => {
  const h = harness({ finalMaxAgeMs: 600_000 });
  await h.runtime.runOpenCode("builder", "write the batch", process.cwd(), false, 60_000, {
    agentMetadata: { ok: true, metadata: h.metadata, pluginPolicy: { ok: true, mode: "allowlisted", plugins: [] } },
  });
  assert.deepEqual(h.calls.slice(0, 2), ["attest.plugins", "attest.agent"], "no key: the old path");
  const h0 = harness({ finalMaxAgeMs: 0 });
  await run(h0);
  assert.deepEqual(h0.calls.slice(0, 2), ["attest.plugins", "attest.agent"]);
});

test("B-171: a pure (isolated) runtime never reuses an attestation", async () => {
  const h = harness({ finalMaxAgeMs: 600_000 });
  await run(h, { forcePure: true });
  assert.deepEqual(h.calls.slice(0, 2), ["isolated.create", "attest.agent"]);
  assert.equal(h.calls.includes("attest.reuse"), false);
});

test("B-161: with a pure runtime the isolated root is created before the slot and wiped when no slot comes", async () => {
  const h = harness({ leaseOk: false });
  const result = await run(h, { forcePure: true });
  assert.equal(result.exitCode, "provider_capacity_unavailable");
  assert.equal(result.errorType, "provider_slot_wait_timeout");
  assert.equal(result.providerConcurrencyKey, "opencode");
  assert.equal(result.providerSlotHolders, 6);
  assert.deepEqual(h.calls, ["isolated.create", "attest.agent", "lease.acquire:opencode", "isolated.wipe"], "pure mode skips the plugin read");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}
console.log(`${failed} of ${tests.length} latency tests failed.`);
process.exit(failed ? 1 : 0);
