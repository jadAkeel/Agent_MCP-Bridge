// Queue evidence, retry policy constants, and worker presence checks.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { sanitizePersistedValue } from "./redaction.js";
import { firstNonEmptyList } from "./scope-contract.js";
import { REPOSITORY_SCOPE_LOCK_PATH, unsafePathReason, normalizeLockPathListForCwd, hasAmbiguousPathPattern } from "./paths.js";

export function queueRequestFingerprint(request) {
  const comparable = structuredClone(request);
  // Both are minted per enqueue (the job id is random), so an idempotent retry of the same
  // contractor request must not see them as different content.
  delete comparable.internalQueueContractorProof;
  delete comparable.internalQueueJobId;
  return createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

// A queued job is "running" from the moment a worker claims it, but it may then wait minutes for
// a provider slot before the agent starts, so status alone cannot tell waiting from working and
// durationMs includes the wait. runStage and agentRunMs separate the two.
export function queueStartAfterPending(record, now = Date.now()) {
  const at = Date.parse(record?.startAfter || "");
  return Number.isFinite(at) && at > now;
}

// B-024: once the job has finished, agentRunMs is the agent process alone (the same number as
// "Agent run ms" in the result text) and afterAgentMs is the post-agent work (snapshots,
// validation, patch collection), so waitBeforeAgentMs + agentRunMs + afterAgentMs ~ durationMs.
// While the job runs, agentRunMs is the time since the supervisor started.
export function queueAgentTiming(record, now = Date.now()) {
  const agentStartedMs = Date.parse(record.agentStartedAt || "");
  if (!Number.isFinite(agentStartedMs)) return { agentRunMs: 0, waitBeforeAgentMs: 0 };
  const finishedMs = Date.parse(record.finishedAt || "");
  const startedMs = Date.parse(record.startedAt || "");
  const waitBeforeAgentMs = Number.isFinite(startedMs) ? Math.max(0, agentStartedMs - startedMs) : 0;
  const processMs = record.phaseTimings?.agentProcessMs;
  if (Number.isFinite(finishedMs) && Number.isFinite(processMs)) {
    // afterAgentMs comes from the job clock (last agent exit to the end): with read-only retries
    // agentStartedAt is the first attempt and agentProcessMs the last, so their difference would
    // count earlier attempts and backoff as post-agent work. Earlier attempts are in neither.
    const afterAgentMs = record.phaseTimings?.afterAgentMs;
    return {
      agentRunMs: Math.max(0, processMs),
      waitBeforeAgentMs,
      afterAgentMs: Number.isFinite(afterAgentMs) ? Math.max(0, afterAgentMs) : Math.max(0, finishedMs - agentStartedMs - processMs),
    };
  }
  return {
    agentRunMs: Math.max(0, (Number.isFinite(finishedMs) ? finishedMs : now) - agentStartedMs),
    waitBeforeAgentMs,
  };
}

// L-025/L-026: the queue keeps the runner's report-priority result (`resultText`, without the
// worktree patch preview) and the detail apart (`resultDetailText`: the patch preview, and the
// bridge preamble when it had to be shortened). Executions that carry no resultRecord (a
// rejection, a test hook) keep their response text as before.
export function queueResultFields(execution) {
  const stored = execution?.resultRecord;
  if (stored && typeof stored.text === "string") {
    return {
      resultText: stored.text,
      resultDetailText: stored.detailText || "",
      resultReportTruncated: Boolean(stored.reportTruncated),
      resultFullChars: Number(stored.chars) || 0,
    };
  }
  return { resultText: execution?.response?.content?.[0]?.text || "", resultDetailText: "", resultReportTruncated: false, resultFullChars: 0 };
}

export function commandFingerprintFields(value, prefix = "validationCommand") {
  const text = String(value || "");
  return {
    [`${prefix}Chars`]: text.length,
    [`${prefix}Sha256`]: createHash("sha256").update(text).digest("hex"),
  };
}

export function scopeContractDurableSummary(contract) {
  if (!contract) return null;
  // An already-summarized contract carries an empty command and its original fingerprint;
  // re-summarizing it must keep that fingerprint instead of replacing it with sha256("").
  const alreadySummarized = !contract.validationCommand
    && Object.prototype.hasOwnProperty.call(contract, "validationCommandSha256")
    && Object.prototype.hasOwnProperty.call(contract, "validationCommandChars");
  return sanitizePersistedValue({
    ...contract,
    validationCommand: "",
    ...(alreadySummarized
      ? { validationCommandChars: contract.validationCommandChars, validationCommandSha256: contract.validationCommandSha256 }
      : commandFingerprintFields(contract.validationCommand)),
  });
}

// Q-001: requeue_opencode_job. Terminal states, from the queue state machine:
//   failed, cancelled     the run (or its start) ended without a result: requeue is the retry.
//   interrupted           the owner's lease lapsed while the job was active: retry-able, but the
//                         previous child may still be alive, which is checked below.
//   not_resumable         a never-started job that recovery could not resume. Requeue works only
//                         when the encrypted request survived; the usual cause (a legacy record
//                         without one) is refused with what is missing.
//   completed             a success: re-running finished work is a deliberate new enqueue.
// Every other status is unfinished and has to be cancelled or awaited first.
export const REQUEUE_ELIGIBLE_STATUSES = new Set(["failed", "cancelled", "interrupted", "not_resumable"]);

export const REQUEUE_UNFINISHED_STATUSES = new Set(["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"]);

const REQUEUE_KEY_SUFFIX = /(?::requeue:\d+)+$/;

// <original key>:requeue:<n>, where n counts the requeues down the chain (a requeue of a requeue
// keeps the root key, so keys do not grow); a job without a key uses its job id. The key is
// deterministic, so a repeated or concurrent requeue of the same job deduplicates to one job.
export function requeueIdempotencyKey(original, sequence) {
  const base = String(original.idempotencyKey || "").replace(REQUEUE_KEY_SUFFIX, "") || String(original.jobId);
  const suffix = `:requeue:${sequence}`;
  if (base.length + suffix.length <= 200) return `${base}${suffix}`;
  const digest = createHash("sha256").update(base).digest("hex").slice(0, 16);
  return `${base.slice(0, 200 - suffix.length - digest.length - 1)}~${digest}${suffix}`;
}

export function requeueRefusal(errorType, error, suggestedFix = "") {
  return { ok: false, errorType, error, suggestedFix };
}

// Q-007: model fallback for queued jobs (the round-6 orchestrator's TOOL_ORDER + attempts). A job
// that names `models` and/or `maxAttempts` carries a retry policy: when it fails for a reason
// another model or another try can fix, the bridge requeues it itself through requeueQueueJob (the
// same validation as requeue_opencode_job, the same lineage fields) on the next model that is not
// paused, and after maxAttempts it marks the last job outcome=gave_up. The policy lives in the
// stored encrypted request, so it survives a restart and a requeue keeps it.
export const RETRY_POLICY_DEFAULT_ATTEMPTS = 4;

export const RETRY_POLICY_MAX_ATTEMPTS = 10;

export const RETRY_POLICY_MAX_SLOT_WAITS = 12;

// B-078: a slot request refused because the provider or model was paused (by the operator, a rate
// limit or a quota) never started the agent either; such refusals are not attempts, up to this many.
export const RETRY_POLICY_MAX_PAUSE_WAITS = 24;

export const RETRY_POLICY_HISTORY_MAX = RETRY_POLICY_MAX_ATTEMPTS + RETRY_POLICY_MAX_SLOT_WAITS + RETRY_POLICY_MAX_PAUSE_WAITS;

export const RETRY_POLICY_ERROR_TYPES = new Set([
  // The provider: limits, pauses, quotas and outages another model (or a later try) avoids.
  "provider_rate_limited", "provider_paused", "provider_slot_wait_timeout",
  "opencode_rate_limited", "opencode_quota_exhausted", "opencode_billing_error", "opencode_auth_error",
  "opencode_model_error", "opencode_transient_provider_error", "opencode_provider_unavailable",
  "opencode_transport_error", "opencode_api_error", "opencode_native_fallback", "opencode_stream_malformed",
  // The run: stalled, too slow, or ended without a usable result.
  "agent_idle_timeout", "agent_timeout", "agent_empty_final_response", "agent_exit_nonzero",
  "essential_output_truncated", "validation_command_failed", "self_check_failed", "writer_no_changes",
  // Q-008: the owner died while the job ran (a client restart).
  "queue_job_interrupted",
]);

export function retryPolicyRequirement(parsed) {
  return { provider: parsed.provider, model: parsed.model, ...(parsed.variant ? { variant: parsed.variant } : {}) };
}

export function retryPolicyModelSpec(parsed) {
  return `${parsed.provider}/${parsed.model}${parsed.variant ? `@${parsed.variant}` : ""}`;
}

export const retryPolicyModelLabel = (summary) => (summary?.configuredModel ? `${summary.configuredProvider || "?"}/${summary.configuredModel}` : summary?.scopeContract?.modelRequirement?.model ? `${summary.scopeContract.modelRequirement.provider}/${summary.scopeContract.modelRequirement.model}` : "profile model");

export function autoIntegrationRetryDelayMs(round) {
  const baseMs = process.argv.includes("--self-test") ? 25 : 5000;
  return Math.min(baseMs * 12, baseMs * 2 ** round);
}

export const QUEUE_BLOCKED_BACKOFF_MAX_MS = 60 * 1000;

// What acquireHardLock refuses before it looks at other locks; such a refusal never clears.
export function queueHardLockRequestRefusal(record) {
  const rawPaths = record.mode === "read"
    ? firstNonEmptyList(record.lockedPaths, record.scopeContract?.scope?.read, [REPOSITORY_SCOPE_LOCK_PATH])
    : firstNonEmptyList(record.allowedEdits, record.lockedPaths);
  const repositoryScope = rawPaths.length === 1 && rawPaths[0] === REPOSITORY_SCOPE_LOCK_PATH;
  if (repositoryScope && record.mode !== "read") {
    return "Repository-wide scope is reserved for internal read or serial-integration consistency leases.";
  }
  if (!repositoryScope) {
    const unsafe = unsafePathReason(rawPaths, record.cwd || "");
    if (unsafe) return `Write lock rejected: ${unsafe}`;
  }
  let normalizedPaths = [];
  try {
    normalizedPaths = repositoryScope ? [REPOSITORY_SCOPE_LOCK_PATH] : normalizeLockPathListForCwd(rawPaths, record.cwd || "");
  } catch (error) {
    return `Write lock rejected: ${error?.message || String(error)}`;
  }
  if (!normalizedPaths.length) return "Write lock rejected: paths are required.";
  if (hasAmbiguousPathPattern(normalizedPaths, record.cwd || "")) return "Write lock rejected: wildcard or ambiguous paths are not allowed.";
  return "";
}

// Feature 10 (log.md B-075..B-077): the unattended queue worker, bin/queue-worker.js. A bridge runs
// only while an MCP client keeps it alive, so a batch of hundreds of jobs could not run for hours
// without one. The worker is this module imported by a plain Node process: it runs the same
// startup checks and recovery, then the same queue runner (leases, bridge_instances, provider
// leases, pauses, integration journal, operations log) for ONE repository, without a transport.
// Nothing new is stored in the database; small files sit beside it in <state-dir>/workers/:
// <projectKey>.json (presence: pid, instance, heartbeat, counts), <projectKey>.stop (a stop
// request, the primary stop signal because Windows has no SIGTERM) and <projectKey>.parked (B-079:
// a stopped worker left jobs behind for the next worker).
export const QUEUE_WORKER_PRESENCE_FRESH_MS = 2 * 60 * 1000;

// B-082: a heartbeat this old is stale even when the recorded pid is alive: a live worker refreshes
// it every 15 s, so after 10 minutes the pid belongs to another process (a reused pid would
// otherwise block every restart for good) or the worker hung; in both cases it is taken over.
const QUEUE_WORKER_PRESENCE_ABANDONED_MS = 10 * 60 * 1000;

// B-087: a heartbeat in the future (a clock that moved back) counts only within this skew.
const QUEUE_WORKER_CLOCK_SKEW_MS = 60 * 1000;

function queueWorkerHeartbeatAgeMs(presence, now = Date.now()) {
  const at = Date.parse(presence?.heartbeatAt || "");
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

// Fresh: written less than 2 minutes ago, and not more than the clock skew in the future (B-087).
export function queueWorkerPresenceFresh(presence, now = Date.now()) {
  const age = queueWorkerHeartbeatAgeMs(presence, now);
  return age >= -QUEUE_WORKER_CLOCK_SKEW_MS && age < QUEUE_WORKER_PRESENCE_FRESH_MS;
}

// EPERM means the process exists but belongs to someone else: alive, unlike processIsAlive.
export function queueWorkerPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// The one rule for "a worker runs here" (start refusal, --stop, --status, --release): a fresh
// heartbeat, or a live pid whose heartbeat is younger than 10 minutes (B-082).
export function queueWorkerPresenceLive(presence, now = Date.now()) {
  if (!presence) return false;
  if (queueWorkerPresenceFresh(presence, now)) return true;
  const age = queueWorkerHeartbeatAgeMs(presence, now);
  return age >= -QUEUE_WORKER_CLOCK_SKEW_MS && age < QUEUE_WORKER_PRESENCE_ABANDONED_MS && queueWorkerPidAlive(presence.pid);
}
