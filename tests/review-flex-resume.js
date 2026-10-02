#!/usr/bin/env node

// Q-008 (log.md, 2026-10-02): surviving a bridge restart. A bridge's agent processes do not outlive
// it (the process supervisor ends the payload when its parent's pipe closes or its heartbeat
// stops), so a job that was running when its client restarted is found by the next bridge as
// `interrupted`. With a retry policy (models / maxAttempts) that bridge now resumes it as its next
// attempt through the retry policy (Q-007), with the job's own full timeout; without a policy, or
// with CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED=false, it stays interrupted for requeue_opencode_job.
// The dead owner is simulated on the durable row in a scratch state directory.
//   node tests/review-flex-resume.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED;
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { hooks, internals } = __selfTest;
const { CONFIG, QUEUE_JOBS, assert, closeDb, enqueueQueueJob, openLockDb, reconcileStaleQueueRecords } = internals;

const MUSE = "opencode/muse-spark-1.3-contributor-free@high";
const GEMINI = "google/antigravity-gemini-3.8-flash@high";
hooks.selfTestModelOverrideAllowlist = [MUSE, GEMINI];
const fixture = await makeFlexFixture(__selfTest, "review-flex-resume");
const { repo, waitFor, durable, execution, readJob, sleep } = fixture;

const requests = [];
hooks.queueJobExecutorTestHook = async (request) => {
  requests.push(request);
  return execution({ configuredProvider: request.scopeContract?.modelRequirement?.provider || "", configuredModel: request.scopeContract?.modelRequirement?.model || "" });
};

// Enqueues a job without starting it, then makes its durable row look like a job a dead bridge was
// running: status running, another owner instance with no live lease, an expired job lease.
async function interruptedByDeadOwner(job) {
  const enqueued = await enqueueQueueJob(job, "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  QUEUE_JOBS.delete(jobId);
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  const db = await openLockDb(repo);
  try {
    db.prepare(`UPDATE opencode_jobs SET status = 'running', owner_instance_id = 'dead-bridge-instance', owner_process_id = 999999,
      owner_generation = 'dead-generation', started_at = ?, heartbeat_at = ?, lease_expires_at = ?, revision = revision + 1 WHERE job_id = ?`).run(past, past, past, jobId);
    const reconciled = reconcileStaleQueueRecords(db, Date.now());
    assert.ok(reconciled.includes(jobId), "the recovery pass of the next bridge finds the job");
  } finally {
    closeDb(db);
  }
  return jobId;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-008: a policy job that a restart interrupted is resumed as its next attempt with its full timeout", async () => {
  requests.length = 0;
  const jobId = await interruptedByDeadOwner(readJob({ task: "resume me", models: [MUSE, GEMINI], timeoutMs: 1_234_000 }));
  assert.ok(await waitFor(async () => Boolean((await durable(jobId))?.requeuedAs)), "requeued by the retry policy");
  const original = await durable(jobId);
  assert.equal(original.status, "interrupted");
  assert.equal(original.errorType, "queue_job_interrupted");
  const resumed = await durable(original.requeuedAs);
  assert.ok(await waitFor(async () => (await durable(original.requeuedAs))?.status === "completed"));
  assert.equal(resumed.retryAttempt, 2);
  assert.match(resumed.attemptHistory[0], new RegExp(`^${jobId} .* queue_job_interrupted$`));
  const request = requests.find((item) => item.task === "resume me");
  assert.ok(request, "the resumed attempt ran");
  assert.equal(request.timeoutMs, 1_234_000, "a fresh run gets the job's whole timeout, not a remainder");
  assert.equal(request.scopeContract.modelRequirement.model, "antigravity-gemini-3.8-flash", "the next model in order");
});

test("Q-008: a job without a policy stays interrupted for requeue_opencode_job", async () => {
  requests.length = 0;
  const jobId = await interruptedByDeadOwner(readJob({ task: "no policy" }));
  await sleep(500);
  const record = await durable(jobId);
  assert.equal(record.status, "interrupted");
  assert.equal(record.requeuedAs || "", "");
  assert.equal(requests.length, 0);
});

test("Q-008: CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED=false leaves a policy job interrupted", async () => {
  assert.equal(CONFIG.autoResumeInterrupted, true, "on by default");
  hooks.autoResumeInterruptedOverride = false;
  try {
    const jobId = await interruptedByDeadOwner(readJob({ task: "resume disabled", models: [MUSE] }));
    await sleep(500);
    const record = await durable(jobId);
    assert.equal(record.status, "interrupted");
    assert.equal(record.requeuedAs || "", "");
    assert.equal(record.completionOutcome || "", "", "not gave_up either");
  } finally {
    hooks.autoResumeInterruptedOverride = null;
  }
});

test("Q-008: the resume counts against maxAttempts, so a job that keeps being interrupted gives up", async () => {
  const jobId = await interruptedByDeadOwner(readJob({ task: "interrupted at the last attempt", models: [MUSE], maxAttempts: 1 }));
  assert.ok(await waitFor(async () => (await durable(jobId))?.completionOutcome === "gave_up"));
  assert.equal((await durable(jobId)).requeuedAs || "", "");
});

await runFlexTests({ file: "tests/review-flex-resume.js", tests, cleanup: async () => { hooks.selfTestModelOverrideAllowlist = null; await fixture.cleanup(); }, finishSkips, label: "restart resume" });
