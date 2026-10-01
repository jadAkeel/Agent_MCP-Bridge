#!/usr/bin/env node

// Regression tests for B-042..B-046 (log.md, 2026-10-01), found while running 10-20 parallel
// builder jobs: a queue limit that silently capped the provider limit, a 504 "Upstream idle
// timeout" reported as an unclassified API error, a timed-out writer that hid its changed files,
// no free-memory floor for the queue, and no idle detection for a stalled agent.
//   node tests/review-round5.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
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

let failed = 0;
const skips = [];
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
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
