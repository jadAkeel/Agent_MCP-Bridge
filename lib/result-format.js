// Result formatting: single-run reports, compact job lines, fitted result text and rejected-execution answers.
// Extracted from server.js in modularization round M-001.

import { directRunMetrics } from "../bin/direct-run-audit.js";
import { normalizeLockPathList } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";
import { fitResultParts, truncateText } from "./result-text.js";

export const COMPACT_FILE_LIST_LIMIT = 40;
export function compactFileList(files, separator = ", ") {
  const list = Array.isArray(files) ? files : [];
  return list.length > COMPACT_FILE_LIST_LIMIT
    ? `${list.slice(0, COMPACT_FILE_LIST_LIMIT).join(separator)} (+${list.length - COMPACT_FILE_LIST_LIMIT} more)`
    : list.join(separator);
}

// Single-run views share the report and decision evidence. Only the bridge's
// ordinary diagnostics move behind detail; persistence can omit the patch.
export function buildSingleResultViews({ runId = "", compactLines, singleParts, lockLines = [], lockRequired = false,
  unsafeFiles = [], lockViolation, compactLockViolation = lockViolation, driftLine, hasWorktree = false, worktreeReview, compactWorktreeReview = worktreeReview, worktreeReviewWithoutPatch,
  verifications = [], validationGateText, compactValidationGateText = validationGateText }) {
  const join = (parts) => parts.filter(Boolean).join("\n");
  const fullTail = [driftLine, worktreeReview, ...verifications.map(({ text }) => text), validationGateText, lockViolation];
  const full = [...lockLines, [singleParts.preamble, singleParts.report, singleParts.stderr].join("\n"), ...fullTail]
    .filter((line) => line !== null).join("\n");
  const head = join([
    runId ? `Run id: ${runId} (get_opencode_job retrieves the stored result and any retained detail)` : "",
    ...compactLines,
    ...(lockRequired ? lockLines : []),
    `Unsafe changed files: ${unsafeFiles.length ? compactFileList(unsafeFiles) : "none detected"}`,
    unsafeFiles.length ? compactLockViolation : compactLockViolation?.trim().replace("Write lock verification:\n", "Write lock verification: "),
  ]);
  const stderr = singleParts.stderr.trim() === "STDERR summary:" ? "" : singleParts.stderr;
  const tail = (review) => join([stderr, driftLine, hasWorktree ? review : "", ...verifications.filter(({ rejected }) => rejected).map(({ text }) => text), compactValidationGateText]);
  return {
    compact: join([head, singleParts.report, tail(compactWorktreeReview)]),
    compactParts: { head, report: singleParts.report, tail: tail(compactWorktreeReview) },
    fullParts: { head: join([...lockLines, singleParts.preamble]), report: singleParts.report, tail: join([singleParts.stderr, ...fullTail]) },
    full,
    storedParts: { head, report: singleParts.report, tail: tail(worktreeReviewWithoutPatch) },
    detailText: join([...lockLines, singleParts.preamble, singleParts.stderr, ...fullTail]),
  };
}

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createResultFormatRuntime({ CONFIG, formatHeavyToolCalls, formatOpenCodeUsage, formatPhaseTimings, formatReadOnlyHeadMove, rateLimitPauseReason, summarizeStderr }) {
// Q-018: run attribution and the eventual integration patch have different scopes in a chain.
function continuedWorktreeSummary(result) {
  if (!result?.worktree?.continued) return "";
  const thisRunFiles = result.worktree.thisRunChangedFiles || result.changedFiles || [];
  const totalFiles = result.worktree.changedFiles || [];
  const runChanges = result.worktree.thisRunAttributionUnavailable
    ? "this run's changed files are unavailable after an infrastructure failure"
    : `this run changed ${thisRunFiles.length} file(s): ${thisRunFiles.length ? compactFileList(thisRunFiles) : "none"}`;
  return [
    `Continued worktree of job ${result.worktree.continuedFrom || "unknown"}: ${runChanges}; worktree total vs base: ${totalFiles.length} file(s): ${totalFiles.length ? compactFileList(totalFiles) : "none"}.`,
    "Integration lands the total worktree patch; its allowedEdits must cover the union of all jobs' changes.",
  ].join("\n");
}

// The three blocks of a job result: the bridge preamble (everything before the agent's report),
// the agent's final response, and the stderr summary. formatSingleResult joins them unchanged;
// callers that shorten a result cut between the blocks, never inside the report.
function formatSingleResultParts({ resolution, result, cwd, lockPlan = null }) {
  const preamble = [
    `Requested agent: ${resolution.requestedAgent}`,
    `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
    `Actual agent used: ${resolution.actualAgent || "none"}`,
    `Actual agent mode: ${resolution.actualAgentMode || resolution.requestedAgentMode || "unknown"}`,
    `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
    resolution.fallbackReason ? `Fallback reason: ${resolution.fallbackReason}` : null,
    `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
    `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
    `OpenCode native fallback detected: ${result?.openCodeFallbackDetected ? "yes" : "no"}`,
    `OpenCode API error detected: ${result?.openCodeApiErrorDetected ? "yes" : "no"}`,
    `Provider error type: ${result?.providerErrorType || "none"}`,
    result?.providerCooldownUntil ? `Provider paused until: ${result.providerCooldownUntil} (new jobs on this provider fail at once until then)` : null,
    `Recovered transient provider error: ${result?.recoveredTransientProviderError ? "yes" : "no"}`,
    `Provider warning type: ${result?.providerWarningType || "none"}`,
    `Provider error lines in OpenCode stderr (attempts OpenCode retried or failed): ${result?.providerRetryWarningCount || 0}`,
    `Token usage: ${formatOpenCodeUsage(result?.usage)}`,
    formatHeavyToolCalls(result?.heavyToolCalls) || null,
    `Configured provider: ${result?.configuredProvider || "unknown"}`,
    `Configured model: ${result?.configuredModel || "unknown"}`,
    `Configured variant: ${result?.configuredVariant || "unknown"}`,
    `Model selection: ${result?.modelSelection || "managed_profile"}`,
    result?.modelSelection === "operator_allowlist_override"
      ? `Managed profile model: ${result.profileProvider}/${result.profileModel} (variant ${result.profileVariant || "unspecified"})`
      : null,
    // Q-012: the OpenCode role was attested and shaped the prompt, but the external CLI enforces none of it.
    result?.externalRunner ? `Role enforcement: ${result.roleEnforcement || `none (runner ${result.externalRunner})`}` : null,
    result?.externalRunner ? `External runner: ${result.externalRunner}${result.runnerVersion ? ` ${result.runnerVersion}` : ""} (unattested; executable ${result.runnerExecutable || "unresolved"}${result.runnerExecutableSha256 ? `, SHA-256 ${result.runnerExecutableSha256}` : ""}); managed profile model ${result.profileProvider || "?"}/${result.profileModel || "?"}` : null,
    result?.targetCheckoutGuard ? `Target checkout guard: ${targetCheckoutGuardText(result.targetCheckoutGuard)}` : null,
    // B-146: a failed runner's sidecar (last-message.txt, agy.log) is kept for diagnosis.
    result?.runnerSidecarDir ? `Runner sidecar: ${result.runnerSidecarDir}` : null,
    `Runtime-observed provider: ${result?.runtimeObservedProvider || "not emitted"}`,
    `Runtime-observed model: ${result?.runtimeObservedModel || "not emitted"}`,
    `Actual provider used: ${result?.actualProvider || "unknown"}`,
    `Actual model used: ${result?.actualModel || "unknown"}`,
    `Actual model evidence: ${result?.actualModelEvidence || "unavailable"}`,
    `Runtime model verification: ${result?.modelAttested ? "verified for observed root-session messages" : "unverified"}`,
    `Runtime model evidence required: ${result?.requireRuntimeModelEvidence ? "yes" : "no"}`,
    `Runtime model identities conflict: ${result?.runtimeModelConflict ? "yes" : "no"}`,
    `Event stream integrity: ${result?.streamIntegrity || "not inspected"}`,
    `Permission denials observed: ${result?.permissionDeniedCount || 0}`,
    "Silent model fallback: disabled",
    `Model fallback used: ${result?.modelFallbackUsed ? "yes" : "no"}`,
    result?.modelFallbackUsed ? `Model fallback: ${result.modelFallbackFrom} -> ${result.modelFallbackTo}; reason: ${result.modelFallbackReason}; payload started: ${result.modelFallbackStarted ? "yes" : "no"}` : null,
    result?.modelFallbackUnavailableReason ? `Model fallback unavailable: ${result.modelFallbackUnavailableReason}; original pause preserved` : null,
    `Provider/account concurrency key: ${result?.providerConcurrencyKey || "not acquired"}`,
    `Provider capacity wait ms: ${result?.providerConcurrencyWaitMs || 0}`,
    result?.providerWaitBudget?.effectiveMaxWaitMs !== undefined ? `Provider wait budget ms: ${result.providerWaitBudget.effectiveMaxWaitMs}${result.providerWaitBudget.maxWaitMsClamped ? ` (clamped from ${result.providerWaitBudget.requestedMaxWaitMs})` : ""}` : null,
    result?.providerWaitInfo ? `Provider slot wait: ${JSON.stringify(result.providerWaitInfo)}` : null,
    `Assistant final response detected: ${result?.assistantFinalResponseDetected ? "yes" : "no"}`,
    `Assistant response truncated: ${result?.assistantResponseTruncated ? "yes" : "no"}`,
    `Raw process output truncated: ${result?.rawOutputTruncated ? "yes" : "no"}`,
    resolution.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Working directory: ${cwd || process.cwd()}`,
    result?.worktree ? `Worktree path: ${result.worktree.path}` : null,
    result?.worktree ? `Worktree branch: ${result.worktree.branch}` : null,
    result?.worktree ? `Worktree cleanup: ${result.worktree.cleanup}` : null,
    ...(result?.worktree?.continued ? [continuedWorktreeSummary(result)] : []),
    `Command shape: ${result?.commandShape || "not run"}`,
    `Dry run: ${result?.dryRun ? "yes" : "no"}`,
    `Error type: ${result?.errorType || "none"}`,
    formatReadOnlyHeadMove(result?.readOnlyHeadMove),
    result?.timedOut ? `Agent timeout: ${resolution.actualAgent || resolution.requestedAgent}` : null,
    `Timeout ms: ${result?.timeoutMs ?? "not specified"}`,
    `Timed out: ${result?.timedOut ? "yes" : "no"}`,
    result?.idleTimedOut ? `Agent idle timeout: the agent wrote no output for ${result.idleTimeoutMs} ms (CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS) and was stopped` : null,
    result?.rateLimited ? `Rate limit detected: ${rateLimitPauseReason(result)}; the agent was stopped (CODEX_OPENCODE_RATE_LIMIT_HITS)${result.rateLimitPause ? `, ${result.rateLimitPause.pauseKey} paused until ${result.rateLimitPause.until} (pause ${result.rateLimitPause.strikes})` : ""}` : null,
    timedOutWriterLine(result),
    `Read-only unavailable: ${result?.readOnlyUnavailable ? "yes" : "no"}`,
    `Retry attempts used: ${result?.retryAttempt ?? 0}`,
    `Max retries: ${result?.maxRetries ?? 0}`,
    `Lock mode: ${lockPlan?.lockMode || "not specified"}${lockPlan?.requestedLockMode ? ` (requested ${lockPlan.requestedLockMode}; parallel writers always use ${lockPlan.lockMode})` : ""}`,
    `Lock type: ${lockPlan?.lockType || "not specified"}`,
    lockPlan?.orchestratorMode ? `Orchestrator mode: ${lockPlan.orchestratorMode}` : null,
    lockPlan?.orchestratorMode === "contractor" ? `User-authorized contractor: ${lockPlan.userAuthorizedOrchestrator ? "yes" : "no"}` : null,
    `Lock granted: ${lockPlan?.lockedPaths?.length ? lockPlan.lockedPaths.join(", ") : "not specified"}`,
    `Allowed edits: ${lockPlan?.allowedEdits?.length ? lockPlan.allowedEdits.join(", ") : "none"}`,
    `Forbidden edits: ${lockPlan?.forbiddenEdits?.length ? lockPlan.forbiddenEdits.join(", ") : "none specified"}`,
    lockPlan?.scopeContract ? `Scope Contract role: ${lockPlan.scopeContract.role || "not specified"}` : null,
    lockPlan?.scopeContract ? `Scope Contract mode: ${lockPlan.scopeContract.mode}` : null,
    lockPlan?.scopeContract ? `Scope read paths: ${lockPlan.scopeContract.scope.read.length ? lockPlan.scopeContract.scope.read.join(", ") : "not specified"}` : null,
    lockPlan?.scopeContract ? `Scope write paths: ${lockPlan.scopeContract.scope.write.length ? lockPlan.scopeContract.scope.write.join(", ") : "none"}` : null,
    lockPlan?.scopeContract ? `Scope forbidden paths: ${lockPlan.scopeContract.scope.forbidden.length ? lockPlan.scopeContract.scope.forbidden.join(", ") : "none"}` : null,
    `Shared files frozen: ${lockPlan?.sharedFiles?.length ? lockPlan.sharedFiles.join(", ") : "none specified"}`,
    `Dependency request: ${result?.dependencyRequest ? JSON.stringify(result.dependencyRequest) : "none"}`,
    result?.dependencyRequestError ? `Dependency request error: ${result.dependencyRequestError}` : null,
    `Files changed: ${result?.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
    `Exit code: ${result?.exitCode ?? "not run"}`,
    `Duration ms: ${result?.durationMs ?? 0} (OpenCode run only: final role attestation, provider slot wait and the agent process; job setup and post-agent checks are under Timing)`,
    result?.childStartedAtMs && result?.childFinishedAtMs
      ? `Agent run ms: ${Math.max(0, result.childFinishedAtMs - result.childStartedAtMs)} (agent process only)`
      : null,
    formatPhaseTimings(result?.phaseTimings),
    "",
    `Tool outcomes: ${result?.toolOutcomes?.length ? result.toolOutcomes.map((item) => `${item.tool}:${item.status}`).join(", ") : "none"}`,
    "",
  ].filter((line) => line !== null).join("\n");
  return {
    preamble,
    report: ["Assistant final response:", result?.stdout || ""].join("\n"),
    stderr: ["", "STDERR summary:", summarizeStderr(result?.stderr)].join("\n"),
  };
}

function formatSingleResult(args) {
  const { preamble, report, stderr } = formatSingleResultParts(args);
  return [preamble, report, stderr].join("\n");
}

// B-044: a writer that hit its timeout after changing files looked like any other timed-out job
// ("Timed out: yes"), and the operator could take it for lost work. Its worktree is retained
// (changed output is never removed), so the summary lines say what was written and where it is
// kept. `idle` is a writer stopped by the idle watchdog (agent_idle_timeout) rather than the
// run clock.
function timedOutWriterNote({ errorType = "", timedOut = false, idleTimedOut = false, changedFiles = [], worktreeRetained = false } = {}) {
  const count = Array.isArray(changedFiles) ? changedFiles.length : 0;
  const idle = idleTimedOut || errorType === "agent_idle_timeout";
  if (!count || !(idle || timedOut || errorType === "agent_timeout")) return "";
  return `${idle ? "stopped as idle" : "timed out"} after writing ${count} changed file(s)${worktreeRetained ? "; worktree retained" : ""}`;
}

function timedOutWriterEvidence(result) {
  return {
    errorType: result?.errorType || "",
    timedOut: Boolean(result?.timedOut),
    idleTimedOut: Boolean(result?.idleTimedOut),
    changedFiles: result?.changedFiles || [],
    worktreeRetained: Boolean(result?.worktree?.path) && !result.worktree.removed,
  };
}

function timedOutWriterLine(result) {
  const note = timedOutWriterNote(timedOutWriterEvidence(result));
  return note ? `Timed out with changes: ${note}` : null;
}

// Q-012/B-140: the agy guard's outcome: target-checkout paths, then changed profile files.
function targetCheckoutGuardText(guard, limit = Infinity) {
  const paths = guard.changedPaths || [];
  const profiles = guard.profileFiles || [];
  if (!paths.length && !profiles.length) return guard.checked ? "unchanged" : "not checked (git status failed)";
  return [
    paths.length ? `changed (${paths.slice(0, limit).join(", ")})` : "",
    profiles.length ? `profile files changed (${profiles.join(", ")})` : "",
  ].filter(Boolean).join("; ");
}

// L-025: what a caller decides on, without the bridge preamble (lock and scope echo, model
// evidence, phase timing split, tool outcomes), which stays behind `detail: true`. Facts are
// printed when they are the point (agent, outcome, timing, usage, changed files) or when they are
// abnormal (provider warnings, fallbacks, unverified model, truncation, denials, failures): a
// normal value is left out, an abnormal one never is.
function compactJobLines({ resolution, result, unsafeFiles = [] }) {
  const metrics = directRunMetrics(result || {});
  const errorType = result?.errorType || (unsafeFiles.length ? "changed_file_validation_error" : "");
  const spawned = Number(result?.childStartedAtMs) > 0;
  const status = result?.groupRejected ? "rejected" : errorType ? (spawned ? "failed" : "rejected") : result?.dryRun ? "dry_run" : "completed";
  const ran = resolution.actualAgent && resolution.actualAgent !== resolution.requestedAgent ? ` (ran as ${resolution.actualAgent})` : "";
  const timing = [
    ["agentRunMs", metrics.agentRunMs],
    ["startupMs", metrics.startupMs],
    ["providerWaitMs", metrics.providerWaitMs],
    ["totalMs", result?.phaseTimings?.totalMs],
  ].filter(([, value]) => value !== null && value !== undefined).map(([name, value]) => `${name}=${value}`);
  const model = [result?.configuredProvider, result?.configuredModel].filter(Boolean).join("/");
  return [
    `Agent: ${resolution.requestedAgent}${ran}`,
    resolution.fallbackUsed ? `Fallback used: yes${resolution.fallbackReason ? ` (${resolution.fallbackReason})` : ""}` : null,
    resolution.proxyUsed ? `Subagent proxy used: yes${resolution.proxyReason ? ` (${resolution.proxyReason})` : ""}` : null,
    `Status: ${status}${errorType ? `; error type: ${errorType}` : ""}`,
    result?.worktree?.continued ? "wt=continued" : null,
    continuedWorktreeSummary(result),
    model ? `Model: ${model}${result?.configuredVariant ? ` (variant ${result.configuredVariant})` : ""}` : null,
    result?.modelSelection === "operator_allowlist_override"
      ? `Model selection: operator_allowlist_override (managed profile model ${result.profileProvider}/${result.profileModel})`
      : null,
    result?.externalRunner ? `Role enforcement: ${result.roleEnforcement || `none (runner ${result.externalRunner})`}` : null,
    // B-148: a guard that could not run is abnormal too.
    result?.targetCheckoutGuard && (result.targetCheckoutGuard.changedPaths?.length || result.targetCheckoutGuard.profileFiles?.length || !result.targetCheckoutGuard.checked)
      ? `Target checkout guard: ${targetCheckoutGuardText(result.targetCheckoutGuard, 10)}`
      : null,
    result?.runnerSidecarDir ? `Runner sidecar: ${result.runnerSidecarDir}` : null,
    timing.length ? `Timing: ${timing.join(" ")}` : null,
    `Token usage: ${formatOpenCodeUsage(result?.usage)}`,
    formatHeavyToolCalls(result?.heavyToolCalls) || null,
    result?.providerWarningType ? `Provider warning type: ${result.providerWarningType}` : null,
    result?.providerErrorType ? `Provider error type: ${result.providerErrorType}` : null,
    result?.providerWaitBudget?.effectiveMaxWaitMs !== undefined
      && (result.providerWaitBudget.requestedMaxWaitMs !== null && result.providerWaitBudget.requestedMaxWaitMs !== undefined || result.providerWaitInfo)
      ? `Provider wait budget ms: ${result.providerWaitBudget.effectiveMaxWaitMs}${result.providerWaitBudget.maxWaitMsClamped ? ` (clamped from ${result.providerWaitBudget.requestedMaxWaitMs})` : ""}` : null,
    result?.providerWaitInfo ? `Provider slot wait: ${JSON.stringify(result.providerWaitInfo)}` : null,
    result?.providerCooldownUntil ? `Provider paused until: ${result.providerCooldownUntil} (new jobs on this provider fail at once until then)` : null,
    result?.recoveredTransientProviderError ? "Recovered transient provider error: yes" : null,
    result?.providerRetryWarningCount ? `Provider error lines in OpenCode stderr (attempts OpenCode retried or failed): ${result.providerRetryWarningCount}` : null,
    result?.openCodeFallbackDetected ? "OpenCode native fallback detected: yes" : null,
    result?.openCodeApiErrorDetected ? "OpenCode API error detected: yes" : null,
    !result?.dryRun && !result?.modelAttested ? "Runtime model verification: unverified" : null,
    result?.runtimeModelConflict ? "Runtime model identities conflict: yes" : null,
    result?.streamIntegrity && result.streamIntegrity !== "valid" ? `Event stream integrity: ${result.streamIntegrity}` : null,
    result?.permissionDeniedCount ? `Permission denials observed: ${result.permissionDeniedCount}` : null,
    result?.modelFallbackUsed ? `Model fallback: ${result.modelFallbackFrom} -> ${result.modelFallbackTo}; reason: ${result.modelFallbackReason}; payload started: ${result.modelFallbackStarted ? "yes" : "no"}` : null,
    result?.modelFallbackUnavailableReason ? `Model fallback unavailable: ${result.modelFallbackUnavailableReason}; original pause preserved` : null,
    !result?.dryRun && result && !result.assistantFinalResponseDetected ? "Assistant final response detected: no" : null,
    result?.assistantResponseTruncated ? "Assistant response truncated: yes" : null,
    result?.rawOutputTruncated ? "Raw process output truncated: yes" : null,
    result?.timedOut ? `Timed out: yes (timeout ms ${result.timeoutMs ?? "not specified"})` : null,
    result?.idleTimedOut ? `Idle timeout: yes (no output for ${result.idleTimeoutMs} ms)` : null,
    result?.rateLimited ? `Rate limit detected: ${rateLimitPauseReason(result)}; the agent was stopped (CODEX_OPENCODE_RATE_LIMIT_HITS)${result.rateLimitPause ? `, ${result.rateLimitPause.pauseKey} paused until ${result.rateLimitPause.until} (pause ${result.rateLimitPause.strikes})` : ""}` : null,
    timedOutWriterLine(result),
    result?.readOnlyUnavailable ? "Read-only unavailable: yes" : null,
    result?.retryAttempt ? `Retry attempts used: ${result.retryAttempt} of ${result.maxRetries ?? 0}` : null,
    result && result.exitCode !== 0 && result.exitCode !== undefined ? `Exit code: ${result.exitCode}` : null,
    result?.dependencyRequest ? `Dependency request: ${JSON.stringify(result.dependencyRequest)}` : null,
    result?.dependencyRequest || result?.dependencyRequestError ? "DEPENDENCY_REQUIRED" : null,
    result?.dependencyRequestError ? `Dependency request error: ${result.dependencyRequestError}` : null,
    formatReadOnlyHeadMove(result?.readOnlyHeadMove),
    `Files changed: ${result?.changedFiles?.length ? compactFileList(result.changedFiles) : "none detected"}`,
  ].filter(Boolean);
}

function fitJobResultText(parts, limit = CONFIG.queueResultMaxChars) {
  return fitResultParts(parts, limit);
}

// The stored text is redacted before it is measured: redaction can lengthen a line, and a text
// fitted first and redacted when it is persisted could land over the limit and be cut anywhere.
function fitRedactedJobResult(parts, limit = CONFIG.queueResultMaxChars) {
  const redactedParts = {
    head: redactSensitiveText(parts.head),
    report: redactSensitiveText(parts.report),
    tail: redactSensitiveText(parts.tail || ""),
  };
  return { ...fitJobResultText(redactedParts, limit), parts: redactedParts };
}

function patchPreviewOmittedLine(chars) {
  return `Worktree patch preview: omitted from this view (${chars} preview characters before storage fitting). integrate_opencode_worktree with dryRun: true shows the patch; get_opencode_job with detail: true returns any retained preview.`;
}

function conflictPathsFromConflict(conflict) {
  return normalizeLockPathList(conflict?.overlap || conflict?.paths || []);
}

function formatRejectedExecution({
  headline = "Execution rejected.",
  errorType = "execution_rejected",
  reason,
  requestedAgent = "unknown",
  actualAgent = "none",
  lockMode = "unknown",
  worktreeMode = CONFIG.worktreeMode,
  durationMs = 0,
  conflictingPaths = [],
  dirtyFiles = null,
  overlappingFiles = null,
  disjointFiles = null,
  lockedPaths = [],
  allowedEdits = [],
  scope = null,
  changedFiles = [],
  runId = "",
  rollback = "",
  disallowedFiles = [],
  serialOnlyMatches = [],
  rollbackFiles = [],
  unresolvedFiles = [],
  fallback = null,
  fallbackReason = "",
  suggestedFix = "Review the request and retry with a bounded task.",
  compactPaths = true,
}) {
  const conflicts = normalizeLockPathList(conflictingPaths);
  const normalizedDirtyFiles = Array.isArray(dirtyFiles) ? normalizeLockPathList(dirtyFiles) : null;
  const normalizedOverlappingFiles = Array.isArray(overlappingFiles) ? normalizeLockPathList(overlappingFiles) : null;
  const normalizedDisjointFiles = Array.isArray(disjointFiles) ? normalizeLockPathList(disjointFiles) : null;
  const pathsText = compactPaths ? compactFileList : files => files.join(", ");
  const scopePaths = new Set(["read", "write", "forbidden", "shared", "lockedPaths", "allowedEdits", "forbiddenEdits", "sharedFiles", "serialOnly"]);
  const scopeText = scope ? JSON.stringify(scope, (key, value) => compactPaths && scopePaths.has(key) && Array.isArray(value) ? compactFileList(value) : value) : "";
  const text = [
    headline,
    "",
    `errorType: ${errorType}`,
    `requestedAgent: ${requestedAgent || "unknown"}`,
    `actualAgent: ${actualAgent || "none"}`,
    fallback === null ? null : `fallback: ${fallback ? "yes" : "no"}`,
    fallbackReason ? `fallbackReason: ${fallbackReason}` : null,
    `reason: ${reason || headline}`,
    `suggestedFix: ${suggestedFix}`,
    `lockMode: ${lockMode || "unknown"}`,
    `worktreeMode: ${worktreeMode || "unknown"}`,
    `durationMs: ${durationMs}`,
    `conflictingPaths: ${conflicts.length ? pathsText(conflicts) : "none"}`,
    normalizedDirtyFiles ? `dirtyFiles: ${normalizedDirtyFiles.length ? pathsText(normalizedDirtyFiles) : "none"}` : null,
    normalizedOverlappingFiles ? `overlappingFiles: ${normalizedOverlappingFiles.length ? pathsText(normalizedOverlappingFiles) : "none"}` : null,
    normalizedDisjointFiles ? `disjointFiles: ${normalizedDisjointFiles.length ? pathsText(normalizedDisjointFiles) : "none"}` : null,
    lockedPaths.length ? `lockedPaths: ${pathsText(normalizeLockPathList(lockedPaths))}` : null,
    allowedEdits.length ? `allowedEdits: ${pathsText(normalizeLockPathList(allowedEdits))}` : null,
    scope ? `scope: ${scopeText}` : null,
    changedFiles.length ? `changedFiles: ${pathsText(normalizeLockPathList(changedFiles))}` : null,
    runId ? `runId: ${runId}` : null,
    rollback ? `rollback: ${rollback}` : null,
    disallowedFiles.length ? `disallowedFiles: ${pathsText(normalizeLockPathList(disallowedFiles))}` : null,
    serialOnlyMatches.length ? `serialOnlyMatches: ${pathsText(serialOnlyMatches)}` : null,
    rollbackFiles.length ? `rollbackFiles: ${pathsText(normalizeLockPathList(rollbackFiles))}` : null,
    unresolvedFiles.length ? `unresolvedFiles: ${pathsText(normalizeLockPathList(unresolvedFiles))}` : null,
  ].filter(Boolean).join("\n");
  return compactPaths ? truncateText(redactSensitiveText(text), CONFIG.queueResultMaxChars) : text;
}
  return { continuedWorktreeSummary, formatSingleResultParts, formatSingleResult, timedOutWriterNote, timedOutWriterEvidence, timedOutWriterLine, COMPACT_FILE_LIST_LIMIT, compactFileList, compactJobLines, fitJobResultText, fitRedactedJobResult, patchPreviewOmittedLine, conflictPathsFromConflict, formatRejectedExecution };
}
