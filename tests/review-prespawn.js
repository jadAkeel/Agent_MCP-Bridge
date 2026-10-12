// Pre-agent regressions for ledger L-1-F1a-2, 4..11. All fixtures live in OS temp.
// --large measures real 130k, 210k and 300k directories without stream listing;
// --native-wide checks 130k with the host's stream listing (fixture creation is untimed).
import "./test-env.js";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createStateDatabase } from "../lib/state/database.js";
import { createStateSchema } from "../lib/state/schema.js";
import { createAttestationCacheRuntime } from "../lib/attestation-cache.js";
import { createExecuteJobRuntime } from "../lib/execute-job.js";
import { createLockRuntime } from "../lib/locks.js";
import { realPathBoundaryReason, unsafePathReason, isWithinAnyPath } from "../lib/paths.js";
import { captureWritableScopeFilesystemState, writableScopeRoots } from "../lib/writable-scope.js";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
const starts = [];
const originalExecFile = cp.execFile;
cp.execFile = function (command, args, ...rest) {
  if (command === "git") starts.push(args);
  return originalExecFile.call(this, command, args, ...rest);
};
cp.execFile[Symbol.for("nodejs.util.promisify.custom")] = (command, args, options) => new Promise((resolve, reject) => {
  cp.execFile(command, args, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else resolve({ stdout, stderr });
  });
});
syncBuiltinESMExports();
const { __selfTest: { internals: I, hooks } } = await import("../server.js");
const scratch = await mkdtemp(path.join(tmpdir(), "pre-"));
const repo = path.join(scratch, "repo");
await mkdir(path.join(repo, "src"), { recursive: true });
const git = async (args) => {
  const result = await I.runCommand("git", args, repo, 60_000);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};
await git(["init", "-q"]);
await writeFile(path.join(repo, "src", "a.txt"), "a\n");
await git(["add", "."]);
await git(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"]);
const paths = ["src/a.txt"];
const job = (writer = true) => ({ agent: writer ? "builder" : "explore", task: "Inspect the scoped file", cwd: repo,
  write: writer, lockedPaths: writer ? paths : undefined, allowedEdits: writer ? paths : undefined,
  scopeContract: { mode: writer ? "write" : "read", read: paths, write: writer ? paths : [], allowedEdits: writer ? paths : [] } });
const metadata = (agent) => ({ ok: true, metadata: { name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
  canEdit: agent === "builder", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
  bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `fixture-${agent}` } });
const resolveAgent = async (agent) => ({ requestedAgent: agent, actualAgent: agent, requestedAgentMode: "primary", actualAgentMode: "primary",
  availableAgents: [agent], discoveryExitCode: 0 });
const textOf = (result) => result.content.map((item) => item.text || "").join("\n");
const call = (request) => I.server._registeredTools.run_opencode_agent.handler(request, {});
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("L-1-F1a-4: direct reader/writer share root resolution and omit git --version", async () => {
  for (const writer of [false, true]) {
    let beforeAgent;
    hooks.agentRuntimeTestHook = { resolveAgent, readAgentDebugMetadata: async (agent) => metadata(agent),
      runOpenCodeWithPolicy: async () => {
        beforeAgent = [...starts];
        return { exitCode: 0, stdout: "REPORT: done", stderr: "", errorType: null, durationMs: 1,
          assistantFinalResponseDetected: true, childExecutionIntervals: [], childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1 };
      } };
    starts.length = 0;
    const began = performance.now();
    const response = await call(job(writer));
    assert.match(textOf(response), /Status: completed/);
    assert.equal(beforeAgent.filter((args) => args.includes("--show-toplevel")).length, 1);
    assert.equal(starts.filter((args) => args.includes("--version")).length, 0);
    console.log(JSON.stringify({ job: writer ? "writer" : "read", preAgentGitStarts: beforeAgent.length,
      preAgentRoots: 1, totalGitStarts: starts.length, totalRoots: starts.filter((args) => args.includes("--show-toplevel")).length,
      ms: Math.round(performance.now() - began) }));
  }
  hooks.agentRuntimeTestHook = null;
});

test("L-1-F1a-7: literal bracket junction and ordinary junction both refuse outside targets", async () => {
  const outside = path.join(scratch, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "page.tsx"), "outside\n");
  await mkdir(path.join(repo, "app"));
  for (const name of ["[slug]", "slugj"]) {
    const link = path.join(repo, "app", name);
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      for (const value of [`app/${name}`, `app/${name}/page.tsx`, path.join(link, "page.tsx")]) {
        assert.match(realPathBoundaryReason(value, repo), /outside the allowed root/);
        assert.match(unsafePathReason([value], repo), /outside the allowed root/);
        const acquired = await I.acquireHardLock({ cwd: repo, paths: [value] });
        assert.equal(acquired.errorType, "lock_path_unsafe");
        assert.notEqual(I.directExecutionLockConflictDetails(acquired).errorType, "manual_lock_misuse");
      }
    } finally { await rm(link, { force: true }); }
  }
  await mkdir(path.join(repo, "app", "[slug]"));
  await writeFile(path.join(repo, "app", "[slug]", "page.tsx"), "literal\n");
  const literal = "app/[slug]/page.tsx";
  assert.equal(realPathBoundaryReason(literal, repo), "");
  assert.deepEqual(writableScopeRoots(repo, { allowedEdits: [literal] }), [path.join(repo, literal)]);
  assert.deepEqual(writableScopeRoots(repo, { allowedEdits: [path.join(repo, literal)] }), [path.join(repo, literal)]);
  assert.equal(isWithinAnyPath("app/s/page.tsx", [literal], repo), false);
  assert.equal(isWithinAnyPath(literal, [literal], repo), true);
  assert.deepEqual(writableScopeRoots(repo, { allowedEdits: ["app/[ab]/new.tsx"] }), [path.join(repo, "app")]);
  await rm(path.join(repo, "app"), { recursive: true, force: true });
});

test("L-1-F1a-8: a durable unresolved integration refuses a direct writer truthfully", async () => {
  const db = await I.openLockDb(repo);
  const fields = db.prepare("PRAGMA table_info(integration_operations)").all();
  const at = new Date().toISOString();
  const values = { operation_id: "prespawn-pending", cwd: repo, status: "quarantined", affected_paths_json: "[]", result_json: "{}",
    created_at: at, updated_at: at, finished_at: null };
  db.prepare(`INSERT INTO integration_operations (${fields.map((field) => field.name).join(",")}) VALUES (${fields.map(() => "?").join(",")})`)
    .run(...fields.map((field) => Object.hasOwn(values, field.name) ? values[field.name] : field.type === "INTEGER" ? 0 : "fixture"));
  I.closeDb(db);
  let ran = false;
  hooks.agentRuntimeTestHook = { resolveAgent, readAgentDebugMetadata: async (agent) => metadata(agent),
    runOpenCodeWithPolicy: async () => { ran = true; throw new Error("must not run"); } };
  try {
    const acquired = await I.acquireHardLock({ cwd: repo, paths });
    assert.equal(acquired.errorType, "integration_recovery_pending");
    const response = textOf(await call(job()));
    assert.match(response, /errorType: integration_recovery_pending/);
    assert.doesNotMatch(response, /manual_lock_misuse/);
    assert.equal(ran, false);
  } finally {
    hooks.agentRuntimeTestHook = null;
    const cleanup = await I.openLockDb(repo);
    cleanup.prepare("DELETE FROM integration_operations WHERE operation_id = ?").run(values.operation_id);
    I.closeDb(cleanup);
  }
});

test("L-1-F1a-8: database/path failures keep their types; only a real manual conflict is misuse", async () => {
  const make = (overrides) => createLockRuntime({ ...I, CONFIG: I.CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS: new Set(),
    PARALLEL_LOCK_TYPES: new Set(["read", "write", "serial_integration"]), DEFAULT_LOCK_TTL_MS: 60_000,
    INTEGRATION_RESOLVED_SQL: "'committed','rolled_back','recovered_noop'", logEvent: () => {}, ...overrides });
  const pathFailure = await make({ resolveProjectStateRoot: async () => { throw new Error("EACCES"); } }).acquireHardLock({ cwd: repo, paths });
  assert.equal(pathFailure.errorType, "lock_path_resolution_failed");
  const openFailure = await make({ reclaimLockQuarantinesForRoot: async () => {}, openLockDb: async () => { throw new Error("SQLITE_BUSY"); } })
    .acquireHardLock({ cwd: repo, paths });
  assert.equal(openFailure.errorType, "lock_database_failed");
  const transactionFailure = await make({ reclaimLockQuarantinesForRoot: async () => {}, closeDb: () => {},
    openLockDb: async () => ({ exec: () => { throw new Error("SQLITE_BUSY"); } }) }).acquireHardLock({ cwd: repo, paths });
  assert.equal(transactionFailure.errorType, "lock_database_failed");
  for (const result of [pathFailure, openFailure, transactionFailure]) {
    assert.equal(I.directExecutionLockConflictDetails(result, { queueConflict: true }).errorType, result.errorType);
  }
  assert.equal(I.directExecutionLockConflictDetails({ conflict: { origin: "manual" } }).errorType, "manual_lock_misuse");
  assert.equal(I.directExecutionLockConflictDetails({ conflict: { origin: "legacy" } }).errorType, "write_lock_conflict");
  assert.equal(I.directExecutionLockConflictDetails({ conflict: { origin: "internal" } }, { queueConflict: true }).errorType, "queue_lock_conflict");
});

test("L-1-F1a-6: database initialization is once per identity, shares concurrent opens, retries failure", async () => {
  let migrations = 0, prunes = 0, scrubs = 0, failNext = false;
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === "SELECT rowid, token, task FROM locks") scrubs++;
    return originalPrepare.call(this, sql);
  };
  const runtime = createStateDatabase({ ...I, ...createStateSchema(), CONFIG: I.CONFIG,
    GLOBAL_BRIDGE_STATE_DIR: path.join(scratch, "db-state"), getStateDirectoryOverride: () => "", assertNoLinkedPath: async () => {},
    BRIDGE_INSTANCE_ID: "prespawn", KNOWN_STATE_DB_PATHS: new Set(), ensureQueueHeartbeatTimer: () => {}, ensureStateMaintenanceTimer: () => {},
    migrateLegacyEncryptedState: async () => { migrations++; await new Promise((resolve) => setTimeout(resolve, 10)); if (failNext) { failNext = false; throw new Error("fixture migration failed"); } },
    prunePersistedState: () => { prunes++; } });
  try {
    await runtime.withProjectRootCache(async () => {
      const dbs = await Promise.all(Array.from({ length: 8 }, () => runtime.openLockDb(repo)));
      dbs.forEach(runtime.closeDb);
      assert.deepEqual([migrations, scrubs, prunes], [1, 1, 1]);
      const times = [];
      for (let n = 0; n < 11; n++) {
        const began = performance.now();
        runtime.closeDb(await runtime.openLockDb(repo));
        times.push(performance.now() - began);
      }
      console.log(JSON.stringify({ databaseOpens: 19, migrations, scrubs, prunes, warmOpenMedianMs: times.sort((a, b) => a - b)[5] }));
    });
    const file = runtime.stateDbPath(repo);
    await rm(file);
    failNext = true;
    await assert.rejects(runtime.openLockDb(repo), /fixture migration failed/);
    runtime.closeDb(await runtime.openLockDb(repo));
    assert.deepEqual([migrations, scrubs, prunes], [3, 2, 2]);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; }
});

test("L-1-F1a-6: memory cache evicts least recently used entries and expires old entries", async () => {
  let now = Date.now(), reads = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const runtime = createAttestationCacheRuntime({ fingerprint: async () => "stable", ttlMs: () => 1000,
    stateDirectory: () => path.join(scratch, "attest"), buildIdentity: "prespawn", assertNoLinkedPath: async () => {}, maxMemoryEntries: 2 });
  const read = (key) => runtime.cachedAttestation(key, async () => ({ ok: true, read: ++reads }), (value) => value.ok);
  try {
    await read("a"); await read("b");
    assert.equal((await read("a")).attestationCacheSource, "this_process");
    await read("c");
    assert.equal((await read("a")).attestationCacheSource, "this_process");
    assert.equal((await read("b")).attestationCacheSource, "shared");
    now += 1001;
    assert.equal((await read("a")).attestationCacheSource, "fresh");
    assert.equal(reads, 4);
  } finally { Date.now = originalNow; }
});

function executor(overrides = {}) {
  const lockPlan = { agent: "contractor", lockType: "write", lockMode: "temporary", orchestratorMode: "contractor",
    lockedPaths: paths, allowedEdits: paths, forbiddenEdits: [], sharedFiles: [], scopeContract: null, validationCommand: "" };
  return createExecuteJobRuntime({ ...I, CONFIG: { ...I.CONFIG, worktreeMode: "off" },
    nowMs: () => Date.now(), logEvent: () => {}, makeQueueJobId: () => "prespawn-fixture", hardLockPathsForPlan: () => paths,
    combineAbortSignals: () => null, DEFAULT_SUBAGENT_PROXY_AGENT: "planner", updateRetainedWorktreeMeasurement: async () => {},
    providerCapacitySnapshot: null, validateSingleLockPlan: () => ({ lockPlan }), validateSingleLockPlanAsync: async () => ({ lockPlan }), verifyJobWorkspaceReadiness: async () => ({ ok: true }),
    readOnlyRoutingPolicyError: () => null, sanitizedRoutingPolicyError: () => null, effectiveReadOnlyMetadataError: () => null,
    agentMetadataPolicyOptions: () => ({}), validationCommandPreflightError: async () => null,
    jobAgentRuntime: () => ({ resolveAgent, readAgentDebugMetadata: async () => metadata("builder") }),
    attestContractorNestedAgents: async () => ({ ok: true }),
    ...overrides });
}

test("L-1-F1a-5: nested discovery stops after a parent policy failure", async () => {
  let nested = 0;
  const runtime = executor({ effectiveReadOnlyMetadataError: () => ({ errorType: "fixture_parent_policy", error: "parent refused" }),
    attestContractorNestedAgents: async () => { nested++; return { ok: true }; } });
  const result = await runtime.executeOpenCodeJob({ ...job(), agent: "contractor" });
  assert.equal(result.result.errorType, "fixture_parent_policy");
  assert.equal(nested, 0);
});

test("L-1-F1a-5/9: contractor mode off records worktree isolation and forwards its identity", async () => {
  let request, nestedOptions = [], reads = 0;
  const worktree = { ok: true, path: path.join(scratch, "contractor"), repoRoot: repo, baseTree: "a".repeat(40) };
  const runtime = executor({ acquireHardLock: async (options) => { request = options; return { ok: true, lock: { id: "fixture", paths } }; },
    startHardLockHeartbeat: () => Object.assign(async () => {}, { signal: null }), releaseHardLock: async () => ({ ok: true }),
    createWorktreeForJob: async () => worktree,
    jobAgentRuntime: () => ({ resolveAgent, readAgentDebugMetadata: async () => { reads++; return metadata("builder"); } }),
    effectiveReadOnlyMetadataError: () => reads === 2 ? { errorType: "fixture_final_policy", error: "stop before snapshots" } : null,
    attestContractorNestedAgents: async (cwd, options) => { nestedOptions.push(options); return { ok: true }; } });
  const result = await runtime.executeOpenCodeJob({ ...job(), agent: "contractor" });
  assert.equal(request.editsCheckout, false);
  assert.equal(result.result.errorType, "fixture_final_policy");
  assert.equal(nestedOptions.length, 1, "final nested discovery stops after final parent failure");

  // Test the actual server helper body with only its metadata reader replaced.
  const source = await fs.promises.readFile(new URL("../server.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function attestContractorNestedAgents("), source.indexOf("\nconst { exactPluginSpecifier"));
  const received = [];
  let coldReads = 0;
  const helper = new Function("CONTRACTOR_ALLOWED_SUBAGENTS", "attestationCacheTtlMs", "withWorktreeConfigTreeHash", "readAgentDebugMetadata", "contractorNestedAgentMetadataError",
    `${body}\nreturn attestContractorNestedAgents;`)(I.CONTRACTOR_ALLOWED_SUBAGENTS, () => 1000,
    async (identity) => ({ ...identity, configTreeHash: identity.configTreeHash || "b".repeat(64) }),
    async (agent, cwd, options) => {
      const key = I.agentMetadataCacheKey(agent, cwd, options.worktreeIdentity);
      received.push(key);
      return I.cachedAttestation(key, async () => { coldReads++; return metadata(agent); }, (value) => value.ok);
    }, () => null);
  hooks.attestationCacheTtlOverride = 60_000;
  I.clearAttestationCache();
  try {
    await helper("worktree-one", { worktreeIdentity: worktree });
    assert.equal(coldReads, 7);
    await helper("worktree-two", { worktreeIdentity: worktree });
    assert.equal(coldReads, 7, "the next unchanged contractor worktree needs zero cold nested reads");
    assert.deepEqual(received.slice(0, 7), received.slice(7), "each nested role shares only the unchanged parent configuration identity");
    assert.equal(new Set(received).size, 7, "roles never share authority");
    await helper("worktree-three", { worktreeIdentity: { ...worktree, configTreeHash: "c".repeat(64) } });
    assert.equal(coldReads, 14, "changed parent configuration refuses reuse for every nested role");
    console.log(JSON.stringify({ firstContractorColdNestedReads: 7, unchangedContractorColdNestedReads: 0, changedConfigColdNestedReads: 7 }));
  } finally { hooks.attestationCacheTtlOverride = null; I.clearAttestationCache(); }
});

test("L-1-F1a-10: scope refusal reports returned and thrown cleanup failures", async () => {
  const worktreePath = path.join(scratch, "scope-cleanup");
  await mkdir(worktreePath);
  await mkdir(path.join(worktreePath, "src"));
  // Force the real capture's root read to fail, without 200k files in the routine suite.
  const originalRealpath = fs.promises.realpath;
  for (const throws of [false, true]) {
    let ran = false, cleanupCalls = 0;
    fs.promises.realpath = async (file, ...args) => {
      if (file === worktreePath) throw new Error("fixture scope refusal");
      return originalRealpath(file, ...args);
    };
    syncBuiltinESMExports();
    const worktree = { ok: true, repoRoot: repo, path: worktreePath, baseTree: "a".repeat(40) };
    const runtime = executor({ acquireHardLock: async () => ({ ok: true, lock: { id: "fixture", paths } }),
      startHardLockHeartbeat: () => Object.assign(async () => {}, { signal: null }), releaseHardLock: async () => ({ ok: true }),
      createWorktreeForJob: async () => worktree, gitChangedFileSnapshot: async () => new Map(), gitControlSurfaceFingerprint: async () => null,
      captureGitHead: async () => "head", updateRetainedWorktreeMeasurement: async () => {},
      jobAgentRuntime: () => ({ resolveAgent, readAgentDebugMetadata: async () => metadata("builder"), runOpenCodeWithPolicy: async () => { ran = true; } }),
      cleanupWorktree: async () => { cleanupCalls++; if (throws) throw new Error("fixture cleanup failure"); return { cleanup: "failed", error: "fixture cleanup failure" }; } });
    try {
      const result = await runtime.executeOpenCodeJob({ ...job(), agent: "contractor" });
      assert.equal(result.result.errorType, "writable_scope_unverifiable");
      assert.equal(result.worktree.path, worktreePath);
      assert.equal(result.worktreeCleanup.cleanup, "failed");
      assert.match(textOf(result.response), /Worktree cleanup failed: fixture cleanup failure/);
      assert.equal(ran, false);
      assert.equal(cleanupCalls, 1);
    } finally { fs.promises.realpath = originalRealpath; syncBuiltinESMExports(); }
  }
});

if (process.argv.includes("--large") || process.argv.includes("--native-wide")) test("L-1-F1a-2: real wide directories stop at the budget before child stats", async () => {
  const root = path.join(scratch, "wide-scope"), wide = path.join(root, "wide");
  await mkdir(wide, { recursive: true });
  let made = 0;
  const originalLstat = fs.promises.lstat, originalOpendir = fs.promises.opendir;
  let stats = 0, enumerated = 0;
  fs.promises.lstat = async (...args) => { stats++; return originalLstat(...args); };
  fs.promises.opendir = async (...args) => {
    const directory = await originalOpendir(...args);
    return { async *[Symbol.asyncIterator]() { for await (const entry of directory) { enumerated++; yield entry; } } };
  };
  syncBuiltinESMExports();
  try {
    const platform = process.argv.includes("--native-wide") ? process.platform : "linux";
    for (const count of process.argv.includes("--native-wide") ? [130_000] : [130_000, 210_000, 300_000]) {
      for (; made < count;) {
        const end = Math.min(count, made + 64);
        await Promise.all(Array.from({ length: end - made }, (_, index) => writeFile(path.join(wide, `f${made + index}`), "")));
        made = end;
      }
      for (const scope of ["wide", "wide/f0"]) {
        stats = 0; enumerated = 0;
        const began = performance.now();
        const result = await captureWritableScopeFilesystemState(root, { allowedEdits: [scope] }, { platform });
        const ms = Math.round(performance.now() - began);
        if (count < 200_000) { assert.equal(result.ok, true, result.error); assert.equal(result.entries, scope === "wide" ? count + 1 : count); }
        else { assert.equal(result.ok, false); assert.match(result.error, /more than 200000 entries/); assert.doesNotMatch(result.error, /call stack/); assert.ok(stats <= 2); assert.ok(enumerated <= 200_001); }
        console.log(JSON.stringify({ directoryEntries: count, scope, platform, ms, stats, enumerated, ok: result.ok }));
      }
    }
  } finally { fs.promises.lstat = originalLstat; fs.promises.opendir = originalOpendir; syncBuiltinESMExports(); }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
} finally {
  hooks.agentRuntimeTestHook = null;
  cp.execFile = originalExecFile;
  syncBuiltinESMExports();
  assert.ok(path.resolve(scratch).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
console.log(`${tests.length - failed}/${tests.length} pre-spawn tests passed; 0 skips`);
if (failed) process.exitCode = 1;
