#!/usr/bin/env node
// Post-run scope checks and containment; only fake agents and OS-temp fixtures.
import "./test-env.js";
import { strict as assert } from "node:assert";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeJobTestHooks } from "../lib/execute-job.js";
import { createCommandRuntime } from "../lib/run-command.js";
import { createValidationRuntime } from "../lib/validation-command.js";
import { createPathMatcher, isWithinAnyPath } from "../lib/paths.js";
import { makeFlexFixture } from "./flex-fixture.js";

process.argv.push("--self-test");
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
// Trace real bridge Git starts after the fake agent finishes; preserve execFile's
// custom promisifier and restore the builtin once the bridge captured its runner.
let gitTrace = null;
const originalExecFile = childProcess.execFile;
const noteCommand = (command, args) => {
  if (gitTrace && /(?:^|[\\/])git(?:\.exe)?$/i.test(command)) gitTrace.push(args);
};
const tracedExecFile = (...args) => { noteCommand(args[0], args[1]); return originalExecFile(...args); };
tracedExecFile[promisify.custom] = (...args) => { noteCommand(args[0], args[1]); return originalExecFile[promisify.custom](...args); };
childProcess.execFile = tracedExecFile;
syncBuiltinESMExports();
const { __selfTest } = await import("../server.js");
childProcess.execFile = originalExecFile;
syncBuiltinESMExports();
const { hooks, internals: I } = __selfTest;
const fixture = await makeFlexFixture(__selfTest, "review-postrun");
await mkdir(path.join(fixture.repo, "tools"));
await writeFile(path.join(fixture.repo, "tools", "check.cjs"), `
const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'mutate') fs.appendFileSync('src/a.txt', 'validation mutation\\n');
if (mode === 'forbidden') fs.writeFileSync('.env', 'fixture only\\n');
if (mode === 'slow') setTimeout(() => process.exit(1), 500);
else process.exit(mode === 'pass' ? 0 : 1);
`);
await fixture.git(["add", "."]);
await fixture.git([...fixture.identity, "commit", "-qm", "validation fixture"]);

function agentRuntime({ spentMs = 0, outcome = null, onRun = null } = {}) {
  const runs = [];
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (agent, cwd, fallback, subagentStrategy) => ({ requestedAgent: agent, actualAgent: agent,
      requestedAgentMode: "primary", actualAgentMode: "primary", fallbackUsed: false, proxyUsed: false,
      subagentStrategy, availableAgents: [agent], discoveryExitCode: 0 }),
    readAgentDebugMetadata: async agent => ({ ok: true, metadata: { name: agent, mode: "primary",
      provider: "fixture", model: "model", canEdit: agent === "builder", canDelegate: false,
      externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true,
      protectedEditsDenied: true, permissionProfileSha256: "fixture" } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, plan, timeoutMs, options) => {
      runs.push({ timeoutMs, cwd });
      if (onRun) await onRun({ cwd, options });
      return outcome || { exitCode: 0, stdout: "Done.", stderr: "", errorType: null, dryRun,
        durationMs: spentMs, childStartedAtMs: Date.now() - spentMs, childFinishedAtMs: Date.now(),
        assistantFinalResponseDetected: true, configuredProvider: "fixture", configuredModel: "model" };
    },
  };
  return runs;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const job = (mode, extra = {}) => {
  const command = `node tools/check.cjs ${mode}`;
  return fixture.writeJob("src/a.txt", { validationCommand: command,
    scopeContract: { ...fixture.writeScope("src/a.txt"), validationCommand: command },
    validationFixPasses: 1, ...extra });
};

test("L-1-F1b-2/12: reader HEAD move uses one snapshot and three descriptive Git starts", async () => {
  agentRuntime({ onRun: async () => {
    await fixture.git([...fixture.identity, "commit", "--allow-empty", "-qm", "concurrent reader HEAD move"]);
    gitTrace = [];
  } });
  try {
    const response = await fixture.callTool("run_opencode_agent", { agent: "reviewer", task: "Read src/a.txt.",
      cwd: fixture.repo, write: false, lockMode: "off", scopeContract: { mode: "read", read: ["src/a.txt"] } });
    assert.match(fixture.textOf(response), /Status: completed/);
    assert.match(fixture.textOf(response), /Repository HEAD moved/);
    assert.equal(gitTrace.filter(args => args.includes("merge-base")).length, 1);
    assert.equal(gitTrace.filter(args => args.includes("log") && args.includes("--format=%h %s")).length, 1);
    assert.equal(gitTrace.filter(args => args.includes("diff") && args.filter(arg => /^[a-f0-9]{40}$/i.test(arg)).length === 2).length, 1);
    assert.equal(gitTrace.filter(args => args.includes("ls-files") && args.includes("--exclude-standard") && !args.includes("--ignored")).length, 1);
    console.log("No validation: one post-run listing; HEAD description: 3 Git starts (previously 6)");
  } finally { gitTrace = null; }
});

for (const mode of ["mutate", "forbidden"]) test(`L-1-F1b-5: failed ${mode} validation forbids a fix pass`, async () => {
  const runs = agentRuntime();
  const response = await fixture.callTool("run_opencode_agent", job(mode));
  assert.equal(runs.length, 1, fixture.textOf(response));
  assert.match(fixture.textOf(response), /^Status: failed/m);
  assert.match(fixture.textOf(response), /validation_mutated_workspace/);
  assert.match(fixture.textOf(response), /Validation fix pass: skipped/);
});
test("L-1-F1b-5: failed mutating self-check forbids every further pass", async () => {
  const runs = agentRuntime();
  const requested = job("pass", { validationFixPasses: 0, selfCheckPasses: 2 });
  requested.scopeContract.selfCheckCommands = ["node tools/check.cjs mutate"];
  const response = await fixture.callTool("run_opencode_agent", requested);
  assert.equal(runs.length, 1, fixture.textOf(response));
  assert.match(fixture.textOf(response), /validation_mutated_workspace/);
  assert.match(fixture.textOf(response), /fix passes used 0 of 2/);
});
test("L-1-F1b-10: triggering validation consumes the fix-pass budget", async () => {
  const runs = agentRuntime({ spentMs: 59800 });
  const response = await fixture.callTool("run_opencode_agent", job("slow", { timeoutMs: 120000 }));
  assert.equal(runs.length, 1, fixture.textOf(response));
  assert.match(fixture.textOf(response), /only \d+ s of the job timeout are left/);
});
test("L-1-F1b-10: admitted pass and final validation use the remaining budget", async () => {
  const runs = agentRuntime({ spentMs: 1000 });
  const gates = [];
  executeJobTestHooks.validationGate = async (_run, options) => {
    gates.push(options.timeoutMs);
    await fixture.sleep(500);
    return { status: gates.length === 1 ? "failed" : "passed", command: options.command,
      exitCode: gates.length === 1 ? 1 : 0, durationMs: 500, stdout: "", stderr: "",
      errorType: gates.length === 1 ? "validation_command_failed" : null };
  };
  try {
    const response = await fixture.callTool("run_opencode_agent", job("pass", { timeoutMs: 120000 }));
    assert.equal(response.isError, undefined, fixture.textOf(response));
    assert.equal(runs.length, 2);
    assert.ok(runs[1].timeoutMs < 118500, JSON.stringify(runs));
    assert.ok(gates[1] <= runs[1].timeoutMs, JSON.stringify(gates));
    console.log(`Fix budget: requested 120000 ms, second run ${runs[1].timeoutMs} ms, checks ${gates.join(",")} ms`);
  } finally { executeJobTestHooks.validationGate = null; }
});

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
for (const stream of ["stdout", "stderr"]) test(`L-1-F1b-3: ${stream} cap stops a live tree`, async () => {
  const marker = path.join(fixture.root, `${stream}-tree.json`);
  const script = path.join(fixture.root, `${stream}-cap.cjs`);
  await writeFile(script, `
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, child:child.pid, crossedAt:Date.now()}));
process.${stream}.write('x'.repeat(2097153));
setInterval(()=>{},1000);
`);
  const started = Date.now();
  const result = await I.runSpawnCommand(process.execPath, [script], fixture.root, 60000);
  const tree = JSON.parse(await readFile(marker, "utf8"));
  try {
    assert.equal(result[`${stream}Truncated`], true);
    assert.ok(Date.now() - tree.crossedAt < 10000, JSON.stringify(result));
    for (const pid of [tree.pid, tree.child, result.supervisorProcessId]) assert.equal(alive(pid), false, `process ${pid} survived`);
    assert.equal(result.processTreeUnconfirmed, false);
    console.log(`Output cap ${stream}: ${Date.now() - tree.crossedAt} ms from cap write, ${Date.now() - started} ms total`);
  } finally {
    for (const pid of [tree.pid, tree.child]) if (alive(pid)) process.kill(pid);
  }
});
test("L-1-F1b-7/12: supervisor loss quarantines the slot and lock with one record", async () => {
  let tree;
  const marker = path.join(fixture.root, "lost-tree.json");
  const script = path.join(fixture.root, "lost-tree.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`);
  // Kill the real supervisor after the payload is demonstrably running.
  const spawnResult = await I.runSpawnCommand(process.execPath, [script], fixture.root, 60000, null, {
    onSpawn: async ({ pid }) => {
      void (async () => {
        await fixture.waitFor(async () => { try { tree = JSON.parse(await readFile(marker, "utf8")); return true; } catch { return false; } });
        process.kill(pid, "SIGKILL");
      })();
      return { ok: true };
    },
  });
  // Quarantine is the safe result even when a payload inherited the supervisor's pipes.
  if (tree && alive(tree.pid)) process.kill(tree.pid);
  assert.equal(spawnResult.processTreeUnconfirmed, true);
  assert.equal(spawnResult.terminationErrorType, "process_tree_termination_unconfirmed");
  assert.equal(spawnResult.supervisorErrorType, "process_supervisor_exited_without_result");
  const lease = await I.acquireProviderLease({ providerKey: "fixture-quarantine", timeoutMs: 1000 });
  const evidence = await I.containmentRecord(spawnResult);
  const pause = await I.quarantineProviderLease(lease.lease, evidence);
  assert.equal(pause.ok, true);
  agentRuntime({ outcome: { ...spawnResult, errorType: spawnResult.terminationErrorType, containmentEvidence: evidence } });
  const response = await fixture.callTool("run_opencode_agent", job("pass"));
  assert.match(fixture.textOf(response), /^Status: failed/m);
  const locks = await I.listLocks(fixture.repo);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].expiresAt, Number.MAX_SAFE_INTEGER);
  const lockDb = await I.openLockDb(fixture.repo);
  try { assert.equal(lockDb.prepare("SELECT containment FROM runs WHERE run_id = ?").get(locks[0].runId).containment, evidence); }
  finally { I.closeDb(lockDb); }
  const handle = await I.openProviderLeaseDb();
  try { assert.equal(handle.prepare("SELECT containment FROM provider_leases WHERE lease_id = ?").get(lease.lease.id).containment, evidence); }
  finally { I.closeDb(handle); }
});
test("L-1-F1b-7: watchdog expiry marks unconfirmed containment for validation", async () => {
  const runtime = createCommandRuntime({ ...I, CONFIG: { ...I.CONFIG, queueLeaseMs: 200, providerLeaseMs: 200 },
    PROCESS_SUPERVISOR_PATH: path.resolve("bin/process-supervisor.js"), BRIDGE_RUNTIME_DIR: path.resolve("."),
    abortSignalErrorType: () => "agent_cancelled", logEvent: () => {} });
  const result = await runtime.runSpawnCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], fixture.root, 60000,
    null, { beforeHeartbeat: () => new Promise(() => {}) });
  assert.equal(result.supervisorErrorType, "process_supervisor_watchdog_expired");
  assert.equal(result.terminationErrorType, result.treeTerminationConfirmed
    ? "process_supervisor_watchdog_expired" : "process_tree_termination_unconfirmed");
  assert.equal(alive(result.payloadProcessId), false);
  const gate = createValidationRuntime({ runSpawnCommand: async () => ({ ...result, processTreeUnconfirmed: true }) });
  assert.equal((await gate.runValidationProcess(process.execPath, [], fixture.root, 1000, process.env)).processTreeUnconfirmed, true);
});
test("L-1-F1b-2: compiled matchers preserve literal, glob and case decisions", async () => {
  const patterns = ["src", "src/*", "**/.env", "**/*.{pem,key}", "src/[a-c].txt", "src/[!a].txt"];
  for (const pattern of patterns) {
    const matcher = createPathMatcher([pattern], fixture.repo);
    for (const file of ["src/a.txt", "SRC/a.txt", "src/b.txt", "src/nested/a.txt", ".env", "nested/.env", "key.pem", "src/[a-c].txt"])
      assert.equal(matcher(file), isWithinAnyPath(file, [pattern], fixture.repo), `${file}: ${pattern}`);
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    const started = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - started} ms)`); }
    catch (error) { failed++; console.log(`FAIL ${name}\n${error.stack || error}`); }
    finally { hooks.agentRuntimeTestHook = null; }
  }
} finally { executeJobTestHooks.validationGate = null; await fixture.cleanup(); }
console.log(`${tests.length - failed}/${tests.length} post-run tests passed.`);
process.exit(failed ? 1 : 0);
