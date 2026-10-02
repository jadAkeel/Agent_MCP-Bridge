#!/usr/bin/env node

// Q-010 (log.md, 2026-10-02): auto-integration of new-file-only patches. A queued writer with
// autoIntegrate: true whose finished patch only adds files is integrated by the bridge itself
// (dry run + receipt-bound apply of the integrate_opencode_worktree engine, validation in the
// target, rollback) and committed by pathspec with the identity of the target's last commit; any
// other patch stays for the reviewed flow. The worktrees are real git worktrees in a scratch
// folder; only the agent run is the queue executor test hook.
//   node tests/review-flex-auto-integrate.js
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
// What a builder leaves: a worktree of HEAD with its edits, uncommitted.
async function builderWorktree(edits) {
  worktrees += 1;
  const dir = path.join(root, `wt-${worktrees}`);
  // Like a bridge writer worktree: its own branch, so cleanup can verify and remove it.
  await git(["worktree", "add", "-q", "-b", `agent/builder/wt-${worktrees}`, dir, "HEAD"]);
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
hooks.queueJobExecutorTestHook = async (request) => {
  const planned = worktreeOf.get(request.task);
  return {
    response: { content: [{ type: "text", text: "REPORT: wrote the batch." }] },
    result: { errorType: "", changedFiles: planned.changed, configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" },
    validation: { status: "passed" },
    worktree: { path: planned.dir, branch: "", baseCommit: "", baseTree: "" },
  };
};
async function runAutoJob(file, edits, extra = {}) {
  const dir = await builderWorktree(edits);
  const request = job(file, extra);
  worktreeOf.set(request.task, { dir, changed: Object.keys(edits) });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, `${enqueued.errorType}: ${enqueued.error}`);
  const jobId = enqueued.record.jobId;
  const settled = (status) => Boolean(status) && status !== "waiting_for_lock";
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

test("Q-010: jobs of one repository integrate one after another, each with its own commit", async () => {
  const before = await head();
  const runs = await Promise.all([
    runAutoJob("out/batch-004.json", { "out/batch-004.json": "[4]\n" }, { lockedPaths: ["out/batch-004.json"] }),
    runAutoJob("out/batch-005.json", { "out/batch-005.json": "[5]\n" }, { lockedPaths: ["out/batch-005.json"] }),
    runAutoJob("out/batch-006.json", { "out/batch-006.json": "[6]\n" }, { lockedPaths: ["out/batch-006.json"] }),
  ]);
  for (const { record } of runs) assert.equal(record.autoIntegration.status, "committed", JSON.stringify(record.autoIntegration));
  const log = (await git(["log", "--format=%s", `${before}..HEAD`])).trim().split("\n");
  assert.equal(log.length, 3);
  assert.equal(AUTO_INTEGRATION_CHAINS.size, 0, "the chain is released");
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
});

test("Q-010: an in-place writer or another integration on the files makes the integration wait, then land", async () => {
  const { acquireHardLock, releaseHardLock } = internals;
  // A finished writer without autoIntegrate gives the terminal job row the outcome is written to.
  const dir = await builderWorktree({ "out/batch-008.json": "[8]\n" });
  const request = job("out/batch-008.json", { lockedPaths: ["out/batch-008.json"], autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-008.json"] });
  const enqueued = await enqueueQueueJob(request);
  assert.equal(enqueued.ok, true, enqueued.error);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "completed", 15_000));
  const before = await head();
  const details = { cwd: repo, jobId: enqueued.record.jobId, agent: "builder", worktreePath: dir, allowedEdits: ["out/batch-008.json"], validationCommand: VALIDATION };
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

test("Q-010: without autoIntegrate a finished writer is not touched", async () => {
  const before = await head();
  const dir = await builderWorktree({ "out/batch-007.json": "[7]\n" });
  const request = job("out/batch-007.json", { autoIntegrate: undefined });
  worktreeOf.set(request.task, { dir, changed: ["out/batch-007.json"] });
  const enqueued = await enqueueQueueJob(request);
  assert.ok(await waitFor(async () => (await durable(enqueued.record.jobId))?.status === "completed"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await head(), before);
  assert.equal((await durable(enqueued.record.jobId)).autoIntegration || null, null);
});

await runFlexTests({ isolatedStateDir, file: "tests/review-flex-auto-integrate.js", tests, cleanup: fixture.cleanup, finishSkips, label: "auto-integration" });
void identity;
