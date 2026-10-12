#!/usr/bin/env node
// F2 bounds and queue polling cost. Git/SQLite are real; the agent is a fixture.
import "./test-env.js";
import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { registerParallelTool } from "../lib/tools/parallel.js";
import { buildSingleResultViews, compactFileList, createResultFormatRuntime } from "../lib/result-format.js";
import { registerIntegrationTools } from "../lib/tools/integration.js";
import { createParallelPlanRuntime } from "../lib/parallel-plan.js";
import { createLockRuntime } from "../lib/locks.js";
import { randomUUID } from "node:crypto";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "6";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const { hooks, internals: i } = __selfTest;
const baseline = process.argv.includes("--baseline");
const root = await i.mkdtemp(i.path.join(i.tmpdir(), "f2-results-"));
const repo = i.path.join(root, "repo");
await i.mkdir(repo);
hooks.stateDirectoryOverride = i.path.join(root, "state");
hooks.queueModeOverride = "sqlite";
const git = async (...args) => {
  const result = await i.runCommand("git", args, repo, 60_000);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};
await git("init", "-q");
await i.writeFile(i.path.join(repo, "a.txt"), "base\n");
await git("add", "a.txt");
await git("-c", "user.name=F2 Test", "-c", "user.email=f2@example.invalid", "commit", "-qm", "base");
const tool = (name, args) => i.server._registeredTools[name].handler(args, { signal: new AbortController().signal });
const text = result => result.content.map(item => item.text || "").join("\n");
const report = "REPORT START\n" + "r".repeat(131_072 - 25) + "\nREPORT END";
let writer = false;
hooks.agentRuntimeTestHook = {
  resolveAgent: async requestedAgent => ({ requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary", fallbackUsed: false, proxyUsed: false, availableAgents: [requestedAgent], discoveryExitCode: 0 }),
  readAgentDebugMetadata: async agent => ({ ok: true, metadata: { name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high", canEdit: agent === "builder", canDelegate: false, externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}` } }),
  runOpenCodeWithPolicy: async (agent, prompt, cwd) => {
    if (writer) await i.writeFile(i.path.join(cwd, "a.txt"), Array.from({ length: 2000 }, (_, n) => `line ${n} ${"p".repeat(40)}`).join("\n"));
    return { exitCode: 0, stdout: report, stderr: "", errorType: null, durationMs: 1, assistantFinalResponseDetected: true, modelAttested: true, childExecutionIntervals: [], childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1, configuredProvider: "fixture", configuredModel: "model-a" };
  },
};
const measurements = {};
let passed = 0;
try {
  writer = true;
  const direct = text(await tool("run_opencode_agent", { agent: "builder", task: "Write fixture.", cwd: repo, write: true, lockMode: "simple", lockedPaths: ["a.txt"], allowedEdits: ["a.txt"], scopeContract: { mode: "write", read: ["a.txt"], write: ["a.txt"], allowedEdits: ["a.txt"], forbidden: [], shared: [], serialOnly: [], validationCommand: "" } }));
  measurements.directWriterChars = direct.length;
  measurements.directWriterBytes = Buffer.byteLength(direct);
  if (!direct.includes("REPORT START")) console.log("Writer fixture refusal: " + direct);
  if (!baseline) {
    assert.ok(direct.length <= i.CONFIG.queueResultMaxChars, direct.length);
    assert.match(direct, /Run id:/); assert.match(direct, /Temporary lock released:/);
    assert.ok(direct.split("Assistant final response:\n")[1].split("\n... [the agent's report was cut here")[0].length > 20_000, "the report gets the room otherwise spent on the patch");
    assert.doesNotMatch(direct, /Worktree patch preview:\ndiff --git/);
    passed++;
  }
  if (!baseline) {
    const runId = /Run id: (\S+)/.exec(direct)[1];
    const stored = JSON.parse(text(await tool("get_opencode_job", { cwd: repo, jobId: runId })));
    assert.equal(stored.resultDetailTextTruncated, true);
    assert.match(stored.note, /detail was (cut|dropped)/);
    assert.doesNotMatch(stored.resultText, /returns the full bridge block|returns the stored preview/);
    passed++;
  }
  if (!baseline) {
    const detailed = text(await tool("run_opencode_agent", { agent: "builder", task: "Write detailed fixture.", cwd: repo, write: true, lockMode: "simple", lockedPaths: ["a.txt"], allowedEdits: ["a.txt"],
      scopeContract: { mode: "write", read: ["a.txt"], write: ["a.txt"], allowedEdits: ["a.txt"], forbidden: [], shared: [], serialOnly: [], validationCommand: "" }, detail: true }));
    measurements.directWriterDetailChars = detailed.length;
    assert.ok(detailed.length <= 24000);
    assert.match(detailed, /REPORT START/);
    passed++;
  }
  writer = false;
  const parallel = text(await tool("run_opencode_parallel", { jobs: Array.from({ length: 6 }, () => ({ agent: "reviewer", task: "Review fixture.", cwd: repo, write: false, lockMode: "off" })) }));
  measurements.parallel6Chars = parallel.length;
  measurements.parallel6Bytes = Buffer.byteLength(parallel);
  if (!baseline) { assert.ok(parallel.length <= 60_000, parallel.length); assert.equal([...parallel.matchAll(/Run id:/g)].length, 6); passed++; }
  if (!baseline) {
    const detailed = text(await tool("run_opencode_parallel", { jobs: Array.from({ length: 6 }, () => ({ agent: "reviewer", task: "Detailed review fixture.", cwd: repo, write: false, lockMode: "off" })), detail: true }));
    measurements.parallel6DetailChars = detailed.length;
    assert.ok(detailed.length <= 60000);
    assert.equal([...detailed.matchAll(/Run id:/g)].length, 6);
    passed++;
  }
  const dirtyFiles = Array.from({ length: 500 }, (_, n) => `dirty/${String(n).padStart(4, "0")}-${"x".repeat(25)}.txt`);
  const refusal = i.formatRejectedExecution({ dirtyFiles, conflictingPaths: dirtyFiles, disjointFiles: dirtyFiles });
  measurements.refusal500Chars = refusal.length;
  measurements.refusal500Bytes = Buffer.byteLength(refusal);
  if (!baseline) { assert.match(refusal, /\(\+460 more\)/); assert.ok(refusal.length < 10_000); passed++; }
  const changedFiles = Array.from({ length: 2000 }, (_, n) => `src/path-${String(n).padStart(4, "0")}-${"x".repeat(8)}.js`);
  const line = i.compactQueueJobLines([{ jobId: "writer-fixture", mode: "write", status: "completed", changedFiles }]);
  measurements.queue2000Chars = line.length;
  measurements.queue2000Bytes = Buffer.byteLength(line);
  if (!baseline) { assert.match(line, /\(\+1960 more\)/); assert.ok(line.length < 2000); passed++; }
  if (!baseline) {
    const previous = hooks.queueModeOverride;
    hooks.queueModeOverride = "memory";
    const record = { jobId: "memory-detail-fixture", cwd: repo, status: "completed", agent: "reviewer", mode: "read", changedFiles,
      resultText: "Run id: fixture (get_opencode_job with detail: true returns the full bridge block)", resultDetailText: "d".repeat(24001) };
    i.QUEUE_JOBS.set(record.jobId, record);
    try {
      const view = JSON.parse(text(await tool("get_opencode_job", { cwd: repo, jobId: record.jobId })));
      assert.equal(view.changedFiles.length, 40);
      assert.equal(view.changedFilesOmitted, 1960);
      assert.equal(view.resultDetailTextTruncated, true);
      assert.doesNotMatch(view.resultText, /returns the full bridge block/);
      assert.match(view.omitted, /detail was cut or dropped/);
      const detail = JSON.parse(text(await tool("get_opencode_job", { cwd: repo, jobId: record.jobId, detail: true })));
      assert.equal(detail.changedFiles.length, 2000);
      assert.equal(detail.resultDetailText.length, 24000);
      passed++;
    } finally { hooks.queueModeOverride = previous; i.QUEUE_JOBS.delete(record.jobId); }
  }
  const paths = Array.from({ length: 3000 }, (_, n) => `src/${String(n).padStart(4, "0")}-${"x".repeat(86)}.js`);
  const shortReport = "Assistant final response:\nREPORT START\ncritical findings\nREPORT END";
  const fitted = i.fitJobResultText({ head: "Run id: short-fixture", report: shortReport, tail: `Worktree changed files: ${paths.join(", ")}` });
  measurements.paths3000FittedChars = fitted.text.length;
  measurements.paths3000ReportTruncated = fitted.reportTruncated;
  if (!baseline) { assert.ok(fitted.text.includes(shortReport)); assert.equal(fitted.reportTruncated, false); passed++; }
  if (!baseline) {
    const compactReview = `Worktree changed files: ${compactFileList(paths)}`;
    const views = buildSingleResultViews({ runId: "paths-fixture", compactLines: [`Files changed: ${compactFileList(paths)}`],
      singleParts: { preamble: "", report: shortReport, stderr: "" }, hasWorktree: true,
      worktreeReview: `Worktree changed files: ${paths.join(", ")}`, compactWorktreeReview: compactReview, worktreeReviewWithoutPatch: compactReview });
    measurements.paths3000CompactChars = views.compact.length;
    assert.ok(views.compact.length <= 24000);
    assert.match(views.compact, /\(\+2960 more\)/);
    assert.ok(!views.compact.includes(paths[40]));
    assert.ok(views.detailText.includes(paths.at(-1)));
    const formatter = registerIntegrationTools({ server: { tool: () => {} } });
    const integration = formatter.formatIntegrationBatchSummary({ batchItems: [{ index: 1, source: "fixture", changedFiles: paths, patchSha256: "a".repeat(64) }] }, [paths]);
    const summary = integration.itemLines.join("\n") + "\n" + integration.scopeLine;
    measurements.integration3000SummaryChars = summary.length;
    assert.ok(summary.length <= 24000);
    assert.match(summary, /\(\+2960 more\)/);
    assert.ok(!summary.includes(paths[40]));
    passed++;
  }
  const detail = i.queueRecordSnapshot({ jobId: "detail-fixture", status: "failed", resultDetailText: "d".repeat(24_001) });
  measurements.detail24001StoredChars = detail.resultDetailText.length;
  if (!baseline) { assert.ok(detail.resultDetailText.length <= 24_000); passed++; }
  if (!baseline) {
    let registered;
    let scenario = "snapshot";
    const { hardLockSummary, hardLockPathsForPlan } = createLockRuntime({ CONFIG: i.CONFIG });
    registerParallelTool(new Proxy({ ...i, compactFileList,
      hardLockSummary, hardLockPathsForPlan,
      labelParallelRunId: createParallelPlanRuntime({ CONFIG: i.CONFIG }).labelParallelRunId,
      fitRedactedJobResult: createResultFormatRuntime({ CONFIG: i.CONFIG }).fitRedactedJobResult,
      server: { tool: (...args) => { registered = args.at(-1); } },
      jobAgentRuntime: () => hooks.agentRuntimeTestHook,
      normalizeJobCwd: async job => job,
      nowMs: Date.now,
      captureGitHead: () => git("rev-parse", "HEAD"),
      makeQueueJobId: () => `reviewer-${randomUUID()}`,
      agentMetadataPolicyOptions: () => ({}),
      sanitizedDiscoveryContext: () => ({ forcePure: false, discoveryCwd: repo }),
      sanitizedRoutingPolicyError: () => null,
      parallelGroupScopeReport: async ({ cwdKey, results, expectedHead }) => {
        if (scenario === "snapshot") throw Object.assign(new Error("fixture group snapshot failure"), { errorType: "parallel_group_snapshot_failed" });
        if (scenario === "head") results[0].result.errorType = "repository_head_changed_during_execution";
        if (scenario === "lock") results[0].result.changedFiles = ["outside.txt"];
        return { cwd: cwdKey, headChanged: scenario === "head", expectedHead, actualHead: scenario === "head" ? "moved-fixture-head" : expectedHead,
          changedFiles: [], disallowedFiles: scenario === "scope" ? ["outside.txt"] : [], serialOnlyMatches: [], externalDriftFiles: [],
          rollback: scenario === "scope" ? "not_attempted_unattributed_changes" : "not_needed", rollbackFiles: [], unresolvedFiles: [] };
      },
    }, { get: (object, key) => object[key] ?? (() => { throw new Error(`Missing F2 fixture dependency: ${String(key)}`); }) }));
    for (const [name, errorType] of [["snapshot", "parallel_group_snapshot_failed"], ["head", "repository_head_changed_during_execution"], ["scope", "parallel_group_scope_violation"], ["lock", "parallel_lock_violation"]]) {
      scenario = name;
      const answer = text(await registered({ jobs: [{ agent: "reviewer", task: "Group fixture.", cwd: repo, write: false, lockMode: "off" }] }));
      assert.ok(answer.includes(`Group check: rejected; error type: ${errorType}`));
      const runId = /Run id: (\S+)/.exec(answer)?.[1];
      const stored = JSON.parse(text(await tool("get_opencode_job", { cwd: repo, jobId: runId })));
      assert.equal(stored.status, "rejected");
      assert.equal(stored.errorType, errorType);
      assert.match(stored.resultText, /Group check: rejected/);
      passed++;
    }
    const missing = text(await tool("get_opencode_job", { cwd: repo, jobId: "unknown-fixture-id" }));
    assert.match(missing, /errorType: job_not_found/);
    assert.match(missing, /suggestedFix:/);
    passed++;
  }
  const db = await i.openLockDb(repo);
  try {
    // Similar row width to the ledger fixture; encrypted request text is deliberately unused.
    const insert = db.prepare("INSERT INTO opencode_jobs (job_id, agent, cwd, mode, status, created_at, record_json, request_encrypted, result_encrypted) VALUES (?, ?, ?, 'read', ?, ?, ?, ?, ?)");
    const sealedFixture = "x".repeat(10612);
    const seed = (first, end) => {
      db.exec("BEGIN");
      for (let n = first; n < end; n++) {
        const record = { jobId: `poll-${n}`, agent: "reviewer", cwd: repo, mode: "read", status: "completed", createdAt: new Date(1_700_000_000_000 + n).toISOString(), fixturePadding: "x".repeat(3700) };
        insert.run(record.jobId, record.agent, repo, record.status, record.createdAt, JSON.stringify(record), "unused".repeat(62), sealedFixture);
      }
      db.exec("COMMIT");
    };
    const measure = async count => {
      if (global.gc) global.gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const answer = text(await tool("list_opencode_jobs", { cwd: repo }));
      measurements[`list${count}Ms`] = +(performance.now() - started).toFixed(2);
      measurements[`list${count}HeapDeltaMb`] = +((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2);
      assert.match(answer, new RegExp(`Jobs: ${count}`));
    };
    seed(0, 50); await measure(50);
    const smallDiagnosisStarted = performance.now();
    const smallDiagnosis = JSON.parse(text(await tool("diagnose_opencode_bridge", { cwd: repo })));
    measurements.diagnose50Ms = +(performance.now() - smallDiagnosisStarted).toFixed(2);
    assert.equal(smallDiagnosis.summary.jobs, 50);
    seed(50, 50_000); await measure(50_000);
    if (!baseline) {
      const plans = [
        ["SELECT record_json FROM opencode_jobs ORDER BY created_at DESC LIMIT 20", "opencode_jobs_created_idx"],
        ["SELECT record_json FROM opencode_jobs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 20", "opencode_jobs_status_created_idx"],
        ["SELECT record_json FROM opencode_jobs INDEXED BY opencode_jobs_created_idx WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted', 'not_resumable') ORDER BY created_at DESC LIMIT 25", "opencode_jobs_created_idx"],
        ["SELECT job_id FROM opencode_jobs WHERE result_encrypted IS NULL OR result_encrypted = ''", "opencode_jobs_unsealed_idx"],
      ];
      for (const [sql, index] of plans) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
        assert.ok(plan.some(row => row.detail.includes(index)), index);
        assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)), sql);
      }
      const filtered = text(await tool("list_opencode_jobs", { cwd: repo, status: "completed", limit: 3 }));
      assert.match(filtered, /Jobs: 50000 \(showing the newest 3\)/);
      assert.match(filtered, /poll-49999/);
      assert.ok(!filtered.includes("poll-49996"));
      db.prepare("UPDATE opencode_jobs SET status = 'failed', record_json = '{broken old fixture' WHERE job_id = 'poll-0'").run();
      passed++;
    }
    for (let n = 0; n < 30; n++) {
      const record = { jobId: `unfinished-${n}`, agent: "reviewer", cwd: repo, status: "pending", createdAt: "2020-01-01T00:00:00.000Z" };
      insert.run(record.jobId, record.agent, repo, record.status, record.createdAt, JSON.stringify(record), "unused", sealedFixture);
    }
    const started = performance.now();
    const diagnosis = JSON.parse(text(await tool("diagnose_opencode_bridge", { cwd: repo })));
    measurements.diagnose50000Ms = +(performance.now() - started).toFixed(2);
    assert.equal(diagnosis.summary.jobs, 50_030);
    assert.equal(diagnosis.summary.nonterminalJobs, 30);
    if (!baseline) assert.equal(diagnosis.summary.failedJobs, 1, "the failed count includes an old row outside the detail page");
    assert.equal(diagnosis.jobs.filter(job => job.status === "pending").length, 30);
    assert.equal(diagnosis.jobs.length, 55);
    passed++;
  } finally { i.closeDb(db); }
  console.log("F2 measurements: " + JSON.stringify(measurements));
  console.log(`${passed}/${baseline ? passed : 18} F2 regression checks passed.`);
} finally {
  hooks.agentRuntimeTestHook = null;
  await i.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
