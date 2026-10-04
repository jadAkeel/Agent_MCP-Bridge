#!/usr/bin/env node

// Queue cost fixes (log.md B-165..B-169, 2026-10-04): what a day of 330 queued jobs cost without
// running a model. B-165: an attestation failure (agent metadata, managed skill, external plugins:
// OpenCode reads that timed out under load) is retried on the same model after 45 s, 90 s, 180 s,
// not counted, instead of ending the job at attempt 1. B-166: a client bridge's recovery pass no
// longer opens a live queue worker's database every 5 s. B-167: queue-worker.js --cancel-pending.
// B-168: one --enqueue/--add file resolves its repository root once per directory and shares one
// connection for the idempotency checks. B-169: a rate limit before any output is a pause wait, not
// an attempt.
// The real scheduler, SQLite queue and retry policy run in a scratch state directory; only
// the agent execution is the queue executor test hook.
//   node tests/review-queue-cost.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS = "200";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_OPS_LOG;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-queue-cost");
const { __selfTest, queueWorkerApi } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { runQueueWorker } = await import("../bin/queue-worker.js");
const { hooks, internals } = __selfTest;
const { QUEUE_JOBS, assert, closeDb, enqueueQueueJob, mkdir, openLockDb, path, pauseProvider, resumeProvider, scheduleQueue } = internals;
const { existsSync, rmSync, writeFileSync } = await import("node:fs");

const MUSE = "opencode/muse-spark-1.3-contributor-free@high";
const GEMINI = "google/antigravity-gemini-3.8-flash@high";
hooks.selfTestModelOverrideAllowlist = [MUSE, GEMINI];
const fixture = await makeFlexFixture(__selfTest, "review-queue-cost");
const { repo, waitFor, durable, readJob, callTool, sleep } = fixture;

// The executor: per task a list of outcomes (the last one repeats); every call is recorded.
const calls = [];
const outcomes = new Map();
const failure = (request, errorType, extra = {}) => {
  const requirement = request.scopeContract?.modelRequirement || {};
  return {
    response: { content: [{ type: "text", text: `Job failed.\nerrorType: ${errorType}` }] },
    result: { errorType, changedFiles: [], configuredProvider: requirement.provider || "", configuredModel: requirement.model || "", ...extra },
    validation: null,
    worktree: null,
  };
};
const success = (request) => ({
  response: { content: [{ type: "text", text: `REPORT: ${request.task} done.` }] },
  result: { errorType: "", changedFiles: [], configuredProvider: request.scopeContract?.modelRequirement?.provider || "", configuredModel: request.scopeContract?.modelRequirement?.model || "" },
  validation: null,
  worktree: null,
});
hooks.queueJobExecutorTestHook = async (request) => {
  const requirement = request.scopeContract?.modelRequirement || {};
  calls.push({ task: request.task, model: requirement.model ? `${requirement.provider}/${requirement.model}` : "profile" });
  const list = outcomes.get(request.task) || [];
  const index = calls.filter((call) => call.task === request.task).length - 1;
  const outcome = list[Math.min(index, list.length - 1)];
  if (!outcome) return success(request);
  return await outcome(request);
};
const retryJob = (task, key) => readJob({ task, idempotencyKey: key, models: [MUSE, GEMINI], maxAttempts: 8 });
const sameDbPath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const secondsUntil = (iso) => (Date.parse(iso) - Date.now()) / 1000;
async function successorOf(jobId, timeoutMs = 15_000) {
  assert.ok(await waitFor(async () => Boolean((await durable(jobId))?.requeuedAs), timeoutMs), `job ${jobId} was not requeued: ${JSON.stringify(await durable(jobId))}`);
  const next = (await durable(jobId)).requeuedAs;
  assert.ok(await waitFor(async () => Boolean(await durable(next))), `the successor ${next} is not persisted`);
  return await durable(next);
}
async function releaseWait(jobId) {
  const record = QUEUE_JOBS.get(jobId);
  assert.ok(record, `job ${jobId} is not held by this process`);
  delete record.startAfter;
  delete record.startAfterReason;
  scheduleQueue();
}
async function setJobStatus(jobId, status) {
  const db = await openLockDb(repo);
  try {
    db.prepare("UPDATE opencode_jobs SET status = ?, record_json = json_set(record_json, '$.status', ?) WHERE job_id = ?").run(status, status, jobId);
  } finally {
    closeDb(db);
  }
}
async function rowOf(jobId) {
  const db = await openLockDb(repo);
  try {
    return db.prepare("SELECT status, cancellation_requested_at, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
  } finally {
    closeDb(db);
  }
}
function runCli(args) {
  const out = { text: "", write(chunk) { this.text += chunk; return true; } };
  const err = { text: "", write(chunk) { this.text += chunk; return true; } };
  return runQueueWorker(args, { out, err, signals: false, importServer: async () => ({ queueWorkerApi }) }).then((code) => ({ code, out: out.text, err: err.text }));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// B-166 first: it needs a state directory whose only queue is quiet.

test("B-166: a live foreign worker's database is not opened and does not keep the pass busy; a stale presence reopens it", async () => {
  closeDb(await openLockDb(repo));
  const dbPath = internals.stateDbPath(repo);
  await internals.reconcileQueueStateAtStartup();
  const files = queueWorkerApi.files(repo);
  await mkdir(files.directory, { recursive: true });
  const presence = { version: 1, pid: process.pid, instanceId: "another-worker-instance", projectKey: files.projectKey, repo, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  writeFileSync(files.presence, JSON.stringify(presence), "utf8");
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      // The worker writes its database between the passes (here: an open, which upserts this
      // instance's lease row); the size/mtime fingerprint changes, the pass still skips it.
      closeDb(await openLockDb(repo));
      await internals.reconcileQueueStateAtStartup();
      const last = internals.deferredRecoveryLastPass();
      assert.ok(last.skippedWorkerDbPaths.some((item) => sameDbPath(item, dbPath)), `skipped: ${JSON.stringify(last)}`);
      assert.equal(last.openedDbPaths.some((item) => sameDbPath(item, dbPath)), false, "the worker's database was not opened");
      assert.equal(last.busy, false, "a live worker does not keep the pass at the busy interval");
    }
    // The worker died: its heartbeat is older than 2 minutes, the next pass opens and reconciles.
    writeFileSync(files.presence, JSON.stringify({ ...presence, heartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString() }), "utf8");
    await internals.reconcileQueueStateAtStartup();
    const last = internals.deferredRecoveryLastPass();
    assert.ok(last.openedDbPaths.some((item) => sameDbPath(item, dbPath)), `opened once the presence is stale: ${JSON.stringify(last)}`);
    assert.equal(last.skippedWorkerDbPaths.length, 0);
  } finally {
    rmSync(files.presence, { force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// B-165: attestation failures.

test("B-165: an attestation failure is retried on the same model after 45 s, 90 s, 180 s, not counted; the fourth one ends the job", async () => {
  const task = "Review for infra.";
  outcomes.set(task, [(request) => failure(request, "agent_metadata_unavailable")]);
  const first = await enqueueQueueJob(retryJob(task, "cost-infra-1"));
  assert.equal(first.ok, true, first.error);
  let current = first.record.jobId;
  for (const [index, seconds] of [[1, 45], [2, 90], [3, 180]]) {
    const next = await successorOf(current);
    assert.equal(next.status, "pending");
    assert.equal(next.retryAttempt, 1, "not counted");
    assert.equal(next.infraRetryRequeues, index);
    assert.equal(next.startAfterReason, "infrastructure_retry");
    assert.equal(next.runStage, "waiting_for_infrastructure_retry");
    const wait = secondsUntil(next.startAfter);
    assert.ok(wait > seconds - 10 && wait <= seconds + 1, `waits about ${seconds} s, got ${wait.toFixed(1)} s`);
    assert.equal(`${next.scopeContract?.modelRequirement?.provider}/${next.scopeContract?.modelRequirement?.model}`, "opencode/muse-spark-1.3-contributor-free", "the same model");
    assert.match(next.attemptHistory.at(-1), /agent_metadata_unavailable \(not counted: the bridge could not attest the role\)$/);
    await releaseWait(next.jobId);
    current = next.jobId;
  }
  assert.ok(await waitFor(async () => (await durable(current))?.status === "failed", 15_000), "the fourth run fails");
  await sleep(300);
  const last = await durable(current);
  assert.equal(last.errorType, "agent_metadata_unavailable");
  assert.equal(last.requeuedAs, "", "after 3 infrastructure retries the job ends as before");
  assert.equal(last.completionOutcome, "");
  assert.equal(last.retryAttempt, 1);
  assert.deepEqual(calls.filter((call) => call.task === task).map((call) => call.model), Array(4).fill("opencode/muse-spark-1.3-contributor-free"));
});

// ---------------------------------------------------------------------------------------------
// B-169: rate limits before any output.

test("B-169: a rate limit with no output is not counted and waits for the pause; one after output counts", async () => {
  const quiet = "Review for limit-quiet.";
  outcomes.set(quiet, [async (request) => {
    // What opencode-run does on a rate limit: the model is paused (here both candidates).
    assert.equal((await pauseProvider({ provider: "opencode/muse-spark-1.3-contributor-free", minutes: 30 })).ok, true);
    assert.equal((await pauseProvider({ provider: "google", minutes: 20 })).ok, true);
    return failure(request, "provider_rate_limited", { usage: { steps: 0, outputCount: 0 }, assistantFinalResponseDetected: false });
  }]);
  const loud = "Review for limit-loud.";
  outcomes.set(loud, [(request) => failure(request, "provider_rate_limited", { usage: { steps: 3, outputCount: 1200 }, assistantFinalResponseDetected: false }), (request) => success(request)]);
  try {
    const first = await enqueueQueueJob(retryJob(quiet, "cost-limit-quiet"));
    assert.equal(first.ok, true, first.error);
    const next = await successorOf(first.record.jobId);
    assert.equal(next.retryAttempt, 1, "not counted");
    assert.equal(next.pauseWaitRequeues, 1);
    assert.equal(next.startAfterReason, "provider_pause");
    const wait = secondsUntil(next.startAfter);
    assert.ok(wait > 18 * 60 && wait <= 20 * 60 + 1, `waits for the earliest pause (20 min), got ${wait.toFixed(0)} s`);
    assert.match(next.attemptHistory.at(-1), /provider_rate_limited \(not counted: the model was rate-limited before it produced output\)$/);
    await callTool("cancel_opencode_job", { cwd: repo, jobId: next.jobId });
  } finally {
    await resumeProvider({ provider: "opencode" });
    await resumeProvider({ provider: "google" });
  }
  const second = await enqueueQueueJob(retryJob(loud, "cost-limit-loud"));
  assert.equal(second.ok, true, second.error);
  const counted = await successorOf(second.record.jobId);
  assert.equal(counted.retryAttempt, 2, "a run that produced output is an attempt");
  assert.equal(counted.pauseWaitRequeues, 0);
  assert.doesNotMatch(counted.attemptHistory.at(-1), /not counted/);
  assert.ok(await waitFor(async () => (await durable(counted.jobId))?.status === "completed", 15_000), "the retry runs");
});

// ---------------------------------------------------------------------------------------------
// B-167: --cancel-pending.

test("B-167: --cancel-pending lists without --apply, cancels only the listed statuses with it, never a started job", async () => {
  const ids = {};
  for (const [key, initialStatus] of [["bulk-a-1", "pending"], ["bulk-a-2", "pending"], ["bulk-a-3", "held"], ["bulk-b-1", "pending"]]) {
    const enqueued = await enqueueQueueJob(readJob({ task: `Review for ${key}.`, idempotencyKey: key }), "", { schedule: false, unowned: true, initialStatus });
    assert.equal(enqueued.ok, true, enqueued.error);
    ids[key] = enqueued.record.jobId;
  }
  const dry = await runCli(["--repo", repo, "--cancel-pending", "--key-prefix", "bulk-a"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^Dry run: 3 job\(s\) of .* match \(status held,pending,planned,blocked, idempotencyKey prefix "bulk-a"\); nothing was changed\. Add --apply to cancel them\./);
  assert.match(dry.out, new RegExp(`${ids["bulk-a-1"]}  pending  bulk-a-1`));
  for (const id of Object.values(ids)) assert.notEqual((await rowOf(id)).status, "cancelled", "the dry run changed nothing");
  const json = await runCli(["--repo", repo, "--cancel-pending", "--key-prefix", "bulk-", "--json"]);
  assert.equal(JSON.parse(json.out).matched, 4);

  const applied = await runCli(["--repo", repo, "--cancel-pending", "--key-prefix", "bulk-a", "--status", "pending", "--apply"]);
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /^Cancelled 2 of 2 matching job\(s\) of .* \(status pending, idempotencyKey prefix "bulk-a"\)\./);
  for (const key of ["bulk-a-1", "bulk-a-2"]) {
    const record = await durable(ids[key]);
    assert.equal(record.status, "cancelled");
    assert.equal(record.errorReason, "operator bulk cancel (queue-worker --cancel-pending)");
  }
  assert.equal((await rowOf(ids["bulk-a-3"])).status, "held", "held was not in --status");
  assert.equal((await rowOf(ids["bulk-b-1"])).status, "pending", "another prefix");

  const running = await runCli(["--repo", repo, "--cancel-pending", "--status", "pending,running"]);
  assert.equal(running.code, 1);
  assert.match(running.err, /never cancels a started job; drop running/);
  const combined = await runCli(["--repo", repo, "--cancel-pending", "--until-empty"]);
  assert.equal(combined.code, 1);
  assert.match(combined.err, /--cancel-pending starts no worker/);

  // A job that started between the listing and the cancel is left alone.
  await setJobStatus(ids["bulk-b-1"], "running");
  assert.deepEqual(await queueWorkerApi.cancelUnstartedJobs([ids["bulk-b-1"]], "x", { repo, unstartedOnly: true }), []);
  const untouched = await rowOf(ids["bulk-b-1"]);
  assert.equal(untouched.status, "running");
  assert.equal(untouched.cancellation_requested_at || "", "", "no cancellation was requested");
  await setJobStatus(ids["bulk-b-1"], "pending");
  const rest = await runCli(["--repo", repo, "--cancel-pending", "--key-prefix", "bulk-", "--apply"]);
  assert.match(rest.out, /^Cancelled 2 of 2 /);
});

// ---------------------------------------------------------------------------------------------
// B-168: the batched --enqueue path decides as the plain one.

test("B-168: the batched check decides every line as the unbatched check (new, conflicting key, refused plan, duplicate)", async () => {
  const existing = readJob({ task: "Review for d-dup.", idempotencyKey: "d-dup" });
  assert.equal((await enqueueQueueJob(existing, "", { schedule: false, unowned: true })).ok, true);
  const lines = [
    readJob({ task: "Review for d-new.", idempotencyKey: "d-new" }),
    readJob({ task: "Other content for d-dup.", idempotencyKey: "d-dup" }),
    { ...readJob({ task: "Write for d-bad.", idempotencyKey: "d-bad" }), agent: "builder", write: true, lockMode: "simple", lockedPaths: ["src"], allowedEdits: ["other/x.txt"], scopeContract: undefined },
    existing,
  ];
  const decision = (result) => ({ ok: result.ok, errorType: result.errorType || "", deduplicates: result.deduplicates || "" });
  const plain = [];
  for (const job of lines) plain.push(decision(await queueWorkerApi.checkJob(job, { repo })));
  const batched = await queueWorkerApi.withEnqueueBatch(async (batch) => {
    const results = [];
    for (const job of lines) results.push(decision(await queueWorkerApi.checkJob(job, { repo, batch })));
    // The cache answers what git answers.
    assert.equal(await internals.resolveProjectStateRoot(repo), repo);
    const enqueued = await queueWorkerApi.enqueueFromToolInput(lines[0], { repo, unowned: true, batch });
    assert.equal(enqueued.ok, true, enqueued.error);
    results.push(enqueued.record.jobId);
    return results;
  });
  const enqueuedId = batched.pop();
  assert.deepEqual(batched, plain);
  assert.deepEqual(plain.map((item) => item.ok), [true, false, false, true]);
  assert.equal(plain[1].errorType, "queue_idempotency_conflict");
  assert.ok(plain[2].errorType, "the refused plan names its error");
  assert.ok(plain[3].deduplicates, "the duplicate names the existing job");
  assert.equal((await durable(enqueuedId))?.status, "pending");
  assert.equal(await internals.resolveProjectStateRoot(repo), repo, "after the batch the root is resolved afresh");
  await queueWorkerApi.cancelUnstartedJobs([enqueuedId, plain[3].deduplicates], "test cleanup", { repo });
});

await runFlexTests({ file: "tests/review-queue-cost.js", tests, cleanup: fixture.cleanup, finishSkips, label: "queue cost", isolatedStateDir });
