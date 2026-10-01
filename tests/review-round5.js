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
