#!/usr/bin/env node

// Regression tests for the second review's core/startup findings R-134, R-135, R-137 and R-138
// (R-136 is covered in bin/main-module.test.js). Each case names the finding it covers.
//   node tests/review2-a.js
// "--self-test" is added to process.argv before the import because server.js keys its
// test-mode guards (background timers, attestation cache TTL) on that flag.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strict as assert } from "node:assert";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
// R-173: importing the bridge must never touch the real state or cache directories. Both are
// read once at import, so they are pointed at a scratch directory first.
const scratch = mkdtempSync(path.join(tmpdir(), "codex-opencode-review2-a-"));
const importState = path.join(scratch, "import-state");
const importCache = path.join(scratch, "import-cache");
mkdirSync(importState, { recursive: true });
process.env.CODEX_OPENCODE_STATE_DIR = importState;
process.env.XDG_CACHE_HOME = importCache;
// "error" keeps the events these cases assert on and silences the rest.
process.env.CODEX_OPENCODE_LOG_LEVEL = "error";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
delete process.env.CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS;

const serverUrl = new URL("../server.js", import.meta.url);
const { __selfTest } = await import(serverUrl.href);
const hooks = __selfTest.hooks;
const {
  awaitBridgeStartupRecovery,
  beginBridgeStartupRecovery,
  persistPipelineRecord,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
  readUserLineEndingGitConfig,
  resolveProjectStateRoot,
  runCommand,
  server,
} = __selfTest.internals;

const stateDir = path.join(scratch, "state");
const repoInput = path.join(scratch, "repo");
mkdirSync(stateDir, { recursive: true });
mkdirSync(repoInput, { recursive: true });
hooks.stateDirectoryOverride = stateDir;
hooks.queueModeOverride = "sqlite";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => (server._registeredTools[name].handler || server._registeredTools[name].callback)(args, {});

function captureEvents() {
  const events = [];
  const original = console.error;
  console.error = (...args) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed?.event) {
        events.push(parsed);
        return;
      }
    } catch { /* Not a bridge event. */ }
    original(...args);
  };
  return { events, restore: () => { console.error = original; } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------- R-134
test("R-134: a rejected startup recovery is a failure, not a pass", async () => {
  const capture = captureEvents();
  let ran = 0;
  server.tool("review2a_startup_probe", "Review regression probe.", async () => {
    ran += 1;
    return { content: [{ type: "text", text: "ran" }] };
  });
  try {
    const recovery = beginBridgeStartupRecovery(async () => {
      throw Object.assign(new Error("recovery exploded C:\\secret\\path"), { errorType: "boom_type" });
    });
    // The process-level await in the startup path must not throw on a failed recovery.
    await recovery.then(() => {}, () => {});
    const outcome = await awaitBridgeStartupRecovery(2000);
    assert.equal(outcome.ok, false, "a rejected recovery must not report ok");
    assert.equal(outcome.failed, true, "the failure is distinguishable from a still-pending recovery");
    const rejected = await callTool("review2a_startup_probe", {});
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /errorType: startup_recovery_failed/);
    assert.doesNotMatch(textOf(rejected), /startup_recovery_pending/);
    assert.equal(ran, 0, "the tool handler must not run on unrecovered state");
    assert.ok(capture.events.some((event) => event.event === "state.startup_recovery_failed"), "the failure is still logged");
  } finally {
    capture.restore();
    hooks.bridgeStartupRecovery = null;
  }
  // A recovery that succeeds still lets calls through.
  await beginBridgeStartupRecovery(async () => {});
  assert.deepEqual(await awaitBridgeStartupRecovery(2000), { ok: true });
  assert.equal(textOf(await callTool("review2a_startup_probe", {})), "ran");
  assert.equal(ran, 1);
  hooks.bridgeStartupRecovery = null;
});

// ---------------------------------------------------------------------------- R-135
test("R-135: the system and global git config reads run in parallel under a short bound", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const execFile = async (file, args, options) => {
    const scope = args[1];
    calls.push({ file, scope, timeout: options.timeout, pattern: args[args.length - 1] });
    active += 1;
    maxActive = Math.max(maxActive, active);
    // The system read is the slower one: the global level must still win, as in Git.
    await sleep(scope === "--system" ? 120 : 30);
    active -= 1;
    return { stdout: scope === "--system"
      ? "core.autocrlf true\ncore.symlinks true\ncore.eol bogus\n"
      : "core.autocrlf false\n" };
  };
  const values = await readUserLineEndingGitConfig({ execFile });
  assert.deepEqual(calls.map((call) => call.scope).sort(), ["--global", "--system"]);
  assert.equal(maxActive, 2, "the two reads must overlap instead of running back to back");
  for (const call of calls) {
    assert.equal(call.file, "git");
    assert.equal(call.pattern, "^core\\.(autocrlf|eol|safecrlf|symlinks)$", "the key filter is unchanged");
  }
  // Two sequential 15 s reads used up the whole 30 s client startup deadline; the reads now
  // overlap, so one bound is also the worst case for both.
  for (const call of calls) assert.ok(call.timeout > 0 && call.timeout <= 10_000, `read timeout ${call.timeout} ms is not short`);
  assert.equal(values.get("core.autocrlf"), "false", "global overrides system");
  assert.equal(values.get("core.symlinks"), "true", "a system-only key is kept");
  assert.equal(values.has("core.eol"), false, "a value outside the allowed literals counts as unset");
});

test("R-135: a failed or missing git read leaves that level unset without failing the other", async () => {
  const execFile = async (file, args) => {
    if (args[1] === "--system") throw Object.assign(new Error("exit 1"), { stdout: "" });
    return { stdout: "core.autocrlf input\n" };
  };
  const values = await readUserLineEndingGitConfig({ execFile });
  assert.equal(values.get("core.autocrlf"), "input");
  const none = await readUserLineEndingGitConfig({ execFile: async () => { throw new Error("spawn git ENOENT"); } });
  assert.equal(none.size, 0);
});

// ---------------------------------------------------------------------------- R-137
test("R-137: an invalid numeric env value fails startup instead of silently using the default", async () => {
  const name = "REVIEW2A_NUMBER";
  try {
    for (const bad of ["foo", "0", "-3", "1.5", "NaN", "Infinity", "12abc"]) {
      process.env[name] = bad;
      assert.throws(() => readPositiveIntEnv(name, 7), new RegExp(`${name} must be`), `positive: ${bad}`);
    }
    for (const bad of ["foo", "-1", "1.5", "NaN", "Infinity"]) {
      process.env[name] = bad;
      assert.throws(() => readNonNegativeIntEnv(name, 7), new RegExp(`${name} must be`), `non-negative: ${bad}`);
    }
    // Unset, blank and whitespace keep the default; valid values are used.
    delete process.env[name];
    assert.equal(readPositiveIntEnv(name, 7), 7);
    for (const blank of ["", "   "]) {
      process.env[name] = blank;
      assert.equal(readPositiveIntEnv(name, 7), 7);
      assert.equal(readNonNegativeIntEnv(name, 9), 9);
    }
    process.env[name] = " 12 ";
    assert.equal(readPositiveIntEnv(name, 7), 12);
    process.env[name] = "0";
    assert.equal(readNonNegativeIntEnv(name, 9), 0);
    // A byte or count limit is not a timer: it may exceed 2^31 - 1.
    process.env[name] = "4294967296";
    assert.equal(readPositiveIntEnv(name, 7), 4294967296);
  } finally {
    delete process.env[name];
  }
});

test("R-137: a millisecond value that overflows setTimeout/setInterval is rejected", async () => {
  const name = "REVIEW2A_INTERVAL_MS";
  try {
    // Above 2^31 - 1 Node fires the timer after 1 ms: a progress heartbeat every millisecond.
    process.env[name] = "2147483648";
    assert.throws(() => readNonNegativeIntEnv(name, 30_000), new RegExp(`${name} must be`));
    assert.throws(() => readPositiveIntEnv(name, 30_000), new RegExp(`${name} must be`));
    process.env[name] = "2147483647";
    assert.equal(readNonNegativeIntEnv(name, 30_000), 2147483647);
    assert.equal(readPositiveIntEnv(name, 30_000), 2147483647);
    process.env[name] = "0";
    assert.equal(readNonNegativeIntEnv(name, 30_000), 0, "0 still disables an interval");
  } finally {
    delete process.env[name];
  }
});

function importServerWith(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(serverUrl.href)}); process.exit(0);`], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...env,
      CODEX_OPENCODE_STATE_DIR: importState,
      XDG_CACHE_HOME: importCache,
    },
  });
  return result;
}

test("R-137: the bridge refuses to start on an invalid numeric config value", async () => {
  const control = importServerWith({});
  assert.equal(control.status, 0, `an unmodified environment must import cleanly: ${control.stderr}`);
  const concurrency = importServerWith({ CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: "foo" });
  assert.notEqual(concurrency.status, 0, "CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT=foo must fail startup");
  assert.match(concurrency.stderr, /CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT must be/);
  const overflow = importServerWith({ CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS: "2147483648" });
  assert.notEqual(overflow.status, 0, "an overflowing progress interval must fail startup");
  assert.match(overflow.stderr, /CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS must be/);
});

// ---------------------------------------------------------------------------- R-138
const gitOk = async (args, cwd) => {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
};
let repo = "";
async function seedPipelines({ terminal, running }) {
  if (!repo) {
    await gitOk(["init", "-q"], repoInput);
    repo = await resolveProjectStateRoot(repoInput);
  }
  const base = Date.UTC(2026, 0, 1);
  let index = 0;
  const make = (status, label) => {
    const at = new Date(base + index * 1000).toISOString();
    const pipelineId = `review2a-${label}-${String(index).padStart(3, "0")}`;
    index += 1;
    return {
      pipelineId, name: pipelineId, cwd: repo, status, createdAt: at, updatedAt: at,
      jobs: [], queueJobIds: [], expectedChildCount: 0, integrationQueue: [], events: [], errors: [],
      finalValidationCommand: "", finalValidationSource: "none", finalValidationSpec: null, finalValidationResult: null,
      reviewerJob: null, testerJob: null, reviewerResult: null, testerResult: null, sourceCleanupResults: [],
      policy: null, finishedAt: status === "completed" ? at : "",
    };
  };
  const records = [];
  for (let i = 0; i < running; i += 1) records.push(make("awaiting_integration", "open"));
  for (let i = 0; i < terminal; i += 1) records.push(make("completed", "done"));
  for (const record of records) await persistPipelineRecord(record);
  return records;
}

test("R-138: list_multi_agent_pipelines pages its output and keeps the total", async () => {
  await seedPipelines({ terminal: 35, running: 2 });
  const listed = textOf(await callTool("list_multi_agent_pipelines", { cwd: repo }));
  assert.match(listed, /^Pipelines: 37 \(showing the newest 20\)\n/, listed.slice(0, 200));
  const shown = JSON.parse(listed.slice(listed.indexOf("\n") + 1));
  assert.equal(shown.length, 20);
  const times = shown.map((item) => item.createdAt);
  assert.deepEqual(times, [...times].sort().reverse(), "newest first");
  const limited = textOf(await callTool("list_multi_agent_pipelines", { cwd: repo, limit: 5 }));
  assert.match(limited, /^Pipelines: 37 \(showing the newest 5\)\n/);
  assert.equal(JSON.parse(limited.slice(limited.indexOf("\n") + 1)).length, 5);
  const everything = textOf(await callTool("list_multi_agent_pipelines", { cwd: repo, limit: 200 }));
  assert.match(everything, /^Pipelines: 37\n/, "no paging note when everything is shown");
  assert.equal(JSON.parse(everything.slice(everything.indexOf("\n") + 1)).length, 37);
  const filtered = textOf(await callTool("list_multi_agent_pipelines", { cwd: repo, status: "awaiting_integration" }));
  assert.match(filtered, /^Pipelines: 2\n/);
});

test("R-138: diagnose_opencode_bridge bounds the pipeline detail, keeps every open pipeline and full counts", async () => {
  const report = JSON.parse(textOf(await callTool("diagnose_opencode_bridge", { cwd: repo })));
  assert.equal(report.summary.pipelines, 37, "the summary counts every pipeline");
  assert.equal(report.summary.nonterminalPipelines, 2);
  const open = report.pipelines.filter((item) => item.status === "awaiting_integration");
  assert.equal(open.length, 2, "every unfinished pipeline is listed");
  const finished = report.pipelines.filter((item) => item.status === "completed");
  assert.equal(finished.length, 25, "only the most recent finished pipelines are listed");
  assert.equal(report.pipelines.length, 27);
  assert.deepEqual(finished.map((item) => item.pipelineId).sort().slice(-1), ["review2a-done-036"], "the newest finished pipeline is kept");
  assert.equal(finished.some((item) => item.pipelineId === "review2a-done-002"), false, "an old finished pipeline is dropped");
  assert.match(report.diagnosticCoverage.detail, /pipelines/);
});

// ------------------------------------------------------------------------------------------
let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${String(error?.stack || error).split("\n").slice(0, 8).join("\n")}\n`);
    }
  }
} finally {
  hooks.bridgeStartupRecovery = null;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} review2-a regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} review2-a regression tests passed.\n`);
process.exit(0);
