#!/usr/bin/env node
// B-194: real Git, receipts, validation and SQLite; all data under a scratch root.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { finishSkips } from "./skip-gate.js";

process.argv.push("--self-test");
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "bridge-integration-reuse-"));
const state = path.join(root, "state");
process.env.CODEX_OPENCODE_STATE_DIR = state;
process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[core]\n autocrlf = false\n[user]\n name = Reuse Test\n email = reuse@example.invalid\n");
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals;
I.setDeferredCleanupSchedulingDisabled(true);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let counter = 0;
const git = async (cwd, ...args) => (await execute("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout;
const database = async (cwd, operation) => {
  const db = await I.openLockDb(cwd);
  try { return operation(db); } finally { I.closeDb(db); }
};
async function fixture() {
  const cwd = path.join(root, "repo-" + ++counter);
  await mkdir(cwd);
  await git(cwd, "init", "-q", "-b", "main");
  for (const file of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(cwd, file), "original\n");
  await writeFile(path.join(cwd, ".gitignore"), "*.secret\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-q", "-m", "fixture");
  const worktreePath = path.join(I.generatedWorktreeRootForCwd(cwd), "source");
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const branch = "reuse-source-" + counter;
  await git(cwd, "worktree", "add", "-q", "-b", branch, worktreePath);
  await writeFile(path.join(worktreePath, "a.txt"), "reviewed\n");
  const options = { cwd, worktreePath, allowedEdits: ["a.txt"], validationCommand: "git diff --check", cleanupAfterSuccess: true };
  return { cwd, worktreePath, branch, options };
}
const preview = async (f, overrides = {}) => {
  const result = await I.integratePatchSerially({ ...f.options, ...overrides, dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const apply = (f, p, overrides = {}) => I.integratePatchSerially({ ...f.options, ...overrides, reviewed: true, previewReceipt: p.previewReceipt });
const pending = (f) => database(f.cwd, db => db.prepare("SELECT * FROM integration_worktree_cleanup WHERE worktree_path = ?").get(f.worktreePath));
const artifact = (f) => database(f.cwd, db => db.prepare("SELECT * FROM worktree_artifacts WHERE worktree_path = ?").get(f.worktreePath));
const cases = [];
const test = (name, run) => cases.push({ name, run });

test("unchanged apply collects no second patch and leaves durable cleanup before replying", async () => {
  const f = await fixture();
  const started = Date.now();
  const p = await preview(f);
  const dryRunMs = Date.now() - started;
  const phases = {};
  const applyStarted = Date.now();
  const result = await I.integrationTimingStorage.run(phases, () => apply(f, p));
  const applyMs = Date.now() - applyStarted;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.previewReused, true);
  assert.equal(phases.sourcePatch?.count || 0, 0, "no second patch collection");
  assert.equal(phases.simulate?.count || 0, 0, "the proved dry-run simulation is reused");
  assert.equal(result.validationGate.status, "passed");
  assert.equal(result.sourceCleanup.cleanup, "pending");
  assert.equal(existsSync(f.worktreePath), true);
  assert.equal((await artifact(f)).status, "cleanup_pending");
  assert.equal((await pending(f)).status, "pending");
  const clean = await I.drainDeferredWorktreeCleanup(f.cwd);
  assert.equal(clean[0].cleanup, "success", JSON.stringify(clean));
  assert.equal(existsSync(f.worktreePath), false);
  assert.equal((await git(f.cwd, "branch", "--list", f.branch)).trim(), "");
  assert.equal(await artifact(f), undefined);
  assert.equal(await pending(f), undefined);
  console.log(JSON.stringify({ dryRunMs, applyMs, phases }));
});
test("foreground integration waits for an internal deferred-cleanup lease", async () => {
  const f = await fixture();
  const claimed = await I.acquireHardLock({ owner: "codex", agent: "merge_manager",
    task: "Deferred reviewed worktree cleanup", cwd: f.cwd, lockType: "serial_integration",
    paths: ["."], repositoryScope: true, ttlMs: 60_000 });
  assert.equal(claimed.ok, true);
  const timer = setTimeout(() => I.releaseHardLock(claimed.lock.id, claimed.lock.token, claimed.lock.paths, f.cwd), 1000);
  try { await preview(f); }
  finally {
    clearTimeout(timer);
    await I.releaseHardLock(claimed.lock.id, claimed.lock.token, claimed.lock.paths, f.cwd);
  }
});
test("a source rewrite with restored mtime falls back and refuses the old receipt", async () => {
  const f = await fixture(), p = await preview(f);
  const file = path.join(f.worktreePath, "a.txt"), details = await stat(file);
  await writeFile(file, "modified\n");
  await utimes(file, details.atime, details.mtime);
  const phases = {};
  const result = await I.integrationTimingStorage.run(phases, () => apply(f, p));
  assert.equal(result.errorType, "integration_preview_stale");
  assert.equal(phases.sourcePatch.count, 1);
  assert.equal(await readFile(path.join(f.cwd, "a.txt"), "utf8"), "original\n");
});
test("an added source file and an ignored source credential cannot be hidden by reuse", async () => {
  for (const file of ["new.txt", "credential.secret"]) {
    const f = await fixture(), p = await preview(f);
    await writeFile(path.join(f.worktreePath, file), "new source bytes\n");
    const result = await apply(f, p);
    assert.equal(result.ok, false);
    assert.equal(result.errorType, file.endsWith(".secret") ? "integration_source_unrepresentable" : "integration_preview_stale");
  }
});
test("target working bytes and a commit touching a patched path refuse the old receipt", async () => {
  for (const commit of [false, true]) {
    const f = await fixture(), p = await preview(f);
    await writeFile(path.join(f.cwd, "a.txt"), "someone else's bytes\n");
    if (commit) { await git(f.cwd, "add", "a.txt"); await git(f.cwd, "commit", "-q", "-m", "target moved"); }
    const result = await apply(f, p);
    assert.equal(result.errorType, "integration_preview_stale", JSON.stringify(result));
  }
});
test("an extra argument still names the exact receipt contract mismatch", async () => {
  const f = await fixture(), p = await preview(f);
  const result = await apply(f, p, { allowedEdits: ["a.txt", "b.txt"] });
  assert.equal(result.errorType, "integration_preview_contract_mismatch");
  assert.match(result.error, /allowedEdits/);
});
test("real validation failure rolls back a reused patch and retains the worktree", async () => {
  const f = await fixture();
  f.options.validationCommand = "git diff --exit-code";
  const p = await preview(f);
  const phases = {};
  const result = await I.integrationTimingStorage.run(phases, () => apply(f, p));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(phases.sourcePatch?.count || 0, 0);
  assert.equal(result.validationGate.status, "failed");
  assert.equal(await readFile(path.join(f.cwd, "a.txt"), "utf8"), "original\n");
  assert.equal(existsSync(f.worktreePath), true);
  assert.equal(await pending(f), undefined);
});
test("the durable receipt is still consumed once", async () => {
  const f = await fixture();
  f.options.cleanupAfterSuccess = false;
  const p = await preview(f);
  const first = await apply(f, p);
  assert.equal(first.ok, true);
  assert.match(await I.integrationPreviewReceiptError(p.previewReceipt,
    { ...p.previewReceipt, changedFiles: p.changedFiles }, false, f.cwd), /already consumed/);
  const replay = await apply(f, p, { allowDirtyTarget: true });
  assert.equal(replay.ok, false);
  assert.equal(await pending(f), undefined);
});
test("a corrupt optional analysis is a miss and the same valid receipt uses full collection", async () => {
  const f = await fixture(), p = await preview(f);
  const entry = I.INTEGRATION_PREVIEWS.get(p.previewReceipt.previewId);
  assert.ok(entry.reuseBytes?.length);
  entry.reuseBytes[0] ^= 0xff;
  const phases = {};
  const result = await I.integrationTimingStorage.run(phases, () => apply(f, p));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.previewReused, false);
  assert.equal(phases.sourcePatch.count, 1);
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "success");
});
test("mutations after apply keep both the source and its registry evidence", async () => {
  for (const sourceChanged of [true, false]) {
    const f = await fixture(), p = await preview(f);
    assert.equal((await apply(f, p)).ok, true);
    await writeFile(path.join(sourceChanged ? f.worktreePath : f.cwd, "b.txt"), "after validation\n");
    const results = await I.drainDeferredWorktreeCleanup(f.cwd);
    assert.equal(results[0].cleanup, "retained_for_review", JSON.stringify(results));
    assert.equal(existsSync(f.worktreePath), true);
    assert.equal((await artifact(f)).status, "retained");
    assert.equal((await pending(f)).status, "retained");
  }
});
test("a newly validated integration replaces a prior retained cleanup task", async () => {
  const f = await fixture(), p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  await writeFile(path.join(f.cwd, "b.txt"), "later target edit\n");
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "retained_for_review");
  const oldTask = await pending(f);
  await git(f.cwd, "add", ".");
  await git(f.cwd, "commit", "-q", "-m", "target progress");
  const head = (await git(f.cwd, "rev-parse", "HEAD")).trim();
  await git(f.worktreePath, "reset", "--hard", head);
  await writeFile(path.join(f.worktreePath, "a.txt"), "second reviewed edit\n");
  const p2 = await preview(f), result = await apply(f, p2);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sourceCleanup.cleanup, "pending");
  assert.notEqual((await pending(f)).payload_json, oldTask.payload_json);
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "success");
  assert.equal(await pending(f), undefined);
  assert.equal(await artifact(f), undefined);
});
test("an in_use source is never removed by deferred cleanup", async () => {
  const f = await fixture(), p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  await database(f.cwd, db => db.prepare("UPDATE worktree_artifacts SET status = 'in_use' WHERE worktree_path = ?").run(f.worktreePath));
  const results = await I.drainDeferredWorktreeCleanup(f.cwd);
  assert.equal(results[0].reason, "worktree_in_use");
  assert.equal(existsSync(f.worktreePath), true);
  await database(f.cwd, db => db.prepare("UPDATE worktree_artifacts SET status = 'cleanup_pending' WHERE worktree_path = ?").run(f.worktreePath));
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "success");
});
test("two successive applies keep separate deferred source identities", async () => {
  const f = await fixture();
  const secondPath = path.join(path.dirname(f.worktreePath), "second");
  await git(f.cwd, "worktree", "add", "-q", "-b", f.branch + "-second", secondPath);
  await writeFile(path.join(secondPath, "b.txt"), "second patch\n");
  const p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  const second = { ...f, worktreePath: secondPath, options: { ...f.options, worktreePath: secondPath, allowedEdits: ["b.txt"], allowDirtyTarget: true } };
  const p2 = await preview(second);
  assert.equal((await apply(second, p2)).ok, true);
  const results = await I.drainDeferredWorktreeCleanup(f.cwd);
  // The first's target baseline has changed: retain it, remove only the second.
  assert.equal(results.find(row => row.path === f.worktreePath).cleanup, "retained_for_review");
  assert.equal(results.find(row => row.path === secondPath).cleanup, "success");
  assert.equal(await readFile(path.join(f.cwd, "a.txt"), "utf8"), "reviewed\n");
  assert.equal(await readFile(path.join(f.cwd, "b.txt"), "utf8"), "second patch\n");
});
test("cleanup yields to an active auto-integration chain without acquiring a lease", async () => {
  const f = await fixture(), p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  const key = process.platform === "win32" ? f.cwd.toLowerCase() : f.cwd;
  I.AUTO_INTEGRATION_CHAINS.set(key, Promise.resolve());
  try {
    const outcomes = await I.drainDeferredWorktreeCleanup(f.cwd);
    assert.equal(outcomes[0].reason, "foreground_auto_integration_active");
    assert.equal(existsSync(f.worktreePath), true);
  } finally { I.AUTO_INTEGRATION_CHAINS.delete(key); }
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "success");
});
test("two engine-committed integrations keep the original ancestry cleanup policy", async () => {
  const f = await fixture();
  await writeFile(path.join(f.worktreePath, "a.txt"), "original\n");
  await writeFile(path.join(f.worktreePath, "first.txt"), "first\n");
  f.options.allowedEdits = ["first.txt"];
  const p = await preview(f);
  const first = await apply(f, p, { afterApply: I.autoIntegrationCommitHooks({ jobId: "first", agent: "builder", worktreePath: f.worktreePath }) });
  assert.equal(first.afterApply.ok, true, JSON.stringify(first));
  const secondPath = path.join(path.dirname(f.worktreePath), "second-committed");
  await git(f.cwd, "worktree", "add", "-q", "-b", f.branch + "-committed", secondPath);
  await writeFile(path.join(secondPath, "second.txt"), "second\n");
  const second = { ...f, worktreePath: secondPath, options: { ...f.options, worktreePath: secondPath, allowedEdits: ["second.txt"] } };
  const p2 = await preview(second);
  const result = await apply(second, p2, { afterApply: I.autoIntegrationCommitHooks({ jobId: "second", agent: "builder", worktreePath: secondPath }) });
  assert.equal(result.afterApply.ok, true, JSON.stringify(result));
  const outcomes = await I.drainDeferredWorktreeCleanup(f.cwd);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(item => item.cleanup === "success"), JSON.stringify(outcomes));
  assert.equal(existsSync(f.worktreePath), false);
  assert.equal(existsSync(secondPath), false);
  assert.equal(await artifact(f), undefined);
});
test("automatic removal finishes after the reply within a bounded time", async () => {
  const f = await fixture(), p = await preview(f);
  I.setDeferredCleanupSchedulingDisabled(false);
  try {
    const result = await apply(f, p);
    assert.equal(result.sourceCleanup.cleanup, "pending");
    assert.equal(existsSync(f.worktreePath), true);
    const deadline = Date.now() + 20_000;
    while (await pending(f)) {
      assert.ok(Date.now() < deadline, "background removal finishes within 20 seconds");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(existsSync(f.worktreePath), false);
    assert.equal(await artifact(f), undefined);
  } finally { I.setDeferredCleanupSchedulingDisabled(true); }
});
test("a crash after directory removal preserves pending evidence until the branch is removed", async () => {
  const f = await fixture(), p = await preview(f);
  assert.equal((await apply(f, p)).ok, true);
  assert.ok(f.worktreePath.startsWith(root + path.sep));
  await git(f.cwd, "worktree", "remove", "--force", f.worktreePath);
  await I.reconcileWorktreeArtifactRegistry(f.cwd);
  assert.equal((await artifact(f)).status, "cleanup_pending");
  assert.equal((await I.drainDeferredWorktreeCleanup(f.cwd))[0].cleanup, "success");
  assert.equal((await git(f.cwd, "branch", "--list", f.branch)).trim(), "");
  assert.equal(await pending(f), undefined);
  assert.equal(await artifact(f), undefined);
});
test("a killed owner leaves cleanup that bridge-gc --apply resumes", async () => {
  const f = await fixture();
  const childFile = path.join(root, "owner.mjs");
  await writeFile(childFile, `
    process.argv.push('--self-test');
    const { __selfTest } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot,"server.js")).href)});
    const I = __selfTest.internals;
    I.setDeferredCleanupSchedulingDisabled(true);
    const options = ${JSON.stringify(f.options)};
    const p = await I.integratePatchSerially({...options,dryRun:true});
    const result = await I.integratePatchSerially({...options,reviewed:true,previewReceipt:p.previewReceipt});
    if (!result.ok) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify({ok:true,cleanup:result.sourceCleanup}));
    setInterval(()=>{},1000);
  `);
  const child = spawn(process.execPath, [childFile], { cwd: repoRoot, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", timer;
  child.stderr.on("data", chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("owner did not reply: " + errors)), 30_000);
      child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) resolve(); });
      child.on("error", reject);
      child.on("exit", code => reject(new Error("owner exited " + code + ": " + errors)));
    });
    assert.equal(JSON.parse(output.trim()).cleanup.cleanup, "pending");
    child.kill();
    await new Promise(resolve => child.once("close", resolve));
    assert.equal((await pending(f)).status, "pending");
    const dry = await execute(process.execPath, ["bin/bridge-gc.js", "--state-dir", state, "--json"], { cwd:repoRoot, env:process.env, windowsHide:true });
    assert.ok(JSON.parse(dry.stdout).report.pendingCleanup.some(row => row.path === f.worktreePath));
    await execute(process.execPath, ["bin/bridge-gc.js", "--state-dir", state, "--apply", "--json"], { cwd:repoRoot, env:process.env, windowsHide:true, timeout:30_000 });
    assert.equal(existsSync(f.worktreePath), false);
    assert.equal(await artifact(f), undefined);
    assert.equal(await pending(f), undefined);
    assert.equal((await git(f.cwd, "branch", "--list", f.branch)).trim(), "");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});
let failed = 0;
try {
  for (const { name, run } of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name, error); }
  }
} finally {
  I.setDeferredCleanupSchedulingDisabled(false);
  assert.ok(path.isAbsolute(root) && path.basename(root).startsWith("bridge-integration-reuse-"));
  await rm(root, { recursive: true, force: true });
}
finishSkips({ file: "tests/review-integration-reuse.js", total: cases.length, skips: [] });
console.log(`${cases.length - failed}/${cases.length} integration-reuse tests passed.`);
if (failed) process.exitCode = 1;
