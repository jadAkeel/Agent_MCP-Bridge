#!/usr/bin/env node

// B-189/B-190: URL credentials cannot survive stored logs, and a lost file record
// remains visible on stderr without flooding it. All paths and credentials are fixtures.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLoggingRuntime } from "../lib/logging.js";
import { patchLikelySecretLines, redactLikelySecrets, redactSensitiveText, sanitizePersistedValue } from "../lib/redaction.js";
import { appendOpsLogLine, redactCliText } from "../bin/ops-log.js";
import { finishSkips } from "./skip-gate.js";

const root = mkdtempSync(path.join(tmpdir(), "review-friend-logging-"));
const savedEnvironment = Object.fromEntries(["CODEX_OPENCODE_OPS_LOG", "CODEX_OPENCODE_ISSUE_LOG", "CODEX_OPENCODE_FAULT_LOG"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(savedEnvironment)) delete process.env[key];
const passwords = ["correcthorsebatterystaple", "q", "p%40ss%3Aw%2Ford"];
const urls = passwords.map((password) => `postgres://fixtureuser:${password}@db.example.invalid/app`);
const day = new Date().toISOString().slice(0, 10);
const tests = [];
let sequence = 0;
const test = (name, fn) => tests.push({ name, fn });
const fixture = (name) => {
  const stateDir = path.join(root, `${++sequence}-${name}`);
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
};
const runtime = (stateDir, logLevel = "off") => createLoggingRuntime({
  CONFIG: { logLevel }, effectiveBridgeStateDirectory: () => stateDir,
  getStateDirectoryOverride: () => stateDir, buildStamp: () => "fixture build",
});
const blockLogs = (stateDir) => writeFileSync(path.join(stateDir, "logs"), "a regular file blocks the log directory");
const captureStderr = (operation) => {
  const previous = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  try { operation(lines); } finally { console.error = previous; }
  return lines;
};
const failure = (jobId = "fixture-job") => ({ jobId, errorType: "agent_exit_nonzero", summary: `Connection failed: ${urls[0]}` });

test("B-189: broad log/storage URL masking matches CLI for all-letter, short and encoded passwords", () => {
  for (const url of urls) {
    assert.equal(redactSensitiveText(url), "postgres://fixtureuser:[redacted]@db.example.invalid/app");
    assert.equal(redactSensitiveText(url), redactCliText(url));
    assert.equal(sanitizePersistedValue({ summary: url }).summary, redactCliText(url));
  }
});

test("B-189: patch and agent-answer heuristics keep their existing meaning", () => {
  for (const url of urls.slice(0, 2)) {
    assert.deepEqual(patchLikelySecretLines(`+// sample ${url}\n`), []);
    assert.equal(redactLikelySecrets(url), url);
  }
  const ordinary = "password = getpass.getpass()\n// Basic usage\ntoken_type = TokenType.INT64\nsk-spinner-plane";
  assert.equal(redactLikelySecrets(ordinary), ordinary);
});

test("B-189: real JSONL, issue and fault sinks remove URL passwords", () => {
  const stateDir = fixture("redacted-sinks");
  const { logEvent } = runtime(stateDir);
  for (const url of urls) {
    logEvent("error", "tool.handler_failed", { tool: "run_opencode_agent", errorType: "Error", summary: `Connection failed: ${url}`, stack: `Error: Connection failed: ${url}\n    at fixture (file:///bridge/lib/test.js:1:1)` });
    logEvent("warn", "queue.job_failed", { jobId: "fixture-job", errorType: "agent_exit_nonzero", summary: `Connection failed: ${url}` });
  }
  for (const file of [`bridge-${day}.jsonl`, "issues.md", "faults.md"]) {
    const text = readFileSync(path.join(stateDir, "logs", file), "utf8");
    for (const url of urls) assert.ok(!text.includes(url), `${file} kept a fixture credential URL`);
    for (const password of passwords) assert.ok(!text.includes(`:${password}@`), `${file} kept a fixture password`);
    assert.match(text, /fixtureuser:\[redacted\]@db\.example\.invalid/);
  }
});

test("B-190: a blocked log directory preserves a safe original incident on stderr even at logLevel off", () => {
  const stateDir = fixture("blocked");
  blockLogs(stateDir);
  const { logEvent } = runtime(stateDir);
  const lines = captureStderr(() => assert.doesNotThrow(() => logEvent("warn", "queue.job_failed", failure())));
  assert.equal(lines.length, 1);
  const fallback = JSON.parse(lines[0]);
  assert.equal(fallback.event, "ops_log_write_failed");
  assert.equal(fallback.errorType, "ops_log_write_failed");
  assert.match(fallback.summary, /persist/i);
  const original = JSON.parse(fallback.incident);
  assert.equal(original.event, "queue.job_failed");
  assert.equal(original.errorType, "agent_exit_nonzero");
  assert.equal(original.jobId, "fixture-job");
  assert.match(original.summary, /fixtureuser:\[redacted\]@/);
  assert.ok(!lines[0].includes(passwords[0]));
  assert.ok(!lines[0].includes(stateDir), "the fallback does not reveal the failed log target");
});

test("B-190: repeated failure emits one warning, successful persistence resets the episode", () => {
  const stateDir = fixture("episode");
  blockLogs(stateDir);
  const { logEvent } = runtime(stateDir);
  const lines = captureStderr((captured) => {
    logEvent("warn", "queue.job_failed", failure("first-failure"));
    logEvent("warn", "queue.job_failed", failure("same-episode"));
    assert.equal(captured.length, 1);
    rmSync(path.join(stateDir, "logs"));
    logEvent("warn", "queue.job_failed", failure("recovered"));
    assert.equal(captured.length, 1, "a recovered write needs no fallback");
    const file = path.join(stateDir, "logs", `bridge-${day}.jsonl`);
    assert.match(readFileSync(file, "utf8"), /recovered/);
    rmSync(file);
    mkdirSync(file);
    logEvent("warn", "queue.job_failed", failure("new-episode"));
    logEvent("warn", "queue.job_failed", failure("new-episode-repeat"));
  });
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(JSON.parse(lines[1]).incident).jobId, "new-episode");
});

test("B-190: intentional OPS_LOG off creates no fallback and keeps normal stderr behavior", () => {
  const stateDir = fixture("intentional-off");
  blockLogs(stateDir);
  process.env.CODEX_OPENCODE_OPS_LOG = "off";
  try {
    assert.deepEqual(captureStderr(() => runtime(stateDir).logEvent("warn", "queue.job_failed", failure())), []);
    const lines = captureStderr(() => runtime(stateDir, "warn").logEvent("warn", "queue.job_failed", failure()));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, "queue.job_failed");
    assert.ok(!lines[0].includes("ops_log_write_failed"));
    assert.ok(!lines[0].includes(passwords[0]));
  } finally { delete process.env.CODEX_OPENCODE_OPS_LOG; }
});

test("B-190: the fallback stays bounded and a broken stderr cannot crash the job", () => {
  const stateDir = fixture("bounded");
  blockLogs(stateDir);
  const { logEvent } = runtime(stateDir);
  const lines = captureStderr(() => logEvent("warn", "queue.job_failed", { ...failure(), samples: Array(2000).fill("safe fixture data") }));
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0], "utf8") < 12_000, "a failed file write must not dump unbounded data on stderr");
  assert.equal(JSON.parse(lines[0]).event, "ops_log_write_failed");
  const previous = console.error;
  console.error = () => { throw new Error("fixture stderr unavailable"); };
  try { assert.doesNotThrow(() => runtime(stateDir).logEvent("warn", "queue.job_failed", failure())); }
  finally { console.error = previous; }
});

test("B-190: the first incident replaced by a daily cap marker triggers fallback and reports false", () => {
  const stateDir = fixture("daily-cap");
  mkdirSync(path.join(stateDir, "logs"));
  const file = path.join(stateDir, "logs", `bridge-${day}.jsonl`);
  writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 - 1, " "));
  const { logEvent } = runtime(stateDir);
  const lines = captureStderr(() => {
    logEvent("warn", "queue.job_failed", failure("dropped-by-cap"));
    logEvent("warn", "queue.job_failed", failure("capped-repeat"));
  });
  assert.equal(lines.length, 1);
  const fallback = JSON.parse(lines[0]);
  assert.equal(fallback.event, "ops_log_write_failed");
  assert.match(fallback.summary, /cap/i);
  assert.equal(JSON.parse(fallback.incident).jobId, "dropped-by-cap");
  assert.match(readFileSync(file, "utf8").slice(-400), /ops_log\.daily_cap_reached/);
  assert.equal(appendOpsLogLine(stateDir, { ts: new Date().toISOString(), event: "capped-direct-call" }), false);
  assert.ok(statSync(file).size < 20 * 1024 * 1024 + 1000);
  const capOnlyState = fixture("first-cap-boolean");
  mkdirSync(path.join(capOnlyState, "logs"));
  writeFileSync(path.join(capOnlyState, "logs", `bridge-${day}.jsonl`), Buffer.alloc(20 * 1024 * 1024 - 1, " "));
  assert.equal(appendOpsLogLine(capOnlyState, { ts: new Date().toISOString(), level: "warn", event: "original-not-written" }), false, "writing only the cap marker is not persisting the incident");
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.log(`FAIL ${name}\n${error?.stack || error}`); }
  }
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.ok(path.isAbsolute(root) && path.basename(root).startsWith("review-friend-logging-"), "cleanup is limited to this suite's scratch directory");
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipFailed = finishSkips({ file: "tests/review-friend-logging.js", total: tests.length, skips: [] });
console.log(failed ? `${failed} of ${tests.length} friend logging tests failed.` : `All ${tests.length} friend logging tests passed.`);
process.exitCode = failed || skipFailed ? 1 : 0;
