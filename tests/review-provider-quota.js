#!/usr/bin/env node

// Regression tests for B-039..B-041 (log.md, 2026-10-01). The Antigravity auth plugin answered an
// exhausted Gemini account pool with a synthetic assistant text instead of an error event, so
// five builder jobs "completed" with no files and no error. The bridge now fails such a run as
// opencode_quota_exhausted, pauses the provider until the reported reset, and labels a queue job
// that waits for a provider slot.
//   node tests/review-provider-quota.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { strict: assert } = await import("node:assert");
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const internals = __selfTest.internals;

const scratch = await mkdtemp(path.join(tmpdir(), "review-provider-quota-"));
__selfTest.hooks.stateDirectoryOverride = scratch;

const sessionID = "ses_root";
const stream = (...texts) => [
  JSON.stringify({ type: "step_start", sessionID, part: { type: "step-start", sessionID } }),
  ...texts.map((text, index) => JSON.stringify({
    type: "text",
    sessionID,
    part: { type: "text", id: `prt_${index}`, messageID: `msg_${index}`, sessionID, text, time: { start: 1, end: 2 } },
  })),
].join("\n");
const QUOTA_TEXT = "All 2 account(s) rate-limited for gemini. Quota resets in 3h 55m. Add more accounts with `opencode auth login` or wait and retry.";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("B-039: the plugin's synthetic quota answer fails the run with the reset delay", () => {
  const inspection = internals.inspectOpenCodeEventStream(stream("Reading the brief first.", QUOTA_TEXT));
  assert.equal(inspection.finalResponseDetected, true);
  assert.equal(inspection.providerErrorType, "opencode_quota_exhausted");
  assert.equal(inspection.apiErrorDetected, true);
  assert.equal(inspection.retryAfterMs, (3 * 60 + 55) * 60_000);
  assert.equal(inspection.providerQuotaNotice.resetText, "3h 55m");
});

test("B-039: the soft-quota variant and other reset formats are recognised", () => {
  const soft = internals.syntheticProviderQuotaNotice("Quota protection: All 1 account(s) are over 90% usage for gemini. Quota resets in 12m 5s. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable.");
  assert.equal(soft?.resetMs, 12 * 60_000 + 5000);
  assert.equal(internals.syntheticProviderQuotaNotice("All 3 account(s) rate-limited for claude. Quota resets in 45s. Add more accounts.")?.resetMs, 45_000);
  assert.equal(internals.syntheticProviderQuotaNotice("All 2 account(s) rate-limited for gemini. Quota resets in unknown. Add more accounts.")?.resetMs, 0);
});

test("B-039: an agent answer that only talks about rate limits is not a provider failure", () => {
  const text = `Done. Note for the reviewer: the plugin can say "${QUOTA_TEXT}" when quota runs out.`;
  const inspection = internals.inspectOpenCodeEventStream(stream(text));
  assert.equal(inspection.providerErrorType, "");
  assert.equal(inspection.apiErrorDetected, false);
  assert.equal(internals.syntheticProviderQuotaNotice("All tests passed. Quota resets in 3h are not relevant here."), null);
});

test("B-040: a recorded quota pause fails new slot requests at once and shows in status", async () => {
  const key = `${internals.CONFIG.providerConcurrencyKey}:review-google`;
  const other = `${internals.CONFIG.providerConcurrencyKey}:review-opencode`;
  const recorded = await internals.recordProviderCooldown({ providerKey: key, durationMs: 60_000, errorType: "opencode_quota_exhausted", reason: "provider reported \"Quota resets in 1m\"" });
  assert.equal(recorded.recorded, true);
  // A shorter later pause never shortens the first one.
  await internals.recordProviderCooldown({ providerKey: key, durationMs: 1000, errorType: "opencode_quota_exhausted" });
  const started = Date.now();
  const blocked = await internals.acquireProviderLease({ providerKey: key, timeoutMs: 5000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorType, "opencode_quota_exhausted");
  assert.ok(Date.now() - started < 2000, "a paused provider must not wait for the slot budget");
  assert.ok(blocked.retryAfterMs > 50_000, `pause was shortened: ${blocked.retryAfterMs}`);
  assert.match(blocked.error, /paused until .*The agent was not started/);
  const snapshot = await internals.providerCapacitySnapshot();
  assert.equal(snapshot.ok, true, snapshot.error);
  const shown = snapshot.cooldowns.find((item) => item.providerKey === key);
  assert.ok(shown && shown.errorType === "opencode_quota_exhausted" && shown.remainingMs > 50_000, JSON.stringify(snapshot.cooldowns));
  const free = await internals.acquireProviderLease({ providerKey: other, timeoutMs: 5000 });
  assert.equal(free.ok, true, "another provider keeps its slots");
  await internals.releaseProviderLease(free.lease);
});

test("B-040: an expired pause is dropped and the provider takes jobs again", async () => {
  const key = "review-quota-expired:google";
  await internals.recordProviderCooldown({ providerKey: key, durationMs: 50, errorType: "opencode_quota_exhausted" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const lease = await internals.acquireProviderLease({ providerKey: key, timeoutMs: 5000 });
  assert.equal(lease.ok, true, lease.error);
  await internals.releaseProviderLease(lease.lease);
});

test("B-040: zero or missing reset time records no pause", async () => {
  assert.equal((await internals.recordProviderCooldown({ providerKey: "review-quota-zero:google", durationMs: 0, errorType: "opencode_quota_exhausted" })).recorded, false);
});

test("B-041: a queue job waiting for a provider slot has its own stage", () => {
  const record = { jobId: "builder-stage-test", status: "running", childProcessStartedAt: "" };
  assert.equal(internals.queueRunStage(record), "starting_agent");
  internals.providerSlotWaitingJobs.set(record.jobId, { providerKey: "k", since: new Date().toISOString() });
  try {
    assert.equal(internals.queueRunStage(record), "waiting_for_provider_slot");
    assert.equal(internals.queueRunStage({ ...record, childProcessStartedAt: new Date().toISOString() }), "agent_running");
  } finally {
    internals.providerSlotWaitingJobs.delete(record.jobId);
  }
});

test("B-039: a write job that changed nothing is flagged, not a plain success", () => {
  const record = internals.enforceQueueResultEvidence({ status: "completed", mode: "write", noChanges: true, resultText: "No change was needed.", changedFiles: [] });
  assert.equal(record.status, "completed");
  assert.equal(record.completionOutcome, "completed_no_changes");
  const reader = internals.enforceQueueResultEvidence({ status: "completed", mode: "read", resultText: "Review done.", changedFiles: [] });
  assert.equal(reader.completionOutcome || "", "");
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
  __selfTest.hooks.stateDirectoryOverride = "";
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-provider-quota.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} provider quota tests failed${skipGateFailed ? "; the skip gate failed" : ""}.\n`);
  process.exit(1);
}
process.stdout.write(`${tests.length - skips.length} of ${tests.length} provider quota tests passed${skips.length ? `, ${skips.length} skipped` : ""}.\n`);
process.exit(0);
