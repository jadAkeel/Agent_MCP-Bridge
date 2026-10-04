#!/usr/bin/env node

// Regression tests for the three speed-up options the user chose on 2026-09-29 (log.md,
// "Measurement follow-up"): 1 target captures start from the target's own index, 2 no
// back-to-back pre-apply capture without a hook, 3 in-worktree attestation cached by base tree.
//   node tests/review-speedup.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  agentMetadataCacheKey,
  assert,
  cleanupWorktree,
  createPatchFromWorkingTree,
  createWorktreeForJob,
  integratePatchSerially,
  integrationTimingStorage,
  mkdir,
  mkdtemp,
  path,
  rm,
  runCommand,
  tmpdir,
  writeFile,
} = __selfTest.internals;
const { utimes, stat } = await import("node:fs/promises");

const stateDir = await mkdtemp(path.join(tmpdir(), "review-speedup-state-"));
selfTestHooks.stateDirectoryOverride = stateDir;
const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
async function makeRepo(files) {
  const repo = await mkdtemp(path.join(tmpdir(), "review-speedup-repo-"));
  await git(["init", "-q"], repo);
  await git(["config", "core.autocrlf", "false"], repo);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content, "utf8");
  }
  await git(["add", "."], repo);
  await git([...gitIdentity, "commit", "-q", "-m", "init"], repo);
  return { repo, head: (await git(["rev-parse", "HEAD"], repo)).trim() };
}
async function capture(repo, head, trustIndexStat) {
  const phases = {};
  const patch = await integrationTimingStorage.run(phases, () => createPatchFromWorkingTree(repo, head, { trustIndexStat }));
  assert.equal(patch.ok, true, JSON.stringify(patch));
  return { patch, phases };
}

const repos = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("1: a target capture from the target's own index equals the fresh-index capture", async () => {
  const { repo, head } = await makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n", "src/e.txt": "e\n" });
  repos.push(repo);
  await writeFile(path.join(repo, "a.txt"), "a changed\n", "utf8");
  await writeFile(path.join(repo, "b.txt"), "b staged\n", "utf8");
  await git(["add", "b.txt"], repo);
  await writeFile(path.join(repo, "b.txt"), "b staged then changed again\n", "utf8");
  await rm(path.join(repo, "c.txt"));
  await git(["rm", "-q", "--cached", "d.txt"], repo);
  await writeFile(path.join(repo, "new.txt"), "untracked\n", "utf8");
  const fresh = await capture(repo, head, false);
  const seeded = await capture(repo, head, true);
  assert.equal(fresh.phases.freshIndexHash?.count, 1);
  assert.equal(seeded.phases.seededIndexHash?.count, 1, JSON.stringify(seeded.phases));
  assert.equal(seeded.patch.patchSha256, fresh.patch.patchSha256);
  assert.deepEqual(seeded.patch.changedFiles, fresh.patch.changedFiles);
  assert.deepEqual(seeded.patch.changedFiles, ["a.txt", "b.txt", "c.txt", "new.txt"]);
  assert.equal(seeded.patch.indexSha256, fresh.patch.indexSha256, "the real index is untouched by either");
});

test("1: assume-unchanged or skip-worktree entries fall back to the fresh index", async () => {
  const { repo, head } = await makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
  repos.push(repo);
  await git(["update-index", "--assume-unchanged", "a.txt"], repo);
  await writeFile(path.join(repo, "a.txt"), "hidden by assume-unchanged\n", "utf8");
  let result = await capture(repo, head, true);
  assert.equal(result.phases.freshIndexHash?.count, 1, JSON.stringify(result.phases));
  assert.equal(result.phases.seededIndexHash, undefined);
  assert.deepEqual(result.patch.changedFiles, ["a.txt"]);
  await git(["update-index", "--no-assume-unchanged", "a.txt"], repo);
  await git(["update-index", "--skip-worktree", "b.txt"], repo);
  await writeFile(path.join(repo, "b.txt"), "hidden by skip-worktree\n", "utf8");
  result = await capture(repo, head, true);
  assert.equal(result.phases.freshIndexHash?.count, 1, JSON.stringify(result.phases));
  assert.deepEqual(result.patch.changedFiles, ["a.txt", "b.txt"]);
});

test("1: the accepted trade-off: a rewrite that keeps size and mtime is only seen by the fresh index", async () => {
  const { repo, head } = await makeRepo({ "a.txt": "aaaa\n" });
  repos.push(repo);
  const file = path.join(repo, "a.txt");
  const before = await stat(file);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await git(["update-index", "--refresh"], repo);
  await writeFile(file, "bbbb\n", "utf8");
  await utimes(file, before.atime, before.mtime);
  const seeded = await capture(repo, head, true);
  const fresh = await capture(repo, head, false);
  assert.deepEqual(fresh.patch.changedFiles, ["a.txt"]);
  assert.deepEqual(seeded.patch.changedFiles, [], "documented: stat-identical rewrites of the target are not seen");
});

test("1+2: an apply rehashes the source fully, the target from its index, and skips the repeat", async () => {
  const { repo } = await makeRepo({ "src/a.txt": "a\n" });
  repos.push(repo);
  const run = async (jobId, content, hook = null) => {
    const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId, lockedPaths: ["src"], allowedEdits: ["src"] });
    assert.equal(worktree.ok, true, JSON.stringify(worktree));
    await writeFile(path.join(worktree.path, "src", "a.txt"), content, "utf8");
    const common = { cwd: repo, worktreePath: worktree.path, allowedEdits: ["src/a.txt"], validationCommand: "git diff --check", cleanupAfterSuccess: true };
    const preview = await integratePatchSerially({ ...common, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const phases = {};
    const applied = await integrationTimingStorage.run(phases, () => integratePatchSerially({
      ...common, reviewed: true, previewReceipt: preview.previewReceipt, ...(hook ? { beforeApplyHook: hook } : {}),
    }));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.sourceCleanup?.cleanup, "success", JSON.stringify(applied.sourceCleanup));
    await git([...gitIdentity, "commit", "-q", "-am", jobId], repo);
    return phases;
  };
  const plain = await run("builder-speed-1", "first\n");
  assert.equal(plain.targetState.count, 4, JSON.stringify(plain));
  assert.equal(plain.sourcePatch.count, 2);
  assert.equal(plain.freshIndexHash.count, 2, "source captures keep reading every file");
  assert.equal(plain.seededIndexHash.count, 4, "target captures start from the target's index");
  const hooked = await run("builder-speed-2", "second\n", async () => {});
  assert.equal(hooked.targetState.count, 5, "with a hook between them both pre-apply captures run");
});

test("3: the in-worktree attestation key is the repository and base tree, not the worktree path", async () => {
  const repoRoot = path.join(tmpdir(), "repo-x");
  const tree = "a".repeat(40);
  const first = agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-1"), { repoRoot, baseTree: tree });
  const second = agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-2"), { repoRoot, baseTree: tree.toUpperCase() });
  assert.equal(first, second);
  assert.notEqual(first, agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-1"), { repoRoot, baseTree: "b".repeat(40) }));
  assert.notEqual(first, agentMetadataCacheKey("debugger", path.join(tmpdir(), "wt-1"), { repoRoot, baseTree: tree }));
  assert.notEqual(first, agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-1"), { repoRoot: path.join(tmpdir(), "repo-y"), baseTree: tree }));
  // Without a proven worktree identity (or with a malformed tree id) the key stays the cwd.
  assert.equal(agentMetadataCacheKey("builder", repoRoot), agentMetadataCacheKey("builder", repoRoot, { repoRoot, baseTree: "not-a-tree" }));
  assert.notEqual(agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-1")), agentMetadataCacheKey("builder", path.join(tmpdir(), "wt-2")));
});

let failed = 0;
try {
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
  for (const directory of [...repos, stateDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} speed-up regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} speed-up regression tests passed.\n`);
process.exit(0);
