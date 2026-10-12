// Parallel/single parity. Real temporary Git, SQLite leases, locks and supervised Node
// payloads; OpenCode discovery/debug reads are fixtures and never execute OpenCode.
import "./test-env.js";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerParallelTool } from "../lib/tools/parallel.js";
import { createLockRuntime } from "../lib/locks.js";
import { createResultFormatRuntime, compactFileList } from "../lib/result-format.js";
import { createParallelPlanRuntime } from "../lib/parallel-plan.js";
import { createExecuteJobRuntime } from "../lib/execute-job.js";
import { createParallelCoordinator } from "../lib/parallel-coordinator.js";

const root = await mkdtemp(path.join(tmpdir(), "parallel-parity-"));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
const fakeExe = path.join(root, "synthetic-native.exe");
await writeFile(fakeExe, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1024 * 1024)]));
process.argv.push("--self-test");
process.env.CODEX_OPENCODE_EXECUTABLE = fakeExe;
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_WORKTREE_ROOT = path.join(root, "worktrees");
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "4";
process.env.CODEX_OPENCODE_PARALLEL_LIMIT = "6";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
delete process.env.CODEX_OPENCODE_STATE_DIR;

let trace = [], fingerprints = 0, injectHeadRead = null;
const originalSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  if (/(?:^|[\\/])git(?:\.exe)?$/i.test(options.file)) {
    trace.push({ args: options.args, cwd: options.cwd });
    if (injectHeadRead && options.args.includes("rev-parse") && options.args.at(-1) === "HEAD") injectHeadRead(options);
  }
  return originalSpawn.call(this, options);
};
const originalReadStream = fs.createReadStream;
fs.createReadStream = function (file, ...args) {
  if (path.resolve(String(file)) === fakeExe) fingerprints++;
  return originalReadStream.call(this, file, ...args);
};
syncBuiltinESMExports();
const { __selfTest: { internals: I, hooks } } = await import("../server.js");
hooks.stateDirectoryOverride = path.join(root, "state");
const text = response => response.content.map(item => item.text || "").join("\n");
const call = (name, args, extra = {}) => I.server._registeredTools[name].handler(args, extra);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, budget = 12000) {
  const deadline = Date.now() + budget;
  do { const value = await probe(); if (value) return value; await sleep(25); } while (Date.now() < deadline);
  throw new Error("Timed out waiting for parity fixture.");
}
const git = async (cwd, args) => {
  const result = await I.runCommand("git", args, cwd, 60000);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};
async function repo(name) {
  const cwd = path.join(root, name);
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "tools"));
  for (let n = 0; n < 4; n++) await writeFile(path.join(cwd, "src", `${n}.txt`), "base\n");
  await writeFile(path.join(cwd, "tools", "check.cjs"), [
    "const fs = require('node:fs'), path = require('node:path');",
    "if (process.argv[2] === 'git') { const dot = fs.readFileSync('.git','utf8'); const dir = path.resolve(/^gitdir:\\s*(.+)$/m.exec(dot)[1]); const common = path.resolve(dir,fs.readFileSync(path.join(dir,'commondir'),'utf8').trim()); fs.appendFileSync(path.join(common,'config'),'\\n[parity]\\n flag = true\\n'); }",
    "if (process.argv[2] === 'stream') fs.writeFileSync('src/0.txt:parity-stream','hidden');",
    "if (process.argv[2] === 'ignored') fs.writeFileSync('.env','ignored validation mutation');",
  ].join("\n"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["add", "."]);
  await git(cwd, ["-c", "user.name=Parity", "-c", "user.email=parity@example.invalid", "commit", "-qm", "fixture"]);
  return cwd;
}
const writer = (cwd, file = "src/0.txt", extra = {}) => ({ agent: "builder", task: `Edit ${file}`, cwd,
  write: true, lockMode: "simple", lockedPaths: [file], allowedEdits: [file],
  scopeContract: { mode: "write", read: [file], write: [file], allowedEdits: [file] }, ...extra });
const reader = cwd => ({ agent: "reviewer", task: "Read the checkout", cwd, write: false, lockMode: "off" });
const metadata = agent => ({ ok: true, metadata: { name: agent, mode: "primary", provider: "fixture", model: "model",
  canEdit: agent === "builder", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
  bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: "fixture" } });
const result = (extra = {}) => ({ exitCode: 0, stdout: "REPORT: done", stderr: "", errorType: null, durationMs: 50,
  assistantFinalResponseDetected: true, childExecutionIntervals: [], ...extra });
let coldReads = [], metadataCalls = [];
function runtime({ run = async () => result(), cached = false, delay = 0 } = {}) {
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (agent, cwd) => {
      if (delay) await sleep(delay);
      if (cached) await I.cachedAttestation(`agent-list\0${I.agentMetadataCacheKey(agent, cwd).split("\0").slice(2).join("\0")}`, async () => ({ ok: true }), value => value.ok);
      return { requestedAgent: agent, actualAgent: agent, requestedAgentMode: "primary", actualAgentMode: "primary",
        availableAgents: [agent], discoveryExitCode: 0 };
    },
    readAgentDebugMetadata: async (agent, cwd, options = {}) => {
      metadataCalls.push({ agent, cwd, options });
      if (delay) await sleep(delay);
      if (!cached) return metadata(agent);
      const identity = options.worktreeIdentity ? await I.withWorktreeConfigTreeHash(options.worktreeIdentity) : null;
      const key = I.agentMetadataCacheKey(agent, cwd, identity);
      return I.cachedAttestation(key, async () => { coldReads.push(key); await sleep(10); return metadata(agent); }, value => value.ok);
    },
    runOpenCodeWithPolicy: run,
  };
}
const lockHelpers = createLockRuntime({ ...I, CONFIG: I.CONFIG });
const resultHelpers = createResultFormatRuntime({ CONFIG: I.CONFIG });
const deps = { ...lockHelpers, ...resultHelpers, ...I, compactFileList, nowMs: performance.now.bind(performance),
  makeQueueJobId: agent => `${agent}-${randomUUID()}`, DEFAULT_SUBAGENT_PROXY_AGENT: "planner",
  agentMetadataPolicyOptions: () => ({}), jobAgentRuntime: () => hooks.agentRuntimeTestHook,
  normalizeJobCwd: async job => ({ ...job, cwd: await I.resolveProjectStateRoot(job.cwd) }),
  captureGitHead: async cwd => git(cwd, ["rev-parse", "HEAD"]),
  labelParallelRunId: createParallelPlanRuntime({ CONFIG: I.CONFIG }).labelParallelRunId,
};
let oldHandler;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const measurements = {};
const runIds = answer => [...answer.matchAll(/Run id: (\S+)/g)].map(match => match[1]);

for (const disconnect of [false, true]) test(`L-2-F4-1: MCP ${disconnect ? "disconnect" : "cancel"} ends supervised payloads and releases slots/locks`, async () => {
  const cwd = await repo(disconnect ? "disconnect" : "cancel");
  const payload = path.join(root, "payload.cjs");
  await writeFile(payload, "const fs=require('node:fs'),cp=require('node:child_process'); if(process.argv[2]!=='child'){const child=cp.spawn(process.execPath,[__filename,'child'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,childPid:child.pid}));} setInterval(()=>{},1000);");
  const markers = [], completions = [];
  runtime({ run: async (_agent, _prompt, executionCwd, _dry, _plan, timeout, options) => {
    const marker = path.join(root, `started-${randomUUID()}.json`); markers.push(marker);
    const acquired = await I.acquireProviderLease({ providerKey: "parity", timeoutMs: 10000, signal: options.signal, maxWaitMs: 1000 });
    assert.ok(acquired.ok, acquired.error);
    try {
      const execution = await I.runSpawnCommand(process.execPath, [payload, marker], executionCwd, 15000, { ...process.env },
        { signal: options.signal, onSpawn: options.onSpawn, beforeHeartbeat: options.onSupervisorHeartbeat });
      completions.push(execution);
      return result({ ...execution, assistantFinalResponseDetected: false });
    } finally { await I.releaseProviderLease(acquired.lease); }
  } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parallel-parity", version: "1" });
  await I.server.connect(st); await client.connect(ct);
  const controller = new AbortController();
  let earlyOutcome;
  const pending = client.callTool({ name: "run_opencode_parallel", arguments: { jobs: [writer(cwd), writer(cwd, "src/1.txt")] } },
    undefined, { signal: controller.signal, timeout: 60000 }).catch(error => ({ error })).then(value => { earlyOutcome = value; return value; });
  try {
    const started = await until(async () => {
      if (earlyOutcome) throw new Error("Parallel request ended before agent launch: " + JSON.stringify(earlyOutcome));
      if (markers.length !== 2) return null;
      try { return await Promise.all(markers.map(async marker => JSON.parse(await readFile(marker, "utf8")))); } catch { return null; }
    });
    assert.equal((await I.listLocks(cwd)).length, 2);
    const abandoned = performance.now();
    if (disconnect) await client.close(); else controller.abort();
    const records = await until(async () => {
      const rows = (await I.directRunAuditStore().snapshot(cwd)).records.filter(row => row.kind === "parallel");
      return rows.length === 2 && rows.every(row => row.finishedAt) ? rows : null;
    }, 10000);
    assert.ok(performance.now() - abandoned < 10000);
    for (const row of records) { assert.equal(row.status, "cancelled"); assert.equal(row.errorType, "agent_cancelled_by_client"); }
    assert.equal((await I.listLocks(cwd)).length, 0);
    const db = await I.openProviderLeaseDb();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider_leases").get().n, 0); } finally { I.closeDb(db); }
    assert.equal(completions.length, 2);
    await until(() => started.every(entry => [entry.pid, entry.childPid].every(pid => {
      try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    })), 3000);
    measurements[disconnect ? "disconnectCleanupMs" : "cancellationCleanupMs"] = Math.round(performance.now() - abandoned);
  } finally {
    controller.abort(); await pending; await client.close(); await I.server.close();
  }
});

test("L-2-F4-2: a post-lock worktree setup throw leaves no renewing lock after 35 seconds", async () => {
  const cwd = await repo("setup-throw");
  runtime();
  const original = fs.promises.readdir;
  let acquired = 0;
  fs.promises.readdir = async (directory, ...args) => {
    if (path.resolve(String(directory)) === path.join(root, "worktrees")) {
      acquired = (await I.listLocks(cwd)).length;
      throw Object.assign(new Error("fixture ENOTDIR after lock acquisition"), { code: "ENOTDIR" });
    }
    return original(directory, ...args);
  };
  syncBuiltinESMExports();
  try {
    const started = performance.now();
    const answer = text(await call("run_opencode_parallel", { jobs: [writer(cwd), writer(cwd, "src/1.txt")] }));
    measurements.setupThrowCleanupMs = Math.round(performance.now() - started);
    assert.match(answer, /job_infrastructure_failed/);
    assert.equal(acquired, 2, "fault happens only after both locks are acquired");
    assert.equal((await I.listLocks(cwd)).length, 0);
    await sleep(35000);
    assert.equal((await I.listLocks(cwd)).length, 0);
    measurements.setupThrowLocksAfter35s = 0;
  } finally { fs.promises.readdir = original; syncBuiltinESMExports(); }
});

test("L-2-F4-3/4/14: snapshot/root counts and a 3000-file reader match the single path", async () => {
  const cwd = await repo("reader-cost");
  await mkdir(path.join(cwd, "dirty"));
  for (let n = 0; n < 3000; n += 64) await Promise.all(Array.from({ length: Math.min(64, 3000 - n) }, (_, offset) => writeFile(path.join(cwd, "dirty", `${n + offset}.txt`), Buffer.alloc(1024))));
  runtime();
  const measure = async operation => {
    trace = []; const start = performance.now(); const answer = text(await operation());
    assert.match(answer, /Status: completed/);
    return { ms: Math.round(performance.now() - start), snapshots: trace.filter(item => item.args.includes("--no-renames") && !item.args.includes("--cached")).length,
      roots: trace.filter(item => item.args.includes("--show-toplevel")).length, gitStarts: trace.length };
  };
  measurements.readerSingle = await measure(() => call("run_opencode_agent", reader(cwd)));
  measurements.readerParallel = await measure(() => call("run_opencode_parallel", { jobs: [reader(cwd)] }));
  assert.equal(measurements.readerSingle.snapshots, 2);
  assert.equal(measurements.readerParallel.snapshots, 2);
  assert.equal(measurements.readerParallel.roots, measurements.readerSingle.roots);
  assert.ok(measurements.readerParallel.ms < measurements.readerSingle.ms * 1.6 + 500);
  if (!process.argv.includes("--baseline")) return;
  // Measure the old duplicated handler on the same fixture, with imports kept in this worktree.
  const oldSource = await promisify(cp.execFile)("git", ["show", "f8fd9ed:lib/tools/parallel.js"], { cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 });
  const oldModule = path.join(root, "old-parallel.mjs");
  const source = oldSource.stdout.replace(/from "(\.\.\/[^\"]+)"/g, (_match, spec) => `from "${new URL(spec, new URL("../lib/tools/parallel.js", import.meta.url)).href}"`)
    .replace('from "zod"', `from "${new URL("../node_modules/zod/index.js", import.meta.url).href}"`);
  await writeFile(oldModule, source);
  (await import(pathToFileURL(oldModule))).registerParallelTool({ ...deps, server: { tool: (...args) => { oldHandler = args.at(-1); } } });
  measurements.readerBefore = await measure(() => oldHandler({ jobs: [reader(cwd)] }));
  assert.equal(measurements.readerBefore.snapshots, 5);
});

test("L-2-F4-3: an editor save between the snapshot and HEAD read is never a validation mutation without a gate", async () => {
  const cwd = await repo("reader-drift");
  let afterAgent = false;
  runtime({ run: async () => { afterAgent = true; return result(); } });
  injectHeadRead = options => {
    if (afterAgent && path.resolve(options.cwd) === cwd) {
      fs.writeFileSync(path.join(cwd, "editor-save.txt"), "external save"); injectHeadRead = null;
    }
  };
  const answer = text(await call("run_opencode_parallel", { jobs: [reader(cwd)] }));
  assert.match(answer, /Parallel group status: completed/);
  assert.doesNotMatch(answer, /validation_mutated_workspace/);
  injectHeadRead = null;
});

test("L-2-F4-4/13/14: writers/plan share root and discovery fingerprints, worktree identities and cold reads", async () => {
  const cwd = await repo("writer-cost");
  hooks.attestationCacheTtlOverride = 60000;
  I.clearAttestationCache();
  runtime({ cached: true, run: async () => { await sleep(50); return result(); } });
  // Warm the unchanged inputs, including the worktree configuration key.
  await call("run_opencode_agent", writer(cwd));
  const measure = async operation => {
    trace = []; fingerprints = 0; coldReads = []; metadataCalls = [];
    const start = performance.now(); const answer = text(await operation());
    assert.match(answer, /Status: completed|Delegation plan accepted/);
    return { ms: Math.round(performance.now() - start), fingerprints, coldDebugReads: coldReads.length,
      roots: trace.filter(item => item.args.includes("--show-toplevel")).length, gitStarts: trace.length,
      snapshots: trace.filter(item => item.args.includes("--no-renames") && !item.args.includes("--cached")).length };
  };
  if (oldHandler) measurements.writerBefore = await measure(() => oldHandler({ jobs: [writer(cwd)] }));
  measurements.writerSingle = await measure(() => call("run_opencode_agent", writer(cwd)));
  measurements.writerParallel = await measure(() => call("run_opencode_parallel", { jobs: [writer(cwd)] }));
  assert.equal(measurements.writerParallel.roots, measurements.writerSingle.roots);
  assert.equal(measurements.writerParallel.fingerprints, measurements.writerSingle.fingerprints);
  const jobs = Array.from({ length: 4 }, (_, n) => writer(cwd, `src/${n}.txt`));
  if (oldHandler) measurements.fourWritersBefore = await measure(() => oldHandler({ jobs }));
  measurements.fourWriters = await measure(() => call("run_opencode_parallel", { jobs }));
  assert.equal(measurements.fourWriters.coldDebugReads, 0);
  assert.ok(metadataCalls.filter(item => item.options.worktreeIdentity).length === 4);
  assert.ok(measurements.fourWriters.roots <= 4);
  measurements.planFourWriters = await measure(() => call("validate_delegation_plan", { jobs }));
  assert.ok(measurements.planFourWriters.fingerprints <= 4);
  assert.equal(measurements.planFourWriters.coldDebugReads, 0);
  I.clearAttestationCache();
  coldReads = [];
  await call("run_opencode_parallel", { jobs: jobs.slice(0, 2) });
  const coldWorktreeReads = coldReads.filter(key => key.includes("\0worktree\0")).length;
  assert.equal(coldWorktreeReads, 1, "two cold writers share the unchanged final worktree policy read");
  coldReads = [];
  await call("run_opencode_parallel", { jobs: [jobs[2]] });
  assert.equal(coldReads.length, 0, "the next unchanged writer performs no cold debug-agent read");
  measurements.coldWorktreeReadsForTwoWriters = coldWorktreeReads;
  measurements.unchangedNextWriterColdReads = coldReads.length;
  hooks.attestationCacheTtlOverride = null;
});

test("L-2-F4-5: the group deadline includes the effective job-wide wait budget once", () => {
  const plan = { agent: "reviewer", lockType: "read", timeoutMs: 60000, validationCommand: "" };
  const runBudget = Math.max(I.CONFIG.readOnlyRetryMaxElapsedMs, 60000) + 60000;
  assert.equal(I.parallelGroupDeadlineMs([plan], [{ maxWaitMs: 1200000 }]), runBudget + Math.min(I.CONFIG.providerWaitMaxMs, 1200000));
  assert.equal(I.parallelGroupDeadlineMs([plan], [{ maxWaitMs: 1234 }]), runBudget + 1234);
  measurements.readerDeadlineBeforeMs = runBudget;
  measurements.readerDeadlineAfterMs = I.parallelGroupDeadlineMs([plan], [{}]);
});

test("L-2-F4-5: waiting for a sibling never consumes a short job's validation budget", async () => {
  const cwd = await repo("group-wait-budget");
  runtime({ run: async (_agent, _prompt, _cwd, _dry, plan) => {
    const started = Date.now();
    await sleep(plan.allowedEdits.includes("src/0.txt") ? 50 : 2400);
    return result({ childStartedAtMs: started, childFinishedAtMs: Date.now() });
  } });
  const answer = text(await call("run_opencode_parallel", { jobs: [
    writer(cwd, "src/0.txt", { timeoutMs: 1500, validationCommand: "git diff --check" }),
    writer(cwd, "src/1.txt", { timeoutMs: 5000 }),
  ] }));
  assert.match(answer, /Parallel group status: completed/);
  assert.match(answer, /Validation gate: passed/);
});

test("L-2-F4-5: a late slot wait remains inside its own budget when the original group timer fires", async () => {
  const waiting = new Map();
  const coordinator = createParallelCoordinator({ jobs: [{}], lockPlans: [{}], jobIds: ["late-wait"],
    providerWaitingJobs: waiting, jobBudgets: [{ waitMs: 250, executionMs: 100 }], groupDeadlineMs: 80,
    parallelGroupScopeReport: async () => { throw new Error("unused in this timer fixture"); } });
  try {
    await coordinator.job(0).ready({ cwd: root, before: new Map(), expectedHead: "" });
    await sleep(40);
    waiting.set("late-wait", { since: new Date().toISOString() });
    await sleep(80);
    assert.equal(coordinator.signal.aborted, false);
    assert.ok(coordinator.deadlineMs >= 350);
    waiting.delete("late-wait");
    coordinator.agentSpawned(0);
    assert.equal(coordinator.signal.aborted, false);
  } finally { coordinator.dispose(); }
});

test("group verification includes forbidden ignored paths written by validation", async () => {
  const cwd = await repo("ignored-gate");
  await writeFile(path.join(cwd, ".gitignore"), ".env\n");
  await git(cwd, ["add", ".gitignore"]);
  await git(cwd, ["-c", "user.name=Parity", "-c", "user.email=parity@example.invalid", "commit", "-qm", "ignore fixture"]);
  runtime();
  const answer = text(await call("run_opencode_parallel", { jobs: [writer(cwd, "src/0.txt", { validationCommand: "node tools/check.cjs ignored" })] }));
  assert.match(answer, /Disallowed files: \.env/);
  const record = await I.directRunAuditStore().get(cwd, runIds(answer)[0]);
  assert.equal(record.status, "rejected");
  assert.equal(record.errorType, "integration_source_unrepresentable", "the earlier patch-collection refusal retains its error type");
  const db = await I.openLockDb(cwd);
  try {
    const retained = db.prepare("SELECT worktree_path FROM worktree_artifacts WHERE job_id = ?").get(runIds(answer)[0]);
    assert.equal(await readFile(path.join(retained.worktree_path, ".env"), "utf8"), "ignored validation mutation");
  } finally { I.closeDb(db); }
});

test("L-2-F4-6/9/10: repositories have separate path ownership; serial lists merge and plan/run reject identically", async () => {
  const a = await repo("repo-a"), b = await repo("repo-b");
  runtime({ run: async (_agent, _prompt, cwd) => { await writeFile(path.join(cwd, "src", "0.txt"), "changed\n"); return result(); } });
  const answer = text(await call("run_opencode_parallel", { jobs: [writer(a), writer(b)] }));
  assert.match(answer, /Parallel group status: completed/);
  for (const file of ["pyproject.toml", "schema/a.sql", "CMakeLists.txt", "requirements-dev.txt"]) {
    const jobs = [writer(a, file), writer(a, "src/1.txt")];
    for (const name of ["validate_delegation_plan", "run_opencode_parallel"]) assert.match(text(await call(name, { jobs })), /serial_only_parallel_write|shared_file_parallel_write/);
  }
  for (const kind of ["serialOnly", "sharedFiles"]) {
    const job = writer(a, "src/0.txt", { [kind]: ["other.txt"] });
    job.scopeContract[kind === "serialOnly" ? "serialOnly" : "shared"] = ["src/0.txt"];
    assert.ok(I.validateParallelWritePlan([job, writer(a, "src/1.txt")]).error);
  }
  for (const origin of ["internal", "manual"]) {
    const held = await I.acquireHardLock({ cwd: a, paths: ["src/0.txt"], lockType: "write", agent: "fixture", origin });
    try {
      const errorType = origin === "manual" ? "manual_lock_misuse" : "read_lock_conflict";
      for (const name of ["run_opencode_agent", "validate_delegation_plan", "run_opencode_parallel"]) {
        const args = name === "run_opencode_agent" ? reader(a) : { jobs: [reader(a), reader(a)] };
        assert.match(text(await call(name, args)), new RegExp(errorType));
      }
    } finally { await I.releaseHardLock(held.lock.id, held.lock.token, held.lock.paths, held.lock.cwd); }
  }
});

test("L-2-F4-7/11: unconfirmed termination retains and measures even an empty worktree and quarantines its lock", async () => {
  const cwd = await repo("unconfirmed");
  await writeFile(path.join(cwd, "large.txt"), Buffer.alloc(200000));
  await git(cwd, ["add", "large.txt"]);
  await git(cwd, ["-c", "user.name=Parity", "-c", "user.email=parity@example.invalid", "commit", "-qm", "size fixture"]);
  runtime({ run: async () => result({ errorType: "process_tree_termination_unconfirmed", processTreeUnconfirmed: true }) });
  const answer = text(await call("run_opencode_parallel", { jobs: [writer(cwd)] }));
  const locks = await I.listLocks(cwd);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].expiresAt, Number.MAX_SAFE_INTEGER);
  assert.match(answer, /Temporary lock released: no/);
  const db = await I.openLockDb(cwd);
  try {
    const row = db.prepare("SELECT measured_bytes, worktree_path FROM worktree_artifacts WHERE job_id = ?").get(runIds(answer)[0]);
    assert.ok(fs.existsSync(row.worktree_path));
    assert.ok(row.measured_bytes >= 200000);
    measurements.retainedBytes = row.measured_bytes;
    // Fixture teardown only: no real processes survive the synthetic unconfirmed result.
    db.exec("DELETE FROM locks");
  } finally { I.closeDb(db); }
  const capProbe = path.join(root, "byte-cap.mjs");
  await writeFile(capProbe, `process.argv.push('--self-test'); process.env.CODEX_OPENCODE_RETAINED_WORKTREE_MAX_BYTES='1';
    const {__selfTest:{internals:I,hooks}}=await import(${JSON.stringify(new URL("../server.js", import.meta.url).href)});
    hooks.stateDirectoryOverride=${JSON.stringify(path.join(root, "state"))};
    const result=await I.createWorktreeForJob({cwd:${JSON.stringify(cwd)},agent:'builder',jobId:'byte-cap',lockedPaths:['src/1.txt'],allowedEdits:['src/1.txt']});
    if(result.errorType!=='worktree_capacity_exceeded') throw new Error(JSON.stringify(result));`);
  const capEnv = { ...process.env }; delete capEnv.CODEX_OPENCODE_STATE_DIR;
  await promisify(cp.execFile)(process.execPath, [capProbe], { env: capEnv, windowsHide: true, timeout: 30000 });
  if (process.argv.includes("--baseline")) {
    const source = await promisify(cp.execFile)("git", ["show", "f8fd9ed:lib/execute-job.js"], { cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 });
    const modulePath = path.join(root, "old-execute-job.mjs");
    await writeFile(modulePath, source.stdout.replace(/from "(\.[^\"]+)"/g, (_match, spec) => `from "${new URL(spec, new URL("../lib/execute-job.js", import.meta.url)).href}"`));
    const baselineRepo = await repo("baseline-unconfirmed");
    const executor = (await import(pathToFileURL(modulePath))).createExecuteJobRuntime({ ...deps, logEvent: () => {}, providerCapacitySnapshot: null });
    const old = await executor.executeOpenCodeJob(writer(baselineRepo));
    assert.equal(old.result.worktree?.removed, true, "base single path also removed an empty unconfirmed worktree: " + text(old.response));
    assert.equal(old.worktree, null);
    measurements.baselineUnconfirmedEmptyWorktreeRemoved = old.result.worktree.removed;
    const baselineDb = await I.openLockDb(baselineRepo);
    try { baselineDb.exec("DELETE FROM locks"); } finally { I.closeDb(baselineDb); }
  }
});

test("L-2-F4-8: validation changes to Git control files and NTFS streams fail on both paths", async () => {
  for (const mode of process.platform === "win32" ? ["git", "stream"] : ["git"]) for (const parallel of [false, true]) {
    const cwd = await repo(`validation-${mode}-${parallel}`);
    runtime();
    const job = writer(cwd, "src/0.txt", { validationCommand: `node tools/check.cjs ${mode}` });
    const answer = text(await call(parallel ? "run_opencode_parallel" : "run_opencode_agent", parallel ? { jobs: [job] } : job));
    assert.match(answer, new RegExp(mode === "git" ? "git_control_surface_modified" : "alternate_data_stream_written"));
  }
});

test("L-2-F4-10/12: shared admission rejects worktree mode off; acquisitions preserve non-conflict error types", async () => {
  const cwd = await repo("lock-errors"); runtime();
  const jobs = [writer(cwd), writer(cwd, "src/1.txt")];
  let handler;
  registerParallelTool({ ...deps, prepareDelegationJobs: async (items, options) => {
    // Exercise the same shared decision using its injected shouldUseWorktree dependency.
    return I.prepareDelegationJobs(items, options);
  }, server: { tool: (...args) => { handler = args.at(-1); } } });
  for (const type of ["lock_path_resolution_failed", "lock_database_failed", "integration_recovery_pending", "lock_request_rejected", "lock_path_unsafe", "lock_path_ambiguous"]) {
    const executor = createExecuteJobRuntime({ ...deps, acquireHardLock: async () => ({ ok: false, errorType: type, error: `fixture ${type}` }),
      logEvent: () => {}, effectiveQueueWriteConflictPolicy: () => "fail", providerCapacitySnapshot: null,
    });
    registerParallelTool({ ...deps, executeOpenCodeJob: executor.executeOpenCodeJob, server: { tool: (...args) => { handler = args.at(-1); } } });
    assert.match(text(await handler({ jobs: [reader(cwd)] })), new RegExp(type));
  }
  // Separate process: CONFIG is immutable after import, just like the real bridge.
  const probe = path.join(root, "mode-off.mjs");
  await writeFile(probe, `process.argv.push('--self-test'); process.env.CODEX_OPENCODE_WORKTREE_MODE='off';
    const {__selfTest:{internals:I}}=await import(${JSON.stringify(new URL("../server.js", import.meta.url).href)});
    for(const name of ['validate_delegation_plan','run_opencode_parallel']) {
      const answer=await I.server._registeredTools[name].handler({jobs:${JSON.stringify(jobs)}},{});
      if(!JSON.stringify(answer).includes('parallel_write_requires_worktrees')) throw new Error(JSON.stringify(answer));
    }`);
  const env = { ...process.env }; delete env.CODEX_OPENCODE_STATE_DIR;
  await promisify(cp.execFile)(process.execPath, [probe], { env, windowsHide: true, timeout: 30000 });
});

let passed = 0;
const started = performance.now();
try {
  for (const [name, fn] of tests) {
    const filter = process.argv.find(arg => arg.startsWith("--filter="))?.slice(9);
    if (filter && !name.includes(filter)) continue;
    try { await fn(); passed++; console.log(`ok ${name}`); }
    catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ passed, total: tests.length, wallMs: Math.round(performance.now() - started), measurements }));
} finally {
  injectHeadRead = null; hooks.agentRuntimeTestHook = null; hooks.attestationCacheTtlOverride = null;
  cp.ChildProcess.prototype.spawn = originalSpawn; fs.createReadStream = originalReadStream; syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
