// Private child for the real-server cache/executor regressions. Provider payload
// and policy byte validation are seams; Git, worktrees, keys and fingerprints are real.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { harness } from "./review-latency.js";
import { normalizePathForCompare } from "../lib/paths.js";

const scenario = process.argv[2], root = path.resolve(process.argv[3]);
if (!["keys", "boundaries", "slot-wait"].includes(scenario)) throw new Error("Unknown scope scenario.");
const folders = { HOME: "home", USERPROFILE: "home", CODEX_HOME: "codex-home", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
  XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "xdg-state", CODEX_OPENCODE_STATE_DIR: "state" };
for (const [key, relative] of Object.entries(folders)) { process.env[key] = path.join(root, relative); await mkdir(process.env[key], { recursive: true }); }
Object.assign(process.env, { CODEX_OPENCODE_EXECUTABLE: process.execPath, CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
  CODEX_OPENCODE_SYNC_MANAGED_RUNTIME: "false", CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off",
  CODEX_OPENCODE_ATTESTATION_FINAL_MAX_AGE_MS: "0" });
const config = path.join(process.env.XDG_CONFIG_HOME, "opencode");
for (const folder of ["agents", "skills", "plugin"]) await mkdir(path.join(config, folder), { recursive: true });
process.env.CODEX_OPENCODE_AGENT_DIR = path.join(config, "agents");
process.env.CODEX_OPENCODE_SKILL_DIR = path.join(config, "skills");
const probe = path.join(config, "opencode.json"), plugin = path.join(config, "plugin", "pinned.js");
await writeFile(probe, "{}\n"); await writeFile(plugin, "safe");
const fixedTime = Date.UTC(2026, 0, 1) / 1000;
await utimes(plugin, fixedTime, fixedTime);
let fingerprintReads = 0;
const originalStream = fs.createReadStream;
fs.createReadStream = function (file, ...args) {
  if (path.resolve(String(file)).toLowerCase() === probe.toLowerCase()) fingerprintReads++;
  return originalStream.call(this, file, ...args);
};
syncBuiltinESMExports();
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest: { internals: I, hooks } } = await import("../server.js");
hooks.attestationCacheTtlOverride = 3_600_000;
assert.equal(I.CONFIG.attestationFinalMaxAgeMs, 0);
const repo = path.join(root, "repo"); await mkdir(path.join(repo, "src"), { recursive: true });
const git = async (args, cwd = repo) => {
  const result = await I.runCommand("git", args, cwd, 30_000);
  assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim();
};
await git(["init", "-q"]); await git(["config", "core.autocrlf", "false"]);
await writeFile(path.join(repo, "src", "a.txt"), "original\n");
await git(["add", "."]); await git(["-c", "user.name=Scope Fixture", "-c", "user.email=scope@example.invalid", "commit", "-q", "-m", "seed"]);
const positive = value => value?.ok === true;
const cwdKey = cwd => normalizePathForCompare(path.resolve(cwd));
const rewrite = async value => {
  const before = await stat(plugin); await writeFile(plugin, value); await utimes(plugin, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = await stat(plugin); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
};

if (scenario === "keys") {
  const tree = await git(["rev-parse", "HEAD^{tree}"]), worktree = path.join(root, "actual-worktree");
  await git(["worktree", "add", "--detach", "-q", worktree, "HEAD"]);
  const identity = await I.withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: tree });
  const listKey = `agent-list\0${cwdKey(repo)}`, metadataKey = I.agentMetadataCacheKey("builder", worktree, identity);
  assert.match(metadataKey, /worktree\0.*\0cfg:[a-f0-9]{64}$/);
  const policyKey = `plugin-policy\0${cwdKey(worktree)}`, operation = async () => ({ ok: true });
  for (const key of [listKey, metadataKey, policyKey]) await I.cachedAttestation(key, operation, positive);
  fingerprintReads = 0;
  await I.withAttestationFingerprintScope(async () => {
    assert.equal((await I.cachedAttestation(listKey, operation, positive)).attestationCacheHit, true);
    assert.equal((await I.cachedAttestation(metadataKey, operation, positive)).attestationCacheHit, true);
    assert.equal(fingerprintReads, 1, "real repository and worktree-metadata keys collapse to one repository fingerprint");
    assert.equal((await I.cachedAttestation(policyKey, operation, positive)).attestationCacheHit, true);
    assert.equal(fingerprintReads, 2, "the actual worktree policy cwd keeps its own fingerprint");
  });
  console.log(JSON.stringify({ scenario, fingerprintReads, actualWorktree: true }));
} else {
  const boundaryKey = `scope-boundary\0${cwdKey(repo)}`;
  const boundaryRead = () => I.cachedAttestation(boundaryKey, async () => ({ ok: true, bytes: await readFile(plugin, "utf8") }), positive);
  const boundaries = [], metadataKeys = [], grantedLease = { id: "scope-fixture-lease", expiresAt: Date.now() + 600_000 };
  let policyReads = 0, metadataReads = 0, metadata, measured = false, policyReadsAtWait = 0;
  const discoveryHits = [];
  const policy = cwd => I.cachedAttestation(`plugin-policy\0${cwdKey(cwd)}`, async () => {
    policyReads++;
    return scenario === "boundaries" || await readFile(plugin, "utf8") === "safe" ? { ok: true, mode: "allowlisted", plugins: [] }
      : { ok: false, errorType: "external_plugin_integrity_failed", error: "Pinned fixture plugin bytes changed." };
  }, positive);
  const h = harness({ finalMaxAgeMs: I.CONFIG.attestationFinalMaxAgeMs }, {
    verifyExternalPluginPolicy: policy,
    readAgentDebugMetadataUncached: async () => { metadataReads++; return { ok: true, metadata }; },
    acquireProviderLease: async () => {
      h.calls.push("lease.acquire");
      if (scenario === "slot-wait" && measured) { policyReadsAtWait = policyReads; await rewrite("evil"); }
      return { ok: true, lease: grantedLease, waitedMs: scenario === "slot-wait" && measured ? 300_000 : 0 };
    },
  });
  metadata = { ...h.metadata, mode: "primary", canEdit: true, canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: "scope-fixture" };
  const resolution = { ok: true, requestedAgent: "builder", actualAgent: "builder", requestedAgentMode: "primary", actualAgentMode: "primary",
    fallbackUsed: false, proxyUsed: false, subagentStrategy: "reject", availableAgents: ["builder"], discoveryExitCode: 0 };
  const readMetadata = async (agent, cwd, options = {}) => {
    const identity = options.worktreeIdentity ? await I.withWorktreeConfigTreeHash(options.worktreeIdentity) : null;
    const key = I.agentMetadataCacheKey(agent, cwd, identity); metadataKeys.push(key);
    if (scenario === "slot-wait") await policy(cwd);
    const value = await I.cachedAttestation(key, async () => ({ ok: true, metadata, pluginPolicy: { ok: true, mode: "allowlisted", plugins: [] } }), positive);
    if (measured && cwdKey(cwd) === cwdKey(repo)) discoveryHits.push(value.attestationCacheHit);
    return value;
  };
  await I.cachedAttestation(`agent-list\0${cwdKey(repo)}`, async () => resolution, positive);
  await readMetadata("builder", repo); await boundaryRead();
  hooks.agentRuntimeTestHook = {
    resolveAgent: async () => {
      const value = await I.cachedAttestation(`agent-list\0${cwdKey(repo)}`, async () => resolution, positive);
      if (measured) discoveryHits.push(value.attestationCacheHit);
      return value;
    },
    readAgentDebugMetadata: readMetadata,
    runOpenCodeWithPolicy: (...args) => h.runtime.runOpenCodeWithPolicy(...args),
  };
  const options = scenario === "boundaries" ? {
    onLockAcquired: async () => { await rewrite("lock"); const proof = await boundaryRead(); boundaries.push({ phase: "lock", ...proof }); },
    onWorktreePrepared: async () => { await rewrite("tree"); const proof = await boundaryRead(); boundaries.push({ phase: "worktree", ...proof }); },
  } : {};
  try {
    const job = { agent: "builder", task: "Leave src/a.txt unchanged.", cwd: repo, write: true,
      lockMode: "simple", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], validationCommand: "git diff --check",
      scopeContract: { mode: "write", read: ["src/a.txt"], write: ["src/a.txt"], allowedEdits: ["src/a.txt"], validationCommand: "git diff --check" }, timeoutMs: 600_000 };
    // A real warmup establishes all execution-owned input directories before
    // proving warm discovery. A cold read closes its scope independently and
    // would conceal removal of the explicit discovery-close call.
    const warmup = await I.executeOpenCodeJob(job);
    assert.equal(warmup.result.errorType || "", "", warmup.response?.content?.[0]?.text);
    await I.cachedAttestation(`agent-list\0${cwdKey(repo)}`, async () => resolution, positive);
    await readMetadata("builder", repo); await boundaryRead();
    h.calls.length = 0; metadataReads = 0; measured = true;
    const execution = await I.executeOpenCodeJob(job, options);
    assert.deepEqual(discoveryHits, [true, true], "the regression must exercise genuinely warm discovery reads");
    assert.ok(metadataKeys.some(key => key.includes("\0worktree\0")), "execution must use a real worktree metadata key");
    if (scenario === "slot-wait") {
      assert.equal(execution.result.errorType, "external_plugin_integrity_failed", execution.response?.content?.[0]?.text);
      assert.equal(h.calls.includes("spawn"), false, "no payload after plugin drift in a long slot wait");
      assert.equal(h.calls.includes("lease.release"), true, "the granted slot is returned");
      assert.equal(policyReads, policyReadsAtWait + 1, "changed-byte final rejection requires a fresh policy read after the wait");
      assert.equal(metadataReads, 1, "rejection precedes the second metadata read");
    } else {
      assert.equal(execution.result.errorType || "", "", execution.response?.content?.[0]?.text);
      assert.deepEqual(boundaries.map(proof => [proof.phase, proof.bytes, proof.attestationCacheHit]), [["lock", "lock", false], ["worktree", "tree", false]],
        "deleting the discovery finish call makes a boundary reuse its old warm fingerprint");
    }
    console.log(JSON.stringify({ scenario, policyReads, metadataReads, boundaries: boundaries.length, errorType: execution.result.errorType || "" }));
  } finally { hooks.agentRuntimeTestHook = null; }
}
