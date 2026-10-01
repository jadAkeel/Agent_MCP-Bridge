#!/usr/bin/env node

// Regression tests for B-042..B-046 (log.md, 2026-10-01), found while running 10-20 parallel
// builder jobs: a queue limit that silently capped the provider limit, a 504 "Upstream idle
// timeout" reported as an unclassified API error, a timed-out writer that hid its changed files,
// no free-memory floor for the queue, and no idle detection for a stalled agent.
//   node tests/review-round5.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS;
delete process.env.CODEX_OPENCODE_MIN_FREE_MEMORY_MB;
// The memory hold polls at this interval; the default (2 s) would only slow the tests.
process.env.CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS = "200";
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { strict: assert } = await import("node:assert");
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const { builderFallbackEligible } = await import("../bin/builder-model-fallback.js");
const internals = __selfTest.internals;
const hooks = __selfTest.hooks;

const scratch = await mkdtemp(path.join(tmpdir(), "review-round5-"));
hooks.stateDirectoryOverride = scratch;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A scratch Git repository for the tools that need a project root.
async function makeRepo(label) {
  const root = await mkdtemp(path.join(tmpdir(), `review-round5-${label}-`));
  scratchRoots.push(root);
  const git = async (...args) => {
    const result = await internals.runCommand("git", args, root, 1000 * 120);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  await git("init", "-q");
  await git("config", "user.email", "round5-self-test@example.invalid");
  await git("config", "user.name", "round5-self-test");
  await git("config", "core.autocrlf", "false");
  await internals.writeFile(path.join(root, "README.md"), "seed\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
  return root;
}
const scratchRoots = [scratch];
const callTool = async (name, args) => (await internals.server._registeredTools[name].handler(args, {})).content[0].text;

// B-042 ------------------------------------------------------------------------------------

test("B-042: the queue capacity report warns when the provider limit exceeds the queue limit", () => {
  const capped = internals.queueCapacityReport({ queueParallelLimit: 6, parallelCallLimit: 6, providerConcurrencyLimit: 10, queueMode: "sqlite" });
  assert.match(capped.warning, /only 6 queued jobs will run at once/);
  assert.match(capped.warning, /CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT/);
  assert.match(capped.warning, /CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT/);
  const roomy = internals.queueCapacityReport({ queueParallelLimit: 10, parallelCallLimit: 6, providerConcurrencyLimit: 10, queueMode: "sqlite" });
  assert.equal(roomy.warning, "");
  const equalLimits = internals.queueCapacityReport({ queueParallelLimit: 4, parallelCallLimit: 6, providerConcurrencyLimit: 4, queueMode: "memory" });
  assert.equal(equalLimits.warning, "");
  // With the queue off the queue limit binds nothing.
  assert.equal(internals.queueCapacityReport({ queueParallelLimit: 2, parallelCallLimit: 6, providerConcurrencyLimit: 10, queueMode: "off" }).warning, "");
});

test("B-042: get_opencode_bridge_status and diagnose_opencode_bridge print the effective queue limit", async () => {
  const repo = await makeRepo("b042");
  const status = await callTool("get_opencode_bridge_status", { cwd: repo });
  const expected = internals.queueCapacityReport();
  assert.match(status, new RegExp(`Queue parallel limit \\(CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT\\): ${internals.CONFIG.queueParallelLimit} job`));
  assert.match(status, new RegExp(`Parallel call job limit \\(CODEX_OPENCODE_PARALLEL_LIMIT\\): ${internals.CONFIG.parallelLimit} job`));
  assert.equal(/only \d+ queued jobs will run at once/.test(status), Boolean(expected.warning), "the warning line appears exactly when the limits disagree");
  const report = JSON.parse(await callTool("diagnose_opencode_bridge", { cwd: repo }));
  assert.equal(report.summary.queueParallelLimit, internals.CONFIG.queueParallelLimit);
  assert.equal(report.summary.parallelCallLimit, internals.CONFIG.parallelLimit);
  assert.equal(report.summary.providerConcurrencyLimit, internals.CONFIG.providerConcurrencyLimit);
  assert.equal(Boolean(report.summary.queueCapacityWarning), Boolean(expected.warning));
});

// B-043 ------------------------------------------------------------------------------------

const GATEWAY_MESSAGE = "Streaming response failed: [504] Upstream idle timeout exceeded";
const TRANSIENT = "opencode_transient_provider_error";
const finalTextEvents = (sessionID = "ses_root") => [
  JSON.stringify({ type: "step_start", sessionID, part: { type: "step-start", sessionID } }),
  JSON.stringify({ type: "text", sessionID, part: { type: "text", id: "prt_1", messageID: "msg_1", sessionID, text: "All done.", time: { start: 1, end: 2 } } }),
];

test("B-043: gateway and upstream idle timeouts are transient provider errors; 502/503 keep their label", () => {
  const classify = internals.providerErrorTypeFromText;
  assert.equal(classify(GATEWAY_MESSAGE), TRANSIENT);
  assert.equal(classify("HTTP 504 Gateway Timeout"), TRANSIENT);
  assert.equal(classify("gateway time-out while contacting the model"), TRANSIENT);
  assert.equal(classify("upstream request timeout after 60s"), TRANSIENT);
  assert.equal(classify("504"), TRANSIENT);
  // Pinned by tests/server-self-test.js: 5xx outages other than a timeout stay "unavailable". Both
  // types are in every retry list, so the retry behaviour is the same.
  assert.equal(classify("HTTP 503 service unavailable"), "opencode_provider_unavailable");
  assert.equal(classify("502 Bad Gateway"), "opencode_provider_unavailable");
  // A rate limit that mentions a gateway is still a rate limit.
  assert.equal(classify("429 Too Many Requests from the gateway"), "opencode_rate_limited");
});

test("B-043: an error event whose only evidence is the message text is classified (string and object forms)", () => {
  const structured = internals.providerErrorTypeFromStructuredEvent;
  // OpenCode's JSON error event for an unclassified failure: name UnknownError, text in data.message.
  assert.equal(structured({ type: "error", error: { name: "UnknownError", data: { message: GATEWAY_MESSAGE } } }), TRANSIENT);
  assert.equal(structured({ type: "session.error", properties: { error: { name: "UnknownError", data: { message: GATEWAY_MESSAGE } } } }), TRANSIENT);
  assert.equal(structured({ type: "error", error: { message: GATEWAY_MESSAGE } }), TRANSIENT);
  assert.equal(structured({ type: "error", error: GATEWAY_MESSAGE }), TRANSIENT);
  assert.equal(structured({ type: "error", error: { name: "UnknownError", data: { message: "Streaming response failed: [503] Service Unavailable" } } }), "opencode_provider_unavailable");
  // A status field wins as before.
  assert.equal(structured({ type: "error", error: { name: "APIError", data: { message: "gateway", statusCode: 504, isRetryable: true } } }), TRANSIENT);
  assert.equal(structured({ type: "error", error: { name: "APIError", data: { message: "service unavailable", statusCode: 503, isRetryable: true } } }), "opencode_provider_unavailable");
  // A bare number or a loose phrase in a message with no provider evidence is not enough.
  assert.equal(structured({ type: "error", error: { message: "Assertion text: expected status 504 in the fixture" } }), "");
  assert.equal(structured({ type: "error", error: { message: "idle timeout setting is documented in the README" } }), "");
  assert.equal(structured({ type: "error", error: { name: "ModelValidationError", message: "Local fixture says model unavailable" } }), "");
});

test("B-043: the run is classified as a transient provider error, not opencode_api_error with type none", () => {
  const event = JSON.stringify({ type: "error", sessionID: "ses_root", error: { name: "UnknownError", data: { message: GATEWAY_MESSAGE } } });
  const inspection = internals.inspectOpenCodeEventStream(event);
  assert.equal(inspection.apiErrorDetected, true);
  assert.equal(inspection.providerErrorType, TRANSIENT);
  const result = { exitCode: 0, dryRun: false, providerErrorType: inspection.providerErrorType, openCodeApiErrorDetected: inspection.apiErrorDetected, assistantFinalResponseDetected: false };
  assert.equal(internals.classifyResultError(result), TRANSIENT);
  // The same text on the bridge's old path: before this fix the type was empty and the result api_error.
  assert.equal(internals.classifyResultError({ ...result, providerErrorType: "" }), "opencode_api_error");
});

test("B-043: a 504 line in OpenCode's stderr counts as a failed provider attempt and can be recovered", () => {
  const stderr = `ERROR 2026-10-01T10:00:00 service=llm ${GATEWAY_MESSAGE}`;
  const recovered = internals.inspectOpenCodeEventStream(finalTextEvents().join("\n"), stderr);
  assert.equal(recovered.providerErrorType, "");
  assert.equal(recovered.recoveredTransientProviderError, true);
  assert.equal(recovered.providerWarningType, TRANSIENT);
  assert.equal(recovered.providerRetryWarningCount, 1);
  const unrecovered = internals.inspectOpenCodeEventStream("", stderr);
  assert.equal(unrecovered.providerErrorType, TRANSIENT);
  assert.equal(unrecovered.apiErrorDetected, true);
});

test("B-043: the existing retry-safety rules decide who retries (readers before any tool call; never a writer)", () => {
  const retryable = internals.readOnlyResultRetryable;
  const readerMetadata = { ok: true, metadata: { canEdit: false, canDelegate: false, externalDirectoryDenied: true } };
  const base = { providerErrorType: TRANSIENT, errorType: TRANSIENT, toolOutcomes: [], invalidEventLineCount: 0, assistantFinalResponseDetected: false };
  assert.equal(retryable(base, "reviewer", readerMetadata), true);
  // A reader that already ran a tool, or answered, is not retried.
  assert.equal(retryable({ ...base, toolOutcomes: [{ tool: "read", status: "completed" }] }, "reviewer", readerMetadata), false);
  assert.equal(retryable({ ...base, assistantFinalResponseDetected: true }, "reviewer", readerMetadata), false);
  // A writer is never retried by this path, whatever the error.
  assert.equal(retryable(base, "builder", { ok: true, metadata: { canEdit: true, canDelegate: false, externalDirectoryDenied: true } }), false);
  // The opt-in builder model fallback is the only write-side reaction and stays gated to runs before any tool.
  const eligible = (extra = {}) => builderFallbackEligible("builder", {
    configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free", errorType: TRANSIENT,
    streamIntegrity: "valid", treeTerminationConfirmed: true, toolOutcomes: [], ...extra,
  }, { enabled: true });
  assert.equal(eligible(), true);
  assert.equal(eligible({ toolOutcomes: [{ tool: "edit", status: "completed" }] }), false);
});

// B-044 ------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "" });

// Agent discovery and the OpenCode run are replaced by the self-test hook (as in
// tests/review-measurement.js); Git, worktrees, locks, the queue and SQLite state are real.
function installRuntime({ onRun = async () => {}, outcome = () => ({ exitCode: 0, errorType: null, stdout: "Done.", assistantFinalResponseDetected: true }) } = {}) {
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: agent === "builder", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan) => {
      const childStartedAtMs = Date.now();
      if (!dryRun) await onRun({ agent, cwd, lockPlan });
      return {
        stderr: "", durationMs: 1, dryRun, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1, usage: null, providerRetryWarningCount: 0,
        ...(dryRun ? { exitCode: 0, errorType: null, stdout: "", assistantFinalResponseDetected: true } : outcome()),
      };
    },
  };
}

async function waitForQueueJob(jobId) {
  const deadline = Date.now() + 30000;
  while (!["completed", "failed", "cancelled"].includes(internals.QUEUE_JOBS.get(jobId)?.status) && Date.now() < deadline) await sleep(50);
  const status = internals.QUEUE_JOBS.get(jobId)?.status;
  assert.ok(["completed", "failed", "cancelled"].includes(status), `queue job ${jobId} did not finish: ${status}`);
  return internals.QUEUE_JOBS.get(jobId);
}

async function makeSourceRepo(label) {
  const root = await makeRepo(label);
  await internals.mkdir(path.join(root, "src"), { recursive: true });
  await internals.writeFile(path.join(root, "src", "a.txt"), "a\n", "utf8");
  await internals.runCommand("git", ["add", "-A"], root, 60000);
  await internals.runCommand("git", ["commit", "-qm", "src"], root, 60000);
  return root;
}

async function enqueueWriter(repo, extra = {}) {
  hooks.queueModeOverride = "sqlite";
  const enqueued = await callTool("enqueue_opencode_job", {
    agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]), ...extra,
  });
  const jobId = /Job ID: (\S+)/.exec(enqueued)?.[1];
  assert.ok(jobId, enqueued);
  return jobId;
}

async function dropRetainedWorktrees(repo, jobId) {
  for (const item of await internals.listRetainedWorktreeArtifacts(repo, { jobId })) {
    await internals.cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
  }
}

test("B-044: the timed-out writer note counts the files, names the retained worktree and ignores other jobs", () => {
  const note = internals.timedOutWriterNote;
  assert.equal(note({ errorType: "agent_timeout", changedFiles: ["a", "b", "c"], worktreeRetained: true }), "timed out after writing 3 changed file(s); worktree retained");
  assert.equal(note({ errorType: "agent_timeout", changedFiles: ["a"] }), "timed out after writing 1 changed file(s)");
  assert.equal(note({ timedOut: true, errorType: "opencode_rate_limited", changedFiles: ["a"], worktreeRetained: true }), "timed out after writing 1 changed file(s); worktree retained");
  assert.equal(note({ errorType: "agent_idle_timeout", changedFiles: ["a", "b"], worktreeRetained: true }), "stopped as idle after writing 2 changed file(s); worktree retained");
  // Nothing to say without files, or when the job did not time out.
  assert.equal(note({ errorType: "agent_timeout", changedFiles: [], worktreeRetained: false }), "");
  assert.equal(note({ errorType: "opencode_api_error", changedFiles: ["a"], worktreeRetained: true }), "");
  assert.equal(note({}), "");
});

test("B-044: the single-result preamble and the compact lines say a timed-out writer wrote files", () => {
  const resolution = { requestedAgent: "builder", actualAgent: "builder" };
  const timedOut = {
    exitCode: 124, timedOut: true, timeoutMs: 600000, errorType: "agent_timeout", dryRun: false, changedFiles: ["src/a.txt", "src/b.txt"],
    worktree: { path: "C:/work/wt", removed: false, cleanup: "retained_for_review" }, assistantFinalResponseDetected: false,
  };
  const expected = "Timed out with changes: timed out after writing 2 changed file(s); worktree retained";
  assert.ok(internals.compactJobLines({ resolution, result: timedOut }).includes(expected), internals.compactJobLines({ resolution, result: timedOut }).join("\n"));
  assert.ok(internals.formatSingleResultParts({ resolution, result: timedOut, cwd: "C:/work", lockPlan: null }).preamble.includes(expected));
  // A timeout that wrote nothing, a removed (empty) worktree and a job that did not time out stay as before.
  const plain = internals.compactJobLines({ resolution, result: { ...timedOut, changedFiles: [], worktree: { path: "", removed: true } } }).join("\n");
  assert.doesNotMatch(plain, /Timed out with changes/);
  const finished = internals.compactJobLines({ resolution, result: { exitCode: 0, errorType: null, dryRun: false, changedFiles: ["src/a.txt"], assistantFinalResponseDetected: true } }).join("\n");
  assert.doesNotMatch(finished, /Timed out with changes/);
  const noWorktree = internals.compactJobLines({ resolution, result: { ...timedOut, worktree: undefined } }).join("\n");
  assert.match(noWorktree, /Timed out with changes: timed out after writing 2 changed file\(s\)$/m);
});

test("B-044: a queued writer that times out after writing keeps its worktree and the job says so", async () => {
  const repo = await makeSourceRepo("b044-queue");
  installRuntime({
    onRun: async ({ cwd }) => internals.writeFile(path.join(cwd, "src", "a.txt"), "half-finished edit\n", "utf8"),
    outcome: () => ({ exitCode: 124, timedOut: true, timeoutMs: 600000, errorType: "agent_timeout", stdout: "", assistantFinalResponseDetected: false }),
  });
  const jobId = await enqueueWriter(repo);
  try {
    const record = await waitForQueueJob(jobId);
    assert.equal(record.status, "failed");
    assert.equal(record.errorType, "agent_timeout");
    assert.deepEqual(record.changedFiles, ["src/a.txt"]);
    assert.ok(record.worktreePath, "the worktree is retained");
    assert.match(record.errorReason, /^timed out after writing 1 changed file\(s\); worktree retained/);
    assert.equal(record.completionOutcome, "timed_out_with_changes");
    const listing = await callTool("list_opencode_jobs", { cwd: repo });
    assert.match(listing, new RegExp(`${jobId}[^\\n]*error=agent_timeout[^\\n]*outcome=timed_out_with_changes[^\\n]*note="timed out after writing 1 changed file\\(s\\); worktree retained"`));
    const view = JSON.parse(await callTool("get_opencode_job", { jobId, cwd: repo }));
    assert.equal(view.completionOutcome, "timed_out_with_changes");
    assert.match(view.errorReason, /timed out after writing 1 changed file\(s\); worktree retained/);
    assert.match(view.resultText, /Timed out with changes: timed out after writing 1 changed file\(s\); worktree retained/);
    assert.match(view.worktreePath, /\S/);
  } finally {
    hooks.agentRuntimeTestHook = null;
    await dropRetainedWorktrees(repo, jobId);
  }
});

test("B-044: a writer that times out without writing anything is a plain timeout and leaves no worktree", async () => {
  const repo = await makeSourceRepo("b044-empty");
  installRuntime({ outcome: () => ({ exitCode: 124, timedOut: true, timeoutMs: 600000, errorType: "agent_timeout", stdout: "", assistantFinalResponseDetected: false }) });
  const jobId = await enqueueWriter(repo);
  try {
    const record = await waitForQueueJob(jobId);
    assert.equal(record.errorType, "agent_timeout");
    assert.equal(record.completionOutcome || "", "");
    assert.doesNotMatch(record.errorReason, /after writing/);
    assert.equal(record.worktreePath || "", "");
    assert.doesNotMatch(await callTool("list_opencode_jobs", { cwd: repo }), /note="/);
  } finally {
    hooks.agentRuntimeTestHook = null;
    await dropRetainedWorktrees(repo, jobId);
  }
});

// B-045 ------------------------------------------------------------------------------------

const MB = 1024 * 1024;
async function withMemory({ floorMb, freeMb }, action) {
  hooks.minFreeMemoryMbOverride = floorMb;
  hooks.freeMemoryBytesTestHook = typeof freeMb === "function" ? () => freeMb() * MB : () => freeMb * MB;
  try {
    return await action();
  } finally {
    hooks.minFreeMemoryMbOverride = null;
    hooks.freeMemoryBytesTestHook = null;
  }
}

test("B-045: the memory gate is off by default and blocks only below the floor", async () => {
  assert.equal(internals.CONFIG.minFreeMemoryMb, 0, "disabled unless CODEX_OPENCODE_MIN_FREE_MEMORY_MB is set");
  assert.equal(internals.queueMemoryGate().blocked, false);
  await withMemory({ floorMb: 0, freeMb: 10 }, () => assert.equal(internals.queueMemoryGate().blocked, false));
  await withMemory({ floorMb: 2048, freeMb: 1000 }, () => {
    const gate = internals.queueMemoryGate();
    assert.equal(gate.blocked, true);
    assert.equal(gate.freeMb, 1000);
    assert.equal(gate.floorMb, 2048);
  });
  await withMemory({ floorMb: 2048, freeMb: 2048 }, () => assert.equal(internals.queueMemoryGate().blocked, false, "free memory equal to the floor starts"));
  await withMemory({ floorMb: 2048, freeMb: 4096 }, () => assert.equal(internals.queueMemoryGate().blocked, false));
});

test("B-045: the status lines show the floor, the free memory, a hold and an unsatisfiable floor", async () => {
  const lines = (gate) => internals.queueMemoryStatusLines(gate).join("\n");
  assert.match(
    lines({ floorMb: 0, freeMb: 5000, totalMb: 16000, blocked: false }),
    /Minimum free memory to start a queue job \(CODEX_OPENCODE_MIN_FREE_MEMORY_MB\): disabled \(0\)\nFree memory now: 5000 MB of 16000 MB$/
  );
  const held = lines({ floorMb: 1024, freeMb: 100, totalMb: 16000, blocked: true });
  assert.match(held, /\(CODEX_OPENCODE_MIN_FREE_MEMORY_MB\): 1024 MB/);
  assert.match(held, /Free memory now: 100 MB of 16000 MB/);
  assert.match(held, /Queue starts held for low memory/);
  // A floor the machine can never satisfy is called out, not left to look like a stuck queue.
  assert.match(
    lines({ floorMb: 20000, freeMb: 5000, totalMb: 16000, blocked: true }),
    /Warning: the free-memory floor \(20000 MB\) is not below the machine's total memory \(16000 MB\)/
  );
  assert.doesNotMatch(held, /Warning/);
  // The tools print the same lines (one status call: it starts the real OpenCode version check).
  const repo = await makeRepo("b045-status");
  await withMemory({ floorMb: 1024, freeMb: 100 }, async () => {
    const status = await callTool("get_opencode_bridge_status", { cwd: repo });
    assert.match(status, /\(CODEX_OPENCODE_MIN_FREE_MEMORY_MB\): 1024 MB/);
    assert.match(status, /Free memory now: 100 MB of \d+ MB/);
    assert.match(status, /Queue starts held for low memory/);
    const report = JSON.parse(await callTool("diagnose_opencode_bridge", { cwd: repo }));
    assert.equal(report.summary.minFreeMemoryMb, 1024);
    assert.equal(report.summary.freeMemoryMb, 100);
  });
});

test("B-045: the queue starts no job below the floor, labels it waiting_for_memory, and starts it when memory recovers", async () => {
  const repo = await makeRepo("b045-queue");
  let ran = 0;
  installRuntime({ onRun: async () => { ran += 1; } });
  hooks.queueModeOverride = "sqlite";
  let freeMb = 100;
  let jobId = "";
  try {
    await withMemory({ floorMb: 1024, freeMb: () => freeMb }, async () => {
      const enqueued = await callTool("enqueue_opencode_job", { agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" });
      jobId = /Job ID: (\S+)/.exec(enqueued)?.[1];
      assert.ok(jobId, enqueued);
      await sleep(900);
      const record = internals.QUEUE_JOBS.get(jobId);
      assert.equal(record.status, "pending", "held below the floor");
      assert.equal(ran, 0, "the agent was not started");
      assert.equal(internals.queueRunStage(record), "waiting_for_memory");
      assert.ok(internals.queueMemoryWaitingJobs.has(jobId));
      assert.match(await callTool("list_opencode_jobs", { cwd: repo }), new RegExp(`${jobId}[^\\n]*status=pending stage=waiting_for_memory`));
      assert.equal(JSON.parse(await callTool("get_opencode_job", { jobId, cwd: repo })).runStage, "waiting_for_memory");
      freeMb = 4096;
      const finished = await waitForQueueJob(jobId);
      assert.equal(finished.status, "completed", finished.errorReason);
      assert.equal(ran, 1);
      assert.equal(internals.queueMemoryWaitingJobs.size, 0, "the hold is released once the job started");
      assert.doesNotMatch(await callTool("list_opencode_jobs", { cwd: repo }), /waiting_for_memory/);
    });
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
});

test("B-045: with the floor disabled a low free-memory reading does not hold the queue", async () => {
  const repo = await makeRepo("b045-off");
  let ran = 0;
  installRuntime({ onRun: async () => { ran += 1; } });
  hooks.queueModeOverride = "sqlite";
  try {
    await withMemory({ floorMb: 0, freeMb: 1 }, async () => {
      const enqueued = await callTool("enqueue_opencode_job", { agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" });
      const jobId = /Job ID: (\S+)/.exec(enqueued)?.[1];
      const finished = await waitForQueueJob(jobId);
      assert.equal(finished.status, "completed", finished.errorReason);
      assert.equal(ran, 1);
    });
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
});

// B-046 ------------------------------------------------------------------------------------

const quietAfterHello = "process.stdout.write('hello'); setTimeout(() => {}, 30000)";

test("B-046: an agent that writes nothing for the idle timeout is stopped and reported as idle", async () => {
  const activity = [];
  const started = Date.now();
  const result = await internals.runSpawnCommand(process.execPath, ["-e", quietAfterHello], process.cwd(), 60_000, null, {
    idleTimeoutMs: 1000,
    onActivity: (atMs) => activity.push(atMs),
  });
  assert.equal(result.idleTimedOut, true, JSON.stringify(result).slice(0, 600));
  assert.equal(result.timedOut, true, "an idle stop is a timeout for the retry rules");
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, "hello");
  assert.ok(Date.now() - started < 25_000, `stopped late: ${Date.now() - started} ms`);
  assert.ok(activity.length >= 2, "the launch and the output are both activity");
  assert.equal(result.terminationErrorType || "", "", "the process tree ended through the supervisor");
  assert.equal(internals.classifyResultError({ ...result, dryRun: false, assistantFinalResponseDetected: false }), "agent_idle_timeout");
});

test("B-046: output keeps an agent alive, and the watchdog is off at 0", async () => {
  const chatty = "let n = 0; const t = setInterval(() => { process.stdout.write('tick' + (n += 1) + '\\n'); if (n === 12) { clearInterval(t); } }, 150)";
  const alive = await internals.runSpawnCommand(process.execPath, ["-e", chatty], process.cwd(), 60_000, null, { idleTimeoutMs: 900 });
  assert.equal(alive.idleTimedOut, false);
  assert.equal(alive.timedOut, false);
  assert.equal(alive.exitCode, 0);
  assert.match(alive.stdout, /tick12/);
  const off = await internals.runSpawnCommand(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], process.cwd(), 60_000, null, { idleTimeoutMs: 0 });
  assert.equal(off.idleTimedOut, false);
  assert.equal(off.exitCode, 0);
  assert.equal(internals.CONFIG.agentIdleTimeoutMs, 0, "disabled unless CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS is set");
});

test("B-046: the idle result is reported like a timeout but named agent_idle_timeout", () => {
  const resolution = { requestedAgent: "builder", actualAgent: "builder" };
  const idle = {
    exitCode: 124, timedOut: true, idleTimedOut: true, idleTimeoutMs: 600000, timeoutMs: 1800000, errorType: "agent_idle_timeout",
    dryRun: false, changedFiles: ["src/a.txt"], worktree: { path: "C:/work/wt", removed: false }, assistantFinalResponseDetected: false,
  };
  assert.equal(internals.classifyResultError({ exitCode: 124, timedOut: true, idleTimedOut: true, dryRun: false }), "agent_idle_timeout");
  assert.equal(internals.classifyResultError({ exitCode: 124, timedOut: true, dryRun: false }), "agent_timeout");
  const lines = internals.compactJobLines({ resolution, result: idle }).join("\n");
  assert.match(lines, /Idle timeout: yes \(no output for 600000 ms\)/);
  assert.match(lines, /Timed out with changes: stopped as idle after writing 1 changed file\(s\); worktree retained/);
  const preamble = internals.formatSingleResultParts({ resolution, result: idle, cwd: "C:/work", lockPlan: null }).preamble;
  assert.match(preamble, /Agent idle timeout: the agent wrote no output for 600000 ms \(CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS\) and was stopped/);
  assert.match(preamble, /^Error type: agent_idle_timeout$/m);
});

test("B-046: a running job shows when its agent last wrote (idle time), a finished or foreign job does not", async () => {
  const jobId = "builder-idle-display-1";
  const base = { jobId, agent: "builder", mode: "write", status: "running", childProcessStartedAt: new Date().toISOString(), agentStartedAt: new Date().toISOString() };
  assert.deepEqual(internals.queueAgentActivity(base), {}, "no activity known yet");
  const now = Date.now();
  internals.noteAgentActivity(jobId, now - 3 * 60_000 - 5_000);
  try {
    const activity = internals.queueAgentActivity(base, now);
    assert.equal(activity.idleMs, 3 * 60_000 + 5_000);
    assert.equal(activity.lastActivityAt, new Date(now - 3 * 60_000 - 5_000).toISOString());
    assert.match(internals.compactQueueJobLines([base]), /status=running stage=agent_running[^\n]* idle 3m\b/);
    // Not running (finished, or still starting): nothing to show.
    assert.deepEqual(internals.queueAgentActivity({ ...base, status: "failed" }, now), {});
    assert.deepEqual(internals.queueAgentActivity({ ...base, childProcessStartedAt: "" }, now), {});
    assert.deepEqual(internals.queueAgentActivity({ ...base, jobId: "builder-other-bridge" }, now), {});
    assert.doesNotMatch(internals.compactQueueJobLines([{ ...base, status: "completed" }]), /idle /);
  } finally {
    internals.agentActivityByJobId.delete(jobId);
  }
  assert.deepEqual([0, 12_000, 59_999, 60_000, 180_000, 3_599_000, 3_900_000].map(internals.formatIdleDuration), ["0s", "12s", "59s", "1m", "3m", "59m", "1h05m"]);
});

test("B-046: list_opencode_jobs and get_opencode_job report the idle time of a job whose agent is running", async () => {
  const repo = await makeSourceRepo("b046-display");
  let release = () => {};
  const hold = new Promise((resolve) => { release = resolve; });
  let atRun = null;
  installRuntime({});
  const runtime = hooks.agentRuntimeTestHook;
  hooks.agentRuntimeTestHook = {
    ...runtime,
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan, timeoutMs, options = {}) => {
      // What runOpenCode does: the supervisor identity is persisted (the job is then agent_running)
      // and the agent's output keeps noting activity under the job id of the provider-wait store.
      const jobId = internals.providerSlotWaitStorage.getStore()?.jobId;
      await options.onSpawn?.({ pid: process.pid, startedAt: new Date().toISOString(), processRole: "supervisor", containmentIdentity: "round5-fixture" });
      internals.noteAgentActivity(jobId, Date.now() - 4 * 60_000);
      atRun = jobId;
      await hold;
      internals.agentActivityByJobId.delete(jobId);
      return runtime.runOpenCodeWithPolicy(agent, prompt, cwd, dryRun, lockPlan);
    },
  };
  const jobId = await enqueueWriter(repo);
  try {
    const deadline = Date.now() + 20_000;
    while (atRun !== jobId && Date.now() < deadline) await sleep(25);
    assert.equal(atRun, jobId, "the job reached its agent");
    const listing = await callTool("list_opencode_jobs", { cwd: repo });
    assert.match(listing, new RegExp(`${jobId}[^\\n]*status=running stage=agent_running[^\\n]* idle 4m\\b`), listing);
    const view = JSON.parse(await callTool("get_opencode_job", { jobId, cwd: repo }));
    assert.equal(view.runStage, "agent_running");
    assert.ok(view.idleMs >= 4 * 60_000 && view.idleMs < 4 * 60_000 + 30_000, JSON.stringify(view));
    assert.ok(Date.parse(view.lastActivityAt) <= Date.now() - 4 * 60_000 + 1000);
    const detail = JSON.parse(await callTool("get_opencode_job", { jobId, cwd: repo, detail: true }));
    assert.ok(detail.idleMs >= 4 * 60_000);
    const diagnose = JSON.parse(await callTool("diagnose_opencode_bridge", { cwd: repo }));
    assert.ok(diagnose.jobs.find((job) => job.jobId === jobId)?.idleMs >= 4 * 60_000);
  } finally {
    release();
    const finished = await waitForQueueJob(jobId);
    hooks.agentRuntimeTestHook = null;
    assert.equal(finished.status === "completed" || finished.status === "failed", true);
    await dropRetainedWorktrees(repo, jobId);
  }
  assert.doesNotMatch(await callTool("list_opencode_jobs", { cwd: repo }), /idle \d/, "a finished job shows no idle time");
});

test("B-046: a queued writer stopped as idle fails as agent_idle_timeout and keeps its worktree", async () => {
  const repo = await makeSourceRepo("b046-queue");
  installRuntime({
    onRun: async ({ cwd }) => internals.writeFile(path.join(cwd, "src", "a.txt"), "edit before the stall\n", "utf8"),
    outcome: () => ({ exitCode: 124, timedOut: true, idleTimedOut: true, idleTimeoutMs: 600000, timeoutMs: 1800000, errorType: "agent_idle_timeout", stdout: "", assistantFinalResponseDetected: false }),
  });
  const jobId = await enqueueWriter(repo);
  try {
    const record = await waitForQueueJob(jobId);
    assert.equal(record.status, "failed");
    assert.equal(record.errorType, "agent_idle_timeout");
    assert.deepEqual(record.changedFiles, ["src/a.txt"]);
    assert.ok(record.worktreePath, "the worktree is retained");
    assert.match(record.errorReason, /^stopped as idle after writing 1 changed file\(s\); worktree retained/);
    assert.equal(record.completionOutcome, "timed_out_with_changes");
    assert.match(await callTool("list_opencode_jobs", { cwd: repo }), /error=agent_idle_timeout[^\n]*note="stopped as idle after writing 1 changed file\(s\); worktree retained"/);
  } finally {
    hooks.agentRuntimeTestHook = null;
    await dropRetainedWorktrees(repo, jobId);
  }
});

let failed = 0;
const skips = [];
try {
  for (const { name, fn } of tests) {
    const startedAt = Date.now();
    try {
      await fn();
      process.stdout.write(`ok   ${name} (${Date.now() - startedAt} ms)\n`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skips.push({ name, reason: error.message, optional: error.optional });
        process.stdout.write(`skip ${name}: ${error.message}\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  hooks.stateDirectoryOverride = "";
  for (const root of scratchRoots) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-round5.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} round 5 tests failed${skipGateFailed ? "; the skip gate failed" : ""}.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} round 5 tests passed.\n`);
process.exit(0);
