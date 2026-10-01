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
