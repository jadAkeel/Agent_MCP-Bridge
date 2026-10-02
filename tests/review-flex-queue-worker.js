#!/usr/bin/env node

// Feature 10 (log.md Q-011, B-075..B-077 and the review fixes B-079..B-091, 2026-10-02): the unattended queue worker, bin/queue-worker.js,
// and the claims it relies on. The worker runs the bridge's own queue for one repository without an
// MCP client. In this process the worker runs in-process (runQueueWorker with a short tick); the
// tests that need two processes (a second worker, a hand-off after a crash, the global worker cap,
// the CLI) start this same file as a child with --queue-worker-child, which installs a fake agent
// through queueJobExecutorTestHook and runs the worker there. Everything lives in scratch folders.
//   node tests/review-flex-queue-worker.js
const CHILD_ROLE = process.argv.includes("--queue-worker-child");
if (!CHILD_ROLE && !process.argv.includes("--self-test")) process.argv.push("--self-test");

if (CHILD_ROLE) {
  await runChild();
} else {
  await runParent();
}

// A worker process for the multi-process tests. The parent passes the arguments and the fake
// agent's behaviour in QUEUE_WORKER_TEST_CHILD; the environment (state directory, leases) is set.
async function runChild() {
  const config = JSON.parse(process.env.QUEUE_WORKER_TEST_CHILD || "{}");
  const { appendFileSync, existsSync } = await import("node:fs");
  const { __selfTest } = await import("../server.js");
  const { runQueueWorker } = await import("../bin/queue-worker.js");
  const { hooks, internals } = __selfTest;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const done = (task) => ({ response: { content: [{ type: "text", text: `REPORT: ${task} done.` }] }, result: { errorType: "", changedFiles: [] }, validation: null, worktree: null });
  hooks.queueJobExecutorTestHook = async (request, { signal } = {}) => {
    appendFileSync(config.callsFile, `${JSON.stringify({ pid: process.pid, task: request.task, at: Date.now() })}\n`);
    const behaviour = (config.behaviour || {})[request.task] || "quick";
    if (behaviour === "quick") {
      await sleep(30);
      return done(request.task);
    }
    if (behaviour === "lease") {
      // The global worker cap counts provider leases; this agent holds one like a real run.
      const lease = await internals.acquireProviderLease({ providerKey: config.providerKey, timeoutMs: 10_000 });
      if (!lease.ok) throw new Error(`lease: ${lease.error}`);
      appendFileSync(config.leaseFile, "held\n");
      try {
        while (!existsSync(config.releaseFile) && !signal?.aborted) await sleep(25);
      } finally {
        await internals.releaseProviderLease(lease.lease);
      }
      return done(request.task);
    }
    // "hold": until the release file appears (or forever when it never does).
    while (!existsSync(config.releaseFile) && !signal?.aborted) await sleep(25);
    return done(request.task);
  };
  const code = await runQueueWorker(config.args, { tickMs: config.tickMs || 100, summaryMs: config.summaryMs || 60_000, signals: true });
  process.exit(code);
}

async function runParent() {
  process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
  process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
  process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
  process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
  // One job at a time in this process: the drain test needs a job that waits behind a running one.
  process.env.CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT = "1";
  delete process.env.CODEX_OPENCODE_OPS_LOG;
  delete process.env.CODEX_OPENCODE_ISSUE_LOG;
  delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
  // Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
  const { isolateBridgeStateDir } = await import("./flex-fixture.js");
  const isolatedStateDir = isolateBridgeStateDir("review-flex-queue-worker");
  const { __selfTest, queueWorkerApi } = await import("../server.js");
  const { finishSkips } = await import("./skip-gate.js");
  const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
  const { runQueueWorker, applyClientEnvironment, parseWorkerArguments } = await import("../bin/queue-worker.js");
  const { hooks, internals } = __selfTest;
  const { QUEUE_JOBS, BRIDGE_INSTANCE_ID, assert, enqueueQueueJob, mkdir, path, runCommand, writeFile } = internals;
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { fileURLToPath } = await import("node:url");

  const fixture = await makeFlexFixture(__selfTest, "review-flex-queue-worker");
  const { root, stateDir, identity, waitFor, sleep, textOf, callTool, terminal } = fixture;
  const THIS_FILE = fileURLToPath(import.meta.url);
  const WORKER_BIN = fileURLToPath(new URL("../bin/queue-worker.js", import.meta.url));

  let repoCount = 0;
  // A fresh repository per test: each worker owns one repository's queue.
  async function makeRepo(name) {
    repoCount += 1;
    const dir = path.join(root, `${name}-${repoCount}`);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const git = async (args) => {
      const result = await runCommand("git", args, dir, 60_000);
      assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    await git(["init", "-q"]);
    await git(["config", "core.autocrlf", "false"]);
    await writeFile(path.join(dir, "src", "a.txt"), "a\n", "utf8");
    await writeFile(path.join(dir, "src", "b.txt"), "b\n", "utf8");
    await git(["add", "."]);
    await git([...identity, "commit", "-q", "-m", "init"]);
    return { repo: await internals.resolveProjectStateRoot(dir), git };
  }
  const readJob = (repo, key, extra = {}) => ({
    idempotencyKey: key, agent: "reviewer", task: `Review for ${key}.`, cwd: repo, write: false, lockMode: "off",
    scopeContract: { mode: "read", read: ["src/a.txt"] }, ...extra,
  });
  const jobsFile = (name, jobs) => {
    const file = path.join(root, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(file, `${jobs.map((job) => (typeof job === "string" ? job : JSON.stringify(job))).join("\n")}\n`, "utf8");
    return file;
  };
  const durableIn = (repo, jobId) => internals.readPersistedQueueRecord(jobId, repo);
  const rowsOf = (repo) => {
    const dbPath = internals.stateDbPath(repo);
    if (!existsSync(dbPath)) return [];
    const db = new DatabaseSync(dbPath);
    try {
      // A database another process is creating may not have its tables (or columns) yet.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_jobs'").get()) return [];
      return db.prepare("SELECT job_id, status, owner_instance_id, idempotency_key, record_json FROM opencode_jobs ORDER BY created_at").all()
        .map((row) => ({ ...row, record: JSON.parse(row.record_json || "{}") }));
    } catch (error) {
      if (/no such (table|column)/.test(String(error?.message || ""))) return [];
      throw error;
    } finally {
      db.close();
    }
  };
  const readOpsLogLines = (directory) => (existsSync(directory) ? readdirSync(directory) : [])
    .filter((name) => /^bridge-.*\.jsonl$/.test(name))
    .flatMap((name) => readFileSync(path.join(directory, name), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
  const issues = () => { const file = path.join(stateDir, "logs", "issues.md"); return existsSync(file) ? readFileSync(file, "utf8") : ""; };

  // The executor of this process: per task "quick", "hold" (until released or aborted) or a function.
  const calls = [];
  const released = new Set();
  let behaviours = {};
  hooks.queueJobExecutorTestHook = async (request, { signal } = {}) => {
    calls.push(request.task);
    const behaviour = behaviours[request.task] || "quick";
    if (typeof behaviour === "function") return behaviour(request);
    if (behaviour === "hold") {
      while (!released.has(request.task) && !signal?.aborted) await sleep(20);
      if (signal?.aborted) return { response: { content: [{ type: "text", text: "Job failed.\nerrorType: agent_cancelled" }] }, result: { errorType: "agent_cancelled", changedFiles: [] }, validation: null, worktree: null };
    } else {
      await sleep(20);
    }
    return { response: { content: [{ type: "text", text: `REPORT: ${request.task} done.` }] }, result: { errorType: "", changedFiles: [] }, validation: null, worktree: null };
  };

  // runQueueWorker in this process; the result promise and the captured output.
  function startWorker(args, { tickMs = 40, api = queueWorkerApi } = {}) {
    const out = { text: "", write(chunk) { this.text += chunk; return true; } };
    const err = { text: "", write(chunk) { this.text += chunk; return true; } };
    const done = runQueueWorker(args, { out, err, tickMs, summaryMs: 150, signals: false, importServer: async () => ({ queueWorkerApi: api }) });
    return { done, out, err };
  }

  // A worker in another process (this file with --queue-worker-child).
  function childEnv(extra = {}) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^CODEX_OPENCODE_/i.test(key) && key !== "QUEUE_WORKER_TEST_CHILD") env[key] = value;
    return {
      ...env,
      CODEX_HOME: path.join(root, "codex-home"),
      CODEX_OPENCODE_STATE_DIR: stateDir,
      CODEX_OPENCODE_WORKTREE_MODE: "write",
      CODEX_OPENCODE_LOG_LEVEL: "off",
      CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
      CODEX_OPENCODE_MIN_FREE_MEMORY_MB: "0",
      CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT: "1",
      CODEX_OPENCODE_SYNC_MANAGED_RUNTIME: "false",
      ...extra,
    };
  }
  function spawnProcess(command, args, env) {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => { output.stdout += chunk; });
    child.stderr.on("data", (chunk) => { output.stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, output, exited };
  }
  function spawnWorkerChild({ args, behaviour = {}, env = {}, tickMs = 100, name }) {
    const base = path.join(root, `${name}-${Date.now()}`);
    const config = { args, behaviour, tickMs, callsFile: `${base}.calls`, releaseFile: `${base}.release`, leaseFile: `${base}.lease`, providerKey: `worker-cap-${name}` };
    writeFileSync(config.callsFile, "", "utf8");
    const spawned = spawnProcess(process.execPath, [THIS_FILE, "--queue-worker-child"], childEnv({ ...env, QUEUE_WORKER_TEST_CHILD: JSON.stringify(config) }));
    const childCalls = () => readFileSync(config.callsFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return { ...spawned, config, childCalls, release: () => writeFileSync(config.releaseFile, "go\n", "utf8") };
  }
  const runCli = async (args, env = {}) => {
    const spawned = spawnProcess(process.execPath, [WORKER_BIN, ...args], childEnv(env));
    const code = await spawned.exited;
    return { code, ...spawned.output };
  };
  // Size and mtime of every file whose name starts with one of the given paths (a database and its
  // -wal/-shm), plus the file names of the folders: --status must leave all of them alone.
  const fileStates = (paths) => paths.flatMap((file) => [file, `${file}-wal`, `${file}-shm`])
    .map((file) => `${file}=${existsSync(file) ? `${statSync(file).size}/${statSync(file).mtimeMs}` : "missing"}`);
  const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${ms} ms`)), ms))]);
  // A pending row whose owner is gone (a crashed bridge or worker): no live lease, an unknown owner.
  function orphanRow(repo, jobId) {
    QUEUE_JOBS.delete(jobId);
    const db = new DatabaseSync(internals.stateDbPath(repo));
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.prepare("UPDATE opencode_jobs SET owner_instance_id = 'dead-owner-1', owner_generation = 'dead-generation', lease_expires_at = ?, heartbeat_at = ? WHERE job_id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 120_000).toISOString(), jobId);
    } finally {
      db.close();
    }
  }

  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // ---------------------------------------------------------------------------------------------
  // Two claims the worker relies on, verified (true before this branch). B-078 (paused models are
  // not attempts) is tested in tests/review-flex-fallback.js. They use the plain queue of this
  // process, so they run before any worker.

  test("Claim 3 (verified): a retry attempt runs in a fresh worktree created from the target's current HEAD", async () => {
    const { repo, git } = await makeRepo("fresh-worktree");
    const previousExecutor = hooks.queueJobExecutorTestHook;
    hooks.queueJobExecutorTestHook = null;
    const runs = [];
    hooks.agentRuntimeTestHook = {
      resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
        requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
        fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
      }),
      readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
        name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
        canEdit: true, canDelegate: false, externalDirectoryDenied: true, webDenied: true,
        bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
      } }),
      runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun) => {
        const index = runs.length;
        runs.push({ cwd, head: (await runCommand("git", ["rev-parse", "HEAD"], cwd, 15_000)).stdout.trim() });
        if (!dryRun && index === 0) {
          // While attempt 1 runs, another batch lands in the target.
          await writeFile(path.join(repo, "src", "landed.txt"), "landed\n", "utf8");
          await git(["add", "src/landed.txt"]);
          await git([...identity, "commit", "-q", "-m", "another batch landed"]);
        }
        if (!dryRun && index === 1) await writeFile(path.join(cwd, "src", "a.txt"), "attempt two\n", "utf8");
        const failedRun = index === 0;
        return {
          exitCode: failedRun ? 1 : 0, stdout: failedRun ? "" : "Done.", stderr: "", errorType: failedRun ? "agent_idle_timeout" : null, durationMs: 1, dryRun,
          assistantFinalResponseDetected: !failedRun, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
          childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1,
        };
      },
    };
    try {
      const job = {
        agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "simple", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"],
        validationCommand: "git diff --check", timeoutMs: 600000, maxAttempts: 2,
        scopeContract: { mode: "write", read: ["src"], write: ["src/a.txt"], allowedEdits: ["src/a.txt"], forbidden: [".env"], validationCommand: "git diff --check" },
      };
      const first = await enqueueQueueJob(job);
      assert.equal(first.ok, true, first.error);
      let second = null;
      assert.ok(await waitFor(async () => {
        const record = await durableIn(repo, first.record.jobId);
        if (!record?.requeuedAs) return false;
        second = await durableIn(repo, record.requeuedAs);
        return terminal(second?.status);
      }, 30_000), "the retry ran");
      const firstRecord = await durableIn(repo, first.record.jobId);
      const newHead = (await git(["rev-parse", "HEAD"])).trim();
      assert.equal(firstRecord.errorType, "agent_idle_timeout");
      assert.equal(second.status, "completed", `${second.errorType}: ${second.errorReason}`);
      assert.equal(runs.length, 2);
      assert.notEqual(path.resolve(runs[1].cwd), path.resolve(runs[0].cwd), "a different worktree");
      assert.notEqual(runs[0].head, newHead);
      assert.equal(runs[1].head, newHead, "created from the target HEAD at the time of the retry");
      assert.equal(second.worktreeBaseCommit, newHead);
      assert.equal(existsSync(runs[0].cwd), false, "the failed attempt's empty worktree was removed (B-072)");
      for (const item of await internals.listRetainedWorktreeArtifacts(repo)) await internals.cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true).catch(() => null);
    } finally {
      hooks.agentRuntimeTestHook = null;
      hooks.queueJobExecutorTestHook = previousExecutor;
    }
  });

  test("Claim 4 (verified): auto-integration re-runs validationCommand in the target before the commit (cross-batch) and removes the worktree after it", async () => {
    const { repo, git } = await makeRepo("cross-batch");
    // Fails when two batches have the same content: only visible once both are in one tree.
    await mkdir(path.join(repo, "tools"), { recursive: true });
    await writeFile(path.join(repo, "tools", "unique.cjs"), [
      "const fs = require('fs'); const path = require('path');",
      "const dir = path.join(process.cwd(), 'out'); const seen = new Map();",
      "if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) { const text = fs.readFileSync(path.join(dir, name), 'utf8'); if (seen.has(text)) { console.error('duplicate of ' + seen.get(text) + ': ' + name); process.exit(1); } seen.set(text, name); }",
      "",
    ].join("\n"), "utf8");
    await git(["add", "."]);
    await git(["-c", "user.name=Batch Owner", "-c", "user.email=owner@example.invalid", "commit", "-q", "-m", "checker"]);
    const VALIDATION = "node tools/unique.cjs";
    // Both builders started from the same HEAD, before either landed.
    const worktrees = {};
    for (const name of ["one", "two"]) {
      const dir = path.join(root, `cross-${name}-${Date.now()}`);
      await git(["worktree", "add", "-q", "-b", `agent/builder/cross-${name}-${Date.now()}`, dir, "HEAD"]);
      await mkdir(path.join(dir, "out"), { recursive: true });
      await writeFile(path.join(dir, "out", `batch-${name}.json`), "[\"same question\"]\n", "utf8");
      worktrees[`Write out/batch-${name}.json.`] = { dir, file: `out/batch-${name}.json` };
    }
    const previousExecutor = hooks.queueJobExecutorTestHook;
    hooks.queueJobExecutorTestHook = async (request) => ({
      response: { content: [{ type: "text", text: "REPORT: wrote the batch." }] },
      result: { errorType: "", changedFiles: [worktrees[request.task].file], configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" },
      validation: { status: "passed" },
      worktree: { path: worktrees[request.task].dir, branch: "", baseCommit: "", baseTree: "" },
    });
    try {
      const outcomes = [];
      for (const task of Object.keys(worktrees)) {
        const file = worktrees[task].file;
        const enqueued = await enqueueQueueJob({
          agent: "builder", task, cwd: repo, write: true, lockMode: "simple", lockedPaths: ["out"], allowedEdits: [file], validationCommand: VALIDATION, timeoutMs: 600000, autoIntegrate: true,
          scopeContract: { mode: "write", read: ["out"], write: [file], allowedEdits: [file], forbidden: [".env"], validationCommand: VALIDATION },
        });
        assert.equal(enqueued.ok, true, enqueued.error);
        assert.ok(await waitFor(async () => {
          const status = (await durableIn(repo, enqueued.record.jobId))?.autoIntegration?.status;
          return Boolean(status) && !["waiting_for_lock", "integrating"].includes(status);
        }, 60_000), `the integration of ${file} finished`);
        outcomes.push(await durableIn(repo, enqueued.record.jobId));
      }
      assert.equal(outcomes[0].autoIntegration.status, "committed", JSON.stringify(outcomes[0].autoIntegration));
      assert.equal(existsSync(worktrees["Write out/batch-one.json."].dir), false, "the landed batch's worktree was removed after the commit");
      assert.equal(outcomes[1].autoIntegration.status, "failed", "the second batch passed alone but failed in the target");
      assert.equal(outcomes[1].autoIntegration.stage, "apply");
      assert.equal((await git(["rev-parse", "HEAD"])).trim(), outcomes[0].autoIntegration.commit, "nothing was committed for the second batch");
      assert.equal(existsSync(path.join(repo, "out", "batch-two.json")), false, "rolled back");
      assert.equal(existsSync(worktrees["Write out/batch-two.json."].dir), true, "kept for review");
    } finally {
      hooks.queueJobExecutorTestHook = previousExecutor;
    }
  });

  // ---------------------------------------------------------------------------------------------
  // The worker in this process.

  test("B-075: the arguments and every --enqueue line are checked; a bad file starts and enqueues nothing", async () => {
    assert.throws(() => parseWorkerArguments(["--repo", "relative/path"]), /must be an absolute path/);
    assert.throws(() => parseWorkerArguments(["--repo", root, "--now"]), /--now goes with --stop/);
    assert.throws(() => parseWorkerArguments(["--repo", root, "--stop", "--enqueue", "x.jsonl"]), /start no worker/);
    assert.throws(() => parseWorkerArguments(["--repo", root, "--env-from", "zsh"]), /claude or codex/);
    assert.equal(queueWorkerApi.parseJobLine("{").ok, false);
    assert.match(queueWorkerApi.parseJobLine(JSON.stringify({ agent: "reviewer", task: "x", cwd: root })).error, /idempotencyKey/);
    assert.match(queueWorkerApi.parseJobLine(JSON.stringify({ idempotencyKey: "k", agent: "reviewer", task: "x", cwd: root, allowedEdit: ["a"] })).error, /allowedEdit/, "a misspelt option is refused, not dropped");
    assert.equal(queueWorkerApi.parseJobLine(JSON.stringify({ idempotencyKey: "k", agent: "reviewer", task: "x", cwd: root })).ok, true);

    const { repo } = await makeRepo("refusals");
    const { repo: other } = await makeRepo("refusals-other");
    const parseErrors = jobsFile("parse", [readJob(repo, "p-1"), "{not json", { ...readJob(repo, "p-3"), mystery: true }, readJob(repo, "p-1")]);
    const parsed = startWorker(["--repo", repo, "--enqueue", parseErrors]);
    assert.equal(await parsed.done, 1);
    assert.match(parsed.err.text, /line 2: not valid JSON/);
    assert.match(parsed.err.text, /line 3: \(object\): Unrecognized key.*mystery/);
    assert.match(parsed.err.text, /line 4: idempotencyKey "p-1" repeats line 1/);
    const checkErrors = jobsFile("check", [readJob(repo, "c-1"), readJob(other, "c-2"), readJob(repo, "c-3", { write: true, lockMode: "simple", agent: "builder" })]);
    const checked = startWorker(["--repo", repo, "--enqueue", checkErrors]);
    assert.equal(await checked.done, 1);
    assert.match(checked.err.text, /line 2: queue_worker_wrong_repository/);
    assert.match(checked.err.text, /line 3: /, "the lock plan of a write job without paths is refused");
    assert.doesNotMatch(checked.err.text, /line 1:/);
    assert.equal(rowsOf(repo).length, 0, "nothing was enqueued");
    assert.equal(existsSync(queueWorkerApi.files(repo).presence), false, "the presence file is gone after a refusal");
    const notGit = path.join(root, "not-a-repo");
    await mkdir(notGit, { recursive: true });
    const refusedRepo = startWorker(["--repo", notGit]);
    assert.equal(await refusedRepo.done, 1);
    assert.match(refusedRepo.err.text, /not inside a Git repository/);
  });

  test("B-075: --until-empty runs the file and exits 0; the same file again deduplicates; changed content under a key is refused", async () => {
    const { repo } = await makeRepo("until-empty");
    calls.length = 0;
    const file = jobsFile("until-empty", [readJob(repo, "ue-1"), readJob(repo, "ue-2")]);
    const run = startWorker(["--repo", repo, "--enqueue", file, "--until-empty"]);
    assert.equal(await withTimeout(run.done, 20_000, "the worker"), 0, run.err.text);
    assert.match(run.out.text, /2 job\(s\) enqueued, 0 already queued, 0 adopted/);
    assert.match(run.out.text, /Queue worker stopped \(queue_empty\): 0 pending, 0 running, 0 blocked, 2 completed/);
    assert.deepEqual(calls.sort(), ["Review for ue-1.", "Review for ue-2."]);
    assert.ok(rowsOf(repo).every((row) => row.status === "completed" && row.owner_instance_id === BRIDGE_INSTANCE_ID));
    const again = startWorker(["--repo", repo, "--enqueue", file, "--until-empty"]);
    assert.equal(await withTimeout(again.done, 20_000, "the second worker"), 0, again.err.text);
    assert.match(again.out.text, /0 job\(s\) enqueued, 2 already queued/);
    assert.equal(calls.length, 2, "nothing ran twice");
    const changed = jobsFile("changed", [readJob(repo, "ue-1", { task: "Something else." })]);
    const conflict = startWorker(["--repo", repo, "--enqueue", changed, "--until-empty"]);
    assert.equal(await conflict.done, 1);
    assert.match(conflict.err.text, /line 1: queue_idempotency_conflict/);
    // Reporting: started/stopped in the operations log (info) and the issue log; summaries too.
    const lines = readOpsLogLines(path.join(stateDir, "logs"));
    assert.ok(lines.some((line) => line.event === "queue_worker.started" && line.level === "info" && line.enqueued === 2));
    const stopped = lines.find((line) => line.event === "queue_worker.stopped" && line.stopReason === "queue_empty");
    assert.ok(stopped, "queue_worker.stopped is logged");
    assert.equal(stopped.completed, 2);
    assert.match(issues(), /\| queue_worker\.started \| - \| - \| Queue worker started for until-empty-\d+ \(pid \d+\): 2 job\(s\) enqueued/);
    assert.match(issues(), /\| queue_worker\.stopped \| - \| - \| Queue worker stopped \(queue_empty, exit 0\)/);
  });

  test("B-075/B-079: a stop request drains; the jobs left are parked: a client bridge does not adopt them until --release", async () => {
    const { repo } = await makeRepo("drain");
    calls.length = 0;
    behaviours = { "Review for drain-1.": "hold" };
    const run = startWorker(["--repo", repo, "--enqueue", jobsFile("drain", [readJob(repo, "drain-1"), readJob(repo, "drain-2"), readJob(repo, "drain-3")])]);
    try {
      assert.ok(await waitFor(() => calls.includes("Review for drain-1.")), "the first job runs");
      const files = queueWorkerApi.files(repo);
      const presence = queueWorkerApi.readFile(files.presence);
      assert.equal(presence.pid, process.pid);
      assert.equal(presence.instanceId, BRIDGE_INSTANCE_ID);
      assert.ok(await waitFor(() => (queueWorkerApi.readFile(files.presence)?.counts?.running || 0) === 1), "the presence file carries the counts");
      queueWorkerApi.writeStop(repo);
      await sleep(400);
      assert.equal(calls.length, 1, "nothing new starts after the stop request");
      assert.equal(await Promise.race([run.done.then(() => "exited"), sleep(100).then(() => "running")]), "running", "the worker waits for its running job");
      released.add("Review for drain-1.");
      assert.equal(await withTimeout(run.done, 10_000, "the drained worker"), 0, run.err.text);
      assert.match(run.out.text, /Queue worker stopped \(stop_requested\): 2 pending, 0 running, 0 blocked, 1 completed/);
      assert.equal(existsSync(files.presence), false);
      assert.equal(existsSync(files.stop), false);
      const rows = rowsOf(repo);
      assert.deepEqual(rows.map((row) => row.status).sort(), ["completed", "pending", "pending"]);
      assert.equal(calls.length, 1, "the pending jobs did not start after the exit either");
      assert.match(run.out.text, /The 2 job\(s\) left are parked: the next worker for this repository runs them; client bridges do not adopt them until you run: .* --release/);
      const parked = queueWorkerApi.readFile(files.parked);
      assert.equal(parked?.stopReason, "stop_requested");
      assert.equal(parked.counts.pending, 2);
      // A client bridge after the leases lapsed: it leaves the parked queue alone.
      for (const row of rows.filter((item) => item.status === "pending")) orphanRow(repo, row.job_id);
      await internals.reconcileQueueStateAtStartup();
      await internals.reconcileQueueStateAtStartup();
      assert.deepEqual(rowsOf(repo).map((row) => row.status).sort(), ["completed", "pending", "pending"], "not adopted while parked");
      assert.ok(rowsOf(repo).filter((row) => row.status === "pending").every((row) => row.owner_instance_id === "dead-owner-1"));
      const present = readOpsLogLines(path.join(stateDir, "logs")).filter((line) => line.event === "queue.worker_present" && line.projectKey === files.projectKey);
      assert.equal(present.length, 1, "one info line");
      assert.equal(present[0].parked, true);
      assert.match(present[0].summary, /parked this repository's queue/);
      const status = await runCli(["--repo", repo, "--status"]);
      assert.match(status.stdout, /Parked: yes, since .*client bridges do not adopt this queue; the next worker takes it, or run --release/);
      const releasedRun = startWorker(["--repo", repo, "--release"]);
      assert.equal(await releasedRun.done, 0, releasedRun.err.text);
      assert.match(releasedRun.out.text, /Released the parked queue/);
      assert.equal(existsSync(files.parked), false);
      const again = startWorker(["--repo", repo, "--release"]);
      assert.equal(await again.done, 0);
      assert.match(again.out.text, /Nothing is parked/);
      await internals.reconcileQueueStateAtStartup();
      assert.ok(await waitFor(() => rowsOf(repo).every((row) => row.status === "completed"), 10_000), "adopted and run after --release");
    } finally {
      behaviours = {};
      released.add("Review for drain-1.");
    }
  });

  test("B-075: --stop --now cancels the running job (requeue-able), then the worker exits 0", async () => {
    const { repo } = await makeRepo("stop-now");
    calls.length = 0;
    behaviours = { "Review for now-1.": "hold" };
    const nowFile = jobsFile("now", [readJob(repo, "now-1")]);
    const run = startWorker(["--repo", repo, "--enqueue", nowFile]);
    try {
      assert.ok(await waitFor(() => calls.includes("Review for now-1.")));
      queueWorkerApi.writeStop(repo, { now: true });
      assert.equal(await withTimeout(run.done, 10_000, "the stopped worker"), 0, run.err.text);
      assert.match(run.out.text, /Stop now: cancelled 1 running job\(s\)/);
      const [row] = rowsOf(repo);
      assert.equal(row.status, "cancelled");
      assert.equal(existsSync(queueWorkerApi.files(repo).parked), false, "nothing left behind, nothing parked");
      behaviours = {};
      // B-088: running the file again deduplicates into the cancelled job; the worker says so.
      const rerun = startWorker(["--repo", repo, "--enqueue", nowFile, "--until-empty"]);
      assert.equal(await withTimeout(rerun.done, 20_000, "the re-run"), 0, rerun.err.text);
      assert.match(rerun.out.text, new RegExp(`line 1: now-1 is already queued as ${row.job_id} \\(cancelled\\)`));
      assert.match(rerun.err.text, /Warning: 1 line\(s\) of .* match jobs that ended cancelled and will not run again: line 1 now-1 .*Requeue them \(requeue_opencode_job\) or give those lines new idempotency keys/);
      const startedLine = readOpsLogLines(path.join(stateDir, "logs")).filter((line) => line.event === "queue_worker.started").pop();
      assert.equal(startedLine.level, "warn");
      assert.equal(startedLine.deduplicatedEnded, 1);
      assert.deepEqual(startedLine.deduplicatedEndedKeys, ["now-1=cancelled"]);
      const requeued = await callTool("requeue_opencode_job", { cwd: repo, jobId: row.job_id });
      assert.notEqual(requeued.isError, true, textOf(requeued));
      assert.match(textOf(requeued), /requeued/i);
    } finally {
      behaviours = {};
    }
  });

  test("B-075: the worker recovers only its own repository's database", async () => {
    const { repo: mine } = await makeRepo("filter-mine");
    const { repo: theirs } = await makeRepo("filter-theirs");
    calls.length = 0;
    const a = await enqueueQueueJob(readJob(mine, "filter-a"), "", { schedule: false });
    const b = await enqueueQueueJob(readJob(theirs, "filter-b"), "", { schedule: false });
    assert.equal(a.ok && b.ok, true);
    orphanRow(mine, a.record.jobId);
    orphanRow(theirs, b.record.jobId);
    const run = startWorker(["--repo", mine, "--until-empty"]);
    assert.equal(await withTimeout(run.done, 20_000, "the worker"), 0, run.err.text);
    assert.match(run.out.text, /0 job\(s\) enqueued, 0 already queued, 1 adopted/);
    assert.deepEqual(calls, ["Review for filter-a."]);
    const [theirsRow] = rowsOf(theirs);
    assert.equal(theirsRow.status, "pending");
    assert.equal(theirsRow.owner_instance_id, "dead-owner-1", "the other repository's job was not touched");
    await callTool("cancel_opencode_job", { cwd: theirs, jobId: b.record.jobId });
  });

  test("B-077: a client bridge does not adopt the pending jobs of a repository whose worker is alive, and logs it once", async () => {
    const { repo } = await makeRepo("client-skip");
    calls.length = 0;
    const job = await enqueueQueueJob(readJob(repo, "skip-1"), "", { schedule: false });
    orphanRow(repo, job.record.jobId);
    const files = queueWorkerApi.files(repo);
    await mkdir(files.directory, { recursive: true });
    const presence = { version: 1, pid: process.pid, instanceId: "another-worker-instance", projectKey: files.projectKey, repo, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
    writeFileSync(files.presence, JSON.stringify(presence), "utf8");
    try {
      await internals.reconcileQueueStateAtStartup();
      await internals.reconcileQueueStateAtStartup();
      assert.equal(QUEUE_JOBS.has(job.record.jobId), false, "not adopted while the worker is fresh");
      assert.equal(rowsOf(repo)[0].owner_instance_id, "dead-owner-1");
      const present = readOpsLogLines(path.join(stateDir, "logs")).filter((line) => line.event === "queue.worker_present" && line.projectKey === files.projectKey);
      assert.equal(present.length, 1, "one info line per episode");
      assert.equal(present[0].level, "info");
      // A heartbeat older than 2 minutes: the worker is gone, the job is adopted as before.
      writeFileSync(files.presence, JSON.stringify({ ...presence, heartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString() }), "utf8");
      await internals.reconcileQueueStateAtStartup();
      assert.ok(await waitFor(async () => (await durableIn(repo, job.record.jobId))?.status === "completed"), "adopted and run once the presence is stale");
      assert.equal(rowsOf(repo)[0].owner_instance_id, BRIDGE_INSTANCE_ID);
    } finally {
      rmSync(files.presence, { force: true });
    }
  });

  test("B-075: --env-from copies the client entry's env, and the explicit environment wins", async () => {
    const target = {};
    const result = applyClientEnvironment(target, { A: "1", B: "2" });
    assert.deepEqual(result.applied, ["A", "B"]);
    const kept = { A: "shell" };
    assert.deepEqual(applyClientEnvironment(kept, { A: "1", B: "2" }), { applied: ["B"], kept: ["A"] });
    assert.equal(kept.A, "shell");
    const { repo } = await makeRepo("env-from");
    const claudeDir = path.join(root, "claude-config");
    await mkdir(claudeDir, { recursive: true });
    const entryState = path.join(root, "entry-state");
    const claudeConfig = path.join(claudeDir, ".claude.json");
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { opencode: { type: "stdio", command: "node", args: [path.join(root, "elsewhere", "server.js")], env: { CODEX_OPENCODE_STATE_DIR: entryState, CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS: "1500" } } } }), "utf8");
    const fromEntry = await runCli(["--repo", repo, "--status", "--json", "--env-from", "claude", "--claude-config", claudeConfig], { CODEX_OPENCODE_STATE_DIR: undefined });
    assert.equal(fromEntry.code, 0, fromEntry.stderr);
    assert.equal(path.resolve(JSON.parse(fromEntry.stdout).stateDirectory), path.resolve(entryState), "the entry's state directory");
    assert.match(fromEntry.stderr, /Environment from the claude entry in .*: 2 variable\(s\) copied/);
    assert.match(fromEntry.stderr, /Note: the claude entry runs .*elsewhere.*server\.js/);
    const explicit = await runCli(["--repo", repo, "--status", "--json", "--env-from", "claude", "--claude-config", claudeConfig]);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(path.resolve(JSON.parse(explicit.stdout).stateDirectory), path.resolve(stateDir), "the shell's value wins");
    assert.match(explicit.stderr, /kept from this shell \(CODEX_OPENCODE_STATE_DIR\)/);
    const codexHome = path.join(root, "codex-env-home");
    await mkdir(codexHome, { recursive: true });
    const codexState = path.join(root, "codex-entry-state");
    writeFileSync(path.join(codexHome, "config.toml"), [
      "[mcp_servers.opencode]",
      "command = \"node\"",
      `args = [${JSON.stringify(path.join(root, "x", "server.js"))}]`,
      "[mcp_servers.opencode.env]",
      `CODEX_OPENCODE_STATE_DIR = ${JSON.stringify(codexState)}`,
      "",
    ].join("\n"), "utf8");
    const fromCodex = await runCli(["--repo", repo, "--status", "--json", "--env-from", "codex"], { CODEX_OPENCODE_STATE_DIR: undefined, CODEX_HOME: codexHome });
    assert.equal(fromCodex.code, 0, fromCodex.stderr);
    assert.equal(path.resolve(JSON.parse(fromCodex.stdout).stateDirectory), path.resolve(codexState));
    assert.equal(existsSync(path.join(entryState, "workers")), false, "--status starts nothing");
  });

  // ---------------------------------------------------------------------------------------------
  // Two processes.

  test("B-076: a second worker on the same repository is refused while the first runs; --status and --stop reach it", async () => {
    const { repo } = await makeRepo("second");
    const first = spawnWorkerChild({ name: "second-a", args: ["--repo", repo, "--enqueue", jobsFile("second", [readJob(repo, "second-1")])], behaviour: { "Review for second-1.": "hold" } });
    try {
      assert.ok(await waitFor(() => first.childCalls().length === 1, 30_000), `the first worker runs its job: ${first.output.stderr}`);
      const second = await runCli(["--repo", repo, "--until-empty"]);
      assert.equal(second.code, 1, second.stdout);
      assert.match(second.stderr, new RegExp(`Refused to start: A queue worker already runs for this repository: pid ${first.child.pid} \\(alive\\)`));
      const status = await runCli(["--repo", repo, "--status", "--json"]);
      assert.equal(status.code, 0, status.stderr);
      const parsed = JSON.parse(status.stdout);
      assert.equal(parsed.worker.state, "running");
      assert.equal(parsed.worker.pid, first.child.pid);
      assert.ok(await waitFor(async () => JSON.parse((await runCli(["--repo", repo, "--status", "--json"])).stdout).counts.running === 1, 10_000));
      const text = await runCli(["--repo", repo, "--status"]);
      assert.match(text.stdout, /Worker: running, pid \d+ \(alive\)/);
      assert.match(text.stdout, /Jobs: 0 pending, 1 running/);
      const stop = await runCli(["--repo", repo, "--stop"]);
      assert.equal(stop.code, 0, stop.stderr);
      assert.match(stop.stdout, /Stop requested for the queue worker pid/);
      await sleep(500);
      assert.equal(first.child.exitCode, null, "it waits for its running job");
      first.release();
      assert.equal(await withTimeout(first.exited, 20_000, "the first worker"), 0, first.output.stderr);
      assert.match(first.output.stdout, /Queue worker stopped \(stop_requested\)/);
      const none = await runCli(["--repo", repo, "--stop"]);
      assert.equal(none.code, 1);
      assert.match(none.stderr, /No queue worker is running/);
    } finally {
      first.release();
      if (first.child.exitCode === null) first.child.kill();
    }
  });

  test("B-076: after a crash the presence file blocks a restart until its heartbeat is stale; the next worker then adopts the lapsed pending job", async () => {
    const { repo } = await makeRepo("handoff");
    const leases = { CODEX_OPENCODE_QUEUE_LEASE_MS: "1500", CODEX_OPENCODE_QUEUE_HEARTBEAT_MS: "300" };
    const first = spawnWorkerChild({ name: "handoff-a", env: leases, args: ["--repo", repo, "--enqueue", jobsFile("handoff", [readJob(repo, "handoff-1"), readJob(repo, "handoff-2")])], behaviour: { "Review for handoff-1.": "hold", "Review for handoff-2.": "hold" } });
    assert.ok(await waitFor(() => first.childCalls().length === 1, 30_000), `the first worker runs one job: ${first.output.stderr}`);
    first.child.kill("SIGKILL");
    await withTimeout(first.exited, 10_000, "the killed worker");
    const files = queueWorkerApi.files(repo);
    const leftover = queueWorkerApi.readFile(files.presence);
    assert.equal(leftover?.pid, first.child.pid, "a killed process leaves its presence file");
    const tooEarly = await runCli(["--repo", repo, "--until-empty"]);
    assert.equal(tooEarly.code, 1, "a dead pid with a fresh heartbeat is still refused");
    assert.match(tooEarly.stderr, /\(not alive\)/);
    writeFileSync(files.presence, JSON.stringify({ ...leftover, heartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString() }), "utf8");
    await sleep(1800);
    const second = spawnWorkerChild({ name: "handoff-b", env: leases, args: ["--repo", repo, "--until-empty"] });
    try {
      assert.equal(await withTimeout(second.exited, 30_000, "the second worker"), 0, `${second.output.stdout}\n${second.output.stderr}`);
      assert.match(second.output.stdout, /1 adopted/);
      assert.deepEqual(second.childCalls().map((call) => call.task), ["Review for handoff-2."], "only the pending job ran again");
      const rows = rowsOf(repo);
      const byKey = Object.fromEntries(rows.map((row) => [row.idempotency_key, row]));
      assert.equal(byKey["handoff-1"].status, "interrupted", "the crashed worker's running job is interrupted (requeue-able)");
      assert.equal(byKey["handoff-2"].status, "completed");
      assert.notEqual(byKey["handoff-2"].owner_instance_id, leftover.instanceId, "run by the new worker");
      assert.equal(existsSync(files.presence), false, "the new worker removed its presence file at its exit");
    } finally {
      if (second.child.exitCode === null) second.child.kill();
    }
  });

  test("B-081/B-082/B-083/B-087: presence rules: rename takeover, 10-minute rule for a live pid, a future heartbeat, the stop file of another owner", async () => {
    const { repo } = await makeRepo("presence-rules");
    const files = queueWorkerApi.files(repo);
    await mkdir(files.directory, { recursive: true });
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    // B-087: within the skew a future heartbeat is fresh, beyond it not.
    assert.equal(queueWorkerApi.presenceFresh({ heartbeatAt: at(30_000) }, now), true);
    assert.equal(queueWorkerApi.presenceFresh({ heartbeatAt: at(5 * 60_000) }, now), false);
    assert.equal(queueWorkerApi.presenceFresh({ heartbeatAt: at(-60_000) }, now), true);
    assert.equal(queueWorkerApi.presenceFresh({ heartbeatAt: at(-3 * 60_000) }, now), false);
    // B-082: a live pid keeps a 5-minute-old heartbeat live, not an 11-minute-old one.
    const other = { version: 1, pid: process.pid, instanceId: "some-other-worker", projectKey: files.projectKey, repo };
    writeFileSync(files.presence, JSON.stringify({ ...other, heartbeatAt: at(-5 * 60_000) }), "utf8");
    const refused = queueWorkerApi.claimPresence(repo);
    assert.equal(refused.ok, false);
    assert.equal(refused.errorType, "queue_worker_already_running");
    assert.match(refused.error, /\(alive\)/);
    // B-083: the stop file belongs to that worker: releasing a presence that is not ours keeps it.
    queueWorkerApi.writeStop(repo);
    assert.equal(queueWorkerApi.releasePresence(files).released, false);
    assert.equal(existsSync(files.stop), true, "another worker's stop request is kept");
    assert.equal(existsSync(files.presence), true);
    rmSync(files.stop, { force: true });
    writeFileSync(files.presence, JSON.stringify({ ...other, heartbeatAt: at(-11 * 60_000) }), "utf8");
    const taken = queueWorkerApi.claimPresence(repo);
    assert.equal(taken.ok, true, taken.error);
    assert.equal(taken.takenOver.instanceId, "some-other-worker", "an 11-minute-old heartbeat is stale even with a live (possibly reused) pid");
    assert.equal(queueWorkerApi.readFile(files.presence).instanceId, BRIDGE_INSTANCE_ID);
    // B-081: taken over by a rename and a content check: no aside copy is left.
    assert.deepEqual(readdirSync(files.directory).filter((name) => name.includes(".stale-")), []);
    queueWorkerApi.writeStop(repo);
    assert.equal(queueWorkerApi.releasePresence(files).released, true);
    assert.equal(existsSync(files.presence), false);
    assert.equal(existsSync(files.stop), false, "its own stop file goes with it");
  });

  test("B-081: a worker that loses its presence file before its first refresh refuses to start (exit 1) and logs queue_worker.refused", async () => {
    const { repo } = await makeRepo("first-refresh");
    calls.length = 0;
    let refreshes = 0;
    const api = Object.create(queueWorkerApi, {
      refreshPresence: { value: (files, fields) => (++refreshes === 1 ? { ok: false, owner: { pid: 4242 } } : queueWorkerApi.refreshPresence(files, fields)) },
    });
    const run = startWorker(["--repo", repo, "--enqueue", jobsFile("first-refresh", [readJob(repo, "fr-1")])], { api });
    assert.equal(await withTimeout(run.done, 20_000, "the worker"), 1);
    assert.match(run.err.text, /Refused to start: the presence file .* now belongs to another worker \(pid 4242\)/);
    assert.equal(calls.length, 0, "nothing ran");
    assert.equal(rowsOf(repo).length, 0, "nothing was enqueued");
    const refusedLine = readOpsLogLines(path.join(stateDir, "logs")).filter((line) => line.event === "queue_worker.refused").pop();
    assert.equal(refusedLine?.level, "warn");
    assert.equal(refusedLine.errorType, "queue_worker_presence_race");
  });

  test("B-085: an exception while enqueueing cancels what the file already added; nothing starts", async () => {
    const { repo } = await makeRepo("enqueue-throw");
    calls.length = 0;
    let enqueues = 0;
    const api = Object.create(queueWorkerApi, {
      enqueueFromToolInput: { value: async (job) => { if (++enqueues === 2) throw new Error("disk full"); return queueWorkerApi.enqueueFromToolInput(job); } },
    });
    const run = startWorker(["--repo", repo, "--enqueue", jobsFile("enqueue-throw", [readJob(repo, "et-1"), readJob(repo, "et-2")])], { api });
    assert.equal(await withTimeout(run.done, 20_000, "the worker"), 1);
    assert.match(run.err.text, /the 1 job\(s\) this file had added are cancelled/);
    assert.match(run.err.text, /line 2: enqueue_failed: disk full/);
    await sleep(200);
    assert.equal(calls.length, 0);
    assert.deepEqual(rowsOf(repo).map((row) => row.status), ["cancelled"]);
  });

  test("B-080: a resume from another process releases the worker's job waiting for paused models within a tick", async () => {
    const { repo } = await makeRepo("resume");
    const MUSE = "opencode/muse-spark-1.3-contributor-free@high";
    const GEMINI = "google/antigravity-gemini-3.8-flash@high";
    assert.equal((await internals.pauseProvider({ provider: "opencode/muse-spark-1.3-contributor-free", minutes: 30 })).ok, true);
    assert.equal((await internals.pauseProvider({ provider: "google", minutes: 20 })).ok, true);
    const worker = spawnWorkerChild({
      name: "resume",
      env: { CODEX_OPENCODE_MODEL_ALLOWLIST: `${MUSE},${GEMINI}` },
      args: ["--repo", repo, "--until-empty", "--enqueue", jobsFile("resume", [readJob(repo, "resume-1", { models: [MUSE, GEMINI], maxAttempts: 1 })])],
    });
    try {
      assert.ok(await waitFor(() => rowsOf(repo).some((row) => row.status === "pending" && row.record.startAfter && row.record.startAfterReason === "provider_pause"), 30_000), `the job waits for the pauses: ${worker.output.stderr}`);
      await sleep(500);
      assert.equal(worker.childCalls().length, 0, "nothing runs while every model is paused");
      // This process is another bridge instance: its resume clears no wait of the worker directly.
      assert.equal((await internals.resumeProvider({ provider: "opencode" })).ok, true);
      assert.equal((await internals.resumeProvider({ provider: "google" })).ok, true);
      const resumedAt = Date.now();
      assert.ok(await waitFor(() => worker.childCalls().length === 1, 15_000), "the worker starts the job after the resume");
      assert.ok(Date.now() - resumedAt < 10_000, `within a scheduler poll, not at the pause end: ${Date.now() - resumedAt} ms`);
      assert.equal(await withTimeout(worker.exited, 30_000, "the worker"), 0, worker.output.stderr);
    } finally {
      await internals.resumeProvider({ provider: "opencode" });
      await internals.resumeProvider({ provider: "google" });
      if (worker.child.exitCode === null) worker.child.kill();
    }
  });

  test("B-086: a refused --enqueue after the start logs one queue_worker.refused warn, not process.exited", async () => {
    const { repo } = await makeRepo("refused-log");
    const { repo: other } = await makeRepo("refused-log-other");
    const result = await runCli(["--repo", repo, "--enqueue", jobsFile("refused-log", [readJob(other, "rl-1")])]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /line 1: queue_worker_wrong_repository/);
    const lines = readOpsLogLines(path.join(stateDir, "logs"));
    const refused = lines.filter((line) => line.event === "queue_worker.refused" && /line 1: queue_worker_wrong_repository/.test(line.summary || ""));
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, "warn");
    assert.equal(lines.some((line) => line.event === "process.exited" && line.pid === refused[0].pid), false, "no process.exited error for a refusal");
  });

  test("B-091: --status opens the repository and provider databases read-only and changes no file", async () => {
    const { repo } = await makeRepo("status-readonly");
    const run = startWorker(["--repo", repo, "--enqueue", jobsFile("status-readonly", [readJob(repo, "sr-1")]), "--until-empty"]);
    assert.equal(await withTimeout(run.done, 20_000, "the worker"), 0, run.err.text);
    const dbPath = internals.stateDbPath(repo);
    const providerDb = path.join(stateDir, "provider-concurrency.sqlite");
    assert.equal(existsSync(dbPath) && existsSync(providerDb), true);
    const listing = () => [...readdirSync(stateDir), ...readdirSync(path.join(stateDir, "projects")), ...(existsSync(path.join(stateDir, "workers")) ? readdirSync(path.join(stateDir, "workers")) : [])].sort();
    const before = { files: fileStates([dbPath, providerDb]), listing: listing() };
    await sleep(50);
    const status = await runCli(["--repo", repo, "--status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).counts.completed, 1, "it still reads the counts");
    assert.deepEqual({ files: fileStates([dbPath, providerDb]), listing: listing() }, before, "no file was created, written or migrated");
    // With a writer holding the database open (a -wal and -shm exist), it reads through them.
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("PRAGMA busy_timeout = 5000;");
      writer.prepare("SELECT COUNT(*) AS count FROM opencode_jobs").get();
      const live = fileStates([dbPath]);
      const second = await runCli(["--repo", repo, "--status", "--json"]);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).counts.completed, 1);
      assert.deepEqual(fileStates([dbPath]), live);
    } finally {
      writer.close();
    }
    // A repository with no database: zeros, and none is created.
    const { repo: empty } = await makeRepo("status-empty");
    const third = await runCli(["--repo", empty, "--status", "--json"]);
    assert.equal(third.code, 0, third.stderr);
    assert.equal(JSON.parse(third.stdout).counts.open, 0);
    assert.equal(existsSync(internals.stateDbPath(empty)), false);
  });

  test("Item 9: the global worker cap counts the worker's running jobs like a bridge's", async () => {
    const { repo } = await makeRepo("global-cap");
    const worker = spawnWorkerChild({ name: "cap", args: ["--repo", repo, "--until-empty", "--enqueue", jobsFile("cap", [readJob(repo, "cap-1")])], behaviour: { "Review for cap-1.": "lease" } });
    try {
      assert.ok(await waitFor(() => existsSync(worker.config.leaseFile), 30_000), `the worker's job holds a provider slot: ${worker.output.stderr}`);
      const set = await internals.setRuntimeConcurrency({ globalWorkerLimit: 1 });
      assert.equal(set.ok, true, set.error);
      const blocked = await internals.acquireProviderLease({ providerKey: "worker-cap-other-provider", timeoutMs: 1200 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.errorType, "provider_slot_wait_timeout");
      assert.match(blocked.error, /the global worker cap was full \(1 of 1 workers running on all providers/);
      worker.release();
      assert.equal(await withTimeout(worker.exited, 30_000, "the worker"), 0, worker.output.stderr);
      const free = await internals.acquireProviderLease({ providerKey: "worker-cap-other-provider", timeoutMs: 5000 });
      assert.equal(free.ok, true, free.error);
      await internals.releaseProviderLease(free.lease);
    } finally {
      worker.release();
      await internals.setRuntimeConcurrency({ reset: true });
      if (worker.child.exitCode === null) worker.child.kill();
    }
  });

  await runFlexTests({
    isolatedStateDir,
    file: "tests/review-flex-queue-worker.js",
    tests,
    cleanup: async () => { await fixture.cleanup(); },
    finishSkips,
    label: "queue worker",
  });
}
