#!/usr/bin/env node

// Regression tests for the maturity-measurement findings B-020..B-026 (log.md, 2026-09-29).
// Agent discovery and the OpenCode run are replaced by the self-test agentRuntimeTestHook, as in
// tests/review-tools-pipelines.js; Git, locks, the worktree registry and SQLite state are real.
//   node tests/review-measurement.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { existsSync } from "node:fs";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  assert,
  cleanupWorktree,
  compactQueueJobLines,
  createPhaseClock,
  createWorktreeForJob,
  directRunAuditStore,
  formatIntegrationTimings,
  formatOpenCodeUsage,
  formatPhaseTimings,
  formatSingleResult,
  inspectOpenCodeEventStream,
  integratePatchSerially,
  integrationTimingStorage,
  listRetainedWorktreeArtifacts,
  mkdir,
  mkdtemp,
  path,
  queueAgentTiming,
  readFile,
  rm,
  runCommand,
  server,
  tmpdir,
  writeFile,
} = __selfTest.internals;

const stateDir = await mkdtemp(path.join(tmpdir(), "review-measure-state-"));
const repo = await mkdtemp(path.join(tmpdir(), "review-measure-repo-"));
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";

const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repo) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
await git(["init", "-q"]);
await git(["config", "core.autocrlf", "false"]);
await mkdir(path.join(repo, "src"), { recursive: true });
await writeFile(path.join(repo, "src", "a.txt"), "a\n", "utf8");
await writeFile(path.join(repo, "src", "b.txt"), "b\n", "utf8");
await git(["add", "."]);
await git([...gitIdentity, "commit", "-q", "-m", "init"]);

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "" });
const USAGE = { steps: 2, inputCount: 1200, outputCount: 80, reasoningCount: 30, cacheReadCount: 5, cacheWriteCount: 0, cost: 0, rootSteps: 2 };

function metadataFor(agent) {
  return { ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: agent === "builder" || agent === "debugger", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
  } };
}

function installRuntime({ onRun = async () => {} } = {}) {
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => metadataFor(agent),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan) => {
      const childStartedAtMs = Date.now();
      if (!dryRun) await onRun({ agent, cwd, lockPlan });
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1,
        usage: USAGE, providerRetryWarningCount: 1, providerConcurrencyWaitMs: 7,
        runPhaseTimings: { preSlotMs: 1, providerWaitMs: 7, finalAttestationMs: 2, spawnGateMs: 0, afterExitMs: 0 },
      };
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------- B-023
test("B-023: OpenCode's AI_APICallError rate-limit lines count as a recovered provider warning", async () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_root", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", sessionID: "ses_root", part: { id: "p1", messageID: "m1", type: "text", text: "All done.", time: { end: 1 } } }),
  ].join("\n");
  const stderr = [
    'ERROR 2026-09-29T13:40:01 +2ms service=session error.error="AI_APICallError: Rate limit exceeded. Please retry after a brief wait." stream error',
    'ERROR 2026-09-29T13:40:09 +1ms service=session error.error="AI_APICallError: Output token rate limit exceeded. Please retry after a brief wait." stream error',
  ].join("\n");
  const inspection = inspectOpenCodeEventStream(stdout, stderr);
  assert.equal(inspection.finalResponseDetected, true);
  assert.equal(inspection.apiErrorDetected, false, "a run that produced its answer is not failed by retried attempts");
  assert.equal(inspection.recoveredTransientProviderError, true);
  assert.equal(inspection.providerWarningType, "opencode_rate_limited");
  assert.equal(inspection.providerRetryWarningCount, 2);

  const failed = inspectOpenCodeEventStream(stdout.split("\n")[0], stderr);
  assert.equal(failed.providerErrorType, "opencode_rate_limited", "without an answer the same lines are the failure cause");
  assert.equal(inspectOpenCodeEventStream(stdout, "").providerRetryWarningCount, 0);
});

// ---------------------------------------------------------------------------- B-022
test("B-022: step_finish token usage is summed and does not end the turn", async () => {
  const finish = (sessionID, input, output, cost = 0) => JSON.stringify({ type: "step_finish", sessionID, part: {
    type: "step-finish", reason: "stop", sessionID, tokens: { total: input + output, input, output, reasoning: 3, cache: { read: 2, write: 1 } }, cost,
  } });
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_root", part: { type: "step-start" } }),
    finish("ses_root", 1000, 10),
    finish("ses_child", 500, 5, 0.25),
    JSON.stringify({ type: "text", sessionID: "ses_root", part: { id: "p1", messageID: "m1", type: "text", text: "Answer.", time: { end: 1 } } }),
    finish("ses_root", 2000, 20),
  ].join("\n");
  const inspection = inspectOpenCodeEventStream(stdout, "");
  assert.equal(inspection.finalResponseDetected, true, "step_finish after the final text must not hide the answer");
  assert.deepEqual(inspection.usage, { steps: 3, inputCount: 3500, outputCount: 35, reasoningCount: 9, cacheReadCount: 6, cacheWriteCount: 3, cost: 0.25, rootSteps: 2 });
  assert.match(formatOpenCodeUsage(inspection.usage), /^steps=3 input=3500 output=35 reasoning=9 cache_read=6 cache_write=3 cost=0\.25$/);
  assert.match(formatOpenCodeUsage({ ...USAGE }), /cost=0 \(provider reported no price\)/);
  assert.equal(formatOpenCodeUsage(null), "not emitted by OpenCode");
  const text = formatSingleResult({ resolution: { requestedAgent: "builder", actualAgent: "builder" }, result: { usage: inspection.usage, providerRetryWarningCount: 2 }, cwd: repo, lockPlan: null });
  assert.match(text, /Token usage: steps=3 input=3500/);
  assert.match(text, /Provider error lines in OpenCode stderr \(attempts OpenCode retried or failed\): 2/);
});

// ---------------------------------------------------------------------------- B-024 / B-025
test("B-024/B-025: the phase clock partitions the job and the queue reports the agent process alone", async () => {
  const clock = createPhaseClock();
  await new Promise((resolve) => setTimeout(resolve, 20));
  clock.mark("worktreeSetup");
  const childStartedAtMs = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const childFinishedAtMs = Date.now();
  clock.mark("openCodeRun");
  const timings = clock.summary({ childStartedAtMs, childFinishedAtMs, runPhaseTimings: { preSlotMs: 1, providerWaitMs: 2, finalAttestationMs: 3, spawnGateMs: 4, afterExitMs: 5 } });
  assert.ok(timings.phases.worktreeSetup >= 15, JSON.stringify(timings));
  assert.ok(timings.beforeAgentMs >= 15 && timings.agentProcessMs >= 25, JSON.stringify(timings));
  const sum = Object.values(timings.phases).reduce((total, ms) => total + ms, 0);
  assert.ok(Math.abs(sum - timings.totalMs) <= 5, `phases ${sum} vs total ${timings.totalMs}`);
  const text = formatPhaseTimings(timings);
  assert.match(text, /^Timing ms: total=\d+ before-agent=\d+ agent-process=\d+ after-agent=\d+/);
  assert.match(text, /worktreeSetup=\d+ \(git worktree add and checkpoint checks\)/);
  assert.match(text, /openCodeRun split: pre-slot=1 provider-slot-wait=2 final-attestation=3 spawn-to-agent=4 after-exit=5/);

  // Queue: claim at 0, supervisor at 10 s, agent process 60 s, finished at 100 s.
  const base = Date.parse("2026-09-29T10:00:00.000Z");
  const record = {
    jobId: "builder-1", agent: "builder", status: "completed",
    startedAt: new Date(base).toISOString(), agentStartedAt: new Date(base + 10000).toISOString(), finishedAt: new Date(base + 100000).toISOString(),
    durationMs: 100000, phaseTimings: { agentProcessMs: 60000 }, usage: USAGE, providerRetryWarningCount: 3,
  };
  assert.deepEqual(queueAgentTiming(record), { agentRunMs: 60000, waitBeforeAgentMs: 10000, afterAgentMs: 30000 });
  assert.deepEqual(queueAgentTiming({ ...record, phaseTimings: null }), { agentRunMs: 90000, waitBeforeAgentMs: 10000 }, "records written before the fix keep the old reading");
  const line = compactQueueJobLines([record]);
  assert.match(line, /waitBeforeAgentMs=10000 agentRunMs=60000 afterAgentMs=30000/);
  assert.match(line, /tokens=1200in\/80out cacheRead=5 providerErrorLines=3/);
});

// ---------------------------------------------------------------------------- B-018 / B-020 / B-021
test("B-018/B-020/B-021: parallel jobs are audited, their worktrees are in diagnose, get_opencode_job finds the Run id", async () => {
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "a.txt"), "parallel edit\n", "utf8") });
  const job = { agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "strict", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]) };
  // L-025: the phase timing split is bridge detail (tests/review-l025.js covers the compact default).
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [job], detail: true }));
  const runId = /JOB 1\nRun id: (\S+) \(get_opencode_job finds it/.exec(text)?.[1];
  assert.ok(runId, text);
  assert.match(text, new RegExp(`Direct run audit: ${runId}; terminal metadata persisted`));
  assert.match(text, /Token usage: steps=2 input=1200 output=80/);
  assert.match(text, /sharedSetup=\d+ \(locks, worktrees and attestation/);

  const audit = await directRunAuditStore().snapshot(repo);
  assert.ok(audit.coverage.includes.includes("parallel_jobs"));
  assert.ok(!audit.coverage.excludes.includes("parallel_runs"));
  const record = audit.records.find((item) => item.runId === runId);
  assert.equal(record?.kind, "parallel", JSON.stringify(audit.records));
  assert.equal(record.status, "completed");
  assert.equal(record.jobId, runId);
  assert.equal(record.inputCount, 1200);
  assert.equal(record.providerWaitMs, 7);
  assert.equal(record.providerRetryWarnings, 1);

  const report = JSON.parse(textOf(await callTool("diagnose_opencode_bridge", { cwd: repo })));
  const retained = report.retainedWorktrees.find((item) => item.jobId === runId);
  assert.ok(retained, JSON.stringify(report.retainedWorktrees));
  assert.equal(retained.owner, "parallel");
  assert.equal(retained.present, true);
  assert.match(retained.recoveryAction, /integrate_opencode_worktree/);
  assert.equal(report.summary.retainedWorktrees >= 1, true);
  const diagnosedRun = report.directRuns.find((item) => item.runId === runId);
  assert.equal(diagnosedRun?.inputCount, 1200, "usage survives the diagnose sanitizer");
  assert.match(report.diagnosticCoverage.retainedWorktrees, /parallel/);

  const lookup = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo })));
  assert.equal(lookup.kind, "parallel_run");
  assert.equal(lookup.status, "completed");
  assert.equal(lookup.usage.inputCount, 1200);
  assert.equal(lookup.worktrees[0].worktreePath, retained.worktreePath);
  assert.match(lookup.note, /run_opencode_parallel/);

  const missing = textOf(await callTool("get_opencode_job", { jobId: "builder-0-00000000", cwd: repo }));
  assert.match(missing, /OpenCode job not found: builder-0-00000000\. Neither the queue, the direct\/parallel run audit, nor the worktree registry/);

  await cleanupWorktree({ path: retained.worktreePath, branch: retained.branch, repoRoot: repo }, "always", true);
  assert.equal((await listRetainedWorktreeArtifacts(repo, { jobId: runId })).length, 0);
});

test("B-018: a parallel writer that edits outside its scope is a failed audit run, not completed", async () => {
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "b.txt"), "outside the lock\n", "utf8") });
  const job = { agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "strict", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]) };
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [job] }));
  const runId = /JOB 1\nRun id: (\S+) /.exec(text)?.[1];
  assert.ok(runId, text);
  const record = await directRunAuditStore().get(repo, runId);
  assert.equal(record.status, "failed", JSON.stringify(record));
  assert.equal(record.errorType, "changed_file_validation_error");
  const retained = await listRetainedWorktreeArtifacts(repo, { jobId: runId });
  for (const item of retained) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

test("B-020: a worktree whose job is still running is not offered for integration or removal", async () => {
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-inflight-1", lockedPaths: ["src"], allowedEdits: ["src"] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  const audit = directRunAuditStore();
  const handle = await audit.start({ agent: "builder", cwd: repo }, { runId: "builder-inflight-1", kind: "parallel", jobId: "builder-inflight-1" });
  let report = JSON.parse(textOf(await callTool("diagnose_opencode_bridge", { cwd: repo })));
  let view = report.retainedWorktrees.find((item) => item.jobId === "builder-inflight-1");
  assert.equal(view.inFlight, true, JSON.stringify(view));
  assert.match(view.recoveryAction, /^None yet: its job is still running/);
  assert.doesNotMatch(view.recoveryAction, /integrate_opencode_worktree \(dry run/);
  assert.ok(report.summary.inFlightWorktrees >= 1);
  await audit.finish(handle, { execution: { result: {} } });
  report = JSON.parse(textOf(await callTool("diagnose_opencode_bridge", { cwd: repo })));
  view = report.retainedWorktrees.find((item) => item.jobId === "builder-inflight-1");
  assert.equal(view.inFlight, false);
  assert.match(view.recoveryAction, /integrate_opencode_worktree/);
  await cleanupWorktree(worktree, "always", true);
});

test("B-024: retried attempts are not counted as post-agent work", async () => {
  const base = Date.parse("2026-09-29T10:00:00.000Z");
  // First attempt spawned at 5 s; the last attempt ran 30 s and ended at 90 s; the job ended at 100 s.
  const record = {
    status: "completed", startedAt: new Date(base).toISOString(), agentStartedAt: new Date(base + 5000).toISOString(),
    finishedAt: new Date(base + 100000).toISOString(), phaseTimings: { agentProcessMs: 30000, afterAgentMs: 10000 },
  };
  assert.deepEqual(queueAgentTiming(record), { agentRunMs: 30000, waitBeforeAgentMs: 5000, afterAgentMs: 10000 });
});

test("B-021: a direct run's audit id also names its worktree", async () => {
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "b.txt"), "direct edit\n", "utf8") });
  const text = textOf(await callTool("run_opencode_agent", {
    agent: "builder", task: "Edit src/b.txt.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src/b.txt"], allowedEdits: ["src/b.txt"], scopeContract: writeScope(["src/b.txt"]),
  }));
  const runId = /Direct run audit: (\S+); terminal metadata persisted/.exec(text)?.[1];
  assert.ok(runId, text);
  assert.match(text, /Timing ms: total=\d+/);
  assert.match(text, /worktreeSetup=\d+/);
  const lookup = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo })));
  assert.equal(lookup.kind, "direct_run");
  assert.equal(lookup.worktrees.length, 1, JSON.stringify(lookup));
  assert.ok(Number.isFinite(lookup.waitBeforeAgentMs), JSON.stringify(lookup));
  const worktree = lookup.worktrees[0];
  await cleanupWorktree({ path: worktree.worktreePath, branch: worktree.branch, repoRoot: repo }, "always", true);
});

// ---------------------------------------------------------------------------- B-028
test("B-028: a failed git worktree add does not leave its new branch behind", async () => {
  const blockedRepo = await mkdtemp(path.join(tmpdir(), "review-measure-blocked-"));
  try {
    await git(["init", "-q"], blockedRepo);
    await writeFile(path.join(blockedRepo, "a.txt"), "a\n", "utf8");
    await git(["add", "."], blockedRepo);
    await git([...gitIdentity, "commit", "-q", "-m", "init"], blockedRepo);
    // A regular file where git keeps worktree metadata: git creates the branch, then fails.
    await writeFile(path.join(blockedRepo, ".git", "worktrees"), "", "utf8");
    const result = await createWorktreeForJob({ cwd: blockedRepo, agent: "builder", jobId: "builder-blocked-1", lockedPaths: ["a.txt"], allowedEdits: ["a.txt"] });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.errorType, "worktree_create_failed", JSON.stringify(result));
    assert.equal(result.branchCleanup, "deleted", JSON.stringify(result));
    assert.equal((await git(["branch", "--list", "agent/*"], blockedRepo)).trim(), "");
  } finally {
    await rm(blockedRepo, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});

// ---------------------------------------------------------------------------- B-027
test("B-027: a file force-added on an ignored path fails the integration instead of being dropped", async () => {
  const ignoredRepo = await mkdtemp(path.join(tmpdir(), "review-measure-ignored-"));
  try {
    await git(["init", "-q"], ignoredRepo);
    await git(["config", "core.autocrlf", "false"], ignoredRepo);
    await writeFile(path.join(ignoredRepo, ".gitignore"), "*.log\n", "utf8");
    await writeFile(path.join(ignoredRepo, "a.txt"), "a\n", "utf8");
    // Tracked before the rule applied: an ignored path the base commit already has.
    await writeFile(path.join(ignoredRepo, "kept.log"), "base\n", "utf8");
    await git(["add", ".gitignore", "a.txt"], ignoredRepo);
    await git(["add", "-f", "kept.log"], ignoredRepo);
    await git([...gitIdentity, "commit", "-q", "-m", "init"], ignoredRepo);
    const edits = ["a.txt", "kept.log", "x.log"];

    // Control: editing the already-tracked ignored file is in the patch and passes.
    let worktree = await createWorktreeForJob({ cwd: ignoredRepo, agent: "builder", jobId: "builder-ignored-ok", lockedPaths: edits, allowedEdits: edits });
    assert.equal(worktree.ok, true, JSON.stringify(worktree));
    await writeFile(path.join(worktree.path, "kept.log"), "edited\n", "utf8");
    let preview = await integratePatchSerially({ cwd: ignoredRepo, worktreePath: worktree.path, allowedEdits: edits, validationCommand: "git diff --check", dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.changedFiles, ["kept.log"]);
    await cleanupWorktree(worktree, "always", true);

    // The defect: a new file force-added on an ignored path.
    worktree = await createWorktreeForJob({ cwd: ignoredRepo, agent: "builder", jobId: "builder-ignored-bad", lockedPaths: edits, allowedEdits: edits });
    assert.equal(worktree.ok, true, JSON.stringify(worktree));
    await writeFile(path.join(worktree.path, "a.txt"), "changed\n", "utf8");
    await writeFile(path.join(worktree.path, "x.log"), "agent output\n", "utf8");
    await git(["add", "-f", "x.log"], worktree.path);
    preview = await integratePatchSerially({ cwd: ignoredRepo, worktreePath: worktree.path, allowedEdits: edits, validationCommand: "git diff --check", dryRun: true });
    assert.equal(preview.ok, false, JSON.stringify(preview));
    assert.equal(preview.errorType, "integration_source_unrepresentable", JSON.stringify(preview));
    assert.deepEqual(preview.ignoredFiles, ["x.log"]);
    assert.match(preview.error, /git add -f/);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(path.join(worktree.path, "x.log")), true, "the source is retained");
    await cleanupWorktree(worktree, "always", true);
  } finally {
    await rm(ignoredRepo, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});

// ---------------------------------------------------------------------------- B-026
test("B-026/B-194: integration reports foreground reuse separately from deferred cleanup", async () => {
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-measure-1", lockedPaths: ["src"], allowedEdits: ["src"] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  await writeFile(path.join(worktree.path, "src", "a.txt"), "integrated\n", "utf8");
  const common = { cwd: repo, worktreePath: worktree.path, allowedEdits: ["src/a.txt"], validationCommand: "git diff --check", cleanupAfterSuccess: true };

  const previewTimings = {};
  const preview = await integrationTimingStorage.run(previewTimings, () => integratePatchSerially({ ...common, dryRun: true }));
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(previewTimings.targetState.count, 2, JSON.stringify(previewTimings));
  assert.equal(previewTimings.sourcePatch.count, 1, JSON.stringify(previewTimings));
  assert.equal(previewTimings.sourceProof.count, 2, JSON.stringify(previewTimings));

  const applyTimings = {};
  const applied = await integrationTimingStorage.run(applyTimings, () => integratePatchSerially({ ...common, reviewed: true, previewReceipt: preview.previewReceipt }));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.status, "applied");
  assert.equal(applied.sourceCleanup?.cleanup, "pending", JSON.stringify(applied.sourceCleanup));
  assert.equal(existsSync(worktree.path), true, "the apply replies before removing its source");
  // B-194: receipt check, final pre-apply and integrated target; no second patch
  // collection or source full-index capture. Cleanup has its own later checks.
  const foregroundTimings = structuredClone(applyTimings);
  assert.equal(foregroundTimings.targetState.count, 3, JSON.stringify(foregroundTimings));
  assert.equal(foregroundTimings.sourceProof.count, 1, JSON.stringify(foregroundTimings));
  assert.equal(foregroundTimings.sourcePatch?.count || 0, 0, JSON.stringify(foregroundTimings));
  assert.equal(foregroundTimings.freshIndexHash?.count || 0, 0, JSON.stringify(foregroundTimings));
  assert.equal(foregroundTimings.worktreeRemove?.count || 0, 0, JSON.stringify(foregroundTimings));
  assert.equal(foregroundTimings.validation.count, 1);
  assert.equal(applied.validationGate.status, "passed");
  assert.equal(await readFile(path.join(repo, "src", "a.txt"), "utf8"), "integrated\n");
  const text = formatIntegrationTimings({ totalMs: 10, phases: foregroundTimings });
  assert.match(text, /^Integration timing: total 10 ms\n/);
  assert.match(text, /targetState: \d+ ms over 3 call\(s\)/);
  assert.match(text, /sourceProof: \d+ ms over 1 call\(s\)/);
  assert.match(text, /seededIndexHash: \d+ ms over 3 call\(s\)/);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const artifacts = await listRetainedWorktreeArtifacts(repo);
    if (!existsSync(worktree.path) && !artifacts.some(row => row.worktreePath === worktree.path)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(existsSync(worktree.path), false, "deferred cleanup must finish within its bound");
  assert.equal((await git(["branch", "--list", worktree.branch])).trim(), "", "the source branch is removed too");
  assert.equal((await listRetainedWorktreeArtifacts(repo)).some(row => row.worktreePath === worktree.path), false);
  await git(["reset", "-q", "--hard", "HEAD"]);
});

test("B-026: the tool result carries the integration timing", async () => {
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-measure-2", lockedPaths: ["src"], allowedEdits: ["src"] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  await writeFile(path.join(worktree.path, "src", "b.txt"), "previewed\n", "utf8");
  const text = textOf(await callTool("integrate_opencode_worktree", { cwd: repo, worktreePath: worktree.path, allowedEdits: ["src/b.txt"], validationCommand: "git diff --check", dryRun: true, previewMode: "stat" }));
  assert.match(text, /Serial integration accepted\./, text);
  assert.match(text, /^Integration timing: total \d+ ms$/m, text);
  assert.match(text, /^ {2}targetState: \d+ ms over 2 call\(s\)/m, text);
  assert.match(text, /^ {2}sourcePatch: \d+ ms over 1 call\(s\)/m, text);
  assert.match(text, /^ {2}sourceProof: \d+ ms over 2 call\(s\)/m, text);
  await cleanupWorktree({ path: worktree.path, branch: worktree.branch, repoRoot: repo }, "always", true);
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    } finally {
      selfTestHooks.agentRuntimeTestHook = null;
    }
  }
} finally {
  for (const directory of [repo, stateDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} measurement regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} measurement regression tests passed.\n`);
process.exit(0);
