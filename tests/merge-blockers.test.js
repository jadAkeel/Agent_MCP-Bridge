import "./test-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentPolicyRuntime } from "../lib/agent-policy.js";
import { createProviderLeaseRuntime } from "../lib/provider-leases.js";
import { createExternalRunnersRuntime } from "../lib/external-runners.js";
import { normalizeScopeContract, scopeContractSchema } from "../lib/scope-contract.js";
import { captureWorkerProfileBinding, verifyWorkerProfileBinding, workerBindingAllowsRunner } from "../lib/worker-profile-binding.js";

process.argv.push("--self-test");
process.env.CODEX_OPENCODE_CLI_MAJOR = "2";
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals;

test("quota-group members share capacity while unrelated accounts stay independent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-group-capacity-"));
  const config = { ...I.CONFIG, quotaGroups: [{ name: "account-one", members: ["codex-one", "openai-one"] }, { name: "same-account", members: ["openai-one", "agy-one"] }], providerConcurrencyLimit: 3, globalWorkerLimit: 0, providerLimits: new Map([["agy-one", 1]]), providerConcurrencyKeyExplicit: false };
  const runtime = createProviderLeaseRuntime({ ...I, CONFIG: config, BRIDGE_INSTANCE_ID: "merge-group-test", RUNTIME_CONCURRENCY: { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, providerLimits: new Map() }, effectiveBridgeStateDirectory: () => root, reclaimProvenGoneProviderQuarantines: async () => 0 });
  const peerRuntime = createProviderLeaseRuntime({ ...I, CONFIG: { ...config }, BRIDGE_INSTANCE_ID: "merge-group-peer", RUNTIME_CONCURRENCY: { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, providerLimits: new Map() }, effectiveBridgeStateDirectory: () => root, reclaimProvenGoneProviderQuarantines: async () => 0 });
  const leases = [];
  const key = member => `${config.providerConcurrencyKey}:${member}`;
  try {
    const first = await runtime.acquireProviderLease({ providerKey: key("codex-one"), timeoutMs: 5000 });
    assert.equal(first.ok, true, JSON.stringify(first)); leases.push(first.lease);
    const peer = await peerRuntime.acquireProviderLease({ providerKey: key("openai-one"), timeoutMs: 5000, maxWaitMs: 120 });
    if (peer.ok) { await peerRuntime.releaseProviderLease(peer.lease); }
    assert.equal(peer.ok, false, "another harness using the same account must share its concurrency slot");
    assert.equal(peer.holders, 1);
    assert.equal(peer.capacity, 1, "strictest cap in the connected quota group wins");
    const other = await runtime.acquireProviderLease({ providerKey: key("codex-two"), timeoutMs: 5000 });
    assert.equal(other.ok, true, JSON.stringify(other)); leases.push(other.lease);
    await runtime.releaseProviderLease(first.lease);
    const freed = await runtime.acquireProviderLease({ providerKey: key("openai-one"), timeoutMs: 5000 });
    assert.equal(freed.ok, true, JSON.stringify(freed)); leases.push(freed.lease);
    await runtime.releaseProviderLease(freed.lease);
    const simultaneous = await Promise.all([
      runtime.acquireProviderLease({ providerKey: key("codex-one"), timeoutMs: 5000, maxWaitMs: 250 }),
      peerRuntime.acquireProviderLease({ providerKey: key("agy-one"), timeoutMs: 5000, maxWaitMs: 250 }),
    ]);
    assert.equal(simultaneous.filter(result => result.ok).length, 1, "independent Bridge instances cannot double-grant shared capacity");
    if (simultaneous[0].ok) leases.push(simultaneous[0].lease);
    if (simultaneous[1].ok) await peerRuntime.releaseProviderLease(simultaneous[1].lease);
  } finally {
    for (const lease of leases) await runtime.releaseProviderLease(lease);
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test("V2 isolated execution refuses before creating V1 credential runtime", async () => {
  let created;
  try { await assert.rejects(async () => { created = await I.createIsolatedOpenCodeRuntime(); }, error => error.errorType === "sanitized_v2_unsupported" && /V2/.test(error.message)); }
  finally { if (created) await I.wipeIsolatedOpenCodeRuntime(created.root); }
});

test("V2 sanitized public execution rejects before named profile resolution", async () => {
  const profiles = I.CONFIG.openCodeProfiles.profiles;
  const originalGet = profiles.get;
  let lookedUp = false;
  profiles.get = function (...args) { lookedUp = true; return originalGet.apply(this, args); };
  try {
    for (const execute of [I.prepareOpenCodeJob, I.executeOpenCodeJob]) {
      const result = await execute({ agent: "reviewer", task: "Read only", cwd: process.cwd(), runnerProfile: "named-fixture", write: false, lockMode: "off", sanitizedWorkspace: { root: process.cwd() } });
      assert.equal(result.result.errorType, "sanitized_v2_unsupported");
    }
    assert.equal(lookedUp, false, "unsupported sanitized route must not inspect a named account");
  } finally { profiles.get = originalGet; }
});

test("required tool contracts survive normalization and fail closed on missing attestation", () => {
  const raw = { mode: "read", read: ["src"], requiredTools: ["read", "github_search"] };
  assert.deepEqual(scopeContractSchema.parse(raw).requiredTools, raw.requiredTools);
  const normalized = normalizeScopeContract({ agent: "reviewer", scopeContract: raw });
  assert.deepEqual(normalized.requiredTools, raw.requiredTools);
  const policy = createAgentPolicyRuntime({ SAFE_AGENT_BASH_ALLOW_PATTERNS: new Set(), CONTRACTOR_ALLOWED_SUBAGENTS: new Set(), WRITE_CAPABLE_AGENTS: new Set(), activeModelOverrideAllowlist: () => [] });
  const metadata = { name: "reviewer", mode: "all", provider: "openai", model: "fixture", canDelegate: false, externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true, canEdit: false, requiredToolAvailability: { read: true } };
  const plan = { lockType: "read", scopeContract: normalized };
  assert.equal(policy.effectiveReadOnlyMetadataError({ ok: true, metadata }, plan)?.errorType, "required_tools_unavailable");
  metadata.requiredToolAvailability.github_search = true;
  assert.equal(policy.effectiveReadOnlyMetadataError({ ok: true, metadata }, plan), null);
  metadata.requiredToolAvailability.github_search = false;
  assert.equal(policy.effectiveReadOnlyMetadataError({ ok: true, metadata }, plan)?.errorType, "required_tools_unavailable");
});

test("configured MCP flags do not invent tool availability or override a denied tool", () => {
  const policy = createAgentPolicyRuntime({ USER_HOME_DIR: tmpdir(), SAFE_AGENT_BASH_ALLOW_PATTERNS: new Set(), CONTRACTOR_ALLOWED_SUBAGENTS: new Set() });
  const metadata = policy.normalizeAgentDebugMetadata({ name: "reviewer", mode: "all", model: { providerID: "openai", modelID: "fixture" }, tools: { read: true, grep: false, github_search: true }, permission: [{ permission: "read", pattern: "*", action: "allow" }, { permission: "grep", pattern: "*", action: "allow" }, { permission: "github_search", pattern: "*", action: "allow" }] });
  assert.equal(metadata.requiredToolAvailability.read, true);
  assert.equal(metadata.requiredToolAvailability.grep, false);
  assert.equal(metadata.requiredToolAvailability.github_search, false);
});

test("external CLIs with required tools refuse before executable probing, credentials or spawn", async () => {
  const runtime = createExternalRunnersRuntime({ ...I,
    nowMs: () => Date.now(),
    runCommand: async () => assert.fail("no executable probe expected"),
    runSpawnCommand: async () => assert.fail("no worker expected"),
  });
  for (const runner of ["codex", "agy"]) {
    const result = await runtime.runExternalCli({ runner, model: "fixture" }, { agent: "reviewer", prompt: "task", cwd: process.cwd(), timeoutMs: 1000, lockPlan: { lockType: "read", scopeContract: { requiredTools: ["github_search"] } } });
    assert.equal(result.errorType, "required_tools_unavailable");
    assert.equal(result.agentNeverStarted, true);
  }
});

test("manual requeue accepts admitted fallback runners and rejects an undeclared runner", () => {
  assert.equal(workerBindingAllowsRunner({ version: 1, runner: "codex" }, "agy"), false);
  const routes = { version: 2, routes: [{ runner: "codex" }, { runner: "opencode" }] };
  assert.equal(workerBindingAllowsRunner(routes, "opencode"), true);
  assert.equal(workerBindingAllowsRunner(routes, "agy"), false);
});

test("queue binding detects cache-resolved plugin changes and primary instruction changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-cache-binding-"));
  const configDir = path.join(root, "config");
  const cacheHome = path.join(root, "cache");
  const plugin = path.join(cacheHome, "opencode/packages/example-plugin@1.0.0/index.js");
  const manifest = path.join(root, "manifest.json");
  await mkdir(configDir); await mkdir(path.dirname(plugin), { recursive: true });
  await writeFile(plugin, "original plugin");
  await writeFile(manifest, JSON.stringify({ plugins: [{ specifier: "example-plugin@1.0.0" }] }));
  const options = { runner: "opencode", profileId: "one", userHome: root, cwd: root, env: {}, config: { openCodeProfiles: { base: { configDir, cacheHome, pluginManifestPath: manifest }, profiles: new Map([["one", { dataHome: path.join(root, "account") }]]) } } };
  try {
    const binding = await captureWorkerProfileBinding(options);
    await writeFile(plugin, "changed plugin");
    await assert.rejects(verifyWorkerProfileBinding(binding, options), { errorType: "worker_profile_changed" });
    const primary = path.join(root, ".codex"); await mkdir(primary);
    await writeFile(path.join(primary, "AGENTS.md"), "Original instructions");
    const codex = { runner: "codex", config: {}, userHome: root, env: {}, cwd: root };
    const primaryBinding = await captureWorkerProfileBinding(codex);
    await writeFile(path.join(primary, "AGENTS.md"), "Updated instructions");
    await assert.rejects(verifyWorkerProfileBinding(primaryBinding, codex), { errorType: "worker_profile_changed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
