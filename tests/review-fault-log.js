#!/usr/bin/env node

// Q-013 (log.md, 2026-10-03): the fault log. The operations log held every failure, but a
// developer could not tell the bridge's own defects (a crash, a tool handler or queue runner
// that threw, state it could not write) from agent, provider and rate-limit failures, and the
// bridge's error records hashed their `error` text away (sanitizeLogValue), so a fix session had
// nothing to read. Now: isBridgeFault classifies each record, faults.md gets one entry per
// fault with the first bridge stack frame, `--faults --prompt` prints a task for a coding
// assistant, every warn/error record carries a readable summary and the build stamp, a thrown
// tool handler is logged with its stack, and a client's probe of an unserved method (-32601 on
// resources/templates/list) is no longer an error line. Everything runs in scratch directories.
//   node tests/review-fault-log.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_OPS_LOG;
delete process.env.CODEX_OPENCODE_FAULT_LOG;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
const { __selfTest } = await import("../server.js");
const opsLog = await import("../bin/ops-log.js");
const { createLoggingRuntime } = await import("../lib/logging.js");
const { finishSkips } = await import("./skip-gate.js");
const { describeFailedMcpMessage, wrapToolHandler } = __selfTest.internals;
const assert = (await import("node:assert/strict")).default;
const { spawnSync } = await import("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPS_LOG_SCRIPT = path.join(ROOT, "bin", "ops-log.js");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "review-fault-log-")));
const FAKE_TOKEN = "ghp_FAKE0123456789abcdefFAKE0123456789abcd";
const day = new Date().toISOString().slice(0, 10);
const jsonlOf = (stateDir) => {
  const file = path.join(stateDir, "logs", `bridge-${day}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const faultsOf = (stateDir) => {
  const file = path.join(stateDir, "logs", "faults.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const crashStack = "TypeError: Cannot read properties of undefined (reading 'jobId')\n    at startQueueRecord (file:///C:/bridge/lib/queue/start.js:240:11)\n    at async runQueueTick (file:///C:/bridge/server.js:4000:5)";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("isBridgeFault: the bridge's own errors are faults, agent and client failures are not", () => {
  const ts = "2026-10-03T08:00:00.000Z";
  const faults = [
    { ts, level: "error", event: "process.uncaught_exception", errorType: "TypeError", summary: "x", stack: crashStack },
    { ts, level: "error", event: "tool.handler_failed", tool: "get_opencode_job", summary: "boom", stack: crashStack },
    { ts, level: "error", event: "queue.job_internal_failure", jobId: "j1", summary: "boom" },
    { ts, level: "error", event: "integration.journal_quarantined", operationId: "op-1" },
    { ts, level: "warn", event: "queue.orphaned_records_reconciled", count: 2 },
    { ts, level: "warn", event: "provider.lease_ownership_lost" },
    { ts, level: "warn", event: "tool.refused", tool: "get_opencode_job", errorType: "", summary: "TypeError: x is not a function" },
    { ts, level: "warn", event: "queue.job_failed", jobId: "j2", errorType: "queue_job_failed", summary: "Cannot read properties of undefined (reading 'cwd')" },
    { ts, level: "error", event: "mcp.request_failed", method: "tools/call", tool: "run_opencode_agent", code: -32603, summary: "Internal error" },
    { ts, level: "error", event: "cli.setup.failed", errorType: "ENOENT", summary: "spawn git ENOENT", exitCode: 1 },
  ];
  for (const record of faults) assert.equal(opsLog.isBridgeFault(record), true, `${record.event} ${record.errorType || ""} is a fault`);
  const notFaults = [
    { ts, level: "warn", event: "agent.run_failed", tool: "run_opencode_agent", errorType: "opencode_rate_limited", summary: "rate limit" },
    { ts, level: "warn", event: "queue.job_failed", jobId: "j3", errorType: "agent_idle_timeout", summary: "stopped as idle after 10 min" },
    { ts, level: "warn", event: "tool.refused", tool: "integrate_opencode_worktree", errorType: "dirty_worktree_requires_checkpoint", summary: "uncommitted changes" },
    { ts, level: "warn", event: "provider.rate_limit_detected", errorType: "provider_rate_limited" },
    { ts, level: "error", event: "mcp.request_failed", method: "resources/templates/list", code: -32601, summary: "Method not found" },
    { ts, level: "error", event: "mcp.request_failed", method: "tools/call", tool: "nope", code: -32601, summary: "MCP error -32601: Tool nope not found" },
    { ts, level: "error", event: "mcp.request_failed", method: "tools/call", tool: "get_opencode_job", code: -32602, summary: "MCP error -32602: Invalid arguments" },
    { ts, level: "error", event: "process.exited", code: 1 },
    { ts, level: "error", event: "external_runner.wrote_outside_worktree", runner: "agy" },
    { ts, level: "error", event: "cli.daily-doctor.failed", errorType: "", summary: "Bridge daily doctor: attention required.", exitCode: 1 },
    { ts, level: "info", event: "queue_worker.started" },
  ];
  for (const record of notFaults) assert.equal(opsLog.isBridgeFault(record), false, `${record.event} ${record.errorType || record.code || ""} is not a fault`);
  assert.equal(opsLog.isBridgeFault(null), false);
});

test("fingerprint and location: stable across paths, hashes, ids and line numbers", () => {
  const base = { ts: "2026-10-03T08:00:00.000Z", level: "error", event: "process.uncaught_exception", errorType: "TypeError", summary: "Cannot read properties of undefined (reading 'jobId') for job builder-17-ab12cd34ef56 in C:\\Users\\me\\repo", stack: crashStack };
  const other = { ...base, summary: base.summary.replace("builder-17-ab12cd34ef56", "builder-99-0123456789ab").replace("C:\\Users\\me\\repo", "D:\\work\\other"), stack: crashStack.replace(":240:11", ":512:3").replace("C:/bridge", "C:/elsewhere") };
  assert.match(opsLog.faultFingerprint(base), /^[0-9a-f]{12}$/);
  assert.equal(opsLog.faultFingerprint(base), opsLog.faultFingerprint(other));
  assert.notEqual(opsLog.faultFingerprint(base), opsLog.faultFingerprint({ ...base, errorType: "RangeError" }));
  assert.equal(opsLog.faultLocation(crashStack), "startQueueRecord (start.js)");
  assert.equal(opsLog.faultLocation("Error: x\n    at file:///C:/bridge/lib/a.js:1:2"), "a.js");
  assert.equal(opsLog.faultLocation("Error: x\n    at async C:\\bridge\\lib\\queue\\leases.js:10:3"), "leases.js");
  assert.equal(opsLog.faultLocation(""), "");
});

test("faultMarkdownEntry: a full entry with status, where, context, summary and stack; a repeat is one line", () => {
  const record = { ts: "2026-10-03T08:12:30.000Z", level: "error", event: "tool.handler_failed", tool: "get_opencode_job", errorType: "TypeError", summary: "x is not a function", stack: crashStack, pid: 4242, build: "server 0123456789ab lib fedcba987654" };
  const entry = opsLog.faultMarkdownEntry(record, { fingerprint: "abcdefabcdef" });
  assert.match(entry, /^### 2026-10-03 08:12 UTC \| tool\.handler_failed \| fault abcdefabcdef\n- status: open\n- errorType: TypeError\n- where: startQueueRecord \(start\.js\)\n- context: tool get_opencode_job, pid 4242, build server 0123456789ab lib fedcba987654\n- summary: x is not a function\n- stack:\n  ```\n  TypeError: Cannot read/);
  assert.ok(entry.endsWith("  ```\n\n"), "an entry ends with the fenced stack and a blank line");
  assert.equal(opsLog.faultMarkdownEntry(record, { fingerprint: "abcdefabcdef", repeat: true }), "- repeat: fault abcdefabcdef at 2026-10-03 08:12 UTC\n");
  assert.equal(opsLog.faultMarkdownEntry({ ...record, level: "warn", event: "agent.run_failed", errorType: "agent_timeout", summary: "timed out", stack: "" }), "", "not a fault, no entry");
});

test("describeFailedMcpMessage: a client's probe of an unserved method is not an error line; unknown tools and internal errors still are", () => {
  const pending = new Map();
  pending.set(1, { method: "resources/templates/list", tool: "", startedAt: Date.now() });
  pending.set(2, { method: "prompts/list", tool: "", startedAt: Date.now() });
  pending.set(3, { method: "tools/call", tool: "nope", startedAt: Date.now() });
  pending.set(4, { method: "tools/call", tool: "get_opencode_job", startedAt: Date.now() });
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }, pending), null);
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }, pending), null);
  const unknownTool = describeFailedMcpMessage({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Tool nope not found" } }, pending);
  assert.equal(unknownTool?.event, "mcp.request_failed");
  assert.equal(unknownTool.data.code, -32601);
  assert.equal(unknownTool.data.errorType, "jsonrpc_-32601", "the incident summary groups by code");
  const internal = describeFailedMcpMessage({ jsonrpc: "2.0", id: 4, error: { code: -32603, message: "Internal error" } }, pending);
  assert.equal(internal?.level, "error");
  assert.equal(internal.data.code, -32603);
  assert.equal(internal.data.errorType, "jsonrpc_-32603");
  const sdkValidation = describeFailedMcpMessage({ jsonrpc: "2.0", id: 4, result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Invalid arguments for tool get_opencode_job" }] } }, pending);
  assert.equal(sdkValidation?.event, "mcp.request_failed");
  assert.equal(sdkValidation.data.errorType, "jsonrpc_-32602");
  assert.equal(opsLog.isBridgeFault({ ts: "2026-10-03T08:00:00.000Z", level: internal.level, event: internal.event, ...internal.data }), true);
  // A request the bridge never saw (no pending entry) keeps the old behaviour: it is logged.
  assert.equal(describeFailedMcpMessage({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found" } }, pending)?.event, "mcp.request_failed");
});

test("logEvent: a warn/error record keeps a redacted readable summary of its error text and the build stamp; the hash fields stay", () => {
  const stateDir = path.join(scratch, "logging", "state");
  mkdirSync(stateDir, { recursive: true });
  const { logEvent } = createLoggingRuntime({
    CONFIG: { logLevel: "off" },
    effectiveBridgeStateDirectory: () => stateDir,
    getStateDirectoryOverride: () => stateDir,
    buildStamp: () => "server 0123456789ab lib fedcba987654",
  });
  logEvent("error", "provider.cooldown_record_failed", { providerKey: "k", error: `SQLITE_BUSY: database is locked while writing ${FAKE_TOKEN}` });
  logEvent("warn", "concurrency.runtime_refresh_failed", { reason: "database is locked" });
  logEvent("warn", "queue.job_failed", { jobId: "j1", errorType: "agent_timeout", summary: "already readable", error: "ignored, summary wins" });
  logEvent("error", "process.uncaught_exception", { errorType: "TypeError", summary: "Cannot read properties of undefined (reading 'x')", stack: crashStack });
  logEvent("info", "queue_worker.started", { message: "info records are not failures" });
  const lines = jsonlOf(stateDir);
  const cooldown = lines.find((line) => line.event === "provider.cooldown_record_failed");
  assert.equal(cooldown.summary, "SQLITE_BUSY: database is locked while writing [github credential redacted]");
  assert.equal(typeof cooldown.errorSha256, "string", "the hash field of the error text stays");
  assert.equal(cooldown.build, "server 0123456789ab lib fedcba987654");
  assert.equal(lines.find((line) => line.event === "concurrency.runtime_refresh_failed").summary, "database is locked");
  assert.equal(lines.find((line) => line.event === "queue.job_failed").summary, "already readable");
  assert.equal(lines.find((line) => line.event === "queue_worker.started").build, undefined, "no build stamp on an info record");
  assert.equal(lines.find((line) => line.event === "queue_worker.started").message, undefined, "sanitizeLogValue still hashes message on info records");
  assert.doesNotMatch(JSON.stringify(lines), /ghp_FAKE/);
  // The fault log holds the two faults (the cooldown write failure and the crash), not the agent timeout.
  const faults = faultsOf(stateDir);
  assert.match(faults, /^# Bridge fault log\n/);
  assert.match(faults, /### .* \| provider\.cooldown_record_failed \| fault [0-9a-f]{12}\n- status: open\n/);
  assert.match(faults, /### .* \| process\.uncaught_exception \| fault [0-9a-f]{12}\n- status: open\n- errorType: TypeError\n- where: startQueueRecord \(start\.js\)/);
  assert.match(faults, /- context: .*build server 0123456789ab lib fedcba987654/);
  assert.doesNotMatch(faults, /agent_timeout|runtime_refresh_failed/);
  // Issue log and fault log do not overlap for these records.
  const issues = readFileSync(path.join(stateDir, "logs", "issues.md"), "utf8");
  assert.match(issues, /queue\.job_failed \| agent_timeout/);
  assert.doesNotMatch(issues, /cooldown_record_failed|uncaught_exception/);
  // Without a build stamp the records simply have no build field.
  const bare = path.join(scratch, "logging-bare", "state");
  mkdirSync(bare, { recursive: true });
  createLoggingRuntime({ CONFIG: { logLevel: "off" }, effectiveBridgeStateDirectory: () => bare, getStateDirectoryOverride: () => bare }).logEvent("error", "x.failed", { error: "y" });
  assert.equal(jsonlOf(bare)[0].build, undefined);
  assert.equal(jsonlOf(bare)[0].summary, "y");
});

test("wrapToolHandler: a thrown handler is logged as tool.handler_failed with its stack and rethrown unchanged; a returned result is untouched", async () => {
  const stateDir = path.join(scratch, "handler", "state");
  mkdirSync(stateDir, { recursive: true });
  __selfTest.hooks.stateDirectoryOverride = stateDir;
  try {
    const failure = Object.assign(new TypeError("record.cwd is not a function"), { stack: crashStack });
    const wrapped = wrapToolHandler("get_opencode_job", async () => { throw failure; });
    await assert.rejects(() => wrapped({ jobId: "x" }, {}), (error) => error === failure);
    const line = jsonlOf(stateDir).find((item) => item.event === "tool.handler_failed");
    assert.ok(line, "a handler failure is in the operations log");
    assert.equal(line.level, "error");
    assert.equal(line.tool, "get_opencode_job");
    assert.equal(line.errorType, "TypeError");
    assert.equal(line.summary, "record.cwd is not a function");
    assert.match(line.stack, /startQueueRecord/);
    assert.match(line.build, /^server [0-9a-f]{12} lib /);
    assert.match(faultsOf(stateDir), /\| tool\.handler_failed \| fault [0-9a-f]{12}\n- status: open\n- errorType: TypeError\n- where: startQueueRecord \(start\.js\)\n- context: tool get_opencode_job/);
    // A refusal the handler returns (the normal path) is not a fault and not logged here.
    const fine = wrapToolHandler("get_opencode_job", async (args) => ({ content: [{ type: "text", text: `errorType: unsafe_path\n${args.jobId}` }] }));
    const result = await fine({ jobId: "y" }, {});
    assert.equal(result.content[0].text, "errorType: unsafe_path\ny");
    assert.equal(jsonlOf(stateDir).filter((item) => item.event === "tool.handler_failed").length, 1);
  } finally {
    __selfTest.hooks.stateDirectoryOverride = "";
  }
});

test("--faults rebuilds the grouped view from the JSONL files, --prompt prints the fix task, the flags exclude each other", () => {
  const stateDir = path.join(scratch, "cli", "state");
  mkdirSync(stateDir, { recursive: true });
  const now = new Date();
  const crash = { ts: now.toISOString(), level: "error", event: "process.uncaught_exception", errorType: "TypeError", summary: "Cannot read properties of undefined (reading 'jobId')", stack: crashStack, build: "server 0123456789ab lib fedcba987654" };
  for (let index = 0; index < 3; index += 1) opsLog.appendOpsLogLine(stateDir, { ...crash, jobId: `job-${index}` }, { now });
  opsLog.appendOpsLogLine(stateDir, { ts: now.toISOString(), level: "warn", event: "agent.run_failed", tool: "run_opencode_agent", errorType: "opencode_rate_limited", summary: "rate limit" }, { now });
  const env = { ...process.env, CODEX_OPENCODE_OPS_LOG: "off" };
  const grouped = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--faults", "--state-dir", stateDir], { encoding: "utf8", env });
  assert.equal(grouped.status, 0, grouped.stderr);
  assert.match(grouped.stdout, /^Bridge faults, last 30 day\(s\): 1 distinct fault\(s\), 3 record\(s\)/);
  assert.match(grouped.stdout, /FAULT [0-9a-f]{12}  3x  process\.uncaught_exception \[TypeError\].*build server 0123456789ab lib fedcba987654/);
  assert.match(grouped.stdout, /where:\s+startQueueRecord \(start\.js\)/);
  assert.match(grouped.stdout, /samples: job-0, job-1, job-2/);
  assert.doesNotMatch(grouped.stdout, /opencode_rate_limited/);
  const prompt = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--faults", "--prompt", "--state-dir", stateDir], { encoding: "utf8", env });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /^You are fixing the Agent MCP Bridge, the MCP server in /);
  assert.match(prompt.stdout, /## Fault 1 of 1: [0-9a-f]{12}, 3x, last /);
  assert.match(prompt.stdout, /- where: startQueueRecord \(start\.js\)/);
  assert.match(prompt.stdout, /status: fixed <commit>/);
  assert.match(prompt.stdout, new RegExp(`Fault log file: ${path.join(stateDir, "logs", "faults.md").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  const json = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--faults", "--json", "--state-dir", stateDir], { encoding: "utf8", env });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].count, 3);
  assert.equal(report.days, 30);
  const empty = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--faults", "--prompt", "--state-dir", path.join(scratch, "cli", "empty")], { encoding: "utf8", env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /logged no fault of its own/);
  const both = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--faults", "--issues", "--state-dir", stateDir], { encoding: "utf8", env });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Use one of/);
  const stray = spawnSync(process.execPath, [OPS_LOG_SCRIPT, "--incidents", "--prompt", "--state-dir", stateDir], { encoding: "utf8", env });
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /--prompt belongs to --faults/);
  // The CLI run wrote nothing: the state directory only holds what the test appended.
  assert.equal(jsonlOf(stateDir).length, 4);
});

test("fault log path: default, off, custom absolute; a relative path is never written", () => {
  assert.equal(opsLog.faultLogPath("/state", {}), path.join("/state", "logs", "faults.md"));
  assert.equal(opsLog.faultLogPath("/state", { CODEX_OPENCODE_FAULT_LOG: "off" }), "");
  assert.equal(opsLog.faultLogPath("/state", { CODEX_OPENCODE_FAULT_LOG: "relative.md" }), "");
  assert.equal(opsLog.faultLogPath("/state", { CODEX_OPENCODE_FAULT_LOG: path.join(scratch, "custom.md") }), path.join(scratch, "custom.md"));
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`not ok - ${name}\n${error?.stack || error}\n`);
  }
}
rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const skipGateFailed = finishSkips({ file: "tests/review-fault-log.js", total: tests.length, skips: [], partial: [] });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} fault-log tests failed${skipGateFailed ? "; the skip gate failed" : ""}.\n`);
  process.exit(1);
}
process.stdout.write(`${tests.length} of ${tests.length} fault-log tests passed.\n`);
process.exit(0);
