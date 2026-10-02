#!/usr/bin/env node

// Q-006 (log.md, 2026-10-02): the automatic issue log. Every job failure (rate limit, idle kill,
// timeout, invalid output, no output, a job that gave up) becomes one markdown line in
// CODEX_OPENCODE_ISSUE_LOG (default <state-dir>/logs/issues.md, "off" disables), derived from the
// same record the operations log (bin/ops-log.js, B-047) just wrote; `node bin/ops-log.js --issues`
// rebuilds the lines from the JSONL file. Queue jobs run through the real scheduler with the
// executor replaced by a test hook; everything is in a scratch directory.
//   node tests/review-flex-issue-log.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_OPS_LOG;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-issue-log");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const opsLog = await import("../bin/ops-log.js");
const { hooks, internals } = __selfTest;
const { assert, enqueueQueueJob, logEvent, mkdir, path, runCommand } = internals;
const { existsSync, readFileSync, symlinkSync, writeFileSync } = await import("node:fs");

const fixture = await makeFlexFixture(__selfTest, "review-flex-issue-log");
const { stateDir, waitFor, durable, execution, readJob, writeJob } = fixture;
const issuesFile = path.join(stateDir, "logs", "issues.md");
const readIssues = (file = issuesFile) => (existsSync(file) ? readFileSync(file, "utf8") : "");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-006: one markdown line per failure record, and none for other events", () => {
  const line = opsLog.issueMarkdownLine({ ts: "2026-10-02T08:12:30.000Z", level: "warn", event: "queue.job_failed", jobId: "builder-1-ab", agent: "builder", model: "opencode/muse-spark-1.3-contributor-free", errorType: "agent_idle_timeout", summary: "stopped as idle\nafter | 10 min" });
  assert.equal(line, "- 2026-10-02 08:12 UTC | queue.job_failed | agent_idle_timeout | job builder-1-ab builder on opencode/muse-spark-1.3-contributor-free | stopped as idle after 10 min\n");
  assert.equal(opsLog.issueMarkdownLine({ ts: "2026-10-02T08:12:30.000Z", event: "queue.memory_hold_started" }), "", "not a failure");
  assert.equal(opsLog.issueMarkdownLine({ ts: "2026-10-02T08:12:30.000Z", event: "agent.run_failed", tool: "run_opencode_agent", errorType: "agent_timeout" }), "- 2026-10-02 08:12 UTC | agent.run_failed | agent_timeout | tool run_opencode_agent | -\n");
  assert.equal(opsLog.issueLogPath("/state", {}), path.join("/state", "logs", "issues.md"));
  assert.equal(opsLog.issueLogPath("/state", { CODEX_OPENCODE_ISSUE_LOG: "off" }), "");
  assert.equal(opsLog.issueLogPath("/state", { CODEX_OPENCODE_ISSUE_LOG: "relative.md" }), "", "a relative path is never written");
});

test("Q-006: a failed queued job and a writer that changed nothing land in the issue log", async () => {
  hooks.queueJobExecutorTestHook = async (request) => request.write
    ? execution({ noChanges: true, configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" })
    : execution({ errorType: "agent_idle_timeout", configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free" });
  try {
    const failed = await enqueueQueueJob(readJob({ task: "Review for the issue log." }));
    assert.equal(failed.ok, true, failed.error);
    const noOutput = await enqueueQueueJob(writeJob("src/a.txt", { task: "Write for the issue log." }));
    assert.equal(noOutput.ok, true, noOutput.error);
    assert.ok(await waitFor(async () => (await durable(failed.record.jobId))?.status === "failed"));
    assert.ok(await waitFor(async () => (await durable(noOutput.record.jobId))?.status === "completed"));
    assert.ok(await waitFor(() => readIssues().includes(noOutput.record.jobId) && readIssues().includes(failed.record.jobId)), readIssues());
    const lines = readIssues().trim().split("\n");
    const failedLine = lines.find((item) => item.includes(failed.record.jobId));
    assert.match(failedLine, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \| queue\.job_failed \| agent_idle_timeout \| job reviewer-\S+ reviewer on opencode\/muse-spark-1\.3-contributor-free \| agent_idle_timeout$/);
    const noOutputLine = lines.find((item) => item.includes(noOutput.record.jobId));
    assert.match(noOutputLine, /\| queue\.job_no_output \| completed_no_changes \| job builder-\S+ builder on opencode\/muse-spark-1\.3-contributor-free \| The writer completed without changing any file/);
  } finally {
    hooks.queueJobExecutorTestHook = null;
  }
});

test("Q-006: the lines are derived from the JSONL records, and --issues rebuilds them", async () => {
  logEvent("warn", "provider.rate_limit_detected", { jobId: "builder-9-cd", agent: "builder", model: "opencode/muse-spark-1.3-contributor-free", errorType: "provider_rate_limited", summary: "rate limit: 2 line(s)" });
  const { fileURLToPath } = await import("node:url");
  const opsLogScript = fileURLToPath(new URL("../bin/ops-log.js", import.meta.url));
  const rebuilt = await runCommand(process.execPath, [opsLogScript, "--issues", "--state-dir", stateDir], process.cwd(), 30_000, { ...process.env, CODEX_OPENCODE_OPS_LOG: "off" });
  assert.equal(rebuilt.exitCode, 0, rebuilt.stderr);
  assert.equal(rebuilt.stdout, readIssues(), "the issue log holds exactly the lines the JSONL records give");
  assert.match(rebuilt.stdout, /\| provider\.rate_limit_detected \| provider_rate_limited \| job builder-9-cd builder on opencode\/muse-spark-1\.3-contributor-free \| rate limit: 2 line\(s\)/);
  // A warning that is not a failure stays in the JSONL file only.
  logEvent("warn", "queue.memory_hold_started", { freeMb: 10, floorMb: 1024 });
  assert.doesNotMatch(readIssues(), /memory_hold_started/);
  const jsonl = readFileSync(path.join(stateDir, "logs", `bridge-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  assert.match(jsonl, /queue\.memory_hold_started/);
});

test("Q-006: a configured file is used, off writes none, and a link or missing folder is never written through", async () => {
  const custom = path.join(fixture.root, "custom-issues.md");
  process.env.CODEX_OPENCODE_ISSUE_LOG = custom;
  try {
    logEvent("warn", "queue.job_failed", { jobId: "custom-1", errorType: "agent_timeout", summary: "custom file" });
    assert.match(readIssues(custom), /custom-1/);
    process.env.CODEX_OPENCODE_ISSUE_LOG = path.join(fixture.root, "missing-folder", "issues.md");
    logEvent("warn", "queue.job_failed", { jobId: "custom-2", errorType: "agent_timeout", summary: "missing folder" });
    assert.equal(existsSync(path.join(fixture.root, "missing-folder")), false, "no folder is created outside the state dir");
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside, { recursive: true });
    const linkedFolder = path.join(fixture.root, "linked");
    symlinkSync(outside, linkedFolder, "junction");
    process.env.CODEX_OPENCODE_ISSUE_LOG = path.join(linkedFolder, "issues.md");
    logEvent("warn", "queue.job_failed", { jobId: "custom-3", errorType: "agent_timeout", summary: "through a junction" });
    assert.equal(existsSync(path.join(outside, "issues.md")), false, "nothing is written through a junction");
    process.env.CODEX_OPENCODE_ISSUE_LOG = "off";
    const before = readIssues();
    logEvent("warn", "queue.job_failed", { jobId: "custom-4", errorType: "agent_timeout", summary: "off" });
    assert.equal(readIssues(), before);
    assert.doesNotMatch(readIssues(custom), /custom-4/);
  } finally {
    delete process.env.CODEX_OPENCODE_ISSUE_LOG;
  }
  // With the operations log off there is no source record, so no issue line either.
  process.env.CODEX_OPENCODE_OPS_LOG = "off";
  try {
    logEvent("warn", "queue.job_failed", { jobId: "ops-off-1", errorType: "agent_timeout", summary: "ops log off" });
    assert.doesNotMatch(readIssues(), /ops-off-1/);
  } finally {
    delete process.env.CODEX_OPENCODE_OPS_LOG;
  }
  writeFileSync(path.join(fixture.root, "touch"), "x");
});

await runFlexTests({ isolatedStateDir, file: "tests/review-flex-issue-log.js", tests, cleanup: fixture.cleanup, finishSkips, label: "issue log" });
