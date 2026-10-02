#!/usr/bin/env node

// Regression tests for Q-001..Q-004 (log.md, 2026-10-01): requeue a failed job, change the
// concurrency limits at runtime, per-job token visibility, and the validation fix pass. Git,
// locks, the worktree registry and SQLite state are real; the agent run is replaced by the
// self-test hooks (queueJobExecutorTestHook / agentRuntimeTestHook), as in tests/review-queue.js
// and tests/review-measurement.js.
//   node tests/review-queue-features.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
delete process.env.CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT;
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const selfTestHooks = __selfTest.hooks;
const {
  CONFIG,
  ENV_PROVIDER_CONCURRENCY_LIMIT,
  ENV_QUEUE_PARALLEL_LIMIT,
  MAX_RUNTIME_CONCURRENCY_LIMIT,
  QUEUE_JOBS,
  RUNTIME_CONCURRENCY,
  acquireProviderLease,
  assert,
  describeConcurrencyLimits,
  enqueueQueueJob,
  mkdir,
  mkdtemp,
  openProviderLeaseDb,
  path,
  providerCapacitySnapshot,
  refreshRuntimeConcurrency,
  releaseProviderLease,
  resolveProjectStateRoot,
  rm,
  runCommand,
  runtimeConcurrencyLimitError,
  scheduleQueue,
  server,
  setRuntimeConcurrency,
  tmpdir,
  writeFile,
} = __selfTest.internals;

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "review-queue-features-"));
const stateDir = path.join(fixtureRoot, "state");
const repoInput = path.join(fixtureRoot, "repo");
await mkdir(stateDir, { recursive: true });
await mkdir(path.join(repoInput, "src"), { recursive: true });
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";

const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repoInput) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
await git(["init", "-q"]);
await git(["config", "core.autocrlf", "false"]);
await writeFile(path.join(repoInput, "src", "a.txt"), "a\n", "utf8");
await writeFile(path.join(repoInput, "src", "b.txt"), "b\n", "utf8");
await git(["add", "."]);
await git([...gitIdentity, "commit", "-q", "-m", "init"]);
const repo = await resolveProjectStateRoot(repoInput);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return Boolean(await predicate());
}
const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------- Q-002
function resetRuntimeState() {
  Object.assign(RUNTIME_CONCURRENCY, { providerLimit: null, queueParallelLimit: null, updatedAt: "" });
}

test("Q-002: invalid limits are refused and nothing is persisted", async () => {
  for (const value of [0, -1, MAX_RUNTIME_CONCURRENCY_LIMIT + 1, 2.5, "8", Number.NaN, Number.POSITIVE_INFINITY, true, [], {}]) {
    const providerRefused = await setRuntimeConcurrency({ providerLimit: value });
    assert.equal(providerRefused.ok, false, `providerLimit ${JSON.stringify(value)} must be refused`);
    assert.equal(providerRefused.errorType, "concurrency_invalid");
    assert.match(providerRefused.error, /providerLimit must be an integer from 1 to 32/);
    const queueRefused = await setRuntimeConcurrency({ queueParallelLimit: value });
    assert.equal(queueRefused.ok, false, `queueParallelLimit ${JSON.stringify(value)} must be refused`);
    assert.match(queueRefused.error, /queueParallelLimit must be an integer from 1 to 32/);
  }
  assert.equal((await setRuntimeConcurrency({})).ok, false, "an empty call changes nothing");
  assert.match((await setRuntimeConcurrency({})).error, /reset: true/);
  const mixed = await setRuntimeConcurrency({ providerLimit: 3, reset: true });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /do not combine/);
  assert.equal(runtimeConcurrencyLimitError("x", 1), "");
  assert.equal(runtimeConcurrencyLimitError("x", MAX_RUNTIME_CONCURRENCY_LIMIT), "");
  await refreshRuntimeConcurrency({ force: true });
  assert.equal(RUNTIME_CONCURRENCY.providerLimit, null);
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT);
  assert.equal(CONFIG.queueParallelLimit, ENV_QUEUE_PARALLEL_LIMIT);
});

test("Q-002: the tool refuses invalid values through its handler too (the schema is bypassed there)", async () => {
  for (const args of [{ providerLimit: 0 }, { queueParallelLimit: 33 }, { providerLimit: 2.5 }, {}, { providerLimit: 2, reset: true }]) {
    const response = await callTool("set_opencode_concurrency", args);
    assert.equal(response.isError, true, JSON.stringify(args));
    assert.match(textOf(response), /Concurrency change rejected\.\s+errorType: concurrency_invalid/, JSON.stringify(args));
  }
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT);
});

test("Q-002: a limit is applied, shown as effective/env, persisted across a restart and cleared by reset", async () => {
  const response = await callTool("set_opencode_concurrency", { providerLimit: 7, queueParallelLimit: 9 });
  assert.notEqual(response.isError, true, textOf(response));
  assert.equal(CONFIG.providerConcurrencyLimit, 7);
  assert.equal(CONFIG.queueParallelLimit, 9);
  const described = describeConcurrencyLimits();
  assert.match(described.provider, new RegExp(`^effective 7 \\(env ${ENV_PROVIDER_CONCURRENCY_LIMIT}, runtime override set \\d{4}-`));
  assert.match(described.queue, new RegExp(`^effective 9 \\(env ${ENV_QUEUE_PARALLEL_LIMIT}, runtime override set `));
  assert.match(textOf(response), /Provider slots per provider: effective 7 \(env \d+, runtime override/);
  assert.match(textOf(response), /Running jobs keep their slots/);
  const snapshot = await providerCapacitySnapshot();
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.capacity, 7, "diagnose reports the effective capacity");

  // A restart: the in-memory state is gone, the persisted rows bring the override back.
  resetRuntimeState();
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT);
  assert.equal(await refreshRuntimeConcurrency({ force: true }), true);
  assert.equal(CONFIG.providerConcurrencyLimit, 7);
  assert.equal(CONFIG.queueParallelLimit, 9);

  const reset = await callTool("set_opencode_concurrency", { reset: true });
  assert.notEqual(reset.isError, true, textOf(reset));
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT);
  assert.equal(CONFIG.queueParallelLimit, ENV_QUEUE_PARALLEL_LIMIT);
  assert.match(describeConcurrencyLimits().provider, new RegExp(`^effective ${ENV_PROVIDER_CONCURRENCY_LIMIT} \\(env ${ENV_PROVIDER_CONCURRENCY_LIMIT}\\)$`));
  resetRuntimeState();
  await refreshRuntimeConcurrency({ force: true });
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT, "the reset is persisted too");
});

test("Q-002: a raise reaches waiting slot requests at once and a lowering never kills held slots", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review-queue-features`;
  assert.equal((await setRuntimeConcurrency({ providerLimit: 1 })).ok, true);
  const first = await acquireProviderLease({ providerKey: key, timeoutMs: 3000 });
  assert.equal(first.ok, true, first.error);
  const blocked = await acquireProviderLease({ providerKey: key, timeoutMs: 400 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorType, "provider_slot_wait_timeout");

  // The stored capacity row says 1 and a lease is held; without the reset of that row the stricter
  // stored value would bind until the first lease drained.
  const raised = await setRuntimeConcurrency({ providerLimit: 3 });
  assert.equal(raised.ok, true);
  assert.deepEqual(raised.previous, { providerLimit: 1, queueParallelLimit: ENV_QUEUE_PARALLEL_LIMIT });
  const second = await acquireProviderLease({ providerKey: key, timeoutMs: 2000 });
  assert.equal(second.ok, true, `a raised limit must apply while a lease is held: ${second.error}`);
  const third = await acquireProviderLease({ providerKey: key, timeoutMs: 2000 });
  assert.equal(third.ok, true, third.error);

  // Lowering below the number of held slots leaves them running and only holds back new ones.
  const lowered = await setRuntimeConcurrency({ providerLimit: 2 });
  assert.equal(lowered.ok, true);
  const snapshot = await providerCapacitySnapshot();
  const entry = snapshot.keys.find((item) => item.providerKey === key);
  assert.equal(entry.leases, 3, "no held slot was released by the lowering");
  assert.equal(entry.capacity, 2);
  const refused = await acquireProviderLease({ providerKey: key, timeoutMs: 400 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /3 of 2 slots/);
  await releaseProviderLease(first.lease);
  assert.equal((await acquireProviderLease({ providerKey: key, timeoutMs: 300 })).ok, false, "2 held of 2 still blocks");
  await releaseProviderLease(second.lease);
  const afterDrain = await acquireProviderLease({ providerKey: key, timeoutMs: 2000 });
  assert.equal(afterDrain.ok, true, afterDrain.error);
  await releaseProviderLease(third.lease);
  await releaseProviderLease(afterDrain.lease);
  assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
});

test("Q-002: another process's persisted limit is picked up by a slot request", async () => {
  const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    db.prepare("INSERT INTO runtime_settings (name, value, updated_at) VALUES ('provider_concurrency_limit', 5, ?) ON CONFLICT(name) DO UPDATE SET value = 5").run(Date.now());
  } finally {
    db.close();
  }
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT, "not read yet");
  const lease = await acquireProviderLease({ providerKey: "review-queue-features:other-process", timeoutMs: 2000 });
  assert.equal(lease.ok, true, lease.error);
  assert.equal(CONFIG.providerConcurrencyLimit, 5, "the slot request read the persisted override");
  await releaseProviderLease(lease.lease);
  assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
});

test("Q-002: a hand-edited out-of-range row is ignored", async () => {
  const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    db.prepare("INSERT INTO runtime_settings (name, value, updated_at) VALUES ('provider_concurrency_limit', 999, ?) ON CONFLICT(name) DO UPDATE SET value = 999").run(Date.now());
  } finally {
    db.close();
  }
  await refreshRuntimeConcurrency({ force: true });
  assert.equal(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT);
  assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
});

test("Q-002: a raised queue parallel limit starts waiting jobs without a restart", async () => {
  QUEUE_JOBS.clear();
  const release = [];
  let running = 0;
  let peak = 0;
  selfTestHooks.queueJobExecutorTestHook = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => release.push(resolve));
    running -= 1;
    return { response: { content: [{ type: "text", text: "REPORT: done." }] }, result: { errorType: "", changedFiles: [] }, validation: null, worktree: null };
  };
  try {
    assert.equal((await setRuntimeConcurrency({ queueParallelLimit: 1 })).ok, true);
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const enqueued = await enqueueQueueJob({
        agent: "reviewer", task: `read ${index}`, cwd: repo, write: false, lockMode: "off",
        scopeContract: { mode: "read", read: [`src/${index}.txt`] },
      });
      assert.equal(enqueued.ok, true, enqueued.error);
      ids.push(enqueued.record.jobId);
    }
    assert.ok(await waitFor(() => running === 1), "one job starts under a limit of 1");
    await sleep(300);
    assert.equal(running, 1, "a limit of 1 holds the others back");
    const raised = await setRuntimeConcurrency({ queueParallelLimit: 3 });
    assert.equal(raised.ok, true);
    assert.ok(await waitFor(() => running === 3), `the raise starts the waiting jobs, running=${running}`);
    // Lowering never interrupts them.
    assert.equal((await setRuntimeConcurrency({ queueParallelLimit: 1 })).ok, true);
    await sleep(150);
    assert.equal(running, 3, "lowering leaves running jobs alone");
    while (release.length) release.shift()();
    assert.ok(await waitFor(() => ids.every((id) => QUEUE_JOBS.get(id)?.status === "completed")), "all three finish");
    assert.equal(peak, 3);
  } finally {
    while (release.length) release.shift()();
    selfTestHooks.queueJobExecutorTestHook = null;
    assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
  }
});

// ---------------------------------------------------------------------------- Q-001
const doneExecution = (text = "REPORT: done.") => ({ response: { content: [{ type: "text", text }] }, result: { errorType: "", changedFiles: [] }, validation: null, worktree: null });
const failedExecution = (errorType = "agent_timeout") => ({ response: { content: [{ type: "text", text: `Job failed.\nerrorType: ${errorType}` }] }, result: { errorType, changedFiles: [] }, validation: null, worktree: null });
const readJob = (extra = {}) => ({
  agent: "reviewer", task: "Review src/a.txt for the requeue tests.", cwd: repo, write: false, lockMode: "off",
  scopeContract: { mode: "read", read: ["src/a.txt"] }, ...extra,
});
const writeScope = (file) => ({ mode: "write", read: ["src"], write: [file], allowedEdits: [file], forbidden: [".env"], validationCommand: "git diff --check" });
const writeJob = (file = "src/a.txt", extra = {}) => ({
  agent: "builder", task: `Edit ${file} for the requeue tests.`, cwd: repo, write: true, lockMode: "simple",
  lockedPaths: ["src"], allowedEdits: [file], validationCommand: "git diff --check", timeoutMs: 600000,
  scopeContract: writeScope(file), ...extra,
});
const durable = (jobId) => __selfTest.internals.readPersistedQueueRecord(jobId, repo);
const requests = new Map();
async function runToEnd(job, execution) {
  selfTestHooks.queueJobExecutorTestHook = async (request) => {
    requests.set(request.task, request);
    return typeof execution === "function" ? execution(request) : execution;
  };
  const enqueued = await enqueueQueueJob(job);
  assert.equal(enqueued.ok, true, `${enqueued.errorType}: ${enqueued.error}`);
  assert.ok(await waitFor(async () => ["completed", "failed", "cancelled"].includes((await durable(enqueued.record.jobId))?.status)), "the job must reach a terminal status");
  return enqueued.record.jobId;
}
async function setStatus(jobId, status) {
  const db = await __selfTest.internals.openLockDb(repo);
  try {
    db.prepare("UPDATE opencode_jobs SET status = ?, revision = revision + 1 WHERE job_id = ?").run(status, jobId);
  } finally {
    __selfTest.internals.closeDb(db);
  }
}
async function rewriteStored(jobId, mutate, { dropRequest = false } = {}) {
  const db = await __selfTest.internals.openLockDb(repo);
  try {
    const row = db.prepare("SELECT request_encrypted, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    if (dropRequest) {
      db.prepare("UPDATE opencode_jobs SET request_encrypted = NULL WHERE job_id = ?").run(jobId);
      return;
    }
    const request = await __selfTest.internals.decryptQueueRequest(row.request_encrypted, jobId);
    mutate(request);
    db.prepare("UPDATE opencode_jobs SET request_encrypted = ? WHERE job_id = ?").run(await __selfTest.internals.encryptQueueRequest(request, jobId), jobId);
  } finally {
    __selfTest.internals.closeDb(db);
  }
}
async function patchSummary(jobId, patch) {
  const db = await __selfTest.internals.openLockDb(repo);
  try {
    const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify({ ...JSON.parse(row.record_json), ...patch }), jobId);
  } finally {
    __selfTest.internals.closeDb(db);
  }
}

test("Q-001: the derived idempotency key is stable, bounded and does not grow down a chain", () => {
  const { requeueIdempotencyKey } = __selfTest.internals;
  assert.equal(requeueIdempotencyKey({ idempotencyKey: "batch-7", jobId: "j1" }, 1), "batch-7:requeue:1");
  assert.equal(requeueIdempotencyKey({ idempotencyKey: "batch-7:requeue:1", jobId: "j2" }, 2), "batch-7:requeue:2");
  assert.equal(requeueIdempotencyKey({ idempotencyKey: "", jobId: "builder-1-ab" }, 1), "builder-1-ab:requeue:1");
  const long = requeueIdempotencyKey({ idempotencyKey: "k".repeat(200), jobId: "j" }, 12);
  assert.ok(long.length <= 200 && long.endsWith(":requeue:12"), long);
  assert.equal(requeueIdempotencyKey({ idempotencyKey: "k".repeat(200), jobId: "j" }, 12), long, "deterministic");
  assert.notEqual(requeueIdempotencyKey({ idempotencyKey: `${"k".repeat(199)}x`, jobId: "j" }, 12), long, "a different long key does not collide");
});

test("Q-001: a failed writer is requeued as a new job with the stored request, linked both ways", async () => {
  const original = await runToEnd(writeJob("src/a.txt", { idempotencyKey: "batch-a" }), failedExecution("agent_timeout"));
  assert.equal((await durable(original)).status, "failed");
  const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original });
  assert.notEqual(response.isError, true, textOf(response));
  const text = textOf(response);
  assert.match(text, /^OpenCode job requeued\./);
  assert.match(text, new RegExp(`Requeued from: ${original} \\(was failed, agent_timeout\\)`));
  assert.match(text, /Idempotency key: batch-a:requeue:1/);
  assert.match(text, /Overrides: none/);
  const created = /New job ID: (\S+)/.exec(text)[1];
  assert.notEqual(created, original);
  assert.ok(await waitFor(async () => (await durable(created))?.status === "failed"), "the new job runs (and fails again with the same fixture)");

  const first = await durable(original);
  const second = await durable(created);
  assert.equal(first.requeuedAs, created);
  assert.ok(first.requeuedAt);
  assert.equal(second.requeuedFrom, original);
  assert.equal(second.requeueSequence, 1);
  assert.equal(second.idempotencyKey, "batch-a:requeue:1");
  assert.equal(second.agent, "builder");
  assert.deepEqual(second.lockedPaths, first.lockedPaths);
  assert.deepEqual(second.allowedEdits, first.allowedEdits);
  assert.deepEqual(second.scopeContract, first.scopeContract);

  // The executor saw the stored request, unchanged (timeout, validationCommand, scope contract).
  const seen = requests.get("Edit src/a.txt for the requeue tests.");
  assert.equal(seen.timeoutMs, 600000);
  assert.equal(seen.validationCommand, "git diff --check");
  assert.deepEqual(seen.scopeContract, writeScope("src/a.txt"));
  assert.equal(seen.idempotencyKey, undefined, "the key is kept out of the stored request, as for any job");

  // Lineage is visible in the compact list and in get_opencode_job.
  const list = textOf(await callTool("list_opencode_jobs", { cwd: repo }));
  assert.match(list, new RegExp(`${original}[^\\n]*requeuedAs=${created}`));
  assert.match(list, new RegExp(`${created}[^\\n]*requeuedFrom=${original}`));
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { cwd: repo, jobId: created })));
  assert.equal(view.requeuedFrom, original);
});

test("Q-001: model and timeout overrides pass through, everything else is replayed", async () => {
  selfTestHooks.selfTestModelOverrideAllowlist = ["fixture/model-b@high", "fixture/model-c"];
  try {
    const original = await runToEnd(writeJob("src/b.txt", { idempotencyKey: "batch-b" }), failedExecution("opencode_rate_limited"));
    const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original, model: "fixture/model-b@high", timeoutMs: 1234567 });
    assert.notEqual(response.isError, true, textOf(response));
    assert.match(textOf(response), /Overrides: model=fixture\/model-b@high, timeoutMs=1234567/);
    const created = /New job ID: (\S+)/.exec(textOf(response))[1];
    assert.ok(await waitFor(async () => (await durable(created))?.status === "failed"));
    const seen = requests.get("Edit src/b.txt for the requeue tests.");
    assert.equal(seen.timeoutMs, 1234567);
    assert.deepEqual(seen.scopeContract.modelRequirement, { provider: "fixture", model: "model-b", variant: "high" });
    assert.deepEqual({ ...seen.scopeContract, modelRequirement: undefined }, { ...writeScope("src/b.txt"), modelRequirement: undefined });
    assert.deepEqual(seen.lockedPaths, ["src"]);
    assert.equal((await durable(created)).scopeContract.modelRequirement.model, "model-b");
  } finally {
    selfTestHooks.selfTestModelOverrideAllowlist = null;
  }
});

test("Q-001: a cancelled, interrupted and not_resumable job can be requeued", async () => {
  for (const status of ["cancelled", "interrupted", "not_resumable"]) {
    const original = await runToEnd(readJob({ task: `Review for the ${status} requeue test.`, idempotencyKey: `status-${status}` }), failedExecution());
    await setStatus(original, status);
    const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original });
    assert.notEqual(response.isError, true, `${status}: ${textOf(response)}`);
    assert.match(textOf(response), new RegExp(`Requeued from: ${original} \\(was ${status}`));
  }
});

test("Q-001: a completed job is refused", async () => {
  const original = await runToEnd(readJob({ task: "Completed job for the requeue test.", idempotencyKey: "completed-one" }), doneExecution());
  assert.equal((await durable(original)).status, "completed");
  const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /errorType: requeue_job_completed/);
  assert.match(textOf(response), /new idempotencyKey/);
  assert.equal((await durable(original)).requeuedAs || "", "", "nothing was created or marked");
  assert.equal((await enqueueQueueJob(readJob({ task: "Completed job for the requeue test.", idempotencyKey: "completed-one:requeue:1" }))).deduplicated, undefined, "no job holds the derived key");
});

test("Q-001: a model outside the allowlist, a malformed model and a bad timeout are refused", async () => {
  selfTestHooks.selfTestModelOverrideAllowlist = ["fixture/model-b@high"];
  try {
    const original = await runToEnd(readJob({ task: "Failed job for the refusal tests.", idempotencyKey: "refusals" }), failedExecution());
    for (const [args, errorType] of [
      [{ model: "evil/model-z" }, "requeue_model_not_allowlisted"],
      [{ model: "fixture/model-b@low" }, "requeue_model_not_allowlisted"],
      [{ model: "not-a-model" }, "requeue_model_invalid"],
      [{ model: "-x/--y" }, "requeue_model_invalid"],
      [{ timeoutMs: 0 }, "requeue_invalid_arguments"],
      [{ timeoutMs: 10 ** 12 }, "requeue_invalid_arguments"],
      [{ timeoutMs: 1.5 }, "requeue_invalid_arguments"],
    ]) {
      const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original, ...args });
      assert.equal(response.isError, true, JSON.stringify(args));
      assert.match(textOf(response), new RegExp(`errorType: ${errorType}`), JSON.stringify(args));
    }
    assert.equal((await durable(original)).requeuedAs || "", "", "a refused requeue leaves the original unmarked");
    const missing = await callTool("requeue_opencode_job", { cwd: repo, jobId: "builder-0-00000000" });
    assert.match(textOf(missing), /errorType: requeue_job_not_found/);
  } finally {
    selfTestHooks.selfTestModelOverrideAllowlist = null;
  }
});

test("Q-001: an unfinished job, a pipeline child and an already requeued job are refused", async () => {
  const release = [];
  selfTestHooks.queueJobExecutorTestHook = async () => {
    await new Promise((resolve) => release.push(resolve));
    return failedExecution();
  };
  const running = await enqueueQueueJob(readJob({ task: "A job that is still running.", idempotencyKey: "still-running" }));
  assert.equal(running.ok, true);
  assert.ok(await waitFor(() => release.length === 1));
  const unfinished = await callTool("requeue_opencode_job", { cwd: repo, jobId: running.record.jobId });
  assert.equal(unfinished.isError, true);
  assert.match(textOf(unfinished), /errorType: requeue_job_not_terminal[\s\S]*still running/);
  release.shift()();
  assert.ok(await waitFor(async () => (await durable(running.record.jobId))?.status === "failed"));
  // B-056: a queued job fails in the background, so its failed record is in the operations log.
  const { readOpsLog } = await import("../bin/ops-log.js");
  const failedLine = readOpsLog(stateDir, { days: 1 }).lines.find((line) => line.event === "queue.job_failed" && line.jobId === running.record.jobId);
  assert.ok(failedLine, "queue.job_failed is logged for the failed job");
  assert.deepEqual([failedLine.level, failedLine.agent, failedLine.errorType], ["warn", "reviewer", "agent_timeout"]);
  assert.ok(failedLine.summary.length > 0);

  await patchSummary(running.record.jobId, { parentJobId: "some-pipeline-1" });
  const child = await callTool("requeue_opencode_job", { cwd: repo, jobId: running.record.jobId });
  assert.match(textOf(child), /errorType: requeue_pipeline_child/);
  await patchSummary(running.record.jobId, { parentJobId: "" });

  selfTestHooks.queueJobExecutorTestHook = async () => failedExecution();
  const first = await callTool("requeue_opencode_job", { cwd: repo, jobId: running.record.jobId });
  assert.notEqual(first.isError, true, textOf(first));
  const created = /New job ID: (\S+)/.exec(textOf(first))[1];
  const again = await callTool("requeue_opencode_job", { cwd: repo, jobId: running.record.jobId });
  assert.equal(again.isError, true);
  assert.match(textOf(again), new RegExp(`errorType: requeue_already_requeued[\\s\\S]*requeued as ${created}`));
});

test("Q-001: a request that is not stored, unreadable or from a contractor job is refused with what is missing", async () => {
  const legacy = await runToEnd(readJob({ task: "Legacy record without a request.", idempotencyKey: "legacy-1" }), failedExecution());
  await rewriteStored(legacy, null, { dropRequest: true });
  const noRequest = await callTool("requeue_opencode_job", { cwd: repo, jobId: legacy });
  assert.equal(noRequest.isError, true);
  assert.match(textOf(noRequest), /errorType: requeue_request_not_stored/);
  assert.match(textOf(noRequest), /agent, task, model pin, Scope Contract, locks, validationCommand, timeout/);

  const contractor = await runToEnd(readJob({ task: "Contractor-shaped record.", idempotencyKey: "contractor-1" }), failedExecution());
  await rewriteStored(contractor, (request) => { request.orchestratorMode = "contractor"; });
  assert.match(textOf(await callTool("requeue_opencode_job", { cwd: repo, jobId: contractor })), /errorType: requeue_contractor_unsupported/);

  const unknown = await runToEnd(readJob({ task: "Record with a field the schema does not know.", idempotencyKey: "unknown-1" }), failedExecution());
  await rewriteStored(unknown, (request) => { request.shellAccess = true; delete request.agent; });
  const invalid = textOf(await callTool("requeue_opencode_job", { cwd: repo, jobId: unknown }));
  assert.match(invalid, /errorType: requeue_request_invalid/);
  assert.match(invalid, /agent/);
  assert.match(invalid, /shellAccess|Unrecognized key/);
});

test("Q-001: the stored request is re-validated; scope rules are not bypassed", async () => {
  const original = await runToEnd(writeJob("src/a.txt", { task: "Writer whose stored scope later turns out invalid.", idempotencyKey: "scope-1" }), failedExecution());
  // A stored request that breaks a scope rule enforced today (an allowed edit outside scope.write).
  await rewriteStored(original, (request) => { request.scopeContract.allowedEdits = ["src/a.txt", "docs/outside.md"]; request.allowedEdits = ["src/a.txt", "docs/outside.md"]; });
  const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: original });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /rejected by the normal enqueue validation/);
  assert.match(textOf(response), /errorType: scope_write_forbidden/);
  assert.equal((await durable(original)).requeuedAs || "", "");

  // A stored request without a Scope Contract is a write job the normal path would not accept either.
  const bare = await runToEnd(writeJob("src/b.txt", { task: "Writer that lost its contract.", idempotencyKey: "scope-2" }), failedExecution());
  await rewriteStored(bare, (request) => { delete request.scopeContract; });
  assert.match(textOf(await callTool("requeue_opencode_job", { cwd: repo, jobId: bare })), /errorType: missing_scope_contract/);
});

test("Q-001: two requeues of the same job at once create one job", async () => {
  const original = await runToEnd(readJob({ task: "Job requeued twice at once.", idempotencyKey: "race-1" }), failedExecution());
  selfTestHooks.queueJobExecutorTestHook = async () => doneExecution();
  const [left, right] = await Promise.all([
    __selfTest.internals.requeueQueueJob({ cwd: repo, jobId: original }),
    __selfTest.internals.requeueQueueJob({ cwd: repo, jobId: original }),
  ]);
  assert.equal(left.ok && right.ok, true, JSON.stringify([left.error, right.error]));
  assert.equal(left.record.jobId, right.record.jobId, "the derived key makes the second call a duplicate of the first");
  assert.equal([left, right].filter((item) => item.deduplicated).length, 1);
  assert.equal((await durable(original)).requeuedAs, left.record.jobId);
});

test("Q-001: a still-alive orphan child of an interrupted job blocks the requeue", async () => {
  const original = await runToEnd(readJob({ task: "Interrupted job with a live orphan.", idempotencyKey: "orphan-1" }), failedExecution());
  await setStatus(original, "interrupted");
  await patchSummary(original, { orphanChildProcessAlive: true, orphanChildProcessId: process.pid });
  const blocked = await callTool("requeue_opencode_job", { cwd: repo, jobId: original });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /errorType: requeue_orphan_child_alive/);
  await patchSummary(original, { orphanChildProcessAlive: false });
  assert.notEqual((await callTool("requeue_opencode_job", { cwd: repo, jobId: original })).isError, true);
});

// ---------------------------------------------------------------------------- Q-003
const sessionID = "ses_root";
const stepFinish = (input, output, cacheRead = 0, session = sessionID) => JSON.stringify({ type: "step_finish", sessionID: session, part: {
  type: "step-finish", reason: "tool-calls", sessionID: session, tokens: { total: input + output + cacheRead, input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } }, cost: 0,
} });
const toolUse = (tool, input, outputChars, session = sessionID) => JSON.stringify({ type: "tool_use", sessionID: session, part: {
  type: "tool", tool, sessionID: session, state: { status: "completed", input, output: "x".repeat(outputChars) },
} });
const stepStart = (session = sessionID) => JSON.stringify({ type: "step_start", sessionID: session, part: { type: "step-start" } });
const finalText = (session = sessionID) => JSON.stringify({ type: "text", sessionID: session, part: { id: "p1", messageID: "m1", type: "text", text: "Done.", time: { end: 1 } } });

test("Q-003: the heaviest tool calls are derived from the per-step prompt growth", () => {
  // Step 1 ends with a prompt of 5000 and 100 output tokens; its grep (40000 chars) and read (2000
  // chars) results make the prompt of step 2 grow to 15600, so 10500 context tokens were added,
  // split 10000/500 by result length; the bash result of step 2 adds 400. A result is sent again
  // by every later step: 2 for step 1's calls, 1 for step 2's.
  const stdout = [
    stepStart(),
    toolUse("grep", { pattern: "pool", path: "docs/question-content" }, 40000),
    toolUse("read", { filePath: "src/a.txt" }, 2000),
    stepFinish(5000, 100),
    stepStart(),
    toolUse("bash", { command: "git diff --stat" }, 800),
    stepFinish(600, 300, 15000),
    stepStart(),
    finalText(),
    stepFinish(900, 50, 15400),
  ].join("\n");
  const inspection = __selfTest.internals.inspectOpenCodeEventStream(stdout, "");
  assert.equal(inspection.usage.steps, 3);
  assert.equal(inspection.usage.inputCount, 6500);
  assert.equal(inspection.usage.cacheReadCount, 30400);
  assert.deepEqual(inspection.heavyToolCalls.map((call) => call.tool), ["grep", "read", "bash"]);
  assert.deepEqual(inspection.heavyToolCalls[0], { tool: "grep", target: "pattern: pool in docs/question-content", addedContextCount: 10000, laterSteps: 2, rereadInputCount: 20000 });
  assert.equal(inspection.heavyToolCalls[1].addedContextCount, 500);
  assert.equal(inspection.heavyToolCalls[1].target, "src/a.txt");
  assert.deepEqual(inspection.heavyToolCalls[2], { tool: "bash", target: "command: git diff --stat", addedContextCount: 400, laterSteps: 1, rereadInputCount: 400 });
  const line = __selfTest.internals.formatSingleResult({ resolution: { requestedAgent: "builder", actualAgent: "builder" }, result: { usage: inspection.usage, heavyToolCalls: inspection.heavyToolCalls }, cwd: repo, lockPlan: null });
  assert.match(line, /Token usage: steps=3 input=6500/);
  assert.match(line, /Heaviest tool calls \(estimated input re-read by later steps\): grep pattern: pool in docs\/question-content \+10000 context x 2 steps = ~20000; read src\/a\.txt/);
});

test("Q-003: a stream without usage reports none instead of guessing; subagent sessions are kept apart", () => {
  const { inspectOpenCodeEventStream, formatOpenCodeUsage } = __selfTest.internals;
  const noUsage = inspectOpenCodeEventStream([stepStart(), toolUse("read", { filePath: "src/a.txt" }, 9000), finalText()].join("\n"), "");
  assert.deepEqual(noUsage.heavyToolCalls, []);
  assert.equal(formatOpenCodeUsage(noUsage.usage), "not emitted by OpenCode");
  // The last step has nothing after it to show what its results cost, so it is never ranked.
  const lastOnly = inspectOpenCodeEventStream([stepStart(), toolUse("read", { filePath: "src/a.txt" }, 9000), stepFinish(1000, 10), finalText()].join("\n"), "");
  assert.deepEqual(lastOnly.heavyToolCalls, []);
  // Two sessions interleave; each session's growth is measured against its own steps.
  const mixed = inspectOpenCodeEventStream([
    stepStart(), toolUse("task", { description: "explore" }, 100), stepFinish(1000, 10),
    stepStart("ses_child"), toolUse("read", { filePath: "big.txt" }, 50000, "ses_child"), stepFinish(500, 5, 0, "ses_child"),
    stepStart("ses_child"), stepFinish(8500, 5, 0, "ses_child"),
    stepStart(), stepFinish(1100, 10),
  ].join("\n"), "");
  assert.deepEqual(mixed.heavyToolCalls.map((call) => [call.tool, call.addedContextCount, call.laterSteps]), [["read", 8000 - 5, 1], ["task", 90, 1]]);
});

test("Q-003: a tool target is redacted and bounded", () => {
  const stdout = [
    stepStart(),
    toolUse("bash", { command: `curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD" ${"https://example.invalid/".repeat(20)}` }, 100),
    stepFinish(100, 5),
    stepStart(), stepFinish(900, 5),
  ].join("\n");
  const [call] = __selfTest.internals.inspectOpenCodeEventStream(stdout, "").heavyToolCalls;
  assert.ok(call.target.length <= 140, `target length ${call.target.length}`);
  assert.doesNotMatch(call.target, /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("Q-003: token totals and the heaviest calls reach list_opencode_jobs and get_opencode_job", async () => {
  const usage = { steps: 9, inputCount: 1048576, outputCount: 5120, reasoningCount: 300, cacheReadCount: 90000, cacheWriteCount: 0, cost: 0, rootSteps: 9 };
  const heavyToolCalls = [
    { tool: "grep", target: "pattern: pool in docs/question-content", addedContextCount: 100000, laterSteps: 8, rereadInputCount: 800000 },
    { tool: "read", target: "docs/big.md", addedContextCount: 20000, laterSteps: 4, rereadInputCount: 80000 },
  ];
  const jobId = await runToEnd(readJob({ task: "Heavy reader for the usage test.", idempotencyKey: "usage-1" }), () => ({
    response: { content: [{ type: "text", text: "REPORT: read a lot." }] },
    result: { errorType: "", changedFiles: [], usage, heavyToolCalls },
    validation: null, worktree: null,
  }));
  const list = textOf(await callTool("list_opencode_jobs", { cwd: repo }));
  const line = list.split("\n").find((item) => item.includes(jobId));
  assert.match(line, /tokens=1048576in\/5120out cacheRead=90000/);
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { cwd: repo, jobId })));
  assert.match(view.usageSummary, /^steps=9 input=1048576 output=5120 reasoning=300 cache_read=90000 cache_write=0 cost=0/);
  assert.equal(view.usage.inputCount, 1048576);
  assert.equal(view.heavyToolCalls.length, 2);
  assert.equal(view.heavyToolCalls[0].tool, "grep");
  assert.equal(view.heavyToolCalls[0].rereadInputCount, 800000);
  const detail = JSON.parse(textOf(await callTool("get_opencode_job", { cwd: repo, jobId, detail: true })));
  assert.deepEqual(detail.heavyToolCalls.map((call) => call.target), ["pattern: pool in docs/question-content", "docs/big.md"]);
});

test("Q-003: a job whose stream carried no usage shows none in the list", async () => {
  const jobId = await runToEnd(readJob({ task: "No usage in the stream.", idempotencyKey: "usage-2" }), doneExecution());
  const line = textOf(await callTool("list_opencode_jobs", { cwd: repo })).split("\n").find((item) => item.includes(jobId));
  assert.doesNotMatch(line, /tokens=/);
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { cwd: repo, jobId })));
  assert.equal(view.usageSummary, undefined);
  assert.equal(view.heavyToolCalls, undefined);
});

// ---------------------------------------------------------------------------- Q-004
const AGENT_USAGE = { steps: 2, inputCount: 1200, outputCount: 80, reasoningCount: 30, cacheReadCount: 5, cacheWriteCount: 0, cost: 0, rootSteps: 2 };
function metadataFor(agent) {
  return { ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: agent === "builder" || agent === "debugger", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
  } };
}
// The agent run is replaced; `runs` records every call so a test can see the prompts and timeouts.
function installAgentRuntime(onRun) {
  const runs = [];
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => metadataFor(agent),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan, timeoutMs) => {
      const run = { prompt, cwd, timeoutMs, index: runs.length };
      runs.push(run);
      const childStartedAtMs = Date.now();
      if (!dryRun) await onRun(run);
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1,
        usage: { ...AGENT_USAGE }, providerRetryWarningCount: 1, providerConcurrencyWaitMs: 7,
        runPhaseTimings: { preSlotMs: 1, providerWaitMs: 7, finalAttestationMs: 2, spawnGateMs: 0, afterExitMs: 0 },
      };
    },
  };
  return runs;
}
const fixWriteJob = (file, extra = {}) => ({
  agent: "builder", task: `Write ${file} cleanly.`, cwd: repo, write: true, lockMode: "simple", lockedPaths: [file], allowedEdits: [file],
  validationCommand: "git diff --check", timeoutMs: 600000, scopeContract: { ...writeScope(file), write: [file], read: [file] }, ...extra,
});
const runDirect = async (job) => textOf(await callTool("run_opencode_agent", job));
async function cleanRetainedWorktrees() {
  const { listRetainedWorktreeArtifacts, cleanupWorktree } = __selfTest.internals;
  for (const item of await listRetainedWorktreeArtifacts(repo)) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true).catch(() => null);
}

test("Q-004: a failed validation gets one fix pass with its output, then validates again", async () => {
  const runs = installAgentRuntime(async ({ cwd, index }) => {
    await writeFile(path.join(cwd, "src", "a.txt"), index === 0 ? "trailing space \n" : "clean line\n", "utf8");
  });
  const text = await runDirect(fixWriteJob("src/a.txt", { validationFixPasses: 1 }));
  assert.equal(runs.length, 2, "exactly one extra run");
  assert.doesNotMatch(runs[0].prompt, /VALIDATION FIX PASS/);
  assert.match(runs[1].prompt, /VALIDATION FIX PASS/);
  assert.ok(runs[1].prompt.includes(runs[0].prompt), "the second prompt contains the job's own prompt");
  assert.match(runs[1].prompt, /Validation command: git diff --check/);
  assert.match(runs[1].prompt, /Validation exit code: 2/);
  assert.match(runs[1].prompt, /trailing whitespace/i);
  assert.equal(runs[1].cwd, runs[0].cwd, "the same worktree");
  assert.ok(runs[1].timeoutMs > 0 && runs[1].timeoutMs <= 600000, `the pass uses what is left of the job timeout: ${runs[1].timeoutMs}`);
  assert.match(text, /Validation fix pass: used 1 of 1; first validation: exit code 2/);
  assert.match(text, /Final validation: passed/);
  assert.match(text, /Validation gate: passed/);
  assert.match(text, /Token usage: steps=4 input=2400 output=160/, "both runs' tokens are reported");
  assert.match(text, /Provider error lines in OpenCode stderr[^\n]*: 2/);
  assert.match(text, /Worktree changed files: src\/a\.txt/);
  assert.doesNotMatch(text, /errorType: validation_command_failed|Error type: validation_command_failed/);
  await cleanRetainedWorktrees();
});

test("Q-004: still failing after the pass fails the job as before; there is never a second pass", async () => {
  const runs = installAgentRuntime(async ({ cwd }) => {
    await writeFile(path.join(cwd, "src", "a.txt"), "still trailing \n", "utf8");
  });
  const text = await runDirect(fixWriteJob("src/a.txt", { validationFixPasses: 1 }));
  assert.equal(runs.length, 2);
  assert.match(text, /Validation fix pass: used 1 of 1/);
  assert.match(text, /Final validation: failed/);
  assert.match(text, /Validation gate: failed/);
  assert.match(text, /Error type: validation_command_failed/);
  await cleanRetainedWorktrees();
});

test("Q-004: without the option a failed validation is final", async () => {
  for (const extra of [{}, { validationFixPasses: 0 }]) {
    const runs = installAgentRuntime(async ({ cwd }) => writeFile(path.join(cwd, "src", "a.txt"), "trailing \n", "utf8"));
    const text = await runDirect(fixWriteJob("src/a.txt", extra));
    assert.equal(runs.length, 1, JSON.stringify(extra));
    assert.doesNotMatch(text, /Validation fix pass/);
    assert.match(text, /Error type: validation_command_failed/);
    await cleanRetainedWorktrees();
  }
});

test("Q-004: the pass is skipped, and says why, when too little of the job timeout is left", async () => {
  const runs = installAgentRuntime(async ({ cwd }) => writeFile(path.join(cwd, "src", "a.txt"), "trailing \n", "utf8"));
  const text = await runDirect(fixWriteJob("src/a.txt", { validationFixPasses: 1, timeoutMs: 30000 }));
  assert.equal(runs.length, 1);
  assert.match(text, /Validation fix pass: skipped \(only 30 s of the job timeout are left \(a pass needs 60 s\)\)/);
  assert.match(text, /Error type: validation_command_failed/);
  await cleanRetainedWorktrees();
});

test("Q-004: scope and lock rules judge the pass: an edit outside the allowed files fails the job", async () => {
  const runs = installAgentRuntime(async ({ cwd, index }) => {
    await writeFile(path.join(cwd, "src", "a.txt"), index === 0 ? "trailing \n" : "clean\n", "utf8");
    if (index === 1) await writeFile(path.join(cwd, "src", "b.txt"), "outside the allowed edits\n", "utf8");
  });
  const text = await runDirect(fixWriteJob("src/a.txt", { validationFixPasses: 1 }));
  assert.equal(runs.length, 2);
  assert.match(text, /changed_file_validation_error|worktree_changed_file_validation_error/);
  assert.match(text, /src\/b\.txt/);
  assert.match(text, /Validation gate: skipped_due_to_prior_failure/);
  await cleanRetainedWorktrees();
});

test("Q-004: an agent error in the pass is the job's error", async () => {
  installAgentRuntime(async ({ cwd }) => writeFile(path.join(cwd, "src", "a.txt"), "trailing \n", "utf8"));
  const base = selfTestHooks.agentRuntimeTestHook.runOpenCodeWithPolicy;
  let calls = 0;
  selfTestHooks.agentRuntimeTestHook.runOpenCodeWithPolicy = async (...args) => {
    const result = await base(...args);
    calls += 1;
    return calls === 2 ? { ...result, errorType: "agent_timeout", timedOut: true } : result;
  };
  const text = await runDirect(fixWriteJob("src/a.txt", { validationFixPasses: 1 }));
  assert.equal(calls, 2);
  assert.match(text, /Error type: agent_timeout/);
  assert.match(text, /Validation fix pass: used 1 of 1/);
  assert.match(text, /Final validation: skipped_due_to_prior_failure/);
  await cleanRetainedWorktrees();
});

test("Q-004: the option is refused where it does nothing or is not supported", async () => {
  installAgentRuntime(async () => {});
  const refused = async (job, errorType) => {
    const response = await callTool("run_opencode_agent", job);
    assert.match(textOf(response), new RegExp(`errorType: ${errorType}`), textOf(response));
  };
  await refused(fixWriteJob("src/a.txt", { validationFixPasses: 1, validationCommand: "", scopeContract: { ...writeScope("src/a.txt"), validationCommand: "" } }), "validation_fix_pass_not_applicable");
  await refused(readJob({ validationFixPasses: 1 }), "validation_fix_pass_not_applicable");
  await refused(fixWriteJob("src/a.txt", { validationFixPasses: 2 }), "validation_fix_pass_invalid");
  const parallel = textOf(await callTool("run_opencode_parallel", { jobs: [fixWriteJob("src/a.txt", { validationFixPasses: 1, lockMode: "strict" })] }));
  assert.match(parallel, /errorType: validation_fix_pass_unsupported_in_parallel/);
  const queued = await enqueueQueueJob(fixWriteJob("src/a.txt", { validationFixPasses: 1, validationCommand: "", scopeContract: { ...writeScope("src/a.txt"), validationCommand: "" } }));
  assert.equal(queued.ok, false);
  assert.equal(queued.errorType, "validation_fix_pass_not_applicable");
});

test("Q-004: a queued job reports its fix pass in the list and in get_opencode_job", async () => {
  selfTestHooks.queueJobExecutorTestHook = null;
  const runs = installAgentRuntime(async ({ cwd, index }) => {
    await writeFile(path.join(cwd, "src", "b.txt"), index === 0 ? "trailing \n" : "clean\n", "utf8");
  });
  const enqueued = await enqueueQueueJob(fixWriteJob("src/b.txt", { validationFixPasses: 1, idempotencyKey: "fix-pass-queue" }));
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => ["completed", "failed"].includes((await durable(jobId))?.status), 20000), "the queued job ends");
  const record = await durable(jobId);
  assert.equal(record.status, "completed", `${record.errorType}: ${record.errorReason}`);
  assert.equal(runs.length, 2);
  assert.equal(record.validationFixPass.used, 1);
  assert.equal(record.validationFixPass.finalValidation, "passed");
  assert.equal(record.usage.inputCount, 2400);
  const line = textOf(await callTool("list_opencode_jobs", { cwd: repo })).split("\n").find((item) => item.includes(jobId));
  assert.match(line, /fixPass=used\(passed\)/);
  assert.match(line, /tokens=2400in\/160out/);
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { cwd: repo, jobId })));
  assert.equal(view.validationFixPass.used, 1);
  assert.match(view.resultText, /Validation fix pass: used 1 of 1/);
  await cleanRetainedWorktrees();
});

test("Q-004: a requeued job keeps validationFixPasses", async () => {
  selfTestHooks.queueJobExecutorTestHook = async (request) => {
    requests.set(request.task, request);
    return failedExecution();
  };
  const enqueued = await enqueueQueueJob(fixWriteJob("src/a.txt", { validationFixPasses: 1, idempotencyKey: "fix-pass-requeue" }));
  assert.equal(enqueued.ok, true, enqueued.error);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "failed"));
  const response = await callTool("requeue_opencode_job", { cwd: repo, jobId: enqueued.record.jobId });
  assert.notEqual(response.isError, true, textOf(response));
  assert.ok(await waitFor(() => requests.get("Write src/a.txt cleanly.")?.validationFixPasses === 1));
  selfTestHooks.queueJobExecutorTestHook = null;
});

let failed = 0;
const skips = [];
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skips.push({ name, reason: error.message, optional: error.optional });
        process.stdout.write(`skip ${name}: ${error.message}\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  selfTestHooks.stateDirectoryOverride = "";
  selfTestHooks.queueModeOverride = "";
  selfTestHooks.queueJobExecutorTestHook = null;
  selfTestHooks.agentRuntimeTestHook = null;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-queue-features.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} queue feature tests failed${skipGateFailed ? "; the skip gate failed" : ""}.\n`);
  process.exit(1);
}
process.stdout.write(`${tests.length - skips.length} of ${tests.length} queue feature tests passed${skips.length ? `, ${skips.length} skipped` : ""}.\n`);
process.exit(0);
