#!/usr/bin/env node

// Real scratch provider/queue SQLite, encrypted requests and Git worktrees. Only agent
// discovery/metadata/payload are fixtures; the advisory executor ordering uses DI counters.
import "./test-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createExecuteJobRuntime } from "../lib/execute-job.js";
import { createOrchestratorPolicyRuntime } from "../lib/orchestrator-policy.js";
import { createQueueSchedulerRuntime } from "../lib/queue/scheduler.js";
import { isolateBridgeStateDir, makeFlexFixture, runFlexTests } from "./flex-fixture.js";
import { finishSkips } from "./skip-gate.js";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const isolatedStateDir = isolateBridgeStateDir("pause-precheck");
Object.assign(process.env, {
  CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_WORKTREE_CLEANUP: "never",
  CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
  CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS: "100", CODEX_OPENCODE_GLOBAL_WORKER_LIMIT: "0",
  CODEX_OPENCODE_QUOTA_GROUPS: "fixture:google,openai",
});
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals, hooks = __selfTest.hooks;
const { assert, path } = I;
const { hasWriteIntent } = createOrchestratorPolicyRuntime(I);
const fixture = await makeFlexFixture(__selfTest, "pause-precheck");
const { repo, stateDir, readJob, writeJob, durable, waitFor, sleep } = fixture;
const A = { provider: "google", model: "fixture-a", variant: "high" };
const B = { provider: "openai", model: "fixture-b", variant: "high" };
const spec = (model) => `${model.provider}/${model.model}@${model.variant}`;
hooks.selfTestModelOverrideAllowlist = [spec(A), spec(B)];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
async function db(fn) { const handle = await I.openProviderLeaseDb(); try { return fn(handle); } finally { I.closeDb(handle); } }
async function reset() {
  hooks.queueJobExecutorTestHook = null;
  hooks.agentRuntimeTestHook = null;
  hooks.stateDirectoryOverride = stateDir;
  hooks.queueModeOverride = "sqlite";
  await db(handle => handle.exec("DELETE FROM provider_cooldowns; DELETE FROM provider_pause_strikes;"));
}
async function pause(key, errorType = "provider_paused", durationMs = 60_000) {
  const result = await I.recordProviderCooldown({ providerKey: key, errorType, durationMs, reason: "pause pre-check fixture" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return new Date(result.untilAt).toISOString();
}
const pinnedWrite = (pin = A, extra = {}) => {
  const job = writeJob();
  return { ...job, scopeContract: { ...job.scopeContract, modelRequirement: pin }, ...extra };
};

function orderingProbe(snapshot = I.providerCapacitySnapshot) {
  const calls = { pauseRead: 0, readiness: 0, validationPreflight: 0, discovery: 0, metadata: 0,
    payload: 0, worktree: 0, snapshot: 0, patch: 0, lock: 0 };
  const forbidden = (name) => async () => { calls[name]++; throw new Error(`unexpected ${name}`); };
  const runtime = createExecuteJobRuntime({
    ...I, nowMs: () => Date.now(),
    makeQueueJobId: (agent) => `${agent}-pause-ordering-probe`, hasWriteIntent,
    providerCapacitySnapshot: async () => { calls.pauseRead++; return snapshot(); },
    verifyJobWorkspaceReadiness: async () => { calls.readiness++; return { ok: false, errorType: "fixture_workspace_probe", error: "ordering probe reached normal preflight" }; },
    validationCommandPreflightError: (...args) => { calls.validationPreflight++; return I.validationCommandPreflightError(...args); },
    createWorktreeForJob: forbidden("worktree"), gitChangedFileSnapshot: forbidden("snapshot"),
    collectWorktreeDiff: forbidden("patch"), acquireHardLock: forbidden("lock"),
    jobAgentRuntime: () => ({ resolveAgent: forbidden("discovery"), readAgentDebugMetadata: forbidden("metadata"), runOpenCodeWithPolicy: forbidden("payload") }),
  });
  return { calls, runtime };
}

test("a pinned provider, model or quota pause refuses before every setup operation with the same slot error", async () => {
  const own = I.providerKeyForMetadata(A), model = I.modelPauseKeyForMetadata(A);
  const quota = I.quotaGroupProviderKeys(A.provider).find(key => key !== own);
  assert.ok(quota, "the fixture has an independent quota-group member");
  for (const [key, errorType] of [[own, "provider_paused"], [model, "provider_rate_limited"], [quota, "opencode_quota_exhausted"]]) {
    await reset();
    const until = await pause(key, errorType);
    const probe = orderingProbe();
    const execution = await probe.runtime.executeOpenCodeJob(pinnedWrite());
    assert.equal(execution.result.exitCode, "provider_capacity_unavailable");
    assert.equal(execution.result.errorType, errorType);
    assert.equal(execution.result.providerCooldownUntil, until);
    assert.equal(execution.result.agentNeverStarted, true);
    assert.equal(execution.result.agentTimeoutSpentMs, 0);
    assert.equal(execution.result.providerConcurrencyWaitMs, 0);
    assert.deepEqual(execution.result.changedFiles, []);
    assert.deepEqual([execution.result.configuredProvider, execution.result.configuredModel, execution.result.configuredVariant], [A.provider, A.model, A.variant]);
    const text = fixture.textOf(execution.response);
    for (const evidence of [/^runId: builder-pause-ordering-probe$/m, /^Files changed: none detected$/m,
      /^Unsafe changed files: none detected$/m, /^scope: .*"mode":"write"/m, /^lockMode: simple$/m,
      /^lockedPaths: src$/m, /^allowedEdits: src\/a\.txt$/m, /^Temporary locks were not acquired\.$/m]) assert.match(text, evidence);
    assert.match(text, new RegExp(`^errorType: ${errorType}$`, "m"));
    assert.deepEqual(probe.calls, { pauseRead: 1, readiness: 0, validationPreflight: 0, discovery: 0, metadata: 0, payload: 0, worktree: 0, snapshot: 0, patch: 0, lock: 0 });
    assert.equal(execution.worktree, undefined);
    const slot = await I.acquireProviderLease({ providerKey: own, pauseKeys: [model, ...I.quotaGroupProviderKeys(A.provider)], timeoutMs: 500 });
    assert.equal(slot.ok, false, JSON.stringify(slot));
    assert.equal(slot.errorType, execution.result.errorType);
    assert.equal(slot.cooldownUntil, until);
    assert.equal((await I.providerCapacitySnapshot()).allLeaseCount, 0, "a pause refusal takes no provider slot");
    assert.deepEqual(await I.listRetainedWorktreeArtifacts(repo), []);
  }
});

test("the longest matching pause wins and an expired pause returns to normal preflight", async () => {
  await reset();
  await pause(I.providerKeyForMetadata(A), "provider_paused", 30_000);
  const until = await pause(I.modelPauseKeyForMetadata(A), "provider_rate_limited", 60_000);
  assert.equal((await I.pinnedProviderPause(pinnedWrite())).cooldownUntil, until);
  await db(handle => handle.prepare("UPDATE provider_cooldowns SET until_at=?").run(Date.now() - 1));
  const probe = orderingProbe();
  assert.equal((await probe.runtime.executeOpenCodeJob(pinnedWrite())).result.errorType, "fixture_workspace_probe");
  assert.equal(probe.calls.readiness, 1);
});

test("dry-run, unpinned Muse roles and unallowlisted pins do not bypass normal validation", async () => {
  await reset();
  await pause(I.providerKeyForMetadata(A));
  for (const job of [pinnedWrite(A, { dryRun: true }), writeJob(), { ...readJob(), agent: "tester" }, pinnedWrite({ provider: "google", model: "unknown" })]) {
    const probe = orderingProbe();
    assert.equal((await probe.runtime.executeOpenCodeJob(job)).result.errorType, "fixture_workspace_probe");
    assert.equal(probe.calls.pauseRead, 0);
    assert.equal(probe.calls.readiness, 1);
  }
  const malformed = pinnedWrite({ provider: "--bad", model: "fixture-a" });
  const schema = I.server._registeredTools.run_opencode_agent.inputSchema;
  assert.equal(schema.safeParse(pinnedWrite()).success, true);
  const rejected = schema.safeParse(malformed);
  assert.equal(rejected.success, false);
  assert.ok(rejected.error.issues.some(issue => issue.path.join(".") === "scopeContract.modelRequirement.provider" && issue.code === "invalid_format"));
  // Private handlers bypass MCP schema parsing; the executor's normalizer still rejects before a pause read.
  const malformedProbe = orderingProbe();
  await assert.rejects(() => malformedProbe.runtime.executeOpenCodeJob(malformed), error => error.name === "ZodError"
    && error.issues.some(issue => issue.path.at(-1) === "provider" && issue.code === "invalid_format"));
  assert.equal(malformedProbe.calls.pauseRead, 0);
  const invalidScope = pinnedWrite(A, { allowedEdits: [".env"], lockedPaths: [".env"] });
  const probe = orderingProbe();
  assert.notEqual((await probe.runtime.executeOpenCodeJob(invalidScope)).result.errorType, "provider_paused");
  assert.equal(probe.calls.pauseRead, 0, "cheap scope validation rejects before advisory pause lookup");
});

test("a thrown or unreadable private provider database fails open to normal preflight", async () => {
  await reset();
  const thrown = orderingProbe(async () => { throw new Error("fixture snapshot unavailable"); });
  assert.equal((await thrown.runtime.executeOpenCodeJob(pinnedWrite())).result.errorType, "fixture_workspace_probe");
  assert.equal(thrown.calls.readiness, 1);
  const badState = path.join(fixture.root, "invalid-provider-db");
  await mkdir(badState);
  await writeFile(path.join(badState, "provider-concurrency.sqlite"), "not a SQLite database");
  hooks.stateDirectoryOverride = badState;
  try {
    assert.equal((await I.providerCapacitySnapshot()).ok, false);
    const probe = orderingProbe();
    assert.equal((await probe.runtime.executeOpenCodeJob(pinnedWrite())).result.errorType, "fixture_workspace_probe");
    assert.equal(probe.calls.pauseRead, 1);
    assert.equal(probe.calls.readiness, 1);
  } finally { hooks.stateDirectoryOverride = stateDir; }
});

function installRuntime() {
  const calls = { executions: [], discovery: 0, metadata: 0, payload: 0 };
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (agent) => { calls.discovery++; return { requestedAgent: agent, actualAgent: agent, requestedAgentMode: "primary", actualAgentMode: "primary", fallbackUsed: false, proxyUsed: false, availableAgents: [agent], discoveryExitCode: 0 }; },
    readAgentDebugMetadata: async (agent) => { calls.metadata++; return { ok: true, metadata: { name: agent, mode: "primary", ...A, canEdit: ["builder", "debugger"].includes(agent), canDelegate: false, externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: "fixture-permissions" } }; },
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan) => {
      calls.payload++;
      const requirement = lockPlan.scopeContract?.modelRequirement || A;
      if (agent === "builder") await writeFile(path.join(cwd, "src", "a.txt"), "pause lifted; worker ran\n");
      return { exitCode: 0, errorType: null, stdout: "Completed after pause.\n", stderr: "", durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, configuredProvider: requirement.provider, configuredModel: requirement.model,
        configuredVariant: requirement.variant, usage: { steps: 1, inputCount: 5, outputCount: 5 }, childExecutionIntervals: [] };
    },
  };
  hooks.queueJobExecutorTestHook = async (request, options) => {
    const before = { discovery: calls.discovery, metadata: calls.metadata, payload: calls.payload };
    const execution = await I.executeOpenCodeJob(request, options);
    calls.executions.push({ request, execution, before, after: { discovery: calls.discovery, metadata: calls.metadata, payload: calls.payload } });
    return execution;
  };
  return calls;
}
async function assertHeld(jobId, pin, calls) {
  assert.ok(await waitFor(async () => (await durable(jobId))?.startAfterReason === "provider_pause"));
  const held = await durable(jobId);
  assert.equal(held.status, "pending");
  assert.equal(held.startedAt, "");
  assert.equal(held.worktreePath, "");
  assert.equal(held.retryAttempt, 1);
  assert.equal(held.pauseWaitRequeues || 0, 0);
  assert.equal(held.requeuedAs || "", "");
  assert.deepEqual(held.scopeContract.modelRequirement, pin, "the held request's pin is unchanged");
  assert.deepEqual([calls.executions.length, calls.discovery, calls.metadata, calls.payload], [0, 0, 0, 0]);
  assert.deepEqual(await I.listRetainedWorktreeArtifacts(repo), []);
  await sleep(300);
  const polled = await durable(jobId);
  assert.equal(polled.revision, held.revision, "blocked polls do not rewrite the same hold");
  assert.equal(polled.retryAttempt, 1);
  return polled;
}
async function completed(jobId) {
  assert.ok(await waitFor(async () => fixture.terminal((await durable(jobId))?.status), 15_000));
  const result = await durable(jobId);
  assert.equal(result.status, "completed", JSON.stringify({ errorType: result.errorType, reason: result.errorReason }));
  return result;
}

test("a pause after enqueue holds every candidate without claim or attempt; resume runs the same writer", async () => {
  await reset(); const calls = installRuntime();
  const input = pinnedWrite(A, { models: [spec(A), spec(B)], maxAttempts: 1 });
  const enqueued = await I.enqueueQueueJob(input, "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  assert.equal(enqueued.record.startAfterReason || "", "", "the provider was free at enqueue");
  await pause(I.modelPauseKeyForMetadata(A));
  const later = await pause(I.modelPauseKeyForMetadata(B), "provider_paused", 90_000);
  I.scheduleQueue();
  const held = await assertHeld(enqueued.record.jobId, A, calls);
  assert.ok(Date.parse(held.startAfter) < Date.parse(later), "the scheduler selects the first candidate pause to end");
  assert.equal((await I.resumeProvider({ provider: `${A.provider}/${A.model}` })).ok, true);
  const ran = await completed(enqueued.record.jobId);
  assert.equal(ran.retryAttempt, 1);
  assert.equal(ran.pauseWaitRequeues || 0, 0);
  assert.equal(calls.executions.length, 1);
  assert.equal(calls.payload, 1);
  assert.deepEqual(ran.changedFiles, ["src/a.txt"]);
  for (const worktree of await I.listRetainedWorktreeArtifacts(repo)) await I.cleanupWorktree({ path: worktree.worktreePath, branch: worktree.branch, repoRoot: repo }, "always", true);
});

test("an expired pause releases the existing held row with its first attempt intact", async () => {
  await reset(); const calls = installRuntime();
  const enqueued = await I.enqueueQueueJob(readJob({ models: [spec(A)], maxAttempts: 1 }), "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  await pause(I.modelPauseKeyForMetadata(A)); I.scheduleQueue();
  await assertHeld(enqueued.record.jobId, A, calls);
  await db(handle => handle.prepare("UPDATE provider_cooldowns SET until_at=? WHERE provider_key=?").run(Date.now() - 1, I.modelPauseKeyForMetadata(A)));
  I.scheduleQueue();
  const ran = await completed(enqueued.record.jobId);
  assert.equal(ran.retryAttempt, 1);
  assert.equal(ran.requeuedAs || "", "");
  assert.equal(calls.payload, 1);
});

test("one unpaused fallback avoids a hold; the fast pin refusal is uncounted and the chooser runs B", async () => {
  await reset(); const calls = installRuntime();
  const enqueued = await I.enqueueQueueJob(readJob({ models: [spec(A), spec(B)], maxAttempts: 1 }), "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  const until = await pause(I.modelPauseKeyForMetadata(A)); I.scheduleQueue();
  assert.ok(await waitFor(async () => Boolean((await durable(enqueued.record.jobId))?.requeuedAs), 15_000));
  const refused = await durable(enqueued.record.jobId);
  assert.equal(refused.status, "failed");
  assert.equal(refused.startAfterReason || "", "", "a free policy model keeps the job startable");
  assert.equal(refused.providerRefusedUntil, until);
  assert.equal(calls.executions[0].execution.result.agentNeverStarted, true);
  assert.deepEqual(calls.executions[0].before, calls.executions[0].after, "the fast refused model does not discover, attest or spawn");
  const ran = await completed(refused.requeuedAs);
  assert.equal(ran.retryAttempt, 1, "the paused-model refusal consumed no attempt");
  assert.equal(ran.pauseWaitRequeues, 1, "the same slot-refusal wait accounting is retained");
  assert.deepEqual(ran.scopeContract.modelRequirement, B);
  assert.match(ran.attemptHistory[0], /provider_paused \(not counted:/);
  assert.equal(calls.executions.length, 2);
  assert.equal(calls.payload, 1);
});

test("a queued unallowlisted pin reaches model validation; an accepted standalone pin still waits", async () => {
  await reset(); let calls = installRuntime();
  await pause(I.providerKeyForMetadata(A));
  const unknown = { ...A, model: "not-allowlisted" };
  const invalid = await I.enqueueQueueJob(readJob({ scopeContract: { mode: "read", read: ["src/a.txt"], modelRequirement: unknown } }), "", { schedule: false });
  assert.equal(invalid.ok, true, invalid.error);
  I.scheduleQueue();
  assert.ok(await waitFor(async () => fixture.terminal((await durable(invalid.record.jobId))?.status), 15_000));
  const refused = await durable(invalid.record.jobId);
  assert.equal(refused.status, "failed");
  assert.equal(refused.errorType, "configured_model_requirement_mismatch");
  assert.equal(refused.startAfterReason || "", "");
  assert.equal(calls.payload, 0);
  calls = installRuntime();
  const valid = await I.enqueueQueueJob(readJob({ scopeContract: { mode: "read", read: ["src/a.txt"], modelRequirement: A } }), "", { schedule: false });
  assert.equal(valid.ok, true, valid.error);
  I.scheduleQueue();
  assert.ok(await waitFor(async () => (await durable(valid.record.jobId))?.startAfterReason === "provider_pause"));
  assert.equal((await durable(valid.record.jobId)).startedAt, "");
  assert.equal(calls.executions.length, 0);
  assert.equal((await I.resumeProvider({ provider: A.provider })).ok, true);
  await completed(valid.record.jobId);
  assert.equal(calls.payload, 1);
});

function schedulerProbe(records, pauses) {
  const jobs = new Map(records.map(record => [record.jobId, record]));
  const counts = { reads: 0, writes: 0, starts: [] };
  const update = async (record, patch) => { counts.writes++; Object.assign(record, patch); return { persisted: true }; };
  const runtime = createQueueSchedulerRuntime({
    ...I, CONFIG: { ...I.CONFIG, queueParallelLimit: 10 }, QUEUE_JOBS: jobs,
    INTEGRATION_RECOVERY_BLOCKED_ROOTS: new Set(), effectiveQueueMode: () => "sqlite",
    effectiveQueueWriteConflictPolicy: () => "wait", findQueueWriteConflict: async () => null,
    activeProviderPauses: async () => { counts.reads++; return pauses(); },
    holdQueueForMemory: () => {}, releaseQueueMemoryHold: () => {}, queueMemoryGate: () => ({ blocked: false }),
    logEvent: () => {}, nextQueueScheduleDelay: () => null, queueDrainRequested: () => false,
    queueRecordOwnedElsewhere: () => false, refreshRuntimeConcurrency: async () => {}, runningQueueRecords: () => [],
    updateQueueRecordDurable: update, updateQueueRecordDurableReacquiringLease: update,
    startQueueRecord: async (record) => { counts.starts.push(record.jobId); record.status = "running"; return true; },
  });
  return { runtime, counts, jobs };
}
const scheduledRecord = (jobId, pin, extra = {}) => ({ jobId, cwd: repo, status: "pending", mode: "read",
  request: readJob({ scopeContract: { mode: "read", read: ["src/a.txt"], modelRequirement: pin } }), ...extra });

test("B-212: sanitized direct and queued paused pins reach the routed reader's model policy error", async () => {
  await reset();
  await pause(I.providerKeyForMetadata(A));
  const root = path.join(fixture.root, "sanitized");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "allowed.txt"), "sanitized\n");
  const manifestPath = path.join(fixture.root, "sanitized-manifest.json");
  const manifest = JSON.stringify({ version: 1, directories: [], files: { "allowed.txt": await I.sha256File(path.join(root, "allowed.txt")) } });
  await writeFile(manifestPath, manifest);
  const request = readJob({ cwd: root, subagentStrategy: "reject",
    scopeContract: { mode: "read", read: ["allowed.txt"], modelRequirement: A },
    sanitizedWorkspace: { root, manifestPath, manifestSha256: I.createHash("sha256").update(manifest).digest("hex"), requiredFiles: ["allowed.txt"] } });
  const calls = installRuntime();
  const reader = I.MCP_SANITIZED_READER_AGENT;
  hooks.agentRuntimeTestHook.resolveAgent = async agent => ({ requestedAgent: agent, actualAgent: reader,
    requestedAgentMode: "primary", actualAgentMode: "primary", fallbackUsed: false, proxyUsed: false, availableAgents: [reader], discoveryExitCode: 0 });
  const metadata = hooks.agentRuntimeTestHook.readAgentDebugMetadata;
  hooks.agentRuntimeTestHook.readAgentDebugMetadata = async agent => {
    const result = await metadata(agent);
    return { ...result, metadata: { ...result.metadata, ...B } };
  };
  assert.equal(await I.pinnedProviderPause(request), null);
  const direct = await I.executeOpenCodeJob(request);
  assert.equal(direct.result.errorType, "configured_model_requirement_mismatch");
  assert.equal(direct.resolution.actualAgent, reader);
  const enqueued = await I.enqueueQueueJob(request, "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  I.scheduleQueue();
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => fixture.terminal((await I.readPersistedQueueRecord(jobId, root))?.status), 15_000));
  const queued = await I.readPersistedQueueRecord(jobId, root);
  assert.equal(queued.errorType, "configured_model_requirement_mismatch");
  assert.equal(queued.startAfterReason || "", "");
  assert.equal(queued.pauseWaitRequeues || 0, 0);
  assert.equal(calls.payload, 0);
  // Also prove a models list cannot bypass the scheduler's sanitized guard.
  const record = scheduledRecord("sanitized-models", A, { request: { ...request, models: [spec(A)] } });
  const scheduler = schedulerProbe([record], I.activeProviderPauses);
  scheduler.runtime.scheduleQueue();
  assert.ok(await waitFor(() => scheduler.counts.starts.length === 1));
  assert.equal(scheduler.counts.reads, 0);
});

test("one scheduler pause read serves existing waits and multiple fresh holds; DB errors preserve known holds but permit fresh jobs", async () => {
  await reset();
  const until = await pause(I.modelPauseKeyForMetadata(A)); await pause(I.modelPauseKeyForMetadata(B));
  const records = () => [scheduledRecord("existing", A, { startAfter: until, startAfterReason: "provider_pause" }), scheduledRecord("fresh-a", A), scheduledRecord("fresh-b", B)];
  const shared = schedulerProbe(records(), I.activeProviderPauses);
  shared.runtime.scheduleQueue();
  assert.ok(await waitFor(() => shared.counts.writes === 2));
  await sleep(25);
  assert.equal(shared.counts.reads, 1);
  assert.deepEqual(shared.counts.starts, []);
  assert.equal(shared.jobs.get("existing").startAfter, until);
  for (const id of ["fresh-a", "fresh-b"]) assert.equal(shared.jobs.get(id).startAfterReason, "provider_pause");
  const failure = schedulerProbe(records().slice(0, 2), async () => { throw new Error("fixture provider DB read failed"); });
  failure.runtime.scheduleQueue();
  assert.ok(await waitFor(() => failure.counts.starts.length === 1));
  assert.equal(failure.counts.reads, 1);
  assert.deepEqual(failure.counts.starts, ["fresh-a"]);
  assert.equal(failure.jobs.get("existing").startAfter, until);
  assert.equal(failure.jobs.get("existing").status, "pending");
});

await runFlexTests({ isolatedStateDir, file: "tests/review-pause-precheck.js", tests, finishSkips, label: "pause pre-check",
  cleanup: async () => { hooks.selfTestModelOverrideAllowlist = null; await fixture.cleanup(); } });
