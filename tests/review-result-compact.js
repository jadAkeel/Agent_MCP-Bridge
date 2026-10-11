#!/usr/bin/env node
// Focused single-result view checks. No server startup, provider or live state.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSingleResultViews, createResultFormatRuntime } from "../lib/result-format.js";
import { createDirectRunAudit, ensureDirectRunAuditSchema } from "../bin/direct-run-audit.js";
import { createStateCrypto } from "../lib/state/crypto.js";
import { queueResultFields } from "../lib/queue.js";
import { createQueueStoreRuntime } from "../lib/queue/store.js";
import { redactSensitiveText } from "../lib/redaction.js";
import { truncateResultText, truncateText } from "../lib/result-text.js";
import { fitResultParts } from "../lib/result-text.js";
import { createWorktreeRuntime } from "../lib/worktrees.js";
import { finishSkips } from "./skip-gate.js";

const root = await mkdtemp(path.join(tmpdir(), "bridge-result-compact-"));
const formatter = createResultFormatRuntime({
  CONFIG: { queueResultMaxChars: 24_000 },
  formatHeavyToolCalls: () => "", formatOpenCodeUsage: (usage) => `steps=${usage?.steps || 0}`,
  formatPhaseTimings: () => null,
  formatReadOnlyHeadMove: (move) => move ? `Read-only HEAD moved: ${move.from} -> ${move.to}` : null,
  rateLimitPauseReason: (result) => `${result.rateLimitHits} rate-limit lines`,
  summarizeStderr: (stderr) => String(stderr || "").trim(),
  truncateResultText,
});
const resolution = { requestedAgent: "explore", actualAgent: "explore", requestedAgentMode: "subagent" };
const report = Array.from({ length: 11 }, (_, index) => `Section ${index + 1}\nNone\n`).join("\n");
const normal = { stdout: report, stderr: "", configuredProvider: "fixture", configuredModel: "model-a", configuredVariant: "high",
  assistantFinalResponseDetected: true, modelAttested: true, streamIntegrity: "valid", changedFiles: [], exitCode: 0,
  durationMs: 100, childStartedAtMs: 1000, childFinishedAtMs: 1100, phaseTimings: { totalMs: 150 }, usage: { steps: 2 } };
const accepted = "\nWrite lock verification:\nAccepted. Detected changed files stayed inside allowedEdits and did not touch forbidden/shared paths.";
function viewsFor(overrides = {}, options = {}) {
  const result = { ...normal, ...overrides };
  const singleParts = formatter.formatSingleResultParts({ resolution, result, cwd: root });
  return buildSingleResultViews({
    runId: "result-fixture", compactLines: formatter.compactJobLines({ resolution, result, unsafeFiles: options.unsafeFiles || [] }),
    singleParts, lockLines: ["Temporary lock acquired: none", "Temporary lock released: not needed"],
    lockViolation: accepted,
    verifications: [
      { text: "\nOpenCode native fallback verification:\nAccepted. No native fallback detected.", rejected: false },
      { text: "\nOpenCode API error verification:\nAccepted. No OpenCode API error detected.", rejected: false },
      { text: "\nOpenCode final response verification:\nAccepted. A terminal assistant response was detected.", rejected: false },
    ],
    validationGateText: "Validation gate: skipped", compactValidationGateText: "",
    ...options,
  });
}
const cases = [];
const test = (name, run) => cases.push({ name, run });

test("full preamble filters null entries and preserves its intentional blank strings", () => {
  const parts = formatter.formatSingleResultParts({ resolution, result: normal, cwd: root });
  assert.equal(parts.preamble.split("\n").filter(line => line === "").length, 2);
  assert.match(parts.preamble, /\n\nTool outcomes: none\n$/);
  assert.match(formatter.formatSingleResult({ resolution, result: normal, cwd: root }), /Assistant final response:\nSection 1/);
});

test("normal explore is under 50 lines with its intact report and decision verdicts", () => {
  const views = viewsFor();
  assert.ok((views.compact + "\nDirect run audit: result-fixture; terminal metadata persisted.").split("\n").length < 50);
  for (const text of ["Run id: result-fixture", "Agent: explore", "Status: completed", "Files changed: none detected", "Unsafe changed files: none detected", "Write lock verification: Accepted.", report]) assert.ok(views.compact.includes(text), text);
  for (const text of ["Requested agent mode:", "Fallback used: no", "STDERR summary:", "Validation gate: skipped", "Temporary lock acquired: none", "Worktree: not used"]) assert.ok(!views.compact.includes(text), text);
  assert.ok(views.full.includes("Requested agent mode: subagent"));
  assert.ok(views.detailText.includes("OpenCode API error verification:\nAccepted."));
  assert.ok(views.full.includes(report));
});

test("writer response keeps patch and complete worktree evidence; stored default omits patch", () => {
  const patch = "diff --git a/src/a.js b/src/a.js\n+const answer = 42;";
  const summary = "Worktree path: C:/scratch/writer\nWorktree branch: bridge/writer\nWorktree cleanup: retained\nWorktree cleanup reason: changes retained for review\nWorktree tolerated unrelated source changes (disjoint): README.md\nWorktree base: repository HEAD moved during creation\nWorktree changed files: src/a.js\nWorktree diff stat:\n src/a.js | 1 +";
  const views = viewsFor({ changedFiles: ["src/a.js"] }, {
    hasWorktree: true, lockRequired: true,
    lockLines: ["Temporary lock acquired: writer-lock", "Temporary lock released: yes"],
    worktreeReview: `${summary}\nWorktree patch preview:\n${patch}`,
    worktreeReviewWithoutPatch: `${summary}\n${formatter.patchPreviewOmittedLine(patch.length)}`,
  });
  for (const text of [summary, patch, "Temporary lock released: yes"]) assert.ok(views.compact.includes(text), text);
  assert.ok(views.full.includes(patch));
  assert.ok(views.detailText.includes(patch));
  const fitted = formatter.fitRedactedJobResult(views.storedParts);
  assert.ok(!fitted.text.includes("+const answer = 42"));
  assert.ok(fitted.text.includes("get_opencode_job with detail: true"));
  assert.ok(fitted.text.includes("Worktree changed files: src/a.js"));
  const fields = queueResultFields({ resultRecord: { ...fitted, detailText: views.detailText } });
  assert.equal(fields.resultText, fitted.text);
  assert.equal(fields.resultDetailText, views.detailText);
});

test("compact failures retain rejection, rollback, quarantine, validation and dependency marker", () => {
  const request = { reason: "required fixture dependency", packages: [{ name: "fixture" }] };
  const views = viewsFor({ errorType: "worktree_changed_file_validation_error", stderr: "failure stderr",
    changedFiles: ["outside.js"], readOnlyHeadMove: { from: "old", to: "new" }, dependencyRequest: request,
    stdout: "REPORT START\n" + "Finding\n".repeat(1500) + `DEPENDENCY_REQUIRED ${JSON.stringify(request)}\nREPORT END`,
  }, {
    unsafeFiles: ["outside.js"], lockRequired: true,
    lockLines: ["Temporary lock acquired: lock-id", "Temporary lock released: no (containment quarantined; quarantine unconfirmed)"],
    lockViolation: "\nWrite lock verification:\nOpenCode result rejected.\nerrorType: worktree_changed_file_validation_error\nrollback: failed\nunresolvedFiles: outside.js",
    driftLine: "Checkout changed during this read-only run; review may describe older files.",
    verifications: [{ text: "\nOpenCode API error verification:\nRejected. API error received.", rejected: true }],
    compactValidationGateText: "Self-checks: failed\nValidation fix pass: skipped (cancelled)\nValidation gate: failed\nValidation stderr:\ncheck failed",
  });
  for (const text of ["error type: worktree_changed_file_validation_error", "Unsafe changed files: outside.js", "unresolvedFiles: outside.js", "quarantine unconfirmed", "API error received", "Self-checks: failed", "check failed", "Read-only HEAD moved", "failure stderr", "REPORT END"]) assert.ok(views.compact.includes(text), text);
  const fitted = formatter.fitRedactedJobResult(views.storedParts, 2400);
  assert.ok(fitted.reportTruncated);
  for (const text of ["REPORT START", "unresolvedFiles: outside.js", "check failed", "Unsafe changed files: outside.js"]) assert.ok(fitted.text.includes(text), text);
  assert.match(fitted.text, /^DEPENDENCY_REQUIRED$/m, "dependency decision survives cutting the report end");
  assert.ok(!fitted.text.includes("REPORT END"));
});

test("caller wait limits, provider failures, rate-limit pause and unenforced role stay visible", () => {
  const text = formatter.compactJobLines({ resolution, result: { ...normal, errorType: "provider_slot_wait_limit_exceeded",
    providerWaitBudget: { requestedMaxWaitMs: 5000, effectiveMaxWaitMs: 3000, maxWaitMsClamped: true },
    providerWaitInfo: { holders: [{ jobId: "holder-id", pid: 123 }], waitedMs: 3000 }, providerErrorType: "provider_rate_limited",
    rateLimited: true, rateLimitHits: 3, rateLimitPause: { pauseKey: "fixture:default", until: "tomorrow", strikes: 2 },
    externalRunner: "codex", roleEnforcement: "none (runner codex)", targetCheckoutGuard: { checked: false },
    runnerSidecarDir: "C:/scratch/sidecar", permissionDeniedCount: 1, modelFallbackUnavailableReason: "both models paused",
  } }).join("\n");
  for (const token of ["provider_slot_wait_limit_exceeded", "clamped from 5000", "holder-id", "provider_rate_limited", "fixture:default paused until tomorrow (pause 2)", "Role enforcement: none", "not checked", "Permission denials observed: 1", "original pause preserved"]) assert.ok(text.includes(token), token);
});

test("hundreds of unsafe paths do not displace the stored report or its rejection verdict", () => {
  const unsafeFiles = Array.from({ length: 500 }, (_, index) => `outside/${String(index).padStart(3, "0")}-${"x".repeat(25)}.js`);
  const rejection = { headline: "OpenCode result rejected.", errorType: "worktree_changed_file_validation_error",
    conflictingPaths: unsafeFiles, disallowedFiles: unsafeFiles, unresolvedFiles: unsafeFiles, rollback: "failed" };
  const views = viewsFor({ changedFiles: unsafeFiles, stdout: "REPORT START\nCritical report evidence.\nREPORT END" }, {
    unsafeFiles, lockViolation: `\nWrite lock verification:\n${formatter.formatRejectedExecution({ ...rejection, compactPaths: false })}`,
    compactLockViolation: `\nWrite lock verification:\n${formatter.formatRejectedExecution({ ...rejection, compactPaths: true })}`,
  });
  const line = views.compact.split("\n").find(line => line.startsWith("Unsafe changed files:"));
  assert.ok(line.includes(unsafeFiles[39])); assert.ok(!line.includes(unsafeFiles[40])); assert.match(line, /\(\+460 more\)/);
  const fitted = formatter.fitRedactedJobResult(views.storedParts, 12_000);
  assert.equal(fitted.reportTruncated, false);
  for (const evidence of ["REPORT END", "OpenCode result rejected.", "worktree_changed_file_validation_error", "rollback: failed", "(+460 more)"]) assert.ok(fitted.text.includes(evidence), evidence);
  assert.ok(views.detailText.includes(unsafeFiles.at(-1)), "full detail keeps all underlying rejection evidence");
});

test("dependency absence and bare headings add no request marker; malformed payload keeps one", () => {
  for (const stdout of ["DEPENDENCY_REQUIRED None.", "DEPENDENCY_REQUIRED\nNone."]) {
    const lines = formatter.compactJobLines({ resolution, result: { ...normal, stdout } });
    assert.ok(!lines.includes("DEPENDENCY_REQUIRED"), stdout);
    assert.ok(!lines.some(line => line.startsWith("Dependency request:")), stdout);
  }
  const lines = formatter.compactJobLines({ resolution, result: { ...normal,
    stdout: "DEPENDENCY_REQUIRED fixture", dependencyRequestError: "DEPENDENCY_REQUIRED payload is not valid single-line JSON." } });
  assert.ok(lines.includes("DEPENDENCY_REQUIRED"));
  assert.ok(lines.some(line => line.startsWith("Dependency request error:")));
});

test("view assembly preserves the report and redaction precedes fitting every response view", () => {
  const views = viewsFor({ stdout: "REPORT START\npassword = getpass()\nREPORT END", runnerSidecarDir: "https://fixture.invalid/?api_key=fixture-secret" });
  assert.ok(views.compact.includes("password = getpass()"));
  assert.ok(views.full.includes("password = getpass()"));
  for (const parts of [views.storedParts, views.compactParts, views.fullParts]) {
    const fitted = formatter.fitRedactedJobResult(parts, 1200);
    assert.ok(fitted.text.includes("password = [redacted]"));
    assert.ok(!fitted.text.includes("fixture-secret"));
    assert.ok(fitted.text.length <= 1200);
  }
  assert.ok(!redactSensitiveText(views.detailText).includes("fixture-secret"));
});

const crypto = createStateCrypto({ effectiveBridgeStateDirectory: () => root, assertNoLinkedPath: async () => {}, CONFIG: { maxSnapshotFileBytes: 1_000_000 } });
function auditStore(maxResultChars = 24_000) {
  return createDirectRunAudit({
    openDb: async () => { const db = new DatabaseSync(path.join(root, "audit.sqlite")); ensureDirectRunAuditSchema(db); return db; },
    closeDb: db => db.close(), resolveProjectRoot: async () => root, redact: redactSensitiveText, instanceId: "result-fixture",
    sealText: (text, runId) => crypto.encryptIntegrationJournalBytes(Buffer.from(text), runId),
    openText: async (text, runId) => (await crypto.decryptIntegrationJournalBytes(text, runId)).toString(), maxResultChars,
  });
}

test("SQLite audit preserves compact/default and complete redacted sealed detail", async () => {
  const store = auditStore();
  const views = viewsFor({ stdout: "REPORT MARKER", commandShape: "opencode run api_key=fixture-secret" });
  const fitted = formatter.fitRedactedJobResult(views.storedParts);
  const handle = await store.start({ agent: "explore", cwd: root }, { runId: "compact-audit" });
  await store.finish(handle, { execution: { result: normal, resultRecord: { ...fitted, detailText: redactSensitiveText(views.detailText) } } });
  const stored = await store.get(root, "compact-audit", { includeResult: true });
  assert.equal(stored.result.text, fitted.text);
  assert.ok(stored.result.detailText.includes("Requested agent: explore"));
  assert.ok(stored.result.detailText.includes("OpenCode final response verification:"));
  assert.ok(!stored.result.detailText.includes("fixture-secret"));
  assert.equal(stored.result.detailTruncated, false);
  const db = new DatabaseSync(path.join(root, "audit.sqlite"));
  try {
    const sealed = db.prepare("SELECT result_sealed AS sealed FROM opencode_direct_runs WHERE run_id = ?").get("compact-audit").sealed;
    assert.ok(!sealed.includes("REPORT MARKER"));
    assert.ok(!sealed.includes("Requested agent"));
    assert.ok(!sealed.includes("fixture-secret"));
  } finally { db.close(); }
});

test("exhausted audit cap protects compact report and explicitly flags omitted detail", async () => {
  const store = auditStore(1200);
  const views = viewsFor({ stdout: "REPORT START\n" + "Finding\n".repeat(1000) + "REPORT END" });
  const fitted = formatter.fitRedactedJobResult(views.storedParts, 1200);
  const handle = await store.start({ agent: "explore", cwd: root }, { runId: "bounded-audit" });
  await store.finish(handle, { execution: { result: normal, resultRecord: { ...fitted, detailText: views.detailText } } });
  const stored = (await store.get(root, "bounded-audit", { includeResult: true })).result;
  assert.ok(stored.text.includes("REPORT START"));
  assert.ok(stored.text.includes("Run id: result-fixture"));
  assert.ok(stored.reportTruncated);
  assert.ok(stored.detailTruncated);
  assert.equal(stored.detailText, "");
  assert.ok(stored.text.length + stored.detailText.length <= 1200);
});

test("queue private results cap each view independently and keep redacted encrypted failure detail", async () => {
  const queue = createQueueStoreRuntime({
    CONFIG: { queueResultMaxChars: 1200, maxSnapshotFileBytes: 1_000_000 },
    truncateResultText, truncateText,
    encryptIntegrationJournalBytes: crypto.encryptIntegrationJournalBytes,
    decryptIntegrationJournalBytes: crypto.decryptIntegrationJournalBytes,
  });
  const views = viewsFor({ stdout: "FAILED REPORT START\n" + "Finding\n".repeat(1000) + "FAILED REPORT END",
    errorType: "validation_command_failed", commandShape: "opencode run api_key=fixture-queue-secret" }, {
    compactValidationGateText: "Validation gate: failed\nValidation stderr:\nfixture validation failure",
  });
  const fitted = formatter.fitRedactedJobResult(views.storedParts, 1200);
  const record = { jobId: "compact-queue", status: "failed", mode: "write", maxAttempts: 1, retryAttempt: 1,
    errorType: "validation_command_failed", errorReason: "validation failed api_key=fixture-queue-secret",
    ...queueResultFields({ resultRecord: { ...fitted, detailText: views.detailText } }),
  };
  const privateDetails = queue.queuePrivateDetails(record);
  assert.ok(privateDetails.resultText.includes("FAILED REPORT START"));
  assert.ok(privateDetails.resultText.includes("fixture validation failure"));
  assert.ok(privateDetails.resultTextTruncated);
  assert.ok(privateDetails.resultDetailText.includes("Requested agent: explore"));
  assert.ok(privateDetails.resultDetailTextChars > privateDetails.resultDetailText.length);
  assert.ok(privateDetails.resultText.length <= 1200 && privateDetails.resultDetailText.length <= 1200);
  assert.ok(privateDetails.resultText.length + privateDetails.resultDetailText.length > 1200, "queue keeps separate view caps; audit alone has a combined cap");
  assert.ok(!JSON.stringify(privateDetails).includes("fixture-queue-secret"));
  const envelope = await queue.encryptQueuePrivateDetails(record);
  assert.ok(!envelope.includes("FAILED REPORT START"));
  assert.ok(!envelope.includes("fixture-queue-secret"));
  assert.deepEqual(await queue.decryptQueuePrivateDetails(envelope, record.jobId), privateDetails);
  assert.equal(queue.enforceQueueResultEvidence(record).status, "failed");
  assert.equal(record.errorType, "validation_command_failed");
});

test("parallel fitting can reuse redacted report/head with byte-identical output", () => {
  for (const credential of ["password = fixture-secret", "api_key=fixture-secret", "https://fixture.invalid/?token=fixture-secret", "Authorization: Bearer fixture-secret"]) {
    const original = { head: `JOB 1\nRun id: fixture\n${credential}`, report: `Assistant final response:\n${credential}\n` + "finding\n".repeat(6000), tail: `Validation: ${credential}` };
    const redacted = formatter.fitRedactedJobResult(original);
    for (const limit of [1200, 24000]) {
      const parts = { ...redacted.parts, tail: `${redacted.parts.tail}\nBridge detail:\n${credential}` };
      assert.equal(fitResultParts({ ...parts, tail: redactSensitiveText(parts.tail) }, limit).text, formatter.fitRedactedJobResult(parts, limit).text);
    }
  }
});

test("production truncators and report fitter preserve cap and honest flags at boundaries", () => {
  for (const limit of [0, 1, 15, 199, 1200, 24000]) {
    assert.ok(truncateText("d".repeat(24001), limit).length <= limit);
    assert.ok(truncateResultText("d".repeat(24001), limit).length <= limit);
  }
  const report = Array.from({ length: 1000 }, (_, n) => `Report line ${String(n).padStart(4, "0")}:x`).join("\n");
  const fitted = formatter.fitJobResultText({ head: "h".repeat(3000), report, tail: "t".repeat(21000) });
  assert.ok(fitted.text.includes(report));
  assert.equal(fitted.reportTruncated, false);
  assert.ok(fitted.text.length <= 24000);
  const short = formatter.fitJobResultText({ head: "h".repeat(24000), report: "REPORT" });
  assert.ok(short.text.includes("REPORT"));
  assert.equal(short.reportTruncated, false);
});

test("parallel diff collection skips preview formatting and retains the patch identity and stat", async () => {
  let previews = 0;
  const patch = { ok: true, changedFiles: ["a.js"], patch: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
    patchSha256: "fixture-patch", sourceStateSha256: "fixture-state", baseCommit: "fixture-base", sourceHead: "fixture-head" };
  const runtime = createWorktreeRuntime({ CONFIG: {}, createPatchFromWorkingTree: async () => patch,
    truncateText: (...args) => { previews++; return truncateText(...args); } });
  const direct = await runtime.collectWorktreeDiff({ path: root });
  const parallel = await runtime.collectWorktreeDiff({ path: root }, { includePatchPreview: false });
  assert.equal(previews, 1, "only the direct run formats a preview");
  assert.ok(direct.patchPreview.includes("diff --git"));
  assert.equal(parallel.patchPreview, "");
  assert.deepEqual({ ...direct, patchPreview: "" }, parallel);
});

let failed = 0;
try {
  for (const { name, run } of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name, error); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
finishSkips({ file: "tests/review-result-compact.js", total: cases.length, skips: [] });
console.log(`${cases.length - failed}/${cases.length} compact-result tests passed.`);
if (failed) process.exitCode = 1;
