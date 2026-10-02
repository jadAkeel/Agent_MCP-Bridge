#!/usr/bin/env node

// Q-007 (log.md, 2026-10-02): model fallback. A queued job may give `models` (and `maxAttempts`);
// after a provider failure, an idle stop, a timeout or no output the bridge requeues it itself on
// the next model that is not paused, records the attempts, and marks the last one outcome=gave_up.
// The real scheduler, SQLite queue, encrypted requests and requeue run in a scratch state
// directory; only the agent execution is the queue executor test hook.
//   node tests/review-flex-fallback.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_OPS_LOG;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-fallback");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { hooks, internals } = __selfTest;
const { QUEUE_JOBS, assert, enqueueQueueJob, jobRetryPolicy, pauseProvider, path, queueOnlyOptionsError, resumeProvider, scheduleQueue } = internals;
const { existsSync, readFileSync } = await import("node:fs");

const MUSE = "opencode/muse-spark-1.3-contributor-free@high";
const GEMINI = "google/antigravity-gemini-3.8-flash@high";
const SOL = "openai/gpt-6.1-sol";
hooks.selfTestModelOverrideAllowlist = [MUSE, GEMINI, SOL];
const fixture = await makeFlexFixture(__selfTest, "review-flex-fallback");
const { repo, stateDir, waitFor, durable, execution, readJob, writeJob, callTool, textOf, sleep } = fixture;
const issues = () => { const file = path.join(stateDir, "logs", "issues.md"); return existsSync(file) ? readFileSync(file, "utf8") : ""; };

// The executor hook: what each model does, and every request it was given.
const calls = [];
function installExecutor(behaviour) {
  hooks.queueJobExecutorTestHook = async (request) => {
    const requirement = request.scopeContract?.modelRequirement || {};
    const model = requirement.model ? `${requirement.provider}/${requirement.model}` : "profile";
    calls.push({ task: request.task, model, variant: requirement.variant || "" });
    const outcome = typeof behaviour === "function" ? behaviour(model, request) : behaviour;
    return execution({ ...outcome, configuredProvider: requirement.provider || "", configuredModel: requirement.model || "" });
  };
}
const terminalOf = async (jobId) => (await waitFor(async () => fixture.terminal((await durable(jobId))?.status), 15_000)) && durable(jobId);
async function chain(firstJobId, timeoutMs = 20_000) {
  // Follows requeuedAs to the end of the chain once the last job is terminal and not requeued further.
  const deadline = Date.now() + timeoutMs;
  let current = firstJobId;
  const seen = [];
  while (Date.now() < deadline) {
    const record = await durable(current);
    if (!record) { await sleep(50); continue; }
    if (!seen.includes(current)) seen.push(current);
    if (record.requeuedAs) { current = record.requeuedAs; continue; }
    const settled = fixture.terminal(record.status) && (record.status === "completed" || record.completionOutcome === "gave_up" || record.errorType === "write_scope_violation" || record.status === "cancelled");
    if (settled) return { records: await Promise.all(seen.map(durable)), last: record };
    await sleep(50);
  }
  throw new Error(`the chain from ${firstJobId} did not settle: ${seen.join(" -> ")}`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-007: models and maxAttempts are validated at enqueue", async () => {
  const refuse = async (extra, errorType, pattern) => {
    const result = await enqueueQueueJob(readJob({ task: `refuse ${JSON.stringify(extra)}`, ...extra }));
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.errorType, errorType, JSON.stringify(extra));
    if (pattern) assert.match(result.error, pattern);
  };
  await refuse({ models: ["opencode/not-allowlisted"] }, "retry_policy_model_not_allowlisted", /not in CODEX_OPENCODE_MODEL_ALLOWLIST/);
  await refuse({ models: ["no-slash"] }, "retry_policy_invalid", /provider\/model\[@variant\] form/);
  await refuse({ models: [] }, "retry_policy_invalid");
  await refuse({ maxAttempts: 0 }, "retry_policy_invalid", /from 1 to 10/);
  await refuse({ maxAttempts: 11 }, "retry_policy_invalid");
  await refuse({ models: [MUSE], scopeContract: { mode: "read", read: ["src/a.txt"], modelRequirement: { provider: "openai", model: "gpt-6.1-sol" } } }, "retry_policy_invalid", /is not one of models/);
  const pipelineChild = await enqueueQueueJob(readJob({ models: [MUSE] }), "pipeline-parent-x");
  assert.equal(pipelineChild.errorType, "retry_policy_not_applicable");
  assert.equal(jobRetryPolicy({ agent: "reviewer" }).policy, null, "no policy without models or maxAttempts");
  assert.equal(jobRetryPolicy({ agent: "reviewer", models: [MUSE] }).policy.maxAttempts, 4, "4 attempts by default");
  assert.equal(jobRetryPolicy({ agent: "reviewer", maxAttempts: 2 }).policy.models.length, 0);
});

test("Q-007: the options are refused where nothing could honour them", async () => {
  assert.equal(queueOnlyOptionsError({}), null);
  const direct = textOf(await callTool("run_opencode_agent", readJob({ models: [MUSE], dryRun: true })));
  assert.match(direct, /errorType: queue_only_option/);
  assert.match(direct, /models is honoured by enqueue_opencode_job only/);
  const parallel = textOf(await callTool("run_opencode_parallel", { jobs: [readJob({ maxAttempts: 2, dryRun: true }), readJob({ task: "second", dryRun: true, scopeContract: { mode: "read", read: ["src/b.txt"] } })] }));
  assert.match(parallel, /queue_only_option/);
});

test("Q-007: a provider failure moves the job to the next model, and the attempts are recorded", async () => {
  calls.length = 0;
  installExecutor((model) => (model === "opencode/muse-spark-1.3-contributor-free" ? { errorType: "provider_rate_limited" } : {}));
  const first = await enqueueQueueJob(readJob({ task: "fallback to the next model", models: [MUSE, GEMINI] }));
  assert.equal(first.ok, true, first.error);
  assert.equal(first.record.scopeContract.modelRequirement.model, "muse-spark-1.3-contributor-free", "the first model is pinned at enqueue");
  const { records, last } = await chain(first.record.jobId);
  assert.equal(records.length, 2);
  assert.deepEqual(calls.filter((call) => call.task === "fallback to the next model").map((call) => `${call.model}@${call.variant}`), [
    "opencode/muse-spark-1.3-contributor-free@high",
    "google/antigravity-gemini-3.8-flash@high",
  ]);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].errorType, "provider_rate_limited");
  assert.equal(records[0].retryAttempt, 1);
  assert.equal(last.status, "completed");
  assert.equal(last.requeuedFrom, first.record.jobId);
  assert.equal(last.retryAttempt, 2);
  assert.equal(last.maxAttempts, 4);
  assert.match(last.attemptHistory[0], new RegExp(`^${first.record.jobId} opencode/muse-spark-1\\.3-contributor-free provider_rate_limited$`));
  const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 50 }));
  assert.match(list, new RegExp(`${last.jobId} .*requeuedFrom=${first.record.jobId} attempt=2/4 model=google/antigravity-gemini-3\\.8-flash .*status=completed`));
  assert.ok(await waitFor(() => issues().includes("queue.job_retried")), "the retry is in the issue log");
  assert.match(issues(), /\| queue\.job_retried \| provider_rate_limited \| job \S+ reviewer on google\/antigravity-gemini-3\.8-flash@high \| Attempt 2 of 4 after provider_rate_limited on opencode\/muse-spark-1\.3-contributor-free/);
});

test("Q-007: after maxAttempts the last job is marked gave_up, with every attempt listed", async () => {
  calls.length = 0;
  installExecutor({ errorType: "agent_idle_timeout" });
  const first = await enqueueQueueJob(readJob({ task: "always stalls", models: [MUSE, GEMINI], maxAttempts: 3 }));
  assert.equal(first.ok, true, first.error);
  const { records, last } = await chain(first.record.jobId);
  assert.equal(records.length, 3);
  assert.deepEqual(calls.map((call) => call.model), [
    "opencode/muse-spark-1.3-contributor-free",
    "google/antigravity-gemini-3.8-flash",
    "opencode/muse-spark-1.3-contributor-free",
  ], "the order wraps around");
  assert.equal(last.completionOutcome, "gave_up");
  assert.equal(last.requeuedAs || "", "");
  assert.equal(last.attemptHistory.length, 3);
  const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 50 }));
  assert.match(list, new RegExp(`${last.jobId} .*attempt=3/3 .*error=agent_idle_timeout outcome=gave_up`));
  assert.ok(await waitFor(() => issues().includes("queue.job_gave_up")));
  assert.match(issues(), /\| queue\.job_gave_up \| agent_idle_timeout \| job \S+ reviewer on opencode\/muse-spark-1\.3-contributor-free \| Gave up after 3 of 3 attempt\(s\)\. Attempts: /);
});

test("Q-007: maxAttempts alone retries on the same model; a failure no model can fix is not retried", async () => {
  calls.length = 0;
  let count = 0;
  installExecutor(() => (++count === 1 ? { errorType: "agent_timeout" } : {}));
  const retried = await enqueueQueueJob(readJob({ task: "same model again", maxAttempts: 2 }));
  const { records } = await chain(retried.record.jobId);
  assert.equal(records.length, 2);
  assert.deepEqual(calls.map((call) => call.model), ["profile", "profile"]);
  assert.equal(records[1].status, "completed");

  installExecutor({ errorType: "write_scope_violation" });
  const scope = await enqueueQueueJob(readJob({ task: "scope violation", models: [MUSE, GEMINI] }));
  const record = await terminalOf(scope.record.jobId);
  await sleep(300);
  const after = await durable(scope.record.jobId);
  assert.equal(record.status, "failed");
  assert.equal(after.requeuedAs || "", "", "a scope violation is the contract's problem, not the model's");
  assert.equal(after.completionOutcome || "", "");
});

test("Q-007: a writer that changed nothing counts as no output under a policy", async () => {
  calls.length = 0;
  let count = 0;
  installExecutor(() => (++count === 1 ? { noChanges: true } : { changedFiles: ["src/a.txt"] }));
  const first = await enqueueQueueJob(writeJob("src/a.txt", { task: "write something", models: [MUSE, GEMINI] }));
  assert.equal(first.ok, true, first.error);
  const { records, last } = await chain(first.record.jobId);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].errorType, "writer_no_changes");
  assert.equal(last.status, "completed");
  assert.equal(last.retryAttempt, 2);
  // Without a policy the same outcome stays a success (outcome=completed_no_changes, B-039).
  installExecutor({ noChanges: true });
  const plain = await enqueueQueueJob(writeJob("src/b.txt", { task: "write without a policy" }));
  const plainRecord = await terminalOf(plain.record.jobId);
  assert.equal(plainRecord.status, "completed");
});

test("Q-007: when every model is paused the retry waits in the queue; a resume lets it start", async () => {
  calls.length = 0;
  let count = 0;
  // The pauses start while attempt 1 runs: a job enqueued while every model is already paused
  // waits at once instead (B-078, below).
  hooks.queueJobExecutorTestHook = async (request) => {
    const requirement = request.scopeContract?.modelRequirement || {};
    calls.push({ task: request.task, model: `${requirement.provider}/${requirement.model}`, variant: requirement.variant || "" });
    if (++count === 1) {
      assert.equal((await pauseProvider({ provider: "opencode/muse-spark-1.3-contributor-free", minutes: 30 })).ok, true);
      assert.equal((await pauseProvider({ provider: "google", minutes: 20 })).ok, true);
      return execution({ errorType: "provider_rate_limited", configuredProvider: requirement.provider || "", configuredModel: requirement.model || "" });
    }
    return execution({ configuredProvider: requirement.provider || "", configuredModel: requirement.model || "" });
  };
  const first = await enqueueQueueJob(readJob({ task: "everything paused", models: [MUSE, GEMINI] }));
  try {
    assert.ok(await waitFor(async () => Boolean((await durable(first.record.jobId))?.requeuedAs)));
    const retryId = (await durable(first.record.jobId)).requeuedAs;
    const waiting = await durable(retryId);
    assert.equal(waiting.status, "pending");
    const google = Date.parse(waiting.startAfter) - Date.now();
    assert.ok(google > 18 * 60_000 && google <= 20 * 60_000, `waits for the earlier pause (google, 20 min): ${waiting.startAfter}`);
    assert.equal(waiting.scopeContract.modelRequirement.model, "antigravity-gemini-3.8-flash", "the model whose pause ends first");
    await sleep(400);
    assert.equal(calls.length, 1, "the waiting retry was not started");
    const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 50 }));
    assert.match(list, new RegExp(`${retryId} .*startAfter=\\S+ agent=reviewer status=pending stage=waiting_for_provider_pause`));
    assert.equal((await resumeProvider({ provider: "google" })).ok, true);
    const done = await terminalOf(retryId);
    assert.equal(done.status, "completed", "resume released the wait");
    assert.equal(calls.length, 2);
  } finally {
    await resumeProvider({ provider: "opencode" });
    await resumeProvider({ provider: "google" });
  }
});

test("Q-007: a job the scheduler holds keeps its waiting time across a restart of the record", async () => {
  // The startAfter field is part of the durable summary, so a bridge that resumes the pending job
  // after a restart waits as well.
  installExecutor({});
  const job = await enqueueQueueJob(readJob({ task: "durable wait", models: [MUSE] }), "", { recordFields: { startAfter: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(job.ok, true, job.error);
  await sleep(300);
  const record = await durable(job.record.jobId);
  assert.equal(record.status, "pending");
  assert.ok(record.startAfter, "persisted");
  QUEUE_JOBS.get(job.record.jobId).startAfter = new Date(Date.now() - 1000).toISOString();
  scheduleQueue();
  assert.equal((await terminalOf(job.record.jobId)).status, "completed");
});

test("B-071: a provider slot wait (the agent never started) is not an attempt", async () => {
  calls.length = 0;
  let count = 0;
  installExecutor(() => (++count <= 2 ? { errorType: "provider_slot_wait_timeout" } : {}));
  const first = await enqueueQueueJob(readJob({ task: "waits for a slot twice", models: [MUSE], maxAttempts: 1 }));
  assert.equal(first.ok, true, first.error);
  const { records, last } = await chain(first.record.jobId);
  assert.equal(records.length, 3, "two uncounted slot waits, then the one real attempt");
  assert.equal(last.status, "completed", "with maxAttempts 1 the job still ran instead of giving up");
  assert.equal(last.retryAttempt, 1);
  assert.equal(last.slotWaitRequeues, 2);
  assert.match(last.attemptHistory[0], /provider_slot_wait_timeout \(not counted: the agent never started\)$/);
});

test("B-078: a new job whose every model is paused waits (startAfter) instead of failing its first attempt", async () => {
  calls.length = 0;
  installExecutor({});
  assert.equal((await pauseProvider({ provider: "opencode/muse-spark-1.3-contributor-free", minutes: 30 })).ok, true);
  assert.equal((await pauseProvider({ provider: "google", minutes: 20 })).ok, true);
  try {
    const input = readJob({ task: "paused at enqueue", models: [MUSE, GEMINI], maxAttempts: 1, idempotencyKey: "paused-at-enqueue" });
    const job = await enqueueQueueJob(input);
    assert.equal(job.ok, true, job.error);
    const waitMs = Date.parse(job.record.startAfter || "") - Date.now();
    assert.ok(waitMs > 18 * 60_000 && waitMs <= 20 * 60_000, `waits for the earliest pause end (google, 20 min): ${job.record.startAfter}`);
    await sleep(300);
    assert.equal(calls.length, 0, "nothing started while every model is paused (before: attempt 1 failed at the slot and, with maxAttempts 1, gave up)");
    const record = await durable(job.record.jobId);
    assert.equal(record.status, "pending");
    assert.equal(record.scopeContract.modelRequirement.model, "muse-spark-1.3-contributor-free", "the request keeps its first model, so the idempotency fingerprint does not depend on the pauses");
    assert.match(textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 50 })), new RegExp(`${job.record.jobId} .*stage=waiting_for_provider_pause`));
    assert.equal((await enqueueQueueJob(input)).deduplicated, true, "the same input again deduplicates");
    await resumeProvider({ provider: "google" });
    QUEUE_JOBS.get(job.record.jobId).startAfter = "";
    scheduleQueue();
    assert.equal((await terminalOf(job.record.jobId)).status, "completed");
  } finally {
    await resumeProvider({ provider: "opencode" });
    await resumeProvider({ provider: "google" });
  }
});

test("B-078: a slot refused for a paused model is not an attempt, so the job does not give up without a real run", async () => {
  calls.length = 0;
  const until = new Date(Date.now() + 60_000).toISOString();
  let museRuns = 0;
  hooks.queueJobExecutorTestHook = async (request) => {
    const requirement = request.scopeContract?.modelRequirement || {};
    calls.push({ task: request.task, model: `${requirement.provider}/${requirement.model}` });
    const reply = (result, text) => ({ response: { content: [{ type: "text", text }] }, result: { changedFiles: [], configuredProvider: requirement.provider, configuredModel: requirement.model, ...result }, validation: null, worktree: null });
    // Attempt 1: the agent ran and hit a rate limit (a counted attempt, the model switches).
    if (requirement.provider === "opencode" && ++museRuns === 1) return reply({ errorType: "provider_rate_limited" }, "Job failed.\nerrorType: provider_rate_limited");
    // The next model was paused meanwhile: the slot request is refused, the agent never starts.
    if (requirement.provider === "google") return reply({ errorType: "provider_paused", exitCode: "provider_capacity_unavailable", providerCooldownUntil: until }, "Job failed.\nerrorType: provider_paused");
    return reply({ errorType: "" }, "REPORT: done.");
  };
  const first = await enqueueQueueJob(readJob({ task: "refused at the slot", models: [MUSE, GEMINI], maxAttempts: 2 }));
  assert.equal(first.ok, true, first.error);
  const { records, last } = await chain(first.record.jobId);
  assert.deepEqual(calls.map((call) => call.model), ["opencode/muse-spark-1.3-contributor-free", "google/antigravity-gemini-3.8-flash", "opencode/muse-spark-1.3-contributor-free"]);
  assert.equal(records[1].providerRefusedUntil, until, "the refusal is recorded as one");
  assert.equal(last.status, "completed", "with maxAttempts 2 the job still got its second real run (before: gave_up after the refusal)");
  assert.equal(last.retryAttempt, 2);
  assert.equal(last.pauseWaitRequeues, 1);
  assert.match(last.attemptHistory[1], /provider_paused \(not counted: the model was paused, the agent never started\)$/);
  assert.equal(records.some((record) => record.completionOutcome === "gave_up"), false);
  // A run that started and was rate limited records the pause it caused, but it is an attempt.
  assert.equal(records[0].providerRefusedUntil || "", "");
});

test("B-072: models, maxAttempts and autoIntegrate are refused in the memory queue, which drops the request", async () => {
  hooks.queueModeOverride = "memory";
  try {
    const policy = await enqueueQueueJob(readJob({ task: "memory queue policy", models: [MUSE] }));
    assert.equal(policy.ok, false);
    assert.equal(policy.errorType, "retry_policy_not_applicable");
    assert.match(policy.error, /need CODEX_OPENCODE_QUEUE_MODE=sqlite/);
    const integrate = await enqueueQueueJob(writeJob("src/a.txt", { task: "memory queue integrate", autoIntegrate: true }));
    assert.equal(integrate.ok, false);
    assert.equal(integrate.errorType, "auto_integrate_not_applicable");
  } finally {
    hooks.queueModeOverride = "sqlite";
  }
});

test("B-072/B-074: only a provably empty worktree of a failed attempt is removed (base commit known, no change, untracked or ignored file)", async () => {
  const { existsSync, writeFileSync, appendFileSync, mkdirSync } = await import("node:fs");
  const base = (await fixture.git(["rev-parse", "HEAD"])).trim();
  // Ignored files: worktree remove --force would delete them, so they keep the worktree.
  mkdirSync(path.join(fixture.repoInput, ".git", "info"), { recursive: true });
  appendFileSync(path.join(fixture.repoInput, ".git", "info", "exclude"), "\n*.log\n");
  const cases = {
    "empty attempt": { keep: false, baseCommit: base },
    "dirty attempt": { keep: true, baseCommit: base, file: ["src", "notes.txt"] },
    "ignored attempt": { keep: true, baseCommit: base, file: ["debug.log"] },
    "unknown base attempt": { keep: true, baseCommit: "" },
  };
  for (const [task, plan] of Object.entries(cases)) {
    plan.dir = path.join(fixture.root, `wt-${task.split(" ")[0]}`);
    plan.branch = `agent/builder/${task.split(" ")[0]}-attempt`;
    await fixture.git(["worktree", "add", "-q", "-b", plan.branch, plan.dir, "HEAD"]);
    if (plan.file) writeFileSync(path.join(plan.dir, ...plan.file), "half done\n");
  }
  const counts = {};
  hooks.queueJobExecutorTestHook = async (request) => {
    counts[request.task] = (counts[request.task] || 0) + 1;
    const plan = cases[request.task];
    return counts[request.task] === 1
      ? { response: { content: [{ type: "text", text: "Job failed.\nerrorType: agent_idle_timeout" }] }, result: { errorType: "agent_idle_timeout", changedFiles: [] }, validation: null, worktree: { path: plan.dir, branch: plan.branch, baseCommit: plan.baseCommit, baseTree: "" } }
      : execution({ changedFiles: ["src/a.txt"] });
  };
  for (const task of Object.keys(cases)) {
    const first = await enqueueQueueJob(writeJob("src/a.txt", { task, models: [MUSE] }));
    assert.equal(first.ok, true, first.error);
    await chain(first.record.jobId);
  }
  for (const [task, plan] of Object.entries(cases)) {
    assert.equal(existsSync(plan.dir), plan.keep, `${task}: ${plan.keep ? "kept" : "removed"}`);
  }
});

await runFlexTests({ isolatedStateDir, file: "tests/review-flex-fallback.js", tests, cleanup: async () => { hooks.selfTestModelOverrideAllowlist = null; await fixture.cleanup(); }, finishSkips, label: "model fallback" });
