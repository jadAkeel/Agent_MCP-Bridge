#!/usr/bin/env node

// B-061 (log.md, 2026-10-02): silent rate limits. OpenCode retries "Rate limit exceeded" on its own
// and prints nothing on stdout while it does, so a job sat until its timeout. The bridge now counts
// rate-limit lines of the run's model (its own stderr, and OpenCode's log file at
// CODEX_OPENCODE_OPENCODE_LOG_PATH) and stops the run as provider_rate_limited, then pauses that
// provider/model with a growing pause. Real child processes run through the process supervisor;
// the log file is a scratch fixture and the state directory is a scratch directory.
//   node tests/review-flex-rate-limit.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
const { mkdtempSync } = await import("node:fs");
const { tmpdir: osTmpdir } = await import("node:os");
const nodePath = await import("node:path");
const scratch = mkdtempSync(nodePath.join(osTmpdir(), "review-flex-rate-limit-"));
// Never the operator's real OpenCode log.
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = nodePath.join(scratch, "opencode.log");
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_HITS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-rate-limit");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { builderFallbackEligible } = await import("../bin/builder-model-fallback.js");
const { hooks, internals } = __selfTest;
const {
  CONFIG,
  acquireProviderLease,
  applyRateLimitOutcome,
  assert,
  classifyResultError,
  createRateLimitWatcher,
  mkdir,
  modelPauseKeyForMetadata,
  openCodeRateLimitHit,
  openProviderLeaseDb,
  parseOpenCodeLogLine,
  path,
  providerCapacitySnapshot,
  rateLimitPauseReason,
  readOpenCodeLogPathEnv,
  recordRateLimitPause,
  releaseProviderLease,
  rm,
  runSpawnCommand,
  writeFile,
} = internals;
const { appendFile } = await import("node:fs/promises");

const stateDir = path.join(scratch, "state");
await mkdir(stateDir, { recursive: true });
hooks.stateDirectoryOverride = stateDir;
const logPath = process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH;
await writeFile(logPath, "", "utf8");

const MUSE = "muse-spark-1.3-contributor-free";
const logLine = ({ model = MUSE, session = "ses_A", agent = "builder", small = false, at = new Date(), error = "AI_APICallError: Rate limit exceeded. Please retry after a brief wait." } = {}) =>
  `timestamp=${at.toISOString()} level=ERROR run=b738c809 message="stream error" providerID=opencode modelID=${model} session.id=${session} small=${small} agent=${agent} mode=all error.error="${error}"`;

// The child payloads: written as files so no shell quoting is involved.
const childScript = path.join(scratch, "child.mjs");
await writeFile(childScript, `
const [mode, arg] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (model = ${JSON.stringify(MUSE)}) => \`timestamp=\${new Date().toISOString()} level=ERROR run=r1 message="stream error" providerID=opencode modelID=\${model} session.id=ses_A small=false agent=builder mode=all error.error="AI_APICallError: Rate limit exceeded. Please retry after a brief wait."\\n\`;
if (mode === "silent-hits") { for (let i = 0; i < 6; i += 1) { process.stderr.write(line()); await sleep(150); } await sleep(20000); }
if (mode === "progress") { for (let i = 0; i < 3; i += 1) { process.stderr.write(line()); await sleep(120); process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: "ses_A" }) + "\\n"); await sleep(120); } }
if (mode === "other-model") { for (let i = 0; i < 4; i += 1) { process.stderr.write(line("antigravity-gemini-3.8-flash")); await sleep(120); } }
if (mode === "silent") { await sleep(Number(arg) || 4000); }
if (mode === "burst") { for (let i = 0; i < 6; i += 1) process.stderr.write(line()); await sleep(1500); }
if (mode === "session") { process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_MINE" }) + "\\n"); await sleep(Number(arg) || 8000); }
`, "utf8");

// minSpreadMs 100: the children print their lines 150 ms apart (the bridge default is 5 s, B-070).
const watch = (extra = {}) => ({ hits: 2, provider: "opencode", model: MUSE, agent: "builder", logPath: "", scanMs: 100, minSpreadMs: 100, ...extra });
const spawnChild = (mode, arg = "", options = {}) => runSpawnCommand(process.execPath, [childScript, mode, String(arg)], scratch, 60_000, null, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("B-061: the log line parser reads OpenCode's logfmt and the hit filter keeps only main-model rate limits", () => {
  const entry = parseOpenCodeLogLine(logLine());
  assert.equal(entry.providerID, "opencode");
  assert.equal(entry.modelID, MUSE);
  assert.equal(entry.sessionID, "ses_A");
  assert.equal(entry.agent, "builder");
  assert.equal(entry.small, false);
  assert.match(entry.detail, /stream error AI_APICallError: Rate limit exceeded/);
  assert.ok(entry.timestampMs > 0);
  assert.equal(openCodeRateLimitHit(logLine()).kind, "rate_limit");
  assert.equal(openCodeRateLimitHit(logLine({ error: "AI_APICallError: Upstream request failed: Insufficient account funds" })).kind, "funds");
  assert.equal(openCodeRateLimitHit(logLine({ error: "RESOURCE_EXHAUSTED: quota exceeded for model" })).kind, "quota");
  // The title agent's small model failing says nothing about the job's model.
  assert.equal(openCodeRateLimitHit(logLine({ small: true, agent: "title", model: "gpt-5.4-nano", error: "AI_APICallError: Upstream request failed: Insufficient account funds" })), null);
  assert.equal(openCodeRateLimitHit("timestamp=2026-10-01T08:25:56.490Z level=INFO run=x message=\"creating instance\" directory=C:/rate-limit"), null, "the word must be in the message or error");
  assert.equal(openCodeRateLimitHit("plain text about a rate limit"), null, "not a log line");
  assert.equal(openCodeRateLimitHit(logLine({ error: "AI_APICallError: Upstream request failed" })), null);
});

test("B-061: a run that only logs rate-limit lines on stderr is stopped as rate limited", async () => {
  const started = Date.now();
  const result = await spawnChild("silent-hits", "", { rateLimitWatch: watch() });
  assert.equal(result.rateLimited, true);
  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - started < 15_000, "stopped long before the child's 20 s sleep");
  assert.equal(result.rateLimitHits, 2);
  assert.equal(result.rateLimitEvidence.source, "stderr");
  assert.equal(result.rateLimitEvidence.modelID, MUSE);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
});

test("B-061: stdout output between rate-limit lines means progress and never trips", async () => {
  const result = await spawnChild("progress", "", { rateLimitWatch: watch() });
  assert.equal(result.rateLimited, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.rateLimitHits, 3, "every line was seen");
});

test("B-061: rate-limit lines of another model do not count, and 0 hits turns the watch off", async () => {
  const other = await spawnChild("other-model", "", { rateLimitWatch: watch() });
  assert.equal(other.rateLimited, false);
  assert.equal(other.rateLimitHits, 0);
  const off = await spawnChild("progress", "", { rateLimitWatch: watch({ hits: 0 }) });
  assert.equal(off.rateLimited, false);
  assert.equal(off.rateLimitHits, 0);
});

test("B-070: before the run's session is known, log-file lines never count (another session's limit must not pause the model)", async () => {
  await writeFile(logPath, `${logLine({ at: new Date(Date.now() - 60_000) })}\n`, "utf8");
  const running = spawnChild("silent", 3000, { rateLimitWatch: watch({ logPath }) });
  await sleep(600);
  // Same model, same agent, new lines, two of them in one scan: still another session's.
  await appendFile(logPath, `${logLine({ session: "ses_X" })}\n${logLine({ session: "ses_X", at: new Date(Date.now() + 1) })}\n`, "utf8");
  await sleep(300);
  await appendFile(logPath, `${logLine({ session: "ses_X" })}\n`, "utf8");
  const result = await running;
  assert.equal(result.rateLimited, false);
  assert.equal(result.rateLimitHits, 0);
});

test("B-070: a burst delivered at once is one observation; the default needs hits 5 s apart", async () => {
  const burst = await spawnChild("burst", "", { rateLimitWatch: watch({ minSpreadMs: undefined }) });
  assert.equal(burst.rateLimited, false, "six lines within a moment do not stop the run");
  assert.ok(burst.rateLimitHits >= 1, "the lines were seen (identical ones count once)");
  let trips = 0;
  const watcher = createRateLimitWatcher({ ...watch({ minSpreadMs: 300 }), onTrip: () => { trips += 1; } });
  watcher.stderrLine(logLine({ at: new Date(Date.now() - 2) }));
  watcher.stderrLine(logLine({ at: new Date(Date.now() - 1) }));
  assert.equal(trips, 0, "two hits in the same moment");
  await sleep(350);
  watcher.stderrLine(logLine());
  assert.equal(trips, 1, "a later read completes the streak");
  watcher.stop();
});

test("B-074: CODEX_OPENCODE_RATE_LIMIT_HITS=1 stops at the first line (there is no spread to wait for)", () => {
  let trips = 0;
  const watcher = createRateLimitWatcher({ ...watch({ hits: 1, minSpreadMs: undefined }), onTrip: () => { trips += 1; } });
  watcher.stderrLine(logLine());
  assert.equal(trips, 1);
  watcher.stop();
});

test("B-061: once the run's session is known only that session's lines count", async () => {
  await writeFile(logPath, "", "utf8");
  const running = spawnChild("session", 8000, { rateLimitWatch: watch({ logPath }) });
  await sleep(700);
  await appendFile(logPath, `${logLine({ session: "ses_OTHER" })}\n`, "utf8");
  await sleep(150);
  await appendFile(logPath, `${logLine({ session: "ses_OTHER" })}\n`, "utf8");
  await sleep(700);
  await appendFile(logPath, `${logLine({ session: "ses_MINE" })}\n`, "utf8");
  await sleep(150);
  await appendFile(logPath, `${logLine({ session: "ses_MINE" })}\n`, "utf8");
  const result = await running;
  assert.equal(result.rateLimited, true);
  assert.equal(result.rateLimitEvidence.sessionId, "ses_MINE", "another job's session never counted");
  assert.equal(result.rateLimitHits, 2);
});

test("B-061: the watcher counts a line seen on stderr and in the file once, and survives a rotated file", async () => {
  await writeFile(logPath, "x\n".repeat(50), "utf8");
  let trips = 0;
  const watcher = createRateLimitWatcher({ ...watch({ logPath, hits: 3, minSpreadMs: 0 }), onTrip: () => { trips += 1; } });
  watcher.stdoutText(JSON.stringify({ type: "step_start", sessionID: "ses_A" }));
  await watcher.scanNow();
  const shared = logLine();
  watcher.stderrLine(shared);
  await appendFile(logPath, `${shared}\n`, "utf8");
  await watcher.scanNow();
  assert.equal(watcher.state.hits, 1, "the same line from both sources is one hit");
  await writeFile(logPath, `${logLine({ at: new Date(Date.now() + 1) })}\n`, "utf8");
  await watcher.scanNow();
  assert.equal(watcher.state.hits, 2, "a truncated file is read from its start");
  watcher.stderrLine(logLine({ at: new Date(Date.now() + 5) }));
  assert.equal(trips, 1);
  assert.equal(watcher.state.tripped, true);
  watcher.stop();
});

test("B-061: the outcome is provider_rate_limited unless a cancellation or containment failure wins", () => {
  const stopped = { rateLimited: true, rateLimitHits: 2, rateLimitEvidence: { source: "stderr", kind: "rate_limit", providerID: "opencode", modelID: MUSE, detail: "stream error AI_APICallError: Rate limit exceeded." } };
  const runResult = applyRateLimitOutcome({ exitCode: 1, configuredProvider: "opencode", configuredModel: MUSE }, stopped);
  assert.equal(classifyResultError(runResult), "provider_rate_limited");
  assert.match(rateLimitPauseReason(runResult), /^rate limit: 2 line\(s\) for opencode\/muse-spark-1\.3-contributor-free with no agent output in between \(stderr: stream error/);
  assert.equal(classifyResultError(applyRateLimitOutcome({ exitCode: 130, cancelled: true }, stopped)), "agent_cancelled");
  assert.equal(classifyResultError(applyRateLimitOutcome({ exitCode: 1, terminationErrorType: "process_tree_termination_unconfirmed" }, stopped)), "process_tree_termination_unconfirmed");
  assert.equal(applyRateLimitOutcome({ exitCode: 0 }, { rateLimited: false }).rateLimited, undefined);
  const eligible = { configuredProvider: "opencode", configuredModel: MUSE, errorType: "provider_rate_limited", streamIntegrity: "valid", treeTerminationConfirmed: true };
  assert.equal(builderFallbackEligible("builder", eligible, { enabled: true }), true, "the opt-in builder fallback treats it like opencode_rate_limited");
});

test("B-061: a detected rate limit pauses the model for 10 minutes, then 20, 40, 60 (B-162); a running pause adds no strike", async () => {
  const key = modelPauseKeyForMetadata({ provider: "OpenCode", model: MUSE });
  assert.equal(key, `${CONFIG.providerConcurrencyKey}:opencode/${MUSE}`);
  assert.equal(modelPauseKeyForMetadata({ provider: "opencode", model: "" }), "");
  const t0 = Date.now();
  const first = await recordRateLimitPause({ pauseKey: key, reason: "rate limit: test", now: t0 });
  assert.equal(first.recorded, true);
  assert.equal(first.strikes, 1);
  assert.equal(first.untilAt - t0, 10 * 60_000);
  const again = await recordRateLimitPause({ pauseKey: key, reason: "parallel job", now: t0 + 1000 });
  assert.equal(again.reused, true, "a second job tripping on the same limit keeps the running pause");
  assert.equal(again.untilAt, first.untilAt);

  // A slot request on the model fails at once; the provider itself is not paused.
  const providerKey = `${CONFIG.providerConcurrencyKey}:opencode`;
  const refused = await acquireProviderLease({ providerKey, pauseKeys: [key], timeoutMs: 2000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.errorType, "provider_rate_limited");
  assert.equal(refused.pausedKey, key);
  assert.match(refused.error, /is paused until .* \(provider_rate_limited: rate limit: test\)\. The agent was not started/);
  const other = await acquireProviderLease({ providerKey, pauseKeys: [modelPauseKeyForMetadata({ provider: "opencode", model: "other-model" })], timeoutMs: 2000 });
  assert.equal(other.ok, true, "another model of the same provider still runs");
  await releaseProviderLease(other.lease);
  const snapshot = await providerCapacitySnapshot();
  assert.ok(snapshot.cooldowns.some((item) => item.providerKey === key && item.errorType === "provider_rate_limited"), "status lists the model pause");

  const expire = async (lastStrikeAt = null) => {
    const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    try {
      db.prepare("UPDATE provider_cooldowns SET until_at = ? WHERE provider_key = ?").run(Date.now() - 1, key);
      if (lastStrikeAt !== null) db.prepare("UPDATE provider_pause_strikes SET last_strike_at = ? WHERE pause_key = ?").run(lastStrikeAt, key);
    } finally {
      db.close();
    }
  };
  await expire();
  const second = await recordRateLimitPause({ pauseKey: key, now: Date.now() });
  assert.equal(second.strikes, 2);
  assert.equal(second.durationMs, 20 * 60_000);
  await expire();
  const third = await recordRateLimitPause({ pauseKey: key, now: Date.now() });
  assert.equal(third.strikes, 3);
  assert.equal(third.durationMs, 40 * 60_000);
  await expire();
  const fourth = await recordRateLimitPause({ pauseKey: key, now: Date.now() });
  assert.equal(fourth.strikes, 4);
  assert.equal(fourth.durationMs, 60 * 60_000, "capped at CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS");
  await expire();
  const fifth = await recordRateLimitPause({ pauseKey: key, now: Date.now() });
  assert.equal(fifth.durationMs, 60 * 60_000, "stays at the cap");
  await expire(Date.now() - 3 * 60 * 60_000);
  const decayed = await recordRateLimitPause({ pauseKey: key, now: Date.now() });
  assert.equal(decayed.strikes, 1, "a strike older than twice the maximum is forgotten");
  assert.equal(decayed.durationMs, 10 * 60_000);
  await expire();
});

test("B-061: the log path setting: default under the OpenCode data dir, off, or absolute only", () => {
  const saved = process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH;
  try {
    delete process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH;
    assert.match(readOpenCodeLogPathEnv(), /opencode[\\/]log[\\/]opencode\.log$/);
    process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
    assert.equal(readOpenCodeLogPathEnv(), "");
    process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "relative/opencode.log";
    assert.throws(() => readOpenCodeLogPathEnv(), /must be an absolute path or off/);
  } finally {
    process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = saved;
  }
  assert.equal(CONFIG.openCodeLogPath, logPath, "this run reads the scratch fixture");
  assert.equal(CONFIG.rateLimitHits, 2);
  assert.equal(CONFIG.rateLimitPauseMs, 10 * 60_000, "B-162: the first pause is 10 min");
  assert.equal(CONFIG.rateLimitPauseMaxMs, 60 * 60_000);
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
    }
  }
} finally {
  hooks.stateDirectoryOverride = "";
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
removeIsolatedStateDir(isolatedStateDir);
const skipGateFailed = finishSkips({ file: "tests/review-flex-rate-limit.js", total: tests.length, skips: [] });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} rate-limit tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} rate-limit tests passed.\n`);
process.exit(0);
