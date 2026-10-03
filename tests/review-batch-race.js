#!/usr/bin/env node

// Batch-run fixes (log.md B-150..B-154, B-156, 2026-10-03): what a 73-job triage run with
// autoIntegrate and parallel writers broke. B-150: a commit landing while a worktree is created no
// longer fails the job (accepted when the commits are outside the job's scope, else the worktree
// is created again from the new HEAD). B-151: under unrelated_ok, uncommitted files in the READ
// scope do not block a writer. B-152: a queued job whose workspace is not ready waits (blocked)
// instead of failing. B-153: an auto-integration whose commit races another commit is rebased
// once more; files already in HEAD are "already committed"; a removed worktree is named as such.
// B-154: a committed auto-integration removes its worktree, and the recovery pass sweeps the ones
// left behind. B-156: the recovery pass releases the hard lock of a job whose owner died.
//   node tests/review-batch-race.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_SOURCE_DIRT_POLICY = "unrelated_ok";
process.env.CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS = "200";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_AUTO_INTEGRATE;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-batch-race");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { hooks, internals } = __selfTest;
const {
  QUEUE_JOBS, acquireHardLock, assert, autoIntegrateQueueJob, cleanupWorktree, closeDb, createWorktreeForJob, enqueueQueueJob,
  inspectSourceCheckpointState, mkdir, openLockDb, path, reconcileStaleQueueRecords, releaseHardLock, sweepCommittedWorktrees, writeFile,
} = internals;
const { existsSync, readFileSync, rmSync } = await import("node:fs");

const fixture = await makeFlexFixture(__selfTest, "review-batch-race");
const { root, repo, git, identity, waitFor, durable, writeScope, execution, writeJob } = fixture;
await mkdir(path.join(repo, "tools"), { recursive: true });
await writeFile(path.join(repo, "tools", "check.cjs"), "process.exit(0);\n", "utf8");
await git(["add", "."]);
await git([...identity, "commit", "-q", "-m", "add the checker"]);
const VALIDATION = "node tools/check.cjs";
const head = async (cwd = repo) => (await git(["rev-parse", "HEAD"], cwd)).trim();
const commitFile = async (relative, content, message) => {
  await mkdir(path.dirname(path.join(repo, ...relative.split("/"))), { recursive: true });
  await writeFile(path.join(repo, ...relative.split("/")), content, "utf8");
  await git(["add", "--", relative]);
  await git([...identity, "commit", "-q", "-m", message]);
  return head();
};

// Auto-integration harness (like tests/review-flex-auto-integrate.js): a builder's worktree with
// uncommitted new files, and a fake agent that reports it.
let worktrees = 0;
async function builderWorktree(edits) {
  worktrees += 1;
  const dir = path.join(root, `wt-${worktrees}`);
  await git(["worktree", "add", "-q", "-b", `agent/builder/wt-${worktrees}`, dir, "HEAD"]);
  for (const [relative, content] of Object.entries(edits)) {
    await mkdir(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
    await writeFile(path.join(dir, ...relative.split("/")), content, "utf8");
  }
  return dir;
}
const autoJob = (file, extra = {}) => ({
  agent: "builder", task: `Write ${file}.`, cwd: repo, write: true, lockMode: "simple",
  lockedPaths: [file], allowedEdits: [file], validationCommand: VALIDATION, timeoutMs: 600000,
  scopeContract: { ...writeScope(file), validationCommand: VALIDATION }, autoIntegrate: true, ...extra,
});
const worktreeOf = new Map();
const plainExecutions = new Map();
hooks.queueJobExecutorTestHook = async (request) => {
  const plain = plainExecutions.get(request.task);
  if (plain) return await plain(request);
  const planned = worktreeOf.get(request.task);
  const diff = await internals.collectWorktreeDiff({ path: planned.dir, baseCommit: "" });
  if (planned.afterFinish) await planned.afterFinish(planned.dir);
  return {
    response: { content: [{ type: "text", text: "REPORT: wrote the batch." }] },
    result: { errorType: "", changedFiles: planned.changed, configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free", worktree: { patchSha256: diff.patchSha256, sourceStateSha256: diff.sourceStateSha256 } },
    validation: { status: "passed" },
    worktree: { path: planned.dir, branch: "", baseCommit: diff.sourceBaseCommit, baseTree: "" },
  };
};
async function runAutoJob(file, edits, extra = {}, afterFinish = null) {
  const dir = await builderWorktree(edits);
  const request = autoJob(file, extra);
  worktreeOf.set(request.task, { dir, changed: Object.keys(edits), afterFinish });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, `${enqueued.errorType}: ${enqueued.error}`);
  const jobId = enqueued.record.jobId;
  const settled = (status) => Boolean(status) && !["waiting_for_lock", "integrating"].includes(status);
  const finished = await waitFor(async () => settled((await durable(jobId))?.autoIntegration?.status), 120_000);
  if (!finished) {
    const record = await durable(jobId);
    assert.fail(`the auto-integration of ${file} did not finish: status=${record?.status} error=${record?.errorType} autoIntegration=${JSON.stringify(record?.autoIntegration)}`);
  }
  return { jobId, dir, record: await durable(jobId) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// B-151: the source-dirt policy and the read scope.

test("B-151: under unrelated_ok an uncommitted file in the READ scope is tolerated and reported; the write scope still blocks", async () => {
  await writeFile(path.join(repo, "tools", "ledger-facts.cjs"), "// untracked\n", "utf8");
  try {
    const contract = { scope: { read: ["tools"], write: ["out/x.json"], forbidden: [] }, allowedEdits: ["out/x.json"], shared: [], serialOnly: [] };
    const tolerated = await inspectSourceCheckpointState(repo, { lockedPaths: ["out/x.json"], allowedEdits: ["out/x.json"], scopeContract: contract, policy: "unrelated_ok" });
    assert.equal(tolerated.ok, true, tolerated.error);
    assert.deepEqual(tolerated.toleratedReadScopeFiles, ["tools/ledger-facts.cjs"]);
    assert.deepEqual(tolerated.toleratedDisjointFiles, ["tools/ledger-facts.cjs"]);
    assert.equal(tolerated.sourceDirtPolicy, "unrelated_ok");
    const strict = await inspectSourceCheckpointState(repo, { lockedPaths: ["out/x.json"], allowedEdits: ["out/x.json"], scopeContract: contract, policy: "strict" });
    assert.equal(strict.ok, false, "strict refuses any dirt");
    assert.equal(strict.errorType, "dirty_worktree_requires_checkpoint");
    const writeScoped = { ...contract, scope: { ...contract.scope, write: ["tools", "out/x.json"] } };
    const blocked = await inspectSourceCheckpointState(repo, { lockedPaths: ["out/x.json"], allowedEdits: ["out/x.json"], scopeContract: writeScoped, policy: "unrelated_ok" });
    assert.equal(blocked.ok, false, "a dirty file in the write scope still blocks");
    assert.deepEqual(blocked.conflictingPaths, ["tools/ledger-facts.cjs"]);
    assert.match(blocked.error, /inside this job's locked\/allowed scope \(tools\/ledger-facts\.cjs\)/);
  } finally {
    rmSync(path.join(repo, "tools", "ledger-facts.cjs"), { force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// B-150: HEAD moves while the worktree is being created.

test("B-150: a commit outside the job's scope during worktree creation is accepted; the worktree keeps its base", async () => {
  const before = await head();
  let moved = "";
  hooks.worktreeCreateTestHook = async ({ attempt }) => {
    if (attempt === 0) moved = await commitFile("notes/unrelated.txt", "unrelated\n", "another job's auto-integration");
  };
  let worktree = null;
  try {
    worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-race-accept", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
    assert.equal(worktree.ok, true, `${worktree.errorType}: ${worktree.error}`);
    assert.equal(worktree.baseCommit, before, "the base is the HEAD read before the add");
    assert.ok(worktree.headMovedDuringCreation, "the move is recorded");
    assert.equal(worktree.headMovedDuringCreation.from, before);
    assert.equal(worktree.headMovedDuringCreation.to, moved);
    assert.equal(worktree.headMovedDuringCreation.changedFiles, 1);
    assert.equal(worktree.recreatedAfterHeadMove, 0);
    assert.equal(await head(worktree.path), before, "the worktree is at the recorded base");
    assert.match(internals.formatWorktreeSummary(worktree), /repository HEAD moved during creation .* 1 file\(s\) outside the job's scope/);
  } finally {
    hooks.worktreeCreateTestHook = null;
    if (worktree?.ok) await cleanupWorktree(worktree, "always", true);
  }
});

test("B-150: a commit inside the job's scope during worktree creation recreates the worktree from the new HEAD", async () => {
  let moved = "";
  hooks.worktreeCreateTestHook = async ({ attempt }) => {
    if (attempt === 0) moved = await commitFile("src/a.txt", "a changed by a colleague\n", "a commit in the job's scope");
  };
  let worktree = null;
  try {
    worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-race-recreate", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
    assert.equal(worktree.ok, true, `${worktree.errorType}: ${worktree.error}`);
    assert.equal(worktree.recreatedAfterHeadMove, 1, "created once more");
    assert.equal(worktree.headMovedDuringCreation, null);
    assert.equal(worktree.baseCommit, moved, "the second attempt started from the new HEAD");
    assert.equal(await head(worktree.path), moved);
    assert.equal(readFileSync(path.join(worktree.path, "src", "a.txt"), "utf8"), "a changed by a colleague\n", "the agent sees the colleague's commit");
    assert.match(internals.formatWorktreeSummary(worktree), /created again 1 time\(s\) after repository HEAD moved/);
  } finally {
    hooks.worktreeCreateTestHook = null;
    if (worktree?.ok) await cleanupWorktree(worktree, "always", true);
    await commitFile("src/a.txt", "a\n", "restore src/a.txt");
  }
});

test("B-150: a HEAD that keeps moving into the scope three times still fails as worktree_source_checkpoint_changed, with nothing left behind", async () => {
  let commits = 0;
  hooks.worktreeCreateTestHook = async () => {
    commits += 1;
    await commitFile("src/a.txt", `moving target ${commits}\n`, `commit ${commits} in the scope`);
  };
  try {
    const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "builder-race-exhausted", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
    assert.equal(worktree.ok, false);
    assert.equal(worktree.errorType, "worktree_source_checkpoint_changed");
    assert.match(worktree.error, /3 times in a row/);
    assert.equal(commits, 3);
    assert.equal(existsSync(worktree.path), false, "the last worktree was removed");
    assert.equal((await internals.runCommand("git", ["for-each-ref", "refs/heads/agent/builder/builder-race-exhausted"], repo, 15_000)).stdout.trim(), "", "no branch left behind");
  } finally {
    hooks.worktreeCreateTestHook = null;
    await commitFile("src/a.txt", "a\n", "restore src/a.txt");
  }
});

// ---------------------------------------------------------------------------------------------
// B-152: the queue waits for the workspace instead of failing the job.

test("B-152: a queued writer refused for uncommitted files in its scope waits (blocked) and runs once the checkout is ready", async () => {
  let calls = 0;
  const request = writeJob("src/b.txt", { task: "Wait for the workspace." });
  plainExecutions.set(request.task, async () => {
    calls += 1;
    if (calls === 1) {
      return {
        response: { content: [{ type: "text", text: "Worktree setup failed.\nerrorType: dirty_worktree_requires_checkpoint" }] },
        result: { errorType: "dirty_worktree_requires_checkpoint", changedFiles: [], dirtyFiles: ["src/b.txt"], overlappingFiles: ["src/b.txt"], disjointFiles: [], conflictingPaths: ["src/b.txt"] },
        validation: null,
        worktree: null,
      };
    }
    return execution({ changedFiles: ["src/b.txt"], configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" });
  });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "blocked", 15_000), `blocked, not failed: ${JSON.stringify(await durable(jobId))}`);
  const blocked = await durable(jobId);
  assert.equal(blocked.errorType, "dirty_worktree_requires_checkpoint");
  assert.equal(blocked.queueWorkspaceWaits, 1);
  assert.match(blocked.errorReason, /uncommitted changes inside this job's write scope \(src\/b\.txt\); commit or revert them and the job runs by itself \(wait 1 of 60/);
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "completed", 20_000), `ran after the wait: ${JSON.stringify(await durable(jobId))}`);
  assert.equal(calls, 2, "the executor ran twice: the refusal, then the run");
  const done = await durable(jobId);
  assert.equal(done.errorType, "");
  assert.equal(done.queueWorkspaceWaits, 1, "the wait count is kept on the record");
});

test("B-152: a refusal for the retained-worktree cap waits too; a cancelled job does not wait", async () => {
  const request = writeJob("src/b.txt", { task: "Wait for the cap." });
  let calls = 0;
  plainExecutions.set(request.task, async () => {
    calls += 1;
    return { response: { content: [{ type: "text", text: "Worktree setup failed." }] }, result: { errorType: "worktree_capacity_exceeded", changedFiles: [] }, validation: null, worktree: null };
  });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "blocked", 15_000));
  const blocked = await durable(jobId);
  assert.equal(blocked.errorType, "worktree_capacity_exceeded");
  assert.match(blocked.errorReason, /retained worktrees of this repository reached their cap/);
  assert.ok(await waitFor(async () => Number((await durable(jobId))?.queueWorkspaceWaits || 0) >= 2, 15_000), "it keeps trying");
  const cancelled = fixture.textOf(await fixture.callTool("cancel_opencode_job", { cwd: repo, jobId }));
  assert.match(cancelled, /cancel/i);
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "cancelled", 15_000), `cancelled: ${JSON.stringify(await durable(jobId))}`);
  assert.ok(calls >= 2);
});

// ---------------------------------------------------------------------------------------------
// B-156: the recovery pass releases a dead owner's hard lock.

test("B-156: reconciling a dead owner's running job releases its hard lock, so a retry is not blocked for the TTL", async () => {
  const lock = await acquireHardLock({ owner: "codex", agent: "builder", task: "a job the dead worker ran", cwd: repo, lockType: "write", paths: ["src/a.txt"], ttlMs: 40 * 60_000, editsCheckout: false });
  assert.equal(lock.ok, true, lock.error);
  const request = writeJob("src/a.txt", { task: "Interrupted with a lock." });
  const enqueued = await enqueueQueueJob(request, "", { schedule: false });
  assert.equal(enqueued.ok, true, enqueued.error);
  const jobId = enqueued.record.jobId;
  QUEUE_JOBS.delete(jobId);
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  const db = await openLockDb(repo);
  try {
    const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    const summary = { ...JSON.parse(row.record_json), status: "running", lockId: lock.lock.id, startedAt: past };
    db.prepare(`UPDATE opencode_jobs SET status = 'running', owner_instance_id = 'dead-worker-instance', owner_process_id = 999999,
      owner_generation = 'dead-generation', started_at = ?, heartbeat_at = ?, lease_expires_at = ?, record_json = ?, revision = revision + 1 WHERE job_id = ?`)
      .run(past, past, past, JSON.stringify(summary), jobId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM locks WHERE run_id = ?").get(lock.lock.id).count, 1, "the dead worker's lock row is there");
    const reconciled = reconcileStaleQueueRecords(db, Date.now());
    assert.ok(reconciled.includes(jobId));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM locks WHERE run_id = ?").get(lock.lock.id).count, 0, "the lock is released with the job");
    assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(lock.lock.id)?.status, "expired");
  } finally {
    closeDb(db);
  }
  const interrupted = await durable(jobId);
  assert.equal(interrupted.status, "interrupted");
  const again = await acquireHardLock({ owner: "codex", agent: "builder", task: "the retry", cwd: repo, lockType: "write", paths: ["src/a.txt"], ttlMs: 60_000, editsCheckout: false });
  assert.equal(again.ok, true, `the path is free at once: ${again.error}`);
  await releaseHardLock(again.lock.id, again.lock.token, again.lock.paths, again.lock.cwd);
  const stale = await releaseHardLock(lock.lock.id, lock.lock.token, lock.lock.paths, lock.lock.cwd);
  assert.equal(stale.ok, false, "the dead owner's token no longer matches a lock");
});

// ---------------------------------------------------------------------------------------------
// B-153 / B-154: auto-integration on a busy target.

test("B-153: a commit that lands between the HEAD read and the move is rebased on, once more, and the job's files are committed", async () => {
  const testHooks = hooks.autoIntegrationTestHooks;
  let unrelated = "";
  testHooks.beforeUpdateRef = async ({ headRetries }) => {
    if (headRetries === 0) unrelated = await commitFile("notes/meanwhile.txt", "meanwhile\n", "the operator commits meanwhile");
  };
  try {
    const before = await head();
    const { record } = await runAutoJob("out/batch-101.json", { "out/batch-101.json": "[101]\n" });
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal(record.autoIntegration.headRetries, 1);
    const after = await head();
    assert.equal(record.autoIntegration.commit, after);
    assert.equal((await git(["log", "-1", "--format=%P"])).trim(), unrelated, "on top of the commit that landed meanwhile");
    assert.equal((await git(["log", "--format=%s", `${before}..HEAD`])).trim().split("\n").length, 2);
    assert.equal((await git(["show", "--name-only", "--format=", "HEAD"])).trim(), "out/batch-101.json");
    assert.equal((await git(["status", "--porcelain"])).trim(), "", "the target is clean");
  } finally {
    testHooks.beforeUpdateRef = null;
  }
});

test("B-153: a path someone else committed meanwhile with other content is not overwritten", async () => {
  const testHooks = hooks.autoIntegrationTestHooks;
  testHooks.beforeUpdateRef = async ({ headRetries }) => {
    if (headRetries === 0) await commitFile("out/batch-102.json", "[\"someone else\"]\n", "someone else lands the same path");
  };
  try {
    const { record } = await runAutoJob("out/batch-102.json", { "out/batch-102.json": "[102]\n" });
    assert.equal(record.autoIntegration.status, "applied_not_committed", JSON.stringify(record.autoIntegration));
    assert.equal(record.autoIntegration.errorType, "auto_integration_path_committed_meanwhile");
    assert.equal((await git(["show", "HEAD:out/batch-102.json"])).trim(), "[\"someone else\"]", "HEAD keeps the other commit");
  } finally {
    testHooks.beforeUpdateRef = null;
    await git(["checkout", "--", "out/batch-102.json"]).catch(() => {});
  }
});

test("B-153: files already in HEAD with the worktree's exact content are 'already committed' and the worktree goes", async () => {
  const before = await head();
  const { record, dir } = await runAutoJob("out/batch-103.json", { "out/batch-103.json": "[103]\n" }, {},
    // Between the job's end and its integration: the operator lands the file by hand.
    async () => { await commitFile("out/batch-103.json", "[103]\n", "Land the verdict files left in bridge worktrees"); });
  assert.equal(record.autoIntegration.status, "already_committed", JSON.stringify(record.autoIntegration));
  assert.deepEqual(record.autoIntegration.files, ["out/batch-103.json"]);
  assert.notEqual(await head(), before);
  assert.equal(record.autoIntegration.commit, await head());
  assert.equal(existsSync(dir), false, `the worktree is removed: ${record.autoIntegration.worktreeCleanup}`);
  assert.match(record.autoIntegration.worktreeCleanup, /^success/);
});

test("B-153: a worktree removed by hand before the integration is named, not 'spawn git ENOENT'", async () => {
  const { record, dir } = await runAutoJob("out/batch-104.json", { "out/batch-104.json": "[104]\n" }, {},
    async (worktree) => { rmSync(worktree, { recursive: true, force: true }); });
  assert.equal(existsSync(dir), false);
  assert.equal(record.autoIntegration.status, "failed", JSON.stringify(record.autoIntegration));
  assert.equal(record.autoIntegration.errorType, "integration_source_missing");
  assert.match(record.autoIntegration.error, /no longer exists/);
  await git(["worktree", "prune"]);
});

test("B-154: when the engine keeps the worktree after the commit, the bridge removes it itself", async () => {
  const testHooks = hooks.autoIntegrationTestHooks;
  testHooks.skipEngineCleanup = true;
  try {
    const { record, dir } = await runAutoJob("out/batch-105.json", { "out/batch-105.json": "[105]\n" });
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal(existsSync(dir), false, `removed after the commit: ${record.autoIntegration.worktreeCleanup}`);
    assert.match(record.autoIntegration.worktreeCleanup, /after commit: success/);
    assert.equal((await git(["for-each-ref", `refs/heads/agent/builder/${path.basename(dir)}`])).trim(), "", "its branch went with it");
  } finally {
    testHooks.skipEngineCleanup = false;
  }
});

test("B-154: the recovery pass sweeps the worktree of a committed job that a crash left behind", async () => {
  const testHooks = hooks.autoIntegrationTestHooks;
  testHooks.skipEngineCleanup = true;
  testHooks.skipPostCommitCleanup = true;
  let dir = "";
  let jobId = "";
  try {
    ({ dir, jobId } = await runAutoJob("out/batch-106.json", { "out/batch-106.json": "[106]\n" }));
    assert.equal((await durable(jobId)).autoIntegration.status, "committed");
    assert.equal(existsSync(dir), true, "left behind");
  } finally {
    testHooks.skipEngineCleanup = false;
    testHooks.skipPostCommitCleanup = false;
  }
  const db = await openLockDb(repo);
  try {
    assert.equal(await sweepCommittedWorktrees(db), 1, "one worktree swept");
    assert.equal(await sweepCommittedWorktrees(db), 0, "once per path");
  } finally {
    closeDb(db);
  }
  assert.equal(existsSync(dir), false);
  assert.match((await durable(jobId)).autoIntegration.worktreeCleanup, /after commit \(recovery pass\): success/);
});

await runFlexTests({ isolatedStateDir, file: "tests/review-batch-race.js", tests, cleanup: fixture.cleanup, finishSkips, label: "batch-race" });
