// Shared scratch fixture for the tests/review-flex-*.js files (flexible scheduling, log.md
// B-060, B-061, Q-005..Q-010). The caller sets its environment and imports ../server.js first (the bridge reads its
// environment at import), then passes __selfTest here. Everything lives in one scratch folder: a
// git repository, the bridge state directory and the worktree root; nothing touches the operator's
// state, clients or OpenCode files.

export async function makeFlexFixture(selfTest, name) {
  const { hooks, internals } = selfTest;
  const { assert, mkdir, mkdtemp, path, resolveProjectStateRoot, rm, runCommand, server, tmpdir, writeFile } = internals;
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const stateDir = path.join(root, "state");
  const repoInput = path.join(root, "repo");
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(repoInput, "src"), { recursive: true });
  hooks.stateDirectoryOverride = stateDir;
  hooks.queueModeOverride = "sqlite";

  const identity = ["-c", "user.name=Flex Review", "-c", "user.email=flex-review@example.invalid"];
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
  await git([...identity, "commit", "-q", "-m", "init"]);
  const repo = await resolveProjectStateRoot(repoInput);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate, timeoutMs = 8000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(stepMs);
    }
    return Boolean(await predicate());
  }
  const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
  const callTool = (toolName, args) => server._registeredTools[toolName].handler(args, {});
  const durable = (jobId) => internals.readPersistedQueueRecord(jobId, repo);
  const terminal = (status) => ["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(status);

  const execution = ({ errorType = "", changedFiles = [], noChanges = false, configuredProvider = "", configuredModel = "", worktree = null, validation = null, text = "REPORT: done." } = {}) => ({
    response: { content: [{ type: "text", text: errorType ? `Job failed.\nerrorType: ${errorType}` : text }] },
    result: { errorType, changedFiles, noChanges, configuredProvider, configuredModel },
    validation,
    worktree,
  });
  const readJob = (extra = {}) => ({
    agent: "reviewer", task: "Review src/a.txt.", cwd: repo, write: false, lockMode: "off",
    scopeContract: { mode: "read", read: ["src/a.txt"] }, ...extra,
  });
  const writeScope = (file) => ({ mode: "write", read: ["src"], write: [file], allowedEdits: [file], forbidden: [".env"], validationCommand: "git diff --check" });
  const writeJob = (file = "src/a.txt", extra = {}) => ({
    agent: "builder", task: `Edit ${file}.`, cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src"], allowedEdits: [file], validationCommand: "git diff --check", timeoutMs: 600000,
    scopeContract: writeScope(file), ...extra,
  });

  async function cleanup() {
    hooks.stateDirectoryOverride = "";
    hooks.queueModeOverride = "";
    hooks.queueJobExecutorTestHook = null;
    hooks.agentRuntimeTestHook = null;
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }

  return { root, stateDir, repo, repoInput, identity, git, sleep, waitFor, textOf, callTool, durable, terminal, execution, readJob, writeJob, writeScope, cleanup };
}

// Runs the collected tests, prints one line each and exits with the skip gate's verdict.
export async function runFlexTests({ file, tests, cleanup, finishSkips, label }) {
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
    await cleanup();
  }
  const skipGateFailed = finishSkips({ file, total: tests.length, skips: [] });
  if (failed || skipGateFailed) {
    process.stdout.write(`${failed} of ${tests.length} ${label} tests failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`All ${tests.length} ${label} tests passed.\n`);
  process.exit(0);
}
