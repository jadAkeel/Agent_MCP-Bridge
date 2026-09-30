#!/usr/bin/env node

// Regression tests for L-025 (a 4-reviewer run_opencode_parallel returned 86,633 characters and
// stored none of it) and L-026 (get_opencode_job for a finished writer returned 25k characters:
// the whole patch preview, a report cut in the middle and a "truncated" outcome). Log: B-031, B-032.
// Agent discovery and the OpenCode run are replaced by the self-test agentRuntimeTestHook, as in
// tests/review-measurement.js; Git, locks, the worktree registry, the queue and SQLite state are real.
//   node tests/review-l025.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
// Four reviewers on one provider are the reported case; the default of 2 would reject the batch.
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "4";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
const { readdir, readFile } = await import("node:fs/promises");
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  CONFIG,
  QUEUE_JOBS,
  assert,
  cleanupWorktree,
  compactJobLines,
  directRunAuditStore,
  fitJobResultText,
  listRetainedWorktreeArtifacts,
  mkdir,
  mkdtemp,
  path,
  rm,
  runCommand,
  server,
  tmpdir,
  writeFile,
} = __selfTest.internals;

const stateDir = await mkdtemp(path.join(tmpdir(), "review-l025-state-"));
const repo = await mkdtemp(path.join(tmpdir(), "review-l025-repo-"));
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";

const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repo) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
await git(["init", "-q"]);
await git(["config", "core.autocrlf", "false"]);
await mkdir(path.join(repo, "src"), { recursive: true });
await writeFile(path.join(repo, "src", "a.txt"), "a\n", "utf8");
await writeFile(path.join(repo, "src", "b.txt"), "b\n", "utf8");
await git(["add", "."]);
await git([...gitIdentity, "commit", "-q", "-m", "init"]);

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "" });
const USAGE = { steps: 2, inputCount: 1200, outputCount: 80, reasoningCount: 30, cacheReadCount: 5, cacheWriteCount: 0, cost: 0, rootSteps: 2 };
const WRITE_AGENTS = new Set(["builder", "debugger"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A report of exactly `chars` characters that starts and ends with a marker, so a cut anywhere shows.
const reportOf = (label, chars) => {
  const lines = [`${label} START`];
  let length = lines[0].length;
  for (let line = 0; length < chars; line += 1) {
    lines.push(`${label} line ${String(line).padStart(4, "0")}: finding text that pads the report.`);
    length += lines.at(-1).length + 1;
  }
  const end = `\n${label} END`;
  return `${lines.join("\n").slice(0, chars - end.length)}${end}`;
};

function metadataFor(agent) {
  return { ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: WRITE_AGENTS.has(agent), canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
  } };
}

// runResult(agent, index) may return fields that replace the default run result.
function installRuntime({ onRun = async () => {}, runResult = () => ({}) } = {}) {
  let runs = 0;
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => metadataFor(agent),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan) => {
      const index = runs++;
      const childStartedAtMs = Date.now();
      if (!dryRun) await onRun({ agent, cwd, lockPlan, index });
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1,
        usage: USAGE, providerRetryWarningCount: 0, providerConcurrencyWaitMs: 7,
        runPhaseTimings: { preSlotMs: 1, providerWaitMs: 7, finalAttestationMs: 2, spawnGateMs: 0, afterExitMs: 0 },
        ...runResult(agent, index),
      };
    },
  };
}

async function waitForQueueJob(jobId) {
  const deadline = Date.now() + 30000;
  while (!["completed", "failed", "cancelled"].includes(QUEUE_JOBS.get(jobId)?.status) && Date.now() < deadline) await sleep(50);
  assert.ok(["completed", "failed"].includes(QUEUE_JOBS.get(jobId)?.status), `queue job ${jobId} did not finish: ${QUEUE_JOBS.get(jobId)?.status}`);
}

async function filesUnder(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else found.push(full);
  }
  return found;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sizes = {};

// ---------------------------------------------------------------------------- L-025 / B-031
test("L-025: a 4-reviewer parallel call stores every job's result under its Run id; get_opencode_job returns it", async () => {
  const canary = "SEALED-CANARY-9f3b7c1d";
  installRuntime({ runResult: (agent, index) => ({ stdout: reportOf(`REPORT-${index}`, 9000) + `\n${canary}` }) });
  const jobs = [0, 1, 2, 3].map((index) => ({ agent: "reviewer", task: `Review part ${index}.`, cwd: repo, write: false, lockMode: "off" }));
  const text = textOf(await callTool("run_opencode_parallel", { jobs }));
  sizes.compact4 = text.length;
  const runIds = [...text.matchAll(/JOB \d\nRun id: (\S+) \(get_opencode_job finds it/g)].map((match) => match[1]);
  assert.equal(runIds.length, 4, text.slice(0, 3000));

  for (const runId of runIds) {
    const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo })));
    assert.equal(view.kind, "parallel_run");
    assert.equal(view.status, "completed");
    assert.match(view.resultText, /REPORT-\d START/, "the stored text carries the report");
    assert.match(view.resultText, /REPORT-\d END/, "and its end");
    assert.equal(view.resultTextTruncated, false);
    assert.ok(view.resultTextChars > 9000, JSON.stringify({ chars: view.resultTextChars }));
    assert.ok(view.resultDetailTextChars > 500, "the bridge preamble is stored as detail");
    assert.equal(view.resultDetailText, undefined, "the detail text is left out unless asked for");
    assert.match(view.note, /resultText/);
    // The stored text is what the call returned for this job: a lost response loses nothing.
    assert.ok(text.includes(view.resultText), `stored text of ${runId} is the block the call returned`);
    const withDetail = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo, detail: true })));
    assert.match(withDetail.resultDetailText, /Temporary lock acquired:/);
    assert.match(withDetail.resultDetailText, /Tool outcomes:/);
    assert.match(withDetail.resultDetailText, /Timing ms: total=\d+/);
  }

  // The report never sits in the database in plaintext.
  for (const file of await filesUnder(stateDir)) {
    if (!/sqlite/.test(file)) continue;
    assert.equal((await readFile(file)).includes(Buffer.from(canary)), false, `${file} holds the report in plaintext`);
  }
  // A reconnect (a new store over the same database) still reads it.
  const reread = await directRunAuditStore().get(repo, runIds[0], { includeResult: true });
  assert.match(reread.result.text, /REPORT-\d START/);
});

test("L-025: the default parallel block is compact; detail: true appends the bridge preamble", async () => {
  installRuntime({ runResult: () => ({ stdout: "Findings: none.\nEND-OF-REPORT" }) });
  const job = { agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" };
  const compact = textOf(await callTool("run_opencode_parallel", { jobs: [job] }));
  for (const wanted of [
    /JOB 1\nRun id: \S+ \(get_opencode_job finds it/, /Agent: reviewer/, /Status: completed/, /Model: fixture\/model-a/,
    /Timing: agentRunMs=\d+ startupMs=\d+ providerWaitMs=7 totalMs=[0-9]+/, /Token usage: steps=2 input=1200 output=80/,
    /Files changed: none detected/, /Unsafe changed files: none detected/,
    /Assistant final response:\nFindings: none\.\nEND-OF-REPORT/, /Direct run audit: \S+; terminal metadata persisted/,
  ]) assert.match(compact, wanted);
  for (const unwanted of [
    /Requested agent mode:/, /Lock granted:/, /Lock mode:/, /Scope Contract/, /Tool outcomes:/, /Timing ms: total=/, /sharedSetup=/,
    /Runtime-observed provider:/, /Provider\/account concurrency key:/, /Working directory:/, /Temporary lock acquired:/, /Silent model fallback/,
  ]) assert.doesNotMatch(compact, unwanted);

  const detailed = textOf(await callTool("run_opencode_parallel", { jobs: [job], detail: true }));
  for (const wanted of [/Bridge detail \(get_opencode_job with detail: true returns it later\):/, /Temporary lock acquired:/, /Lock mode:/, /Tool outcomes:/, /Timing ms: total=\d+/, /sharedSetup=\d+/, /Runtime-observed provider:/]) {
    assert.match(detailed, wanted);
  }
  assert.ok(detailed.length > compact.length + 1500, `detail ${detailed.length} vs compact ${compact.length}`);
  // The detail is additive: the compact block is still there, unchanged, at the top.
  assert.match(detailed, /Status: completed/);
  assert.match(detailed, /Assistant final response:\nFindings: none\.\nEND-OF-REPORT/);
});

test("L-025: provider warnings, failures and scope violations stay visible in the compact block", async () => {
  installRuntime({
    onRun: async ({ agent, cwd }) => {
      if (agent === "builder") await writeFile(path.join(cwd, "src", "b.txt"), "outside the lock\n", "utf8");
    },
    runResult: (agent) => {
      if (agent === "reviewer") {
        return { stdout: "Reviewed despite rate limits.", providerWarningType: "opencode_rate_limited", recoveredTransientProviderError: true, providerRetryWarningCount: 2 };
      }
      if (agent === "tester") {
        return {
          stdout: "", exitCode: 1, errorType: "opencode_rate_limited", providerErrorType: "opencode_rate_limited", openCodeApiErrorDetected: true,
          assistantFinalResponseDetected: false, stderr: "ERROR AI_APICallError: Rate limit exceeded", providerRetryWarningCount: 5,
        };
      }
      return {};
    },
  });
  const readScope = { mode: "read", read: ["src/b.txt"] };
  const jobs = [
    { agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off", scopeContract: readScope },
    { agent: "tester", task: "Test.", cwd: repo, write: false, lockMode: "off", scopeContract: readScope },
    { agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "strict", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]) },
  ];
  const text = textOf(await callTool("run_opencode_parallel", { jobs }));
  const blocks = text.split(/(?=^JOB \d$)/m).filter((block) => /^JOB \d\nRun id: /.test(block));
  assert.equal(blocks.length, 3, text);
  const [reviewer, tester, builder] = blocks;
  // Rate limits that were retried: visible.
  assert.match(reviewer, /Provider warning type: opencode_rate_limited/);
  assert.match(reviewer, /Recovered transient provider error: yes/);
  assert.match(reviewer, /Provider error lines in OpenCode stderr \(attempts OpenCode retried or failed\): 2/);
  assert.match(reviewer, /Status: completed/);
  // A rate-limited failure: status, error type, API error flag, exit code, missing response and stderr.
  assert.match(tester, /Status: failed; error type: opencode_rate_limited/);
  assert.match(tester, /Provider error type: opencode_rate_limited/);
  assert.match(tester, /OpenCode API error detected: yes/);
  assert.match(tester, /Assistant final response detected: no/);
  assert.match(tester, /Exit code: 1/);
  assert.match(tester, /STDERR summary:\nERROR AI_APICallError: Rate limit exceeded/);
  // A writer that left its scope: the unsafe file, the failed status and the group verdict.
  assert.match(builder, /Unsafe changed files: src\/b\.txt/);
  assert.match(builder, /Status: failed; error type: changed_file_validation_error/);
  assert.match(builder, /Worktree path: /);
  assert.match(builder, /Worktree branch: agent\/builder\//);
  assert.match(builder, /Worktree diff stat:\n src\/b\.txt \| \+1 -1/);
  assert.match(text, /Path: .+\nBranch: agent\/builder\/.+\nCleanup: retained_for_review/, "the group section still names the retained worktree");
  assert.match(text, /Rejected\. Disallowed changed files were detected; no rollback was attempted/);
  for (const item of await listRetainedWorktreeArtifacts(repo)) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

test("L-025: a single run_opencode_agent run is stored under its audit id; its patch preview is detail", async () => {
  const edited = Array.from({ length: 300 }, (_, line) => `direct edit line ${line} with some text to pad it`).join("\n");
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "b.txt"), `${edited}\n`, "utf8"), runResult: () => ({ stdout: "Edited src/b.txt.\nDIRECT-END" }) });
  const response = textOf(await callTool("run_opencode_agent", {
    agent: "builder", task: "Edit src/b.txt.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src/b.txt"], allowedEdits: ["src/b.txt"], scopeContract: writeScope(["src/b.txt"]),
  }));
  const runId = /Direct run audit: (\S+); terminal metadata persisted/.exec(response)?.[1];
  assert.ok(runId, response);
  assert.match(response, /Worktree patch preview:\ndiff --git/, "the direct response still carries the patch preview");
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo })));
  assert.equal(view.kind, "direct_run");
  assert.match(view.resultText, /Assistant final response:\nEdited src\/b\.txt\.\nDIRECT-END/);
  assert.match(view.resultText, /Worktree diff stat:/);
  assert.match(view.resultText, /Worktree patch preview: omitted from this view \(\d+ characters stored\)/);
  assert.doesNotMatch(view.resultText, /diff --git/);
  assert.ok(view.resultDetailTextChars > 5000, JSON.stringify({ chars: view.resultDetailTextChars }));
  const detailed = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo, detail: true })));
  assert.match(detailed.resultDetailText, /^Worktree patch preview:\ndiff --git/);
  for (const item of await listRetainedWorktreeArtifacts(repo, { jobId: runId })) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

// ---------------------------------------------------------------------------- L-026 / B-032
async function runQueuedWriter({ report, lines = 400, file = "src/a.txt" }) {
  const content = Array.from({ length: lines }, (_, line) => `queued edit line ${line} with enough text to make the patch long`).join("\n");
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, file), `${content}\n`, "utf8"), runResult: () => ({ stdout: report }) });
  const enqueued = textOf(await callTool("enqueue_opencode_job", {
    agent: "builder", task: `Edit ${file}.`, cwd: repo, write: true, lockMode: "simple",
    lockedPaths: [file], allowedEdits: [file], scopeContract: writeScope([file]),
  }));
  const jobId = /Job ID: (\S+)/.exec(enqueued)?.[1];
  assert.ok(jobId, enqueued);
  await waitForQueueJob(jobId);
  return jobId;
}

test("L-026: get_opencode_job for a finished writer leaves the patch preview out and reports no truncation", async () => {
  // Preamble (about 4k) + report (9k) + patch preview (12k) is over the 24000 limit: the old text lost
  // the middle of the report and read as a failure. Without the patch it is well under.
  const report = reportOf("QUEUE-REPORT", 9000);
  const jobId = await runQueuedWriter({ report });
  assert.equal(QUEUE_JOBS.get(jobId).status, "completed", QUEUE_JOBS.get(jobId).errorReason);
  const raw = textOf(await callTool("get_opencode_job", { jobId, cwd: repo }));
  sizes.queueDefault = raw.length;
  const view = JSON.parse(raw);
  assert.equal(view.status, "completed");
  assert.notEqual(view.completionOutcome, "completed_with_truncated_output", "a bridge that only left the patch out did not truncate anything");
  assert.notEqual(view.resultTextTruncated, true);
  assert.ok(view.resultText.includes(report), "the whole report, first line to last");
  assert.match(view.resultText, /Worktree diff stat:\n.*src\/a\.txt/);
  assert.match(view.resultText, /Worktree patch preview: omitted from this view \(\d+ characters stored\)\. integrate_opencode_worktree with dryRun: true shows the patch; get_opencode_job with detail: true returns the stored preview\./);
  assert.doesNotMatch(view.resultText, /diff --git/);
  assert.doesNotMatch(view.resultText, /the middle was truncated/);
  assert.ok(view.resultText.length < 16000, `result text ${view.resultText.length}`);
  assert.ok(view.resultDetailTextChars > 10000, "the patch preview is stored apart");
  assert.equal(view.resultDetailText, undefined);
  assert.match(view.omitted, /resultDetailText/);

  const detailed = JSON.parse(textOf(await callTool("get_opencode_job", { jobId, cwd: repo, detail: true })));
  assert.match(detailed.resultDetailText, /^Worktree patch preview:\ndiff --git a\/src\/a\.txt/);
  assert.match(detailed.resultDetailText, /queued edit line 0 with enough text/);
  assert.equal(detailed.completionOutcome || "", "");
  for (const item of await listRetainedWorktreeArtifacts(repo, { jobId })) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

test("L-026: a report over the limit is cut at its end and is the only thing reported as truncated", async () => {
  const report = reportOf("HUGE-REPORT", CONFIG.queueResultMaxChars + 6000);
  const jobId = await runQueuedWriter({ report, lines: 40, file: "src/b.txt" });
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId, cwd: repo })));
  assert.equal(view.status, "completed");
  assert.equal(view.completionOutcome, "completed_with_truncated_output");
  assert.equal(view.resultTextTruncated, true);
  assert.ok(view.resultText.length <= CONFIG.queueResultMaxChars, `stored ${view.resultText.length}`);
  assert.ok(view.resultTextChars > CONFIG.queueResultMaxChars, "the original length is kept");
  assert.match(view.resultText, /HUGE-REPORT START/);
  assert.ok(view.resultText.includes(report.slice(0, 15000)), "the report is contiguous from its start");
  assert.doesNotMatch(view.resultText, /HUGE-REPORT END/);
  assert.match(view.resultText, /the agent's report was cut here: \d+ of \d+ characters omitted at its end/);
  assert.doesNotMatch(view.resultText, /the middle was truncated/);
  assert.match(view.resultText, /Worktree diff stat:/, "the text after the report survives");
  assert.match(view.resultText, /Write lock verification:/);
  for (const item of await listRetainedWorktreeArtifacts(repo, { jobId })) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

test("L-026: fitJobResultText cuts the preamble before the report, and the report at its end, never in the middle", async () => {
  const limit = 24000;
  const head = `HEAD-START\n${"preamble line\n".repeat(300)}HEAD-END`;
  const tail = "TAIL: worktree review\nTAIL: Write lock verification: Accepted.";
  const standIn = "STAND-IN: agent reviewer; status completed";

  const fits = fitJobResultText({ head, headStandIn: standIn, report: reportOf("R1", 8000), tail }, limit);
  assert.equal(fits.reportTruncated, false);
  assert.equal(fits.movedHead, "");
  assert.ok(fits.text.startsWith("HEAD-START"), "a result that fits is left as it is");

  const report = reportOf("R2", 21000);
  const shortened = fitJobResultText({ head, headStandIn: standIn, report, tail }, limit);
  assert.ok(head.length + report.length + tail.length > limit);
  assert.equal(shortened.reportTruncated, false, "shortening the preamble is enough; no report was cut");
  assert.equal(shortened.movedHead, head, "the preamble is handed back so it can be kept as detail");
  assert.ok(shortened.text.includes(report) && shortened.text.includes(standIn) && shortened.text.includes(tail));
  assert.ok(shortened.text.length <= limit);

  const huge = reportOf("R3", 30000);
  const cut = fitJobResultText({ head, headStandIn: standIn, report: huge, tail }, limit);
  assert.equal(cut.reportTruncated, true);
  assert.ok(cut.text.length <= limit, `fitted ${cut.text.length}`);
  assert.ok(cut.text.includes(tail), "the lines after the report are kept");
  const kept = cut.text.slice(cut.text.indexOf("R3 START"), cut.text.indexOf("\n... [the agent's report was cut here"));
  assert.ok(huge.startsWith(kept) && kept.length > 15000, "what is kept of the report is its unbroken beginning");
  assert.doesNotMatch(cut.text, /the middle was truncated/);
  assert.equal(cut.chars, head.length + huge.length + tail.length + 2);

  // The compact stand-in itself is a small, fixed-shape block.
  const lines = compactJobLines({ resolution: { requestedAgent: "reviewer", actualAgent: "reviewer" }, result: { usage: USAGE, changedFiles: ["a", "b"], exitCode: 0, assistantFinalResponseDetected: true } });
  assert.ok(lines.length <= 10 && lines.join("\n").length < 700, lines.join("\n"));
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
    } finally {
      selfTestHooks.agentRuntimeTestHook = null;
    }
  }
} finally {
  for (const directory of [repo, stateDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
process.stdout.write(`sizes: ${JSON.stringify(sizes)}\n`);
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} L-025/L-026 regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} L-025/L-026 regression tests passed.\n`);
process.exit(0);
