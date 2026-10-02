#!/usr/bin/env node

// B-096 (log.md, 2026-10-02): two builder runs pinned to opencode/muse-spark-1.3-contributor-free
// hung 10 minutes each. OpenCode logged one line, the real shape below, and then wrote nothing:
//   timestamp=2026-10-02T18:05:23.604Z level=ERROR run=c45be722 message="stream error"
//   providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_... small=false
//   agent=builder mode=all error.error="AI_APICallError: Rate limit exceeded. Please try again later."
// The rate-limit watcher (B-061/B-070) waits for 2 lines at least 5 s apart, OpenCode never retries
// this wording, so only the idle watchdog ended the run (600 s). A final line, or a structured
// rate-limit error event on stdout, now ends a run that stays alive within seconds and pauses the
// model. The fake opencode prints the real shape and then sleeps 30 s. Scratch dirs only.
//   node tests/review-b096-rate-limit-exit.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";

import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";

const execFileAsync = promisify(execFileCallback);
const scratch = mkdtempSync(path.join(tmpdir(), "review-b096-rate-limit-exit-"));
const fakeOpenCodeDir = path.join(scratch, "fake-opencode");
await mkdir(fakeOpenCodeDir, { recursive: true });
const fakeOpenCodeExecutable = path.join(fakeOpenCodeDir, process.platform === "win32" ? "opencode.exe" : "opencode");
// Never the operator's real OpenCode log, cache, executable or bridge state.
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = path.join(scratch, "opencode.log");
process.env.XDG_CACHE_HOME = path.join(scratch, "xdg-cache");
process.env.CODEX_OPENCODE_EXECUTABLE = fakeOpenCodeExecutable;
process.env.CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS = "2000";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_HITS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS;
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-b096-rate-limit-exit");
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const { hooks, internals } = __selfTest;
const { CONFIG, createRateLimitWatcher, modelPauseKeyForMetadata, openCodeRateLimitHit, openProviderLeaseDb, rateLimitPauseReason, runOpenCode, runSpawnCommand } = internals;

const stateDir = path.join(scratch, "state");
await mkdir(stateDir, { recursive: true });
hooks.stateDirectoryOverride = stateDir;
await writeFile(process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH, "", "utf8");

const MUSE = "muse-spark-1.3-contributor-free";
const FINAL_ERROR = "AI_APICallError: Rate limit exceeded. Please try again later.";
const RETRIED_ERROR = "AI_APICallError: Rate limit exceeded. Please retry after a brief wait.";
const logLine = ({ error = FINAL_ERROR, level = "ERROR", model = MUSE, session = "ses_b096", at = "2026-10-02T18:05:23.604Z" } = {}) =>
  `timestamp=${at} level=${level} run=c45be722 message="stream error" providerID=opencode modelID=${model} session.id=${session} small=false agent=builder mode=all error.error="${error}"`;
// The JSON stream's error event (OpenCode run --format json) for a session that gave up.
const errorEvent = (message = "Rate limit exceeded. Please try again later.", extra = {}) => JSON.stringify({
  type: "error",
  timestamp: 1790964323604,
  sessionID: "ses_b096",
  error: { name: "APIError", data: { message, statusCode: 429, isRetryable: false, ...extra } },
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const skipTest = (reason) => { throw new SkipTest(reason); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fake opencode: `debug agent` prints fixture metadata; `run` acts on a marker in the prompt.
const fixtureAgentName = "fixture-agent";
const fixtureAgentDebug = {
  name: fixtureAgentName,
  mode: "primary",
  model: { providerID: "opencode", modelID: MUSE },
  variant: "high",
  temperature: 0.1,
  prompt: "fixture prompt",
  permission: [
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "*", action: "deny" },
  ],
  tools: { apply_patch: false, bash: false, edit: false, skill: false, task: false, webfetch: false, websearch: false, write: false },
};
const stepStart = JSON.stringify({ type: "step_start", sessionID: "ses_b096" });
const outputs = {
  B096_STDERR: { stdout: `${stepStart}\n`, stderr: `${logLine()}\n` },
  B096_EVENT: { stdout: `${stepStart}\n${errorEvent()}\n`, stderr: "" },
};
async function buildFakeOpenCode() {
  if (process.platform === "win32") {
    const source = path.join(fakeOpenCodeDir, "opencode.c");
    const branch = (marker) => [
      `  if (strstr(prompt, ${JSON.stringify(marker)})) {`,
      `    fputs(${JSON.stringify(outputs[marker].stdout)}, stdout); fflush(stdout);`,
      `    fputs(${JSON.stringify(outputs[marker].stderr)}, stderr); fflush(stderr);`,
      "    Sleep(30000); return 0; }",
    ].join("\n");
    await writeFile(source, [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <windows.h>",
      "int main(int argc, char **argv) {",
      "  for (int i = 1; i + 1 < argc; i += 1) { if (strcmp(argv[i], \"debug\") == 0 && strcmp(argv[i + 1], \"agent\") == 0) {",
      `    fputs(${JSON.stringify(JSON.stringify(fixtureAgentDebug))}, stdout); return 0; } }`,
      "  const char *prompt = argc > 1 ? argv[argc - 1] : \"\";",
      branch("B096_STDERR"),
      branch("B096_EVENT"),
      "  fputs(\"unexpected fake OpenCode arguments\", stderr); return 2;",
      "}",
    ].join("\n"), "utf8");
    const compilers = process.env.REVIEW_SPAWN_COMPILERS ? process.env.REVIEW_SPAWN_COMPILERS.split(",") : ["gcc", "C:\\MinGW\\bin\\gcc.exe"];
    for (const compiler of compilers) {
      try {
        await execFileAsync(compiler, [source, "-O2", "-o", fakeOpenCodeExecutable], { cwd: fakeOpenCodeDir, windowsHide: true, timeout: 60_000 });
        return "";
      } catch {
        // try the next compiler
      }
    }
    return "no C compiler (gcc) to build the Windows fake opencode";
  }
  await writeFile(fakeOpenCodeExecutable, [
    `#!${process.execPath}`,
    "const argv = process.argv.slice(2);",
    "const debugIndex = argv.indexOf('debug');",
    `if (debugIndex >= 0 && argv[debugIndex + 1] === 'agent') { process.stdout.write(${JSON.stringify(JSON.stringify(fixtureAgentDebug))}); process.exit(0); }`,
    `const outputs = ${JSON.stringify(outputs)};`,
    "const marker = Object.keys(outputs).find((key) => String(argv[argv.length - 1]).includes(key));",
    "if (!marker) { process.stderr.write('unexpected fake OpenCode arguments'); process.exit(2); }",
    "process.stdout.write(outputs[marker].stdout); process.stderr.write(outputs[marker].stderr);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  return "";
}
const fakeSkipReason = await buildFakeOpenCode();
const fixtureMetadata = () => ({ ok: true, metadata: internals.normalizeAgentDebugMetadata(structuredClone(fixtureAgentDebug), fixtureAgentName), pluginPolicy: { ok: true, mode: "pure", plugins: [] } });
const workCwd = path.join(scratch, "work");
await mkdir(workCwd, { recursive: true });
const pauseKey = modelPauseKeyForMetadata({ provider: "opencode", model: MUSE });
const clearPause = async () => {
  const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    db.prepare("DELETE FROM provider_cooldowns WHERE provider_key = ?").run(pauseKey);
    db.prepare("DELETE FROM provider_pause_strikes WHERE pause_key = ?").run(pauseKey);
  } finally {
    db.close();
  }
};

// Node children for the watcher-level cases (no compiler needed).
const childScript = path.join(scratch, "child.mjs");
await writeFile(childScript, `
const [mode] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = ${JSON.stringify({ final: logLine(), retried: logLine({ error: RETRIED_ERROR }), info: logLine({ level: "INFO" }), other: logLine({ model: "antigravity-gemini-3.8-flash" }) })};
const report = ${JSON.stringify(JSON.stringify({ type: "text", sessionID: "ses_b096", part: { type: "text", text: "The provider said: Rate limit exceeded. Please try again later. (HTTP 429)" } }))};
if (mode === "final-then-exit") { process.stderr.write(lines.final + "\\n"); await sleep(300); process.exit(1); }
if (mode === "retried") { process.stderr.write(lines.retried + "\\n"); await sleep(4500); }
if (mode === "no-trip") {
  process.stdout.write(${JSON.stringify(stepStart)} + "\\n" + report + "\\n");
  process.stderr.write("Rate limit exceeded. Please try again later.\\n" + lines.info + "\\n" + lines.other + "\\n");
  await sleep(4500);
}
`, "utf8");
const watch = (extra = {}) => ({ hits: 2, provider: "opencode", model: MUSE, agent: "builder", logPath: "", scanMs: 100, ...extra });
const spawnChild = (mode, options = {}) => runSpawnCommand(process.execPath, [childScript, mode], scratch, 60_000, null, options);

// ---------------------------------------------------------------------------
test("B-096: the real line is a final rate-limit hit; the retried wording and free text are not final", () => {
  const hit = openCodeRateLimitHit(logLine());
  assert.equal(hit.kind, "rate_limit");
  assert.equal(hit.final, true);
  assert.equal(hit.modelID, MUSE);
  assert.equal(openCodeRateLimitHit(logLine({ error: RETRIED_ERROR })).final, false, "OpenCode retries this one");
  assert.equal(openCodeRateLimitHit(logLine({ level: "INFO" })).final, false, "only an ERROR line is final");
  assert.equal(openCodeRateLimitHit("Rate limit exceeded. Please try again later."), null, "not a log line");
  assert.equal(openCodeRateLimitHit(`timestamp=2026-10-02T18:05:23.604Z level=ERROR run=x message="tool failed" directory="Rate limit exceeded. Please try again later."`), null, "the wording must be in the message or error fields");
});

test("B-096: the watcher trips once on the first final line after the grace, at the default hits 2 and spread 5 s", async () => {
  let trips = 0;
  const watcher = createRateLimitWatcher({ ...watch(), finalGraceMs: 100, onTrip: () => { trips += 1; } });
  watcher.stderrLine(logLine());
  assert.equal(trips, 0, "OpenCode gets the grace to end the run itself");
  await sleep(250);
  assert.equal(trips, 1);
  assert.equal(watcher.state.tripped, true);
  assert.equal(watcher.state.hits, 1);
  assert.equal(watcher.state.evidence.final, true);
  watcher.stderrLine(logLine({ at: "2026-10-02T18:05:30.000Z" }));
  assert.equal(trips, 1, "trips once");
  watcher.stop();
  // stop() (the run ended by itself) cancels a pending grace trip.
  let late = 0;
  const ended = createRateLimitWatcher({ ...watch(), finalGraceMs: 100, onTrip: () => { late += 1; } });
  ended.stderrLine(logLine());
  ended.stop();
  await sleep(250);
  assert.equal(late, 0);
  // hits 0 still turns the watch off.
  let off = 0;
  const disabled = createRateLimitWatcher({ ...watch({ hits: 0 }), finalGraceMs: 0, onTrip: () => { off += 1; } });
  disabled.stderrLine(logLine());
  disabled.stdoutLine(errorEvent());
  await sleep(50);
  assert.equal(off, 0);
});

test("B-096: a structured rate-limit error event trips; text events, another session and other providers do not", async () => {
  let trips = 0;
  const watcher = createRateLimitWatcher({ ...watch(), finalGraceMs: 0, onTrip: () => { trips += 1; } });
  watcher.stdoutText(stepStart);
  watcher.stdoutLine(stepStart);
  watcher.stdoutLine(JSON.stringify({ type: "text", sessionID: "ses_b096", part: { type: "text", text: "Rate limit exceeded. Please try again later. 429" } }));
  watcher.stdoutLine(JSON.stringify({ type: "tool_use", sessionID: "ses_b096", part: { tool: "bash", state: { status: "completed", output: "HTTP 429 rate limit" } } }));
  watcher.stdoutLine(JSON.stringify({ type: "error", sessionID: "ses_OTHER", error: { name: "APIError", data: { message: "Rate limit exceeded.", statusCode: 429 } } }));
  watcher.stdoutLine(JSON.stringify({ type: "error", sessionID: "ses_b096", error: { name: "APIError", data: { message: "Rate limit exceeded.", statusCode: 429, providerID: "google" } } }));
  watcher.stdoutLine(JSON.stringify({ type: "error", sessionID: "ses_b096", error: { name: "UnknownError", data: { message: "the agent mentioned a rate limit" } } }));
  await sleep(30);
  assert.equal(trips, 0);
  assert.equal(watcher.state.hits, 0);
  watcher.stdoutLine(errorEvent());
  await sleep(30);
  assert.equal(trips, 1);
  assert.equal(watcher.state.evidence.source, "stdout");
  assert.equal(watcher.state.evidence.modelID, MUSE);
  assert.match(watcher.state.evidence.detail, /APIError: Rate limit exceeded\. Please try again later\./);
  watcher.stop();
});

test("B-096: a run that logs the final line and exits by itself keeps its own result", async () => {
  const result = await spawnChild("final-then-exit", { rateLimitWatch: watch() });
  assert.equal(result.rateLimited, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.rateLimitHits, 1, "the line was seen");
});

test("B-096: the retried wording keeps the streak rule (one line does not stop a run that may recover)", async () => {
  const result = await spawnChild("retried", { rateLimitWatch: watch() });
  assert.equal(result.rateLimited, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.rateLimitHits, 1);
});

test("B-096: free text, an INFO line and another model's final line never stop the run", async () => {
  const result = await spawnChild("no-trip", { rateLimitWatch: watch() });
  assert.equal(result.rateLimited, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.rateLimitHits, 1, "the INFO line counts toward the streak as before (B-061), but is not final");
  assert.equal(result.rateLimitEvidence.final, false);
});

test("B-096: end to end, the real stderr line ends a silent run in seconds as provider_rate_limited and pauses the model", async () => {
  if (fakeSkipReason) skipTest(fakeSkipReason);
  assert.equal(CONFIG.rateLimitHits, 2, "the default watch, as in production");
  await clearPause();
  const started = Date.now();
  const result = await runOpenCode(fixtureAgentName, "B096_STDERR task", workCwd, false, 120_000, { agentMetadata: fixtureMetadata() });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `ended in ${elapsed} ms, not after the fake's 30 s sleep or the idle watchdog`);
  assert.equal(result.errorType, "provider_rate_limited", `${result.errorType}: ${result.stderr}`);
  assert.equal(result.rateLimited, true);
  assert.equal(result.rateLimitHits, 1);
  assert.equal(result.rateLimitEvidence.source, "stderr");
  assert.equal(result.rateLimitEvidence.final, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.rateLimitPause?.pauseKey, pauseKey);
  assert.equal(result.rateLimitPause?.strikes, 1);
  assert.ok(Date.parse(result.providerCooldownUntil) - Date.now() > 25 * 60_000, "paused for the first-strike 30 minutes");
  assert.match(rateLimitPauseReason(result), /^rate limit: final provider error for opencode\/muse-spark-1\.3-contributor-free, OpenCode did not retry \(stderr: stream error AI_APICallError: Rate limit exceeded\. Please try again later\.\)/);
  // The pause holds: the next run on the model is refused before the agent starts.
  const refusedAt = Date.now();
  const refused = await runOpenCode(fixtureAgentName, "B096_STDERR task", workCwd, false, 120_000, { agentMetadata: fixtureMetadata() });
  assert.equal(refused.errorType, "provider_rate_limited");
  assert.ok(Date.now() - refusedAt < 5000, "refused at the slot, not run");
  await clearPause();
});

test("B-096: end to end, a structured rate-limit error event on stdout ends a silent run the same way", async () => {
  if (fakeSkipReason) skipTest(fakeSkipReason);
  await clearPause();
  const started = Date.now();
  const result = await runOpenCode(fixtureAgentName, "B096_EVENT task", workCwd, false, 120_000, { agentMetadata: fixtureMetadata() });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `ended in ${elapsed} ms`);
  assert.equal(result.errorType, "provider_rate_limited", `${result.errorType}: ${result.stderr}`);
  assert.equal(result.rateLimitEvidence.source, "stdout");
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.rateLimitPause?.pauseKey, pauseKey);
  await clearPause();
});

let failed = 0;
const skips = [];
try {
  for (const { name, fn } of tests) {
    const started = Date.now();
    try {
      await fn();
      process.stdout.write(`ok   ${name} (${Date.now() - started} ms)\n`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skips.push({ name, reason: error.message });
        process.stdout.write(`skip ${name}: ${error.message}\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  hooks.stateDirectoryOverride = "";
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
removeIsolatedStateDir(isolatedStateDir);
const skipGateFailed = finishSkips({ file: "tests/review-b096-rate-limit-exit.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} B-096 tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} B-096 tests passed.\n`);
process.exit(0);
