#!/usr/bin/env node

// B-131..B-134, Q-014a (2026-10-03 review of the rate-limit and provider-pause code).
// - B-131 / Q-014a: CODEX_OPENCODE_QUOTA_GROUPS works both ways. A rate limit of an OpenCode
//   provider (openai/<model>) pauses the external runner of its group (codex) and the reverse; the
//   retry chooser and the scheduler's pause-wait check see a group pause, so a job with models
//   ["codex/...", "openai/..."] waits instead of burning its pause-wait budget in seconds.
// - B-132: an unreadable provider database fails closed (no "nothing is paused").
// - B-133: a provider/model pause matches whatever the case of the model part.
// - B-134: resume_opencode_provider releases only the pause-waits whose models are free.
// Scratch state only; the fake opencode prints a real final rate-limit line and sleeps.
//   node tests/review-prod-quota.js
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
const scratch = mkdtempSync(path.join(tmpdir(), "review-prod-quota-"));
const fakeOpenCodeDir = path.join(scratch, "fake-opencode");
await mkdir(fakeOpenCodeDir, { recursive: true });
const fakeOpenCodeExecutable = path.join(fakeOpenCodeDir, process.platform === "win32" ? "opencode.exe" : "opencode");
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = path.join(scratch, "opencode.log");
process.env.XDG_CACHE_HOME = path.join(scratch, "xdg-cache");
process.env.CODEX_OPENCODE_EXECUTABLE = fakeOpenCodeExecutable;
process.env.CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS = "2000";
process.env.CODEX_OPENCODE_QUOTA_GROUPS = "chatgpt:codex,openai";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_HITS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS;
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-prod-quota");
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const { hooks, internals } = __selfTest;
const { CONFIG, QUEUE_JOBS, acquireProviderLease, activeProviderPauses, chooseRetryModel, modelPauseKeyForMetadata, openProviderLeaseDb, pauseProvider, providerCapacitySnapshot, quotaGroupProviderKeys, recordProviderCooldown, releaseProviderLease, releaseResumedPauseWaits, resumeProvider, runOpenCode } = internals;

const stateDir = path.join(scratch, "state");
await mkdir(stateDir, { recursive: true });
hooks.stateDirectoryOverride = stateDir;
// The scheduler stays idle: the tests drive the pause-wait check themselves.
hooks.queueModeOverride = "off";
await writeFile(process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH, "", "utf8");

const base = CONFIG.providerConcurrencyKey;
const codexKey = `${base}:codex`;
const openaiKey = `${base}:openai`;
const SOL = "gpt-6.1-sol";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const skipTest = (reason) => { throw new SkipTest(reason); };
const resumeAll = async () => { for (const provider of ["codex", "openai", "google", "opencode"]) await resumeProvider({ provider }); };
const policy = (...specs) => ({ models: specs.map((spec) => { const [provider, model] = spec.split("/"); return { spec, provider, model, variant: "" }; }), maxAttempts: 3 });
const waitingRecord = (jobId, models) => {
  const record = { jobId, status: "pending", startAfter: new Date(Date.now() + 30 * 60_000).toISOString(), startAfterReason: "provider_pause", request: { models } };
  QUEUE_JOBS.set(jobId, record);
  return record;
};

// ---------------------------------------------------------------------------
// Fake opencode (the B-096 test's shape) on openai/gpt-6.1-sol.
const fixtureAgentName = "fixture-agent";
const fixtureAgentDebug = {
  name: fixtureAgentName,
  mode: "primary",
  model: { providerID: "openai", modelID: SOL },
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
const stepStart = JSON.stringify({ type: "step_start", sessionID: "ses_q014" });
const finalLine = `timestamp=2026-10-03T08:00:00.000Z level=ERROR run=q014 message="stream error" providerID=openai modelID=${SOL} session.id=ses_q014 small=false agent=${fixtureAgentName} mode=all error.error="AI_APICallError: Rate limit exceeded. Please try again later."`;
const outputs = { Q014_RATE: { stdout: `${stepStart}\n`, stderr: `${finalLine}\n` } };
async function buildFakeOpenCode() {
  if (process.platform === "win32") {
    const source = path.join(fakeOpenCodeDir, "opencode.c");
    await writeFile(source, [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <windows.h>",
      "int main(int argc, char **argv) {",
      "  for (int i = 1; i + 1 < argc; i += 1) { if (strcmp(argv[i], \"debug\") == 0 && strcmp(argv[i + 1], \"agent\") == 0) {",
      `    fputs(${JSON.stringify(JSON.stringify(fixtureAgentDebug))}, stdout); return 0; } }`,
      "  const char *prompt = argc > 1 ? argv[argc - 1] : \"\";",
      "  if (strstr(prompt, \"Q014_RATE\")) {",
      `    fputs(${JSON.stringify(outputs.Q014_RATE.stdout)}, stdout); fflush(stdout);`,
      `    fputs(${JSON.stringify(outputs.Q014_RATE.stderr)}, stderr); fflush(stderr);`,
      "    Sleep(30000); return 0; }",
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

// ---------------------------------------------------------------------------
test("Q-014a: quotaGroupProviderKeys names every member's slot key for any provider of the group", () => {
  assert.deepEqual(quotaGroupProviderKeys("openai"), [codexKey, openaiKey]);
  assert.deepEqual(quotaGroupProviderKeys("Codex"), [codexKey, openaiKey]);
  assert.deepEqual(quotaGroupProviderKeys("google"), [], "not in a group");
  assert.deepEqual(quotaGroupProviderKeys(""), []);
});

test("B-131: an OpenCode provider pause holds the runner of its group in the retry chooser and the pause-wait check", async () => {
  await resumeAll();
  const free = await chooseRetryModel(policy("codex/gpt-6.1", "openai/gpt-6.1-sol"), 0);
  assert.deepEqual(free, { spec: "codex/gpt-6.1", startAfter: "" });
  const paused = await recordProviderCooldown({ providerKey: openaiKey, durationMs: 20 * 60_000, errorType: "provider_rate_limited", reason: "test" });
  assert.equal(paused.recorded, true);
  // Both candidates are held: codex through the group. The job waits for the pause to end
  // instead of picking codex, being refused at the slot by the group key and rotating.
  const chosen = await chooseRetryModel(policy("codex/gpt-6.1", "openai/gpt-6.1-sol"), 0);
  assert.ok(chosen.startAfter, `codex was seen as free: ${JSON.stringify(chosen)}`);
  assert.ok(Math.abs(Date.parse(chosen.startAfter) - paused.untilAt) < 2000);
  const record = waitingRecord("q014-codex-wait", ["codex/gpt-6.1"]);
  try {
    assert.equal(await releaseResumedPauseWaits(Date.now(), { force: true }), 0, "the codex wait is held by the openai pause");
    assert.ok(record.startAfter);
  } finally {
    QUEUE_JOBS.delete(record.jobId);
    await resumeAll();
  }
});

test("B-131: a runner's pause (codex) refuses an OpenCode openai run at the slot, before the agent starts", async () => {
  await resumeAll();
  // What a codex rate limit records (lib/external-runners.js: the group's provider keys).
  await recordProviderCooldown({ providerKey: codexKey, durationMs: 20 * 60_000, errorType: "provider_rate_limited", reason: "quota group of codex: test" });
  try {
    const started = Date.now();
    const refused = await runOpenCode(fixtureAgentName, "Q014_RATE task", workCwd, false, 60_000, { agentMetadata: fixtureMetadata() });
    assert.equal(refused.errorType, "provider_rate_limited", refused.stderr);
    assert.match(refused.stderr, new RegExp(`Provider ${codexKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is paused until`));
    assert.ok(Date.now() - started < 5000, "refused at the slot, not run");
    // Resuming codex ends the group's provider pauses with it (openai holds codex and the reverse).
    await recordProviderCooldown({ providerKey: openaiKey, durationMs: 20 * 60_000, errorType: "provider_rate_limited", reason: "quota group of codex: test" });
    const resumed = await resumeProvider({ provider: "codex" });
    assert.deepEqual(resumed.removed.map((item) => item.providerKey).sort(), [codexKey, openaiKey]);
    const lease = await acquireProviderLease({ providerKey: openaiKey, pauseKeys: quotaGroupProviderKeys("openai"), timeoutMs: 2000 });
    assert.equal(lease.ok, true, lease.error);
    await releaseProviderLease(lease.lease);
  } finally {
    await resumeAll();
  }
});

test("B-131: an OpenCode openai rate limit pauses codex too (end to end)", async () => {
  if (fakeSkipReason) skipTest(fakeSkipReason);
  await resumeAll();
  try {
    const result = await runOpenCode(fixtureAgentName, "Q014_RATE task", workCwd, false, 120_000, { agentMetadata: fixtureMetadata() });
    assert.equal(result.errorType, "provider_rate_limited", `${result.errorType}: ${result.stderr}`);
    assert.equal(result.rateLimitPause?.pauseKey, modelPauseKeyForMetadata({ provider: "openai", model: SOL }));
    assert.deepEqual(result.rateLimitPause?.groupKeys, [codexKey, openaiKey]);
    const pauses = await activeProviderPauses();
    assert.ok(pauses.get(codexKey) > Date.now() + 25 * 60_000, "codex paused for the first-strike 30 minutes");
    assert.equal(pauses.get(codexKey), pauses.get(openaiKey));
    const codex = await acquireProviderLease({ providerKey: codexKey, pauseKeys: quotaGroupProviderKeys("codex"), timeoutMs: 2000 });
    assert.equal(codex.ok, false);
    assert.equal(codex.errorType, "provider_rate_limited");
  } finally {
    await resumeAll();
  }
});

test("B-132: an unreadable provider database fails closed: no unpaused reading, waits are kept", async () => {
  await resumeAll();
  const record = waitingRecord("q014-db-wait", ["google/gemini-x"]);
  const brokenState = path.join(scratch, "broken-state");
  // The database path is a folder: openProviderLeaseDb refuses it, the snapshot reports ok: false.
  await mkdir(path.join(brokenState, "provider-concurrency.sqlite"), { recursive: true });
  hooks.stateDirectoryOverride = brokenState;
  try {
    const snapshot = await providerCapacitySnapshot();
    assert.equal(snapshot.ok, false);
    await assert.rejects(activeProviderPauses(), /provider pauses could not be read/);
    const before = Date.now();
    const chosen = await chooseRetryModel(policy("google/gemini-x", "openai/gpt-6.1-sol"), 0);
    assert.equal(chosen.spec, "google/gemini-x", "the attempt's own model");
    assert.ok(Date.parse(chosen.startAfter) >= before + Math.min(250, CONFIG.queueBlockedPollMs) - 5, `held back: ${chosen.startAfter}`);
    assert.equal(await releaseResumedPauseWaits(Date.now(), { force: true }), 0);
    assert.ok(record.startAfter, "the wait is kept");
  } finally {
    hooks.stateDirectoryOverride = stateDir;
    QUEUE_JOBS.delete(record.jobId);
  }
});

test("B-132: the snapshot is a read: an expired lease is skipped, not deleted outside a transaction", async () => {
  const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("q014-expired", `${base}:google`, "other-instance", 1, Date.now() - 10_000, Date.now() - 10_000, Date.now() - 1000);
  } finally {
    db.close();
  }
  const snapshot = await providerCapacitySnapshot();
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.leases.some((lease) => lease.leaseId === "q014-expired"), false);
  assert.equal(snapshot.allLeaseCount, 0);
  const check = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    assert.equal(Number(check.prepare("SELECT COUNT(*) AS count FROM provider_leases WHERE lease_id = 'q014-expired'").get().count), 1, "left for acquireProviderLease");
  } finally {
    check.close();
  }
  const lease = await acquireProviderLease({ providerKey: `${base}:google`, timeoutMs: 2000 });
  assert.equal(lease.ok, true, lease.error);
  await releaseProviderLease(lease.lease);
});

test("B-133: a provider/model pause matches whatever the case of the model part, in pause and resume", async () => {
  await resumeAll();
  const runKey = modelPauseKeyForMetadata({ provider: "opencode", model: "muse-spark-1.3-contributor-free" });
  assert.equal(modelPauseKeyForMetadata({ provider: "OpenCode", model: "Muse-Spark-1.3-Contributor-Free" }), runKey);
  const paused = await pauseProvider({ provider: "opencode/Muse-Spark-1.3-Contributor-Free", minutes: 5 });
  assert.equal(paused.ok, true, paused.error);
  assert.equal(paused.key, runKey);
  const refused = await acquireProviderLease({ providerKey: `${base}:opencode`, pauseKeys: [runKey], timeoutMs: 2000 });
  assert.equal(refused.errorType, "provider_paused");
  const resumed = await resumeProvider({ provider: "opencode/MUSE-SPARK-1.3-CONTRIBUTOR-FREE" });
  assert.equal(resumed.removed.length, 1);
  // A row stored with its original case before the fix is found by the resume as well.
  const db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
  try {
    db.prepare("INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)")
      .run(`${base}:opencode/Muse-Spark-1.3-Contributor-Free`, Date.now() + 60_000, "provider_paused", "old row", Date.now());
  } finally {
    db.close();
  }
  assert.equal((await resumeProvider({ provider: "opencode/muse-spark-1.3-contributor-free" })).removed.length, 1);
});

test("B-134: a resume releases only the pause-waits whose models are no longer paused", async () => {
  await resumeAll();
  const google = waitingRecord("q014-google-wait", ["google/gemini-x"]);
  const opencode = waitingRecord("q014-opencode-wait", ["opencode/muse-spark-1.3-contributor-free"]);
  try {
    assert.equal((await pauseProvider({ provider: "google", minutes: 10 })).ok, true);
    assert.equal((await pauseProvider({ provider: "opencode", minutes: 10 })).ok, true);
    const resumed = await resumeProvider({ provider: "opencode" });
    assert.equal(resumed.released, 1);
    assert.equal(opencode.startAfter, undefined, "its model is free");
    assert.ok(google.startAfter, "google is still paused: the wait stays");
    assert.equal(google.startAfterReason, "provider_pause");
  } finally {
    QUEUE_JOBS.delete(google.jobId);
    QUEUE_JOBS.delete(opencode.jobId);
    await resumeAll();
  }
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
const skipGateFailed = finishSkips({ file: "tests/review-prod-quota.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} production quota tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} production quota tests passed.\n`);
process.exit(0);
