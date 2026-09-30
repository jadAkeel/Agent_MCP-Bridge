#!/usr/bin/env node

// Regression test for B-030 (log.md, 2026-09-30): removing a worktree whose ignored
// node_modules/ was a junction into another checkout deleted that checkout's files, because
// `git worktree remove` on Windows recurses through a junction. Git and the filesystem are real.
//   node tests/review-b030.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const { detachWorktreeLinks } = await import("../bin/worktree-links.js");
const { assert, cleanupWorktree, mkdir, mkdtemp, path, rm, runCommand, tmpdir, writeFile } = __selfTest.internals;
const { existsSync } = await import("node:fs");
const { symlink } = await import("node:fs/promises");

const LINK_KIND = process.platform === "win32" ? "junction" : "dir";
const root = await mkdtemp(path.join(tmpdir(), "review-b030-"));
const repo = path.join(root, "repo");
const shared = path.join(root, "shared-node_modules");
const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repo) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function sharedDependencies() {
  await mkdir(path.join(shared, "pkg", "lib"), { recursive: true });
  await writeFile(path.join(shared, "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  await writeFile(path.join(shared, "pkg", "lib", "a.js"), "a\n", "utf8");
}
const sharedIntact = () => existsSync(path.join(shared, "pkg", "index.js")) && existsSync(path.join(shared, "pkg", "lib", "a.js"));

let counter = 0;
async function worktreeWithLinks() {
  counter += 1;
  const branch = `agent/builder/b030-${counter}`;
  const worktreePath = path.join(root, `wt-${counter}`);
  await git(["worktree", "add", "-q", "-b", branch, worktreePath, "HEAD"]);
  await symlink(shared, path.join(worktreePath, "node_modules"), LINK_KIND);
  // A nested link inside an ignored real directory is found too.
  await mkdir(path.join(worktreePath, "build", "deep"), { recursive: true });
  await symlink(shared, path.join(worktreePath, "build", "deep", "linked"), LINK_KIND);
  return { path: worktreePath, branch, repoRoot: repo };
}

test("cleanupWorktree removes the worktree and leaves a junction's target intact", async () => {
  await sharedDependencies();
  const worktree = await worktreeWithLinks();
  const cleanup = await cleanupWorktree(worktree, "always", true);
  assert.equal(cleanup.cleanup, "success", JSON.stringify(cleanup));
  assert.equal(existsSync(worktree.path), false);
  assert.ok(sharedIntact(), "B-030: the worktree removal deleted the files behind the junction");
});

test("detachWorktreeLinks unlinks only the links, never the directories they point at", async () => {
  await sharedDependencies();
  const worktree = await worktreeWithLinks();
  const detached = await detachWorktreeLinks(worktree.path);
  assert.deepEqual(detached.detached.sort(), ["build/deep/linked", "node_modules"]);
  assert.equal(existsSync(path.join(worktree.path, "node_modules")), false);
  assert.equal(existsSync(path.join(worktree.path, "build", "deep")), true);
  assert.ok(sharedIntact());
  assert.deepEqual(await detachWorktreeLinks(worktree.path), { detached: [], keptTracked: [] });
  await cleanupWorktree(worktree, "always", true);
});

test("a tracked symlink is git's own entry and is left in place", async () => {
  const probe = path.join(root, "symlink-probe");
  try {
    await symlink(shared, probe, "dir");
    await rm(probe, { force: true });
  } catch (error) {
    if (error?.code === "EPERM") {
      process.stdout.write("skip (symlinks need Developer Mode or admin on this Windows host)\n");
      return;
    }
    throw error;
  }
  const trackedRepo = path.join(root, "tracked-repo");
  await mkdir(trackedRepo, { recursive: true });
  await git(["init", "-q"], trackedRepo);
  await git(["config", "core.symlinks", "true"], trackedRepo);
  await writeFile(path.join(trackedRepo, "target.txt"), "t\n", "utf8");
  await symlink("target.txt", path.join(trackedRepo, "link.txt"));
  await git(["add", "."], trackedRepo);
  await git([...gitIdentity, "commit", "-q", "-m", "link"], trackedRepo);
  const result = await detachWorktreeLinks(trackedRepo);
  assert.deepEqual(result, { detached: [], keptTracked: ["link.txt"] });
  assert.equal(existsSync(path.join(trackedRepo, "link.txt")), true);
});

let failed = 0;
try {
  await mkdir(repo, { recursive: true });
  await git(["init", "-q"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, ".gitignore"), "node_modules\nbuild/\n", "utf8");
  await writeFile(path.join(repo, "a.txt"), "a\n", "utf8");
  await git(["add", "."]);
  await git([...gitIdentity, "commit", "-q", "-m", "init"]);
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} B-030 tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} B-030 tests passed.\n`);
process.exit(0);
