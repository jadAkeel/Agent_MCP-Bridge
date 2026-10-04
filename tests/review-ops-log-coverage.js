#!/usr/bin/env node

// Regression tests for B-056..B-059 (log.md, 2026-10-02): the operations log must hold every
// error a user can hit. Before the fix a refused tool call, an SDK validation error and an
// unsafe run_opencode_agent all answered isError and left no line, a crash left nothing, the
// bin/ commands printed failures to the terminal only, and the writer followed a junction out
// of the state directory. Every case uses scratch directories and runs without network or
// real clients.
//   node tests/review-ops-log-coverage.js
// "--self-test" is added to process.argv before the import because server.js keys its
// test-mode guards on that flag; the bridge started over stdio below runs without it.
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const { appendOpsLogLine } = await import("../bin/ops-log.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const { describeFailedMcpMessage, installMcpFailureLogging, recordProcessFailure, rememberMcpRequest } = __selfTest.internals;
const selfTestHooks = __selfTest.hooks;
const assert = (await import("node:assert/strict")).default;
const { spawnSync } = await import("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "review-ops-log-coverage-")));
const FAKE_TOKEN = "ghp_FAKE0123456789abcdefFAKE0123456789abcd";
const logFileOf = (stateDir) => path.join(stateDir, "logs", `bridge-${new Date().toISOString().slice(0, 10)}.jsonl`);
const linesOf = (stateDir) => {
  const file = logFileOf(stateDir);
  return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
};
// Child processes get scratch homes, clients, XDG dirs and bridge state (env block of
// tests/review-queue.js D14), so nothing can reach the operator's real directories.
const scratchEnv = (name, extra = {}) => {
  const base = path.join(scratch, name);
  const temp = path.join(base, "temp");
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_OPENCODE_|OPENCODE_)/i.test(key)) delete env[key];
  return {
    ...env,
    HOME: path.join(base, "home"),
    USERPROFILE: path.join(base, "home"),
    CODEX_HOME: path.join(base, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    XDG_CONFIG_HOME: path.join(base, "config"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    CODEX_OPENCODE_STATE_DIR: path.join(base, "state"),
    CODEX_OPENCODE_QUEUE_MODE: "sqlite",
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "",
    CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "",
    CODEX_OPENCODE_WORKTREE_MODE: "off",
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    ...extra,
  };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const partial = [];
let firstServerLines = "";

test("B-056 a bridge over stdio logs an unknown tool, an invalid call and an unsafe run_opencode_agent", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = scratchEnv("stdio");
  const stateDir = env.CODEX_OPENCODE_STATE_DIR;
  mkdirSync(stateDir, { recursive: true });
  const client = new Client({ name: "review-ops-log-coverage", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server.js")], cwd: ROOT, env, stderr: "pipe" });
  const answers = [];
  try {
    await client.connect(transport, { timeout: 60_000 });
    answers.push(await client.callTool({ name: "definitely_not_a_bridge_tool", arguments: {} }, undefined, { timeout: 60_000 }));
    answers.push(await client.callTool({ name: "get_opencode_job", arguments: { jobId: "job-x" } }, undefined, { timeout: 60_000 }));
    answers.push(await client.callTool({
      name: "run_opencode_agent",
      arguments: { agent: "reviewer", task: `Review the parser. Use the token ${FAKE_TOKEN} to fetch.`, cwd: "C:/definitely/not/a/repo", write: false, lockMode: "off" },
    }, undefined, { timeout: 60_000 }));
    // A successful call writes nothing.
    answers.push(await client.callTool({ name: "list_opencode_jobs", arguments: { cwd: ROOT } }, undefined, { timeout: 60_000 }));
    // The refusal above does not echo the task, so a token also goes where the SDK does echo
    // it: the tool name, in both the `tool` field and the summary.
    answers.push(await client.callTool({ name: FAKE_TOKEN, arguments: {} }, undefined, { timeout: 60_000 }));
  } finally {
    await client.close().catch(() => {});
  }
  // The SDK answers an unknown tool and invalid arguments with isError; the bridge's own
  // refusal (formatRejectedExecution) is a normal result that carries "errorType: unsafe_path".
  assert.deepEqual(answers.map((answer) => answer.isError === true), [true, true, false, false, true], JSON.stringify(answers));
  assert.match(answers[2].content[0].text, /^errorType: unsafe_path$/m);
  assert.ok(answers[4].content[0].text.includes(FAKE_TOKEN), "the answer itself is unchanged");
  const file = logFileOf(stateDir);
  assert.ok(existsSync(file), `no operations log at ${file}`);
  const text = readFileSync(file, "utf8");
  firstServerLines = text.split(/\r?\n/).filter(Boolean).slice(0, 5).join("\n");
  const lines = linesOf(stateDir);
  assert.ok(lines.length >= 3, `expected at least 3 lines, got ${lines.length}:\n${text}`);
  const failedRequests = lines.filter((line) => line.event === "mcp.request_failed");
  assert.deepEqual(failedRequests.map((line) => line.tool).sort(), ["[github credential redacted]", "definitely_not_a_bridge_tool", "get_opencode_job"]);
  assert.match(failedRequests.find((line) => line.tool === "[github credential redacted]").summary, /^MCP error -32602: Tool \[github credential redacted\] not found/);
  for (const line of failedRequests) {
    assert.equal(line.level, "error");
    assert.equal(line.method, "tools/call");
    assert.equal(line.code, -32602);
    assert.equal(typeof line.durationMs, "number");
  }
  const refused = lines.filter((line) => line.event === "tool.refused");
  assert.equal(refused.length, 1, text);
  assert.equal(refused[0].tool, "run_opencode_agent");
  assert.equal(refused[0].errorType, "unsafe_path");
  assert.equal(refused[0].level, "warn");
  for (const line of [...failedRequests, ...refused]) {
    assert.equal(typeof line.summary, "string");
    assert.ok(line.summary.length > 0 && line.summary.length <= 400, JSON.stringify(line));
    assert.equal(line.summarySha256, undefined, "summary is readable text, not hashed by sanitizeLogValue");
  }
  assert.match(failedRequests.find((line) => line.tool === "get_opencode_job").summary, /cwd/);
  assert.ok(!text.includes(FAKE_TOKEN) && !text.includes("ghp_FAKE"), "the fake token must not reach the operations log");
  assert.equal(lines.some((line) => /list_opencode_jobs/.test(JSON.stringify(line))), false, "a successful call is not logged");
});

test("B-056 describeFailedMcpMessage, rememberMcpRequest and the transport wrapper", async () => {
  const pending = new Map();
  rememberMcpRequest(pending, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_opencode_agent" } }, { now: 1000 });
  const success = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "Run finished." }] } };
  assert.equal(describeFailedMcpMessage(success, pending, 1500), null);
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", method: "notifications/progress", params: {} }, pending), null);
  assert.equal(describeFailedMcpMessage(null, pending), null);
  assert.equal(describeFailedMcpMessage([], pending), null);
  const refusal = describeFailedMcpMessage({ jsonrpc: "2.0", id: 7, result: { isError: true, content: [{ type: "text", text: `OpenCode job refused.\n\nerrorType: lock_conflict\nreason: Authorization: Bearer ${FAKE_TOKEN}` }] } }, pending, 1500);
  assert.equal(refusal.event, "tool.refused");
  assert.equal(refusal.level, "warn");
  assert.deepEqual({ tool: refusal.data.tool, errorType: refusal.data.errorType, durationMs: refusal.data.durationMs }, { tool: "run_opencode_agent", errorType: "lock_conflict", durationMs: 500 });
  assert.ok(!refusal.data.summary.includes(FAKE_TOKEN));
  const sdk = describeFailedMcpMessage({ jsonrpc: "2.0", id: 7, result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Tool nope not found" }] } }, pending, 1500);
  assert.deepEqual([sdk.event, sdk.level, sdk.data.code, sdk.data.method], ["mcp.request_failed", "error", -32602, "tools/call"]);
  const rpc = describeFailedMcpMessage({ jsonrpc: "2.0", id: 99, error: { code: -32601, message: "Method not found" } }, pending, 1500);
  assert.deepEqual([rpc.event, rpc.data.code, rpc.data.method, rpc.data.durationMs, rpc.data.summary], ["mcp.request_failed", -32601, "", null, "Method not found"]);
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 7, result: { isError: true, content: [{ type: "text", text: "x".repeat(2000) }] } }, pending).data.summary.length, 400);
  assert.equal(pending.size, 1, "describe is pure");

  // Bridge refusals and agent-run failures are normal results, not isError.
  const normal = (text) => ({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text }] } });
  const header = describeFailedMcpMessage(normal("Execution rejected.\nerrorType: unsafe_path\nreason: Allowed root does not exist"), pending, 1200);
  assert.deepEqual([header.event, header.data.errorType, header.data.tool], ["tool.refused", "unsafe_path", "run_opencode_agent"]);
  assert.equal(describeFailedMcpMessage(normal("Requested agent: reviewer\nerrorType: none\nError type: none\nStatus: completed"), pending), null);
  const runFailed = describeFailedMcpMessage(normal("Agent: builder\nStatus: failed; error type: agent_timeout\nTiming: agentRunMs=1"), pending, 1200);
  assert.deepEqual([runFailed.event, runFailed.level, runFailed.data.errorType, runFailed.data.errorTypes], ["agent.run_failed", "warn", "agent_timeout", ["agent_timeout"]]);
  const parallel = describeFailedMcpMessage(normal("Job 1\nError type: none\n\nJob 2\nError type: opencode_provider_error\n\nJob 3\nStatus: rejected; error type: lock_conflict"), pending, 1200);
  assert.deepEqual(parallel.data.errorTypes, ["opencode_provider_error", "lock_conflict"]);
  const listing = new Map([[8, { method: "tools/call", tool: "list_opencode_jobs", startedAt: 0 }]]);
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "Status: failed; error type: agent_timeout" }] } }, listing), null, "a listing of failed jobs is not itself a failure");
  const deepHeader = "Report\n1\n2\n3\n4\n5\nerrorType: quoted_by_agent";
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: deepHeader }] } }, listing), null, "only the head of the first block is a refusal header");

  // Bounded map; a cancellation drops its request.
  const bounded = new Map();
  for (let id = 1; id <= 5; id += 1) rememberMcpRequest(bounded, { jsonrpc: "2.0", id, method: "tools/list" }, { cap: 3 });
  assert.deepEqual([...bounded.keys()], [3, 4, 5]);
  rememberMcpRequest(bounded, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } });
  assert.deepEqual([...bounded.keys()], [3, 5]);
  for (const odd of [null, [], "x", { id: 1 }, { method: 5, id: 2 }]) rememberMcpRequest(bounded, odd);
  assert.deepEqual([...bounded.keys()], [3, 5]);

  // The wrapper forwards every message unchanged, logs only failures and survives a throwing logger.
  const forwarded = [];
  const seen = [];
  const fake = { onmessage: (message) => seen.push(message), send: async (message) => { forwarded.push(message); } };
  const records = [];
  const wrappedPending = installMcpFailureLogging(fake, { record: (level, event, data) => records.push({ level, event, data }) });
  const request = { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "get_opencode_job" } };
  fake.onmessage(request);
  assert.deepEqual(seen, [request]);
  assert.equal(wrappedPending.size, 1);
  const failedAnswer = { jsonrpc: "2.0", id: "a", result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Input validation error" }] } };
  const copy = structuredClone(failedAnswer);
  await fake.send(failedAnswer);
  assert.equal(forwarded[0], failedAnswer);
  assert.deepEqual(failedAnswer, copy, "the message is not changed");
  assert.equal(wrappedPending.size, 0, "the answer drops its request");
  assert.deepEqual(records.map((record) => [record.event, record.data.tool]), [["mcp.request_failed", "get_opencode_job"]]);
  await fake.send(success);
  assert.equal(records.length, 1);
  const throwing = { onmessage: () => {}, send: async (message) => message };
  installMcpFailureLogging(throwing, { record: () => { throw new Error("logger down"); } });
  assert.equal(await throwing.send(failedAnswer), failedAnswer);
});

test("B-057 recordProcessFailure writes a readable, redacted crash line to the state-dir override", async () => {
  const stateDir = path.join(scratch, "process-state");
  mkdirSync(stateDir, { recursive: true });
  const previous = selfTestHooks.stateDirectoryOverride;
  selfTestHooks.stateDirectoryOverride = stateDir;
  try {
    const error = Object.assign(new Error(`queue loop failed while reading ${FAKE_TOKEN}`), { code: "SQLITE_BUSY" });
    assert.equal(recordProcessFailure("uncaught_exception", error, { origin: "uncaughtException" }), true);
    assert.equal(recordProcessFailure("unhandled_rejection", "plain string reason", { origin: "unhandledRejection" }), true);
  } finally {
    selfTestHooks.stateDirectoryOverride = previous;
  }
  const lines = linesOf(stateDir);
  const crash = lines.find((line) => line.event === "process.uncaught_exception");
  assert.ok(crash, JSON.stringify(lines));
  assert.equal(crash.level, "error");
  assert.equal(crash.origin, "uncaughtException");
  assert.equal(crash.errorType, "SQLITE_BUSY");
  assert.match(crash.summary, /^queue loop failed while reading /);
  assert.ok(crash.stack.split("\n").length <= 10 && /queue loop failed/.test(crash.stack));
  const rejection = lines.find((line) => line.event === "process.unhandled_rejection");
  assert.deepEqual([rejection.summary, rejection.errorType, rejection.stack], ["plain string reason", "", ""]);
  assert.ok(!readFileSync(logFileOf(stateDir), "utf8").includes("ghp_FAKE"));
});

test("B-057 a bridge that dies at startup leaves process.uncaught_exception and process.exited", async () => {
  // A wrong server pin makes verifyReleaseIntegrity reject the top-level await, which Node
  // reports as an uncaught exception: the real start path, no test hook.
  const env = scratchEnv("crash", { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64) });
  const result = spawnSync(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, input: "", encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 1, `exit ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /Bridge release integrity check failed/, "the error is still printed");
  const lines = linesOf(env.CODEX_OPENCODE_STATE_DIR);
  const crash = lines.find((line) => line.event === "process.uncaught_exception");
  assert.ok(crash, JSON.stringify(lines));
  assert.equal(crash.origin, "unhandledRejection");
  assert.equal(crash.errorType, "Error");
  // B-104: the summary goes on to name server.js and the --sync-clients remedy.
  assert.match(crash.summary, /^Bridge release integrity check failed\. Expected 0{64}, got [a-f0-9]{64}\. server\.js \(.*\) does not match CODEX_OPENCODE_EXPECTED_SERVER_SHA256/);
  assert.match(crash.stack, /verifyReleaseIntegrity/);
  const exited = lines.find((line) => line.event === "process.exited");
  assert.ok(exited && exited.code === 1, JSON.stringify(lines));
});

test("B-058 a failing bin/ command records cli.<script>.failed with its exit code", async () => {
  const env = scratchEnv("cli");
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "sync-managed-runtime.js"), "--apply", "--config", path.join(scratch, "cli", "missing", "config.toml")],
    { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /config\.toml/, "the terminal output is kept");
  const lines = linesOf(env.CODEX_OPENCODE_STATE_DIR);
  const line = lines.find((entry) => entry.event === "cli.sync-managed-runtime.failed");
  assert.ok(line, JSON.stringify(lines));
  assert.equal(line.exitCode, 1);
  assert.equal(line.level, "error");
  assert.ok(line.summary.length > 0);

  // doctor: "attention required" is not an exception but exits 1, and is logged in the state
  // directory it checked (no entry, so <home>/.codex/codex-opencode-mcp of the scratch home).
  const doctor = spawnSync(process.execPath, [path.join(ROOT, "bin", "daily-doctor.js"), "--config", path.join(scratch, "cli", "missing", "config.toml"), "--cwd", ROOT],
    { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(doctor.status, 1, doctor.stderr);
  const doctorLine = linesOf(path.join(env.USERPROFILE, ".codex", "codex-opencode-mcp")).find((entry) => entry.event === "cli.daily-doctor.failed");
  assert.ok(doctorLine, doctor.stdout);
  assert.equal(doctorLine.errorType, "doctor_attention_required");
  assert.match(doctorLine.summary, /\[config\] Cannot read the opencode entry/);

  // setup: an argument error (exit 2, --state-dir honoured) and a failed preflight (exit 1).
  const setupState = path.join(scratch, "cli", "setup-state");
  const bad = spawnSync(process.execPath, [path.join(ROOT, "bin", "setup.js"), "--state-dir", setupState, "--provider-limit", "0"], { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(bad.status, 2, bad.stderr);
  const emptyPath = path.join(scratch, "cli", "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const noTools = { ...env };
  for (const key of pathKeys) delete noTools[key];
  noTools.PATH = emptyPath;
  const preflight = spawnSync(process.execPath, [path.join(ROOT, "bin", "setup.js"), "--yes", "--codex-home", path.join(scratch, "cli", "setup-codex"),
    "--state-dir", setupState, "--claude-config", path.join(scratch, "cli", "claude.json")], { cwd: ROOT, env: noTools, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(preflight.status, 1, preflight.stderr);
  assert.match(preflight.stdout, /git: missing/);
  const setupLines = linesOf(setupState).filter((entry) => entry.event === "cli.setup.failed");
  assert.deepEqual(setupLines.map((entry) => entry.exitCode), [2, 1], JSON.stringify(setupLines));
  assert.match(setupLines[0].summary, /--provider-limit/);
  assert.match(setupLines[1].summary, /preflight/i);
  assert.match(setupLines[1].summary, /git: missing/);
  assert.equal(existsSync(path.join(scratch, "cli", "setup-codex", "config.toml")), false, "a failed preflight still writes no client config");
});

test("B-059 the writer never follows a junction or a symlinked day file", async () => {
  const elsewhere = path.join(scratch, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const linkedState = path.join(scratch, "linked-state");
  mkdirSync(linkedState, { recursive: true });
  symlinkSync(elsewhere, path.join(linkedState, "logs"), "junction");
  assert.equal(appendOpsLogLine(linkedState, { ts: new Date().toISOString(), level: "warn", event: "probe" }), false);
  assert.deepEqual(readdirSync(elsewhere), []);

  const fileState = path.join(scratch, "file-link-state");
  mkdirSync(path.join(fileState, "logs"), { recursive: true });
  const target = path.join(elsewhere, "target.jsonl");
  writeFileSync(target, "outside\n");
  try {
    symlinkSync(target, logFileOf(fileState), "file");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    partial.push({ name: "B-059 symlinked day file", reason: "file symlinks need Developer Mode or admin on this Windows host" });
    process.stdout.write("note: file symlink case skipped (EPERM: needs Developer Mode or admin)\n");
    return;
  }
  assert.equal(appendOpsLogLine(fileState, { ts: new Date().toISOString(), level: "warn", event: "probe" }), false);
  assert.equal(readFileSync(target, "utf8"), "outside\n");
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
  if (firstServerLines) process.stdout.write(`First lines of the scratch operations log:\n${firstServerLines}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-ops-log-coverage.js", total: tests.length, skips, partial });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} ops-log coverage tests failed${skipGateFailed ? "; the skip gate failed" : ""}.\n`);
  process.exit(1);
}
process.stdout.write(`${tests.length - skips.length} of ${tests.length} ops-log coverage tests passed.\n`);
process.exit(0);
