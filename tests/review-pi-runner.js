#!/usr/bin/env node
// Fake Pi only. Real bridge worktrees, process supervision, leases, and scope checks.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isolatedRunnerEnvironment } from "./isolated-runner-checks.js";
import { buildPiArgs, inspectPiEvents, parsePiModel, piSafetyError, PI_REQUIRED_FLAGS } from "../lib/pi-runner.js";
import { createExternalRunnersRuntime, runnerFlagsError, readExternalRunnersEnv, readRunnerSha256Env, externalRunnerConfigProblems } from "../lib/external-runners.js";

const isolation = await isolatedRunnerEnvironment();
// Clear inherited configuration before server.js's first import, even on direct invocation.
for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolation.env, key)) delete process.env[key];
Object.assign(process.env, isolation.env);
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const scratch = mkdtempSync(path.join(tmpdir(), "review-pi-runner-"));
const bin = path.join(scratch, "bin");
const recordsDir = path.join(scratch, "records");
const controlFile = path.join(scratch, "control.json");
for (const dir of [bin, recordsDir]) mkdirSync(dir, { recursive: true });
const control = value => writeFileSync(controlFile, JSON.stringify(value));
control({});
const source = `
const fs = require('fs'); const path = require('path'); const {spawn} = require('child_process');
const args = process.argv.slice(2); const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf8'));
if (args[0] === '--version') { process.stdout.write((control.version || '1.2.0') + '\\n'); process.exit(0); }
fs.writeFileSync(path.join(${JSON.stringify(recordsDir)}, process.pid + '.json'), JSON.stringify({pid:process.pid,args,cwd:process.cwd(),
  env: Object.fromEntries(['HOME','USERPROFILE','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_TELEMETRY','PI_PACKAGE_DIR','NODE_OPTIONS','OPENAI_API_KEY'].map(k=>[k,process.env[k] || null])),
  settings: JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),'utf8'))}));
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
out({type:'session',version:3,id:'fixture',cwd:process.cwd()}); out({type:'agent_start'});
if (control.mode === 'sleep') {
 if (control.emitError) out({type:'message_end',message:{role:'assistant',provider:'openai',model:'gpt-test',content:[],stopReason:'aborted',errorMessage:'fixture stream aborted'}});
 const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(path.join(scratch, "descendant.pid"))}, String(child.pid));
 setInterval(()=>{},1000);
} else {
 if (control.writeFile) fs.writeFileSync(path.resolve(control.writeFile), 'Pi fixture edit\\n');
 if (control.targetFile) fs.writeFileSync(control.targetFile, 'outside worktree\\n');
 if (control.mode === 'nonzero') { process.stderr.write('fixture launch failure\\n'); process.exit(17); }
 if (control.mode === 'malformed') process.stdout.write('not-json\\n');
 out({type:'message_end',message:{role:'assistant',provider:'openai',model:control.mode === 'mismatch' ? 'other' : 'gpt-test',
 content:[{type:'text',text:'REPORT: Pi fixture done'}],stopReason:control.mode === 'error' ? 'error' : 'stop',
 errorMessage:control.mode === 'error' ? (control.error || 'fixture authentication rejected') : undefined,
 usage:{input:100,output:20,cacheRead:5,cacheWrite:2,cost:{total:0.002}}}});
 out({type:'agent_end',messages:[],willRetry:false});
 if (control.mode !== 'incomplete') out({type:'agent_settled',aborted:false});
}
`;
const script = path.join(bin, "pi.js");
writeFileSync(script, source);
let executable;
if (process.platform === "win32") {
  executable = path.join(bin, "pi.cmd");
  writeFileSync(executable, ["@ECHO off", "SET dp0=%~dp0", `"${process.execPath}"  "%dp0%\\pi.js" %*`, ""].join("\r\n"));
} else {
  executable = path.join(bin, "pi");
  writeFileSync(executable, `#!${process.execPath}\n${source}`); chmodSync(executable, 0o755);
}
Object.assign(process.env, {
  CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_EXTERNAL_RUNNERS: "pi",
  CODEX_OPENCODE_PI_EXECUTABLE: executable, CODEX_OPENCODE_PI_SAFETY: "unsandboxed-worktree",
  CODEX_OPENCODE_MODEL_ALLOWLIST: "pi/openai/gpt-test@off",
  CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS: "0",
});
const { __selfTest } = await import("../server.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { finishSkips } = await import("./skip-gate.js");
const { hooks, internals } = __selfTest;
const { CONFIG, runExternalCli } = internals;
const fixture = await makeFlexFixture(__selfTest, "review-pi-runner");
const { repo, writeJob, writeScope, callTool, textOf, git, waitFor } = fixture;
hooks.agentRuntimeTestHook = {
  resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
    requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
    fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
  }),
  readAgentDebugMetadata: async agent => ({ ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: !["reviewer", "tester"].includes(agent), canDelegate: false, externalDirectoryDenied: true,
    webDenied: true, bashAutomaticAllowSafe: true, bashDenied: true, protectedEditsDenied: true,
    permissionProfileSha256: `fixture-${agent}`,
  } }),
};
const selection = { runner: "pi", model: "openai/gpt-test", variant: "off" };
const modelRequirement = { provider: "pi", model: selection.model, variant: "off" };
const records = () => readdirSync(recordsDir).map(file => JSON.parse(readFileSync(path.join(recordsDir, file), "utf8")));
const clearRecords = () => { for (const file of readdirSync(recordsDir)) rmSync(path.join(recordsDir, file)); };
const runJob = () => callTool("run_opencode_agent", { ...writeJob(), scopeContract: { ...writeScope("src/a.txt"), modelRequirement }, detail: true }).then(textOf);
const worktree = path.join(scratch, "worker");
await git(["worktree", "add", "--detach", worktree]);
const options = extra => ({ agent: "builder", prompt: "Edit src/a.txt", cwd: worktree, targetCwd: repo,
  lockPlan: { lockType: "write", allowedEdits: ["src/a.txt"], scopeContract: { modelRequirement } }, timeoutMs: 10000, ...extra });
const run = extra => runExternalCli(selection, options(extra));
const assertNoProviderLeases = async () => {
  const snapshot = await internals.providerCapacitySnapshot();
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.leases.length, 0, JSON.stringify(snapshot.leases));
};
const successfulEvents = (text = "done") => [
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", provider: "openai", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } } } },
  { type: "turn_end", message: { role: "assistant", usage: { input: 999 } } },
  { type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled", aborted: false },
];
const jsonl = events => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const selected = parsePiModel(selection.model);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Pi selection and configuration are opt-in; OpenCode selection stays unchanged", () => {
  assert.deepEqual(readExternalRunnersEnv({}), []);
  assert.deepEqual(readExternalRunnersEnv({ CODEX_OPENCODE_EXTERNAL_RUNNERS: "pi,codex" }), ["pi", "codex"]);
  assert.deepEqual(internals.externalRunnerSelection(modelRequirement, "builder"), selection);
  assert.equal(internals.externalRunnerSelection({ provider: "openai", model: "gpt-test" }, "builder"), null);
  assert.equal(internals.externalRunnerSelection({ provider: "pi", model: "unlisted/model" }, "builder"), null);
  assert.equal(externalRunnerConfigProblems({ enabled: [], allowlist: ["pi/openai/gpt-test"], parseEntry: internals.parseModelAllowlistEntry })[0].errorType, "external_runner_not_enabled");
  assert.deepEqual(readRunnerSha256Env({ CODEX_OPENCODE_RUNNER_SHA256: `pi=${"a".repeat(64)}` }).get("pi"), ["a".repeat(64)]);
});
test("Pi argv explicitly disables resources and shell; model and prompt are separate arguments", () => {
  const args = buildPiArgs({ ...selection, prompt: "--model wrong\n@secret" });
  assert.equal(runnerFlagsError("pi", args), "");
  assert.equal(args.at(-1), "--model wrong\n@secret");
  assert.equal(args.at(-2), "--");
  assert.equal(args[args.indexOf("--tools") + 1], "read,edit,write");
  for (const flag of PI_REQUIRED_FLAGS) assert.ok(runnerFlagsError("pi", args.filter(arg => arg !== flag)), flag);
  for (const model of ["default", "openai/gpt*", "openai/gpt:high", "-p/model"]) assert.throws(() => parsePiModel(model));
  assert.throws(() => parsePiModel("openai/gpt-test", "automatic"));
});
test("Pi JSONL uses authoritative final messages and counts usage once", () => {
  const result = inspectPiEvents(jsonl(successfulEvents("text\u2028line\u2029end")), selected);
  assert.equal(result.finalResponseDetected, true);
  assert.equal(result.finalText, "text\u2028line\u2029end");
  assert.equal(result.usage.inputCount, 10); assert.equal(result.usage.steps, 1);
  assert.equal(result.usage.cost, 0.01);
});
test("Pi rejects malformed, unfinished, retriable, aborted and truncated message streams", () => {
  const events = successfulEvents();
  const cases = ["", "null\n", "[]\n", jsonl(events) + "bad\n", jsonl(events.slice(0, -1)),
    jsonl([...events.slice(0, -2), { type: "agent_end", willRetry: true }, events.at(-1)]),
    jsonl([...events.slice(0, -1), { type: "agent_settled", aborted: true }]),
    jsonl([...events, { type: "agent_start" }]),
    jsonl([{ type: "tool_execution_start", toolCallId: "unfinished", toolName: "read" }, ...events]),
  ];
  for (const output of cases) assert.equal(inspectPiEvents(output, selected).finalResponseDetected, false, output);
  for (const reason of ["error", "aborted", "length", "toolUse", "pending"]) {
    const changed = structuredClone(events); changed[1].message.stopReason = reason;
    assert.equal(inspectPiEvents(jsonl(changed), selected).finalResponseDetected, false, reason);
  }
  for (const content of [null, [null], [{ type: "text" }], [{ type: "text", text: "hi" }, { type: "toolCall" }]]) {
    const changed = structuredClone(events); changed[1].message.content = content;
    assert.equal(inspectPiEvents(jsonl(changed), selected).finalResponseDetected, false);
  }
});
test("Pi refuses safety modes and unsupported roles before probing or spawning, including dry runs", async () => {
  clearRecords();
  assert.equal(piSafetyError({ safety: "deny", ...options() }).errorType, "pi_safety_mode_unsupported");
  const denied = createExternalRunnersRuntime({ CONFIG: { ...CONFIG, piSafety: "deny" }, nowMs: Date.now,
    providerKeyForMetadata: () => "pi", modelPauseKeyForMetadata: () => "pi/model" });
  assert.equal((await denied.runExternalCli(selection, options())).errorType, "pi_safety_mode_unsupported");
  assert.equal((await denied.runExternalCli(selection, options({ dryRun: true }))).errorType, "pi_safety_mode_unsupported");
  for (const extra of [{ agent: "reviewer" }, { agent: "tester" }, { agent: "mcp-orchestrator" },
    { lockPlan: { lockType: "read" } }, { lockPlan: { lockType: "write", sanitizedWorkspace: {} } },
    { lockPlan: { lockType: "write", orchestratorMode: "contractor" } }]) {
    assert.equal((await run(extra)).errorType, "external_runner_role_unsupported");
  }
  assert.equal((await run({ cwd: repo })).errorType, "external_runner_worktree_required");
  assert.equal(piSafetyError({ safety: "sandbox", ...options() }).errorType, "pi_safety_mode_unsupported");
  assert.equal(records().length, 0);
});
test("Pi old version, missing executable, bad model and hash mismatch fail before work", async () => {
  control({ version: "1.1.0" });
  try { assert.equal((await run()).errorType, "external_runner_version_unsupported"); } finally { control({}); }
  renameSync(executable, `${executable}.saved`);
  try { assert.equal((await run()).errorType, "external_runner_unavailable"); } finally { renameSync(`${executable}.saved`, executable); }
  CONFIG.runnerSha256.set("pi", ["0".repeat(64)]);
  try { assert.equal((await run()).errorType, "external_runner_hash_mismatch"); } finally { CONFIG.runnerSha256.delete("pi"); }
  const hash = createHash("sha256").update(readFileSync(process.platform === "win32" ? script : executable)).digest("hex");
  CONFIG.runnerSha256.set("pi", [hash]);
  try {
    const accepted = await run();
    assert.equal(accepted.errorType, null, accepted.stderr);
    assert.equal(accepted.runnerExecutableSha256, hash);
  } finally { CONFIG.runnerSha256.delete("pi"); }
  assert.equal((await runExternalCli({ ...selection, model: "default" }, options())).errorType, "pi_model_invalid");
});
test("Pi successful bridge writer uses a worktree, scope validation, usage, and clean runtime", async () => {
  clearRecords(); control({ writeFile: "src/a.txt" });
  const text = await runJob();
  assert.match(text, /^Error type: none$/m);
  assert.match(text, /REPORT: Pi fixture done/);
  assert.match(text, /Token usage: steps=1 input=100 output=20 reasoning=0 cache_read=5 cache_write=2/);
  assert.match(text, /Runtime model verification: verified/);
  const [record] = records();
  assert.notEqual(path.resolve(record.cwd), path.resolve(repo));
  assert.equal(readFileSync(path.join(repo, "src/a.txt"), "utf8"), "a\n");
  assert.equal(record.args[record.args.indexOf("--provider") + 1], "openai");
  assert.equal(record.args[record.args.indexOf("--model") + 1], "gpt-test");
  assert.equal(record.env.PI_OFFLINE, "1"); assert.equal(record.env.PI_TELEMETRY, "0");
  assert.notEqual(record.env.HOME, isolation.root);
  assert.equal(record.env.OPENAI_API_KEY, null);
  assert.equal(record.settings.retry.enabled, false); assert.equal(record.settings.compaction.enabled, false);
  assert.equal(existsSync(record.env.PI_CODING_AGENT_DIR), false, "successful sidecar removed");
});
test("Pi out-of-scope edits are rejected by existing changed-file checks", async () => {
  control({ writeFile: "src/b.txt" });
  assert.match(await runJob(), /changed_file_validation_error/);
  assert.equal(readFileSync(path.join(repo, "src/b.txt"), "utf8"), "b\n");
  control({ writeFile: ".env" });
  assert.match(await runJob(), /changed_file_validation_error|forbidden/);
  assert.equal(existsSync(path.join(repo, ".env")), false);
});
test("Pi unverifiable target fails before the payload and releases its lease", async () => {
  clearRecords(); control({});
  const result = await run({ targetCwd: path.join(scratch, "missing-target") });
  assert.equal(result.errorType, "external_runner_guard_unverifiable");
  assert.equal(records().length, 0);
  await assertNoProviderLeases();
});
test("Pi resource and preload environment overrides are stripped even when allowlisted", () => {
  const env = internals.buildRunnerEnv("pi", { PATH: process.env.PATH, PI_PACKAGE_DIR: "fixture-path", NODE_OPTIONS: "--require=fixture",
    CODEX_OPENCODE_PASSTHROUGH_ENV: "PI_PACKAGE_DIR,NODE_OPTIONS", CODEX_OPENCODE_ALLOW_SENSITIVE_ENV: "true" });
  assert.equal(env.PI_PACKAGE_DIR, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});
test("Pi malformed/incomplete/error/nonzero/mismatched streams fail meaningfully", async () => {
  for (const [mode, error] of [["malformed", "pi_stream_malformed"], ["incomplete", "pi_stream_incomplete"],
    ["error", "pi_execution_error"], ["nonzero", "agent_exit_nonzero"], ["mismatch", "pi_model_mismatch"]]) {
    control({ mode }); const result = await run();
    assert.equal(result.errorType, error, JSON.stringify(result));
    assert.ok(result.runnerSidecarDir);
    if (mode === "error") assert.match(result.stderr, /authentication rejected/);
  }
});
test("Pi target-checkout escape is detected and pauses Pi without reverting", async () => {
  const targetFile = path.join(repo, "src/b.txt");
  control({ targetFile });
  try {
    const result = await run();
    assert.equal(result.errorType, "external_runner_wrote_outside_worktree");
    assert.ok(result.providerCooldownUntil);
    assert.equal(readFileSync(targetFile, "utf8"), "outside worktree\n");
  } finally { await git(["checkout", "--", "src/b.txt"]); await internals.resumeProvider({ provider: "pi" }); }
});
test("Pi structured quota failures reuse bridge pauses, and cancelled-before-start never launches", async () => {
  control({ mode: "error", error: "Usage limit exceeded. Try again in 2 hours." });
  try {
    const result = await run();
    assert.equal(result.errorType, "provider_rate_limited");
    assert.ok(result.providerCooldownUntil);
  } finally { await internals.resumeProvider({ provider: "pi" }); }
  clearRecords();
  const signal = AbortSignal.abort();
  assert.equal((await run({ signal })).errorType, "agent_cancelled");
  assert.equal(records().length, 0);
});
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const assertCleanupEvidence = result => {
  if (process.platform === "win32") {
    assert.equal(result.treeTerminationConfirmed, false, "Windows cleanup must not claim guaranteed containment");
    assert.equal(result.containmentGuarantee, "windows_taskkill_best_effort");
    assert.equal(result.terminationBestEffortSucceeded, true);
  } else assert.equal(result.treeTerminationConfirmed, true);
};
test("Pi cancellation terminates the worker and descendant and releases the provider lease", async () => {
  clearRecords(); control({ mode: "sleep" });
  const abort = new AbortController();
  const pending = run({ signal: abort.signal });
  assert.equal(await waitFor(() => existsSync(path.join(scratch, "descendant.pid")), 15000), true);
  const child = Number(readFileSync(path.join(scratch, "descendant.pid"), "utf8"));
  const worker = records().at(-1).pid;
  abort.abort(); const result = await pending;
  assert.equal(result.errorType, "agent_cancelled", JSON.stringify(result));
  assertCleanupEvidence(result);
  assert.equal(alive(worker), false); assert.equal(alive(child), false);
  await assertNoProviderLeases();
  rmSync(path.join(scratch, "descendant.pid"));
});
test("Pi timeout terminates the process tree and reports agent_timeout", async () => {
  clearRecords(); control({ mode: "sleep", emitError: true });
  const result = await run({ timeoutMs: 2000 });
  assert.equal(result.errorType, "agent_timeout", JSON.stringify(result));
  assert.equal(result.timedOut, true); assertCleanupEvidence(result);
  assert.equal(alive(records().at(-1).pid), false);
  assert.equal(alive(Number(readFileSync(path.join(scratch, "descendant.pid"), "utf8"))), false);
  await assertNoProviderLeases();
});
test("Pi status exposes the unsandboxed safety mode and executable pin", () => {
  assert.ok(internals.externalRunnerStatusLines().some(line => /Pi safety: unsandboxed-worktree; no built-in sandbox/.test(line)));
});

await runFlexTests({ file: "tests/review-pi-runner.js", tests, finishSkips, label: "Pi runner", cleanup: async () => {
  await fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  rmSync(isolation.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
} });
