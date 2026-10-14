#!/usr/bin/env node

// Q-010 (log.md, 2026-10-02): auto-integration of new-file-only patches. A queued writer with
// autoIntegrate: true whose finished patch only adds files is integrated by the bridge itself
// (dry run + receipt-bound apply of the integrate_opencode_worktree engine, validation in the
// target, rollback) and committed by pathspec with the target's configured identity, else the
// identity of the target's last commit (B-125; these repositories configure none); any
// other patch stays for the reviewed flow. The worktrees are real git worktrees in a scratch
// folder; only the agent run is the queue executor test hook.
//   node tests/review-flex-auto-integrate.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_AUTO_INTEGRATE;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-auto-integrate");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { hooks, internals } = __selfTest;
const { AUTO_INTEGRATION_CHAINS, assert, autoIntegrateJobError, autoIntegrateQueueJob, enqueueQueueJob, mkdir, patchFileEntries, path, writeFile } = internals;
const { existsSync, readFileSync } = await import("node:fs");

const fixture = await makeFlexFixture(__selfTest, "review-flex-auto-integrate");
const { root, repo, git, identity, waitFor, durable, callTool, textOf, writeScope } = fixture;
// The target's validation: fails when any file under out/ contains BAD.
await mkdir(path.join(repo, "tools"), { recursive: true });
await writeFile(path.join(repo, "tools", "check.cjs"), [
  "const fs = require('fs'); const path = require('path');",
  "const dir = path.join(process.cwd(), 'out');",
  "if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) { if (fs.readFileSync(path.join(dir, name), 'utf8').includes('BAD')) { console.error('bad batch ' + name); process.exit(1); } }",
  "",
].join("\n"), "utf8");
await git(["add", "."]);
await git(["-c", "user.name=Batch Owner", "-c", "user.email=owner@example.invalid", "commit", "-q", "-m", "add the checker"]);
const VALIDATION = "node tools/check.cjs";
const issues = () => { const file = path.join(fixture.stateDir, "logs", "issues.md"); return existsSync(file) ? readFileSync(file, "utf8") : ""; };

let worktrees = 0;
const worktreeBaseCommits = new Map();
// What a builder leaves: a worktree of HEAD with its edits, uncommitted.
async function builderWorktree(edits) {
  worktrees += 1;
  const dir = path.join(root, `wt-${worktrees}`);
  // Like a bridge writer worktree: its own branch, so cleanup can verify and remove it.
  await git(["worktree", "add", "-q", "-b", `agent/builder/wt-${worktrees}`, dir, "HEAD"]);
  worktreeBaseCommits.set(dir, (await git(["rev-parse", "HEAD"], dir)).trim());
  for (const [relative, content] of Object.entries(edits)) {
    await mkdir(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
    await writeFile(path.join(dir, ...relative.split("/")), content, "utf8");
  }
  return dir;
}
const job = (file, extra = {}) => ({
  agent: "builder", task: `Write ${file}.`, cwd: repo, write: true, lockMode: "simple",
  lockedPaths: [path.posix.dirname(file)], allowedEdits: [file], validationCommand: VALIDATION, timeoutMs: 600000,
  scopeContract: { ...writeScope(file), validationCommand: VALIDATION }, autoIntegrate: true, ...extra,
});
const worktreeOf = new Map();
hooks.queueJobExecutorTestHook = async (request, { jobId }) => {
  const planned = worktreeOf.get(request.task);
  if (planned.beforeFinish) await planned.beforeFinish(planned.dir);
  const branch = (await git(["branch", "--show-current"], planned.dir)).trim();
  const db = await internals.openLockDb(repo);
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO worktree_artifacts (worktree_path, cwd, branch, job_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'retained', ?, ?)`).run(path.resolve(planned.dir), path.resolve(repo), branch, jobId, now, now);
  } finally { internals.closeDb(db); }
  // B-114: like executeOpenCodeJob, the result carries the patch identity the job finished with.
  const diff = await internals.collectWorktreeDiff({ path: planned.dir, baseCommit: worktreeBaseCommits.get(planned.dir) || "" });
  assert.equal(diff.errorType, null, diff.error || "the fixture must capture a real complete source identity");
  // Something that changes the worktree after the job finished (a leftover process, a hand edit).
  if (planned.afterFinish) await planned.afterFinish(planned.dir);
  return {
    response: { content: [{ type: "text", text: "REPORT: wrote the batch." }] },
    result: { errorType: "", changedFiles: planned.changed, configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free", worktree: { patchSha256: diff.patchSha256, sourceStateSha256: diff.sourceStateSha256 } },
    validation: { status: "passed" },
    worktree: { path: planned.dir, branch, baseCommit: diff.sourceBaseCommit, baseTree: "" },
  };
};
async function runAutoJob(file, edits, extra = {}, afterFinish = null) {
  const dir = await builderWorktree(edits);
  const request = job(file, extra);
  worktreeOf.set(request.task, { dir, changed: Object.keys(edits), afterFinish });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, `${enqueued.errorType}: ${enqueued.error}`);
  const jobId = enqueued.record.jobId;
  const settled = (status) => Boolean(status) && !["waiting_for_lock", "integrating"].includes(status);
  const finished = await waitFor(async () => settled((await durable(jobId))?.autoIntegration?.status), 120_000);
  if (!finished) {
    const record = await durable(jobId);
    assert.fail(`the auto-integration of ${file} did not finish: status=${record?.status} error=${record?.errorType} reason=${record?.errorReason} autoIntegration=${JSON.stringify(record?.autoIntegration)}`);
  }
  return { jobId, dir, record: await durable(jobId) };
}
const head = async () => (await git(["rev-parse", "HEAD"])).trim();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-010: the option is checked at enqueue and refused where it cannot work", async () => {
  assert.equal(autoIntegrateJobError({ autoIntegrate: false }, {}), null);
  assert.equal(autoIntegrateJobError({ write: true }, { lockType: "write", validationCommand: VALIDATION }), null);
  const reader = await enqueueQueueJob({ agent: "reviewer", task: "read", cwd: repo, write: false, lockMode: "off", scopeContract: { mode: "read", read: ["src/a.txt"] }, autoIntegrate: true });
  assert.equal(reader.errorType, "auto_integrate_not_applicable");
  const noValidation = await enqueueQueueJob(job("out/x.json", { validationCommand: undefined, scopeContract: { ...writeScope("out/x.json"), validationCommand: "" } }));
  assert.equal(noValidation.errorType, "auto_integrate_needs_validation");
  const pipeline = await enqueueQueueJob(job("out/y.json"), "pipeline-parent");
  assert.equal(pipeline.errorType, "auto_integrate_not_applicable");
  const direct = textOf(await callTool("run_opencode_agent", { ...job("out/z.json"), dryRun: true }));
  assert.match(direct, /errorType: queue_only_option/);
});

test("Q-010: the patch file list tells new files from changed ones", () => {
  const patch = [
    "diff --git a/out/new.json b/out/new.json", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/out/new.json", "@@ -0,0 +1 @@", "+[]",
    "diff --git a/src/a.txt b/src/a.txt", "index 2222222..3333333 100644", "--- a/src/a.txt", "+++ b/src/a.txt", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n");
  assert.deepEqual(patchFileEntries(patch).map((file) => [file.path, file.created, file.deleted]), [["out/new.json", true, false], ["src/a.txt", false, false]]);
});

test("Q-010: a new-file-only patch is integrated and committed with the target's last commit identity", async () => {
  const before = await head();
  const { record, dir } = await runAutoJob("out/batch-001.json", { "out/batch-001.json": "[1, 2, 3]\n" });
  assert.equal(record.status, "completed");
  assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
  assert.deepEqual(record.autoIntegration.files, ["out/batch-001.json"]);
  const after = await head();
  assert.notEqual(after, before);
  assert.equal(record.autoIntegration.commit, after);
  assert.equal((await git(["log", "-1", "--format=%P"])).trim(), before, "one commit on top of the old HEAD");
  assert.equal((await git(["log", "-1", "--format=%an <%ae>"])).trim(), "Batch Owner <owner@example.invalid>", "the identity of the target's last commit");
  assert.match((await git(["log", "-1", "--format=%s"])).trim(), new RegExp(`^Auto-integrate ${record.jobId}: 1 new file\\(s\\) by builder on opencode/muse-spark-1\\.3-contributor-free$`));
  assert.equal((await git(["show", "--name-only", "--format=", "HEAD"])).trim(), "out/batch-001.json", "exactly the job's files");
  assert.equal((await git(["status", "--porcelain"])).trim(), "", "the target is clean afterwards");
  assert.equal(readFileSync(path.join(repo, "out", "batch-001.json"), "utf8"), "[1, 2, 3]\n");
  assert.equal(await waitFor(async () => {
    await internals.drainDeferredWorktreeCleanup(repo);
    return !existsSync(dir);
  }, 20_000), true, "deferred cleanup completed within 20 seconds");
  assert.equal(existsSync(dir), false, `the worktree was cleaned up after the passing validation: ${record.autoIntegration.worktreeCleanup}`);
  const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 10 }));
  assert.match(list, new RegExp(`${record.jobId} .*autoIntegration=committed@${after.slice(0, 12)}`));
});

test("Q-010: unrelated uncommitted work in the target stays uncommitted", async () => {
  await writeFile(path.join(repo, "src", "a.txt"), "local edit\n", "utf8");
  try {
    const { record } = await runAutoJob("out/batch-002.json", { "out/batch-002.json": "[4]\n" });
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal((await git(["show", "--name-only", "--format=", "HEAD"])).trim(), "out/batch-002.json");
    assert.match(await git(["status", "--porcelain"]), /^ M src\/a\.txt/m, "the local edit is still only a local edit");
  } finally {
    await git(["checkout", "--", "src/a.txt"]);
  }
});

test("Q-010: a patch that changes an existing file is left for the reviewed flow", async () => {
  const before = await head();
  const { record, dir } = await runAutoJob("src/b.txt", { "src/b.txt": "changed\n" }, { lockedPaths: ["src"] });
  assert.equal(record.autoIntegration.status, "skipped_not_new_files");
  assert.deepEqual(record.autoIntegration.files, ["src/b.txt"]);
  assert.equal(await head(), before, "nothing landed");
  assert.equal(readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "b\n");
  assert.equal(existsSync(dir), true, "the worktree is kept for integrate_opencode_worktree");
});

test("Q-010: a validation that fails in the target rolls the files back and keeps the worktree", async () => {
  const before = await head();
  const { record, dir } = await runAutoJob("out/batch-003.json", { "out/batch-003.json": "BAD\n" });
  assert.equal(record.status, "completed", "the job itself stays completed");
  assert.equal(record.autoIntegration.status, "failed");
  assert.equal(record.autoIntegration.stage, "apply");
  assert.equal(await head(), before);
  assert.equal(existsSync(path.join(repo, "out", "batch-003.json")), false, "rolled back");
  assert.equal(existsSync(dir), true);
  assert.ok(await waitFor(() => issues().includes(record.jobId)));
  assert.match(issues(), new RegExp(`\\| queue\\.auto_integration_failed \\| \\S+ \\| job ${record.jobId} builder on opencode/muse-spark-1\\.3-contributor-free \\| Auto-integration stopped at the apply`));
});

test("Q-010 / Q-017 (e): with CODEX_OPENCODE_AUTO_INTEGRATION_BATCH=false jobs of one repository integrate one after another, each with its own commit", async () => {
  assert.equal(internals.CONFIG.autoIntegrationBatch, true, "batching is on by default");
  // CONFIG is frozen; the test hook stands in for the variable (the scheduler reads either).
  hooks.autoIntegrationTestHooks.batch = false;
  try {
    const before = await head();
    const runs = await Promise.all([
      runAutoJob("out/batch-004.json", { "out/batch-004.json": "[4]\n" }, { lockedPaths: ["out/batch-004.json"] }),
      runAutoJob("out/batch-005.json", { "out/batch-005.json": "[5]\n" }, { lockedPaths: ["out/batch-005.json"] }),
      runAutoJob("out/batch-006.json", { "out/batch-006.json": "[6]\n" }, { lockedPaths: ["out/batch-006.json"] }),
    ]);
    for (const { record } of runs) assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    for (const { record } of runs) assert.equal(record.autoIntegration.batch, undefined, "no batch record");
    const log = (await git(["log", "--format=%s", `${before}..HEAD`])).trim().split("\n");
    assert.equal(log.length, 3);
    assert.equal(AUTO_INTEGRATION_CHAINS.size, 0, "the chain is released");
    assert.equal((await git(["status", "--porcelain"])).trim(), "");
  } finally {
    hooks.autoIntegrationTestHooks.batch = null;
  }
});

// Q-017: a finished writer enqueued without the option (so nothing schedules it yet) and the
// details the queue schedules for it; the tests schedule several in one tick, as jobs that
// finished while the repository's chain was busy.
async function finishedJob(file, edits, extra = {}, beforeFinish = null) {
  const dir = await builderWorktree(edits);
  const request = job(file, { lockedPaths: [file], autoIntegrate: undefined, ...extra });
  worktreeOf.set(request.task, { dir, changed: Object.keys(edits), beforeFinish });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, `${enqueued.errorType}: ${enqueued.error}`);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "completed", 30_000), `${file} did not complete`);
  const record = await durable(jobId);
  return { jobId, dir, file, details: { cwd: repo, jobId, agent: "builder", model: "opencode/muse-spark-1.3-contributor-free", worktreePath: dir, allowedEdits: [file], validationCommand: VALIDATION, sourceRecord: record, changedFiles: record.changedFiles } };
}
const scheduleTogether = (jobs) => Promise.all(jobs.map((entry) => internals.scheduleAutoIntegration(entry.details)));
const commitsSince = async (before) => (await git(["log", "--format=%H %s", `${before}..HEAD`])).trim().split("\n").filter(Boolean);

test("Q-017 (a): three new-file jobs that wait for the same turn land in ONE commit", async () => {
  const jobs = [];
  for (const number of [20, 21, 22]) jobs.push(await finishedJob(`out/batch-0${number}.json`, { [`out/batch-0${number}.json`]: `[${number}]\n` }));
  const before = await head();
  const outcomes = await scheduleTogether(jobs);
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  const after = await head();
  for (const [index, entry] of jobs.entries()) {
    assert.equal(outcomes[index]?.status, "committed", JSON.stringify(outcomes[index]));
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal(record.autoIntegration.commit, after);
    assert.deepEqual(record.autoIntegration.files, [entry.file], "each job keeps its own files");
    assert.deepEqual(record.autoIntegration.batch, { size: 3, jobIds: jobs.map((other) => other.jobId) });
    assert.equal(await waitFor(async () => {
      await internals.drainDeferredWorktreeCleanup(repo);
      return !existsSync(entry.dir);
    }, 20_000), true, "deferred batch cleanup completed within 20 seconds");
    assert.equal(existsSync(entry.dir), false, `worktree removed: ${record.autoIntegration.worktreeCleanup}`);
  }
  const subject = (await git(["log", "-1", "--format=%s"])).trim();
  assert.match(subject, /^Auto-integrate 3 jobs \(/);
  for (const entry of jobs) assert.ok(subject.includes(entry.jobId), `the message names ${entry.jobId}`);
  assert.deepEqual((await git(["show", "--name-only", "--format=", "HEAD"])).trim().split("\n"), jobs.map((entry) => entry.file));
  assert.equal((await git(["status", "--porcelain"])).trim(), "", "the target is clean afterwards");
  assert.equal(AUTO_INTEGRATION_CHAINS.size, 0, "the chain is released");
});

test("Q-017 (b): a job that changes an existing file leaves the batch; the other two land in one commit", async () => {
  const jobs = [
    await finishedJob("out/batch-023.json", { "out/batch-023.json": "[23]\n" }),
    await finishedJob("src/b.txt", { "src/b.txt": "changed in a batch group\n" }, { task: "Change src/b.txt in a batch group." }),
    await finishedJob("out/batch-024.json", { "out/batch-024.json": "[24]\n" }),
  ];
  const before = await head();
  await scheduleTogether(jobs);
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  const after = await head();
  for (const entry of [jobs[0], jobs[2]]) {
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal(record.autoIntegration.commit, after);
    assert.deepEqual(record.autoIntegration.batch, { size: 2, jobIds: [jobs[0].jobId, jobs[2].jobId] });
  }
  const changer = await durable(jobs[1].jobId);
  assert.equal(changer.autoIntegration.status, "skipped_not_new_files", JSON.stringify(changer.autoIntegration));
  assert.deepEqual(changer.autoIntegration.files, ["src/b.txt"]);
  assert.equal(readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "b\n", "the existing file is untouched");
  assert.equal(existsSync(jobs[1].dir), true, "its worktree is kept for review");
  assert.deepEqual((await git(["show", "--name-only", "--format=", "HEAD"])).trim().split("\n"), ["out/batch-023.json", "out/batch-024.json"]);
});

test("Q-017 (c): two jobs that create the same path are never batched together; each takes the one-by-one path", async () => {
  const jobs = [
    await finishedJob("out/batch-dup.json", { "out/batch-dup.json": "[25]\n" }),
    await finishedJob("out/batch-dup.json", { "out/batch-dup.json": "[25]\n" }, { task: "Write out/batch-dup.json a second time." }),
    await finishedJob("out/batch-026.json", { "out/batch-026.json": "[26]\n" }),
  ];
  const before = await head();
  await scheduleTogether(jobs);
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  const after = await head();
  const first = await durable(jobs[0].jobId);
  const third = await durable(jobs[2].jobId);
  assert.equal(first.autoIntegration.status, "committed", JSON.stringify(first.autoIntegration));
  assert.deepEqual(first.autoIntegration.batch, { size: 2, jobIds: [jobs[0].jobId, jobs[2].jobId] }, "the second writer of the path is not in the batch");
  assert.equal(third.autoIntegration.commit, after);
  // The second writer lands alone afterwards: its identical file is already in HEAD (B-153).
  const second = await durable(jobs[1].jobId);
  assert.equal(second.autoIntegration.status, "already_committed", JSON.stringify(second.autoIntegration));
  assert.equal(second.autoIntegration.batch, undefined);
  assert.equal(second.autoIntegration.commit, after);
  assert.equal(existsSync(jobs[1].dir), false);
});

test("Q-017 (d): a batch whose validation fails applies nothing, then each job is integrated alone", async () => {
  const jobs = [
    await finishedJob("out/batch-027.json", { "out/batch-027.json": "[27]\n" }),
    await finishedJob("out/batch-028.json", { "out/batch-028.json": "BAD\n" }),
    await finishedJob("out/batch-029.json", { "out/batch-029.json": "[29]\n" }),
  ];
  const before = await head();
  await scheduleTogether(jobs);
  const commits = await commitsSince(before);
  assert.equal(commits.length, 2, `one commit per good job: ${commits.join("\n")}`);
  for (const entry of [jobs[0], jobs[2]]) {
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.equal(record.autoIntegration.batch, undefined, "landed alone");
    assert.ok(commits.some((line) => line.endsWith(`Auto-integrate ${entry.jobId}: 1 new file(s) by builder on opencode/muse-spark-1.3-contributor-free`)), commits.join("\n"));
  }
  const bad = await durable(jobs[1].jobId);
  assert.equal(bad.autoIntegration.status, "failed", JSON.stringify(bad.autoIntegration));
  assert.equal(bad.autoIntegration.stage, "apply");
  assert.equal(existsSync(path.join(repo, "out", "batch-028.json")), false, "rolled back");
  assert.equal(existsSync(jobs[1].dir), true, "its worktree is kept");
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
  const opsLog = path.join(fixture.stateDir, "logs", `bridge-${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert.ok(await waitFor(() => existsSync(opsLog) && readFileSync(opsLog, "utf8").includes("queue.auto_integration_batch_fallback")), "the fallback is in the operations log");
});

test("Q-017 (f): a member whose worktree changed after its job leaves the batch; the others land in one commit", async () => {
  const jobs = [
    await finishedJob("out/batch-030.json", { "out/batch-030.json": "[30]\n" }),
    await finishedJob("out/batch-031.json", { "out/batch-031.json": "[31]\n" }),
    await finishedJob("out/batch-032.json", { "out/batch-032.json": "[32]\n" }),
  ];
  await writeFile(path.join(jobs[1].dir, "out", "batch-031.json"), "[31, \"changed after the job\"]\n", "utf8");
  const before = await head();
  await scheduleTogether(jobs);
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  for (const entry of [jobs[0], jobs[2]]) {
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.deepEqual(record.autoIntegration.batch, { size: 2, jobIds: [jobs[0].jobId, jobs[2].jobId] });
  }
  const changed = await durable(jobs[1].jobId);
  assert.equal(changed.autoIntegration.status, "failed", JSON.stringify(changed.autoIntegration));
  assert.equal(changed.autoIntegration.errorType, "pipeline_source_identity_changed");
  assert.equal(existsSync(path.join(repo, "out", "batch-031.json")), false, "the changed file was not applied");
  assert.equal(existsSync(jobs[1].dir), true, "its worktree is kept for review");
});

test("Q-017 (g): a member another live process has claimed is left to it; the others land in one commit", async () => {
  const { closeDb, openLockDb } = internals;
  const jobs = [
    await finishedJob("out/batch-033.json", { "out/batch-033.json": "[33]\n" }),
    await finishedJob("out/batch-034.json", { "out/batch-034.json": "[34]\n" }),
    await finishedJob("out/batch-035.json", { "out/batch-035.json": "[35]\n" }),
  ];
  const db = await openLockDb(repo);
  try {
    const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(jobs[1].jobId);
    db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(
      JSON.stringify({ ...JSON.parse(row.record_json), autoIntegration: { status: "integrating", claimedBy: `${process.pid}-1-otherclaimer`, at: new Date().toISOString() } }),
      jobs[1].jobId);
  } finally {
    closeDb(db);
  }
  const before = await head();
  const outcomes = await scheduleTogether(jobs);
  assert.equal(outcomes[1]?.status, "not_claimed", JSON.stringify(outcomes[1]));
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  for (const entry of [jobs[0], jobs[2]]) {
    const record = await durable(entry.jobId);
    assert.deepEqual(record.autoIntegration.batch, { size: 2, jobIds: [jobs[0].jobId, jobs[2].jobId] });
  }
  const held = await durable(jobs[1].jobId);
  assert.equal(held.autoIntegration.claimedBy, `${process.pid}-1-otherclaimer`, "the other process keeps its claim");
  assert.equal(existsSync(path.join(repo, "out", "batch-034.json")), false);
  assert.equal(existsSync(jobs[1].dir), true);
});

test("Q-017 (h): a record that cannot be written after the batch commit never sends the job back to the one-by-one path", async () => {
  const jobs = [
    await finishedJob("out/batch-036.json", { "out/batch-036.json": "[36]\n" }),
    await finishedJob("out/batch-037.json", { "out/batch-037.json": "[37]\n" }),
    await finishedJob("out/batch-038.json", { "out/batch-038.json": "[38]\n" }),
  ];
  hooks.autoIntegrationTestHooks.beforeBatchRecord = async (jobId) => {
    if (jobId === jobs[1].jobId) throw new Error("database is locked (test)");
  };
  let outcomes = [];
  const before = await head();
  try {
    outcomes = await scheduleTogether(jobs);
  } finally {
    hooks.autoIntegrationTestHooks.beforeBatchRecord = null;
  }
  const commits = await commitsSince(before);
  assert.equal(commits.length, 1, commits.join("\n"));
  assert.equal(outcomes[1]?.status, "committed", JSON.stringify(outcomes[1]));
  assert.match(outcomes[1]?.recordError || "", /database is locked/);
  const unrecorded = await durable(jobs[1].jobId);
  assert.notEqual(unrecorded.autoIntegration.status, "failed", JSON.stringify(unrecorded.autoIntegration));
  assert.equal(readFileSync(path.join(repo, "out", "batch-037.json"), "utf8"), "[37]\n", "its file is committed");
  for (const entry of [jobs[0], jobs[2]]) {
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.deepEqual(record.autoIntegration.batch, { size: 3, jobIds: jobs.map((other) => other.jobId) });
  }
});

test("Q-010: an in-place writer or another integration on the files makes the integration wait, then land", async () => {
  const { acquireHardLock, releaseHardLock } = internals;
  // Earlier integrations can finish while their source cleanup still holds the repository lock.
  let cleanupOutcomes = [];
  let pendingCleanup = [];
  assert.ok(await waitFor(async () => {
    cleanupOutcomes = await internals.drainDeferredWorktreeCleanup(repo);
    const db = await internals.openLockDb(repo);
    try {
      pendingCleanup = db.prepare("SELECT worktree_path, status FROM integration_worktree_cleanup WHERE cwd = ? AND status = 'pending'").all(path.resolve(repo));
    } finally {
      internals.closeDb(db);
    }
    return pendingCleanup.length === 0;
  }, 20_000), `previous deferred cleanup must finish before the intentional blocker: ${JSON.stringify({ cleanupOutcomes, pendingCleanup })}`);
  // A finished writer without autoIntegrate gives the terminal job row the outcome is written to.
  const dir = await builderWorktree({ "out/batch-008.json": "[8]\n" });
  const request = job("out/batch-008.json", { lockedPaths: ["out/batch-008.json"], autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-008.json"] });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, enqueued.error);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "completed", 15_000));
  const before = await head();
  const details = { cwd: repo, jobId: enqueued.record.jobId, agent: "builder", worktreePath: dir, allowedEdits: ["out/batch-008.json"], validationCommand: VALIDATION, sourceRecord: await durable(enqueued.record.jobId) };
  const blocker = await acquireHardLock({ owner: "codex", agent: "builder", task: "edits the checkout in place", cwd: repo, lockType: "write", paths: ["out/batch-008.json"], ttlMs: 60_000, editsCheckout: true });
  assert.equal(blocker.ok, true, blocker.error);
  try {
    const waiting = await autoIntegrateQueueJob(details);
    assert.equal(waiting.retryLater, true, JSON.stringify(waiting));
    assert.equal((await durable(enqueued.record.jobId)).autoIntegration.status, "waiting_for_lock");
    assert.equal(await head(), before, "nothing lands while the lock is held");
  } finally {
    await releaseHardLock(blocker.lock.id, blocker.lock.token, blocker.lock.paths, blocker.lock.cwd);
  }
  const landed = await autoIntegrateQueueJob({ ...details, laterAttempt: 1 });
  assert.equal(landed.status, "committed", JSON.stringify(landed));
  assert.equal((await git(["show", "--name-only", "--format=", "HEAD"])).trim(), "out/batch-008.json");
});

test("B-069: the commit keeps the owner's staged work out, handles a name git would quote, and stores no email", async () => {
  await writeFile(path.join(repo, "src", "a.txt"), "staged by the owner\n", "utf8");
  await git(["add", "src/a.txt"]);
  const name = "out/bätch 009.json";
  try {
    const before = await head();
    const { record } = await runAutoJob(name, { [name]: "[9]\n" }, { lockedPaths: [name] });
    assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
    assert.deepEqual(record.autoIntegration.files, [name], "the engine's -z path, not a quoted header");
    assert.equal((await git(["log", "-1", "--format=%P"])).trim(), before);
    assert.equal((await git(["-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD"])).trim(), name, "only the new file is in the commit");
    assert.match(await git(["status", "--porcelain"]), /^M  src\/a\.txt/m, "the owner's staged change is still staged and not committed");
    assert.doesNotMatch(await git(["-c", "core.quotePath=false", "status", "--porcelain"]), /bätch/, "the new file is clean in the index");
    assert.equal(record.autoIntegration.author, "Batch Owner");
    const view = textOf(await callTool("get_opencode_job", { cwd: repo, jobId: record.jobId, detail: true }));
    assert.doesNotMatch(view, /owner@example\.invalid/, "the author's email is not stored in the queue record");
  } finally {
    await git(["reset", "-q", "--", "src/a.txt"]);
    await git(["checkout", "--", "src/a.txt"]);
  }
});

test("B-069: the commit step refuses content that is not the reviewed content and leaves HEAD alone", async () => {
  const { autoIntegrationCommitHooks } = internals;
  await writeFile(path.join(repo, "out", "batch-010.json"), "[10]\n", "utf8");
  const before = await head();
  const hooks = autoIntegrationCommitHooks({ jobId: "manual-test", agent: "builder", worktreePath: path.join(root, "no-such-worktree") });
  const wrong = await hooks.commit({ changedFiles: ["out/batch-010.json"] }, { targetCwd: repo, prepared: { ok: true, files: [{ path: "out/batch-010.json", blob: "0".repeat(40), mode: "100644" }] } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.errorType, "auto_integration_content_mismatch");
  assert.equal(await head(), before, "nothing was committed");
  const unprepared = await hooks.commit({ changedFiles: [] }, { targetCwd: repo, prepared: null });
  assert.equal(unprepared.ok, false);
  const { rm: remove } = await import("node:fs/promises");
  await remove(path.join(repo, "out", "batch-010.json"), { force: true });
});

test("B-069: after a restart an open auto-integration is scheduled again, once, and a claim stops a second run", async () => {
  const { AUTO_INTEGRATION_RESCHEDULED, closeDb, decryptQueueRequest, encryptQueueRequest, openLockDb, rescheduleOpenAutoIntegrations } = internals;
  // A finished writer whose bridge died before it integrated: run it without the option, then
  // give its stored request and record the option, as an enqueue with autoIntegrate would have.
  const dir = await builderWorktree({ "out/batch-011.json": "[11]\n" });
  const request = job("out/batch-011.json", { lockedPaths: ["out/batch-011.json"], autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-011.json"] });
  const enqueued = await enqueueQueueJob(request);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "completed", 15_000));
  const db = await openLockDb(repo);
  try {
    const row = db.prepare("SELECT request_encrypted, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    const stored = await decryptQueueRequest(row.request_encrypted, jobId);
    stored.autoIntegrate = true;
    db.prepare("UPDATE opencode_jobs SET request_encrypted = ?, record_json = ? WHERE job_id = ?").run(
      await encryptQueueRequest(stored, jobId), JSON.stringify({ ...JSON.parse(row.record_json), autoIntegrateRequested: true }), jobId);
    AUTO_INTEGRATION_RESCHEDULED.delete(jobId);
    assert.equal(await rescheduleOpenAutoIntegrations(db), 1, "the open integration is scheduled");
    assert.equal(await rescheduleOpenAutoIntegrations(db), 0, "once per process");
  } finally {
    closeDb(db);
  }
  assert.ok(await waitFor(async () => (await durable(jobId))?.autoIntegration?.status === "committed", 120_000), JSON.stringify((await durable(jobId))?.autoIntegration));
  // A second run (another bridge that found the same job) is refused by the claim.
  const again = await autoIntegrateQueueJob({ cwd: repo, jobId, agent: "builder", worktreePath: dir, allowedEdits: ["out/batch-011.json"], validationCommand: VALIDATION });
  assert.equal(again.status, "not_claimed");
  assert.equal(again.current, "committed");
});

test("B-074: a claim of a dead bridge process is taken over at startup; a live process's claim is not", async () => {
  const { AUTO_INTEGRATION_RESCHEDULED, autoIntegrationClaimerGone, closeDb, decryptQueueRequest, encryptQueueRequest, openLockDb, rescheduleOpenAutoIntegrations } = internals;
  const dir = await builderWorktree({ "out/batch-012.json": "[12]\n" });
  const request = job("out/batch-012.json", { lockedPaths: ["out/batch-012.json"], autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-012.json"] });
  const enqueued = await enqueueQueueJob(request);
  const jobId = enqueued.record.jobId;
  assert.ok(await waitFor(async () => (await durable(jobId))?.status === "completed", 15_000));
  const setClaim = async (claimedBy) => {
    const db = await openLockDb(repo);
    try {
      const row = db.prepare("SELECT request_encrypted, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
      const stored = await decryptQueueRequest(row.request_encrypted, jobId);
      stored.autoIntegrate = true;
      db.prepare("UPDATE opencode_jobs SET request_encrypted = ?, record_json = ? WHERE job_id = ?").run(
        await encryptQueueRequest(stored, jobId),
        JSON.stringify({ ...JSON.parse(row.record_json), autoIntegrateRequested: true, autoIntegration: { status: "integrating", claimedBy, at: new Date().toISOString() } }),
        jobId);
      return db;
    } catch (error) {
      closeDb(db);
      throw error;
    }
  };
  // A live process (this test's own pid under another instance id): its fresh claim stands.
  const liveClaimer = `${process.pid}-1-livelivelive`;
  let db = await setClaim(liveClaimer);
  try {
    assert.equal(autoIntegrationClaimerGone(db, liveClaimer), false);
  } finally {
    closeDb(db);
  }
  const refused = await autoIntegrateQueueJob({ cwd: repo, jobId, agent: "builder", worktreePath: dir, allowedEdits: ["out/batch-012.json"], validationCommand: VALIDATION });
  assert.equal(refused.status, "not_claimed", "a fresh claim of a live process is not taken over");
  // A crashed bridge: no live bridge_instances lease and no live process. The restart scan takes it over at once.
  const deadClaimer = "999999-1-deaddeaddead";
  db = await setClaim(deadClaimer);
  try {
    assert.equal(autoIntegrationClaimerGone(db, deadClaimer), true);
    AUTO_INTEGRATION_RESCHEDULED.delete(jobId);
    assert.equal(await rescheduleOpenAutoIntegrations(db), 1);
  } finally {
    closeDb(db);
  }
  assert.ok(await waitFor(async () => (await durable(jobId))?.autoIntegration?.status === "committed", 120_000), JSON.stringify((await durable(jobId))?.autoIntegration));
});

test("B-114: a worktree changed after the job finished is not integrated", async () => {
  const before = await head();
  const { record, dir } = await runAutoJob("out/batch-013.json", { "out/batch-013.json": "[13]\n" }, { lockedPaths: ["out/batch-013.json"] },
    (worktree) => writeFile(path.join(worktree, "out", "batch-013.json"), "[13, \"changed after the job\"]\n", "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.autoIntegration.status, "failed", JSON.stringify(record.autoIntegration));
  assert.equal(record.autoIntegration.stage, "dry run");
  assert.equal(record.autoIntegration.errorType, "pipeline_source_identity_changed");
  assert.equal(await head(), before, "nothing was committed");
  assert.equal(existsSync(path.join(repo, "out", "batch-013.json")), false, "nothing was applied");
  assert.equal(existsSync(dir), true, "the worktree is kept for review");
});

test("B-114: a record without the source identity is not integrated", async () => {
  const dir = await builderWorktree({ "out/batch-014.json": "[14]\n" });
  const request = job("out/batch-014.json", { lockedPaths: ["out/batch-014.json"], autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-014.json"] });
  const enqueued = await enqueueQueueJob(request);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "completed", 15_000));
  const before = await head();
  const outcome = await autoIntegrateQueueJob({ cwd: repo, jobId: enqueued.record.jobId, agent: "builder", worktreePath: dir, allowedEdits: ["out/batch-014.json"], validationCommand: VALIDATION, sourceRecord: { worktreeBaseCommit: "", worktreePatchSha256: "", worktreeSourceStateSha256: "" } });
  assert.equal(outcome.status, "failed", JSON.stringify(outcome));
  assert.equal(outcome.errorType, "auto_integration_source_unattested");
  assert.equal(await head(), before);
  assert.equal(existsSync(path.join(repo, "out", "batch-014.json")), false);
});

test("Q-010: without autoIntegrate a finished writer is not touched", async () => {
  const before = await head();
  const dir = await builderWorktree({ "out/batch-007.json": "[7]\n" });
  const request = job("out/batch-007.json", { autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-007.json"] });
  const enqueued = await enqueueQueueJob(request);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "completed"), await (async () => {
    const record = await durable(enqueued.record.jobId);
    const bounded = (value, limit = 120) => String(value ?? "").slice(0, limit);
    return `writer did not complete: ${JSON.stringify({
      jobId: bounded(enqueued.record.jobId), status: bounded(record?.status), revision: bounded(record?.revision, 32),
      errorType: bounded(record?.errorType), reason: bounded(record?.errorReason, 400),
      createdAt: bounded(record?.createdAt, 64), startedAt: bounded(record?.startedAt, 64), finishedAt: bounded(record?.finishedAt, 64),
    })}`;
  })());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await head(), before);
  assert.equal((await durable(enqueued.record.jobId)).autoIntegration || null, null);
});

test("B-125: the commit uses the target's configured user.name/user.email, not the author of its last commit", async () => {
  const { autoIntegrationCommitHooks } = internals;
  const file = "out/batch-013.json";
  await mkdir(path.join(repo, "out"), { recursive: true });
  await writeFile(path.join(repo, "out", "batch-013.json"), "[13]\n", "utf8");
  const blob = (await git(["hash-object", "--path", file, path.join(repo, "out", "batch-013.json")])).trim();
  await git(["config", "user.name", "Configured Owner"]);
  await git(["config", "user.email", "configured@example.invalid"]);
  try {
    const before = await head();
    assert.notEqual((await git(["log", "-1", "--format=%an"])).trim(), "Configured Owner", "the last commit is someone else's");
    const hooks = autoIntegrationCommitHooks({ jobId: "identity-test", agent: "builder", worktreePath: path.join(root, "no-such-worktree") });
    const committed = await hooks.commit({ changedFiles: [file] }, { targetCwd: repo, prepared: { ok: true, files: [{ path: file, blob, mode: "100644" }] } });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(committed.authorName, "Configured Owner");
    assert.equal((await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim(), "Configured Owner <configured@example.invalid>|Configured Owner <configured@example.invalid>");
    assert.equal((await git(["log", "-1", "--format=%P"])).trim(), before);
  } finally {
    await git(["config", "--unset", "user.name"]);
    await git(["config", "--unset", "user.email"]);
  }
});

// Whole-week controls keep provider execution synthetic and use real terminal rows,
// registered Git worktrees, serial leases, collection and shared cleanup.
const withDb = async (operation, runtime = internals) => {
  const db = await runtime.openLockDb(repo);
  try { return await operation(db); } finally { runtime.closeDb(db); }
};
const artifactOf = entry => withDb(db => db.prepare("SELECT * FROM worktree_artifacts WHERE worktree_path = ?").get(path.resolve(entry.dir)));
const sourceIdentityOf = record => ({ sourceBaseCommit: record.worktreeBaseCommit,
  patchSha256: record.worktreePatchSha256, sourceStateSha256: record.worktreeSourceStateSha256 });
const assertSourceRetained = async (entry, relative, content) => {
  assert.equal(existsSync(entry.dir), true, "the original source directory must survive");
  assert.equal(readFileSync(path.join(entry.dir, relative), "utf8"), content, "later source bytes must survive exactly");
  assert.ok((await git(["worktree", "list", "--porcelain"])).includes(entry.dir.replace(/\\/g, "/")), "the worktree registration must survive");
  assert.ok((await git(["show-ref", "--hash", "--verify", `refs/heads/${entry.details.sourceRecord.worktreeBranch}`])).trim(), "the source branch must survive");
};
const commitByHand = async entry => {
  await mkdir(path.dirname(path.join(repo, entry.file)), { recursive: true });
  await writeFile(path.join(repo, entry.file), readFileSync(path.join(entry.dir, entry.file)));
  await git(["add", "--", entry.file]);
  await git([...identity, "commit", "-q", "-m", `Land ${entry.file} by hand`]);
  return await head();
};
const markLegacyCommitted = async (entry, commit, omitIdentity = false) => withDb(db => {
  const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(entry.jobId);
  const record = JSON.parse(row.record_json);
  if (omitIdentity) delete record.worktreeSourceStateSha256;
  record.autoIntegration = { status: "committed", commit, files: [entry.file], worktreeCleanup: "", worktreeSweepDone: false };
  db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify(record), entry.jobId);
});
const sweep = runtime => withDb(db => runtime.sweepCommittedWorktrees(db), runtime);
let restartedRuntimes = 0;
const restartRuntime = async () => {
  const restarted = (await import(`../server.js?ww-auto-cleanup-${++restartedRuntimes}`)).__selfTest;
  restarted.hooks.stateDirectoryOverride = fixture.stateDir;
  restarted.hooks.queueModeOverride = "sqlite";
  restarted.internals.setDeferredCleanupSchedulingDisabled(true);
  return restarted.internals;
};

for (const [kind, relative] of [["tracked", "src/a.txt"], ["untracked", "later-untracked.txt"]]) {
  test(`WW-A2-001: already committed accounting retains later ${kind} source work`, async () => {
    const entry = await finishedJob(`out/ww-already-${kind}.json`, { [`out/ww-already-${kind}.json`]: "original output\n" });
    const commit = await commitByHand(entry);
    const later = `later ${kind} bytes\n`;
    await writeFile(path.join(entry.dir, relative), later);
    const outcome = await autoIntegrateQueueJob(entry.details);
    assert.equal(outcome.status, "already_committed", JSON.stringify(outcome));
    assert.equal(outcome.commit, commit);
    assert.deepEqual(outcome.files, [entry.file]);
    await assertSourceRetained(entry, relative, later);
    assert.equal(await head(), commit, "cleanup never creates another target commit");
  });
}

test("WW-A2-001: an active continuation keeps its registered ownership and source", async () => {
  const entry = await finishedJob("out/ww-continuation.json", { "out/ww-continuation.json": "continued output\n" });
  const commit = await commitByHand(entry);
  const executor = hooks.queueJobExecutorTestHook;
  let signalStarted, finishContinuation, claimed = false, continuationId = "";
  const started = new Promise(resolve => { signalStarted = resolve; });
  const finished = new Promise(resolve => { finishContinuation = resolve; });
  hooks.queueJobExecutorTestHook = async (request, context) => {
    if (request.task !== "WW active continuation") return executor(request, context);
    continuationId = context.jobId;
    const claim = await internals.attachRetainedWorktree({ cwd: repo, worktreePath: entry.dir, jobId: continuationId });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    claimed = true;
    signalStarted();
    await finished;
    return { response: { content: [{ type: "text", text: "REPORT: continuation finished." }] },
      result: { errorType: "", changedFiles: [], noChanges: true }, validation: { status: "passed" }, worktree: null };
  };
  try {
    const active = await enqueueQueueJob(job("out/ww-continuation.json", { task: "WW active continuation", continueWorktree: entry.dir, autoIntegrate: undefined }));
    assert.equal(active.ok, true, active.error);
    assert.equal(await Promise.race([started.then(() => true), fixture.sleep(15_000).then(() => false)]), true, "the real continuation claim must start");
    assert.equal((await durable(active.record.jobId)).status, "running");
    const outcome = await autoIntegrateQueueJob(entry.details);
    assert.equal(outcome.status, "already_committed", JSON.stringify(outcome));
    const artifact = await artifactOf(entry);
    assert.equal(artifact.status, "in_use");
    assert.equal(artifact.job_id, continuationId);
    await assertSourceRetained(entry, entry.file, "continued output\n");
    assert.equal(await head(), commit);
  } finally {
    if (claimed) await internals.releaseRetainedWorktreeClaim({ cwd: repo, worktreePath: entry.dir, jobId: continuationId });
    finishContinuation();
    hooks.queueJobExecutorTestHook = executor;
    if (continuationId) assert.ok(await waitFor(async () => (await durable(continuationId))?.status !== "running", 15_000));
  }
});

test("WW-A2-001: branch advance at the actual shared guard retains tip, bytes and registration", async () => {
  const entry = await finishedJob("out/ww-branch.json", { "out/ww-branch.json": "original branch output\n" }, {}, async dir => {
    await git(["add", "out/ww-branch.json"], dir);
    await git([...identity, "commit", "-q", "-m", "Complete job on an advanced source tip"], dir);
  });
  const sourceTip = (await git(["rev-parse", "HEAD"], entry.dir)).trim();
  assert.notEqual(sourceTip, entry.details.sourceRecord.worktreeBaseCommit, "the collected tip differs from the original base checkpoint");
  const commit = await commitByHand(entry);
  const { createIntegrationCleanupRuntime } = await import("../lib/integration-cleanup.js");
  let guarded = false, movedTip = "";
  const runtime = createIntegrationCleanupRuntime({ ...internals,
    cleanupWorktree: async (worktree, ...args) => {
      guarded = true;
      assert.equal(worktree.expectedBranchOid, sourceTip, "the successful collection's final tip reaches shared cleanup");
      await writeFile(path.join(entry.dir, "src/a.txt"), "branch advanced after collection\n");
      await git(["add", "src/a.txt"], entry.dir);
      await git([...identity, "commit", "-q", "-m", "Advance source before shared guard"], entry.dir);
      movedTip = (await git(["rev-parse", "HEAD"], entry.dir)).trim();
      return await internals.cleanupWorktree(worktree, ...args);
    } });
  const outcome = await runtime.cleanupCommittedWorktree({ cwd: repo, worktreePath: entry.dir, jobId: entry.jobId,
    expectedSourceIdentity: sourceIdentityOf(entry.details.sourceRecord), committedCommit: commit });
  assert.equal(guarded, true, "the actual guarded cleanup must execute");
  assert.equal(outcome.cleanup, "retained_for_review", JSON.stringify(outcome));
  assert.equal(outcome.reason, "source_branch_identity_changed");
  await assertSourceRetained(entry, "src/a.txt", "branch advanced after collection\n");
  assert.equal((await git(["rev-parse", `refs/heads/${entry.details.sourceRecord.worktreeBranch}`])).trim(), movedTip);
  assert.equal((await artifactOf(entry)).status, "retained");
});

for (const count of [1, 2]) {
  test(`WW-A2-001: ${count === 1 ? "single" : "batch"} fallback respects an actual engine retention decision and sweep`, async () => {
    const entries = [];
    for (let i = 0; i < count; i++) entries.push(await finishedJob(`out/ww-engine-${count}-${i}.json`, { [`out/ww-engine-${count}-${i}.json`]: "engine retained output\n" }));
    const previous = hooks.autoIntegrationTestHooks.beforeUpdateRef;
    let detached = false;
    hooks.autoIntegrationTestHooks.beforeUpdateRef = async (...args) => {
      if (previous) await previous(...args);
      if (detached) return;
      detached = true;
      // The real engine refuses cleanup without its source's branch identity.
      for (const entry of entries) await git(["checkout", "-q", "--detach", "HEAD"], entry.dir);
    };
    try { await scheduleTogether(entries); }
    finally { hooks.autoIntegrationTestHooks.beforeUpdateRef = previous; }
    assert.equal(detached, true);
    for (const entry of entries) {
      const record = await durable(entry.jobId);
      assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
      assert.match(record.autoIntegration.worktreeCleanup, /retained_for_review \(source_branch_identity_unverified\)/);
      await assertSourceRetained(entry, entry.file, "engine retained output\n");
    }
    const commit = await head();
    await sweep(internals);
    for (const entry of entries) await assertSourceRetained(entry, entry.file, "engine retained output\n");
    assert.equal(await head(), commit);
  });
  test(`WW-A2-001: ${count === 1 ? "single" : "batch"} true-absence fallback cleans unchanged original sources`, async () => {
    const entries = [];
    for (let i = 0; i < count; i++) entries.push(await finishedJob(`out/ww-fallback-${count}-${i}.json`, { [`out/ww-fallback-${count}-${i}.json`]: "unchanged output\n" }));
    const previous = hooks.autoIntegrationTestHooks.skipEngineCleanup;
    hooks.autoIntegrationTestHooks.skipEngineCleanup = true;
    try { await scheduleTogether(entries); }
    finally { hooks.autoIntegrationTestHooks.skipEngineCleanup = previous; }
    for (const entry of entries) {
      const record = await durable(entry.jobId);
      assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
      assert.equal(existsSync(entry.dir), false, record.autoIntegration.worktreeCleanup);
      assert.equal((await git(["branch", "--list", entry.details.sourceRecord.worktreeBranch])).trim(), "");
      assert.equal(readFileSync(path.join(repo, entry.file), "utf8"), "unchanged output\n");
    }
  });
}

for (const mode of ["changed", "unchanged", "missing identity", "malformed identity"]) {
  test(`WW-A2-001: fresh-runtime legacy sweep ${mode === "unchanged" ? "cleans unchanged source" : `retains ${mode} source`}`, async () => {
    const file = `out/ww-restart-${mode.replace(/ /g, "-")}.json`;
    const entry = await finishedJob(file, { [file]: "restart output\n" });
    const commit = await commitByHand(entry);
    await markLegacyCommitted(entry, commit, mode === "missing identity");
    if (mode === "malformed identity") await withDb(db => {
      const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(entry.jobId);
      const record = JSON.parse(row.record_json);
      record.worktreePatchSha256 = "not a complete source hash";
      db.prepare("UPDATE opencode_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify(record), entry.jobId);
    });
    if (mode === "changed") await writeFile(path.join(entry.dir, "src/a.txt"), "later restart bytes\n");
    const restarted = await restartRuntime();
    await sweep(restarted);
    const record = await durable(entry.jobId);
    assert.equal(record.autoIntegration.status, "committed");
    assert.equal(record.autoIntegration.commit, commit);
    if (mode === "unchanged") {
      assert.equal(existsSync(entry.dir), false, record.autoIntegration.worktreeCleanup);
      assert.equal((await git(["branch", "--list", entry.details.sourceRecord.worktreeBranch])).trim(), "");
    } else {
      await assertSourceRetained(entry, mode === "changed" ? "src/a.txt" : entry.file, mode === "changed" ? "later restart bytes\n" : "restart output\n");
      assert.match(record.autoIntegration.worktreeCleanup, mode === "changed" ? /committed_cleanup_identity_changed/ : /original_identity_missing/);
    }
    assert.equal(await head(), commit, "sweep never reapplies or commits the landed patch");
  });
}

test("WW-A2-001: fresh-runtime sweep preserves an actual durable retained cleanup task", async () => {
  const entry = await finishedJob("out/ww-durable-retain.json", { "out/ww-durable-retain.json": "durable output\n" });
  internals.setDeferredCleanupSchedulingDisabled(true);
  try {
    const outcome = await autoIntegrateQueueJob(entry.details);
    assert.equal(outcome.status, "committed", JSON.stringify(outcome));
    const taskBefore = await withDb(db => db.prepare("SELECT * FROM integration_worktree_cleanup WHERE worktree_path = ?").get(path.resolve(entry.dir)));
    assert.equal(taskBefore.status, "pending", "the actual integration engine must enqueue its validated result");
    await writeFile(path.join(entry.dir, "src/a.txt"), "durable later bytes\n");
    const outcomes = await internals.drainDeferredWorktreeCleanup(repo);
    assert.equal(outcomes.find(item => item.path === entry.dir)?.cleanup, "retained_for_review", JSON.stringify(outcomes));
    const retained = await withDb(db => db.prepare("SELECT * FROM integration_worktree_cleanup WHERE worktree_path = ?").get(path.resolve(entry.dir)));
    assert.equal(retained.status, "retained");
    await markLegacyCommitted(entry, outcome.commit);
    await sweep(await restartRuntime());
    assert.deepEqual(await withDb(db => db.prepare("SELECT * FROM integration_worktree_cleanup WHERE worktree_path = ?").get(path.resolve(entry.dir))), retained);
    await assertSourceRetained(entry, "src/a.txt", "durable later bytes\n");
  } finally { internals.setDeferredCleanupSchedulingDisabled(false); }
});

test("WW-A2-001: serial-lock contention retries cleanup after release without another commit", async () => {
  const entry = await finishedJob("out/ww-cleanup-lock.json", { "out/ww-cleanup-lock.json": "locked output\n" });
  const commit = await commitByHand(entry);
  await markLegacyCommitted(entry, commit);
  const restarted = await restartRuntime();
  const blocker = await internals.acquireHardLock({ owner: "codex", agent: "merge_manager", task: "WW cleanup blocker",
    cwd: repo, lockType: "serial_integration", repositoryScope: true, paths: ["."], ttlMs: 60_000 });
  assert.equal(blocker.ok, true, blocker.error);
  try {
    await sweep(restarted);
    assert.equal(existsSync(entry.dir), true);
    assert.match((await durable(entry.jobId)).autoIntegration.worktreeCleanup, /pending/);
  } finally { await internals.releaseHardLock(blocker.lock.id, blocker.lock.token, blocker.lock.paths, repo); }
  await sweep(restarted);
  assert.equal(existsSync(entry.dir), false, (await durable(entry.jobId)).autoIntegration.worktreeCleanup);
  assert.equal((await git(["branch", "--list", entry.details.sourceRecord.worktreeBranch])).trim(), "");
  assert.equal(await head(), commit);
});

test("WW-A2-001: original job and registry evidence cannot authorize a foreign repository source", async () => {
  const foreign = path.join(root, "ww-foreign-repository");
  await git(["clone", "-q", "--no-hardlinks", repo, foreign]);
  await git(["checkout", "-q", "-b", "ww/foreign-source"], foreign);
  worktreeBaseCommits.set(foreign, (await git(["rev-parse", "HEAD"], foreign)).trim());
  const file = "out/ww-foreign.json";
  await mkdir(path.join(foreign, "out"), { recursive: true });
  await writeFile(path.join(foreign, file), "foreign source bytes\n");
  const request = job(file, { autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir: foreign, changed: [file] });
  const queued = await enqueueQueueJob(request);
  assert.equal(queued.ok, true, queued.error);
  assert.ok(await waitFor(async () => (await durable(queued.record.jobId))?.status === "completed", 30_000));
  const record = await durable(queued.record.jobId);
  const entry = { dir: foreign, file, jobId: queued.record.jobId };
  const commit = await commitByHand(entry);
  const { createIntegrationCleanupRuntime } = await import("../lib/integration-cleanup.js");
  let sharedCleanupCalled = false;
  const runtime = createIntegrationCleanupRuntime({ ...internals, cleanupWorktree: async (...args) => {
    sharedCleanupCalled = true;
    return await internals.cleanupWorktree(...args);
  } });
  const outcome = await runtime.cleanupCommittedWorktree({ cwd: repo, worktreePath: foreign, jobId: entry.jobId,
    expectedSourceIdentity: sourceIdentityOf(record), committedCommit: commit });
  assert.equal(outcome.cleanup, "retained_for_review", JSON.stringify(outcome));
  assert.equal(sharedCleanupCalled, false, "repository provenance must fail before the shared remover is reached");
  assert.equal(readFileSync(path.join(foreign, file), "utf8"), "foreign source bytes\n");
  assert.equal((await git(["branch", "--show-current"], foreign)).trim(), "ww/foreign-source");
});

await runFlexTests({ isolatedStateDir, file: "tests/review-flex-auto-integrate.js", tests, cleanup: fixture.cleanup, finishSkips, label: "auto-integration" });
void identity;
