#!/usr/bin/env node

// G-10 (third production review pass): integration dry runs, applies and writer worktree
// creation are refused while the target repository is in the middle of a merge, rebase,
// cherry-pick, revert or bisect, or its index has unmerged entries, whatever allowDirtyTarget
// says. Each case builds its own scratch repository with the operator's plain Git.
//   node tests/review3-g10.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-review3-g10-"));
const userGlobalConfig = path.join(fixtureRoot, "user-global.gitconfig");
await writeFile(userGlobalConfig, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_STATE_DIR = path.join(fixtureRoot, "bridge-global-state");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  cleanupWorktree,
  createWorktreeForJob,
  inspectRepositoryOperationState,
  integratePatchSerially,
} = __selfTest.internals;

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };

async function userGit(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv, maxBuffer: 1024 * 1024 * 16, windowsHide: true });
  return stdout;
}
// A git command that is expected to stop with a conflict (non-zero exit).
async function userGitMayFail(cwd, ...args) {
  try {
    return { exitCode: 0, stdout: await userGit(cwd, ...args) };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

let repoCounter = 0;
// main: base commit with conflict.txt; branch "other" changes conflict.txt one way and main
// another way, so merging/rebasing/cherry-picking "other" conflicts. Branch "feature" (from the
// base) adds feature.txt only: the patch the bridge integrates.
async function makeRepo(name) {
  repoCounter += 1;
  const repo = path.join(fixtureRoot, `${String(repoCounter).padStart(2, "0")}-${name}`);
  await mkdir(repo, { recursive: true });
  await userGit(repo, "init", "-q", "-b", "main");
  await userGit(repo, "config", "user.email", "review3@example.invalid");
  await userGit(repo, "config", "user.name", "Review Three");
  await writeFile(path.join(repo, "conflict.txt"), "base\n");
  await writeFile(path.join(repo, "keep.txt"), "keep\n");
  await userGit(repo, "add", "-A");
  await userGit(repo, "commit", "-q", "-m", "base");
  await userGit(repo, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  await userGit(repo, "add", "feature.txt");
  await userGit(repo, "commit", "-q", "-m", "feature");
  await userGit(repo, "checkout", "-q", "-b", "other", "main");
  await writeFile(path.join(repo, "conflict.txt"), "other\n");
  await userGit(repo, "commit", "-q", "-am", "other");
  await userGit(repo, "checkout", "-q", "main");
  await writeFile(path.join(repo, "conflict.txt"), "main\n");
  await userGit(repo, "commit", "-q", "-am", "main");
  return repo;
}

const featureSource = { branch: "feature" };
const common = (repo, extra = {}) => ({ cwd: repo, ...featureSource, allowedEdits: ["feature.txt"], validationCommand: "git diff --check", ...extra });

async function assertRefused(repo, expectedNames, { unmerged = false } = {}) {
  const state = await inspectRepositoryOperationState(repo);
  assert.equal(state.ok, false, JSON.stringify(state));
  assert.equal(state.errorType, "target_operation_in_progress");
  for (const name of expectedNames) assert.ok(state.operationState.includes(name), `${name} missing: ${JSON.stringify(state)}`);
  if (unmerged) assert.deepEqual(state.unmergedPaths, ["conflict.txt"]);
  assert.match(state.suggestedFix, /Finish or abort/);
  for (const allowDirtyTarget of [false, true]) {
    const preview = await integratePatchSerially(common(repo, { dryRun: true, allowDirtyTarget }));
    assert.equal(preview.ok, false, JSON.stringify(preview));
    assert.equal(preview.errorType, "target_operation_in_progress", JSON.stringify(preview));
    assert.equal(preview.previewReceipt, undefined);
  }
  assert.equal(existsSync(path.join(repo, "feature.txt")), false, "the target was modified");
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: `g10-${repoCounter}`, lockedPaths: ["feature.txt"], allowedEdits: ["feature.txt"] });
  assert.equal(worktree.ok, false, JSON.stringify(worktree));
  assert.equal(worktree.errorType, "target_operation_in_progress", JSON.stringify(worktree));
  assert.equal((await userGit(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm).length, 1);
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS [G-10] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL [G-10] ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
selfTestHooks.stateDirectoryOverride = path.join(fixtureRoot, "bridge-state");
try {
  await check("a clean target still integrates, and a writer worktree is still created", async () => {
    const repo = await makeRepo("clean");
    assert.deepEqual(await inspectRepositoryOperationState(repo), { ok: true });
    const preview = await integratePatchSerially(common(repo, { dryRun: true }));
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await integratePatchSerially(common(repo, { reviewed: true, previewReceipt: preview.previewReceipt }));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(path.join(repo, "feature.txt"), "utf8"), "feature\n");
    // The integration leaves the change uncommitted for the coordinator; commit it so the
    // checkout is a clean writer base again.
    await userGit(repo, "add", "feature.txt");
    await userGit(repo, "commit", "-q", "-m", "integrated");
    const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "g10-clean", lockedPaths: ["keep.txt"], allowedEdits: ["keep.txt"] });
    assert.equal(worktree.ok, true, JSON.stringify(worktree));
    await cleanupWorktree(worktree, "always", true);
  });

  await check("a conflicted merge (MERGE_HEAD and unmerged entries) is refused", async () => {
    const repo = await makeRepo("merge-conflict");
    assert.notEqual((await userGitMayFail(repo, "merge", "--no-edit", "other")).exitCode, 0);
    await assertRefused(repo, ["MERGE_HEAD"], { unmerged: true });
  });

  await check("a clean merge stopped with --no-commit (MERGE_HEAD only) is refused, even with allowDirtyTarget", async () => {
    const repo = await makeRepo("merge-no-commit");
    await userGit(repo, "merge", "--no-commit", "--no-ff", "-s", "ours", "other");
    assert.equal((await userGit(repo, "status", "--porcelain")).trim(), "", "the -s ours merge should leave no status change");
    await assertRefused(repo, ["MERGE_HEAD"]);
  });

  await check("a conflicted rebase (rebase-merge/ and REBASE_HEAD) is refused", async () => {
    const repo = await makeRepo("rebase-merge");
    await userGit(repo, "checkout", "-q", "-b", "rebasing", "other");
    assert.notEqual((await userGitMayFail(repo, "rebase", "--merge", "main")).exitCode, 0);
    await assertRefused(repo, ["rebase-merge", "REBASE_HEAD"], { unmerged: true });
  });

  await check("a conflicted apply-backend rebase (rebase-apply/) is refused", async () => {
    const repo = await makeRepo("rebase-apply");
    await userGit(repo, "checkout", "-q", "-b", "rebasing", "other");
    assert.notEqual((await userGitMayFail(repo, "rebase", "--apply", "main")).exitCode, 0);
    await assertRefused(repo, ["rebase-apply"]);
  });

  await check("a conflicted cherry-pick (CHERRY_PICK_HEAD) is refused", async () => {
    const repo = await makeRepo("cherry-pick");
    assert.notEqual((await userGitMayFail(repo, "cherry-pick", "other")).exitCode, 0);
    await assertRefused(repo, ["CHERRY_PICK_HEAD"], { unmerged: true });
  });

  await check("a conflicted revert (REVERT_HEAD) is refused", async () => {
    const repo = await makeRepo("revert");
    // Reverting "base" conflicts with main's later edit of conflict.txt.
    const base = (await userGit(repo, "rev-list", "--max-parents=0", "main")).trim();
    await writeFile(path.join(repo, "conflict.txt"), "main again\n");
    await userGit(repo, "commit", "-q", "-am", "main again");
    const revertBase = (await userGitMayFail(repo, "revert", "--no-edit", "HEAD~1")).exitCode;
    assert.notEqual(revertBase, 0, `revert of HEAD~1 did not conflict (base ${base})`);
    await assertRefused(repo, ["REVERT_HEAD"], { unmerged: true });
  });

  await check("a bisect in progress (BISECT_LOG) is refused", async () => {
    const repo = await makeRepo("bisect");
    await userGit(repo, "bisect", "start");
    await userGit(repo, "bisect", "bad", "main");
    await assertRefused(repo, ["BISECT_LOG"]);
  });

  await check("unmerged index entries without any operation file are refused", async () => {
    const repo = await makeRepo("unmerged-only");
    assert.notEqual((await userGitMayFail(repo, "merge", "--no-edit", "other")).exitCode, 0);
    for (const name of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) {
      await rm(path.join(repo, ".git", name), { force: true });
    }
    const state = await inspectRepositoryOperationState(repo);
    assert.deepEqual(state.operationState, []);
    await assertRefused(repo, [], { unmerged: true });
  });

  await check("a linked worktree mid-merge is refused while its main checkout still integrates", async () => {
    const repo = await makeRepo("linked-main");
    const linked = path.join(fixtureRoot, `${String(repoCounter).padStart(2, "0")}-linked`);
    await userGit(repo, "worktree", "add", "-q", "-b", "side", linked, "main");
    assert.notEqual((await userGitMayFail(linked, "merge", "--no-edit", "other")).exitCode, 0);
    assert.equal(existsSync(path.join(linked, ".git", "MERGE_HEAD")), false, ".git of a linked worktree is a file");
    const state = await inspectRepositoryOperationState(linked);
    assert.equal(state.errorType, "target_operation_in_progress", JSON.stringify(state));
    assert.ok(state.operationState.includes("MERGE_HEAD"));
    const linkedPreview = await integratePatchSerially(common(linked, { dryRun: true, allowDirtyTarget: true }));
    assert.equal(linkedPreview.errorType, "target_operation_in_progress", JSON.stringify(linkedPreview));
    assert.deepEqual(await inspectRepositoryOperationState(repo), { ok: true });
    const preview = await integratePatchSerially(common(repo, { dryRun: true }));
    assert.equal(preview.ok, true, JSON.stringify(preview));
  });

  await check("a merge started between the dry run and the apply is refused before any write", async () => {
    const repo = await makeRepo("merge-after-preview");
    const preview = await integratePatchSerially(common(repo, { dryRun: true }));
    assert.equal(preview.ok, true, JSON.stringify(preview));
    await userGit(repo, "merge", "--no-commit", "--no-ff", "-s", "ours", "other");
    const applied = await integratePatchSerially(common(repo, { reviewed: true, previewReceipt: preview.previewReceipt }));
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.errorType, "target_operation_in_progress", JSON.stringify(applied));
    assert.equal(existsSync(path.join(repo, "feature.txt")), false);
  });

  await check("a merge started inside the final pre-apply window is refused before any write", async () => {
    const repo = await makeRepo("merge-in-window");
    const preview = await integratePatchSerially(common(repo, { dryRun: true }));
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await integratePatchSerially(common(repo, {
      reviewed: true,
      previewReceipt: preview.previewReceipt,
      beforeApplyHook: async () => { await userGit(repo, "merge", "--no-commit", "--no-ff", "-s", "ours", "other"); },
    }));
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.errorType, "target_operation_in_progress", JSON.stringify(applied));
    assert.match(applied.error, /The patch was not applied/);
    assert.equal(existsSync(path.join(repo, "feature.txt")), false);
  });
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} G-10 target operation state tests passed.`);
if (failed.length) process.exitCode = 1;
