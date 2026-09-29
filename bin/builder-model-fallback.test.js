import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builderFallbackEligible, runBuilderModelFallback, terminationContained } from "./builder-model-fallback.js";

const failed = { configuredProvider: "opencode", configuredModel: "muse-spark-1.3-contributor-free",
  errorType: "opencode_rate_limited", streamIntegrity: "valid", treeTerminationConfirmed: true, toolOutcomes: [] };
const policy = { enabled: true, timeoutMs: 10000,
  fallbackRequirement: { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" } };

// The run result server.js builds on Windows after the bridge terminated a builder on a
// provider error: the supervisor never claims tree confirmation there.
const windowsTerminated = { ...failed, treeTerminationConfirmed: false, containmentGuarantee: "windows_taskkill_best_effort",
  terminationBestEffortSucceeded: true, terminationErrorType: "" };
// The payload exited on its own and its stdio closed.
const windowsNaturalExit = { ...failed, treeTerminationConfirmed: false, containmentGuarantee: "windows_direct_child_observed",
  terminationBestEffortSucceeded: false, terminationErrorType: "" };

test("only builder provider failure before any tool is eligible", () => {
  assert.equal(builderFallbackEligible("builder", failed, policy), true);
  for (const agent of ["build", "debugger", "planner", "mcp-sanitized-reader"]) {
    assert.equal(builderFallbackEligible(agent, failed, policy), false);
  }
  for (const patch of [{ errorType: null }, { errorType: "validation_failed" },
    { toolOutcomes: [{ tool: "edit", status: "running" }] }, { cancelled: true },
    { timedOut: true }, { streamIntegrity: "malformed" }, { treeTerminationConfirmed: false },
    { rawOutputTruncated: true }, { assistantFinalResponseDetected: true },
    { configuredModel: "another-model" }, { permissionDeniedCount: 1 }]) {
    assert.equal(builderFallbackEligible("builder", { ...failed, ...patch }, policy), false);
  }
  for (const patch of [{ enabled: false }, { forcePure: true }, { modelRequirement: policy.fallbackRequirement }]) {
    assert.equal(builderFallbackEligible("builder", failed, { ...policy, ...patch }), false);
  }
});

test("a contained Windows termination is eligible even though the tree is never confirmed there", () => {
  assert.equal(builderFallbackEligible("builder", windowsTerminated, policy), true);
  assert.equal(builderFallbackEligible("builder", windowsNaturalExit, policy), true);
});

test("an uncontained Windows termination is not eligible", () => {
  for (const patch of [
    { terminationBestEffortSucceeded: false },
    { terminationErrorType: "process_tree_termination_unconfirmed" },
  ]) {
    assert.equal(builderFallbackEligible("builder", { ...windowsTerminated, ...patch }, policy), false, JSON.stringify(patch));
  }
  assert.equal(builderFallbackEligible("builder", { ...windowsNaturalExit, terminationErrorType: "process_tree_termination_unconfirmed" }, policy), false);
  for (const containmentGuarantee of ["windows_exit_descendant_snapshot", "supervisor_unavailable", "direct_child_only", "", undefined]) {
    assert.equal(terminationContained({ ...windowsTerminated, containmentGuarantee }), false, String(containmentGuarantee));
  }
});

test("server.js passes the Windows containment fields into the run result", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /containmentGuarantee: result\.containmentGuarantee \|\| ""/);
  assert.match(server, /terminationBestEffortSucceeded: result\.terminationBestEffortSucceeded === true/);
});

test("one explicit fallback within the original budget, with recorded evidence", async () => {
  const calls = [];
  const result = await runBuilderModelFallback("builder", async (model, timeout) => {
    calls.push({ model, timeout });
    return calls.length === 1 ? failed : { ...failed, configuredProvider: "google", errorType: null };
  }, policy);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, null);
  assert.deepEqual(calls[1].model, policy.fallbackRequirement);
  assert.ok(calls[1].timeout <= calls[0].timeout);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(result.modelFallbackReason, failed.errorType);
  assert.equal(result.errorType, null);
});

test("failed fallback is returned without a third attempt; no allowlist means no fallback", async () => {
  let calls = 0;
  const result = await runBuilderModelFallback("builder", async () => { calls++; return failed; }, policy);
  assert.equal(calls, 2);
  assert.equal(result.errorType, failed.errorType);
  calls = 0;
  await runBuilderModelFallback("builder", async () => { calls++; return failed; }, { ...policy, fallbackRequirement: null });
  assert.equal(calls, 1);
});
