#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { freemem, homedir, tmpdir, totalmem, userInfo } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDirectRunAudit, directRunMetrics } from "./bin/direct-run-audit.js";
import { runBuilderModelFallback, sumOpenCodeUsage } from "./bin/builder-model-fallback.js";
import { resolvePluginManifestEntryPath } from "./bin/plugin-manifest-paths.js";
import { libPinError } from "./bin/lib-digest.js";
import { LIKELY_SECRET_PATTERNS, redactLikelySecrets, redactSensitiveText, patchLikelySecretLines, sanitizePersistedValue, sanitizeLogValue, failureSummary } from "./lib/redaction.js";
import { binaryTextFilesInPatch, patchFileEntries, diffStatFromPatch } from "./lib/git-patch.js";
import { createBridgeConfig } from "./lib/config.js";
import { createLoggingRuntime } from "./lib/logging.js";
import { createStateSchema } from "./lib/state/schema.js";
import { createStateDatabase } from "./lib/state/database.js";
import { createStateCrypto } from "./lib/state/crypto.js";
import { createQueueStoreRuntime } from "./lib/queue/store.js";
import { createQueueRetryRuntime } from "./lib/queue/retry.js";
import { createQueueWorkerFilesRuntime } from "./lib/queue/worker-files.js";
import { createAgentPolicyRuntime } from "./lib/agent-policy.js";
import { createOpenCodeEventRuntime } from "./lib/opencode-events.js";
import { createLockPlanRuntime } from "./lib/lock-plan.js";
import { createWorktreeRuntime } from "./lib/worktrees.js";
import { createLockRuntime } from "./lib/locks.js";
import { createValidationRuntime } from "./lib/validation-command.js";
import { createProcessTableRuntime } from "./lib/process-table.js";
import { createCommandRuntime } from "./lib/run-command.js";
import {
  queueRequestFingerprint,
  queueStartAfterPending,
  queueAgentTiming,
  queueResultFields,
  commandFingerprintFields,
  scopeContractDurableSummary,
  REQUEUE_ELIGIBLE_STATUSES,
  REQUEUE_UNFINISHED_STATUSES,
  requeueIdempotencyKey,
  requeueRefusal,
  RETRY_POLICY_DEFAULT_ATTEMPTS,
  RETRY_POLICY_MAX_ATTEMPTS,
  RETRY_POLICY_MAX_SLOT_WAITS,
  RETRY_POLICY_MAX_PAUSE_WAITS,
  RETRY_POLICY_HISTORY_MAX,
  RETRY_POLICY_ERROR_TYPES,
  retryPolicyRequirement,
  retryPolicyModelSpec,
  retryPolicyModelLabel,
  autoIntegrationRetryDelayMs,
  QUEUE_BLOCKED_BACKOFF_MAX_MS,
  queueHardLockRequestRefusal,
  QUEUE_WORKER_PRESENCE_FRESH_MS,
  queueWorkerPresenceFresh,
  queueWorkerPidAlive,
  queueWorkerPresenceLive,
} from "./lib/queue.js";
import {
  pipelineRecordSnapshot,
  pipelineReplayRequest,
  pipelinePersistenceKey,
  pipelineConcurrentUpdateError,
  pipelineRecordJson,
  pipelineTerminalError,
  pipelineIntegrationItemMatches,
  PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES,
  nextPipelineIntegrationItemStatus,
  pipelineHasPendingIntegrations,
} from "./lib/pipelines.js";
import {
  integrationFingerprintMode,
  integrationJournalAad,
  integrationJournalTargetPath,
  integrationJournalFingerprintSha256,
  integrationRecoveryErrorIsTransient,
  integrationPathspecs,
  integrationOperationResult,
  integrationOperationDiagnosisView,
  integrationScopePlan,
  integrationBatchItemLabel,
  integrationBatchOverlaps,
  integrationBatchItemAtLine,
  integrationPathsTouching,
  patchedPathsStateSha256Of,
  integrationContractValue,
  integrationContractSha256,
  integrationContractDifference,
  integrationQuarantineStatusLine,
  integrationPreviewReceiptSchema,
  integrationBatchItemSchema,
} from "./lib/integration.js";
import {
  MAX_AGENT_TIMEOUT_MS,
  DEFAULT_FORBIDDEN_EDIT_PATHS,
  scopePathSetSchema,
  scopeValidationSchema,
  MODEL_IDENTIFIER_PATTERN,
  MODEL_NAME_PATTERN,
  modelRequirementSchema,
  scopeContractSchema,
  normalizeScopeContract,
  normalizeProjectAgentPolicy,
  applyProjectPolicyToJobs,
  scopeContractPathInputs,
  formatScopeContractForPrompt,
  findSerialOnlyMatches,
  firstNonEmptyList,
} from "./lib/scope-contract.js";
import { parseCommandLine, formatValidationGateResult } from "./lib/validation-command.js";
import {
  retryAfterMsFromText,
  syntheticProviderQuotaNotice,
  parseOpenCodeLogLine,
  openCodeRateLimitHit,
  createRateLimitWatcher,
  providerErrorTypeFromText,
  providerErrorTypeFromDiagnosticLine,
  providerErrorTypeFromStructuredEvent,
} from "./lib/rate-limit.js";
import {
  readPositiveIntEnv,
  readNonNegativeIntEnv,
  readModelDurationMapEnv,
  readChoiceEnv,
} from "./lib/env.js";
import {
  REPOSITORY_SCOPE_LOCK_PATH,
  normalizeList,
  normalizeLockPath,
  filesystemCaseModeForRoot,
  realPathBoundaryReason,
  windowsStreamSyntax,
  unsafePathReason,
  normalizeLockPathList,
  normalizeLockPathForCwd,
  normalizeLockPathListForCwd,
  mergePathLists,
  globToRegex,
  isAbsolutePathLike,
  normalizeFilesystemCase,
  isWithinAnyPath,
  unsafeChangedFiles,
  isPathInside,
  normalizePathForCompare,
  hasAmbiguousPathPattern,
  overlaps,
} from "./lib/paths.js";
import { createPluginPolicyRuntime } from "./lib/plugin-policy.js";
import { WRITABLE_SCOPE_MAX_ENTRIES, STREAM_LISTING_MAX_COMMAND_CHARS, writableScopeRoots, writableScopeRelative, listAlternateDataStreams, captureWritableScopeFilesystemState, writableScopeFilesystemViolation } from "./lib/writable-scope.js";
import { createAgentResolutionRuntime } from "./lib/agent-resolution.js";
import { createOpenCodeCommandRuntime } from "./lib/opencode-command.js";
import { createResultFormatRuntime } from "./lib/result-format.js";
import { createFileSnapshotRuntime } from "./lib/file-snapshot.js";
import { createRollbackRuntime } from "./lib/rollback.js";
import { createIntegrationPatchRuntime } from "./lib/integration-patch.js";
import { createIntegrationApplyRuntime } from "./lib/integration-apply.js";
import { createIntegrationSerialRuntime } from "./lib/integration-serial.js";
import { createOpenCodeRunRuntime } from "./lib/opencode-run.js";
import { createIntegrationJournalRuntime } from "./lib/integration-journal.js";
import { createIntegrationPreviewRuntime } from "./lib/integration-preview.js";
import { createQueueLeaseRuntime } from "./lib/queue/leases.js";
import { createExecuteJobRuntime } from "./lib/execute-job.js";

const execFileAsync = promisify(execFile);
const BRIDGE_RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SERVER_PATH = fileURLToPath(import.meta.url);
const BRIDGE_SOURCE_SHA256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
const PROCESS_SUPERVISOR_PATH = path.join(BRIDGE_RUNTIME_DIR, "bin", "process-supervisor.js");
const {
  USER_HOME_DIR,
  DEFAULT_OPENCODE_CONFIG_DIR,
  DEFAULT_OPENCODE_DATA_DIR,
  DEFAULT_OPENCODE_CACHE_HOME,
  DEFAULT_OPENCODE_STATE_HOME,
  CODEX_STATE_HOME,
  OPENCODE_EXE,
  OPENCODE_AGENT_DIR,
  OPENCODE_SKILL_DIR,
  MCP_ORCHESTRATOR_AGENT,
  MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  STANDALONE_ORCHESTRATOR_AGENT,
  MCP_SANITIZED_READER_AGENT,
  MCP_SANITIZED_READER_PROFILE,
  MCP_SANITIZED_READER_PROMPT,
  MCP_SANITIZED_READER_PROMPT_SHA256,
  ORCHESTRATOR_AGENT_ALIASES,
  DEFAULT_SUBAGENT_PROXY_AGENT,
  CONTRACTOR_ALLOWED_SUBAGENTS,
  WRITE_CAPABLE_AGENTS,
  READ_ONLY_PARALLEL_AGENTS,
  SAFE_AGENT_BASH_ALLOW_PATTERNS,
  REQUIRED_MANAGED_AGENTS,
  GLOBALLY_REQUIRED_MANAGED_AGENTS,
  RELEASE_REQUIRED_MANAGED_AGENTS,
  REQUIRED_MANAGED_SKILLS,
  PARALLEL_LOCK_TYPES,
  SELF_TEST_TEMP_STATE_DIR,
  GLOBAL_BRIDGE_STATE_DIR,
  DISABLED_GIT_HOOKS_PATH,
  BRIDGE_OPENCODE_HOME_DIR,
  DEFAULT_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  ENV_PROVIDER_CONCURRENCY_LIMIT,
  ENV_QUEUE_PARALLEL_LIMIT,
  MAX_RUNTIME_CONCURRENCY_LIMIT,
  ENV_GLOBAL_WORKER_LIMIT,
  MAX_GLOBAL_WORKER_LIMIT,
  RUNTIME_CONCURRENCY,
  DEFAULT_MIN_FREE_MEMORY_MB,
  CONFIG,
  defaultReadOnlyAgentTimeoutMs,
  defaultWriteAgentTimeoutMs,
  defaultBuilderTimeoutMs,
  defaultOrchestratorTimeoutMs,
  defaultContractorOrchestratorTimeoutMs,
  maxReadOnlyAgentRetries,
  assertSupportedQueueRetryConfig,
  assertSupportedCallerModel,
  readOpenCodeLogPathEnv,
} = createBridgeConfig();

const DEFAULT_RETURN_FORMAT = [
  "1. Summary",
  "2. Lock used",
  "3. Files inspected",
  "4. Files changed",
  "5. Files wanted but not edited",
  "6. Changes made or proposed",
  "7. NEEDS_INTEGRATION, if required",
  "8. Dependencies: the DEPENDENCY_REQUIRED marker line only when a package manifest change is required; otherwise write \"Dependencies: none\"",
  "9. Risks",
  "10. Validation performed: only commands you ran in this run, each with its result (\"none run\" otherwise); never repeat test results stated in this task",
  "11. Validation still recommended",
].join("\n");
const QUEUE_JOBS = new Map();
const PIPELINE_RUNS = new Map();
const PIPELINE_PERSISTENCE_CHAINS = new Map();
const BRIDGE_INSTANCE_ID = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
const QUEUE_CAPABILITY_KEY = randomBytes(32);
const INTEGRATION_PREVIEWS = new Map();
const KNOWN_STATE_DB_PATHS = new Set();
// Repository roots whose writers wait for integration-journal recovery. Keys are normalized
// once here (resolved, case-folded on win32) so every add/has/delete site agrees on
// C:\Repo vs c:\repo; the entries are the normalized keys.
class RepositoryRootSet extends Set {
  static key(root) {
    return normalizeFilesystemCase(path.resolve(String(root || "") || process.cwd()));
  }

  add(root) { return super.add(RepositoryRootSet.key(root)); }

  has(root) { return super.has(RepositoryRootSet.key(root)); }

  delete(root) { return super.delete(RepositoryRootSet.key(root)); }
}
const INTEGRATION_RECOVERY_BLOCKED_ROOTS = new RepositoryRootSet();
// Integration journal statuses that no longer block writers. recovered_verified and
// resolved_by_operator close a quarantine through resolve_integration_quarantine (G-01).
const INTEGRATION_RESOLVED_STATUSES = Object.freeze(["committed", "rolled_back", "recovered_noop", "recovered_verified", "resolved_by_operator"]);
const INTEGRATION_RESOLVED_SQL = INTEGRATION_RESOLVED_STATUSES.map((status) => `'${status}'`).join(", ");
// Set to "1" only by bin/pipeline-admin.js for the bridge it starts; never in a client's MCP entry.
// It is what lets resolve_integration_quarantine accept_current run (an operator at a terminal).
const OPERATOR_CLI_ENV = "CODEX_OPENCODE_OPERATOR_CLI";
const PRIVATE_STATE_VACUUMED_DB_PATHS = new Set();
const INTEGRATION_PREVIEW_TTL_MS = 1000 * 60 * 60;

let queueSchedulerActive = false;
let queueWakeTimer = null;
let deferredRecoveryTimer = null;
let deferredRecoveryRunning = false;
let deferredRecoveryIdlePasses = 0;
// dbPath -> { fingerprint, pending }: an unchanged database with no non-terminal work is not reopened.
const DEFERRED_RECOVERY_DB_MEMO = new Map();
let stateDirectoryOverride = "";

// Construct shared services before startup probes can call them.
const {
  ensureTableColumn,
  ensureQueueLeaseSchema,
  ensurePipelineRevisionSchema,
  ensureIntegrationJournalSchema,
  ensureIntegrationPreviewReceiptSchema,
  ensureWorktreeArtifactSchema,
} = createStateSchema();

const {
  projectStateKey,
  recordMatchesProject,
  effectiveBridgeStateDirectory,
  stateDbPath,
  resolveProjectStateRoot,
  scrubLegacyLockSecrets,
  openLockDb,
  closeDb,
} = createStateDatabase({
  CONFIG,
  GLOBAL_BRIDGE_STATE_DIR,
  getStateDirectoryOverride: () => stateDirectoryOverride,
  runCommand: (...args) => runCommand(...args),
  assertNoLinkedPath,
  ensureLockTableSchema: (...args) => ensureLockTableSchema(...args),
  ensureTableColumn,
  ensureQueueLeaseSchema,
  ensurePipelineRevisionSchema,
  ensureIntegrationJournalSchema,
  ensureIntegrationPreviewReceiptSchema,
  ensureWorktreeArtifactSchema,
  migrateLegacyEncryptedState,
  BRIDGE_INSTANCE_ID,
  KNOWN_STATE_DB_PATHS,
  ensureQueueHeartbeatTimer: (...args) => ensureQueueHeartbeatTimer(...args),
  ensureStateMaintenanceTimer: (...args) => ensureStateMaintenanceTimer(...args),
  prunePersistedState: (...args) => prunePersistedState(...args),
});

const {
  queueRequestKeyPath,
  queueRequestKey,
  encryptQueueRequest,
  decryptQueueRequest,
  encryptIntegrationJournalBytes,
  decryptIntegrationJournalBytes,
} = createStateCrypto({
  effectiveBridgeStateDirectory,
  assertNoLinkedPath,
  CONFIG,
});

const {
  logEvent,
  opsLogEnabled,
} = createLoggingRuntime({
  CONFIG,
  effectiveBridgeStateDirectory,
  getStateDirectoryOverride: () => stateDirectoryOverride,
});

let queueModeOverride = "";
let queueWriteConflictPolicyOverride = "";

function effectiveQueueMode() {
  return queueModeOverride || CONFIG.queueMode;
}

function effectiveQueueWriteConflictPolicy() {
  return queueWriteConflictPolicyOverride || CONFIG.queueWriteConflictPolicy;
}

// B-042: the queue runs at most CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT jobs per bridge process, whatever
// the provider limit allows; with a provider limit of 10 and a queue limit of 6 (the default) four
// slots stayed empty and nothing said why. The numbers and the mismatch are printed by
// get_opencode_bridge_status and diagnose_opencode_bridge. The parallel-call limit is a separate
// setting (jobs per run_opencode_parallel call) and does not bound the queue.
function queueCapacityReport({
  queueParallelLimit = CONFIG.queueParallelLimit,
  parallelCallLimit = CONFIG.parallelLimit,
  providerConcurrencyLimit = CONFIG.providerConcurrencyLimit,
  queueMode = effectiveQueueMode(),
} = {}) {
  const warning = queueMode !== "off" && providerConcurrencyLimit > queueParallelLimit
    ? `Warning: the provider concurrency limit is ${providerConcurrencyLimit} (CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT) but the queue parallel limit is ${queueParallelLimit} (CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT): only ${queueParallelLimit} queued jobs will run at once per bridge process. Raise the queue limit to ${providerConcurrencyLimit}, or lower the provider limit.`
    : "";
  return { queueMode, queueParallelLimit, parallelCallLimit, providerConcurrencyLimit, warning };
}

// B-045: free-memory floor for starting queue jobs. Self-test only: stand in for os.freemem()
// (bytes) and for CODEX_OPENCODE_MIN_FREE_MEMORY_MB (CONFIG is frozen).
let freeMemoryBytesTestHook = null;
let minFreeMemoryMbOverride = null;
// jobId -> { since } for the pending jobs this process holds back for low memory; the stage of
// such a job reads "waiting_for_memory" (queueRunStage). Known only for the listing process's
// own jobs, like waiting_for_provider_slot.
const queueMemoryWaitingJobs = new Map();
let queueMemoryHold = null;

function currentFreeMemoryBytes() {
  if (typeof freeMemoryBytesTestHook === "function" && process.argv.includes("--self-test")) {
    const value = Number(freeMemoryBytesTestHook());
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return freemem();
}

// B-060: the floor is on by default, but a self-test run must not depend on how much memory the
// machine running the suite has free: there the default applies only when the variable is set.
const MIN_FREE_MEMORY_ENV_SET = String(process.env.CODEX_OPENCODE_MIN_FREE_MEMORY_MB ?? "").trim() !== "";

function effectiveMinFreeMemoryMb() {
  if (minFreeMemoryMbOverride !== null && minFreeMemoryMbOverride !== undefined) return minFreeMemoryMbOverride;
  if (!MIN_FREE_MEMORY_ENV_SET && process.argv.includes("--self-test")) return 0;
  return CONFIG.minFreeMemoryMb;
}

// B-060: the idle limit of one run: the per-model entry of CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL
// for the model that actually runs (override included), else CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS.
function agentIdleTimeoutForModel(metadata = null) {
  const key = `${String(metadata?.provider || "").toLowerCase()}/${String(metadata?.model || "").toLowerCase()}`;
  return CONFIG.agentIdleTimeoutByModel.has(key) ? CONFIG.agentIdleTimeoutByModel.get(key) : CONFIG.agentIdleTimeoutMs;
}

function agentIdleTimeoutStatusLine() {
  const perModel = [...CONFIG.agentIdleTimeoutByModel.entries()].map(([model, ms]) => `${model}=${ms} ms`);
  return `Agent idle timeout (CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS): ${CONFIG.agentIdleTimeoutMs > 0 ? `${CONFIG.agentIdleTimeoutMs} ms` : "disabled (0)"}; per model (CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL): ${perModel.length ? perModel.join(", ") : "none"}`;
}

function queueMemoryGate() {
  const floorMb = effectiveMinFreeMemoryMb();
  const freeMb = Math.floor(currentFreeMemoryBytes() / (1024 * 1024));
  const totalMb = Math.floor(totalmem() / (1024 * 1024));
  return { floorMb, freeMb, totalMb, blocked: floorMb > 0 && freeMb < floorMb };
}

// Lines of get_opencode_bridge_status: the floor, the memory the machine has now, and whether this
// process is holding jobs back for it.
function queueMemoryStatusLines(gate = queueMemoryGate()) {
  return [
    `Minimum free memory to start a queue job (CODEX_OPENCODE_MIN_FREE_MEMORY_MB): ${gate.floorMb > 0 ? `${gate.floorMb} MB` : "disabled (0)"}`,
    `Free memory now: ${gate.freeMb} MB of ${gate.totalMb} MB`,
    ...(gate.floorMb > 0 && gate.floorMb >= gate.totalMb
      ? [`Warning: the free-memory floor (${gate.floorMb} MB) is not below the machine's total memory (${gate.totalMb} MB): no queue job can ever start. Lower CODEX_OPENCODE_MIN_FREE_MEMORY_MB.`]
      : []),
    ...(gate.blocked
      ? [`Queue starts held for low memory: free memory is under the floor; ${queueMemoryWaitingJobs.size} pending job(s) of this bridge process wait (stage waiting_for_memory) and start when it recovers`]
      : []),
  ];
}

// Called by the scheduler pass: holds back every job that could start while free memory is under
// the floor. The jobs stay pending and the next poll (CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS) tries
// again; nothing is written to the durable record, so a held pass costs one memory read.
function holdQueueForMemory(gate, records) {
  const waiting = records.filter((record) => ["pending", "planned"].includes(record.status));
  const now = new Date().toISOString();
  for (const jobId of [...queueMemoryWaitingJobs.keys()]) {
    if (!waiting.some((record) => record.jobId === jobId)) queueMemoryWaitingJobs.delete(jobId);
  }
  for (const record of waiting) {
    if (!queueMemoryWaitingJobs.has(record.jobId)) queueMemoryWaitingJobs.set(record.jobId, { since: now });
  }
  if (!queueMemoryHold) {
    queueMemoryHold = { since: now, floorMb: gate.floorMb };
    logEvent("warn", "queue.memory_hold_started", { freeMb: gate.freeMb, floorMb: gate.floorMb, waitingJobs: waiting.length });
  }
  queueMemoryHold.freeMb = gate.freeMb;
  queueMemoryHold.waitingJobs = waiting.length;
}

function releaseQueueMemoryHold(gate) {
  if (queueMemoryHold) {
    logEvent("info", "queue.memory_hold_released", { freeMb: gate?.freeMb ?? 0, floorMb: gate?.floorMb ?? 0, heldSince: queueMemoryHold.since });
  }
  queueMemoryHold = null;
  queueMemoryWaitingJobs.clear();
}

// B-046: when the agent process of a queue job last wrote to stdout or stderr (epoch ms), by job id.
// Kept in this bridge process (like waiting_for_provider_slot): a listing from another bridge
// process shows no idle time. The entry exists only while the job's agent process runs.
const agentActivityByJobId = new Map();

function noteAgentActivity(jobId, atMs = Date.now()) {
  if (jobId) agentActivityByJobId.set(jobId, atMs);
}

function clearAgentActivity(jobId) {
  if (jobId) agentActivityByJobId.delete(jobId);
}

// "3m", "45s", "1h05m": how long a running agent has been silent.
function formatIdleDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000)) || 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
let selfTestContractorAuthorizationSha256 = "";
let selfTestModelOverrideAllowlist = null;
let pipelinePersistenceTestHook = null;
let queueCancellationTestHook = null;
let pipelineGateExecutorTestHook = null;
// Self-test only: stands in for agent discovery, attestation and the OpenCode run so the job
// and parallel paths can be exercised against a real Git checkout without a provider.
let agentRuntimeTestHook = null;

const server = new McpServer({
  name: "codex-opencode-bridge",
  version: "1.0.0",
});

// Long tool calls (builders can run 45 minutes) look idle to the client while OpenCode
// works. Claude Code aborts a stdio tool call after 30 idle minutes unless progress
// notifications arrive, so every handler whose request carries a progressToken sends one
// on an interval until it returns. Requests without a token get nothing extra.
function startToolProgressHeartbeat(extra) {
  const progressToken = extra?._meta?.progressToken;
  const intervalMs = CONFIG.toolProgressIntervalMs;
  if (progressToken === undefined || progressToken === null || typeof extra?.sendNotification !== "function" || !intervalMs) {
    return () => {};
  }
  const startedAt = Date.now();
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message: `Still running (${elapsedSeconds} s elapsed).` },
    }).catch(() => { /* A closed client simply stops receiving progress. */ });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Startup recovery runs right after the transport connects, so a slow recovery can no longer
// exceed the client's MCP startup timeout. Every tool call still waits for it (bounded) and
// then answers with a clear rejection instead of hanging or acting on unrecovered state.
let bridgeStartupRecovery = null;
const STARTUP_RECOVERY_TOOL_WAIT_MS = readPositiveIntEnv("CODEX_OPENCODE_STARTUP_RECOVERY_WAIT_MS", 1000 * 60 * 2);

async function awaitBridgeStartupRecovery(timeoutMs = STARTUP_RECOVERY_TOOL_WAIT_MS) {
  const pending = bridgeStartupRecovery;
  if (!pending) return { ok: true };
  let timer = null;
  try {
    return await Promise.race([
      // A rejected recovery is a failure: turning it into ok let early tool calls act on
      // unrecovered queue, pipeline and integration state.
      pending.then(() => ({ ok: true }), (error) => ({ ok: false, failed: true, error })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), Math.max(0, Number(timeoutMs) || 0));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Starts startup recovery and remembers it for awaitBridgeStartupRecovery. The failure is
// logged here but the promise stays rejected, so every tool call answers startup_recovery_failed
// instead of running on unrecovered state. `run` is a seam for tests.
function beginBridgeStartupRecovery(run = reconcileQueueStateAtStartup) {
  const recovery = Promise.resolve().then(run);
  recovery.catch((error) => {
    logEvent("error", "state.startup_recovery_failed", {
      errorType: error?.errorType || "startup_recovery_failed",
      error: redactSensitiveText(error?.message || String(error)),
    });
  });
  bridgeStartupRecovery = recovery;
  return recovery;
}

function startupRecoveryFailedResult(error) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: [
        "Bridge startup recovery failed.",
        "errorType: startup_recovery_failed",
        `The bridge could not recover durable queue, pipeline and integration state, so it refuses tool calls instead of acting on unrecovered state: ${redactSensitiveText(error?.message || String(error))}`,
        "Restart the bridge. The failure is in the bridge log as state.startup_recovery_failed.",
      ].join("\n"),
    }],
  };
}

function startupRecoveryPendingResult() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: [
        "Bridge startup recovery still running.",
        "errorType: startup_recovery_pending",
        `The bridge is still recovering durable queue, pipeline and integration state (waited ${Math.round(STARTUP_RECOVERY_TOOL_WAIT_MS / 1000)} s). Retry the call shortly; get_opencode_bridge_status reports the bridge once recovery finishes.`,
      ].join("\n"),
    }],
  };
}

const registerToolWithoutProgress = server.tool.bind(server);
server.tool = (...registration) => {
  const handler = registration[registration.length - 1];
  if (typeof handler === "function") {
    registration[registration.length - 1] = async (...handlerArgs) => {
      const stop = startToolProgressHeartbeat(handlerArgs[handlerArgs.length - 1]);
      try {
        const recovery = await awaitBridgeStartupRecovery();
        if (!recovery.ok) return recovery.failed ? startupRecoveryFailedResult(recovery.error) : startupRecoveryPendingResult();
        return await handler(...handlerArgs);
      } finally {
        stop();
      }
    };
  }
  return registerToolWithoutProgress(...registration);
};

const sanitizedWorkspaceSchema = z
  .object({
    root: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    requiredFiles: z.array(z.string()).optional(),
    forbiddenFiles: z.array(z.string()).optional(),
  })
  .strict();

// One job shape shared by run_opencode_agent, enqueue_opencode_job,
// validate_delegation_plan, and run_opencode_parallel. Scope details belong in
// scopeContract; the top-level path fields stay because Codex sends them directly.
// Older aliases (top-level role/mode/scope/actions/validation/timeoutPolicy,
// ownedPaths, and the long-form delegation packet) are no longer advertised.
const jobInputShape = {
  agent: z.string().describe("Agent name: planner, architect, explore, reviewer, tester, builder, or debugger."),
  task: z.string().describe("Task prompt for the agent."),
  cwd: z.string().min(1).describe("Absolute repository path."),
  write: z.boolean().optional().describe("True when the job may edit files. Write jobs need lockedPaths and allowedEdits."),
  lockMode: z.string().optional().describe("off (read-only), simple (one writer), or strict (parallel writers)."),
  lockType: z.string().optional().describe("read, write, or serial_integration."),
  lockedPaths: z.array(z.string()).optional().describe("Paths this job owns; apps/web/** normalizes to apps/web."),
  allowedEdits: z.array(z.string()).optional().describe("Files the job may change."),
  forbiddenEdits: z.array(z.string()).optional(),
  sharedFiles: z.array(z.string()).optional(),
  serialOnly: z.array(z.string()).optional(),
  validationCommand: z.string().optional().describe("Command run after the agent, e.g. npm test. Checked before the agent starts."),
  selfCheckPasses: z.number().int().min(0).max(3).optional().describe("With scopeContract.selfCheckCommands: how many more agent runs a failing self-check may get, each with the check's output (default 2, at most 3; 0 = none). Not available in run_opencode_parallel."),
  validationFixPasses: z.number().int().min(0).max(1).optional().describe("0 (default) or 1. A write job cannot run its own checks (builders have no shell), so with 1 a failed validationCommand gives the agent one more run in the same worktree with the validation output, then validates again. Uses the rest of the job timeout; scope and lock rules apply unchanged. Not available in run_opencode_parallel."),
  timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional().describe("Agent run timeout in ms (at most 24 h). Waiting for a provider slot is not counted."),
  models: z.array(z.string().min(1).max(300)).min(1).max(8).optional().describe("enqueue_opencode_job only. Models to try in order, each provider/model[@variant] from CODEX_OPENCODE_MODEL_ALLOWLIST. After a provider failure (rate limit, pause, quota, 5xx), an idle stop, a timeout, no output or a failed validation the bridge requeues the job on the next model that is not paused; after maxAttempts it marks the job outcome=gave_up."),
  maxAttempts: z.number().int().min(1).max(10).optional().describe("enqueue_opencode_job only. Attempts in total, the first included (default 4 when models is given). Alone (without models) it retries on the same model."),
  autoIntegrate: z.boolean().optional().describe("enqueue_opencode_job only, write jobs with a validationCommand. When the finished job only ADDED new files and its validation passed, the bridge integrates them (the same dry run, receipt, validation and rollback as integrate_opencode_worktree) and commits exactly those files with the target repository's last commit identity. Any other patch keeps the normal reviewed flow."),
  dryRun: z.boolean().optional().describe("Validate routing without running OpenCode."),
  scopeContract: scopeContractSchema.optional().describe("Full Scope Contract; required for write jobs."),
  allowFallbackToBuild: z.boolean().optional(),
  subagentStrategy: z.enum(["proxy", "reject"]).optional(),
  proxyAgent: z.string().optional(),
  orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional().describe("Only when the user named the OpenCode Orchestrator."),
  userAuthorizedOrchestrator: z.boolean().optional(),
  contractorAuthorizationToken: z.string().optional(),
  sanitizedWorkspace: sanitizedWorkspaceSchema.optional(),
  delegation: z.object({
    permissions: z.string().optional(),
    returnFormat: z.string().optional(),
  }).optional().describe("Optional prompt hints: permissions summary and expected return format."),
};




// Windows editors (Notepad, PowerShell 5 Out-File) write UTF-8 with a byte-order mark, which
// JSON.parse rejects. Callers hash the raw bytes first; only the parse ignores the BOM.
function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ""));
}

async function runSingleFlight(flights, key, operation) {
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = Promise.resolve().then(operation);
  flights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

// Attestation results are reused while nothing they depend on has changed. Each
// entry is bound to a fingerprint of the managed agent/skill sources and the
// OpenCode config files, so any edit forces a fresh attestation on the next job.
// Failed results and isolated-runtime (forcePure) attestations are never cached,
// and deep bridge status clears the cache. Plugin package trees are re-hashed only
// when an entry expires (CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS, 0 disables).
const attestationCache = new Map();
const attestationFlights = new Map();
let attestationCacheTtlOverride = null;

function attestationCacheTtlMs() {
  if (attestationCacheTtlOverride !== null) return attestationCacheTtlOverride;
  return process.argv.includes("--self-test") ? 0 : CONFIG.attestationCacheTtlMs;
}

function clearAttestationCache() {
  attestationCache.clear();
}

async function statFingerprint(filePath) {
  try {
    const details = await stat(filePath);
    return `${filePath}\0${details.size}\0${details.mtimeMs}`;
  } catch {
    return `${filePath}\0missing`;
  }
}

async function attestationFingerprint() {
  const configFiles = ["opencode.json", "opencode.jsonc", "config.json", "antigravity.json", "package.json"]
    .map((name) => path.join(DEFAULT_OPENCODE_CONFIG_DIR, name));
  let agentFiles = [];
  try {
    agentFiles = (await readdir(OPENCODE_AGENT_DIR))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort()
      .map((name) => path.join(OPENCODE_AGENT_DIR, name));
  } catch {
    agentFiles = [];
  }
  const tracked = [...configFiles, ...agentFiles, CONFIG.externalPluginManifestPath].filter(Boolean);
  const parts = await Promise.all(tracked.map(statFingerprint));
  const skills = await managedSkillSourceEvidence();
  parts.push(`skills\0${skills.ok ? skills.sha256 : "unavailable"}\0${skills.fileCount}`);
  parts.push(`plugins\0${CONFIG.allowExternalPlugins ? CONFIG.externalPluginAllowlist.join(",") : "pure"}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function cachedAttestation(key, operation, cacheable) {
  const ttl = attestationCacheTtlMs();
  if (ttl <= 0) return operation();
  const fingerprint = await attestationFingerprint();
  const hit = attestationCache.get(key);
  if (hit && hit.fingerprint === fingerprint && Date.now() - hit.at < ttl) {
    return structuredClone(hit.value);
  }
  const value = await runSingleFlight(attestationFlights, `${key}\0${fingerprint}`, operation);
  if (cacheable(value)) {
    attestationCache.set(key, { fingerprint, value: structuredClone(value), at: Date.now() });
  } else {
    attestationCache.delete(key);
  }
  return structuredClone(value);
}

function attestationCwdKey(cwd) {
  return normalizePathForCompare(path.resolve(cwd || process.cwd()));
}

const OPENCODE_BASE_ENV_KEYS = new Set([
  "APPDATA",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "TERM",
]);
const SENSITIVE_ENV_PATTERN = /(?:api[-_]?key|access[-_]?token|auth|credential|password|secret|token|private[-_]?key|(?:^|_)pat(?:$|_))/i;

function buildOpenCodeEnv(extra = {}) {
  const passthrough = new Set(
    String(process.env.CODEX_OPENCODE_PASSTHROUGH_ENV || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const allowSensitive = String(process.env.CODEX_OPENCODE_ALLOW_SENSITIVE_ENV || "").trim().toLowerCase() === "true";
  const env = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    const forbiddenConfigOverride = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"].includes(key.toUpperCase());
    const permitted = OPENCODE_BASE_ENV_KEYS.has(key) || passthrough.has(key);
    const runtimePathKey = ["PATH", "PATHEXT", "HOMEPATH"].includes(key.toUpperCase());
    if (forbiddenConfigOverride || !permitted || (!runtimePathKey && !allowSensitive && SENSITIVE_ENV_PATTERN.test(key))) {
      continue;
    }
    env[key] = value;
  }
  if (process.platform === "win32" && !Object.keys(env).some((key) => key.toUpperCase() === "PATHEXT")) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  // OpenCode also scans the legacy $HOME/.opencode tree even when repository
  // config is disabled. Keep that control surface bridge-owned while preserving
  // the operator's explicit XDG config/data/cache/state locations.
  env.HOME = String(extra.HOME || BRIDGE_OPENCODE_HOME_DIR);
  env.USERPROFILE = String(extra.USERPROFILE || env.HOME);
  env.XDG_CONFIG_HOME = String(extra.XDG_CONFIG_HOME || path.dirname(DEFAULT_OPENCODE_CONFIG_DIR));
  env.XDG_DATA_HOME = String(extra.XDG_DATA_HOME || path.dirname(DEFAULT_OPENCODE_DATA_DIR));
  env.XDG_CACHE_HOME = String(extra.XDG_CACHE_HOME || DEFAULT_OPENCODE_CACHE_HOME);
  env.XDG_STATE_HOME = String(extra.XDG_STATE_HOME || DEFAULT_OPENCODE_STATE_HOME);
  // OpenCode's version-pinned internal plugins include the Codex OAuth transport.
  // `--pure` suppresses configured external plugins without disabling those
  // binary-bundled authentication hooks. External plugins are verified below.
  delete env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
  // Repository-controlled OpenCode config can register local/remote MCP servers,
  // provider endpoints, formatters, and other executable control surfaces. Bridge
  // jobs use only operator-managed global configuration and bridge-pinned CLI args.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  env.OPENCODE_DISABLE_SHARE = "true";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "true";
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  // Each bridge child is a bounded one-shot process. Durable queue/pipeline audit
  // belongs to the bridge SQLite store; a shared OpenCode session DB creates
  // cross-process lock races and unnecessary prompt/session persistence.
  env.OPENCODE_DB = ":memory:";
  env.OPENCODE_DISABLE_CHANNEL_DB = "true";
  // The agent's own git: a repository-local fsmonitor hook, external diff or gpg.program (run
  // by log.showSignature) must not execute. Appended after any operator entries so they win.
  const inheritedConfigCount = /^\d+$/.test(String(env.GIT_CONFIG_COUNT || "")) ? Number(env.GIT_CONFIG_COUNT) : 0;
  if (!inheritedConfigCount) {
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
    }
  }
  [["core.fsmonitor", "false"], ["diff.external", ""], ["log.showSignature", "false"]].forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${inheritedConfigCount + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${inheritedConfigCount + offset}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(inheritedConfigCount + 3);
  return env;
}

async function readOpenCodeAuthContentForIsolatedRuntime() {
  const authPath = path.join(DEFAULT_OPENCODE_DATA_DIR, "auth.json");
  try {
    const authStat = await stat(authPath);
    if (!authStat.isFile() || authStat.size > 1024 * 1024) {
      throw new Error("OpenCode auth.json is not a bounded regular file.");
    }
    const content = await readFile(authPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenCode auth.json must contain a JSON object.");
    }
    return content;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function createIsolatedOpenCodeRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), `codex-opencode-sanitized-${process.pid}-`));
  try {
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const cacheHome = path.join(root, "cache");
    const stateHome = path.join(root, "state");
    const temporaryHome = path.join(root, "tmp");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(configHome, { recursive: true }),
      mkdir(cacheHome, { recursive: true }),
      mkdir(stateHome, { recursive: true }),
      mkdir(temporaryHome, { recursive: true }),
    ]);
    const env = buildOpenCodeEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      TEMP: temporaryHome,
      TMP: temporaryHome,
      TMPDIR: temporaryHome,
    });
    env.OPENCODE_DB = ":memory:";
    env.OPENCODE_DISABLE_CHANNEL_DB = "true";
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    env.OPENCODE_DISABLE_SHARE = "true";
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
    env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
    env.OPENCODE_DISABLE_MODELS_FETCH = "true";
    env.OPENCODE_DISABLE_AUTOUPDATE = "true";
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      plugin: [],
      mcp: {},
      formatter: false,
      lsp: false,
      share: "disabled",
      autoshare: false,
      autoupdate: false,
      skills: { paths: [], urls: [] },
      agent: {
        [MCP_SANITIZED_READER_AGENT]: {
          description: "Bridge-owned reader for exact manifest-pinned sanitized workspaces.",
          mode: MCP_SANITIZED_READER_PROFILE.mode,
          model: `${MCP_SANITIZED_READER_PROFILE.provider}/${MCP_SANITIZED_READER_PROFILE.model}`,
          variant: MCP_SANITIZED_READER_PROFILE.variant,
          temperature: 0,
          prompt: MCP_SANITIZED_READER_PROMPT,
          tools: { apply_patch: false, edit: false, write: false, task: false, bash: false, webfetch: false, websearch: false, skill: false },
          permission: {
            edit: "deny",
            task: "deny",
            bash: "deny",
            webfetch: "deny",
            websearch: "deny",
            external_directory: "deny",
            skill: "deny",
            lsp: "deny",
            repo_clone: "deny",
          },
        },
      },
    });
    const authContent = await readOpenCodeAuthContentForIsolatedRuntime();
    if (authContent) env.OPENCODE_AUTH_CONTENT = authContent;
    return { root, env };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function overwriteRegularFile(file, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return;
  const handle = await open(file, "r+");
  try {
    const zeros = Buffer.alloc(Math.min(64 * 1024, size));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(zeros.length, size - offset);
      await handle.write(zeros, 0, length, offset);
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function wipeIsolatedOpenCodeRuntime(root) {
  const resolvedRoot = path.resolve(root || "");
  const expectedPrefix = `codex-opencode-sanitized-${process.pid}-`;
  if (!isPathInside(path.resolve(tmpdir()), resolvedRoot) || !path.basename(resolvedRoot).startsWith(expectedPrefix)) {
    return { ok: false, error: "Refused to clean an untrusted isolated OpenCode runtime path." };
  }
  try {
    const wipeTree = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        const targetStat = await lstat(target);
        if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
          await wipeTree(target);
        } else if (targetStat.isFile()) {
          await overwriteRegularFile(target, targetStat.size);
        }
      }
    };
    await wipeTree(resolvedRoot);
    await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: redactSensitiveText(error.message || String(error)) };
  }
}

function buildValidationEnv(extra = {}) {
  const env = {};
  for (const key of OPENCODE_BASE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!SENSITIVE_ENV_PATTERN.test(key)) {
      env[key] = value;
    }
  }
  if (process.platform === "win32" && !Object.keys(env).some((key) => key.toUpperCase() === "PATHEXT")) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_0 = "false";
  env.GIT_CONFIG_KEY_1 = "core.untrackedCache";
  env.GIT_CONFIG_VALUE_1 = "false";
  if (process.platform === "win32") {
    env.GIT_CONFIG_KEY_2 = "core.longpaths";
    env.GIT_CONFIG_VALUE_2 = "true";
    env.GIT_CONFIG_COUNT = "3";
  }
  return env;
}

const TRUSTED_GIT_EXTRA_ENV_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

function isGitExecutable(command) {
  const executable = path.basename(String(command || "")).toLowerCase();
  return executable === "git" || executable === "git.exe";
}

// Bridge-owned Git drops the operator's system and global config (GIT_CONFIG_NOSYSTEM,
// GIT_CONFIG_GLOBAL=NUL). That also dropped Git for Windows' system core.autocrlf=true: a
// clean CRLF checkout looked modified to bridge Git after a timestamp-only change, bridge
// worktrees were checked out with LF, and the integration apply saw every CRLF target file as
// "needs update". The line-ending keys are read once, with the operator's plain environment,
// from the system and global levels, and handed to bridge Git as its *global* config file.
// A repository-local value (the self-test repositories and this repository set
// core.autocrlf=false) therefore still wins exactly as it does for the operator's Git; a
// `-c`/GIT_CONFIG_COUNT override would have beaten it. Only these keys with these literal
// values are carried; any other value counts as unset. core.symlinks is carried for the
// same reason: Git for Windows sets it in the system config, and it decides whether a
// 120000 entry is checked out as a symlink or as a plain file.
const USER_LINE_ENDING_GIT_CONFIG_KEYS = new Map([
  ["core.autocrlf", /^(?:true|false|input)$/],
  ["core.eol", /^(?:lf|crlf|native)$/],
  ["core.safecrlf", /^(?:true|false|warn)$/],
  ["core.symlinks", /^(?:true|false)$/],
]);
const NULL_GIT_CONFIG_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

// These reads run at import, before the transport connects, so they count against the client's
// 30 s MCP startup deadline. Two sequential 15 s reads could use all of it; the levels are now
// read together under one short bound (worst case 10 s).
const USER_GIT_CONFIG_READ_TIMEOUT_MS = 1000 * 10;

async function readUserLineEndingGitConfig({ execFile = execFileAsync } = {}) {
  const values = new Map();
  const readLevel = async (scope) => {
    try {
      const { stdout } = await execFile("git", ["config", scope, "--includes", "--get-regexp", "^core\\.(autocrlf|eol|safecrlf|symlinks)$"], {
        cwd: tmpdir(),
        shell: false,
        timeout: USER_GIT_CONFIG_READ_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: process.env,
      });
      return String(stdout || "");
    } catch (error) {
      // Exit 1 means no key is set at that level; a missing git leaves Git's defaults.
      return String(error?.stdout || "");
    }
  };
  // Later levels win, as in Git: global overrides system, whichever read finishes first.
  for (const stdout of await Promise.all(["--system", "--global"].map(readLevel))) {
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(\S+)\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim().toLowerCase();
      if (USER_LINE_ENDING_GIT_CONFIG_KEYS.get(key)?.test(value)) values.set(key, value);
    }
  }
  return values;
}

// Written lazily, on the first Git process of a state directory, never at module import:
// tests (and embedders) import this file first and only afterwards point
// hooks.stateDirectoryOverride at a scratch directory, so an import-time write landed in the
// operator's real state directory. Synchronous because buildTrustedGitEnv is; the file is a
// few bytes and is written once per state directory.
function writeUserLineEndingGitConfigFile(values, directory) {
  if (!values.size) return NULL_GIT_CONFIG_PATH;
  const content = `[core]\n${[...values].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `\t${key.slice("core.".length)} = ${value}\n`).join("")}`;
  // Content-addressed in the operator-private state directory, so concurrent bridge
  // processes write identical bytes and a shared temporary directory is never trusted.
  const file = path.join(directory, `git-line-endings-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.gitconfig`);
  const current = () => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  };
  try {
    if (current() === content) return file;
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  } catch {
    // Another bridge process may have renamed the same content-addressed file first.
  }
  if (current() === content) return file;
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "git.line_ending_config_unavailable" }));
  return NULL_GIT_CONFIG_PATH;
}

const USER_LINE_ENDING_GIT_CONFIG = await readUserLineEndingGitConfig();
// state directory -> gitconfig path (or the null config when it could not be written)
const BRIDGE_GIT_GLOBAL_CONFIG_PATHS = new Map();

function bridgeGitGlobalConfigPath() {
  const directory = effectiveBridgeStateDirectory();
  const known = BRIDGE_GIT_GLOBAL_CONFIG_PATHS.get(directory);
  // A state directory that was wiped since (a scratch directory a test removed and
  // recreated) gets the file again; Git would silently read a missing file as empty.
  if (known !== undefined && (known === NULL_GIT_CONFIG_PATH || existsSync(known))) return known;
  const file = writeUserLineEndingGitConfigFile(USER_LINE_ENDING_GIT_CONFIG, directory);
  BRIDGE_GIT_GLOBAL_CONFIG_PATHS.set(directory, file);
  return file;
}

// Enforced on every bridge Git process, as GIT_CONFIG_COUNT entries and as `-c` options.
// log.showSignature/gpg.* keep a repository-local gpg.program from running inside bridge
// `git log` (readOnlyHeadMove ran one); core.pager is never a repository program.
const TRUSTED_GIT_ENFORCED_CONFIG = [
  ["core.hooksPath", DISABLED_GIT_HOOKS_PATH],
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["credential.helper", ""],
  ["diff.external", ""],
  // Bridge-owned Git ignores global config, so opt into long paths explicitly:
  // generated worktree roots plus repository-relative paths routinely exceed MAX_PATH.
  ...(process.platform === "win32" ? [["core.longpaths", "true"]] : []),
  ["log.showSignature", "false"],
  ["gpg.program", ""],
  ["gpg.ssh.program", ""],
  ["gpg.x509.program", ""],
  ["core.pager", "cat"],
];

function buildTrustedGitEnv(extra = null) {
  const env = buildValidationEnv();
  for (const key of TRUSTED_GIT_EXTRA_ENV_KEYS) {
    if (extra && extra[key] !== undefined) env[key] = extra[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = bridgeGitGlobalConfigPath();
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  // Paths the bridge passes to git are file names (app/[slug]/page.tsx), never patterns; as
  // glob pathspecs `git add -N -- app/[slug]/page.tsx` would also match app/s/page.tsx.
  env.GIT_LITERAL_PATHSPECS = "1";
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  TRUSTED_GIT_ENFORCED_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(TRUSTED_GIT_ENFORCED_CONFIG.length);
  return env;
}

function trustedGitArgs(args = []) {
  const trusted = [...args];
  let subcommandIndex = 0;
  const pairedGlobalOptions = new Set(["-c", "-C", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);
  while (subcommandIndex < trusted.length) {
    const argument = trusted[subcommandIndex];
    if (pairedGlobalOptions.has(argument)) {
      subcommandIndex += 2;
      continue;
    }
    if (argument.startsWith("-")) {
      subcommandIndex += 1;
      continue;
    }
    break;
  }
  if (subcommandIndex >= trusted.length) return trusted;
  const enforcedConfig = [
    ...TRUSTED_GIT_ENFORCED_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    "-c", "core.quotePath=false",
  ];
  trusted.splice(subcommandIndex, 0, ...enforcedConfig);
  const actualSubcommandIndex = subcommandIndex + enforcedConfig.length;
  if (trusted[actualSubcommandIndex] === "diff") {
    if (!trusted.includes("--no-ext-diff")) trusted.splice(actualSubcommandIndex + 1, 0, "--no-ext-diff");
    if (!trusted.includes("--no-textconv")) trusted.splice(actualSubcommandIndex + 1, 0, "--no-textconv");
  }
  return trusted;
}

// The directory that holds the repository's shared control files (config, hooks, info/,
// objects/): `.git` itself, or the common dir a linked worktree's `.git` pointer file leads
// to. Found by walking up from `startDir` as Git does, without spawning a process. "" when
// no repository is found.
async function resolveGitCommonDirectory(startDir) {
  let directory = path.resolve(startDir || process.cwd());
  for (;;) {
    const dotGit = path.join(directory, ".git");
    let details = null;
    try {
      details = await stat(dotGit);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (details?.isDirectory()) return dotGit;
    if (details?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
      if (!pointer) return "";
      const gitDir = path.resolve(directory, pointer[1]);
      try {
        return path.resolve(gitDir, (await readFile(path.join(gitDir, "commondir"), "utf8")).trim());
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return gitDir;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "";
    directory = parent;
  }
}

// Files under the common .git/ directory that Git honours but that no patch ever shows:
// info/attributes sets filter, diff, merge, eol and text attributes for every path (the file
// counterpart of the core.attributesfile key refused below), and objects/info/alternates adds
// another directory to the object store. A line that is neither blank nor a comment makes
// the file effective. Reported next to the config keys, under these labels.
const GIT_CONTROL_FILES_WITH_EFFECT = [
  ["info/attributes", ["info", "attributes"]],
  ["objects/info/alternates", ["objects", "info", "alternates"]],
];

async function inspectGitControlFilesWithEffect(cwd) {
  const effective = [];
  const commonDir = await resolveGitCommonDirectory(cwd);
  if (!commonDir) return effective;
  for (const [label, segments] of GIT_CONTROL_FILES_WITH_EFFECT) {
    let text = "";
    try {
      text = await readFile(path.join(commonDir, ...segments), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (text.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#"))) effective.push(label);
  }
  return effective;
}

// G-10: a merge, rebase, cherry-pick, revert or bisect that is still in progress, or an index with
// unmerged entries. Applying onto such a target, or starting a writer from it, mixes the
// agent's change into an operation the operator has not finished, and rollback can no longer
// tell whose state it restores. allowDirtyTarget does not admit it. --git-path resolves each
// name for linked worktrees, whose operation state lives in .git/worktrees/<name>/.
const GIT_OPERATION_STATE_PATHS = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["sequencer", "cherry-pick or revert sequence"],
  ["BISECT_LOG", "bisect"],
];

async function inspectRepositoryOperationState(cwd) {
  const args = ["rev-parse", ...GIT_OPERATION_STATE_PATHS.flatMap(([name]) => ["--git-path", name])];
  const [located, unmerged] = await Promise.all([
    runCommand("git", args, cwd, 1000 * 15, buildValidationEnv({ GIT_OPTIONAL_LOCKS: "0" })),
    runGitReadOnlyCommand(["ls-files", "--unmerged", "-z"], cwd, 1000 * 30),
  ]);
  const lines = String(located.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (located.exitCode !== 0 || lines.length !== GIT_OPERATION_STATE_PATHS.length || unmerged.exitCode !== 0) {
    return {
      ok: false,
      errorType: "target_operation_state_unreadable",
      error: `Could not check the repository for an unfinished merge, rebase, cherry-pick, revert or bisect: ${located.stderr || unmerged.stderr || "git rev-parse --git-path returned an unexpected answer"}`,
      suggestedFix: "Check that git works in this repository (git status), then retry.",
    };
  }
  const found = [];
  GIT_OPERATION_STATE_PATHS.forEach(([name, operation], index) => {
    if (existsSync(path.resolve(cwd, lines[index]))) found.push({ name, operation });
  });
  const unmergedPaths = [...new Set(splitNulSeparated(unmerged.stdout).map((entry) => entry.replace(/^[^\t]*\t/, "")))];
  if (!found.length && !unmergedPaths.length) return { ok: true };
  const operations = [...new Set(found.map((entry) => entry.operation))];
  const described = [
    ...(operations.length ? [`a ${operations.join(", ")} in progress (${found.map((entry) => entry.name).join(", ")})`] : []),
    ...(unmergedPaths.length ? [`${unmergedPaths.length} unmerged index path(s): ${unmergedPaths.slice(0, 10).join(", ")}${unmergedPaths.length > 10 ? ", ..." : ""}`] : []),
  ];
  return {
    ok: false,
    errorType: "target_operation_in_progress",
    error: `The repository has ${described.join(" and ")}. The bridge does not apply patches to, or start writers from, a repository in the middle of a Git operation; allowDirtyTarget does not change this. Finish or abort the operation, then retry.`,
    suggestedFix: "Finish or abort the operation in the repository (git merge --continue/--abort, git rebase --continue/--abort, git cherry-pick --continue/--abort (or --quit for a leftover sequencer), git revert --continue/--abort/--quit, git bisect reset; resolve and stage every conflicted file), then retry.",
    operationState: found.map((entry) => entry.name),
    unmergedPaths: unmergedPaths.slice(0, 50),
    conflictingPaths: unmergedPaths.slice(0, 50),
  };
}

async function inspectRepositoryGitControlSurface(cwd) {
  const listed = await runCommand("git", ["config", "--local", "--name-only", "--list"], cwd, 1000 * 15);
  if (listed.exitCode !== 0) {
    return {
      ok: false,
      errorType: "git_repository_config_unreadable",
      error: listed.stderr || listed.stdout || "Could not inspect repository-local Git configuration.",
      unsafeKeys: [],
    };
  }
  // Every key that names a program Git may run (pager, editor, proxy, askpass, gpg, fsmonitor
  // hook, external diff, upload/receive-pack) or that makes Git run one (log.showSignature).
  const unsafePattern = /^(?:filter\..*|diff\..*\.(?:command|textconv)|diff\.external|merge\..*\.driver|core\.(?:attributesfile|sshcommand|pager|editor|gitproxy|askpass)|credential\..*|http\..*\.extraheader|url\..*\.insteadof|include(?:if)?\..*|gpg\..*|log\.showsignature|pager\..*|sequence\.editor|uploadpack\..*|remote\..*\.(?:uploadpack|receivepack))$/i;
  const listedKeys = String(listed.stdout || "").split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
  const unsafeKeys = new Set(listedKeys.filter((key) => unsafePattern.test(key)));
  // core.fsmonitor=true/false selects Git's builtin daemon or none; any other value is a hook
  // program path that every status/diff would execute.
  if (listedKeys.some((key) => key.toLowerCase() === "core.fsmonitor")) {
    const monitor = await runCommand("git", ["config", "--local", "--get-all", "core.fsmonitor"], cwd, 1000 * 15);
    const values = String(monitor.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (monitor.exitCode !== 0 || values.some((value) => !/^(?:true|false|yes|no|on|off|1|0)$/i.test(value))) {
      unsafeKeys.add("core.fsmonitor");
    }
  }
  try {
    for (const label of await inspectGitControlFilesWithEffect(cwd)) unsafeKeys.add(label);
  } catch (error) {
    return {
      ok: false,
      errorType: "git_repository_config_unreadable",
      error: `Could not inspect the repository's .git/info/attributes and .git/objects/info/alternates: ${error?.message || String(error)}`,
      unsafeKeys: [],
    };
  }
  const sortedUnsafeKeys = [...unsafeKeys].sort();
  return sortedUnsafeKeys.length
    ? {
        ok: false,
        errorType: "git_repository_config_unsafe",
        error: `Repository-local Git configuration contains executable, credential-bearing or content-altering controls: ${sortedUnsafeKeys.join(", ")}.`,
        unsafeKeys: sortedUnsafeKeys,
      }
    : { ok: true, errorType: null, error: "", unsafeKeys: [] };
}

// Git never reports edits under .git/ as changes, so a writer that rewrote .git/config
// (core.hooksPath, an alias, a filter driver) or dropped a hook would pass every
// changed-file check. This fingerprint covers the control files a job could use to run
// code later or change what Git shows: the repository config (and a linked worktree's
// config.worktree), every hook, info/attributes, objects/info/alternates, and a linked
// worktree's `.git` pointer file. Compare it before and after a write job.
async function gitControlSurfaceFingerprint(cwd) {
  const root = path.resolve(cwd || process.cwd());
  const entries = {};
  const record = async (label, filePath) => {
    try {
      const details = await lstat(filePath);
      if (details.isSymbolicLink()) {
        entries[label] = `symlink:${await readlink(filePath)}`;
      } else if (details.isFile()) {
        entries[label] = `file:${details.mode & 0o777}:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
      } else {
        entries[label] = `other:${details.isDirectory() ? "directory" : "special"}`;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      entries[label] = "missing";
    }
  };
  try {
    const dotGit = path.join(root, ".git");
    await record(".git", dotGit);
    let gitDir = dotGit;
    let commonDir = dotGit;
    if (entries[".git"].startsWith("file:")) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
      if (!pointer) return { ok: false, sha256: "", entries, error: "The .git file does not name a gitdir." };
      gitDir = path.resolve(root, pointer[1]);
      commonDir = gitDir;
      try {
        commonDir = path.resolve(gitDir, (await readFile(path.join(gitDir, "commondir"), "utf8")).trim());
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await record("gitdir/config.worktree", path.join(gitDir, "config.worktree"));
    }
    await record("common/config", path.join(commonDir, "config"));
    // Git reads both from the common dir: info/attributes can select filter/diff/merge drivers
    // and rewrite what a diff shows; objects/info/alternates adds another object directory.
    await record("common/info/attributes", path.join(commonDir, "info", "attributes"));
    await record("common/objects/info/alternates", path.join(commonDir, "objects", "info", "alternates"));
    let hookNames = [];
    try {
      hookNames = (await readdir(path.join(commonDir, "hooks"))).sort();
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    entries["common/hooks"] = hookNames.join("\0");
    for (const name of hookNames) await record(`common/hooks/${name}`, path.join(commonDir, "hooks", name));
    const sha256 = createHash("sha256").update(JSON.stringify(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))).digest("hex");
    return { ok: true, sha256, entries, error: "" };
  } catch (error) {
    return { ok: false, sha256: "", entries, error: error.message || String(error) };
  }
}

// Paths whose .git/ control files differ between two gitControlSurfaceFingerprint() results.
function gitControlSurfaceChanges(before, after) {
  const labels = [...new Set([...Object.keys(before?.entries || {}), ...Object.keys(after?.entries || {})])].sort();
  return labels.filter((label) => (before?.entries || {})[label] !== (after?.entries || {})[label]);
}

// Marks a write job failed when its .git/ control files (config, hooks, info/attributes,
// objects/info/alternates, a worktree's .git pointer) changed while it ran. A fingerprint
// that could not be taken before proves nothing either way (logged, not failed); one that
// fails only afterwards fails closed.
function applyGitControlSurfaceCheck(result, before, after, phase = "agent execution") {
  if (!before) return;
  if (!before.ok) {
    logEvent("warn", "git.control_surface_fingerprint_unavailable", { phase, error: before.error || "" });
    return;
  }
  const changed = after?.ok ? gitControlSurfaceChanges(before, after) : ["(fingerprint unavailable afterwards)"];
  if (!changed.length) return;
  result.gitControlSurfaceChanges = changed;
  result.errorType ||= "git_control_surface_modified";
  result.stderr = [
    result.stderr,
    `Git control files changed during ${phase}: ${changed.join(", ")}${after?.ok ? "" : ` (${after?.error || "unreadable"})`}. Git never lists .git/ as a change, so this is checked separately; the output was retained. Inspect .git/config, .git/hooks, .git/info/attributes and .git/objects/info/alternates before running git in this checkout.`,
  ].filter(Boolean).join("\n");
}




// B-056: SDK errors (unknown tool, input validation: "MCP error -32602 ...") and handler
// exceptions become `isError` answers inside @modelcontextprotocol/sdk, and the bridge's own
// refusals and failed agent runs are normal answers with an errorType line; none reached
// logEvent, so the operations log stayed empty while the user saw failures. Every answer is
// inspected once, at the transport (installMcpFailureLogging), instead of in 26 handlers.
// The text goes under `summary`, not `error`/`message`/`reason`: sanitizeLogValue hashes those
// keys, and this line exists to be read. It is redacted before it is cut, so a cut can never
// leave half a credential that the redactor no longer recognizes.
const MCP_PENDING_REQUEST_CAP = 1000;

function mcpAnswerText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

// Remembers a request the client sent, until its answer goes out. Bounded: a client that never
// receives its answers (or cancels without one) cannot grow the map past the cap.
function rememberMcpRequest(pending, message, { now = Date.now(), cap = MCP_PENDING_REQUEST_CAP } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") return;
  if (message.method === "notifications/cancelled") {
    pending.delete(message.params?.requestId);
    return;
  }
  if (message.id === undefined || message.id === null) return;
  while (pending.size >= cap) pending.delete(pending.keys().next().value);
  const tool = message.method === "tools/call" && typeof message.params?.name === "string" ? message.params.name : "";
  pending.set(message.id, { method: message.method, tool, startedAt: now });
}

// The ops-log record for one outgoing message, or null when it is not a failed answer.
// Pure: it reads `pending` but never changes it or the message.
function describeFailedMcpMessage(message, pending = new Map(), now = Date.now()) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method === "string") return null;
  if (message.id === undefined) return null;
  const request = pending.get(message.id) || null;
  const durationMs = request ? Math.max(0, now - request.startedAt) : null;
  const method = request?.method || "";
  const tool = request?.tool || "";
  if (message.error && typeof message.error === "object") {
    const code = Number.isSafeInteger(message.error.code) ? message.error.code : null;
    return { level: "error", event: "mcp.request_failed", data: { method, tool, code, summary: failureSummary(message.error.message || "JSON-RPC error without a message"), durationMs } };
  }
  const result = message.result;
  if (!result || typeof result !== "object") return null;
  const text = mcpAnswerText(result);
  if (result.isError === true) {
    // McpServer turns its own McpErrors (unknown tool, input validation) into isError results
    // whose text starts "MCP error <code>:"; those are request failures, not bridge refusals.
    const sdkError = /^MCP error (-?\d+):/.exec(text);
    if (sdkError) {
      return { level: "error", event: "mcp.request_failed", data: { method, tool, code: Number(sdkError[1]), summary: failureSummary(text), durationMs } };
    }
    const errorType = /^errorType:\s*([A-Za-z0-9_.:-]+)/m.exec(text)?.[1] || "";
    return { level: "warn", event: "tool.refused", data: { tool, errorType, summary: failureSummary(text || "isError answer without text"), durationMs } };
  }
  if (method && method !== "tools/call") return null;
  // Most bridge refusals are not isError: formatRejectedExecution and formatToolRefusal answer
  // a normal result whose first lines carry "errorType: <type>" (an unsafe cwd, a lock conflict,
  // a refused integration). Only the head of the first text block is read, where those put it.
  const firstText = Array.isArray(result.content) ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text || "" : "";
  const headType = /^errorType:\s*([A-Za-z0-9_.:-]+)/m.exec(firstText.split(/\r?\n/, 5).join("\n"))?.[1] || "";
  if (headType && headType !== "none") {
    return { level: "warn", event: "tool.refused", data: { tool, errorType: headType, summary: failureSummary(text), durationMs } };
  }
  // An agent run that started and failed (timeout, provider error, validation) is also a normal
  // result: its job lines say "Status: failed; error type: <type>" (compact) or
  // "Error type: <type>" (detail), once per job of a parallel run.
  if (AGENT_RUN_TOOLS.has(tool)) {
    const errorTypes = [...new Set([...text.matchAll(/^(?:Error type: |Status: (?:failed|rejected); error type: )([A-Za-z0-9_.:-]+)/gm)].map((match) => match[1]).filter((value) => value !== "none"))];
    if (errorTypes.length) {
      return { level: "warn", event: "agent.run_failed", data: { tool, errorType: errorTypes[0], errorTypes: errorTypes.slice(0, 10), summary: failureSummary(text), durationMs } };
    }
  }
  return null;
}

const AGENT_RUN_TOOLS = new Set(["run_opencode_agent", "run_opencode_parallel", "run_multi_agent_pipeline"]);

// Wraps a connected transport: onmessage remembers each request, send logs each failed
// answer before forwarding it. Neither wrapper throws or changes a message.
function installMcpFailureLogging(transport, { record = logEvent, cap = MCP_PENDING_REQUEST_CAP } = {}) {
  const pending = new Map();
  const received = transport.onmessage;
  transport.onmessage = (message, extra) => {
    try {
      rememberMcpRequest(pending, message, { cap });
    } catch { /* Logging must never stop a request. */ }
    return received?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    try {
      const failed = describeFailedMcpMessage(message, pending);
      if (message && typeof message === "object" && typeof message.method !== "string" && message.id !== undefined) pending.delete(message.id);
      if (failed) record(failed.level, failed.event, failed.data);
    } catch { /* Logging must never stop an answer. */ }
    return send(message, options);
  };
  return pending;
}

// B-057: an uncaught exception or unhandled rejection used to end the bridge with nothing in
// the operations log (stderr goes to the client and is lost). appendOpsLogLine is synchronous,
// so the line is on disk before the process exits.
function recordProcessFailure(kind, error, { origin = "" } = {}) {
  try {
    const isObject = error !== null && typeof error === "object";
    logEvent("error", `process.${kind}`, {
      origin: String(origin || ""),
      errorType: String((isObject && (error.code || error.name)) || ""),
      summary: failureSummary(isObject ? error.message ?? String(error) : String(error)),
      stack: isObject && typeof error.stack === "string" ? error.stack.split(/\r?\n/).slice(0, 10).join("\n") : "",
    });
    return true;
  } catch {
    return false;
  }
}

// Only the real start path installs these (never an import or --self-test): the bridge still
// prints the error and exits 1, as Node does without a handler.
let processFailureHandlersInstalled = false;

function installProcessFailureHandlers() {
  // Once per process: the queue worker installs them too (B-075), and a test may start it twice.
  if (processFailureHandlersInstalled) return;
  processFailureHandlersInstalled = true;
  process.on("uncaughtException", (error, origin) => crashAndExit("uncaught_exception", error, origin || "uncaughtException"));
  // The second argument of unhandledRejection is the promise, not an origin string.
  process.on("unhandledRejection", (reason) => crashAndExit("unhandled_rejection", reason, "unhandledRejection"));
  process.on("exit", (code) => {
    try {
      if (code && code !== processExitLogSuppressedCode) logEvent("error", "process.exited", { code });
    } catch { /* The process is ending; nothing else can be done. */ }
  });
}

// B-075: the queue worker documents exit code 2 for "stopped by an error" (1 is "refused to start").
let processCrashExitCode = 1;
// B-086: the exit code a queue worker's refusal already logged (queue_worker.refused) as itself.
let processExitLogSuppressedCode = null;

function crashAndExit(kind, error, origin) {
  recordProcessFailure(kind, error, { origin });
  try {
    process.stderr.write(`${error?.stack || error}\n`);
  } catch { /* stderr may already be closed. */ }
  process.exit(processCrashExitCode);
}

const { runCommand, runSpawnCommand } = createCommandRuntime({
  execFileAsync,
  isGitExecutable,
  trustedGitArgs,
  buildTrustedGitEnv,
  CONFIG,
  BRIDGE_RUNTIME_DIR,
  PROCESS_SUPERVISOR_PATH,
  nowMs,
  abortSignalErrorType,
  logEvent,
});



const { validationCommandTrustError, validationPathValue, resolveValidationExecutable, prepareValidationCommand, VALIDATION_PREFLIGHT_FIX, validationCommandPreflightError, runValidationProcess, runValidationGate } = createValidationRuntime({
  CONFIG,
  buildValidationEnv,
  sha256File,
  runCommand,
  runSpawnCommand,
  integrationTimed: (...args) => integrationTimed(...args),
  nowMs,
  truncateText,
});










function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function delayWithSignal(delayMs, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(new Error("cancelled")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function openProviderLeaseDb({ deadlineAt = Date.now() + 1000 * 30, signal = null } = {}) {
  const dbPath = path.join(effectiveBridgeStateDirectory(), "provider-concurrency.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  await assertNoLinkedPath(path.dirname(dbPath), "Provider concurrency state directory");
  if (existsSync(dbPath)) {
    const details = await lstat(dbPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Provider concurrency database must be a regular file, not a link or special entry.");
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error("Cancelled while opening the provider concurrency database.");
      error.code = "PROVIDER_CONCURRENCY_CANCELLED";
      throw error;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const error = new Error("Provider concurrency database initialization exceeded the caller deadline.");
      error.code = "PROVIDER_CONCURRENCY_TIMEOUT";
      throw error;
    }
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      const openedDetails = await lstat(dbPath);
      if (openedDetails.isSymbolicLink() || !openedDetails.isFile()) {
        throw new Error("Provider concurrency database identity changed during open.");
      }
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(5000, remainingMs))};`);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = FULL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_leases (
          lease_id TEXT PRIMARY KEY,
          provider_key TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          heartbeat_at INTEGER,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS provider_leases_key_expiry_idx ON provider_leases (provider_key, expires_at);
        CREATE TABLE IF NOT EXISTS provider_capacities (
          provider_key TEXT PRIMARY KEY,
          capacity INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_cooldowns (
          provider_key TEXT PRIMARY KEY,
          until_at INTEGER NOT NULL,
          error_type TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          set_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_settings (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_pause_strikes (
          pause_key TEXT PRIMARY KEY,
          strikes INTEGER NOT NULL,
          last_strike_at INTEGER NOT NULL
        );
      `);
      ensureTableColumn(db, "provider_leases", "heartbeat_at", "INTEGER");
      ensureTableColumn(db, "provider_leases", "containment", "TEXT NOT NULL DEFAULT ''");
      return db;
    } catch (error) {
      if (db) closeDb(db);
      const retryable = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error));
      if (!retryable || attempt === 7) throw error;
      const delayMs = Math.min(
        Math.max(0, deadlineAt - Date.now()),
        Math.min(1000, 25 * (2 ** attempt)) + Math.floor(Math.random() * 25)
      );
      if (delayMs <= 0) continue;
      try {
        await delayWithSignal(delayMs, signal);
      } catch (error) {
        const cancelled = new Error("Cancelled while opening the provider concurrency database.");
        cancelled.code = "PROVIDER_CONCURRENCY_CANCELLED";
        throw cancelled;
      }
    }
  }
  throw new Error("Provider lease database initialization exhausted its retry budget.");
}

// Q-002: runtime override of the provider slot limit and the queue parallel limit. The rows live
// in provider-concurrency.sqlite (shared by every bridge process and every project); a process
// applies them at its next scheduler pass or slot request, and a restart reloads them.
const RUNTIME_PROVIDER_LIMIT_SETTING = "provider_concurrency_limit";
const RUNTIME_QUEUE_LIMIT_SETTING = "queue_parallel_limit";
// Q-005: 0 is a valid stored value here (no cap, even when the environment sets one).
const RUNTIME_GLOBAL_LIMIT_SETTING = "global_worker_limit";
const RUNTIME_CONCURRENCY_REFRESH_MS = 5000;
let runtimeConcurrencyRefreshedFor = "";
let runtimeConcurrencyRefreshedAt = 0;

// Returns "" for a usable limit, else why it is refused. The tool schema checks the same range,
// but a direct handler call skips the schema.
function runtimeConcurrencyLimitError(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RUNTIME_CONCURRENCY_LIMIT) {
    return `${name} must be an integer from 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT}; got ${JSON.stringify(value)}.`;
  }
  return "";
}

function globalWorkerLimitError(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_GLOBAL_WORKER_LIMIT) {
    return `globalWorkerLimit must be an integer from 0 (no cap) to ${MAX_GLOBAL_WORKER_LIMIT}; got ${JSON.stringify(value)}.`;
  }
  return "";
}

function readRuntimeConcurrencyRows(db) {
  const settings = { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, updatedAt: "" };
  let updatedAtMs = 0;
  const rows = db.prepare("SELECT name, value, updated_at FROM runtime_settings WHERE name IN (?, ?, ?)")
    .all(RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING);
  for (const row of rows) {
    const value = Number(row.value);
    // A hand-edited row outside the accepted range is ignored, not applied.
    if (row.name === RUNTIME_GLOBAL_LIMIT_SETTING) {
      if (globalWorkerLimitError(value)) continue;
      settings.globalWorkerLimit = value;
    } else {
      if (!Number.isInteger(value) || value < 1 || value > MAX_RUNTIME_CONCURRENCY_LIMIT) continue;
      if (row.name === RUNTIME_PROVIDER_LIMIT_SETTING) settings.providerLimit = value;
      else settings.queueParallelLimit = value;
    }
    updatedAtMs = Math.max(updatedAtMs, Number(row.updated_at) || 0);
  }
  if (updatedAtMs) settings.updatedAt = new Date(updatedAtMs).toISOString();
  return settings;
}

function applyRuntimeConcurrency(settings) {
  const globalWorkerLimit = settings.globalWorkerLimit ?? null;
  const changed = RUNTIME_CONCURRENCY.providerLimit !== settings.providerLimit
    || RUNTIME_CONCURRENCY.queueParallelLimit !== settings.queueParallelLimit
    || RUNTIME_CONCURRENCY.globalWorkerLimit !== globalWorkerLimit;
  Object.assign(RUNTIME_CONCURRENCY, {
    providerLimit: settings.providerLimit,
    queueParallelLimit: settings.queueParallelLimit,
    globalWorkerLimit,
    updatedAt: settings.updatedAt || "",
  });
  if (changed) {
    logEvent("info", "concurrency.runtime_limits_applied", {
      providerLimit: CONFIG.providerConcurrencyLimit,
      queueParallelLimit: CONFIG.queueParallelLimit,
      globalWorkerLimit: CONFIG.globalWorkerLimit,
      providerOverride: settings.providerLimit !== null,
      queueOverride: settings.queueParallelLimit !== null,
      globalOverride: globalWorkerLimit !== null,
    });
  }
  return changed;
}

// Reads the persisted overrides into this process (at most every few seconds unless forced, and
// again whenever the state directory differs from the last read). A failed read keeps the values
// already in force.
async function refreshRuntimeConcurrency({ force = false } = {}) {
  const directory = effectiveBridgeStateDirectory();
  if (!force && runtimeConcurrencyRefreshedFor === directory && Date.now() - runtimeConcurrencyRefreshedAt < RUNTIME_CONCURRENCY_REFRESH_MS) return false;
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const changed = applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
    runtimeConcurrencyRefreshedFor = directory;
    runtimeConcurrencyRefreshedAt = Date.now();
    return changed;
  } catch (error) {
    logEvent("warn", "concurrency.runtime_refresh_failed", { error: redactSensitiveText(error?.message || String(error)) });
    return false;
  } finally {
    if (db) closeDb(db);
  }
}

// One line each for get_opencode_bridge_status: the value in force, the env value and whether a
// runtime override produced the difference.
function describeConcurrencyLimits() {
  const describe = (effective, env, override) => `effective ${effective} (env ${env}${override !== null ? `, runtime override set ${RUNTIME_CONCURRENCY.updatedAt || "earlier"}` : ""})`;
  return {
    provider: describe(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT, RUNTIME_CONCURRENCY.providerLimit),
    queue: describe(CONFIG.queueParallelLimit, ENV_QUEUE_PARALLEL_LIMIT, RUNTIME_CONCURRENCY.queueParallelLimit),
    global: describe(CONFIG.globalWorkerLimit === 0 ? "0 (no cap)" : CONFIG.globalWorkerLimit, ENV_GLOBAL_WORKER_LIMIT, RUNTIME_CONCURRENCY.globalWorkerLimit),
  };
}

// Sets (or, with reset, clears) the persisted overrides and applies them to this process. Running
// jobs are untouched: a lower limit only keeps new jobs from starting until enough have finished.
async function setRuntimeConcurrency({ providerLimit, queueParallelLimit, globalWorkerLimit, reset = false } = {}) {
  const hasProvider = providerLimit !== undefined && providerLimit !== null;
  const hasQueue = queueParallelLimit !== undefined && queueParallelLimit !== null;
  const hasGlobal = globalWorkerLimit !== undefined && globalWorkerLimit !== null;
  if (reset && (hasProvider || hasQueue || hasGlobal)) {
    return { ok: false, errorType: "concurrency_invalid", error: "reset clears the overrides; do not combine it with providerLimit, queueParallelLimit or globalWorkerLimit." };
  }
  if (!reset && !hasProvider && !hasQueue && !hasGlobal) {
    return { ok: false, errorType: "concurrency_invalid", error: "Pass providerLimit, queueParallelLimit and/or globalWorkerLimit, or reset: true to return to the environment values." };
  }
  const invalid = (hasProvider ? runtimeConcurrencyLimitError("providerLimit", providerLimit) : "")
    || (hasQueue ? runtimeConcurrencyLimitError("queueParallelLimit", queueParallelLimit) : "")
    || (hasGlobal ? globalWorkerLimitError(globalWorkerLimit) : "");
  if (invalid) return { ok: false, errorType: "concurrency_invalid", error: invalid };

  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 10000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const before = readRuntimeConcurrencyRows(db);
    const effectiveProviderBefore = before.providerLimit ?? ENV_PROVIDER_CONCURRENCY_LIMIT;
    const now = Date.now();
    if (reset) {
      db.prepare("DELETE FROM runtime_settings WHERE name IN (?, ?, ?)").run(RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING);
    } else {
      const upsert = db.prepare(`
        INSERT INTO runtime_settings (name, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      if (hasProvider) upsert.run(RUNTIME_PROVIDER_LIMIT_SETTING, providerLimit, now);
      if (hasQueue) upsert.run(RUNTIME_QUEUE_LIMIT_SETTING, queueParallelLimit, now);
      if (hasGlobal) upsert.run(RUNTIME_GLOBAL_LIMIT_SETTING, globalWorkerLimit, now);
    }
    const after = readRuntimeConcurrencyRows(db);
    const effectiveProviderAfter = after.providerLimit ?? ENV_PROVIDER_CONCURRENCY_LIMIT;
    // acquireProviderLease keeps the stricter of a stored capacity and the configured limit while
    // leases are held (an older bridge process may hold them under another limit), so a raise
    // would not apply until those drained. The rows are only a cache of the last configured limit:
    // removing them makes the next slot request store the new value and use it at once.
    if (effectiveProviderAfter !== effectiveProviderBefore) db.prepare("DELETE FROM provider_capacities").run();
    db.exec("COMMIT");
    transactionOpen = false;
    const previous = {
      providerLimit: effectiveProviderBefore,
      queueParallelLimit: before.queueParallelLimit ?? ENV_QUEUE_PARALLEL_LIMIT,
    };
    const previousGlobalWorkerLimit = before.globalWorkerLimit ?? ENV_GLOBAL_WORKER_LIMIT;
    applyRuntimeConcurrency(after);
    runtimeConcurrencyRefreshedFor = effectiveBridgeStateDirectory();
    runtimeConcurrencyRefreshedAt = Date.now();
    // A raised queue limit can start jobs that were waiting for a free worker.
    scheduleQueue();
    return { ok: true, previous, previousGlobalWorkerLimit, current: { providerLimit: CONFIG.providerConcurrencyLimit, queueParallelLimit: CONFIG.queueParallelLimit, globalWorkerLimit: CONFIG.globalWorkerLimit }, reset: Boolean(reset) };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    return { ok: false, errorType: "concurrency_persist_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

async function acquireProviderLease({ providerKey, pauseKeys = [], timeoutMs, signal = null }) {
  // B-061: a pause can sit on the provider key itself or on a provider/model key under it.
  const cooldownKeys = [...new Set([providerKey, ...(Array.isArray(pauseKeys) ? pauseKeys : [])].filter(Boolean))];
  const started = Date.now();
  const waitBudgetMs = Math.max(1, timeoutMs);
  const deadlineAt = started + waitBudgetMs;
  let observedHolders = 0;
  let observedCapacity = CONFIG.providerConcurrencyLimit;
  let observedGlobal = null;
  while (Date.now() < deadlineAt) {
    await reclaimProvenGoneProviderQuarantines();
    if (signal?.aborted) {
      return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
    }
    let db = null;
    try {
      db = await openProviderLeaseDb({ deadlineAt, signal });
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
      db.prepare("DELETE FROM provider_cooldowns WHERE until_at <= ?").run(now);
      // Q-002: the limit in force is the persisted runtime override, read in this transaction so a
      // raise or lowering made by any bridge process applies to the slot being decided right now.
      applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
      runtimeConcurrencyRefreshedFor = effectiveBridgeStateDirectory();
      runtimeConcurrencyRefreshedAt = Date.now();
      // A provider whose quota ran out fails new jobs at once instead of starting agents that
      // can only burn their wait budget (or the quota of the next account) until the reset.
      const cooldown = db.prepare(`SELECT provider_key, until_at, error_type, reason FROM provider_cooldowns WHERE provider_key IN (${cooldownKeys.map(() => "?").join(", ")}) ORDER BY until_at DESC LIMIT 1`).get(...cooldownKeys);
      if (cooldown) {
        db.exec("ROLLBACK");
        const untilAt = Number(cooldown.until_at);
        return {
          ok: false,
          errorType: String(cooldown.error_type || "opencode_quota_exhausted"),
          error: `Provider ${cooldown.provider_key || providerKey} is paused until ${new Date(untilAt).toISOString()} (${cooldown.error_type}${cooldown.reason ? `: ${cooldown.reason}` : ""}). The agent was not started; enqueue the job again after that time.`,
          pausedKey: String(cooldown.provider_key || providerKey),
          waitedMs: Date.now() - started,
          holders: observedHolders,
          capacity: observedCapacity,
          cooldownUntil: new Date(untilAt).toISOString(),
          retryAfterMs: Math.max(0, untilAt - Date.now()),
        };
      }
      const active = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases WHERE provider_key = ?").get(providerKey)?.count || 0);
      const configuredCapacity = CONFIG.providerConcurrencyLimit;
      let effectiveCapacity = configuredCapacity;
      const capacityRow = db.prepare("SELECT capacity FROM provider_capacities WHERE provider_key = ?").get(providerKey);
      if (!capacityRow) {
        db.prepare("INSERT INTO provider_capacities (provider_key, capacity, updated_at) VALUES (?, ?, ?)").run(providerKey, configuredCapacity, now);
      } else if (Number(capacityRow.capacity) !== configuredCapacity) {
        if (active > 0) {
          // Another bridge process (often an older one a client kept alive with the previous
          // env) holds leases under a different limit. Honour the stricter of the two and wait,
          // instead of failing the job; the stored limit follows the config once leases drain.
          const storedCapacity = Number(capacityRow.capacity);
          effectiveCapacity = Number.isInteger(storedCapacity) && storedCapacity > 0
            ? Math.min(storedCapacity, configuredCapacity)
            : configuredCapacity;
        } else {
          db.prepare("UPDATE provider_capacities SET capacity = ?, updated_at = ? WHERE provider_key = ?").run(configuredCapacity, now, providerKey);
        }
      }
      observedHolders = active;
      observedCapacity = effectiveCapacity;
      // Q-005: the global worker cap counts every held slot in this state directory, on every
      // provider key and from every bridge process (quarantined slots too: their process tree may
      // still run). It only ever holds a start back; held slots are never taken away.
      const globalLimit = CONFIG.globalWorkerLimit;
      const globalHeld = globalLimit > 0 ? Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases").get()?.count || 0) : 0;
      observedGlobal = globalLimit > 0 ? { held: globalHeld, limit: globalLimit } : null;
      if (active < effectiveCapacity && (!(globalLimit > 0) || globalHeld < globalLimit)) {
        const lease = {
          id: `${BRIDGE_INSTANCE_ID}-${randomBytes(6).toString("hex")}`,
          providerKey,
          expiresAt: now + CONFIG.providerLeaseMs,
        };
        db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(lease.id, providerKey, BRIDGE_INSTANCE_ID, process.pid, now, now, lease.expiresAt);
        db.exec("COMMIT");
        return { ok: true, lease, waitedMs: Date.now() - started };
      }
      db.exec("ROLLBACK");
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch { /* preserve original error */ }
      if (error?.code === "PROVIDER_CONCURRENCY_CANCELLED") {
        return { ok: false, errorType: "agent_cancelled", error: error.message || String(error) };
      }
      if (error?.code === "PROVIDER_CONCURRENCY_TIMEOUT") {
        return { ok: false, errorType: "provider_slot_wait_timeout", error: error.message || String(error), waitedMs: Date.now() - started, holders: observedHolders, capacity: observedCapacity };
      }
      if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error))) {
        return { ok: false, errorType: "provider_concurrency_failed", error: error.message || String(error) };
      }
    } finally {
      if (db) closeDb(db);
    }
    try {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const delayMs = Math.min(remainingMs, CONFIG.providerLeasePollMs + Math.floor(Math.random() * CONFIG.providerLeasePollMs));
      if (delayMs <= 0) break;
      await delayWithSignal(delayMs, signal);
    } catch {
      return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
    }
  }
  return {
    ok: false,
    errorType: "provider_slot_wait_timeout",
    error: `Waited ${Date.now() - started} ms for a provider slot on ${providerKey}: ${observedHolders} of ${observedCapacity} slots stayed held for the whole wait budget (CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS=${waitBudgetMs})${observedGlobal && observedGlobal.held >= observedGlobal.limit ? `; the global worker cap was full (${observedGlobal.held} of ${observedGlobal.limit} workers running on all providers, CODEX_OPENCODE_GLOBAL_WORKER_LIMIT)` : ""}. The agent was not started.`,
    waitedMs: Date.now() - started,
    holders: observedHolders,
    capacity: observedCapacity,
    globalWorkers: observedGlobal,
  };
}

// A provider pause outlives this process: every bridge (Claude's and Codex's) reads the same
// table before taking a slot. A later pause never shortens an existing one.
const PROVIDER_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;

// Queue jobs of this process that are waiting for a provider slot, so list_opencode_jobs can say
// "waiting_for_provider_slot" instead of a generic starting_agent (6 "running" jobs on 4 slots).
const providerSlotWaitStorage = new AsyncLocalStorage();
const providerSlotWaitingJobs = new Map();

async function recordProviderCooldown({ providerKey, durationMs, errorType, reason = "" }) {
  const boundedMs = Math.min(PROVIDER_COOLDOWN_MAX_MS, Math.max(0, Math.ceil(Number(durationMs) || 0)));
  if (!providerKey || boundedMs <= 0) return { ok: false, recorded: false };
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const now = Date.now();
    const untilAt = now + boundedMs;
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        until_at = MAX(provider_cooldowns.until_at, excluded.until_at),
        error_type = excluded.error_type,
        reason = excluded.reason,
        set_at = excluded.set_at
    `).run(providerKey, untilAt, String(errorType || "opencode_quota_exhausted"), redactSensitiveText(String(reason || "")).slice(0, 300), now);
    logEvent("warn", "provider.cooldown_recorded", { providerKey, untilAt: new Date(untilAt).toISOString(), errorType });
    return { ok: true, recorded: true, untilAt };
  } catch (error) {
    logEvent("error", "provider.cooldown_record_failed", { providerKey, error: error.message || String(error) });
    return { ok: false, recorded: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// B-061: the pause a detected rate limit puts on one provider/model. A pause still running is kept
// as it is (the parallel jobs that trip on the same rate limit add no strike); otherwise the strike
// count grows and the pause doubles from CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS up to
// CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS. A strike older than twice the maximum is forgotten, so a
// model that behaved for hours starts again at the first step.
async function recordRateLimitPause({ pauseKey, reason = "", now = Date.now() }) {
  if (!pauseKey || !(CONFIG.rateLimitPauseMs > 0)) return { ok: true, recorded: false };
  const baseMs = CONFIG.rateLimitPauseMs;
  const maxMs = Math.max(baseMs, CONFIG.rateLimitPauseMaxMs);
  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const active = db.prepare("SELECT until_at FROM provider_cooldowns WHERE provider_key = ? AND until_at > ?").get(pauseKey, now);
    const strikeRow = db.prepare("SELECT strikes, last_strike_at FROM provider_pause_strikes WHERE pause_key = ?").get(pauseKey);
    if (active) {
      db.exec("COMMIT");
      transactionOpen = false;
      return { ok: true, recorded: true, reused: true, untilAt: Number(active.until_at), strikes: Number(strikeRow?.strikes || 1) };
    }
    const recent = strikeRow && now - Number(strikeRow.last_strike_at || 0) < 2 * maxMs;
    const strikes = recent ? Number(strikeRow.strikes || 0) + 1 : 1;
    const durationMs = Math.min(maxMs, PROVIDER_COOLDOWN_MAX_MS, baseMs * 2 ** Math.min(20, strikes - 1));
    const untilAt = now + durationMs;
    db.prepare(`
      INSERT INTO provider_pause_strikes (pause_key, strikes, last_strike_at) VALUES (?, ?, ?)
      ON CONFLICT(pause_key) DO UPDATE SET strikes = excluded.strikes, last_strike_at = excluded.last_strike_at
    `).run(pauseKey, strikes, now);
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        until_at = MAX(provider_cooldowns.until_at, excluded.until_at),
        error_type = excluded.error_type,
        reason = excluded.reason,
        set_at = excluded.set_at
    `).run(pauseKey, untilAt, "provider_rate_limited", redactSensitiveText(String(reason || "")).slice(0, 300), now);
    db.exec("COMMIT");
    transactionOpen = false;
    logEvent("warn", "provider.cooldown_recorded", { providerKey: pauseKey, untilAt: new Date(untilAt).toISOString(), errorType: "provider_rate_limited", strikes });
    return { ok: true, recorded: true, reused: false, untilAt, strikes, durationMs };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    logEvent("error", "provider.cooldown_record_failed", { providerKey: pauseKey, error: error.message || String(error) });
    return { ok: false, recorded: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// Q-005: pause_opencode_provider / resume_opencode_provider. The target is "provider" (every model
// of it: the slot key) or "provider/model" (the B-061 model key). The model part may hold "/"
// (openrouter/anthropic/...), so only the first "/" splits.
function providerPauseTarget(target) {
  const raw = String(target || "").trim();
  const slash = raw.indexOf("/");
  const provider = (slash < 0 ? raw : raw.slice(0, slash)).trim();
  const model = slash < 0 ? "" : raw.slice(slash + 1).trim();
  if (!provider || !MODEL_IDENTIFIER_PATTERN.test(provider) || (slash >= 0 && (!model || !MODEL_NAME_PATTERN.test(model)))) {
    return { ok: false, error: `provider must be "provider" or "provider/model" (for example opencode or opencode/muse-spark-1.3-contributor-free); got ${JSON.stringify(raw)}.` };
  }
  const normalizedProvider = provider.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return model
    ? { ok: true, key: modelPauseKeyForMetadata({ provider, model }), provider: normalizedProvider, model, modelPrefix: "" }
    : { ok: true, key: providerKeyForMetadata({ provider }), provider: normalizedProvider, model: "", modelPrefix: `${CONFIG.providerConcurrencyKey}:${normalizedProvider}/` };
}

async function pauseProvider({ provider, until, minutes, reason = "", now = Date.now() } = {}) {
  const target = providerPauseTarget(provider);
  if (!target.ok) return { ok: false, errorType: "provider_pause_invalid", error: target.error };
  const hasUntil = until !== undefined && until !== null && String(until).trim() !== "";
  const hasMinutes = minutes !== undefined && minutes !== null;
  if (hasUntil === hasMinutes) {
    return { ok: false, errorType: "provider_pause_invalid", error: "Pass exactly one of until (an ISO time) or minutes." };
  }
  let untilAt = 0;
  if (hasUntil) {
    untilAt = Date.parse(String(until));
    if (!Number.isFinite(untilAt) || untilAt <= now) return { ok: false, errorType: "provider_pause_invalid", error: `until must be an ISO time in the future; got ${JSON.stringify(String(until))}.` };
  } else {
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return { ok: false, errorType: "provider_pause_invalid", error: `minutes must be an integer from 1 to 1440; got ${JSON.stringify(minutes)}.` };
    untilAt = now + minutes * 60_000;
  }
  if (untilAt - now > PROVIDER_COOLDOWN_MAX_MS) return { ok: false, errorType: "provider_pause_invalid", error: "A pause can last at most 24 hours." };
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    // An operator's pause replaces whatever is there, shorter or longer: the operator decides.
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET until_at = excluded.until_at, error_type = excluded.error_type, reason = excluded.reason, set_at = excluded.set_at
    `).run(target.key, untilAt, "provider_paused", redactSensitiveText(`paused by the operator${reason ? `: ${reason}` : ""}`).slice(0, 300), now);
    logEvent("info", "provider.paused_by_operator", { providerKey: target.key, untilAt: new Date(untilAt).toISOString() });
    return { ok: true, key: target.key, until: new Date(untilAt).toISOString(), target };
  } catch (error) {
    return { ok: false, errorType: "provider_pause_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

// Removes the pause of the target; for a whole provider also the pauses of its models, and the
// rate-limit strike counts of everything it removes (the operator says the provider is fine).
async function resumeProvider({ provider } = {}) {
  const target = providerPauseTarget(provider);
  if (!target.ok) return { ok: false, errorType: "provider_pause_invalid", error: target.error };
  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const like = target.modelPrefix ? `${target.modelPrefix.replace(/[\\%_]/g, (item) => `\\${item}`)}%` : null;
    const rows = like
      ? db.prepare("SELECT provider_key, until_at, error_type FROM provider_cooldowns WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'").all(target.key, like)
      : db.prepare("SELECT provider_key, until_at, error_type FROM provider_cooldowns WHERE provider_key = ?").all(target.key);
    for (const statement of like
      ? ["DELETE FROM provider_cooldowns WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'", "DELETE FROM provider_pause_strikes WHERE pause_key = ? OR pause_key LIKE ? ESCAPE '\\'"]
      : ["DELETE FROM provider_cooldowns WHERE provider_key = ?", "DELETE FROM provider_pause_strikes WHERE pause_key = ?"]) {
      db.prepare(statement).run(...(like ? [target.key, like] : [target.key]));
    }
    db.exec("COMMIT");
    transactionOpen = false;
    const removed = rows.map((row) => ({ providerKey: row.provider_key, until: new Date(Number(row.until_at)).toISOString(), errorType: row.error_type }));
    logEvent("info", "provider.resumed_by_operator", { providerKey: target.key, removed: removed.length });
    // Q-007: retries of this process that wait for a pause to end may start now; one whose model is
    // still paused fails at its slot request and its retry policy picks again.
    let released = 0;
    for (const record of QUEUE_JOBS.values()) {
      if (["pending", "planned"].includes(record.status) && record.startAfter) {
        delete record.startAfter;
        released += 1;
      }
    }
    if (released) scheduleQueue();
    return { ok: true, key: target.key, removed, target };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    return { ok: false, errorType: "provider_pause_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

function providerLeaseOwnershipLossError(detail = "Durable provider-capacity ownership could not be renewed before expiry.") {
  const error = new Error(detail);
  error.errorType = "provider_lease_ownership_lost";
  return error;
}

function startProviderLeaseHeartbeat(lease, { intervalMs: requestedIntervalMs = 0, refreshLease = null } = {}) {
  const controller = new AbortController();
  const inertStop = Object.assign(async () => {}, { signal: controller.signal, pulse: async () => false });
  if (!lease?.id) return inertStop;
  const effectiveLeaseMs = Math.max(250, Number(CONFIG.providerLeaseMs) || 250);
  const intervalMs = requestedIntervalMs > 0
    ? Math.max(20, Math.min(requestedIntervalMs, Math.floor(effectiveLeaseMs / 2)))
    : Math.max(1000, Math.min(CONFIG.providerHeartbeatMs, Math.floor(effectiveLeaseMs / 3)));
  const expiryGuardMs = Math.max(20, Math.min(intervalMs, Math.floor(effectiveLeaseMs / 4)));
  let lastConfirmedExpiresAt = Number(lease.expiresAt) || Date.now() + effectiveLeaseMs;
  let fenceTimer = null;
  let refreshPromise = null;
  let stopped = false;

  const loseOwnership = (detail) => {
    if (stopped || controller.signal.aborted) return;
    const error = providerLeaseOwnershipLossError(detail);
    logEvent("error", "provider.lease_ownership_lost", { leaseId: lease.id, detail });
    controller.abort(error);
  };
  const scheduleFence = () => {
    if (fenceTimer) clearTimeout(fenceTimer);
    fenceTimer = setTimeout(() => {
      loseOwnership("The provider-capacity lease was not durably renewed before the fail-closed deadline.");
    }, Math.max(0, lastConfirmedExpiresAt - Date.now() - expiryGuardMs));
    fenceTimer.unref?.();
  };
  const pulse = async () => {
    if (stopped || controller.signal.aborted) return false;
    if (refreshPromise) return await refreshPromise;
    refreshPromise = (async () => {
      let db = null;
      try {
        const now = Date.now();
        if (lastConfirmedExpiresAt <= now) {
          loseOwnership("The provider-capacity lease expired before its heartbeat could run.");
          return false;
        }
        const expiresAt = now + effectiveLeaseMs;
        let renewed = false;
        if (typeof refreshLease === "function") {
          renewed = (await refreshLease({ lease, heartbeatAt: now, expiresAt })) !== false;
        } else {
          db = await openProviderLeaseDb({ deadlineAt: Date.now() + Math.min(10000, intervalMs) });
          const result = db.prepare(`
            UPDATE provider_leases SET heartbeat_at = ?, expires_at = ?
            WHERE lease_id = ? AND owner_instance_id = ? AND expires_at > ? AND expires_at < ?
          `).run(now, expiresAt, lease.id, BRIDGE_INSTANCE_ID, now, Number.MAX_SAFE_INTEGER);
          renewed = Number(result.changes || 0) === 1;
        }
        if (!renewed) {
          loseOwnership("The durable provider-capacity lease no longer belongs to this execution.");
          return false;
        }
        lease.expiresAt = expiresAt;
        lastConfirmedExpiresAt = expiresAt;
        scheduleFence();
        return { ok: true, deadlineAt: lastConfirmedExpiresAt - expiryGuardMs };
      } catch (error) {
        // A thrown error (SQLITE_BUSY, a transient open failure) proves nothing about
        // ownership; the last confirmed expiry still holds. Returning false here killed the
        // running agent on one busy database read. Fail only once that deadline has passed
        // (the fence timer enforces it too) or when the renewal changed no row.
        logEvent("warn", "provider.lease_heartbeat_failed", { leaseId: lease.id, error: error.message || String(error) });
        const deadlineAt = lastConfirmedExpiresAt - expiryGuardMs;
        if (deadlineAt <= Date.now()) {
          loseOwnership("The provider-capacity lease could not be renewed before its confirmed expiry.");
          return false;
        }
        return { ok: true, deadlineAt, renewalFailed: true };
      } finally {
        if (db) closeDb(db);
      }
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  };
  scheduleFence();
  const timer = setInterval(pulse, intervalMs);
  timer.unref?.();
  // stop() settles once an in-flight renewal has finished, so a caller that awaits it can
  // release or quarantine the lease without a late pulse writing after it. It never rejects:
  // callers stop the heartbeat in a finally block right before that write.
  return Object.assign(async () => {
    stopped = true;
    clearInterval(timer);
    if (fenceTimer) clearTimeout(fenceTimer);
    const inFlight = refreshPromise;
    if (inFlight) await inFlight.catch(() => {});
  }, { signal: controller.signal, pulse });
}

async function releaseProviderLease(lease) {
  if (!lease?.id) return;
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 1000 * 30 });
    db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(lease.id, BRIDGE_INSTANCE_ID);
  } catch (error) {
    logEvent("warn", "provider.lease_release_failed", { leaseId: lease.id, error: error.message || String(error) });
  } finally {
    if (db) closeDb(db);
  }
}

// A containment quarantine (expires_at = MAX_SAFE_INTEGER) keeps a provider slot or a set
// of path locks reserved while an OpenCode process tree might still be running. It used to
// be permanent: one unconfirmed termination on 2026-09-26 held one of two provider slots and
// eight path locks forever. The quarantine now records the processes it is waiting on and is
// lifted only when that is proven: every recorded PID is gone, or, for records without a
// complete PID set, the owning bridge is gone and no OpenCode process runs on the machine.
// Children that OpenCode started (test runners, language servers) are not recorded and can
// outlive it on Windows, so a recorded quarantine is also held for a grace period.
// Every live descendant of the given PIDs, read from the process table once, when a
// quarantine is written. Windows keeps a child's ParentProcessId after its parent dies, so
// orphans of a killed OpenCode payload (a test runner, an LSP server) are still found.
// Temporary Git index directories are removed in a finally block, but a bridge killed in
// the middle of a patch build leaves one behind. Startup removes those older than a day;
// a younger one may belong to a live bridge.
async function sweepStaleIndexScratchDirs(maxAgeMs = 1000 * 60 * 60 * 24) {
  let removed = 0;
  try {
    for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("codex-opencode-index-")) continue;
      const dir = path.join(tmpdir(), entry.name);
      const details = await lstat(dir);
      if (details.isSymbolicLink() || Date.now() - details.mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  } catch (error) {
    logEvent("warn", "scratch.sweep_failed", { error: error.message || String(error) });
  }
  return removed;
}

const { processTable, processDescendants, containmentRecord, recordedProcessStillRuns, containmentProcessExists, openCodeProcessRunning, containmentStillPossible } = createProcessTableRuntime({
  runCommand,
  BRIDGE_RUNTIME_DIR,
  OPENCODE_EXE,
  CONFIG,
});








let providerQuarantineReclaimAt = 0;
async function reclaimProvenGoneProviderQuarantines({ force = false } = {}) {
  if (!force && Date.now() - providerQuarantineReclaimAt < 1000 * 60) return 0;
  providerQuarantineReclaimAt = Date.now();
  let db = null;
  let released = 0;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 1000 * 10 });
    const rows = db.prepare("SELECT lease_id, owner_pid, containment FROM provider_leases WHERE expires_at = ?").all(Number.MAX_SAFE_INTEGER);
    for (const row of rows) {
      if (await containmentStillPossible(row.containment, row.owner_pid)) continue;
      released += Number(db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND expires_at = ?").run(row.lease_id, Number.MAX_SAFE_INTEGER).changes || 0);
    }
    if (released) logEvent("warn", "provider.containment_quarantine_released", { released });
  } catch (error) {
    logEvent("warn", "provider.containment_reclaim_failed", { error: error.message || String(error) });
  } finally {
    if (db) closeDb(db);
  }
  return released;
}

async function reclaimProvenGoneLockQuarantines(db) {
  let released = 0;
  const runs = db.prepare(`
    SELECT DISTINCT locks.run_id AS run_id, runs.containment AS containment
    FROM locks LEFT JOIN runs ON runs.run_id = locks.run_id
    WHERE locks.expires_at = ?
  `).all(Number.MAX_SAFE_INTEGER);
  for (const run of runs) {
    if (await containmentStillPossible(run.containment, 0)) continue;
    // The lock rows and the run's status change together or not at all.
    db.exec("BEGIN IMMEDIATE");
    try {
      released += Number(db.prepare("DELETE FROM locks WHERE run_id = ? AND expires_at = ?").run(run.run_id, Number.MAX_SAFE_INTEGER).changes || 0);
      db.prepare("UPDATE runs SET status = 'quarantine_released', finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status = 'quarantined'").run(Date.now(), run.run_id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }
  if (released) logEvent("warn", "lock.containment_quarantine_released", { released });
  return released;
}

const lockQuarantineReclaimAt = new Map();
async function reclaimLockQuarantinesForRoot(projectRoot) {
  const key = normalizePathForCompare(projectRoot);
  if (Date.now() - (lockQuarantineReclaimAt.get(key) || 0) < 1000 * 60) return 0;
  lockQuarantineReclaimAt.set(key, Date.now());
  let db = null;
  try {
    db = await openLockDb(projectRoot);
    if (!db.prepare("SELECT 1 FROM locks WHERE expires_at = ? LIMIT 1").get(Number.MAX_SAFE_INTEGER)) return 0;
    return await reclaimProvenGoneLockQuarantines(db);
  } catch (error) {
    logEvent("warn", "lock.containment_reclaim_failed", { error: error.message || String(error) });
    return 0;
  } finally {
    if (db) closeDb(db);
  }
}

async function quarantineProviderLease(lease, containment = "") {
  if (!lease?.id) return { ok: false, error: "No provider lease to quarantine." };
  let db = null;
  try {
    const now = Date.now();
    db = await openProviderLeaseDb({ deadlineAt: now + 1000 * 30 });
    db.exec("BEGIN IMMEDIATE");
    const quarantined = db.prepare(`
      UPDATE provider_leases SET heartbeat_at = ?, expires_at = ?, containment = ?
      WHERE lease_id = ? AND owner_instance_id = ? AND expires_at > ?
    `).run(now, Number.MAX_SAFE_INTEGER, String(containment || ""), lease.id, BRIDGE_INSTANCE_ID, now);
    if (Number(quarantined.changes || 0) === 1) {
      db.exec("COMMIT");
      return { ok: true, leaseId: lease.id, inserted: false };
    }
    // The lease already expired (a long termination outlived it) or was reclaimed. The
    // process tree may still run, so the slot must still be held: write a new quarantine row.
    db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(lease.id, BRIDGE_INSTANCE_ID);
    const leaseId = `${BRIDGE_INSTANCE_ID}-quarantine-${randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at, containment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(leaseId, String(lease.providerKey || CONFIG.providerConcurrencyKey), BRIDGE_INSTANCE_ID, process.pid, now, now, Number.MAX_SAFE_INTEGER, String(containment || ""));
    db.exec("COMMIT");
    logEvent("warn", "provider.containment_quarantine_reinserted", { leaseId: lease.id, quarantineLeaseId: leaseId });
    return { ok: true, leaseId, inserted: true };
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch { /* keep the original error */ }
    logEvent("error", "provider.containment_quarantine_failed", {
      leaseId: lease.id,
      error: error.message || String(error),
    });
    return { ok: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// Builders (OpenCode Zen) and reviewers/testers (Google Antigravity) are different
// accounts with separate rate limits, but one shared key gave them two slots in total, so a
// builder often spent part of its timeout waiting behind a reviewer. Without an explicit
// CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY each configured provider gets its own slots.
function providerKeyForMetadata(metadata = null) {
  const provider = String(metadata?.provider || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return CONFIG.providerConcurrencyKeyExplicit || !provider
    ? CONFIG.providerConcurrencyKey
    : `${CONFIG.providerConcurrencyKey}:${provider}`;
}

// B-061: the pause key of one provider/model, "<account key>:<provider>/<model>". It lives under the
// same "<key>:" prefix as the per-provider slot keys, so status and diagnose list it with them.
function modelPauseKeyForMetadata(metadata = null) {
  const provider = String(metadata?.provider || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const model = String(metadata?.model || "").trim();
  if (!provider || !model || !MODEL_NAME_PATTERN.test(model)) return "";
  return `${CONFIG.providerConcurrencyKey}:${provider}/${model}`;
}

// LIKE pattern for "<key>:<provider>" rows; "_" and "%" in the operator key are literals.
function providerKeyLikePattern(baseKey) {
  return `${String(baseKey).replace(/[\\%_]/g, (item) => `\\${item}`)}:%`;
}

async function providerCapacitySnapshot() {
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const now = Date.now();
    db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
    applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
    const likePattern = providerKeyLikePattern(CONFIG.providerConcurrencyKey);
    const capacityRows = db.prepare(`
      SELECT provider_key, capacity FROM provider_capacities WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'
    `).all(CONFIG.providerConcurrencyKey, likePattern);
    const capacityByKey = new Map(capacityRows.map((row) => [row.provider_key, Number(row.capacity)]));
    const leases = db.prepare(`
      SELECT lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at
      FROM provider_leases WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\' ORDER BY created_at
    `).all(CONFIG.providerConcurrencyKey, likePattern).map((row) => ({
      leaseId: row.lease_id,
      providerKey: row.provider_key,
      ownerInstanceId: row.owner_instance_id,
      ownerProcessId: Number(row.owner_pid || 0),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      heartbeatAt: row.heartbeat_at ? new Date(Number(row.heartbeat_at)).toISOString() : "",
      expiresAt: Number(row.expires_at) === Number.MAX_SAFE_INTEGER
        ? "quarantined (no expiry)"
        : new Date(Number(row.expires_at)).toISOString(),
      remainingMs: Math.max(0, Number(row.expires_at) - now),
      quarantined: Number(row.expires_at) === Number.MAX_SAFE_INTEGER,
    }));
    // Leases are stored per "<key>:<provider>"; the base key's capacity said nothing about
    // them ("capacity 4, 6 leases" across two providers). Report each key on its own.
    // Same rule as acquireProviderLease: a stored limit that differs from the config only binds
    // while leases taken under it are held (an older bridge process); an idle key takes the
    // configured limit on its next acquire, so "0 of 2" after a raise to 4 was wrong.
    const capacityFor = (key) => {
      const stored = capacityByKey.get(key);
      const configured = CONFIG.providerConcurrencyLimit;
      if (!Number.isInteger(stored) || stored <= 0 || stored === configured) return configured;
      return leases.some((lease) => lease.providerKey === key) ? Math.min(stored, configured) : configured;
    };
    const keyNames = [...new Set([...capacityByKey.keys(), ...leases.map((lease) => lease.providerKey)])].sort();
    const keys = keyNames.map((key) => {
      const held = leases.filter((lease) => lease.providerKey === key);
      return {
        providerKey: key,
        capacity: capacityFor(key),
        leases: held.length,
        quarantined: held.filter((lease) => lease.quarantined).length,
      };
    });
    const cooldowns = db.prepare(`
      SELECT provider_key, until_at, error_type, reason FROM provider_cooldowns
      WHERE until_at > ? AND (provider_key = ? OR provider_key LIKE ? ESCAPE '\\') ORDER BY provider_key
    `).all(now, CONFIG.providerConcurrencyKey, likePattern).map((row) => ({
      providerKey: row.provider_key,
      until: new Date(Number(row.until_at)).toISOString(),
      remainingMs: Math.max(0, Number(row.until_at) - now),
      errorType: row.error_type,
      reason: row.reason || "",
    }));
    // Q-005: what the global worker cap counts (every held slot, every key).
    const allLeaseCount = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases").get()?.count || 0);
    return { ok: true, providerKey: CONFIG.providerConcurrencyKey, capacity: capacityFor(CONFIG.providerConcurrencyKey), limits: describeConcurrencyLimits(), keys, leases, cooldowns, allLeaseCount };
  } catch (error) {
    return { ok: false, providerKey: CONFIG.providerConcurrencyKey, capacity: CONFIG.providerConcurrencyLimit, keys: [], leases: [], cooldowns: [], error: redactSensitiveText(error.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

function summarizeStderr(stderr) {
  return (stderr || "")
    .trim()
    .split(/\r?\n/)
    .slice(0, 12)
    .map((line) => {
      if (/"(messages|system|prompt|input)"\s*:/i.test(line)) {
        const errorType = providerErrorTypeFromText(line);
        return errorType ? `[provider request body omitted; classified as ${errorType}]` : "[provider request body omitted]";
      }
      return redactSensitiveText(line).slice(0, 500);
    })
    .join("\n")
    .slice(0, 4000);
}

function sanitizeAgentName(agent) {
  const normalized = String(agent || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid agent name "${agent}". Use only letters, numbers, dashes, or underscores.`);
  }
  return normalized;
}

function parseAgentList(output) {
  const agents = new Map();
  for (const line of (output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s+\((primary|subagent|all)\)/);
    if (match) {
      agents.set(match[1], match[2]);
    }
  }
  return agents;
}

async function listAvailableAgents(cwd, { forcePure = false } = {}) {
  if (forcePure) return listAvailableAgentsUncached(cwd, { forcePure });
  return cachedAttestation(
    `agent-list\0${attestationCwdKey(cwd)}`,
    () => listAvailableAgentsUncached(cwd),
    (value) => value?.result?.exitCode === 0 && value.agents.size > 0,
  );
}

async function listAvailableAgentsUncached(cwd, { forcePure = false } = {}) {
  const result = await safeOpenCodeCommand(["agent", "list"], cwd, 1000 * 30, { forcePure });
  return {
    result,
    agents: parseAgentList(result.stdout || result.stderr),
  };
}

async function debugAgentExists(agent, cwd, { forcePure = false } = {}) {
  if (forcePure) return debugAgentExistsUncached(agent, cwd, { forcePure });
  return cachedAttestation(
    `agent-exists\0${String(agent)}\0${attestationCwdKey(cwd)}`,
    () => debugAgentExistsUncached(agent, cwd),
    (value) => typeof value === "string" && Boolean(value),
  );
}

async function debugAgentExistsUncached(agent, cwd, { forcePure = false } = {}) {
  const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, 1000 * 20, { forcePure });
  if (result.exitCode !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.name === agent ? parsed?.mode || "unknown" : null;
  } catch {
    return null;
  }
}

const {
  normalizedPermissionRules,
  permissionDefaultAndOverrides,
  effectivePermissionProfileRules,
  approvedOpenCodeToolOutputPattern,
  normalizeAgentDebugMetadata,
  parseModelAllowlistEntry,
  allowlistedModelOverride,
  applyModelOverrideToMetadata,
  effectiveReadOnlyMetadataError,
  contractorNestedAgentMetadataError,
  sanitizedExternalPatternInsideRoot,
  sanitizedAgentMetadataError,
  agentMetadataPolicyOptions,
  sanitizedRoutingPolicyError,
  availableAgentLabels,
} = createAgentPolicyRuntime({
  USER_HOME_DIR,
  SAFE_AGENT_BASH_ALLOW_PATTERNS,
  CONTRACTOR_ALLOWED_SUBAGENTS,
  WRITE_CAPABLE_AGENTS,
  MCP_SANITIZED_READER_AGENT,
  MCP_SANITIZED_READER_PROFILE,
  MCP_SANITIZED_READER_PROMPT_SHA256,
  MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  activeModelOverrideAllowlist,
});





function managedAgentSourceProfile(source, agent) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(source || ""));
  if (!match) return null;
  const scalar = (name) => {
    const line = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m").exec(match[1]);
    return line ? line[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim() : "";
  };
  const modelValue = scalar("model");
  const separator = modelValue.indexOf("/");
  const temperature = Number(scalar("temperature"));
  if (!agent || separator <= 0 || !Number.isFinite(temperature)) return null;
  return {
    name: agent,
    mode: scalar("mode"),
    provider: modelValue.slice(0, separator),
    model: modelValue.slice(separator + 1),
    variant: scalar("variant"),
    temperature,
    promptSha256: createHash("sha256").update(match[2].trim()).digest("hex"),
  };
}

async function managedAgentSourceProfileError(agent, metadata) {
  const normalizedAgent = String(agent || "").toLowerCase();
  const sourceAttested = normalizedAgent !== MCP_SANITIZED_READER_AGENT.toLowerCase()
    && (REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === normalizedAgent)
      || CONTRACTOR_ALLOWED_SUBAGENTS.has(normalizedAgent));
  if (!sourceAttested) return null;
  const source = await readAgentDefinition(agent);
  const expected = managedAgentSourceProfile(source, agent);
  if (!expected) {
    return {
      errorType: "managed_agent_source_unavailable",
      error: `Bridge-managed source profile for ${agent} is missing or invalid in ${OPENCODE_AGENT_DIR}.`,
    };
  }
  const changedFields = ["name", "mode", "provider", "model", "variant", "temperature", "promptSha256"]
    .filter((field) => metadata?.[field] !== expected[field]);
  return changedFields.length ? {
    errorType: "managed_agent_profile_mismatch",
    error: `Effective OpenCode profile for ${agent} does not match its operator-managed source (changed fields: ${changedFields.join(", ")}).`,
  } : null;
}

async function managedSkillTreeInventory(root, { optional = false, prefix = "" } = {}) {
  const resolvedRoot = path.resolve(root);
  try {
    await assertNoLinkedPath(resolvedRoot, "Managed OpenCode skill root");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return [];
    throw error;
  }
  const rootDetails = await lstat(resolvedRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`Managed OpenCode skill root must be a real directory: ${resolvedRoot}`);
  }
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const details = await lstat(absolute);
      const relative = path.relative(resolvedRoot, absolute).replace(/\\/g, "/");
      if (details.isSymbolicLink()) {
        throw new Error(`Managed OpenCode skill tree contains a symbolic link or junction: ${relative}`);
      }
      if (details.isDirectory()) {
        await walk(absolute);
      } else if (details.isFile()) {
        if (!/\.bak$/i.test(entry.name)) {
          files.push({ path: `${prefix}${relative}`, sha256: await sha256File(absolute) });
        }
      } else {
        throw new Error(`Managed OpenCode skill tree contains an unsupported entry: ${relative}`);
      }
    }
  }
  await walk(resolvedRoot);
  return files;
}

async function managedSkillPolicyError(agent, {
  sourceRoot = OPENCODE_SKILL_DIR,
  effectiveConfigRoot = DEFAULT_OPENCODE_CONFIG_DIR,
  debugSkills = null,
  metadata = null,
} = {}) {
  const normalizedAgent = String(agent || "").toLowerCase();
  const managed = RELEASE_REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === normalizedAgent);
  if (!managed || metadata?.skillDenied === true) return null;
  try {
    const source = await managedSkillTreeInventory(sourceRoot);
    const missing = REQUIRED_MANAGED_SKILLS.filter((skill) => !source.some((entry) => entry.path === `${skill}/SKILL.md`));
    if (missing.length) {
      throw new Error(`Immutable managed skill source is missing required skills: ${missing.join(", ")}`);
    }
    const effective = [
      ...await managedSkillTreeInventory(path.join(effectiveConfigRoot, "skills")),
      ...await managedSkillTreeInventory(path.join(effectiveConfigRoot, "skill"), { optional: true, prefix: "skill/" }),
    ];
    const canonical = (entries) => entries
      .map((entry) => `${entry.path}\0${entry.sha256}`)
      .sort();
    if (JSON.stringify(canonical(source)) !== JSON.stringify(canonical(effective))) {
      throw new Error("Effective OpenCode skill tree does not exactly match the immutable managed source.");
    }
    if (!Array.isArray(debugSkills)) {
      throw new Error("OpenCode did not provide authoritative effective skill metadata.");
    }
    const expectedSkillNames = source
      .map((entry) => /^([^/]+)\/SKILL\.md$/.exec(entry.path)?.[1] || "")
      .filter(Boolean)
      .sort();
    const effectiveSkillsRoot = path.join(path.resolve(effectiveConfigRoot), "skills");
    const seen = new Set();
    for (const skill of debugSkills) {
      const location = String(skill?.location || "").trim();
      if (location === "<built-in>") continue;
      const name = String(skill?.name || "").trim();
      if (!name || !path.isAbsolute(location) || seen.has(name)) {
        throw new Error("OpenCode reported an invalid or duplicate effective managed skill.");
      }
      const expectedLocation = path.join(effectiveSkillsRoot, name, "SKILL.md");
      if (normalizePathForCompare(location) !== normalizePathForCompare(expectedLocation)) {
        throw new Error(`OpenCode resolved managed skill ${name} from an unexpected origin.`);
      }
      seen.add(name);
    }
    if (JSON.stringify([...seen].sort()) !== JSON.stringify(expectedSkillNames)) {
      throw new Error("OpenCode effective skill names do not exactly match the immutable managed source.");
    }
    return null;
  } catch (error) {
    return {
      errorType: "managed_skill_integrity_failed",
      error: redactSensitiveText(error.message || String(error)),
    };
  }
}

async function managedSkillSourceEvidence(sourceRoot = OPENCODE_SKILL_DIR) {
  try {
    const inventory = await managedSkillTreeInventory(sourceRoot);
    const records = inventory.map((entry) => `${entry.path}\0${entry.sha256}`).sort();
    const names = inventory
      .map((entry) => /^([^/]+)\/SKILL\.md$/.exec(entry.path)?.[1] || "")
      .filter(Boolean)
      .sort();
    return {
      ok: true,
      fileCount: inventory.length,
      names,
      sha256: createHash("sha256").update(records.join("\n")).digest("hex"),
      error: "",
    };
  } catch (error) {
    return { ok: false, fileCount: 0, names: [], sha256: "", error: redactSensitiveText(error.message || String(error)) };
  }
}

const managedSkillDebugFlights = new Map();

async function readManagedSkillDebugMetadata(cwd, { forcePure = false, runtimeContext = null, verifiedPluginPolicy = null } = {}) {
  const read = () => safeOpenCodeCommand(["debug", "skill"], cwd, 1000 * 30, { forcePure, runtimeContext, verifiedPluginPolicy });
  if (forcePure || runtimeContext) return read();
  const key = normalizePathForCompare(path.resolve(cwd || process.cwd()));
  return runSingleFlight(managedSkillDebugFlights, key, read);
}

// Speed-up option 3 (user decision, 2026-09-29): a freshly created, proven-clean worktree holds
// exactly its base tree, and OpenCode's project directory there is the worktree root, so every
// such worktree of one repository and base tree attests the same (global inputs are in the cache
// fingerprint). Keyed that way instead of by the new worktree path, which never repeated. The
// final uncached pre-spawn attestation in runOpenCode still runs in each worktree.
function agentMetadataCacheKey(agent, cwd, worktreeIdentity = null) {
  const place = worktreeIdentity?.repoRoot && /^[0-9a-f]{40,64}$/i.test(String(worktreeIdentity.baseTree || ""))
    ? `worktree\0${attestationCwdKey(worktreeIdentity.repoRoot)}\0${String(worktreeIdentity.baseTree).toLowerCase()}`
    : attestationCwdKey(cwd);
  return `agent-metadata\0${String(agent)}\0${place}`;
}

async function readAgentDebugMetadata(agent, cwd, { forcePure = false, runtimeContext = null, verifiedPluginPolicy = null, worktreeIdentity = null } = {}) {
  if (forcePure || runtimeContext) {
    return readAgentDebugMetadataUncached(agent, cwd, { forcePure, runtimeContext, verifiedPluginPolicy });
  }
  return cachedAttestation(
    agentMetadataCacheKey(agent, cwd, worktreeIdentity),
    () => readAgentDebugMetadataUncached(agent, cwd, { verifiedPluginPolicy }),
    (value) => Boolean(value?.ok),
  );
}

async function readAgentDebugMetadataUncached(agent, cwd, { forcePure = false, runtimeContext = null, verifiedPluginPolicy = null } = {}) {
  const pluginPolicy = forcePure
    ? { ok: true, mode: "pure", plugins: [] }
    : verifiedPluginPolicy || await verifyExternalPluginPolicy(cwd);
  if (!pluginPolicy.ok) {
    return { ok: false, errorType: pluginPolicy.errorType, error: pluginPolicy.error, metadata: null, pluginPolicy };
  }
  const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, 1000 * 30, { forcePure, runtimeContext, verifiedPluginPolicy: pluginPolicy });
  if (result.exitCode !== 0) {
    return { ok: false, errorType: "agent_metadata_unavailable", error: summarizeStderr(result.stderr), metadata: null };
  }
  try {
    const metadata = normalizeAgentDebugMetadata(JSON.parse(result.stdout), agent, { isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" });
    const sourceProfileError = metadata ? await managedAgentSourceProfileError(agent, metadata) : null;
    if (sourceProfileError) {
      return { ok: false, ...sourceProfileError, metadata: null, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" };
    }
    let debugSkills = null;
    const managedSkillAttestationRequired = metadata
      && metadata.skillDenied !== true
      && RELEASE_REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === String(agent || "").toLowerCase());
    if (managedSkillAttestationRequired) {
      const skillResult = await readManagedSkillDebugMetadata(cwd, { forcePure, runtimeContext, verifiedPluginPolicy: pluginPolicy });
      if (skillResult.exitCode !== 0) {
        return {
          ok: false,
          errorType: "managed_skill_integrity_failed",
          error: summarizeStderr(skillResult.stderr) || "OpenCode effective skill metadata could not be read.",
          metadata: null,
          isolatedRuntimeRoot: result.isolatedRuntimeRoot || "",
        };
      }
      try {
        debugSkills = JSON.parse(skillResult.stdout);
      } catch (error) {
        return {
          ok: false,
          errorType: "managed_skill_integrity_failed",
          error: `OpenCode effective skill metadata was invalid JSON: ${error.message || String(error)}`,
          metadata: null,
          isolatedRuntimeRoot: result.isolatedRuntimeRoot || "",
        };
      }
    }
    const skillPolicyError = metadata ? await managedSkillPolicyError(agent, { debugSkills, metadata }) : null;
    if (skillPolicyError) {
      return { ok: false, ...skillPolicyError, metadata: null, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" };
    }
    return metadata
      ? { ok: true, metadata, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "", pluginPolicy }
      : { ok: false, errorType: "agent_metadata_invalid", error: "OpenCode debug metadata did not match the requested agent.", metadata: null };
  } catch (error) {
    return { ok: false, errorType: "agent_metadata_invalid", error: error.message || String(error), metadata: null };
  }
}


function activeModelOverrideAllowlist() {
  return process.argv.some((argument) => String(argument).startsWith("--self-test")) && Array.isArray(selfTestModelOverrideAllowlist)
    ? selfTestModelOverrideAllowlist
    : CONFIG.modelOverrideAllowlist;
}





async function attestContractorNestedAgents(cwd, { forcePure = false } = {}) {
  const agents = [...CONTRACTOR_ALLOWED_SUBAGENTS].sort();
  const results = await Promise.all(agents.map(async (agent) => ({
    agent,
    metadataResult: await readAgentDebugMetadata(agent, cwd, { forcePure }),
  })));
  const profiles = [];
  for (const { agent, metadataResult } of results) {
    const error = contractorNestedAgentMetadataError(agent, metadataResult);
    if (error) return { ok: false, ...error, agent, profiles };
    profiles.push({ agent, metadata: metadataResult.metadata });
  }
  return { ok: true, profiles };
}

const { exactPluginSpecifier, parseJsoncObject, pluginSpecsFromConfigText, hashExactTree, readPluginConfigSource, verifyNoLocalPluginDirectory, openCodeProjectConfigDirectories, managedOpenCodeConfigDirectories, exactPluginPackageName, pluginConfigCandidatePaths, expectedOpenCodePluginResolution, verifyExternalPluginPolicyUnshared, externalPluginPolicyFlights, verifyExternalPluginPolicy } = createPluginPolicyRuntime({ CONFIG, DEFAULT_OPENCODE_CACHE_HOME, DEFAULT_OPENCODE_CONFIG_DIR, OPENCODE_EXE, assertNoLinkedPath, buildOpenCodeEnv, cachedAttestation, logEvent, parseJsonText, resolveProjectStateRoot, runCommand, runSingleFlight, sha256File, staleBridgeProcessHint, summarizeStderr });

async function safeOpenCodeCommand(args, cwd, timeoutMs = 1000 * 30, { forcePure = false, runtimeContext = null, verifiedPluginPolicy = null } = {}) {
  const pure = forcePure || !CONFIG.allowExternalPlugins;
  if (!pure) {
    const pluginPolicy = verifiedPluginPolicy || await verifyExternalPluginPolicy(cwd);
    if (!pluginPolicy.ok) {
      return { stdout: "", stderr: pluginPolicy.error, exitCode: "plugin_policy_rejected", pluginPolicy };
    }
  }
  const commandArgs = pure && !args.includes("--pure") ? ["--pure", ...args] : args;
  let ownedRuntime = null;
  let result = null;
  let cleanup = { ok: true, error: "" };
  try {
    ownedRuntime = forcePure && !runtimeContext ? await createIsolatedOpenCodeRuntime() : null;
    const isolatedRuntime = runtimeContext || ownedRuntime;
    const executionEnv = isolatedRuntime?.env || buildOpenCodeEnv();
    result = { ...(await runCommand(OPENCODE_EXE, commandArgs, cwd, timeoutMs, executionEnv)), isolatedRuntimeRoot: isolatedRuntime?.root || "" };
  } finally {
    if (ownedRuntime) {
      cleanup = await wipeIsolatedOpenCodeRuntime(ownedRuntime.root);
    }
  }
  return cleanup.ok
    ? result
    : { stdout: "", stderr: `Isolated OpenCode runtime cleanup failed: ${cleanup.error}`, exitCode: "isolated_runtime_cleanup_failed", isolatedRuntimeRoot: ownedRuntime?.root || "" };
}

function normalizedManifestRelativePath(value) {
  const raw = String(value || "");
  if (raw.includes("\\")) {
    return "";
  }
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw) || raw.startsWith("/") || raw.split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1F\x7F]/.test(raw)) {
    return "";
  }
  return raw;
}

async function enumerateSanitizedTree(root) {
  const absoluteRoot = path.resolve(root);
  await assertNoLinkedPath(absoluteRoot, "Sanitized workspace root");
  const rootDetails = await lstat(absoluteRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error("Sanitized workspace root must be a real directory, not a symlink, junction, or file.");
  }
  const files = [];
  const directories = [];
  let totalBytes = 0;
  const realRoot = await realpath(absoluteRoot);
  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(absoluteRoot, absolute).replace(/\\/g, "/");
      const details = await lstat(absolute);
      if (child.isSymbolicLink() || details.isSymbolicLink()) {
        throw new Error(`Sanitized workspace contains a symbolic link or junction: ${relative}`);
      }
      const realEntry = await realpath(absolute);
      if (realEntry !== realRoot && !isPathInside(realRoot, realEntry)) {
        throw new Error(`Sanitized workspace entry resolves outside its root: ${relative}`);
      }
      if (details.isDirectory()) {
        directories.push(relative);
        await walk(absolute);
      } else if (details.isFile()) {
        totalBytes += details.size;
        files.push({ relative, absolute, size: details.size });
        if (files.length > CONFIG.sanitizedMaxFiles || totalBytes > CONFIG.sanitizedMaxBytes) {
          throw new Error(`Sanitized workspace exceeds configured bounds (${files.length} files, ${totalBytes} bytes).`);
        }
      } else {
        throw new Error(`Sanitized workspace contains an unsupported filesystem entry: ${relative}`);
      }
    }
  }
  await walk(absoluteRoot);
  return { files, directories: directories.sort(), totalBytes };
}

async function assertNoLinkedPath(absolutePath, label = "Path") {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link or junction: ${current}`);
    }
  }
}

async function verifySanitizedWorkspace(contract, phase = "manual") {
  const checkedAt = new Date().toISOString();
  try {
    const parsedContract = sanitizedWorkspaceSchema.parse(contract);
    if (!path.isAbsolute(parsedContract.root) || !path.isAbsolute(parsedContract.manifestPath)) {
      throw new Error("Sanitized workspace root and manifestPath must be explicit absolute paths.");
    }
    const root = path.resolve(parsedContract.root);
    const manifestPath = path.resolve(parsedContract.manifestPath);
    await assertNoLinkedPath(root, "Sanitized workspace root");
    await assertNoLinkedPath(manifestPath, "Sanitized workspace manifest");
    const manifestDetails = await lstat(manifestPath);
    if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
      throw new Error("Sanitized workspace manifest must be a regular file, not a symlink or junction.");
    }
    if (manifestDetails.size > CONFIG.policyMaxBytes) {
      throw new Error(`Sanitized workspace manifest exceeds the ${CONFIG.policyMaxBytes}-byte safety limit.`);
    }
    const manifestContent = await readFile(manifestPath);
    const actualManifestSha256 = createHash("sha256").update(manifestContent).digest("hex");
    if (actualManifestSha256 !== parsedContract.manifestSha256.toLowerCase()) {
      throw new Error(`Sanitized workspace manifest hash mismatch. Expected ${parsedContract.manifestSha256.toLowerCase()}, got ${actualManifestSha256}.`);
    }
    const manifest = parseJsonText(manifestContent.toString("utf8"));
    if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
      throw new Error("Sanitized workspace manifest must contain version 1, a files object, and an exact directories array.");
    }
    const manifestEntries = Object.entries(manifest.files);
    if (manifestEntries.length > CONFIG.sanitizedMaxFiles || manifest.directories.length > CONFIG.sanitizedMaxFiles) {
      throw new Error("Sanitized workspace manifest exceeds configured entry-count bounds.");
    }
    const expectedFiles = manifestEntries.map(([relative]) => normalizedManifestRelativePath(relative));
    const expectedDirectories = manifest.directories.map(normalizedManifestRelativePath);
    if (expectedFiles.some((item) => !item) || expectedDirectories.some((item) => !item)) {
      throw new Error("Sanitized workspace manifest contains an unsafe path.");
    }
    const caseKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    if (new Set(expectedFiles.map(caseKey)).size !== expectedFiles.length || new Set(expectedDirectories.map(caseKey)).size !== expectedDirectories.length) {
      throw new Error("Sanitized workspace manifest contains duplicate or case-colliding paths.");
    }
    const canonicalManifestFiles = Object.fromEntries(manifestEntries.map(([relative, digest], index) => [expectedFiles[index], digest]));
    for (const [relative, digest] of Object.entries(canonicalManifestFiles)) {
      if (!/^[a-f0-9]{64}$/.test(String(digest || ""))) {
        throw new Error(`Sanitized workspace manifest contains an invalid SHA-256 digest for ${relative}.`);
      }
    }
    const tree = await enumerateSanitizedTree(root);
    const actualFiles = tree.files.map((item) => item.relative).sort();
    const actualDirectories = tree.directories.sort();
    const expectedFileList = [...expectedFiles].sort();
    const expectedDirectoryList = [...expectedDirectories].sort();
    const actualFileSet = new Set(actualFiles);
    const expectedFileSet = new Set(expectedFileList);
    const actualDirectorySet = new Set(actualDirectories);
    const expectedDirectorySet = new Set(expectedDirectoryList);
    const discrepancies = [];
    for (const file of expectedFileList) if (!actualFileSet.has(file)) discrepancies.push({ type: "missing", path: file });
    for (const file of actualFiles) if (!expectedFileSet.has(file)) discrepancies.push({ type: "unexpected", path: file });
    for (const directory of expectedDirectoryList) if (!actualDirectorySet.has(directory)) discrepancies.push({ type: "directory_missing", path: directory });
    for (const directory of actualDirectories) if (!expectedDirectorySet.has(directory)) discrepancies.push({ type: "directory_unexpected", path: directory });
    const requiredFiles = (parsedContract.requiredFiles || []).map(normalizedManifestRelativePath);
    const forbiddenFiles = (parsedContract.forbiddenFiles || []).map(normalizedManifestRelativePath);
    if (requiredFiles.some((item) => !item) || forbiddenFiles.some((item) => !item)) {
      throw new Error("Sanitized workspace contract contains an unsafe required/forbidden path.");
    }
    for (const required of requiredFiles) if (!actualFileSet.has(required)) discrepancies.push({ type: "required_missing", path: required });
    for (const file of actualFiles) if (isWithinAnyPath(file, forbiddenFiles, root)) discrepancies.push({ type: "forbidden_present", path: file });
    for (const file of tree.files) {
      const expected = canonicalManifestFiles[file.relative];
      if (!expected) continue;
      const actual = await sha256File(file.absolute);
      if (actual !== expected) discrepancies.push({ type: "hash_mismatch", path: file.relative, expected, actual });
    }
    const stateSha256 = createHash("sha256").update(JSON.stringify({
      manifestSha256: actualManifestSha256,
      files: expectedFileList.map((file) => [file, canonicalManifestFiles[file]]),
      directories: expectedDirectoryList,
    })).digest("hex");
    return {
      ok: discrepancies.length === 0,
      phase,
      checkedAt,
      root,
      manifestPath,
      manifestSha256: actualManifestSha256,
      stateSha256,
      fileCount: actualFiles.length,
      directoryCount: actualDirectories.length,
      totalBytes: tree.totalBytes,
      discrepancies,
      errorType: discrepancies.length ? "sanitized_workspace_integrity_failed" : null,
      error: discrepancies.length ? "Sanitized workspace does not exactly match its pinned manifest and boundary contract." : "",
    };
  } catch (error) {
    return {
      ok: false,
      phase,
      checkedAt,
      errorType: "sanitized_workspace_integrity_failed",
      error: redactSensitiveText(error.message || String(error)),
      discrepancies: [],
    };
  }
}

const {
  detectsOpenCodeFallback,
  modelEvidenceFromEvent,
  emptyOpenCodeUsage,
  addStepFinishUsage,
  formatOpenCodeUsage,
  emptyToolWeights,
  toolWeightSession,
  noteToolUse,
  noteStepFinish,
  heaviestToolCalls,
  mergeHeavyToolCalls,
  formatHeavyToolCalls,
  inspectOpenCodeEventStream,
  detectsOpenCodeApiError,
} = createOpenCodeEventRuntime({
  CONFIG,
});

const { readAgentDefinition, buildSubagentProxyPrompt, resolveAgent } = createAgentResolutionRuntime({ DEFAULT_SUBAGENT_PROXY_AGENT, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, MCP_SANITIZED_READER_AGENT, OPENCODE_AGENT_DIR, ORCHESTRATOR_AGENT_ALIASES, availableAgentLabels, debugAgentExists, listAvailableAgents, normalizeOrchestratorModeValue, sanitizeAgentName });

async function loadProjectAgentPolicy(
  cwd = "",
  policyPath = ".mcp/agent-policy.json",
  {
    operatorTrustedPolicySha256 = CONFIG.trustedPolicySha256,
    operatorTrustedPolicyRoot = CONFIG.trustedPolicyRoot,
    operatorTrustedPolicyPath = CONFIG.trustedPolicyPath,
    operatorExecutableHashes = CONFIG.validationExecutableSha256Allowlist,
  } = {}
) {
  const targetCwd = cwd || process.cwd();
  const resolved = path.resolve(targetCwd, policyPath || ".mcp/agent-policy.json");
  const boundaryError = unsafePathReason([policyPath || ".mcp/agent-policy.json"], targetCwd);
  if (!isPathInside(targetCwd, resolved) || boundaryError) {
    return {
      ok: false,
      errorType: "policy_path_unsafe",
      error: boundaryError || "Policy path must stay inside the target repository.",
    };
  }

  try {
    const contentBuffer = await readFile(resolved);
    if (contentBuffer.length > CONFIG.policyMaxBytes) {
      throw new Error(`Policy exceeds CODEX_OPENCODE_POLICY_MAX_BYTES=${CONFIG.policyMaxBytes}.`);
    }
    const content = contentBuffer.toString("utf8");
    const sha256 = createHash("sha256").update(contentBuffer).digest("hex");
    let trustedForAuthority = false;
    const trustedRootInput = String(operatorTrustedPolicyRoot || "").trim();
    const trustedPathInput = String(operatorTrustedPolicyPath || "").trim();
    if (
      String(operatorTrustedPolicySha256 || "").trim().toLowerCase() === sha256
      && trustedRootInput
      && trustedPathInput
      && !path.isAbsolute(trustedPathInput)
      && !unsafePathReason([trustedPathInput], trustedRootInput)
    ) {
      try {
        const canonicalTargetRoot = await realpath(path.resolve(targetCwd));
        const canonicalTrustedRoot = await realpath(path.resolve(trustedRootInput));
        const canonicalPolicyPath = await realpath(resolved);
        const trustedPolicyAbsolute = path.resolve(canonicalTrustedRoot, trustedPathInput);
        trustedForAuthority = normalizePathForCompare(canonicalTargetRoot) === normalizePathForCompare(canonicalTrustedRoot)
          && isPathInside(canonicalTrustedRoot, trustedPolicyAbsolute)
          && normalizePathForCompare(canonicalPolicyPath) === normalizePathForCompare(trustedPolicyAbsolute);
      } catch {
        trustedForAuthority = false;
      }
    }
    const raw = parseJsonText(content);
    if (raw?.requiresWorktrees === false) {
      return {
        ok: false,
        errorType: "policy_safety_weakening",
        error: "Repository policy may require worktrees but may not disable the caller/default worktree requirement.",
        path: resolved,
        sha256,
      };
    }
    const policy = normalizeProjectAgentPolicy(raw);
    if (policy.finalValidationCommand) {
      if (!trustedForAuthority) {
        return {
          ok: false,
          errorType: "policy_validation_command_untrusted",
          error: "Repository policy selected a validation command, but the operator trust pins do not approve its canonical repository root, exact repo-relative path, and bytes.",
          path: resolved,
          sha256,
        };
      }
      const validationSpec = await prepareValidationCommand(policy.finalValidationCommand, {
        requirePinnedExecutable: true,
        operatorExecutableHashes,
      });
      if (!validationSpec.ok) {
        return {
          ok: false,
          errorType: "policy_validation_command_untrusted",
          error: validationSpec.error,
          path: resolved,
          sha256,
        };
      }
      policy.finalValidationSpec = validationSpec;
    }
    return {
      ok: true,
      path: resolved,
      sha256,
      trustedForAuthority,
      policy,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, path: resolved, policy: null };
    }
    return {
      ok: false,
      errorType: error instanceof z.ZodError ? "policy_schema_invalid" : "policy_load_failed",
      error: error.message || String(error),
      path: resolved,
    };
  }
}

const { callerPathSpellings, pathSpeller, buildCompactPrompt, dependencyRequestPayloadSchema, DEPENDENCY_ABSENT, parseDependencyRequest, openCodePromptArgument, openCodeRunArgs, OPENCODE_WINDOWS_COMMAND_LINE_LIMIT, OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT, openCodeCommandLineLengthError, commandShape, timeoutForAgent, unboundedTimeoutForAgent, isTimeoutResult, applyRateLimitOutcome, rateLimitPauseReason, classifyResultError, createPhaseClock, PHASE_LABELS, formatPhaseTimings } = createOpenCodeCommandRuntime({ CONFIG, DEFAULT_RETURN_FORMAT, OPENCODE_EXE, defaultBuilderTimeoutMs, defaultContractorOrchestratorTimeoutMs, defaultOrchestratorTimeoutMs, defaultReadOnlyAgentTimeoutMs, defaultWriteAgentTimeoutMs, isOrchestratorAgent, nowMs });

const { runOpenCode, readOnlyResultRetryable, runOpenCodeWithPolicy, readOnlyRetryBudgetExhaustedResult, logOpenCodeResult } = createOpenCodeRunRuntime({ CONFIG, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, OPENCODE_EXE, acquireProviderLease, agentIdleTimeoutForModel, allowlistedModelOverride, applyModelOverrideToMetadata, applyRateLimitOutcome, buildOpenCodeEnv, classifyResultError, clearAgentActivity, combineAbortSignals, commandShape, containmentRecord, createIsolatedOpenCodeRuntime, defaultWriteAgentTimeoutMs, delayWithSignal, detectsOpenCodeFallback, effectiveReadOnlyMetadataError, emptyOpenCodeUsage, inspectOpenCodeEventStream, isManagedReadOnlyAgent, isTimeoutResult, logEvent, maxReadOnlyAgentRetries, mergeHeavyToolCalls, modelPauseKeyForMetadata, noteAgentActivity, nowMs, openCodeCommandLineLengthError, openCodeRunArgs, parseDependencyRequest, providerKeyForMetadata, providerSlotWaitStorage, providerSlotWaitingJobs, quarantineProviderLease, rateLimitPauseReason, readAgentDebugMetadata, readAgentDebugMetadataUncached, recordProviderCooldown, recordRateLimitPause, releaseProviderLease, runSpawnCommand, startProviderLeaseHeartbeat, summarizeStderr, timeoutForAgent, verifyExternalPluginPolicy, wipeIsolatedOpenCodeRuntime });

const { formatSingleResultParts, formatSingleResult, timedOutWriterNote, timedOutWriterEvidence, timedOutWriterLine, COMPACT_FILE_LIST_LIMIT, compactFileList, compactJobLines, fitJobResultText, fitRedactedJobResult, patchPreviewOmittedLine, conflictPathsFromConflict, formatRejectedExecution } = createResultFormatRuntime({ CONFIG, formatHeavyToolCalls, formatOpenCodeUsage, formatPhaseTimings, formatReadOnlyHeadMove: (...args) => formatReadOnlyHeadMove(...args), rateLimitPauseReason, summarizeStderr, truncateResultText });

function transientGitIndexReadError(result) {
  return /(?:\.git[\\/]index|index file open failed|index\.lock).*(?:permission denied|used by another process|file exists)/i
    .test([result?.stderr, result?.stdout].filter(Boolean).join("\n"));
}

async function runGitReadOnlyCommand(args, cwd, timeoutMs = 1000 * 15, commandRunner = runCommand) {
  let result = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await commandRunner(
      "git",
      args,
      cwd,
      timeoutMs,
      buildValidationEnv({ GIT_OPTIONAL_LOCKS: "0" })
    );
    if (result.exitCode === 0 || !transientGitIndexReadError(result) || attempt === 3) return result;
    await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
  }
  return result;
}

// Ignored entries, listed with --directory so a wholly ignored node_modules/ or .venv/ is one
// "dir/" entry: listing every file in them exceeded the 30 MB capture budget in large
// checkouts and every snapshot then failed closed. A wholly ignored directory that is not a
// regenerable build/cache directory (.idea/, logs/, secrets/) is walked so its files keep
// their own entries; regenerable directories inside it stay one entry, by name.
function ignoredEntryIsRegenerable(entry) {
  const segments = String(entry || "").split("/");
  const directories = entry.endsWith("/") ? segments.filter(Boolean) : segments.slice(0, -1);
  return directories.some((segment) => REGENERABLE_IGNORED_DIRECTORY.test(segment));
}

async function expandIgnoredDirectoryEntries(cwd, entries, { limit = CONFIG.maxIgnoredSnapshotFiles } = {}) {
  const base = path.resolve(cwd || process.cwd());
  const expanded = [];
  const limitError = () => {
    const error = new Error(`Ignored-file snapshot limit exceeded: more than ${limit} ignored entries outside build/cache directories exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${limit}.`);
    error.errorType = "snapshot_safety_limit_exceeded";
    return error;
  };
  for (const entry of entries) {
    if (!entry.endsWith("/") || ignoredEntryIsRegenerable(entry)) {
      expanded.push(entry);
      continue;
    }
    const stack = [entry.replace(/\/+$/, "")];
    while (stack.length) {
      const directory = stack.pop();
      let children;
      try {
        children = await readdir(path.join(base, ...directory.split("/")), { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") expanded.push(`${directory}/`);
        continue;
      }
      if (children.some((child) => child.name === ".git")) {
        expanded.push(`${directory}/`);
        continue;
      }
      for (const child of children) {
        const childPath = `${directory}/${child.name}`;
        if (child.isDirectory()) {
          if (REGENERABLE_IGNORED_DIRECTORY.test(child.name)) expanded.push(`${childPath}/`);
          else stack.push(childPath);
        } else {
          expanded.push(childPath);
        }
      }
      if (expanded.length > limit + entries.length) throw limitError();
    }
  }
  return expanded;
}

function splitNulSeparated(stdout) {
  return String(stdout || "").split("\0").filter(Boolean);
}

async function gitChangedFiles(cwd, { includeIgnored = false } = {}) {
  return (await gitChangedFileLists(cwd, { includeIgnored })).all;
}

// ordinary: modified, staged and untracked files; all: those plus ignored entries when asked.
// Callers that need both used to list the ordinary set twice (three git commands each time).
async function gitChangedFileLists(cwd, { includeIgnored = false } = {}) {
  // --no-renames: a staged `git mv forbidden/x allowed/x` otherwise lists only the destination
  // and the forbidden deletion passed scope validation. -z: exact paths, no quoting.
  const commands = [
    runGitReadOnlyCommand(["diff", "--name-only", "--no-renames", "-z"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["diff", "--cached", "--name-only", "--no-renames", "-z"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["ls-files", "--others", "--exclude-standard", "-z"], cwd, 1000 * 15),
  ];
  if (includeIgnored) {
    commands.push(runGitReadOnlyCommand(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"], cwd, 1000 * 30));
    // Forbidden-looking ignored files (.env, *.pem, *.key, secrets/) keep their own entry even
    // inside a directory --directory collapsed. They are selected with exclude patterns (-x,
    // gitignore syntax), not pathspecs: bridge git runs with GIT_LITERAL_PATHSPECS=1, under
    // which a ":(glob)" pathspec matched nothing and these files were silently missed. Without
    // --exclude-standard this also lists non-ignored matches, which the untracked listing
    // already holds (the Set below dedupes them).
    commands.push(runGitReadOnlyCommand(["-c", "core.ignorecase=true", "ls-files", "--others", "--ignored", "-z", ...FORBIDDEN_LOOKING_EXCLUDE_PATTERNS.flatMap((pattern) => ["-x", pattern])], cwd, 1000 * 30));
  }
  const [workingTreeDiff, stagedDiff, untracked, ignored, forbiddenIgnored] = await Promise.all(commands);
  const failedChecks = [
    ["working tree", workingTreeDiff],
    ["staged files", stagedDiff],
    ["untracked files", untracked],
    ...(ignored ? [["ignored files", ignored]] : []),
    ...(forbiddenIgnored ? [["ignored protected files", forbiddenIgnored]] : []),
  ].filter(([, result]) => result.exitCode !== 0);
  if (failedChecks.length) {
    const details = failedChecks
      .map(([label, result]) => `${label}: ${summarizeStderr(result.stderr || result.stdout) || `exit ${result.exitCode}`}`)
      .join("; ");
    throw new Error(`Git changed-file inspection failed closed (${details}).`);
  }

  const ignoredEntries = ignored ? await expandIgnoredDirectoryEntries(cwd, splitNulSeparated(ignored.stdout)) : [];
  const ordinary = [
    ...new Set([
      ...splitNulSeparated(workingTreeDiff.stdout),
      ...splitNulSeparated(stagedDiff.stdout),
      ...splitNulSeparated(untracked.stdout),
    ]),
  ].sort();
  const all = includeIgnored
    ? [...new Set([
      ...ordinary,
      ...ignoredEntries,
      ...(forbiddenIgnored ? splitNulSeparated(forbiddenIgnored.stdout).filter((file) => FORBIDDEN_LOOKING_PATH.test(file)) : []),
    ])].sort()
    : ordinary;
  return { ordinary, all };
}

async function verifyProtectedGitRoot(cwd) {
  const base = path.resolve(cwd || process.cwd());
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], base, 1000 * 15);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      errorType: "git_state_required",
      error: "Protected OpenCode execution requires a Git repository so changed-file validation cannot silently fail open.",
    };
  }
  const root = path.resolve(result.stdout.trim());
  return { ok: true, root };
}

async function verifyJobWorkspaceReadiness(job, lockPlan, worktreeMode = CONFIG.worktreeMode) {
  if (job.dryRun) return { ok: true, skipped: "routing_only" };
  // Sanitized callers verify the manifest separately, before agent discovery.
  if (job.sanitizedWorkspace) return { ok: true, skipped: "manifest_protected" };
  const gitState = await verifyProtectedGitRoot(job.cwd);
  if (!gitState.ok) {
    return {
      ...gitState,
      suggestedFix: "Run the job inside a Git repository, or use dryRun for routing-only validation.",
    };
  }
  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD^{commit}"], gitState.root, 1000 * 15, buildValidationEnv());
  if (head.exitCode !== 0 || !head.stdout.trim()) {
    return {
      ok: false,
      root: gitState.root,
      errorType: "git_head_required",
      error: "Protected OpenCode execution requires HEAD to resolve to a commit. An unborn or invalid HEAD cannot provide a reproducible execution baseline.",
      suggestedFix: "Select a checkout with a valid commit, or create an appropriate checkpoint outside the bridge before retrying. Use dryRun for routing-only validation.",
    };
  }
  if (shouldUseWorktree(job, lockPlan, worktreeMode)) {
    const checkpoint = await inspectSourceCheckpointState(gitState.root, {
      lockedPaths: lockPlan.lockedPaths,
      allowedEdits: lockPlan.allowedEdits,
      scopeContract: lockPlan.scopeContract,
    });
    if (!checkpoint.ok) {
      return {
        ...checkpoint,
        root: gitState.root,
        ...dirtyCheckpointDetails(checkpoint),
        suggestedFix: "Create or select an external checkpoint for the complete source checkout; the bridge will not stash, reset, or commit it.",
      };
    }
  }
  return { ok: true, root: gitState.root, head: head.stdout.trim() };
}

const { fileFingerprint, durableFileMode, INTEGRATION_WORKTREE_RULES, integrationWorktreeRules, exactIntegrationFileSnapshot, snapshotMismatches, regularFileFingerprint, crlfToLfBytes, gitEolRecordsFromOutput, integrationContentMismatches, changedPathSetEvidence, shouldAvoidSnapshotContent, gitChangedFileSnapshot, gitChangedFileSnapshotUntimed, gitChangedFileSnapshotParts, REGENERABLE_IGNORED_DIRECTORY, FORBIDDEN_LOOKING_PATH, FORBIDDEN_LOOKING_EXCLUDE_PATTERNS, groupIgnoredFiles, changedFilesBetween } = createFileSnapshotRuntime({ CONFIG, gitChangedFileLists, integrationTimed: (...args) => integrationTimed(...args), runCommand, runGitReadOnlyCommand });

const { snapshotIdentitySha256, readFileIfExists, captureRollbackBaseline, captureRollbackBaselineUntimed, ensureParentDir, safeRollbackParent, removeRollbackLeaf, replaceRollbackLeaf, restoreFromGitHead, fileExistsInGitCommit, rollbackUnsafeChanges, rollbackVerifiedOwnedChanges, scopeChangedFileViolations, changedFileValidationErrorType, validateChangedFilesForPlan } = createRollbackRuntime({ CONFIG, assertNoLinkedPath, buildValidationEnv, durableFileMode, exactIntegrationFileSnapshot, gitChangedFileLists, groupIgnoredFiles, integrationContentMismatches, integrationTimed: (...args) => integrationTimed(...args), integrationWorktreeRules, runCommand, shouldAvoidSnapshotContent });

function safeNamePart(value, fallback = "item") {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}




function makeQueueJobId(agent = "agent") {
  return `${safeNamePart(agent, "agent")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

const { captureIntegrationJournalEvidence, assertIntegrationLockOwned, prepareIntegrationOperation, INTEGRATION_JOURNAL_TERMINAL, transitionIntegrationOperation, readIntegrationJournalFileEvidence, restoreIntegrationJournalFile, quarantineIntegrationOperation, integrationRecoveryErrorText, integrationRecoveryBaseline, recoverSingleIntegrationOperationWhileLocked, REQUALIFIABLE_INTEGRATION_QUARANTINES, requalifyStateDriftQuarantine, recoverIntegrationOperationsWhileLocked, readIntegrationOperationSummary, integrationJournalDiagnosis } = createIntegrationJournalRuntime({ BRIDGE_INSTANCE_ID, CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, INTEGRATION_RESOLVED_SQL, INTEGRATION_RESOLVED_STATUSES, captureIntegrationTargetState: (...args) => captureIntegrationTargetState(...args), closeDb, decryptIntegrationJournalBytes, durableFileMode, encryptIntegrationJournalBytes, ensureParentDir, exactIntegrationFileSnapshot, gitIndexPathSnapshot: (...args) => gitIndexPathSnapshot(...args), integrationContentMismatches, integrationWorktreeRules, logEvent, openLockDb, removeRollbackLeaf, replaceRollbackLeaf, runGitReadOnlyCommand, safeRollbackParent, stateCapacityError: (...args) => stateCapacityError(...args), truncateText });

const BRIDGE_PROCESS_STARTED_AT = new Date().toISOString();

// Pins reach a bridge through its client's environment at launch. After
// `release-activate.js --sync-clients` re-pins the client config files, a bridge that is still
// running keeps the old pin and rejects every job with a bare hash mismatch that reads like a
// broken install. When the current hash is already pinned in a client config file, the process
// is only stale: say so.
async function staleBridgeProcessHint(currentSha256) {
  const configFiles = [
    path.join(homedir(), ".claude.json"),
    path.join(homedir(), ".codex", "config.toml"),
  ];
  for (const file of configFiles) {
    try {
      if ((await readFile(file, "utf8")).includes(currentSha256)) {
        return ` The client config ${file} already pins ${currentSha256}: this bridge process (started ${BRIDGE_PROCESS_STARTED_AT}) is older than the current install. Restart the client (a new Claude Code session, or restart Codex) so it launches a bridge with the current pins.`;
      }
    } catch {
      // A missing or unreadable client config gives no hint.
    }
  }
  return "";
}

// A client keeps its bridge process alive across a deploy (closing the window, or Codex keeping
// idle bridges, does not end it), so a restart that did not happen looked exactly like one that
// did: status printed the startup hash and "healthy" while the process ran the old code, and the
// synced runtime profiles no longer matched that code's rules. Compare against the file on disk.
async function bridgeSourceFreshness(serverPath = BRIDGE_SERVER_PATH, startupSha256 = BRIDGE_SOURCE_SHA256) {
  try {
    const onDiskSha256 = createHash("sha256").update(await readFile(serverPath)).digest("hex");
    return { startedAt: BRIDGE_PROCESS_STARTED_AT, startupSha256, onDiskSha256, stale: onDiskSha256 !== startupSha256, error: "" };
  } catch (error) {
    return { startedAt: BRIDGE_PROCESS_STARTED_AT, startupSha256, onDiskSha256: "", stale: false, error: error?.message || String(error) };
  }
}

function bridgeSourceFreshnessLines(freshness) {
  if (freshness.error) return [`Bridge source on disk: unreadable (${freshness.error})`];
  if (!freshness.stale) return ["Bridge source on disk: same as at startup"];
  return [
    `Bridge source on disk: ${freshness.onDiskSha256} (differs from startup)`,
    `Warning: server.js changed after this bridge process started (${freshness.startedAt}); this process still runs the old code. Restart the client that launched it (quit Claude fully, not just the window, or start a new Claude Code session; restart Codex) so it launches the current bridge.`,
  ];
}

function truncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

// A queued job's result text is the bridge preamble followed by the agent's final report, and
// the report's end (open doubts, DEPENDENCY_REQUIRED) is what the coordinator needs most, so a
// head-only cut lost exactly that. Keep the start and the longer end, and say what was dropped.
function truncateResultText(value, limit = CONFIG.queueResultMaxChars) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  // The output stays within the limit, so truncating a stored result again is a no-op.
  const marker = `\n... [${text.length} characters in total; the middle was truncated] ...\n`;
  const head = Math.floor(Math.max(0, limit - marker.length) * 0.3);
  const tail = Math.max(0, limit - marker.length - head);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(text.length - tail) : ""}`;
}

const { isBridgeGeneratedWorktree, generatedWorktreeRootForCwd, filterGeneratedWorktreeFiles, resolveWorktreeRoot, shouldUseWorktree, makeWorktreeBranchName, inspectSourceCheckpointState, dirtyCheckpointDetails, reconcileWorktreeArtifactRegistry, reserveWorktreeArtifact, markWorktreeArtifactState, releaseFailedWorktreeReservation, measureRetainedWorktreeBytes, updateRetainedWorktreeMeasurement, createWorktreeForJob, collectWorktreeDiff, cleanupWorktree, cleanupWorktreeUntimed, formatWorktreeSummary, RETAINED_WORKTREE_STATUSES, worktreeTestHooks } = createWorktreeRuntime({
  CONFIG,
  effectiveBridgeStateDirectory,
  projectStateKey,
  safeNamePart,
  runCommand,
  buildValidationEnv,
  openLockDb,
  closeDb,
  logEvent,
  stateCapacityError: (...args) => stateCapacityError(...args),
  inspectRepositoryGitControlSurface,
  inspectRepositoryOperationState,
  createPatchFromWorkingTree: (...args) => createPatchFromWorkingTree(...args),
  truncateText,
  integrationTimed: (...args) => integrationTimed(...args),
});

const { markUntrackedFilesForDiff, forceAddedIgnoredSourceFiles, ignoredIntegrationSourceFiles, streamGitReadOnlyOutputSha256, captureGitIndexIdentity, seedIndexFromRealIndex, createPatchFromWorkingTree, collectIntegrationPatch, collectIntegrationPatchUntimed, INTEGRATION_BATCH_MAX_ITEMS, INTEGRATION_BATCH_COLLECT_CONCURRENCY, collectIntegrationBatchPatch, writeTemporaryPatchFile, checkPatchApplies, applyPatchFile, applyPatchFileUntimed, simulateIntegrationPatchSnapshot, simulateIntegrationPatchSnapshotUntimed, gitIndexPathSnapshot, isolatedIndexPreservationEvidence, integrationTimingStorage, integrationTimed, INTEGRATION_PHASE_LABELS, formatIntegrationTimings, captureIntegrationTargetState, captureIntegrationTargetStateUntimed, GIT_OBJECT_ID_PATTERN, integrationHeadEntries, capturePatchedPathsState, integrationTargetMovementEvidence, formatIntegrationTargetMove, readOnlyHeadMove, formatReadOnlyHeadMove, captureGitHead } = createIntegrationPatchRuntime({ CONFIG, buildTrustedGitEnv, buildValidationEnv, changedFileValidationErrorType, exactIntegrationFileSnapshot, execFileAsync, expandIgnoredDirectoryEntries, gitChangedFileSnapshotParts, gitEolRecordsFromOutput, ignoredEntryIsRegenerable, inspectRepositoryGitControlSurface, integrationWorktreeRules, logEvent, nowMs, removeRollbackLeaf, runCommand, runGitReadOnlyCommand, safeRollbackParent, snapshotIdentitySha256, snapshotMismatches, splitNulSeparated, transientGitIndexReadError, trustedGitArgs, validateChangedFilesForPlan });

const { sweepIntegrationPreviews, ensureIntegrationPreviewSweepTimer, integrationPreviewKeyPromise, integrationPreviewKey, claimIntegrationPreviewReceipt, makeIntegrationPreviewReceipt, integrationPreviewReceiptError } = createIntegrationPreviewRuntime({ CONFIG, INTEGRATION_PREVIEWS, INTEGRATION_PREVIEW_TTL_MS, closeDb, integrationTargetMovementEvidence, openLockDb, queueRequestKey });

const { integratePatchSerially, recoverIntegrationRepositorySerially, INTEGRATION_QUARANTINE_RESOLUTION_MODES, verifyQuarantinedOperationRestored, integrationQuarantineOperator, resolveIntegrationQuarantine, formatIntegrationQuarantineResolution } = createIntegrationSerialRuntime({ CONFIG, DEFAULT_LOCK_TTL_MS, INTEGRATION_RECOVERY_BLOCKED_ROOTS, INTEGRATION_RESOLVED_STATUSES, abortSignalErrorType, acquireHardLock: (...args) => acquireHardLock(...args), cleanupIntegratedBatchWorktreesWhileLocked: (...args) => cleanupIntegratedBatchWorktreesWhileLocked(...args), cleanupIntegratedWorktreeWhileLocked: (...args) => cleanupIntegratedWorktreeWhileLocked(...args), closeDb, conflictPathsFromConflict, exactIntegrationFileSnapshot, integratePatchWithoutSerialLock: (...args) => integratePatchWithoutSerialLock(...args), integrationJournalDiagnosis, integrationRecoveryBaseline, integrationRecoveryErrorText, logEvent, openLockDb, readIntegrationJournalFileEvidence, readIntegrationOperationSummary, recoverIntegrationOperationsWhileLocked, releaseHardLock: (...args) => releaseHardLock(...args), runCommand, startHardLockHeartbeat: (...args) => startHardLockHeartbeat(...args), transitionIntegrationOperation, truncateText });

const { integratePatchWithoutSerialLock, integrationCleanupTargetStateError, cleanupIntegratedWorktreeWhileLocked, cleanupIntegratedBatchWorktreesWhileLocked, recordChangedFiles, getIntegrationScratchCleanupTestHook, setIntegrationScratchCleanupTestHook } = createIntegrationApplyRuntime({ CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, abortSignalErrorType, applyPatchFile, captureGitHead, captureGitIndexIdentity, captureIntegrationTargetState, capturePatchedPathsState, captureRollbackBaseline, changedFileValidationErrorType, changedFilesBetween, changedPathSetEvidence, checkPatchApplies, cleanupWorktree, closeDb, collectIntegrationBatchPatch, collectIntegrationPatch, exactIntegrationFileSnapshot, filterGeneratedWorktreeFiles, gitChangedFileSnapshot, gitChangedFiles, gitIndexPathSnapshot, inspectRepositoryOperationState, integrationContentMismatches, integrationPreviewReceiptError, integrationRecoveryErrorText, isolatedIndexPreservationEvidence, loadProjectAgentPolicy, logEvent, makeIntegrationPreviewReceipt, openLockDb, prepareIntegrationOperation, quarantineIntegrationOperation, recoverIntegrationOperationsWhileLocked, rollbackVerifiedOwnedChanges, runCommand, runValidationGate, simulateIntegrationPatchSnapshot, snapshotMismatches, transitionIntegrationOperation, validateChangedFilesForPlan, writeTemporaryPatchFile });

const { lockPaths, conflictsWithActiveLock, makeLockId, makeLockToken, lockTableHasCompositePrimaryKey, ensureLockTableSchema, migrateLegacyLockTable, rowsToLocks, expireLocksFromDb, listLocksFromDb, cleanupExpiredLocks, listLocks, acquireHardLock, releaseHardLock, quarantineHardLock, formatLockExpiry, formatAgentLockList, reservedLockAgentError, hardLockPathsForPlan, hardLockTtlForPlan, lockOwnershipLossError, startHardLockHeartbeat, hardLockSummary } = createLockRuntime({
  CONFIG,
  DEFAULT_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  PARALLEL_LOCK_TYPES,
  INTEGRATION_RECOVERY_BLOCKED_ROOTS,
  INTEGRATION_RESOLVED_SQL,
  ensureTableColumn,
  openLockDb,
  closeDb,
  resolveProjectStateRoot,
  reclaimLockQuarantinesForRoot,
  logEvent,
  timeoutForAgent,
});





const statePruneTimes = new Map();

const { reconcileStaleQueueRecords, processIsAlive, renewPersistedQueueRecordLease, QUEUE_PRE_EXECUTION_STATUSES, reacquirePersistedQueueRecordLease, queueOwnershipLossError, clearQueueLeaseFence, loseQueueOwnership, resetQueueLeaseFence, noteQueueLeaseRenewalFailure, assertQueueRecordDurableOwnership, renewQueueRecordDurableOwnership, heartbeatKnownQueueState, ensureQueueHeartbeatTimer, pruneInMemoryState, sqliteUsedBytes, stateCapacityError, prunePersistedState, maintainKnownStateDatabases, ensureStateMaintenanceTimer } = createQueueLeaseRuntime({ BRIDGE_INSTANCE_ID, CONFIG, KNOWN_STATE_DB_PATHS, PIPELINE_RUNS, QUEUE_JOBS, closeDb, effectiveQueueMode, expireLocksFromDb, logEvent, openLockDb, propagatePipelineTerminalInTransaction, scheduleQueueRetryPolicy: (...args) => scheduleQueueRetryPolicy(...args), stateDbPath, statePruneTimes });


async function normalizeJobCwd(job) {
  if (job?.sanitizedWorkspace?.root) {
    return {
      ...job,
      cwd: path.resolve(job.sanitizedWorkspace.root),
    };
  }
  return {
    ...job,
    cwd: await resolveProjectStateRoot(job?.cwd || process.cwd()),
  };
}










async function migrateLegacyEncryptedState(db, dbPath) {
  const legacyJobs = db.prepare(`
    SELECT job_id, revision, record_json FROM opencode_jobs
    WHERE result_encrypted IS NULL OR result_encrypted = ''
  `).all();
  const legacyPipelines = db.prepare(`
    SELECT pipeline_id, revision, record_json FROM opencode_pipelines
    WHERE details_encrypted IS NULL OR details_encrypted = ''
  `).all();
  if (!legacyJobs.length && !legacyPipelines.length) return false;

  const preparedJobs = [];
  for (const row of legacyJobs) {
    let snapshot = {};
    try { snapshot = JSON.parse(row.record_json || "{}"); } catch { snapshot = {}; }
    snapshot.jobId = snapshot.jobId || row.job_id;
    preparedJobs.push({
      ...row,
      recordJson: JSON.stringify(queueRecordDurableSummary(snapshot)),
      encrypted: await encryptQueuePrivateDetails(snapshot),
    });
  }
  const preparedPipelines = [];
  for (const row of legacyPipelines) {
    let snapshot = {};
    try { snapshot = JSON.parse(row.record_json || "{}"); } catch { snapshot = {}; }
    snapshot.pipelineId = snapshot.pipelineId || row.pipeline_id;
    preparedPipelines.push({
      ...row,
      recordJson: JSON.stringify(pipelineRecordDurableSummary(snapshot)),
      encrypted: await encryptPipelinePrivateDetails(snapshot),
    });
  }

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const updateJob = db.prepare(`
      UPDATE opencode_jobs SET record_json = ?, result_encrypted = ?
      WHERE job_id = ? AND revision = ? AND (result_encrypted IS NULL OR result_encrypted = '')
    `);
    for (const row of preparedJobs) updateJob.run(row.recordJson, row.encrypted, row.job_id, Number(row.revision || 0));
    const updatePipeline = db.prepare(`
      UPDATE opencode_pipelines SET record_json = ?, details_encrypted = ?
      WHERE pipeline_id = ? AND revision = ? AND (details_encrypted IS NULL OR details_encrypted = '')
    `);
    for (const row of preparedPipelines) {
      updatePipeline.run(row.recordJson, row.encrypted, row.pipeline_id, Number(row.revision || 0));
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
    }
    throw error;
  }

  const remaining = Number(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM opencode_jobs WHERE result_encrypted IS NULL OR result_encrypted = '') +
      (SELECT COUNT(*) FROM opencode_pipelines WHERE details_encrypted IS NULL OR details_encrypted = '') AS count
  `).get()?.count || 0);
  if (remaining === 0 && !PRIVATE_STATE_VACUUMED_DB_PATHS.has(dbPath)) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("VACUUM;");
    PRIVATE_STATE_VACUUMED_DB_PATHS.add(dbPath);
  }
  return true;
}



function directRunAuditStore() {
  return createDirectRunAudit({
    openDb: openLockDb,
    closeDb,
    resolveProjectRoot: resolveProjectStateRoot,
    redact: redactSensitiveText,
    retentionDays: CONFIG.auditRetentionDays,
    instanceId: BRIDGE_INSTANCE_ID,
    processId: process.pid,
    // L-025: a run's result text is kept like a queue job's, encrypted with the queue's key and
    // bound to the run id, and capped by the same setting.
    sealText: (text, runId) => encryptIntegrationJournalBytes(Buffer.from(text, "utf8"), `direct-run-result\0${runId}`),
    openText: async (sealed, runId) => (await decryptIntegrationJournalBytes(sealed, `direct-run-result\0${runId}`)).toString("utf8"),
    maxResultChars: CONFIG.queueResultMaxChars,
  });
}

















function abortSignalErrorType(signal, fallback = "agent_cancelled") {
  return signal?.aborted && typeof signal.reason?.errorType === "string"
    ? signal.reason.errorType
    : fallback;
}

function combineAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}



function validateDelegationPlanInputs(jobs) {
  if (!Array.isArray(jobs) || jobs.length < 1) {
    return {
      error: "At least one delegation job is required.",
      lockPlans: [],
      conflictingPaths: [],
      executionMode: "none",
    };
  }

  if (jobs.length === 1) {
    const { error, errorType, suggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(jobs[0]);
    return {
      error,
      errorType,
      suggestedFix,
      lockPlans: [lockPlan],
      conflictingPaths: [],
      serialOnlyMatches,
      executionMode: "single",
    };
  }

  const { error, errorType, suggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
  return {
    error,
    errorType,
    suggestedFix,
    lockPlans,
    conflictingPaths,
    serialOnlyMatches,
    executionMode: "parallel",
  };
}

async function findActiveLockConflict(lockPlans) {
  for (const plan of lockPlans) {
    if (plan.lockType === "read") {
      continue;
    }

    const active = await listLocks(plan.cwd);
    const conflict = active
      .map((lock) =>
        conflictsWithActiveLock(
          {
            lockType: plan.lockType,
            paths: hardLockPathsForPlan(plan),
          },
          lock
        )
      )
      .find(Boolean);

    if (conflict) {
      return { plan, conflict };
    }
  }

  return null;
}

function formatDelegationPlanJob({ index, job, lockPlan, resolution }) {
  const timeoutMs = timeoutForAgent(resolution?.actualAgent || lockPlan.agent, lockPlan, lockPlan.timeoutMs);
  const modelOverride = allowlistedModelOverride(lockPlan.scopeContract?.modelRequirement, resolution?.actualAgent || lockPlan.agent);
  const effectiveMetadata = applyModelOverrideToMetadata(resolution?.agentMetadata || null, modelOverride);
  return [
    `JOB ${index + 1}`,
    `Requested agent: ${resolution?.requestedAgent || lockPlan.agent}`,
    `Requested agent mode: ${resolution?.requestedAgentMode || "unknown"}`,
    ...(lockPlan.scopeContract?.modelRequirement ? [
      `Required provider: ${lockPlan.scopeContract.modelRequirement.provider}`,
      `Required model: ${lockPlan.scopeContract.modelRequirement.model}`,
      `Required variant: ${lockPlan.scopeContract.modelRequirement.variant || "not specified"}`,
      `Runtime model evidence required: ${lockPlan.scopeContract.modelRequirement.requireRuntimeEvidence ? "yes" : "no"}`,
    ] : []),
    `Actual agent: ${resolution?.actualAgent || "none"}`,
    `Actual agent mode: ${resolution?.actualAgentMode || resolution?.requestedAgentMode || "unknown"}`,
    `Fallback used: ${resolution?.fallbackUsed ? "yes" : "no"}`,
    resolution?.fallbackReason ? `Fallback reason: ${resolution.fallbackReason}` : null,
    `Subagent proxy used: ${resolution?.proxyUsed ? "yes" : "no"}`,
    `Subagent strategy: ${resolution?.subagentStrategy || job.subagentStrategy || "reject"}`,
    resolution?.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Configured provider: ${resolution?.agentMetadata?.provider || "unknown"}`,
    `Configured model: ${resolution?.agentMetadata?.model || "unknown"}`,
    `Configured variant: ${resolution?.agentMetadata?.variant || "unknown"}`,
    `Model selection: ${modelOverride ? `operator_allowlist_override (${modelOverride.provider}/${modelOverride.model}${modelOverride.variant ? `, variant ${modelOverride.variant}` : ""})` : "managed_profile"}`,
    "Silent model fallback: disabled",
    `Effective edit permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canEdit ? "enabled" : "denied") : "unattested"}`,
    `Effective task permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canDelegate ? "enabled" : "denied") : "unattested"}`,
    `Effective external-directory permission denied: ${resolution?.agentMetadata?.externalDirectoryDenied ? "yes" : "no/unattested"}`,
    `Would run: ${resolution?.actualAgent ? commandShape(resolution.actualAgent, effectiveMetadata) : "no"}`,
    "Would acquire consistency lock: yes (shared for reads, exclusive for writes/integration)",
    `Lock mode: ${lockPlan.lockMode}${lockPlan.requestedLockMode ? ` (requested ${lockPlan.requestedLockMode}; parallel writers always use ${lockPlan.lockMode})` : ""}`,
    `Lock type: ${lockPlan.lockType}`,
    lockPlan.orchestratorMode ? `Orchestrator mode: ${lockPlan.orchestratorMode}` : null,
    lockPlan.orchestratorMode === "contractor" ? `User-authorized contractor: ${lockPlan.userAuthorizedOrchestrator ? "yes" : "no"}` : null,
    `Timeout ms: ${timeoutMs}`,
    `Lock granted: ${lockPlan.lockedPaths.length ? lockPlan.lockedPaths.join(", ") : "not specified"}`,
    `Allowed edits: ${lockPlan.allowedEdits.length ? lockPlan.allowedEdits.join(", ") : "none"}`,
    `Forbidden edits: ${lockPlan.forbiddenEdits.length ? lockPlan.forbiddenEdits.join(", ") : "none specified"}`,
    `Shared files frozen: ${lockPlan.sharedFiles.length ? lockPlan.sharedFiles.join(", ") : "none specified"}`,
    `Validation command: ${lockPlan.validationCommand || "not specified"}`,
  ].filter(Boolean).join("\n");
}

server.tool(
  "acquire_agent_lock",
  "Acquire a temporary file/path lock for exceptional delegated-agent coordination.",
  {
    owner: z.string().optional().describe("Lock owner, usually Codex."),
    agent: z.string().optional().describe("Agent receiving the lock."),
    task: z.string().optional().describe("Short task description."),
    cwd: z.string().min(1).describe("Canonical repository path."),
    lockType: z.enum(["read", "write", "serial_integration"]).optional(),
    paths: z.array(z.string()).min(1).describe("Concrete files or directories to lock."),
    ttlMs: z.number().int().positive().max(MAX_LOCK_TTL_MS).optional().describe("Lease duration in milliseconds. Defaults to 30 minutes; at most 24 hours."),
  },
  async ({ owner = "codex", agent = "opencode", task = "", cwd = "", lockType = "write", paths, ttlMs = DEFAULT_LOCK_TTL_MS }) => {
    const reservedAgentError = reservedLockAgentError(agent) || reservedLockAgentError(owner);
    const result = reservedAgentError
      ? { ok: false, error: reservedAgentError }
      : await acquireHardLock({ owner, agent, origin: "manual", task, cwd, lockType, paths, ttlMs });
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                "Temporary lock acquired.",
                "",
                `Lock id: ${result.lock.id}`,
                `Release token: ${result.lock.token}`,
                `Owner: ${result.lock.owner}`,
                `Agent: ${result.lock.agent}`,
                `Type: ${result.lock.lockType}`,
                `Paths: ${result.lock.paths.join(", ")}`,
                `Expires at: ${formatLockExpiry(result.lock.expiresAt)}`,
              ].join("\n")
            : [
                "Temporary lock rejected.",
                "",
                result.error,
                result.conflict ? `Conflict: ${JSON.stringify(result.conflict, null, 2)}` : "",
              ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "release_agent_lock",
  "Release a temporary agent lock by id.",
  {
    lockId: z.string().describe("Lock id returned by acquire_agent_lock or an OpenCode run result."),
    token: z.string().optional().describe("Release token returned by acquire_agent_lock."),
    cwd: z.string().min(1).describe("Canonical repository path for the lock registry."),
  },
  async ({ lockId, token = "", cwd = "" }) => {
    const result = await releaseHardLock(lockId, token, [], cwd);
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                result.released ? "Temporary lock released." : "No active temporary lock matched that id.",
                "",
                `Lock id: ${lockId}`,
                `Active locks remaining: ${result.activeLocks.length}`,
              ].join("\n")
            : ["Temporary lock release failed.", "", result.error].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_agent_locks",
  "List active temporary agent locks.",
  {
    cwd: z.string().min(1).describe("Canonical repository path for the lock registry."),
  },
  async ({ cwd = "" }) => {
    const locks = await listLocks(cwd);

    return {
      content: [
        {
          type: "text",
          text: formatAgentLockList(locks),
        },
      ],
    };
  }
);

server.tool(
  "verify_sanitized_workspace",
  "Verify an exact, hash-pinned sanitized workspace before or after an agent wave. This is file-level integrity, not row-level filtering or an OS sandbox.",
  {
    contract: sanitizedWorkspaceSchema,
    phase: z.enum(["manual", "before_wave", "after_wave"]).optional(),
  },
  async ({ contract, phase = "manual" }) => {
    const result = await verifySanitizedWorkspace(contract, phase);
    return {
      content: [{
        type: "text",
        text: [
          result.ok ? "Sanitized workspace verification passed." : "Sanitized workspace verification failed.",
          JSON.stringify(sanitizePersistedValue(result), null, 2),
          "Boundary note: exact file manifests do not enforce row/column filtering, archive contents, database queries, network isolation, or reads elsewhere on the host.",
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "list_opencode_agents",
  "List available OpenCode agents and subagents.",
  {
    cwd: z.string().min(1),
  },
  async ({ cwd }) => {
    const discovery = await listAvailableAgents(cwd);
    const agents = [...discovery.agents.entries()].map(([name, mode]) => ({ name, mode })).sort((left, right) => left.name.localeCompare(right.name));

    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode agents:",
            "",
            discovery.result.exitCode === 0
              ? JSON.stringify(agents, null, 2)
              : `Agent discovery failed: ${summarizeStderr(discovery.result.stderr)}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_opencode_bridge_status",
  "Check OpenCode, Git, agent discovery, and the bridge's effective safety configuration. Quick mode is the daily default; deep mode re-attests every managed role for activation and audits.",
  {
    cwd: z.string().min(1).describe("Canonical repository path used for command and agent discovery checks."),
    deep: z.boolean().optional().describe("Run slow full managed-role attestation. Defaults to false; actual agent execution always re-attests its role before spawn."),
  },
  async ({ cwd, deep = false }) => {
    if (deep) clearAttestationCache();
    const [pluginPolicy, openCodeVersion, gitVersion, agentDiscovery, safeOrchestratorMetadata, contractorOrchestratorMetadata, contractorNestedAttestation, sanitizedReaderMetadata, managedSkillEvidence, providerCapacity] = await Promise.all([
      verifyExternalPluginPolicy(cwd),
      safeOpenCodeCommand(["--version"], cwd, 1000 * 30),
      runCommand("git", ["--version"], cwd, 1000 * 30),
      listAvailableAgents(cwd),
      deep ? readAgentDebugMetadata(MCP_ORCHESTRATOR_AGENT, cwd || process.cwd()) : Promise.resolve(null),
      deep ? readAgentDebugMetadata(MCP_CONTRACTOR_ORCHESTRATOR_AGENT, cwd || process.cwd()) : Promise.resolve(null),
      deep ? attestContractorNestedAgents(cwd || process.cwd()) : Promise.resolve({ ok: true, skipped: true }),
      deep ? readAgentDebugMetadata(MCP_SANITIZED_READER_AGENT, cwd || process.cwd(), { forcePure: true }) : Promise.resolve(null),
      managedSkillSourceEvidence(),
      providerCapacitySnapshot(),
    ]);
    const sourceFreshness = await bridgeSourceFreshness();
    const queueCapacity = queueCapacityReport();
    const journal = await resolveProjectStateRoot(cwd || process.cwd())
      .then((root) => integrationJournalDiagnosis(root, { limit: 20 }))
      .catch((error) => ({ error: error?.message || String(error) }));
    if (!pluginPolicy.ok) {
      return { content: [{ type: "text", text: `OpenCode MCP bridge status: attention required.\n\nPlugin policy: rejected\nReason: ${pluginPolicy.error}` }] };
    }
    const availableAgents = availableAgentLabels(agentDiscovery.agents);
    const missingRequiredAgents = GLOBALLY_REQUIRED_MANAGED_AGENTS.filter((agent) => !agentDiscovery.agents.has(agent));
    const sanitizedReaderPolicyError = sanitizedAgentMetadataError(sanitizedReaderMetadata, path.resolve(cwd || process.cwd()));
    const safeOrchestratorPolicy = safeOrchestratorMetadata?.metadata || null;
    const safeOrchestratorEnforced = safeOrchestratorMetadata?.ok
      && safeOrchestratorPolicy?.name === MCP_ORCHESTRATOR_AGENT
      && safeOrchestratorPolicy?.canEdit === false
      && safeOrchestratorPolicy?.canDelegate === false;
    const contractorOrchestratorPolicy = contractorOrchestratorMetadata?.metadata || null;
    const contractorOrchestratorEnforced = contractorOrchestratorMetadata?.ok
      && contractorOrchestratorPolicy?.name === MCP_CONTRACTOR_ORCHESTRATOR_AGENT
      && contractorOrchestratorPolicy?.canEdit === false
      && contractorOrchestratorPolicy?.canDelegate === true
      && contractorOrchestratorPolicy?.bashDenied === true
      && contractorOrchestratorPolicy?.skillDenied === true;
    const contractorSubagentAllowlistEnforced = contractorOrchestratorPolicy?.taskDelegationAllowlistSafe === true;
    const baseHealthy = openCodeVersion.exitCode === 0
      && gitVersion.exitCode === 0
      && agentDiscovery.result.exitCode === 0
      && missingRequiredAgents.length === 0
      && managedSkillEvidence.ok
      && !sourceFreshness.stale;
    const deepHealthy = safeOrchestratorEnforced
      && contractorOrchestratorEnforced
      && contractorSubagentAllowlistEnforced
      && contractorNestedAttestation.ok
      && !sanitizedReaderPolicyError;
    const healthy = baseHealthy && (!deep || deepHealthy);

    return {
      content: [
        {
          type: "text",
          text: [
            healthy ? "OpenCode MCP bridge status: healthy." : "OpenCode MCP bridge status: attention required.",
            "",
            `OpenCode executable: ${OPENCODE_EXE}`,
            `OpenCode version: ${(openCodeVersion.stdout || openCodeVersion.stderr || "unavailable").trim()}`,
            `Bridge source SHA-256 at startup: ${BRIDGE_SOURCE_SHA256}`,
            `Bridge process started: ${BRIDGE_PROCESS_STARTED_AT}`,
            ...bridgeSourceFreshnessLines(sourceFreshness),
            `Bridge release root: ${BRIDGE_RUNTIME_DIR}`,
            `Bridge release manifest pin: ${String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "not pinned")}`,
            `Health depth: ${deep ? "deep managed-role attestation" : "quick daily check"}`,
            `Execution-time role attestation: always enabled`,
            `Node runtime: ${process.version}`,
            "Provider readiness: not tested by health (no model request sent)",
            "Project OpenCode config: disabled; use a reviewed managed profile, not the personal/project default",
            `Runtime model evidence required by operator: ${CONFIG.requireRuntimeModelEvidence ? "yes" : "no"}`,
            ...(CONFIG.requireRuntimeModelEvidence ? [
              "Warning: OpenCode 1.17.13 emits no runtime provider/model identity in `run --format json`, so every non-dry agent run will end with opencode_model_evidence_required while CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=true. Set it to false and use per-job modelRequirement.requireRuntimeEvidence when exact identity matters more than completing the run.",
            ] : []),
            `Source dirt policy: ${CONFIG.sourceDirtPolicy}`,
            `Model allowlist: ${CONFIG.modelOverrideAllowlist.length ? CONFIG.modelOverrideAllowlist.join(", ") : "none (managed profiles only)"}`,
            `OpenCode check exit code: ${openCodeVersion.exitCode}`,
            `Git version: ${(gitVersion.stdout || gitVersion.stderr || "unavailable").trim()}`,
            `Git check exit code: ${gitVersion.exitCode}`,
            `Agent directory: ${OPENCODE_AGENT_DIR}`,
            `Managed skill source directory: ${OPENCODE_SKILL_DIR}`,
            `Managed skill source file count: ${managedSkillEvidence.fileCount}`,
            `Managed skill source names: ${managedSkillEvidence.names.length ? managedSkillEvidence.names.join(", ") : "none"}`,
            `Managed skill source aggregate SHA-256: ${managedSkillEvidence.sha256 || "unavailable"}`,
            `Managed skill source error: ${managedSkillEvidence.error || "none"}`,
            `MCP orchestrator execution agent: ${MCP_ORCHESTRATOR_AGENT}`,
            `MCP orchestrator edit permission denied: ${deep ? (safeOrchestratorPolicy?.canEdit === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP orchestrator nested task permission denied: ${deep ? (safeOrchestratorPolicy?.canDelegate === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor orchestrator execution agent: ${MCP_CONTRACTOR_ORCHESTRATOR_AGENT}`,
            `MCP contractor direct edit permission denied: ${deep ? (contractorOrchestratorPolicy?.canEdit === false ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested task permission enabled: ${deep ? (contractorOrchestratorPolicy?.canDelegate === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor shell permission denied: ${deep ? (contractorOrchestratorPolicy?.bashDenied === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor skill permission denied: ${deep ? (contractorOrchestratorPolicy?.skillDenied === true ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor subagent allowlist enforced: ${deep ? (contractorSubagentAllowlistEnforced ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested agent profiles attested: ${deep ? (contractorNestedAttestation.ok ? "yes" : "no") : "not checked in quick mode"}`,
            `MCP contractor nested agent policy error: ${deep && !contractorNestedAttestation.ok ? contractorNestedAttestation.error : "none"}`,
            `MCP sanitized reader isolated policy attested: ${deep ? (sanitizedReaderPolicyError ? "no" : "yes") : "not checked in quick mode"}`,
            `MCP sanitized reader policy error: ${deep ? (sanitizedReaderPolicyError?.error || "none") : "none"}`,
            `Agent discovery exit code: ${agentDiscovery.result.exitCode}`,
            `Available agents: ${availableAgents.length ? availableAgents.join(", ") : "none discovered"}`,
            `Missing required managed agents: ${missingRequiredAgents.length ? missingRequiredAgents.join(", ") : "none"}`,
            integrationQuarantineStatusLine(journal),
            "",
            `Worktree mode: ${CONFIG.worktreeMode}`,
            `Worktree root: ${CONFIG.worktreeRoot}`,
            `Worktree cleanup: ${CONFIG.worktreeCleanup}`,
            `Queue mode: ${effectiveQueueMode()}`,
            `Queue write conflict policy: ${effectiveQueueWriteConflictPolicy()}`,
            `Queue blocked poll ms: ${CONFIG.queueBlockedPollMs}`,
            `Queue stale after ms: ${CONFIG.queueStaleAfterMs}`,
            `Deferred recovery idle max ms: ${CONFIG.deferredRecoveryIdleMaxMs}`,
            `Read lock mode: ${CONFIG.defaultReadLockMode}`,
            `Write lock mode: ${CONFIG.defaultWriteLockMode}`,
            `Parallel write lock mode: ${CONFIG.defaultParallelWriteLockMode}`,
            `Contractor orchestrator timeout ms: ${CONFIG.contractorOrchestratorTimeoutMs}`,
            `Bridge state directory: ${GLOBAL_BRIDGE_STATE_DIR}`,
            `OpenCode external plugins: ${CONFIG.allowExternalPlugins ? "enabled (exact allowlist and pinned tree verified)" : "disabled (--pure)"}`,
            `External plugin manifest SHA-256: ${pluginPolicy.manifestSha256 || "not applicable"}`,
            `Provider/account concurrency limit: ${describeConcurrencyLimits().provider}${CONFIG.providerConcurrencyKeyExplicit ? "" : " per configured provider"}`,
            `Queue parallel limit (CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT): ${queueCapacity.queueParallelLimit} job(s) at once per bridge process${queueCapacity.queueMode === "off" ? " (queue mode is off)" : ""}; ${describeConcurrencyLimits().queue}`,
            `Parallel call job limit (CODEX_OPENCODE_PARALLEL_LIMIT): ${queueCapacity.parallelCallLimit} job(s) per run_opencode_parallel call (does not bound the queue)`,
            ...(queueCapacity.warning ? [queueCapacity.warning] : []),
            ...queueMemoryStatusLines(),
            agentIdleTimeoutStatusLine(),
            `Global worker limit (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT, all providers and bridge processes): ${describeConcurrencyLimits().global}; workers running now: ${Number(providerCapacity.allLeaseCount || 0)}`,
            `Provider active leases: ${providerCapacity.leases.length}`,
            // Slots are counted per provider key; one total against one limit read as over capacity.
            ...(providerCapacity.keys || []).map((item) => `- ${item.providerKey}: ${item.leases} of ${item.capacity} slot(s) held${item.quarantined ? ` (${item.quarantined} quarantined for an unconfirmed process tree)` : ""}`),
            ...providerCapacity.leases.map((lease) => `- provider lease ${lease.leaseId} (${lease.providerKey}): pid=${lease.ownerProcessId}, ${lease.quarantined ? "quarantined" : `remainingMs=${lease.remainingMs}`}, heartbeat=${lease.heartbeatAt || "none"}`),
            `Paused providers: ${(providerCapacity.cooldowns || []).length ? "" : "none"}`,
            ...(providerCapacity.cooldowns || []).map((item) => `- ${item.providerKey}: paused until ${item.until} (${item.errorType}${item.reason ? `: ${item.reason}` : ""}); new jobs fail at once instead of starting; resume_opencode_provider ends it early`),
            `Bridge instance id: ${BRIDGE_INSTANCE_ID}`,
            "Default OpenCode orchestrator mode: planning-only",
            `Explicit user-authorized OpenCode contractor mode: ${/^[a-f0-9]{64}$/.test(effectiveContractorAuthorizationSha256()) ? "capability configured" : "disabled (capability not configured)"}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "diagnose_opencode_bridge",
  "Show correlated queue, pipeline, lock, provider-capacity, preservation, retry-safety, and recovery information for one repository.",
  {
    cwd: z.string().describe("Repository path to diagnose."),
  },
  async ({ cwd }) => {
    const projectRoot = await resolveProjectStateRoot(cwd);
    const [jobs, pipelines, locks, provider, directRunAudit, integrationOperations, retainedArtifacts] = await Promise.all([
      listPersistedQueueRecords(projectRoot),
      listPersistedPipelineRecords(projectRoot),
      listLocks(projectRoot),
      providerCapacitySnapshot(),
      directRunAuditStore().snapshot(projectRoot),
      // Queue records blocked on integration_recovery_pending point here; show the journal.
      integrationJournalDiagnosis(projectRoot, { limit: 20 }).catch((error) => ({ error: error?.message || String(error) })),
      listRetainedWorktreeArtifacts(projectRoot).catch((error) => ({ error: error?.message || String(error) })),
    ]);
    const queueJobByWorktree = new Map(jobs.filter((job) => job.worktreePath).map((job) => [path.resolve(job.worktreePath), job]));
    const runByJobId = new Map(directRunAudit.records.filter((run) => run.jobId || run.runId).map((run) => [run.jobId || run.runId, run]));
    const retainedWorktrees = Array.isArray(retainedArtifacts)
      ? retainedArtifacts.map((artifact) => retainedWorktreeView(artifact, {
        queueJob: queueJobByWorktree.get(path.resolve(artifact.worktreePath)) || null,
        run: runByJobId.get(artifact.jobId) || null,
      }))
      : retainedArtifacts;
    const nonterminal = jobs.filter((job) => !["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    const failed = jobs.filter((job) => ["failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    // The report goes into the caller's context. After a long run it listed every audit row
    // and job (up to thousands); summary counts stay complete, detail keeps every unfinished
    // item plus the most recent ones.
    const DIAGNOSE_DETAIL_LIMIT = 25;
    const newestFirst = (list, key) => [...list].sort((left, right) => String(right[key] || "").localeCompare(String(left[key] || "")));
    const unfinishedJobs = new Set(nonterminal.map((job) => job.jobId));
    const detailJobs = [...nonterminal, ...newestFirst(jobs.filter((job) => !unfinishedJobs.has(job.jobId)), "createdAt").slice(0, DIAGNOSE_DETAIL_LIMIT)];
    const detailDirectRuns = [
      ...directRunAudit.records.filter((run) => run.status === "started"),
      ...newestFirst(directRunAudit.records.filter((run) => run.status !== "started"), "startedAt").slice(0, DIAGNOSE_DETAIL_LIMIT),
    ];
    // Pipelines follow the same rule (R-138): every unfinished one plus the newest finished ones.
    const pipelineFinished = (pipeline) => ["completed", "failed", "cancelled"].includes(pipeline.status);
    let finishedPipelinesShown = 0;
    const detailPipelines = newestFirst(pipelines, "createdAt")
      .filter((pipeline) => !pipelineFinished(pipeline) || (finishedPipelinesShown += 1) <= DIAGNOSE_DETAIL_LIMIT);
    const queueCapacity = queueCapacityReport();
    const memoryGate = queueMemoryGate();
    const report = {
      generatedAt: new Date().toISOString(),
      cwd: projectRoot,
      bridgeProcess: await bridgeSourceFreshness(),
      summary: {
        jobs: jobs.length,
        nonterminalJobs: nonterminal.length,
        failedJobs: failed.length,
        directRuns: directRunAudit.records.length,
        failedDirectRuns: directRunAudit.records.filter((run) => ["failed", "rejected", "abandoned"].includes(run.status)).length,
        unfinishedDirectRuns: directRunAudit.records.filter((run) => run.status === "started").length,
        pipelines: pipelines.length,
        nonterminalPipelines: pipelines.filter((item) => !pipelineFinished(item)).length,
        locks: locks.length,
        unresolvedIntegrationOperations: integrationOperations.unresolvedCount ?? "unavailable",
        retainedWorktrees: Array.isArray(retainedWorktrees) ? retainedWorktrees.filter((item) => item.present && !item.inFlight).length : "unavailable",
        inFlightWorktrees: Array.isArray(retainedWorktrees) ? retainedWorktrees.filter((item) => item.present && item.inFlight).length : "unavailable",
        providerCapacity: provider.capacity,
        providerSlotsByKey: (provider.keys || []).map((item) => `${item.providerKey}=${item.leases}/${item.capacity}`),
        providerActiveLeases: provider.leases.length,
        // B-042: the queue cap that decides how many of those slots a bridge process can fill.
        queueParallelLimit: queueCapacity.queueParallelLimit,
        parallelCallLimit: queueCapacity.parallelCallLimit,
        providerConcurrencyLimit: queueCapacity.providerConcurrencyLimit,
        ...(queueCapacity.warning ? { queueCapacityWarning: queueCapacity.warning } : {}),
        // B-045: the free-memory floor for starting queue jobs (0 = disabled) and what the machine has now.
        minFreeMemoryMb: memoryGate.floorMb,
        freeMemoryMb: memoryGate.freeMb,
        queueJobsHeldForMemory: memoryGate.blocked ? queueMemoryWaitingJobs.size : 0,
      },
      directRuns: detailDirectRuns,
      diagnosticCoverage: {
        jobs: "queued_jobs_only",
        directRuns: directRunAudit.coverage,
        retainedWorktrees: "every bridge-created worktree still registered (queued, direct and parallel jobs); owner says which",
        detail: `every unfinished item plus the ${DIAGNOSE_DETAIL_LIMIT} most recent finished jobs, direct runs and pipelines; counts in summary cover all`,
      },
      jobs: detailJobs.map((job) => diagnoseJobView(job)),
      retainedWorktrees,
      pipelines: detailPipelines.map((pipeline) => ({
        pipelineId: pipeline.pipelineId,
        status: pipeline.status,
        ownerInstanceId: pipeline.ownerInstanceId || "",
        ownerLeaseExpiresAt: pipeline.ownerLeaseExpiresAt || "",
        recoverableByThisInstance: pipelineOwnedByThisInstance(pipeline) || Date.parse(pipeline.ownerLeaseExpiresAt || "") <= Date.now(),
        pendingIntegrations: (pipeline.integrationQueue || []).filter((item) => item.status === "pending").length,
        errors: pipeline.errors || [],
      })),
      locks: locks.map((lock) => ({ ...lock, expires: formatLockExpiry(lock.expiresAt) })),
      integrationOperations,
      provider,
    };
    return { content: [{ type: "text", text: JSON.stringify(sanitizePersistedValue(report), null, 2) }] };
  }
);

server.tool(
  "validate_delegation_plan",
  "Preflight a single or parallel OpenCode delegation plan without running OpenCode agents or acquiring locks.",
  { jobs: z.array(z.object(jobInputShape)).min(1) },
  async ({ jobs }) => {
    jobs = await Promise.all(jobs.map((job) => normalizeJobCwd(job)));
    const toolStarted = nowMs();
    const { error: planError, errorType: planErrorType, suggestedFix: planSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [], executionMode } = validateDelegationPlanInputs(jobs);
    const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "unknown";
    const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";

    if (planError) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: planErrorType || (executionMode === "parallel" ? "parallel_plan_rejected" : "lock_plan_rejected"),
              reason: planError,
              requestedAgent: requestedAgents,
              actualAgent: "none",
              lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths,
              serialOnlyMatches,
              suggestedFix: planSuggestedFix || "Adjust agents, lockMode, lockedPaths, allowedEdits, or split overlapping write work into serial steps.",
            }),
          },
        ],
      };
    }

    const sanitizedPlanPreflight = await verifySanitizedJobsBeforeDiscovery(jobs, "delegation_plan_preflight_before_discovery");
    if (!sanitizedPlanPreflight.ok) {
      const index = sanitizedPlanPreflight.index;
      const verification = sanitizedPlanPreflight.verification;
      return {
        content: [{
          type: "text",
          text: formatRejectedExecution({
            headline: "Delegation plan sanitized-workspace preflight rejected before OpenCode discovery.",
            errorType: verification.errorType,
            reason: verification.error,
            requestedAgent: lockPlans[index]?.agent || jobs[index]?.agent || "unknown",
            actualAgent: "none",
            lockMode: lockPlans[index]?.lockMode || "off",
            durationMs: nowMs() - toolStarted,
            conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Rebuild the exact sanitized workspace from its trusted manifest before retrying the delegation preflight.",
          }),
        }],
      };
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const readiness = await verifyJobWorkspaceReadiness(jobs[index], lockPlans[index]);
      if (!readiness.ok) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Delegation plan workspace preflight rejected before OpenCode discovery.",
          errorType: readiness.errorType,
          reason: readiness.error,
          requestedAgent: lockPlans[index].agent,
          actualAgent: "none",
          lockMode: lockPlans[index].lockMode,
          durationMs: nowMs() - toolStarted,
          ...dirtyCheckpointDetails(readiness),
          suggestedFix: readiness.suggestedFix,
        }) }] };
      }
    }

    const activeConflict = await findActiveLockConflict(lockPlans);
    if (activeConflict) {
      const conflictPaths = conflictPathsFromConflict(activeConflict.conflict);
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: "write_lock_conflict",
              reason: `Write lock conflict on: ${conflictPaths[0] || "unknown"}`,
              requestedAgent: activeConflict.plan.agent,
              actualAgent: "none",
              lockMode: activeConflict.plan.lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths: conflictPaths,
              suggestedFix: "Wait for the active lock to expire, release it if it is stale, or choose a non-overlapping lockedPaths scope.",
            }),
          },
        ],
      };
    }

    const queueAssessment = await assessQueuePlan(lockPlans);
    const plannedJobs = [];
    const plannedResolutions = [];
    const plannedMetadata = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const validationPreflight = await validationCommandPreflightError(lockPlan.validationCommand, { sanitized: Boolean(job.sanitizedWorkspace) });
      if (validationPreflight) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
                errorType: validationPreflight.errorType,
                reason: `JOB ${index + 1} validation command cannot run: ${validationPreflight.error}`,
                requestedAgent: job.agent,
                actualAgent: "none",
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: VALIDATION_PREFLIGHT_FIX,
              }),
            },
          ],
        };
      }
      const discoveryContext = sanitizedDiscoveryContext(job);
      const resolution = await jobAgentRuntime().resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "reject",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT,
        lockPlan.orchestratorMode,
        discoveryContext
      );

      if (resolution.error) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
                errorType: "agent_routing_error",
                reason: resolution.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: "none",
                fallback: resolution.fallbackUsed,
                fallbackReason: resolution.fallbackReason,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
              }),
            },
          ],
        };
      }

      const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
      if (routingPolicyError) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
                errorType: routingPolicyError.errorType,
                reason: routingPolicyError.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: routingPolicyError.suggestedFix,
              }),
            },
          ],
        };
      }

      const metadata = await jobAgentRuntime().readAgentDebugMetadata(
        resolution.actualAgent,
        discoveryContext.discoveryCwd,
        { forcePure: discoveryContext.forcePure }
      );
      const metadataPolicyError = effectiveReadOnlyMetadataError(metadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
      const contractorNestedAttestation = lockPlan.orchestratorMode === "contractor"
        ? await attestContractorNestedAgents(discoveryContext.discoveryCwd, { forcePure: discoveryContext.forcePure })
        : { ok: true };
      const contractorNestedError = contractorNestedAttestation.ok ? null : contractorNestedAttestation;
      const sanitizedMetadataError = job.sanitizedWorkspace ? sanitizedAgentMetadataError(metadata, job.sanitizedWorkspace.root) : null;
      const sanitizedRoutingError = sanitizedRoutingPolicyError(job, resolution, discoveryContext.discoveryCwd);
      if (metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError) {
        const policyError = metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError;
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Delegation plan effective agent policy rejected.",
          errorType: policyError.errorType,
          reason: policyError.error,
          requestedAgent: resolution.requestedAgent,
          actualAgent: resolution.actualAgent,
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: "Use a directly runnable role whose effective OpenCode debug policy matches the requested contract.",
        }) }] };
      }
      resolution.agentMetadata = metadata.metadata || null;
      plannedResolutions[index] = resolution;
      plannedMetadata[index] = metadata;

      plannedJobs.push(formatDelegationPlanJob({ index, job, lockPlan, resolution }));
    }

    // run_opencode_parallel rejects a batch above the per-provider slot limit; the preflight
    // must not accept what the run would refuse.
    if (executionMode === "parallel") await refreshRuntimeConcurrency();
    const capacityError = executionMode === "parallel"
      ? parallelBatchCapacityError(jobs, parallelProviderKeys(plannedResolutions, plannedMetadata, lockPlans))
      : null;
    if (capacityError) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Delegation plan rejected.",
        errorType: capacityError.errorType,
        reason: capacityError.error,
        requestedAgent: requestedAgents,
        actualAgent: "none",
        lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: capacityError.suggestedFix,
      }) }] };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "Delegation plan accepted.",
            "",
            `Execution mode: ${executionMode}`,
            `Jobs: ${jobs.length}`,
            `Queue status: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
            `Queue conflicting paths: ${queueAssessment.conflictingPaths.length ? queueAssessment.conflictingPaths.join(", ") : "none"}`,
            "OpenCode agents will not run during this preflight.",
            "Temporary locks were not acquired.",
            "",
            ...plannedJobs,
          ].join("\n\n"),
        },
      ],
    };
  }
);

server.tool(
  "run_opencode_agent",
  "Run one OpenCode agent/subagent with a task prompt.",
  jobInputShape,
  async ({
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "reject",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    orchestratorMode,
    userAuthorizedOrchestrator,
    contractorAuthorizationToken,
    role,
    mode,
    scope,
    actions,
    validation: scopeValidation,
    timeoutPolicy,
    scopeContract,
    sanitizedWorkspace,
    dryRun = false,
    write,
    lockType,
    lockMode,
    timeoutMs,
    lockedPaths,
    ownedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    validationCommand,
    validationFixPasses,
    selfCheckPasses,
    delegation,
    models,
    maxAttempts,
    autoIntegrate,
  }) => {
    const toolStarted = nowMs();
    const queueOnly = queueOnlyOptionsError({ models, maxAttempts, autoIntegrate });
    if (queueOnly) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Execution rejected.",
        errorType: queueOnly.errorType,
        reason: queueOnly.error,
        requestedAgent: agent,
        actualAgent: "none",
        suggestedFix: queueOnly.suggestedFix,
      }) }] };
    }
    const requestedJob = {
      agent,
      task,
      cwd,
      // executeOpenCodeJob routes with these; dropping them made its own advice to set
      // allowFallbackToBuild impossible to follow.
      allowFallbackToBuild,
      subagentStrategy,
      proxyAgent,
      dryRun,
      orchestratorMode,
      userAuthorizedOrchestrator,
      contractorAuthorizationToken,
      role,
      mode,
      scope,
      actions,
      validation: scopeValidation,
      timeoutPolicy,
      scopeContract,
      sanitizedWorkspace,
      write,
      lockMode,
      lockType,
      timeoutMs,
      lockedPaths,
      ownedPaths,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      validationFixPasses,
      selfCheckPasses,
      delegation,
    };
    const directRunId = makeQueueJobId(agent);
    return directRunAuditStore().run(requestedJob, async ({ onChildSpawn }) =>
      executeOpenCodeJob(await normalizeJobCwd(requestedJob), { toolStarted, onChildSpawn, jobId: directRunId })
    , { runId: directRunId, kind: "direct", jobId: directRunId });
  }
);

server.tool(
  "enqueue_opencode_job",
  "Enqueue one OpenCode job for MCP-managed scheduling. Uses the same validation as run_opencode_agent.",
  {
    parentJobId: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional().describe("Stable caller key; repeating it returns the original job instead of duplicating work."),
    ...jobInputShape,
  },
  async ({ parentJobId = "", ...job }) => {
    const started = nowMs();
    const enqueued = await enqueueQueueJob(job, parentJobId);
    if (!enqueued.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Queue job rejected.",
              errorType: enqueued.errorType || "queue_rejected",
              reason: enqueued.error,
              requestedAgent: job.agent,
              actualAgent: "none",
              lockMode: enqueued.lockPlan?.lockMode || job.lockMode || "unknown",
              durationMs: nowMs() - started,
              serialOnlyMatches: enqueued.serialOnlyMatches || [],
              suggestedFix: enqueued.suggestedFix || "Fix the job contract and enqueue again.",
            }),
          },
        ],
      };
    }

    // The read scope keeps a reader from counting as the whole repository, and the job id keeps
    // a writer the scheduler already claimed from conflicting with itself.
    const queueAssessment = await assessQueuePlan([{
      jobId: enqueued.record.jobId,
      lockType: enqueued.record.mode === "read" ? "read" : "write",
      cwd: enqueued.record.cwd,
      lockedPaths: enqueued.record.lockedPaths,
      allowedEdits: enqueued.record.allowedEdits,
      scopeContract: enqueued.record.scopeContract,
    }]);
    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode job enqueued.",
            `Job ID: ${enqueued.record.jobId}`,
            `Deduplicated: ${enqueued.deduplicated ? "yes" : "no"}`,
            `Status: ${enqueued.record.status}`,
            `Agent: ${enqueued.record.agent}`,
            `Mode: ${enqueued.record.mode}`,
            `Lock mode: ${enqueued.record.lockMode}`,
            `Locked paths: ${enqueued.record.lockedPaths.length ? enqueued.record.lockedPaths.join(", ") : "none"}`,
            `Allowed edits: ${enqueued.record.allowedEdits.length ? enqueued.record.allowedEdits.join(", ") : "none"}`,
            `Queue mode: ${effectiveQueueMode()}`,
            `Queue assessment: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_opencode_jobs",
  "List queued OpenCode jobs and their current state.",
  {
    cwd: z.string().min(1).describe("Canonical repository path for project-scoped job listing."),
    status: z.enum(["pending", "planned", "blocked", "running", "validating", "reviewing", "testing", "completed", "failed", "cancelled", "interrupted", "not_resumable"]).optional(),
    detail: z.boolean().optional().describe("Full job records (scope contracts, hashes, lease and containment fields). Default: one compact line per job."),
    limit: z.number().int().positive().max(500).optional().describe("Newest jobs to show; default 20."),
  },
  async ({ cwd = "", status = "", detail = false, limit = 20 }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const records = (effectiveQueueMode() === "sqlite"
      ? await listPersistedQueueRecords(projectRoot || cwd, status)
      : [...QUEUE_JOBS.values()]
        .filter((record) => recordMatchesProject(record, projectRoot))
        .map((record) => queueRecordSnapshot(record, false))
        .filter((record) => !status || record.status === status)
    ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const shown = records.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: [
            `Queue mode: ${effectiveQueueMode()}`,
            `Jobs: ${records.length}${shown.length < records.length ? ` (showing the newest ${shown.length})` : ""}`,
            detail ? JSON.stringify(shown.map((record) => ({ ...record, ...queueAgentActivity(record) })), null, 2) : compactQueueJobLines(shown),
          ].join("\n"),
        },
      ],
    };
  }
);

// Polling four jobs with full records cost ~20k characters of coordinator context per poll.
// The compact form keeps what a coordinator acts on; detail: true or get_opencode_job has the rest.
// One diagnose row. A completed writer whose worktree no longer exists was integrated (or removed),
// so it is not offered for integration again.
// B-020: every bridge-created worktree (queued, direct or parallel) is in worktree_artifacts;
// diagnose read only queue records, so parallel writers' retained patches were invisible.
async function listRetainedWorktreeArtifacts(projectRoot, { jobId = "" } = {}) {
  const db = await openLockDb(projectRoot);
  try {
    const placeholders = RETAINED_WORKTREE_STATUSES.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT worktree_path AS worktreePath, cwd, branch, job_id AS jobId, status,
        measured_bytes AS measuredBytes, created_at AS createdAt, updated_at AS updatedAt
      FROM worktree_artifacts
      WHERE status IN (${placeholders})${jobId ? " AND job_id = ?" : ""}
      ORDER BY created_at DESC
    `).all(...RETAINED_WORKTREE_STATUSES, ...(jobId ? [jobId] : []));
    return rows.map((row) => ({ ...row, present: existsSync(row.worktreePath) }));
  } finally {
    closeDb(db);
  }
}

const QUEUE_JOB_RUNNING_STATUSES = new Set(["pending", "planned", "running", "validating", "reviewing", "testing", "blocked"]);

function retainedWorktreeView(artifact, { queueJob = null, run = null } = {}) {
  const owner = queueJob ? "queue" : run ? run.kind || "direct" : "unrecorded";
  // A worktree is registered "retained" when it is created, so a running agent's worktree looks
  // retained too; it must not be offered for integration or removal while an agent may write to it.
  const inFlight = Boolean(queueJob ? QUEUE_JOB_RUNNING_STATUSES.has(queueJob.status) : run?.status === "started");
  return {
    worktreePath: artifact.worktreePath,
    branch: artifact.branch,
    jobId: artifact.jobId,
    owner,
    ownerStatus: queueJob?.status || run?.status || "",
    registryStatus: artifact.status,
    present: artifact.present,
    inFlight,
    createdAt: artifact.createdAt,
    measuredBytes: artifact.measuredBytes,
    recoveryAction: inFlight
      ? "None yet: its job is still running (or its bridge stopped before recording the outcome; check the owner status). Do not integrate or remove it while an agent may be writing."
      : !artifact.present
      ? "None on disk: the directory is gone; the next worktree reservation reconciles the registry row."
      : artifact.status === "creating"
      ? "Creation did not finish: inspect it, then remove it with git worktree remove if it holds no work."
      : `Review: git -C "${artifact.worktreePath}" status --short and git diff; integrate with integrate_opencode_worktree (dry run first) or remove it.`,
  };
}

function directRunView(run, artifacts = [], { detail = false } = {}) {
  const usage = run.usageSteps === null || run.usageSteps === undefined ? null : {
    steps: run.usageSteps,
    inputCount: run.inputCount,
    outputCount: run.outputCount,
    reasoningCount: run.reasoningCount,
    cacheReadCount: run.cacheReadCount,
    cacheWriteCount: run.cacheWriteCount,
    cost: run.cost,
  };
  // L-025: the result text stored under the Run id (redacted, sealed on disk, capped like a queue
  // result); a run from before this, or one whose text could not be sealed, has none.
  const stored = run.result && !run.result.unreadable ? run.result : null;
  const resultView = stored
    ? {
      resultText: stored.text,
      resultTextChars: stored.chars,
      resultTextTruncated: stored.reportTruncated,
      resultDetailTextChars: stored.detailText.length,
      ...(detail ? { resultDetailText: stored.detailText, resultDetailTextTruncated: stored.detailTruncated } : {}),
    }
    : {};
  const resultNote = stored
    ? `The result text stored under this Run id is in resultText${stored.detailText ? (detail ? " and resultDetailText" : "; pass detail: true for resultDetailText (a writer's patch preview, a parallel job's bridge preamble)") : ""}.`
    : run.result?.unreadable
    ? "A result text was stored for this run but could not be opened (its encryption key changed or the record is damaged)."
    : run.status === "started"
    ? "The run has not finished (or its bridge stopped before recording the outcome); its result text is stored when it does."
    : "No result text was stored for this run (it ran before results were kept, or the audit could not store it).";
  return {
    kind: run.kind === "parallel" ? "parallel_run" : "direct_run",
    runId: run.runId,
    agent: run.agent,
    status: run.status,
    errorType: run.errorType || "",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || "",
    durationMs: run.durationMs,
    waitBeforeAgentMs: run.startupMs,
    agentRunMs: run.agentRunMs,
    providerWaitMs: run.providerWaitMs,
    providerRetryWarningCount: run.providerRetryWarnings,
    usage,
    ...(usage?.steps ? { usageSummary: formatOpenCodeUsage(usage) } : {}),
    configuredModel: run.configuredModel || "",
    worktrees: artifacts.map((artifact) => retainedWorktreeView(artifact, { run })),
    ...resultView,
    note: `Not a queue job: this ${run.kind === "parallel" ? "run_opencode_parallel" : "run_opencode_agent"} run cannot be cancelled or replayed. ${resultNote} A worktree listed here is retained work.`,
  };
}

function diagnoseJobView(job) {
  const worktreePresent = Boolean(job.worktreePath) && existsSync(job.worktreePath);
  return {
    jobId: job.jobId,
    pipelineId: job.parentJobId || "",
    status: job.status,
    stage: queueRunStage(job),
    ...queueAgentActivity(job),
    errorType: job.errorType || "",
    failureReason: job.errorReason || "",
    requestedAgent: job.agent || "",
    actualModel: job.actualModel || job.runtimeObservedModel || "",
    childProcessId: job.childProcessId || job.orphanChildProcessId || 0,
    worktreePath: job.worktreePath || "",
    workPreserved: worktreePresent,
    retrySafe: job.mode === "read" && !["running", "validating", "reviewing", "testing"].includes(job.status),
    // Healthy jobs used to get "inspect preserved work before retrying", which reads as if
    // something had gone wrong; only jobs that stopped short get recovery steps.
    recoveryAction: ["pending", "planned", "running", "validating", "reviewing", "testing"].includes(job.status)
      ? `None: the job is ${queueRunStage(job)}.`
      : job.status === "completed"
      ? (worktreePresent && job.mode === "write"
        ? "None: review the patch and integrate it with integrate_opencode_worktree (dry run first)."
        : job.worktreePath && job.mode === "write"
        ? "None: the worktree is gone (integrated and cleaned up, or removed)."
        : "None: the job completed.")
      : worktreePresent
      ? `Inspect preserved work: git -C "${job.worktreePath}" status --short and git diff --binary before retrying.`
      : job.status === "not_resumable"
      ? "Re-enqueue with a stable idempotencyKey; legacy records without encrypted requests cannot be replayed."
      : job.status === "interrupted"
      ? "Inspect the target repository and recorded child identity before retrying with the same idempotencyKey."
      : "No manual SQLite edit is required; follow the stable error type and wait for active leases/locks to expire or complete.",
  };
}

const ESSENTIAL_QUEUE_JOB_FIELDS = [
  "jobId", "idempotencyKey", "requeuedFrom", "requeuedAs", "retryAttempt", "maxAttempts", "attemptHistory", "startAfter", "autoIntegration", "agent", "mode", "status", "runStage", "createdAt", "startedAt",
  "agentStartedAt", "lastActivityAt", "idleMs", "finishedAt", "durationMs", "agentRunMs", "waitBeforeAgentMs", "afterAgentMs", "providerWaitMs",
  "providerRetryWarningCount", "usage", "usageSummary", "heavyToolCalls", "validationFixPass", "selfCheck", "phaseTimings",
  "errorType", "errorReason", "completionOutcome", "changedFiles", "worktreePath", "worktreeBranch",
  "dependencyRequest", "readOnlyHeadMove", "resultTextChars", "resultTextTruncated", "resultText", "resultDetailTextChars",
];

// The fields a caller polling or reading one job acts on; `detail: true` returns the full record.
function essentialQueueJobView(snapshot) {
  const view = {};
  for (const field of ESSENTIAL_QUEUE_JOB_FIELDS) {
    const value = snapshot?.[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (field === "resultDetailTextChars" && !value) continue;
    view[field] = value;
  }
  view.omitted = "Pass detail: true for the scope contract, hashes, lease, owner and containment fields, and for the stored worktree patch preview (resultDetailText); the result text leaves the patch out (integrate_opencode_worktree with dryRun: true shows it too).";
  return view;
}

function queueTimedOutWriterNote(record) {
  if (record?.status !== "failed" || record.mode !== "write") return "";
  return timedOutWriterNote({ errorType: record.errorType, changedFiles: record.changedFiles, worktreeRetained: Boolean(record.worktreePath) });
}

function compactQueueJobLines(records) {
  if (!records.length) return "(no jobs)";
  return records.map((record) => {
    const stage = queueRunStage(record);
    const timing = queueAgentTiming(record);
    const activity = queueAgentActivity(record);
    const parts = [
      record.jobId,
      record.idempotencyKey ? `key=${record.idempotencyKey}` : "",
      record.requeuedFrom ? `requeuedFrom=${record.requeuedFrom}` : "",
      record.requeuedAs ? `requeuedAs=${record.requeuedAs}` : "",
      record.maxAttempts ? `attempt=${record.retryAttempt || 1}/${record.maxAttempts}` : "",
      record.maxAttempts && record.scopeContract?.modelRequirement?.model ? `model=${record.scopeContract.modelRequirement.provider}/${record.scopeContract.modelRequirement.model}` : "",
      queueStartAfterPending(record) ? `startAfter=${record.startAfter}` : "",
      `agent=${record.agent || "?"}`,
      `status=${record.status || "?"}`,
      stage && stage !== record.status ? `stage=${stage}` : "",
      timing.waitBeforeAgentMs ? `waitBeforeAgentMs=${timing.waitBeforeAgentMs}` : "",
      timing.agentRunMs ? `agentRunMs=${timing.agentRunMs}` : "",
      activity.idleMs !== undefined ? `idle ${formatIdleDuration(activity.idleMs)}` : "",
      timing.afterAgentMs ? `afterAgentMs=${timing.afterAgentMs}` : "",
      record.providerWaitMs ? `providerWaitMs=${record.providerWaitMs}` : "",
      record.usage?.steps ? `tokens=${record.usage.inputCount}in/${record.usage.outputCount}out` : "",
      record.usage?.steps && record.usage.cacheReadCount ? `cacheRead=${record.usage.cacheReadCount}` : "",
      record.validationFixPass ? `fixPass=${record.validationFixPass.used ? `used(${record.validationFixPass.finalValidation})` : "skipped"}` : "",
      record.selfCheck ? `selfCheck=${record.selfCheck.final}(${record.selfCheck.passesUsed}/${record.selfCheck.passesAllowed})` : "",
      record.providerRetryWarningCount ? `providerErrorLines=${record.providerRetryWarningCount}` : "",
      record.readOnlyHeadMove ? `headMoved=${record.readOnlyHeadMove.readScopeTouched?.length ? "read-scope" : "outside-read-scope"}` : "",
      record.durationMs ? `durationMs=${record.durationMs}` : "",
      record.errorType ? `error=${record.errorType}` : "",
      record.completionOutcome ? `outcome=${record.completionOutcome}` : "",
      record.autoIntegration?.status ? `autoIntegration=${record.autoIntegration.status}${record.autoIntegration.commit ? `@${String(record.autoIntegration.commit).slice(0, 12)}` : ""}` : "",
      (record.changedFiles || []).length ? `changed=${record.changedFiles.join(",")}` : "",
      queueTimedOutWriterNote(record) ? `note="${queueTimedOutWriterNote(record)}"` : "",
    ].filter(Boolean);
    return `- ${parts.join(" ")}`;
  }).join("\n");
}

server.tool(
  "get_opencode_job",
  "Get one OpenCode job by id: a queued job (with result text), or a run_opencode_agent / run_opencode_parallel Run id (status, timing, usage, retained worktree and the stored result text).",
  {
    jobId: z.string(),
    cwd: z.string().min(1).describe("Canonical repository path for project-scoped job lookup."),
    detail: z.boolean().optional().describe("Full record (scope contract, hashes, lease, owner and containment fields) plus the stored detail text: a writer's worktree patch preview, a parallel job's bridge preamble. Default: status, timing, changed files, worktree and result text (without the patch preview)."),
  },
  async ({ jobId, cwd = "", detail = false }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const authoritative = await authoritativeQueueRecord(jobId, projectRoot || cwd);
    const persisted = authoritative
      ? (effectiveQueueMode() === "sqlite" ? authoritative : queueRecordSnapshot(authoritative))
      : null;
    // record_json keeps the stage and timings of its last write; a running job's are derived now.
    const snapshot = persisted
      ? {
        ...persisted,
        runStage: queueRunStage(persisted),
        ...queueAgentTiming(persisted),
        ...queueAgentActivity(persisted),
        // One readable line next to the usage counts: the totals a job read, so a very heavy one is noticed.
        ...(persisted.usage?.steps ? { usageSummary: formatOpenCodeUsage(persisted.usage) } : {}),
      }
      : null;
    if (!snapshot) {
      const lookupRoot = projectRoot || await resolveProjectStateRoot(process.cwd());
      const [run, artifacts] = await Promise.all([
        directRunAuditStore().get(lookupRoot, jobId, { includeResult: true }),
        listRetainedWorktreeArtifacts(lookupRoot, { jobId }).catch(() => []),
      ]);
      if (run || artifacts.length) {
        const view = run
          ? directRunView(run, artifacts, { detail })
          : {
            kind: "worktree_only",
            runId: jobId,
            worktrees: artifacts.map((artifact) => retainedWorktreeView(artifact)),
            note: "No queue record or run audit record has this id (older than the audit, or pruned); the worktree registry still has its retained worktree.",
          };
        return { content: [{ type: "text", text: JSON.stringify(sanitizePersistedValue(view), null, 2) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `OpenCode job not found: ${jobId}. Neither the queue, the direct/parallel run audit, nor the worktree registry of this repository has that id.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(detail ? snapshot : essentialQueueJobView(snapshot), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "inspect_opencode_queue_recovery",
  "Inspect queue ownership/lease state and optionally reconcile only confirmed expired records. Audit history is retained.",
  {
    cwd: z.string().describe("Repository path for the sqlite-backed queue state."),
    reconcileExpired: z.boolean().optional().describe("Set true to mark only confirmed expired records interrupted/not_resumable. Defaults to read-only inspection."),
  },
  async ({ cwd, reconcileExpired = false }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: "Queue recovery inspection requires CODEX_OPENCODE_QUEUE_MODE=sqlite." }] };
    }
    const db = await openLockDb(cwd);
    try {
      const now = Date.now();
      const rows = db.prepare(`
        SELECT job_id, status, owner_instance_id, owner_process_id, owner_generation,
               heartbeat_at, lease_expires_at, cancellation_requested_at, child_process_id,
               child_process_started_at, revision, created_at, started_at
        FROM opencode_jobs
        WHERE status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
        ORDER BY created_at
      `).all().map((row) => {
        const active = ["running", "validating", "reviewing", "testing"].includes(row.status);
        const leaseMs = Date.parse(row.lease_expires_at || "");
        const ownerAlive = processIsAlive(Number(row.owner_process_id || 0));
        return sanitizePersistedValue({
          jobId: row.job_id,
          status: row.status,
          ownerInstanceId: row.owner_instance_id || "",
          ownerProcessId: row.owner_process_id || 0,
          ownerGeneration: row.owner_generation || "",
          heartbeatAt: row.heartbeat_at || "",
          leaseExpiresAt: row.lease_expires_at || "",
          leaseExpired: active ? Number.isFinite(leaseMs) && leaseMs <= now : false,
          ownerProcessAlive: ownerAlive,
          cancellationRequestedAt: row.cancellation_requested_at || "",
          childProcessId: row.child_process_id || 0,
          childProcessStartedAt: row.child_process_started_at || "",
          childProcessAlive: processIsAlive(Number(row.child_process_id || 0)),
          revision: row.revision || 0,
        });
      });
      const reconciled = reconcileExpired ? reconcileStaleQueueRecords(db, now) : [];
      return {
        content: [{
          type: "text",
          text: [
            `Queue recovery mode: ${reconcileExpired ? "confirmed expired reconciliation" : "read-only inspection"}`,
            `Bridge instance: ${BRIDGE_INSTANCE_ID}`,
            `Nonterminal records: ${rows.length}`,
            `Reconciled records: ${reconciled.length ? reconciled.join(", ") : "none"}`,
            JSON.stringify(rows, null, 2),
          ].join("\n"),
        }],
      };
    } finally {
      closeDb(db);
    }
  }
);

server.tool(
  "cancel_opencode_job",
  "Cancel a queued OpenCode job. Pending and blocked jobs are cancelled immediately; active jobs terminate their exact OpenCode process tree.",
  {
    jobId: z.string(),
    cwd: z.string().min(1).describe("Canonical repository path for the project-scoped cancellation."),
  },
  async ({ jobId, cwd = "" }) => {
    const projectRoot = await resolveProjectStateRoot(cwd);
    let record = QUEUE_JOBS.get(jobId) || null;
    if (record && !recordMatchesProject(record, projectRoot)) record = null;
    if (effectiveQueueMode() === "sqlite") {
      const durable = await readPersistedQueueRecord(jobId, projectRoot);
      const exactLocalOwner = durable && record
        && Number(record.revision || 0) === Number(durable.revision || 0)
        && record.ownerInstanceId === durable.ownerInstanceId
        && String(record.ownerGeneration || "") === String(durable.ownerGeneration || "");
      if (exactLocalOwner) Object.assign(record, durable);
      else record = null;
    }
    if (!record) {
      if (effectiveQueueMode() === "sqlite" && cwd) {
        const db = await openLockDb(projectRoot);
        try {
          const cancelled = await cancelPersistedQueueJob(db, jobId);
          if (cancelled.outcome === "cancelled") {
            if (cancelled.pipelinePropagation?.pipelineId) {
              await reconcileParentPipelineAfterQueueTerminal({
                jobId,
                parentJobId: cancelled.pipelinePropagation.pipelineId,
                pipelinePropagation: cancelled.pipelinePropagation,
                cwd: projectRoot,
              });
            }
            return { content: [{ type: "text", text: `OpenCode job ${jobId} was cancelled atomically before execution.` }] };
          }
          if (cancelled.outcome === "cancellation_requested") {
            return { content: [{ type: "text", text: `Cross-process cancellation requested for OpenCode job ${jobId}; the owning bridge heartbeat will terminate its exact child process tree.` }] };
          }
          if (cancelled.outcome === "already_terminal") {
            return { content: [{ type: "text", text: `OpenCode queue job ${jobId} is already ${cancelled.status}.` }] };
          }
          if (cancelled.outcome === "contention") {
            return { content: [{ type: "text", text: `OpenCode queue job ${jobId} changed repeatedly while cancellation was attempted; retry against its current status ${cancelled.status}.` }] };
          }
        } finally {
          closeDb(db);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job not found: ${jobId}`,
          },
        ],
      };
    }

    if (["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job ${jobId} is already ${record.status}.`,
          },
        ],
      };
    }

    if (["running", "validating", "reviewing", "testing"].includes(record.status)) {
      Object.assign(record, {
        cancellationRequested: true,
        cancellationRequestedAt: new Date().toISOString(),
        errorReason: "Cancellation requested; terminating the active OpenCode process tree.",
      });
      await persistQueueRecord(record);
      record.abortController?.abort();
      return {
        content: [
          {
            type: "text",
            text: `Cancellation requested and process termination started for OpenCode job ${jobId}.`,
          },
        ],
      };
    }

    Object.assign(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      cancellationRequested: true,
      cancellationRequestedAt: new Date().toISOString(),
      errorType: "agent_cancelled",
      errorReason: "Cancelled before execution.",
      heartbeatAt: "",
      leaseExpiresAt: "",
    });
    const persisted = await persistQueueRecord(record);
    scheduleQueue();
    if (!persisted?.persisted) {
      // The durable row moved first (claimed, finished, or owned elsewhere); persistQueueRecord
      // reloaded it, so report what the job durably is instead of a cancellation that did not land.
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job ${jobId} was not cancelled: its durable status is ${persisted?.status || record.status || "unknown"}.${persisted?.ownershipLost ? " Another bridge generation owns it now." : ""}`,
          },
        ],
      };
    }
    if (record.parentJobId || record.pipelinePropagation?.pipelineId) {
      try {
        await reconcileParentPipelineAfterQueueTerminal(record);
      } catch (error) {
        logEvent("warn", "pipeline.child_terminal_reconciliation_failed", {
          pipelineId: record.parentJobId || record.pipelinePropagation?.pipelineId || "",
          jobId,
          errorType: error?.errorType || "pipeline_child_terminal_reconciliation_failed",
        });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `OpenCode queue job cancelled: ${jobId} (durable status: ${persisted.status || record.status}).`,
        },
      ],
    };
  }
);

// A short refusal for the queue-management tools (not an agent job, so no lock or worktree lines).
function formatToolRefusal({ headline, errorType, reason, suggestedFix }) {
  return [headline, "", `errorType: ${errorType}`, `reason: ${reason}`, `suggestedFix: ${suggestedFix}`].join("\n");
}

function formatConcurrencyChange(change) {
  const described = describeConcurrencyLimits();
  return [
    change.reset ? "OpenCode concurrency limits reset to the environment values." : "OpenCode concurrency limits updated.",
    `Provider slots per provider: ${described.provider}; was ${change.previous.providerLimit}`,
    `Queue parallel limit (this process): ${described.queue}; was ${change.previous.queueParallelLimit}`,
    `Global worker limit (all providers and bridge processes): ${described.global}; was ${change.previousGlobalWorkerLimit === 0 ? "0 (no cap)" : change.previousGlobalWorkerLimit}`,
    "Running jobs keep their slots; a lower limit only holds back new starts until enough jobs have finished.",
    `Persisted in ${path.join(effectiveBridgeStateDirectory(), "provider-concurrency.sqlite")}: other bridge processes pick it up at their next scheduler pass or slot request, and a restart keeps it until reset: true.`,
  ].join("\n");
}

server.tool(
  "requeue_opencode_job",
  "Re-run a failed, cancelled, interrupted or not_resumable queue job as a NEW job built from its stored request (agent, task, model pin, Scope Contract, locks, validationCommand, timeout). The request goes through the normal enqueue validation again; the new job gets its own id and a derived idempotency key (<original key>:requeue:<n>), and the two jobs reference each other (requeuedFrom / requeuedAs). Completed and unfinished jobs are refused. Optional overrides: model (must be in CODEX_OPENCODE_MODEL_ALLOWLIST) and timeoutMs.",
  {
    cwd: z.string().min(1).describe("Canonical repository path of the project that owns the job."),
    jobId: z.string().min(1).describe("The failed, cancelled, interrupted or not_resumable job to run again."),
    model: z.string().optional().describe("Run the new job on this model instead: provider/model[@variant], an entry of CODEX_OPENCODE_MODEL_ALLOWLIST."),
    timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional().describe("Agent run timeout in ms for the new job (at most 24 h)."),
  },
  async ({ cwd, jobId, model, timeoutMs }) => {
    const started = nowMs();
    const requeued = await requeueQueueJob({ cwd, jobId, model, timeoutMs });
    if (!requeued.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Requeue refused.",
          errorType: requeued.errorType,
          reason: requeued.error,
          suggestedFix: requeued.suggestedFix || "Fix the cause above and call requeue_opencode_job again.",
        }) }],
      };
    }
    const record = requeued.record;
    const queueAssessment = await assessQueuePlan([{
      jobId: record.jobId,
      lockType: record.mode === "read" ? "read" : "write",
      cwd: record.cwd,
      lockedPaths: record.lockedPaths,
      allowedEdits: record.allowedEdits,
      scopeContract: record.scopeContract,
    }]);
    return {
      content: [{
        type: "text",
        text: [
          "OpenCode job requeued.",
          `New job ID: ${record.jobId}`,
          `Requeued from: ${requeued.originalJobId} (was ${requeued.originalStatus}${requeued.originalErrorType ? `, ${requeued.originalErrorType}` : ""})`,
          `Idempotency key: ${requeued.idempotencyKey}`,
          `Deduplicated: ${requeued.deduplicated ? "yes (the same requeue already created this job)" : "no"}`,
          `Overrides: ${requeued.overrides.length ? requeued.overrides.join(", ") : "none"}`,
          `Status: ${record.status}`,
          `Agent: ${record.agent}`,
          `Mode: ${record.mode}`,
          `Lock mode: ${record.lockMode}`,
          `Locked paths: ${(record.lockedPaths || []).length ? record.lockedPaths.join(", ") : "none"}`,
          `Allowed edits: ${(record.allowedEdits || []).length ? record.allowedEdits.join(", ") : "none"}`,
          `Queue mode: ${effectiveQueueMode()}`,
          `Queue assessment: ${queueAssessment.status}`,
          `Queue reason: ${queueAssessment.reason}`,
          requeued.originalWorktreePath ? `The previous attempt's worktree is untouched: ${requeued.originalWorktreePath}` : null,
          ...requeued.warnings.map((warning) => `Warning: ${warning}`),
          `Duration ms: ${Math.round(nowMs() - started)}`,
        ].filter((line) => line !== null).join("\n"),
      }],
    };
  }
);

server.tool(
  "set_opencode_concurrency",
  `Change the provider slot limit (CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT), the queue parallel limit (CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT) and/or the global worker cap over all providers (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT, 0 = none) of the running bridge without a restart, so running jobs are not interrupted. Values are 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT} (global 0 to ${MAX_GLOBAL_WORKER_LIMIT}). The change is persisted until reset: true returns to the environment values. Lowering never kills running jobs; it only holds back new starts.`,
  {
    providerLimit: z.number().int().min(1).max(MAX_RUNTIME_CONCURRENCY_LIMIT).optional().describe("Simultaneous model calls per provider, across all bridge processes."),
    queueParallelLimit: z.number().int().min(1).max(MAX_RUNTIME_CONCURRENCY_LIMIT).optional().describe("Queue jobs this bridge process runs at once (the provider limit still caps model calls)."),
    globalWorkerLimit: z.number().int().min(0).max(MAX_GLOBAL_WORKER_LIMIT).optional().describe("Agents running at once on ALL providers across all bridge processes (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT); 0 removes the cap."),
    reset: z.boolean().optional().describe("Clear every runtime override and return to the environment values. Do not combine with a limit."),
  },
  async ({ providerLimit, queueParallelLimit, globalWorkerLimit, reset = false }) => {
    const change = await setRuntimeConcurrency({ providerLimit, queueParallelLimit, globalWorkerLimit, reset });
    if (!change.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Concurrency change rejected.",
          errorType: change.errorType,
          reason: change.error,
          suggestedFix: `Pass providerLimit and/or queueParallelLimit as integers from 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT}, globalWorkerLimit from 0 to ${MAX_GLOBAL_WORKER_LIMIT}, or reset: true.`,
        }) }],
      };
    }
    return { content: [{ type: "text", text: formatConcurrencyChange(change) }] };
  }
);

// Q-005: runtime pause of a provider or one of its models (orch/pause.json of the round-6
// orchestrator). Stored with the automatic pauses in provider-concurrency.sqlite, so every bridge
// process honours it at its next slot request and it survives a restart.
server.tool(
  "pause_opencode_provider",
  "Pause a provider (\"opencode\") or one model (\"opencode/muse-spark-1.3-contributor-free\") until a time or for some minutes, in every bridge process. Running jobs keep going; new jobs on it fail at once with provider_paused (a job with a models list moves to its next model). Replaces any pause already on that key, shorter or longer. resume_opencode_provider ends it early.",
  {
    provider: z.string().min(1).describe("provider or provider/model, as in CODEX_OPENCODE_MODEL_ALLOWLIST without the @variant."),
    until: z.string().optional().describe("ISO time the pause ends (at most 24 h ahead). Give until or minutes."),
    minutes: z.number().int().min(1).max(24 * 60).optional().describe("Pause length in minutes. Give until or minutes."),
    reason: z.string().max(200).optional().describe("Shown in get_opencode_bridge_status and in the error new jobs get."),
  },
  async ({ provider, until, minutes, reason = "" }) => {
    const paused = await pauseProvider({ provider, until, minutes, reason });
    if (!paused.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Provider pause rejected.",
          errorType: paused.errorType,
          reason: paused.error,
          suggestedFix: "Pass provider as provider or provider/model and exactly one of until (ISO time, at most 24 h ahead) or minutes (1 to 1440).",
        }) }],
      };
    }
    return { content: [{ type: "text", text: [
      `Provider paused: ${paused.key}`,
      `Until: ${paused.until}`,
      paused.target.model ? `Scope: model ${paused.target.provider}/${paused.target.model} only` : `Scope: every model of ${paused.target.provider}${CONFIG.providerConcurrencyKeyExplicit ? ` (CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY is set, so every provider shares this key and this pause covers them all)` : ""}`,
      "Running jobs keep their slots; new jobs on this key fail at once with provider_paused until then, in every bridge process.",
    ].join("\n") }] };
  }
);

server.tool(
  "resume_opencode_provider",
  "End the pause of a provider or provider/model early, whether an operator set it (pause_opencode_provider) or the bridge did (a quota reset time, a detected rate limit). For a whole provider it also clears the pauses of its models and their rate-limit backoff.",
  {
    provider: z.string().min(1).describe("provider or provider/model."),
  },
  async ({ provider }) => {
    const resumed = await resumeProvider({ provider });
    if (!resumed.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolRefusal({
          headline: "Provider resume rejected.",
          errorType: resumed.errorType,
          reason: resumed.error,
          suggestedFix: "Pass provider as provider or provider/model.",
        }) }],
      };
    }
    return { content: [{ type: "text", text: [
      `Provider resumed: ${resumed.key}`,
      `Pauses removed: ${resumed.removed.length ? resumed.removed.map((item) => `${item.providerKey} (was until ${item.until}, ${item.errorType})`).join("; ") : "none (nothing was paused)"}`,
    ].join("\n") }] };
  }
);

server.tool(
  "create_multi_agent_pipeline",
  "Create a multi-agent execution pipeline with ownership, worktree, integration, and final-validation policy checks.",
  {
    name: z.string().optional(),
    cwd: z.string().min(1),
    usePolicy: z.boolean().optional().describe("Load and apply .mcp/agent-policy.json by default."),
    policyPath: z.string().optional().describe("Repo-relative policy path. Defaults to .mcp/agent-policy.json."),
    trustedPolicySha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Deprecated diagnostic echo only. Policy trust is anchored exclusively in CODEX_OPENCODE_TRUSTED_POLICY_SHA256."),
    sanitizedWorkspace: sanitizedWorkspaceSchema.optional().describe("Optional exact workspace contract for read-only pipeline waves."),
    requiresWorktrees: z.boolean().optional().describe("Require isolated worktrees for write jobs. Defaults to true."),
    finalValidationCommand: z.string().optional().describe("Coordinator-level validation command required for write pipelines."),
    reviewerJob: z.object({ agent: z.string(), task: z.string() }).optional(),
    testerJob: z.object({ agent: z.string(), task: z.string() }).optional(),
    jobs: z.array(
      z.object({
        agent: z.string(),
        owner: z.string().optional().describe("Optional policy owner label. Defaults to role or agent."),
        role: z.string().optional(),
        task: z.string(),
        cwd: z.string().optional(),
        write: z.boolean().optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        lockedPaths: z.array(z.string()).optional(),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        sanitizedWorkspace: sanitizedWorkspaceSchema.optional(),
        timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
        scope: scopePathSetSchema.optional(),
        validation: scopeValidationSchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        allowFallbackToBuild: z.boolean().optional(),
        // "direct" is not offered: a subagent run as `--agent <subagent>` falls back to the default
        // agent, which the bridge cannot attest as the requested role (see resolveAgent).
        subagentStrategy: z.enum(["proxy", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        dryRun: z.boolean().optional(),
        delegation: z.any().optional(),
      })
    ).min(1),
  },
  async ({
    name = "multi-agent-pipeline",
    cwd = "",
    usePolicy = true,
    policyPath = ".mcp/agent-policy.json",
    sanitizedWorkspace = null,
    jobs,
    requiresWorktrees = true,
    finalValidationCommand = "",
    reviewerJob = null,
    testerJob = null,
  }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline rejected.",
        errorType: "pipeline_requires_sqlite_queue",
        reason: "Durable pipelines require one SQLite transaction for their pipeline row, child manifest, encrypted requests, and queue release.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server. Memory mode remains available for standalone queue jobs only.",
      }) }] };
    }
    if (sanitizedWorkspace && (usePolicy || String(finalValidationCommand || "").trim() || jobs.some((job) => String(job.validationCommand || job.scopeContract?.validationCommand || job.delegation?.validationCommand || "").trim()))) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Sanitized multi-agent pipeline rejected.",
        errorType: "sanitized_workspace_command_forbidden",
        reason: "Sanitized pipelines may not load project policy or execute repository validation commands. Their trust boundary is the exact manifest verification before and after every wave.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        suggestedFix: "Set usePolicy=false, remove validation commands, and perform any domain validation in a separate externally trusted environment.",
      }) }] };
    }
    const targetCwd = sanitizedWorkspace
      ? path.resolve(sanitizedWorkspace.root)
      : await resolveProjectStateRoot(cwd || jobs[0]?.cwd || process.cwd());
    // A job without its own cwd belongs to the pipeline's repository, not to the bridge's
    // working directory (which made every such pipeline "multi-repository").
    const pipelineJobs = sanitizedWorkspace
      ? jobs.map((job) => ({ ...job, cwd: targetCwd, sanitizedWorkspace, subagentStrategy: "reject", write: false, lockType: "read", lockMode: "off" }))
      : jobs.map((job) => ({ ...job, cwd: job.cwd || targetCwd }));
    const normalizedJobs = await Promise.all(pipelineJobs.map((job) => normalizeJobCwd(job)));
    // Children are inserted into the pipeline's own state database, so a child that resolves to
    // another project would be run and recorded elsewhere while the parent waits for it forever.
    const foreignJob = normalizedJobs.find((job) => normalizeFilesystemCase(path.resolve(job.cwd), targetCwd) !== normalizeFilesystemCase(path.resolve(targetCwd), targetCwd));
    if (foreignJob) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: "pipeline_multi_repository_unsupported",
              reason: `Pipeline job "${foreignJob.agent}" resolves to a different repository: ${foreignJob.cwd}.`,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Create one pipeline per Git repository and keep every job cwd inside that repository.",
            }),
          },
        ],
      };
    }
    const policyLoad = usePolicy ? await loadProjectAgentPolicy(targetCwd, policyPath) : { ok: true, path: "", policy: null, sha256: "" };
    if (!policyLoad.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: policyLoad.errorType,
              reason: policyLoad.error,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Fix or remove the project agent policy file, or call create_multi_agent_pipeline with usePolicy=false.",
            }),
          },
        ],
      };
    }
    const sanitizedPreflight = sanitizedWorkspace
      ? await verifySanitizedWorkspace(sanitizedWorkspace, "before_wave")
      : null;
    if (sanitizedPreflight && !sanitizedPreflight.ok) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline sanitized-workspace preflight rejected.",
        errorType: sanitizedPreflight.errorType,
        reason: sanitizedPreflight.error,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        conflictingPaths: sanitizedPreflight.discrepancies?.map((item) => item.path) || [],
        suggestedFix: "Rebuild and re-pin the sanitized workspace before creating the pipeline.",
      }) }] };
    }
    const plan = createPipelinePlan({
      name,
      cwd: targetCwd,
      jobs: normalizedJobs,
      requiresWorktrees,
      finalValidationCommand,
      reviewerJob,
      testerJob,
      policy: policyLoad.policy,
      policyPath: policyLoad.policy ? policyPath : "",
      policySha256: policyLoad.sha256 || "",
      policyTrustedForAuthority: Boolean(policyLoad.trustedForAuthority),
      sanitizedWorkspace,
      sanitizedPreflight,
    });
    if (!plan.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: plan.errorType,
              reason: plan.error,
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              lockMode: plan.lockPlans?.map((lockPlan) => lockPlan.lockMode).join(", ") || "unknown",
              conflictingPaths: plan.conflictingPaths || [],
              serialOnlyMatches: plan.serialOnlyMatches || [],
              suggestedFix: plan.suggestedFix,
            }),
          },
        ],
      };
    }

    const pipelineValidationCommands = [
      ...(plan.record.finalValidationSource === "caller" ? [{ label: "finalValidationCommand", command: plan.record.finalValidationCommand }] : []),
      ...(plan.record.lockPlans || []).map((lockPlan, index) => ({ label: `JOB ${index + 1} validationCommand`, command: lockPlan.validationCommand })),
    ];
    for (const { label, command } of pipelineValidationCommands) {
      const validationPreflight = await validationCommandPreflightError(command, { sanitized: Boolean(sanitizedWorkspace) });
      if (validationPreflight) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Multi-agent pipeline rejected before any job was queued.",
          errorType: validationPreflight.errorType,
          reason: `${label} cannot run: ${validationPreflight.error}`,
          requestedAgent: "pipeline_coordinator",
          actualAgent: "none",
          suggestedFix: VALIDATION_PREFLIGHT_FIX,
        }) }] };
      }
    }

    PIPELINE_RUNS.set(plan.record.pipelineId, plan.record);
    await persistPipelineRecord(plan.record);
    return {
      content: [
        {
          type: "text",
          text: [
            "Multi-agent pipeline created.",
            "",
            JSON.stringify(pipelineRecordSnapshot(plan.record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "run_multi_agent_pipeline",
  "Start a previously created multi-agent pipeline by enqueueing its bounded jobs through the MCP queue.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
  },
  async ({ pipelineId, cwd = "" }) => {
    if (effectiveQueueMode() !== "sqlite") {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: "pipeline_requires_sqlite_queue",
              reason: "run_multi_agent_pipeline requires the SQLite queue so batch activation is atomic and restart-recoverable.",
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server.",
            }),
          },
        ],
      };
    }

    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }

    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "start") }] };
    }

    if (record.status !== "planned" || record.queueJobIds?.length) {
      return {
        content: [
          {
            type: "text",
            text: [
              "Multi-agent pipeline not started.",
              "",
              `Pipeline id: ${pipelineId}`,
              `Current status: ${record.status}`,
              `Queue jobs: ${record.queueJobIds?.join(", ") || "none"}`,
            ].join("\n"),
          },
        ],
      };
    }

    const preparedRecords = [];
    const errors = [];
    for (const job of record.jobs || []) {
      const prepared = await enqueueQueueJob(
        { ...job, cwd: job.cwd || record.cwd },
        pipelineId,
        { schedule: false, initialStatus: "held", persist: false }
      );
      if (!prepared.ok) {
        errors.push({
          agent: job.agent,
          errorType: prepared.errorType,
          error: prepared.error,
          suggestedFix: prepared.suggestedFix,
        });
        continue;
      }
      preparedRecords.push(prepared.record);
    }

    if (errors.length) {
      await updatePipelineRecord(record, {
        status: "failed",
        batchState: "aborted",
        errors,
        finishedAt: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: "text",
            text: [
              "Multi-agent pipeline failed before start.",
              "",
              JSON.stringify(pipelineRecordSnapshot(record), null, 2),
            ].join("\n"),
          },
        ],
      };
    }

    const activation = await activatePipelineBatch(record, preparedRecords);
    if (!activation.ok) {
      return {
        content: [{
          type: "text",
          text: formatRejectedExecution({
            headline: "Multi-agent pipeline activation rejected.",
            errorType: activation.errorType,
            reason: activation.error,
            requestedAgent: "pipeline_coordinator",
            actualAgent: "none",
            lockMode: "atomic_sqlite_batch",
            suggestedFix: "Inspect the durable pipeline revision and retry only if it remains planned with no child manifest.",
          }),
        }],
      };
    }

    scheduleQueue();
    return {
      content: [
        {
          type: "text",
          text: [
            "Multi-agent pipeline started.",
            "",
            JSON.stringify(pipelineRecordSnapshot(record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_multi_agent_pipeline",
  "Get one multi-agent pipeline, including queue job status and integration queue.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
  },
  async ({ pipelineId, cwd = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }

    if (!pipelineOwnedByThisInstance(record)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...pipelineRecordSnapshot(record),
            readOnlyForeignOwner: true,
          }, null, 2),
        }],
      };
    }

    if (!PIPELINE_RUNS.has(pipelineId)) {
      PIPELINE_RUNS.set(pipelineId, record);
    }
    await refreshPipelineRecord(record);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(pipelineRecordSnapshot(record), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "abandon_multi_agent_pipeline",
  "Explicitly abandon an inactive durable pipeline while retaining every unintegrated worktree for separate review or cleanup.",
  {
    pipelineId: z.string().min(1),
    cwd: z.string().min(1),
    confirmation: z.string().min(1).describe("Must exactly equal pipelineId. Prevents accidental abandonment."),
    reason: z.string().max(500).optional(),
  },
  async ({ pipelineId, cwd = "", confirmation, reason = "Operator abandoned an obsolete pipeline." }) => {
    if (confirmation !== pipelineId) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_abandon_confirmation_mismatch",
        reason: "The confirmation value must exactly equal the pipeline id.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Inspect the pipeline first, then repeat with confirmation set to the exact pipelineId. Abandonment retains all worktrees.",
      }) }] };
    }
    if (effectiveQueueMode() !== "sqlite") {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_requires_sqlite_queue",
        reason: "Only durable SQLite pipelines can be abandoned through this recovery operation.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=sqlite and restart the MCP server.",
      }) }] };
    }

    const projectRoot = await resolveProjectStateRoot(cwd);
    const record = await authoritativePipelineRecord(pipelineId, projectRoot);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }
    if (record.status === "cancelled" && (record.events || []).some((event) => event.type === "pipeline_abandoned")) {
      return { content: [{ type: "text", text: [
        "Multi-agent pipeline already abandoned; retained sources were not modified.",
        "",
        JSON.stringify(pipelineRecordSnapshot(record), null, 2),
      ].join("\n") }] };
    }
    if (["completed", "failed", "cancelled"].includes(record.status)) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_already_terminal",
        reason: `Pipeline status is already ${record.status}.`,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Keep the terminal audit record; normal retention will remove it after the configured retention period.",
      }) }] };
    }
    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "abandonment") }] };
    }

    const children = record.status === "planned" && record.batchState === "unstarted"
      ? { ok: true, snapshots: [] }
      : await readPersistedPipelineChildren(record);
    if (!children.ok) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_child_record_missing",
        reason: "The durable child manifest is incomplete, so inactivity cannot be proven safely.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Run diagnose_opencode_bridge and preserve the state database for recovery analysis.",
      }) }] };
    }
    const activeStatuses = new Set(["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"]);
    const activeChildren = children.snapshots.filter((child) => activeStatuses.has(child.status));
    if (activeChildren.length) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_abandon_active_jobs",
        reason: `The pipeline still has active jobs: ${activeChildren.map((child) => child.jobId).join(", ")}.`,
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Cancel the active queue jobs first, wait for terminal status, then abandon the pipeline.",
      }) }] };
    }
    if ((record.integrationQueue || []).some((item) => item.status === "integrating")) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: "pipeline_integration_in_progress",
        reason: "An integration journal operation is still in progress or awaiting recovery.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Run diagnose_opencode_bridge and finish integration recovery before abandoning the pipeline.",
      }) }] };
    }

    const abandonedAt = new Date().toISOString();
    try {
      await updatePipelineRecord(record, (current) => {
        // Finalization removes source worktrees that abandonment promises to retain.
        if (["finalizing", "cleanup_pending"].includes(current.status)) {
          const error = new Error("The pipeline is being finalized.");
          error.errorType = "pipeline_finalization_in_progress";
          throw error;
        }
        // An integration may have reserved an item since the check above.
        if ((current.integrationQueue || []).some((item) => item.status === "integrating")) {
          const error = new Error("An integration reserved an item of this pipeline while it was being abandoned.");
          error.errorType = "pipeline_integration_in_progress";
          throw error;
        }
        return {
          status: "cancelled",
          finishedAt: abandonedAt,
          cleanupPending: false,
          cleanupState: "abandoned_sources_retained",
          events: (current.events || []).concat({
            type: "pipeline_abandoned",
            at: abandonedAt,
            reason,
            retainedWorktrees: (current.integrationQueue || []).filter((item) => item.worktreePath).map((item) => item.worktreePath),
          }),
        };
      });
    } catch (error) {
      if (!["pipeline_integration_in_progress", "pipeline_concurrent_update", "pipeline_finalization_in_progress"].includes(error?.errorType)) throw error;
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Multi-agent pipeline abandonment rejected.",
        errorType: error.errorType,
        reason: error.errorType === "pipeline_integration_in_progress"
          ? "An integration journal operation started while the pipeline was being abandoned."
          : error.errorType === "pipeline_finalization_in_progress"
            ? "The pipeline is being finalized; abandoning it now would let finalization remove the source worktrees abandonment retains."
            : "The pipeline changed in another process while it was being abandoned.",
        requestedAgent: "pipeline_coordinator",
        actualAgent: "none",
        lockMode: "abandonment",
        suggestedFix: "Nothing was cancelled. Wait for the integration or finalization to finish (get_multi_agent_pipeline), then abandon again if it is still needed.",
      }) }] };
    }
    return { content: [{ type: "text", text: [
      "Multi-agent pipeline abandoned. Unintegrated worktrees were retained and no project files were deleted.",
      "",
      JSON.stringify(pipelineRecordSnapshot(record), null, 2),
    ].join("\n") }] };
  }
);

server.tool(
  "resolve_integration_quarantine",
  "Close a quarantined integration journal operation that recovery does not clear on its own. verify_restored closes it only when HEAD, the index entries and the bytes of every affected path are back at the recorded pre-integration state; accept_current records that an operator inspected the checkout and accepts it as it is (needs reason and confirmation). Refused while any job holds a lock in the repository; journal rows and pre-images are kept.",
  {
    cwd: z.string().min(1).describe("The repository the quarantine is in."),
    operationId: z.string().min(1).describe("From the integrationOperations section of diagnose_opencode_bridge."),
    mode: z.enum(INTEGRATION_QUARANTINE_RESOLUTION_MODES),
    reason: z.string().max(500).optional().describe("Required for accept_current: what was inspected and why the current state is accepted."),
    confirmation: z.string().optional().describe("Required for accept_current: must exactly equal operationId."),
  },
  async ({ cwd, operationId, mode, reason = "", confirmation = "" }) => {
    // Who and how are set here, never by the caller: the operator is the OS user running this
    // bridge, and "cli" only for the bridge bin/pipeline-admin.js starts for a person at a terminal.
    const via = process.env[OPERATOR_CLI_ENV] === "1" ? "cli" : "mcp";
    const result = await resolveIntegrationQuarantine({ cwd, operationId, mode, reason, confirmation, via });
    return { content: [{ type: "text", text: formatIntegrationQuarantineResolution(result) }] };
  }
);

server.tool(
  "finalize_multi_agent_pipeline",
  "Finalize a multi-agent pipeline after all integrations by running final validation and optional read-only reviewer/tester gates.",
  {
    pipelineId: z.string(),
    cwd: z.string().min(1),
    skipReviewers: z.boolean().optional().describe("Skip configured reviewer/tester gates and run only final validation."),
    dryRun: z.boolean().optional().describe("Check finalization preconditions only: no final validation, no reviewer/tester agents, and no pipeline status change."),
  },
  async ({ pipelineId, cwd = "", skipReviewers = false, dryRun = false }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const record = await authoritativePipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }


    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "finalization") }] };
    }

    if (!PIPELINE_RUNS.has(pipelineId)) {
      PIPELINE_RUNS.set(pipelineId, record);
    }

    const result = await finalizePipelineRecord(record, { skipReviewers, dryRun });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Multi-agent pipeline finalization rejected.",
                errorType: result.errorType,
                reason: result.error,
                requestedAgent: "pipeline_coordinator",
                actualAgent: "none",
                lockMode: "finalization",
                suggestedFix: "Integrate all pending worktrees, fix validation failures, or inspect reviewer/tester gate output before retrying.",
              }),
              "",
              JSON.stringify(pipelineRecordSnapshot(record), null, 2),
            ].join("\n"),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            result.dryRun
              ? `Multi-agent pipeline finalization dry run: preconditions pass. Would run final validation ${result.wouldRun.finalValidationCommand ? `"${result.wouldRun.finalValidationCommand}"` : "(none)"} and gates: ${result.wouldRun.gates.join(", ") || "none"}. Nothing was run or changed.`
              : result.alreadyFinalized
                ? "Multi-agent pipeline was already finalized; its recorded gate results stand and nothing was rerun."
                : "Multi-agent pipeline finalized.",
            "",
            JSON.stringify(pipelineRecordSnapshot(record), null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_multi_agent_pipelines",
  "List multi-agent pipelines from memory and persisted state.",
  {
    cwd: z.string().min(1),
    status: z.enum(["planned", "running", "awaiting_integration", "awaiting_finalization", "finalizing", "integrating", "cleanup_pending", "cleanup_failed", "completed", "failed", "cancelled"]).optional(),
    limit: z.number().int().positive().max(200).optional().describe("Newest pipelines to show; default 20. The count line always covers every pipeline."),
  },
  async ({ cwd = "", status = "", limit = 20 }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const records = (effectiveQueueMode() === "sqlite"
      ? await listPersistedPipelineRecords(projectRoot || cwd, status)
      : [...PIPELINE_RUNS.values()]
        .filter((record) => recordMatchesProject(record, projectRoot))
        .map((record) => pipelineRecordSnapshot(record))
        .filter((record) => !status || record.status === status)
    ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const shown = records.slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: [
            `Pipelines: ${records.length}${shown.length < records.length ? ` (showing the newest ${shown.length})` : ""}`,
            JSON.stringify(shown, null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "integrate_opencode_worktree",
  "Serially integrate one OpenCode worktree or branch after ownership, patch, conflict, and validation checks. A dry run returns a previewReceipt that the apply must present; the receipt survives a target HEAD that only moved forward past commits touching none of the patched paths between the two calls, and is otherwise integration_preview_stale. To land several disjoint worktrees in one dry run and one apply, use integrate_opencode_worktrees.",
  {
    cwd: z.string().min(1).describe("Canonical target repository path where the patch should be checked or applied."),
    pipelineId: z.string().optional().describe("Optional pipeline id to append this integration result to its audit trail."),
    worktreePath: z.string().optional().describe("OpenCode worktree path containing uncommitted changes to integrate."),
    branch: z.string().optional().describe("Branch containing committed changes to integrate. Use worktreePath for uncommitted worktree output."),
    allowedEdits: z.array(z.string()).min(1).describe("Exact file or directory paths this integration may change."),
    forbiddenEdits: z.array(z.string()).optional().describe("Paths that must not change."),
    sharedFiles: z.array(z.string()).optional().describe("Shared/frozen paths that must not change during this integration."),
    serialOnly: z.array(z.string()).optional().describe("Serial-only paths that must not be integrated as part of an unreviewed/shared parallel result."),
    validationCommand: z.string().optional().describe("Command to run after applying the patch. Parsed without a shell."),
    dryRun: z.boolean().optional().describe("Check source paths and merge conflicts without applying the patch."),
    reviewed: z.boolean().optional().describe("Required true for non-dry-run integration after Codex reviews the patch preview."),
    previewReceipt: integrationPreviewReceiptSchema.optional().describe("Exact identity receipt returned by the reviewed dry run. Required for apply."),
    cleanupAfterSuccess: z.boolean().optional().describe("Remove the source worktree and its local branch only after reviewed integration and a passing validationCommand. Defaults to true for worktrees the bridge created; pass false to keep the source."),
    allowDirtyTarget: z.boolean().optional().describe("Allow integration into a target repo that already has changes. Defaults to false."),
    acceptFlaggedSecretLines: z.boolean().optional().describe("Dry run only: issue the receipt even though the secret gate flagged patch lines, after you inspected those lines in the worktree and found no real credential. Defaults to false."),
    acceptBinaryHunks: z.boolean().optional().describe("Dry run only: issue the receipt although the patch has binary hunks for files without a known binary extension, after you inspected those files in the worktree. Defaults to false."),
    previewMode: z.enum(["full", "stat"]).optional().describe("Dry run output: full (default) prints the whole patch; stat prints per-file line counts and the patch SHA-256, for callers that already read the diff in the worktree. The receipt is the same."),
  },
  async ({
    cwd = "",
    pipelineId = "",
    worktreePath = "",
    branch = "",
    allowedEdits,
    forbiddenEdits = [],
    sharedFiles = [],
    serialOnly = [],
    validationCommand = "",
    dryRun = false,
    reviewed = false,
    previewReceipt = null,
    cleanupAfterSuccess = undefined,
    allowDirtyTarget = false,
    acceptFlaggedSecretLines = false,
    acceptBinaryHunks = false,
    previewMode = "full",
  }) => {
    const started = nowMs();
    let pipeline = null;
    let pipelineItem = null;
    let validationTrustedSpec = null;
    let validationPolicyTrust = null;
    if (pipelineId) {
      const requestedProjectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
      pipeline = await authoritativePipelineRecord(pipelineId, requestedProjectRoot || cwd);
      if (!pipeline) {
        return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
      }
      if (!pipelineOwnedByThisInstance(pipeline)) {
        const claim = await claimPersistedPipeline(pipeline);
        if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(pipeline, "integration") }] };
      }
      if (!PIPELINE_RUNS.has(pipelineId)) PIPELINE_RUNS.set(pipelineId, pipeline);
      await refreshPipelineRecord(pipeline);
      await reconcilePipelineIntegrationOperationStates(pipeline);
      if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(pipeline.status)) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_terminal",
          reason: `The pipeline is ${pipeline.status}; an abandoned, failed or completed pipeline does not integrate any more.`,
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Nothing was applied. To use this worktree's change anyway, integrate it without pipelineId after reviewing it, or start a new pipeline.",
        }) }] };
      }
      const candidates = (pipeline.integrationQueue || []).filter((item) => pipelineIntegrationItemMatches(pipeline, item, { worktreePath, branch }));
      if (candidates.length !== 1 || !["pending", "integrating"].includes(candidates[0].status)) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_integration_item_invalid",
          reason: candidates.length !== 1
            ? "The source did not identify exactly one planned pipeline integration item."
            : `The matched integration item is ${candidates[0].status}, not pending or durably recovering.`,
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Use the exact retained worktree/branch reported by the completed pipeline queue item and do not replay an integration.",
        }) }] };
      }
      pipelineItem = candidates[0];
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pipelineItem.sourceBaseCommit || "")
        || !/^[a-f0-9]{64}$/i.test(pipelineItem.patchSha256 || "")
        || !/^[a-f0-9]{64}$/i.test(pipelineItem.sourceStateSha256 || "")) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_source_identity_unattested",
          reason: "The completed queue item lacks an exact base/patch/source-state identity.",
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Re-run this writer with the hardened bridge; legacy or incomplete records are audit-only and cannot be integrated.",
        }) }] };
      }
      cwd = pipeline.cwd;
      allowedEdits = [...(pipelineItem.allowedEdits || [])];
      forbiddenEdits = mergePathLists(pipelineItem.forbiddenEdits, pipeline.policy?.path);
      sharedFiles = [...(pipelineItem.sharedFiles || [])];
      serialOnly = [...(pipelineItem.serialOnly || [])];
      validationCommand = String(pipelineItem.validationCommand || "").trim();
      validationTrustedSpec = pipelineItem.validationSpec || null;
      const validationSource = String(pipelineItem.validationSource || "");
      const validationSourceValid = ["job", "caller", "policy"].includes(validationSource);
      if ((validationCommand && !validationSourceValid)
        || (!validationCommand && validationSource && validationSource !== "none")
        || (validationSource === "policy" && (!pipeline.policy?.path || !validationTrustedSpec))) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "policy_validation_command_untrusted",
          reason: "This integration item has missing, unknown, or inconsistent validation-command provenance. Policy commands also require their exact trusted executable/vector attestation. Legacy records are audit-only.",
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Create a new pipeline with the hardened bridge; the existing worktree was retained.",
        }) }] };
      }
      if (validationTrustedSpec) {
        const currentPolicy = pipeline.policy?.path ? await loadProjectAgentPolicy(pipeline.cwd, pipeline.policy.path) : { ok: false };
        const trustedNow = currentPolicy.ok
          && currentPolicy.sha256 === pipeline.policy?.sha256
          && currentPolicy.policy?.finalValidationSpec?.commandSha256 === validationTrustedSpec.commandSha256;
        if (!trustedNow) {
          return { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Pipeline integration rejected.",
            errorType: "policy_validation_command_untrusted",
            reason: currentPolicy.error || "Project policy trust, bytes, executable hash, or exact validation vector changed before integration.",
            requestedAgent: "merge_manager",
            actualAgent: "none",
            suggestedFix: "Re-approve the exact policy and executable hashes, then create a new pipeline. The existing source was retained.",
          }) }] };
        }
        validationPolicyTrust = {
          path: pipeline.policy.path,
          sha256: pipeline.policy.sha256,
          commandSha256: validationTrustedSpec.commandSha256,
        };
      }
    }
    const effectiveCleanupAfterSuccess = cleanupAfterSuccess ?? isBridgeGeneratedWorktree(cwd || process.cwd(), worktreePath);
    const integrationTimings = {};
    const integrationStarted = nowMs();
    const result = await integrationTimingStorage.run(integrationTimings, () => integratePatchSerially({
      cwd: cwd || process.cwd(),
      worktreePath,
      branch,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      validationTrustedSpec,
      validationPolicyTrust,
      dryRun,
      reviewed,
      previewReceipt,
      allowDirtyTarget,
      acceptFlaggedSecretLines,
      acceptBinaryHunks,
      previewMode,
      cleanupAfterSuccess: effectiveCleanupAfterSuccess,
      deferCleanup: Boolean(pipelineId),
      pipelineId,
      pipelineJobId: pipelineItem?.jobId || "",
      onIntegrationPrepared: pipeline ? async ({ operationId }) => {
        await updatePipelineRecord(pipeline, (current) => {
          // Thrown before the patch is written: the prepared journal operation is recovered as
          // a no-op by the integration's finally block.
          if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status)) throw pipelineTerminalError(current);
          return {
          integrationQueue: (current.integrationQueue || []).map((item) => pipelineIntegrationItemMatches(current, item, { worktreePath, branch })
            ? { ...item, status: "integrating", operationId }
            : item),
          events: (current.events || []).concat({
            type: "integration_prepared",
            at: new Date().toISOString(),
            operationId,
            jobId: pipelineItem?.jobId || "",
          }),
          };
        });
        pipelineItem = (pipeline.integrationQueue || []).find((item) => item.operationId === operationId) || pipelineItem;
      } : null,
      expectedSourceIdentity: pipelineItem ? {
        sourceBaseCommit: pipelineItem.sourceBaseCommit,
        patchSha256: pipelineItem.patchSha256,
        sourceStateSha256: pipelineItem.sourceStateSha256,
      } : null,
    }));
    result.timings = { totalMs: Math.round(nowMs() - integrationStarted), phases: { ...integrationTimings } };
    if (pipelineId) {
      if (pipeline && result.errorType !== "pipeline_terminal") {
        // Computed from the record as it stands when the write runs, so a concurrent
        // integration of another item on this pipeline keeps its own item update.
        await updatePipelineRecord(pipeline, (current) => {
          const integrated = !dryRun && Boolean(result.ok && ["applied", "no_changes"].includes(result.status));
          const integrationQueue = (current.integrationQueue || []).map((item) => {
            // A dry run changes nothing about the item: its outcome is only an event.
            if (dryRun || !pipelineIntegrationItemMatches(current, item, { worktreePath, branch })) return item;
            return {
              ...item,
              status: nextPipelineIntegrationItemStatus(item, result),
              errorType: result.errorType || "",
              operationId: result.operationId || item.operationId || "",
              noChanges: result.ok && result.status === "no_changes" ? true : Boolean(item.noChanges),
              cleanupRequested: Boolean(result.ok && result.status === "applied" && result.validationGate?.status === "passed" && effectiveCleanupAfterSuccess && worktreePath),
              // A failed attempt returns only part of the source identity; the item keeps the
              // attested identity a retry is checked against.
              sourceBaseCommit: result.sourceBaseCommit || item.sourceBaseCommit || "",
              patchSha256: result.patchSha256 || item.patchSha256 || "",
              sourceStateSha256: result.sourceStateSha256 || item.sourceStateSha256 || "",
            };
          });
          const allIntegrated = integrationQueue.length && integrationQueue.every((item) => item.status === "integrated");
          const reopen = integrated && allIntegrated && !PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status);
          return {
            status: reopen ? "awaiting_finalization" : current.status,
            finishedAt: reopen ? "" : current.finishedAt,
            integrationQueue,
            events: (current.events || []).concat({
              type: "integration",
              at: new Date().toISOString(),
              ok: Boolean(result.ok),
              dryRun: Boolean(dryRun),
              status: result.status || "rejected",
              errorType: result.errorType || "",
              sourceType: result.sourceType || (worktreePath ? "worktree" : branch ? "branch" : "unknown"),
              source: result.source || worktreePath || branch || "",
              changedFiles: result.changedFiles || [],
              appliedFiles: result.appliedFiles || [],
              operationId: result.operationId || pipelineItem?.operationId || "",
            }),
            errors: result.ok ? current.errors || [] : (current.errors || []).concat({
              type: "integration",
              errorType: result.errorType || "integration_rejected",
              error: result.error || "",
              dryRun: Boolean(dryRun),
            }),
          };
        });
      }
    }

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Serial integration rejected.",
                errorType: result.errorType || "integration_rejected",
                reason: result.error || "Integration failed.",
                requestedAgent: "merge_manager",
                actualAgent: "none",
                lockMode: "serial_integration",
                durationMs: nowMs() - started,
                conflictingPaths: result.conflictingPaths || result.disallowedFiles || result.changedFiles || [],
                allowedEdits,
                rollback: result.rollback?.rollback || "",
                rollbackFiles: result.rollback?.rollbackFiles || [],
                unresolvedFiles: result.rollback?.unresolvedFiles || [],
                suggestedFix: result.suggestedFix || "Resolve conflicts, narrow allowedEdits, move shared/global files to a serial contract step, or rerun with a passing validation command.",
              }),
              result.validationGate ? formatValidationGateResult(result.validationGate) : null,
              formatIntegrationTimings(result.timings),
            ].filter(Boolean).join("\n\n"),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "Serial integration accepted.",
            "",
            `Status: ${result.status}`,
            `Source type: ${result.sourceType || "unknown"}`,
            `Source: ${result.source || "not specified"}`,
            `Dry run: ${result.dryRun ? "yes" : "no"}`,
            result.targetMovedSincePreview ? formatIntegrationTargetMove(result.targetMovedSincePreview) : null,
            `Changed files from source: ${result.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
            `Applied files: ${result.appliedFiles?.length ? result.appliedFiles.join(", ") : "none"}`,
            `Pre-existing target changes: ${result.preExistingTargetChanges?.length ? result.preExistingTargetChanges.join(", ") : "none"}`,
            `Dirty target explicitly allowed: ${result.allowDirtyTarget ? "yes (rollback cannot cover unrelated external mutations)" : "no"}`,
            result.patchSha256 ? `Patch SHA-256: ${result.patchSha256}` : null,
            result.sourceBaseCommit ? `Source base commit: ${result.sourceBaseCommit}` : null,
            result.sourceStateSha256 ? `Source state SHA-256: ${result.sourceStateSha256}` : null,
            result.targetStateSha256 ? `Target state SHA-256: ${result.targetStateSha256}` : null,
            result.contractSha256 ? `Integration contract SHA-256: ${result.contractSha256}` : null,
            result.previewReceipt ? `Preview receipt: ${JSON.stringify(result.previewReceipt)}` : null,
            // A dry run printed the whole patch every time (6-13k characters per job) even when
            // the caller had read the diff in the worktree already; stat mode prints line counts.
            previewMode === "stat" && result.patchStat ? `Patch stat (previewMode stat; the receipt covers the full patch):\n${result.patchStat}` : null,
            previewMode !== "stat" && result.patchPreviewMaskedLines?.length ? `Patch preview masks the flagged values on patch lines ${result.patchPreviewMaskedLines.slice(0, 10).join(", ")}${result.patchPreviewMaskedLines.length > 10 ? ", ..." : ""} (acceptFlaggedSecretLines); the receipt covers the full unmasked patch SHA-256.` : null,
            previewMode !== "stat" && result.patchPreview ? `Patch preview:\n${result.patchPreview}` : null,
            previewMode !== "stat" && result.patchPreviewTruncated ? "Patch preview truncated: yes (apply remains blocked on the full patch SHA-256)" : null,
            `Allowed edits: ${normalizeLockPathList(allowedEdits).join(", ")}`,
            `Forbidden edits: ${normalizeLockPathList(forbiddenEdits).length ? normalizeLockPathList(forbiddenEdits).join(", ") : "none specified"}`,
            `Shared files frozen: ${normalizeLockPathList(sharedFiles).length ? normalizeLockPathList(sharedFiles).join(", ") : "none specified"}`,
            result.sourceCleanup ? `Source worktree cleanup: ${result.sourceCleanup.cleanup}` : "Source worktree cleanup: not requested",
            result.sourceCleanup?.branchCleanup ? `Source branch cleanup: ${result.sourceCleanup.branchCleanup}` : null,
            result.sourceCleanup?.reason ? `Source worktree cleanup reason: ${result.sourceCleanup.reason}` : null,
            result.cleanupWarning ? `Cleanup warning: ${result.cleanupWarning}` : null,
            formatValidationGateResult(result.validationGate),
            formatIntegrationTimings(result.timings),
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

function formatIntegrationBatchSummary(result, allowedEditsByItem = []) {
  const items = Array.isArray(result.batchItems) ? result.batchItems : [];
  const itemLines = items.map((item) => {
    const cleanup = item.sourceCleanup ? ` [cleanup: ${item.sourceCleanup.cleanup}${item.sourceCleanup.reason ? ` (${item.sourceCleanup.reason})` : ""}]` : "";
    return `  ${item.index}. ${item.source}: ${item.changedFiles.join(", ")} (patch ${item.patchSha256.slice(0, 12)})${cleanup}`;
  });
  return {
    itemLines,
    scopeLine: `Allowed edits per item: ${allowedEditsByItem.map((edits, index) => `${index + 1}: ${normalizeLockPathList(edits).join(", ")}`).join("; ")}`,
  };
}

server.tool(
  "integrate_opencode_worktrees",
  `Serially integrate SEVERAL disjoint OpenCode worktrees or branches (at most ${INTEGRATION_BATCH_MAX_ITEMS}) as ONE all-or-nothing operation with one receipt. dryRun: true collects and checks every item (scope per item, no two items touching the same path, the combined patch applies) and returns one previewReceipt bound to all of them; the apply passes the same items and arguments plus reviewed: true and that receipt, and either lands every item as one journaled operation (one validationCommand run after all are applied, one rollback if it fails) or applies none. forbiddenEdits, sharedFiles, serialOnly, validationCommand, allowDirtyTarget and cleanupAfterSuccess apply to the whole batch; allowedEdits is per item. A source that changed nothing, or two items writing the same path, refuses the batch. A target HEAD that moves past commits touching none of the patched paths between the dry run and the apply does not invalidate the receipt. Not available for pipeline items (use integrate_opencode_worktree with pipelineId).`,
  {
    cwd: z.string().min(1).describe("Canonical target repository path where the patches should be checked or applied."),
    items: z.array(integrationBatchItemSchema).min(1).max(INTEGRATION_BATCH_MAX_ITEMS).describe(`The worktrees/branches to integrate, in the order they are reviewed (the receipt binds the order). 1 to ${INTEGRATION_BATCH_MAX_ITEMS} items, pairwise disjoint paths.`),
    forbiddenEdits: z.array(z.string()).optional().describe("Paths that must not change in any item."),
    sharedFiles: z.array(z.string()).optional().describe("Shared/frozen paths that must not change in any item."),
    serialOnly: z.array(z.string()).optional().describe("Serial-only paths that must not be integrated as part of a batch."),
    validationCommand: z.string().optional().describe("Command run ONCE after every item is applied. Parsed without a shell. If it fails, no item stays applied."),
    dryRun: z.boolean().optional().describe("Check every item and the combined patch without applying anything; returns the batch previewReceipt."),
    reviewed: z.boolean().optional().describe("Required true for non-dry-run integration after the patches were reviewed."),
    previewReceipt: integrationPreviewReceiptSchema.optional().describe("Exact receipt returned by the batch dry run. Required for apply; valid only for the same items, in the same order, with the same arguments."),
    cleanupAfterSuccess: z.boolean().optional().describe("Remove each source worktree and its local branch after the batch passed a validationCommand. Defaults to true for the worktrees the bridge created; pass false to keep all."),
    allowDirtyTarget: z.boolean().optional().describe("Allow integration into a target repo that already has changes (none of them on the batch's paths). Defaults to false."),
    acceptFlaggedSecretLines: z.boolean().optional().describe("Dry run only: issue the receipt although the secret gate flagged patch lines, after you inspected those lines in the named item's worktree and found no real credential. Defaults to false."),
    acceptBinaryHunks: z.boolean().optional().describe("Dry run only: issue the receipt although the combined patch has binary hunks for files without a known binary extension, after you inspected those files. Defaults to false."),
    previewMode: z.enum(["full", "stat"]).optional().describe("Dry run output: full (default) prints the whole combined patch, subject to the preview size cap; stat prints per-file line counts and the patch SHA-256. The receipt is the same."),
  },
  async ({
    cwd = "",
    items = [],
    forbiddenEdits = [],
    sharedFiles = [],
    serialOnly = [],
    validationCommand = "",
    dryRun = false,
    reviewed = false,
    previewReceipt = null,
    cleanupAfterSuccess = undefined,
    allowDirtyTarget = false,
    acceptFlaggedSecretLines = false,
    acceptBinaryHunks = false,
    previewMode = "full",
  }) => {
    const started = nowMs();
    const targetCwd = cwd || process.cwd();
    const batchItems = (Array.isArray(items) ? items : []).map((item) => ({
      worktreePath: item?.worktreePath || "",
      branch: item?.branch || "",
      allowedEdits: item?.allowedEdits || [],
      cleanup: cleanupAfterSuccess ?? isBridgeGeneratedWorktree(targetCwd, item?.worktreePath),
    }));
    const integrationTimings = {};
    const integrationStarted = nowMs();
    const result = await integrationTimingStorage.run(integrationTimings, () => integratePatchSerially({
      cwd: targetCwd,
      batch: { items: batchItems },
      allowedEdits: batchItems.flatMap((item) => item.allowedEdits),
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      validationCommand,
      dryRun,
      reviewed,
      previewReceipt,
      allowDirtyTarget,
      acceptFlaggedSecretLines,
      acceptBinaryHunks,
      previewMode,
    }));
    result.timings = { totalMs: Math.round(nowMs() - integrationStarted), phases: { ...integrationTimings } };
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "Serial batch integration rejected.",
                errorType: result.errorType || "integration_rejected",
                reason: result.error || "Integration failed.",
                requestedAgent: "merge_manager",
                actualAgent: "none",
                lockMode: "serial_integration",
                durationMs: nowMs() - started,
                conflictingPaths: result.overlappingPaths?.map((conflict) => conflict.path) || result.conflictingPaths || result.disallowedFiles || result.changedFiles || [],
                allowedEdits: normalizeLockPathList(batchItems.flatMap((item) => item.allowedEdits)),
                rollback: result.rollback?.rollback || "",
                rollbackFiles: result.rollback?.rollbackFiles || [],
                unresolvedFiles: result.rollback?.unresolvedFiles || [],
                suggestedFix: result.suggestedFix || "Fix or remove the item named in the reason and dry-run the batch again; nothing was applied unless the reason says an operation needs recovery.",
              }),
              result.batchItemNumbers?.length ? `Batch item number(s) involved: ${result.batchItemNumbers.join(", ")}` : null,
              result.validationGate ? formatValidationGateResult(result.validationGate) : null,
              formatIntegrationTimings(result.timings),
            ].filter(Boolean).join("\n\n"),
          },
        ],
      };
    }

    const summary = formatIntegrationBatchSummary(result, batchItems.map((item) => item.allowedEdits));
    return {
      content: [
        {
          type: "text",
          text: [
            "Serial batch integration accepted.",
            "",
            `Status: ${result.status}`,
            `Items: ${result.batchItems?.length || 0}`,
            `Dry run: ${result.dryRun ? "yes" : "no"}`,
            result.targetMovedSincePreview ? formatIntegrationTargetMove(result.targetMovedSincePreview) : null,
            ...summary.itemLines,
            `Changed files from all items: ${result.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
            `Applied files: ${result.appliedFiles?.length ? result.appliedFiles.join(", ") : "none"}`,
            `Pre-existing target changes: ${result.preExistingTargetChanges?.length ? result.preExistingTargetChanges.join(", ") : "none"}`,
            `Dirty target explicitly allowed: ${result.allowDirtyTarget ? "yes (rollback cannot cover unrelated external mutations)" : "no"}`,
            result.patchSha256 ? `Combined patch SHA-256: ${result.patchSha256}` : null,
            result.sourceBaseCommit ? `Source base commit: ${result.sourceBaseCommit}` : null,
            result.sourceStateSha256 ? `Source state SHA-256 (all items): ${result.sourceStateSha256}` : null,
            result.targetStateSha256 ? `Target state SHA-256: ${result.targetStateSha256}` : null,
            result.contractSha256 ? `Integration contract SHA-256: ${result.contractSha256}` : null,
            result.operationId ? `Integration operation: ${result.operationId} (${result.journalStatus || "unknown"})` : null,
            result.previewReceipt ? `Preview receipt: ${JSON.stringify(result.previewReceipt)}` : null,
            previewMode === "stat" && result.patchStat ? `Patch stat (previewMode stat; the receipt covers the full combined patch):\n${result.patchStat}` : null,
            previewMode !== "stat" && result.patchPreviewMaskedLines?.length ? `Patch preview masks the flagged values on combined patch lines ${result.patchPreviewMaskedLines.slice(0, 10).join(", ")}${result.patchPreviewMaskedLines.length > 10 ? ", ..." : ""} (acceptFlaggedSecretLines); the receipt covers the full unmasked patch SHA-256.` : null,
            previewMode !== "stat" && result.patchPreview ? `Patch preview:\n${result.patchPreview}` : null,
            summary.scopeLine,
            `Forbidden edits: ${normalizeLockPathList(forbiddenEdits).length ? normalizeLockPathList(forbiddenEdits).join(", ") : "none specified"}`,
            `Shared files frozen: ${normalizeLockPathList(sharedFiles).length ? normalizeLockPathList(sharedFiles).join(", ") : "none specified"}`,
            result.sourceCleanup ? `Source worktree cleanup: ${result.sourceCleanup.cleanup} (${result.sourceCleanup.removed} of ${result.sourceCleanup.requested} removed)` : "Source worktree cleanup: not requested",
            result.cleanupWarning ? `Cleanup warning: ${result.cleanupWarning}` : null,
            formatValidationGateResult(result.validationGate),
            formatIntegrationTimings(result.timings),
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

function hasWriteIntent(job) {
  if (job.write === true) {
    return true;
  }

  const scopeContract = normalizeScopeContract(job);
  if (scopeContract?.mode === "write" || scopeContract?.scope.write.length) {
    return true;
  }

  if (job.write === false) {
    return false;
  }

  const agent = String(job.agent || "").trim().toLowerCase();
  const allowedEdits = normalizeList(job.allowedEdits).concat(normalizeList(job.delegation?.allowedEdits));
  const permissions = String(job.delegation?.permissions || "");

  if (agent === "debugger" && (!allowedEdits.length || /read-only/i.test(permissions))) {
    return false;
  }

  if (READ_ONLY_PARALLEL_AGENTS.has(agent)) {
    return false;
  }

  return WRITE_CAPABLE_AGENTS.has(agent);
}

function isOrchestratorAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  return ORCHESTRATOR_AGENT_ALIASES.has(normalized)
    || normalized === MCP_ORCHESTRATOR_AGENT.toLowerCase()
    || normalized === MCP_CONTRACTOR_ORCHESTRATOR_AGENT.toLowerCase();
}

function isManagedReadOnlyAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  return READ_ONLY_PARALLEL_AGENTS.has(normalized)
    || ORCHESTRATOR_AGENT_ALIASES.has(normalized)
    || normalized === MCP_ORCHESTRATOR_AGENT.toLowerCase();
}

function readOnlyRoutingPolicyError(resolution, lockPlan) {
  const actualAgent = String(resolution?.actualAgent || "").trim().toLowerCase();
  if (lockPlan?.lockType === "read" && WRITE_CAPABLE_AGENTS.has(actualAgent)) {
    return {
      errorType: "read_only_proxy_unsafe",
      error: `Read-only agent "${resolution.requestedAgent}" resolved to write-capable agent "${resolution.actualAgent}".`,
      suggestedFix: "Install the requested agent as primary/all or use a managed read-only planner, architect, reviewer, tester, or MCP orchestrator without a write-capable proxy.",
    };
  }
  return null;
}

function requestedOrchestratorMode(job) {
  return String(job.orchestratorMode || job.delegation?.orchestratorMode || "").trim().toLowerCase();
}

function normalizeOrchestratorModeValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["planning", "planning_only", "plan-only", "plan_only", "readonly", "read-only"].includes(raw)) {
    return "planning-only";
  }
  if (["contractor", "broker", "delegated-contractor", "full-delegation"].includes(raw)) {
    return "contractor";
  }
  if (["bounded", "bounded_writer", "bounded-writer", "writer"].includes(raw)) {
    return "bounded-writer";
  }
  return raw;
}

function userAuthorizedOrchestrator(job) {
  return job.userAuthorizedOrchestrator === true || job.delegation?.userAuthorizedOrchestrator === true;
}

function contractorAuthorizationToken(job) {
  return String(job.contractorAuthorizationToken || job.delegation?.contractorAuthorizationToken || "");
}

function effectiveContractorAuthorizationSha256() {
  return process.argv.includes("--self-test") && selfTestContractorAuthorizationSha256
    ? selfTestContractorAuthorizationSha256
    : CONFIG.contractorAuthorizationSha256;
}

// A queued contractor job carries a proof instead of the caller's token. The proof is bound to
// the configured authorization hash as well as the job: rotating or removing
// CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256 revokes every proof minted under the old one.
// Its second half is a keyless binding digest that survives a restart, so recovery (which
// re-mints the process-keyed half) re-authorizes a job only under the hash it was minted with.
function internalQueueContractorBinding(jobId, authorizationSha256) {
  return createHash("sha256").update(`contractor-binding\0${authorizationSha256}\0${jobId}`).digest("hex");
}

function currentContractorAuthorizationSha256() {
  const configured = String(effectiveContractorAuthorizationSha256() || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(configured) ? configured : "";
}

function makeInternalQueueContractorProof(jobId, previousProof = "") {
  const authorizationSha256 = currentContractorAuthorizationSha256();
  if (!authorizationSha256) return "";
  const binding = internalQueueContractorBinding(jobId, authorizationSha256);
  // Re-minting a stored proof (startup recovery) keeps it only when it was minted under the
  // hash configured now.
  if (previousProof && String(previousProof).split(":")[1] !== binding) return "";
  const keyed = createHmac("sha256", QUEUE_CAPABILITY_KEY).update(`contractor\0${authorizationSha256}\0${jobId}`).digest("hex");
  return `${keyed}:${binding}`;
}

function internalQueueContractorProofValid(job) {
  const jobId = String(job?.internalQueueJobId || "");
  const proof = String(job?.internalQueueContractorProof || "");
  if (!jobId || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(proof)) return false;
  const expected = makeInternalQueueContractorProof(jobId);
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(proof, "utf8"), Buffer.from(expected, "utf8"));
}

function contractorAuthorizationValid(job, expectedHash = effectiveContractorAuthorizationSha256()) {
  if (internalQueueContractorProofValid(job)) {
    return true;
  }
  const normalizedExpected = String(expectedHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedExpected)) {
    return false;
  }
  const suppliedHash = createHash("sha256").update(contractorAuthorizationToken(job)).digest("hex");
  return timingSafeEqual(Buffer.from(suppliedHash, "hex"), Buffer.from(normalizedExpected, "hex"));
}

function hasOrchestratorBoundedWriterShape(job) {
  const scopeContract = normalizeScopeContract(job);
  return job.write === true
    || scopeContract?.mode === "write"
    || scopeContract?.scope.write.length > 0
    || normalizeList(job.lockedPaths).length > 0
    || normalizeList(job.ownedPaths).length > 0
    || normalizeList(job.allowedEdits).length > 0
    || normalizeList(job.delegation?.lockedPaths).length > 0
    || normalizeList(job.delegation?.allowedEdits).length > 0;
}

function normalizeOrchestratorMode(job) {
  const raw = requestedOrchestratorMode(job);
  if (!raw) {
    if (!isOrchestratorAgent(job.agent)) {
      return "";
    }
    return hasOrchestratorBoundedWriterShape(job) ? "bounded-writer" : "planning-only";
  }
  return normalizeOrchestratorModeValue(raw);
}

function detectsOrchestratorInternalWriterRequest(task) {
  return /\b(run|spawn|call|invoke|delegate|launch|start|use)\b.{0,50}\b(builder|debugger|writer|write agent|sub-builder|subbuilder|sub-agent|subagent)\b|\b(parallel|concurrent)\b.{0,50}\b(builder|debugger|writer|write agents?)\b/i.test(String(task || ""));
}

function detectsLargeOrchestratorTask(task) {
  const text = String(task || "");
  return /\b(large|complete|entire|full|whole|service|microservice|bounded-writer)\b/i.test(text)
    || /(\bbuild\b|\bimplement\b).{0,80}\b(service|microservice|module|app|feature)\b/i.test(text)
    || /(كبيرة|كاملة|خدمة|سيرفس|مايكروسيرفس|ابني|بناء|نفذ)/i.test(text);
}

function detectsPlanningIntent(task) {
  return /\b(plan|planning|analyze|analyse|architecture|breakdown|proposal)\b|(?:خطط|خطة|حلل|تحليل|قسّم|قسم|معمارية)/i.test(String(task || ""));
}

function findOrchestratorGlobalFileMatches(paths) {
  const normalized = normalizeLockPathList(paths);
  const matches = [...findSerialOnlyMatches(normalized)];
  for (const candidate of normalized) {
    if (/^(packages\/shared|shared)(\/|$)/i.test(candidate)) {
      matches.push(`${candidate} (shared package)`);
    }
  }
  return [...new Set(matches)];
}

function orchestratorPolicyError(job, lockPlan, executionMode = "single") {
  if (!isOrchestratorAgent(job.agent)) {
    return null;
  }

  const mode = lockPlan.orchestratorMode || normalizeOrchestratorMode(job);

  if (mode === "contractor") {
    if (!/^[a-f0-9]{64}$/.test(effectiveContractorAuthorizationSha256())) {
      return {
        errorType: "orchestrator_contractor_disabled",
        error: "OpenCode contractor orchestration is disabled until CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256 is configured.",
        suggestedFix: "Generate a per-installation secret, configure only its SHA-256 hash in the MCP environment, and pass the secret as contractorAuthorizationToken only after explicit user authorization.",
      };
    }
    if (!userAuthorizedOrchestrator(job)) {
      return {
        errorType: "orchestrator_user_authorization_required",
        error: "OpenCode contractor orchestration requires an explicit user authorization flag for this task.",
        suggestedFix: "Use contractor mode only after the user explicitly requests the OpenCode Orchestrator by name, then set userAuthorizedOrchestrator to true.",
      };
    }
    if (!contractorAuthorizationValid(job)) {
      return {
        errorType: "orchestrator_contractor_capability_invalid",
        error: "OpenCode contractor orchestration requires the configured authorization capability in addition to the explicit user flag.",
        suggestedFix: "Pass the correct one-installation contractorAuthorizationToken after explicit user approval. Do not store or log the plaintext token.",
      };
    }
    if (executionMode !== "single") {
      return {
        errorType: "orchestrator_contractor_must_run_alone",
        error: "OpenCode contractor orchestration must run as one outer MCP job because its internal subagents share one aggregate contract.",
        suggestedFix: "Call run_opencode_agent once for the authorized contractor. Do not place contractor mode inside run_opencode_parallel or a multi-job pipeline.",
      };
    }
    if (job.write !== true || lockPlan.lockType !== "write" || !["simple", "strict"].includes(lockPlan.lockMode)) {
      return {
        errorType: "orchestrator_contractor_scope_required",
        error: "OpenCode contractor orchestration requires a bounded write contract with write: true, lockType write, and lockMode simple or strict.",
        suggestedFix: "Provide explicit lockedPaths, allowedEdits, a write Scope Contract, and a validation command for the whole contractor task.",
      };
    }
    return null;
  }

  if (detectsOrchestratorInternalWriterRequest(job.task)) {
    return {
      errorType: "orchestrator_write_visibility_risk",
      error: "OpenCode orchestrator cannot run, spawn, invoke, or delegate to internal writer agents because nested writers would bypass MCP per-writer locks.",
      suggestedFix: "Use direct builder/debugger jobs with explicit Scope Contracts so MCP can enforce per-writer locks and changed-file validation.",
    };
  }

  if (mode === "planning-only") {
    if (job.write === true || lockPlan.lockType !== "read" || lockPlan.lockMode !== "off" || lockPlan.allowedEdits.length) {
      return {
        errorType: "orchestrator_write_forbidden",
        error: "OpenCode orchestrator planning-only mode cannot write files.",
        suggestedFix: "Run the orchestrator as planning-only, then delegate each approved write task directly to builder/debugger with an explicit Scope Contract.",
      };
    }
    return null;
  }

  if (mode === "bounded-writer") {
    return {
      errorType: "orchestrator_write_visibility_risk",
      error: "OpenCode orchestrator cannot be used as a MCP-managed writer in strict safety mode because MCP only observes the outer orchestrator process.",
      suggestedFix: "Run orchestrator as planning-only, then call direct builder/debugger jobs with explicit Scope Contracts.",
    };
  }

  return {
    errorType: "orchestrator_large_task_requires_mode",
    error: `Invalid orchestratorMode "${mode}". Use planning-only or explicitly authorized contractor mode.`,
    suggestedFix: "Use planning-only by default. Use contractor mode with userAuthorizedOrchestrator true only after an explicit user request by name.",
  };
}

const { normalizeLockType, normalizeLockMode, createLockPlan, directExecutionLockConflictDetails, validateScopeContract, sanitizedJobPolicyError, parallelBatchCapacityError, validateParallelWritePlan, SELF_CHECK_MAX_COMMANDS, SELF_CHECK_FORBIDDEN_CHARACTERS, SELF_CHECK_INTERPRETERS, SELF_CHECK_DEFAULT_PASSES, SELF_CHECK_MAX_PASSES, selfCheckCommandsError, queueOnlyOptionsError, validationFixPassError, validateSingleLockPlan } = createLockPlanRuntime({
  CONFIG,
  hasWriteIntent,
  normalizeOrchestratorMode,
  userAuthorizedOrchestrator,
  contractorAuthorizationValid,
  READ_ONLY_PARALLEL_AGENTS,
  PARALLEL_LOCK_TYPES,
  WRITE_CAPABLE_AGENTS,
  hardLockPathsForPlan,
  orchestratorPolicyError,
  validationCommandTrustError,
});






function sanitizedDiscoveryContext(job = {}) {
  const forcePure = Boolean(job.sanitizedWorkspace);
  return {
    forcePure,
    routeToSanitizedAgent: forcePure,
    // Manifest verification must precede this call. Attest the exact cwd whose
    // effective project/agent configuration the subsequent run will use.
    discoveryCwd: job.cwd,
  };
}

async function verifySanitizedJobsBeforeDiscovery(jobs, phase) {
  const verifications = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const contract = jobs[index]?.sanitizedWorkspace;
    if (!contract) continue;
    const verification = await verifySanitizedWorkspace(contract, phase);
    verifications[index] = verification;
    if (!verification.ok) {
      return { ok: false, index, verification, verifications };
    }
  }
  return { ok: true, index: -1, verification: null, verifications };
}


function parallelProviderKeys(resolutions = [], metadataResults = [], lockPlans = []) {
  return resolutions.map((resolution, index) => {
    const metadata = metadataResults[index]?.metadata || null;
    if (!metadata) return "";
    const override = allowlistedModelOverride(lockPlans[index]?.scopeContract?.modelRequirement, resolution?.actualAgent || lockPlans[index]?.agent);
    return providerKeyForMetadata(applyModelOverrideToMetadata(metadata, override));
  });
}








function jobAgentRuntime() {
  const hook = process.argv.includes("--self-test") ? agentRuntimeTestHook : null;
  return {
    resolveAgent: hook?.resolveAgent || resolveAgent,
    readAgentDebugMetadata: hook?.readAgentDebugMetadata || readAgentDebugMetadata,
    runOpenCodeWithPolicy: hook?.runOpenCodeWithPolicy || runOpenCodeWithPolicy,
  };
}

const { VALIDATION_FIX_MIN_REMAINING_MS, VALIDATION_FIX_OUTPUT_CHARS, agentProcessMsOf, buildValidationFixPrompt, buildSelfCheckFixPrompt, selfCheckFailureSummary, selfCheckPassSkipReason, formatSelfCheck, validationFixPassSkipReason, mergeValidationFixRuns, formatValidationFixPass, readOnlyEditsDeniedByAttestation, readOnlyWorkspaceDrift, formatReadOnlyWorkspaceDrift, executeOpenCodeJob } = createExecuteJobRuntime({ CONFIG, DEFAULT_SUBAGENT_PROXY_AGENT, OPENCODE_EXE, SELF_CHECK_DEFAULT_PASSES, VALIDATION_PREFLIGHT_FIX, abortSignalErrorType, acquireHardLock, agentMetadataPolicyOptions, applyGitControlSurfaceCheck, attestContractorNestedAgents, buildCompactPrompt, buildSubagentProxyPrompt, callerPathSpellings, captureGitHead, changedFileValidationErrorType, changedFilesBetween, changedPathSetEvidence, cleanupWorktree, collectWorktreeDiff, combineAbortSignals, compactJobLines, conflictPathsFromConflict, containmentRecord, createPhaseClock, createWorktreeForJob, directExecutionLockConflictDetails, dirtyCheckpointDetails, effectiveQueueWriteConflictPolicy, effectiveReadOnlyMetadataError, fitRedactedJobResult, formatRejectedExecution, formatSingleResultParts, formatWorktreeSummary, gitChangedFileSnapshot, gitControlSurfaceFingerprint, hardLockPathsForPlan, hardLockSummary, hardLockTtlForPlan, hasWriteIntent, jobAgentRuntime, logEvent, makeQueueJobId, mergeHeavyToolCalls, nowMs, openCodeCommandLineLengthError, openCodeRunArgs, patchPreviewOmittedLine, quarantineHardLock, readAgentDefinition, readOnlyHeadMove, readOnlyRoutingPolicyError, recordChangedFiles, releaseHardLock, runValidationGate, sanitizedAgentMetadataError, sanitizedDiscoveryContext, sanitizedRoutingPolicyError, shouldUseWorktree, startHardLockHeartbeat, timeoutForAgent, truncateText, updateRetainedWorktreeMeasurement, validateChangedFilesForPlan, validateSingleLockPlan, validationCommandPreflightError, verifyJobWorkspaceReadiness, verifySanitizedWorkspace });

function queueRunStage(record) {
  if (record.status !== "running") {
    // Q-007: a retry that waits for the provider/model pause of every candidate model to end.
    if (["pending", "planned"].includes(record.status) && queueStartAfterPending(record)) return "waiting_for_provider_pause";
    // B-045: a pending job held back by the free-memory floor (jobs of this process only).
    return ["pending", "planned"].includes(record.status) && queueMemoryWaitingJobs.has(record.jobId)
      ? "waiting_for_memory"
      : record.status || "";
  }
  // Before the agent process starts the bridge checks the workspace, creates the worktree,
  // attests the role (several `opencode` calls), snapshots the tree and waits for a provider slot;
  // phaseTimings on the finished record splits these, providerWaitMs is the slot wait alone.
  if (record.childProcessStartedAt) return "agent_running";
  // Known only for jobs this process runs; a job owned by another bridge stays starting_agent.
  return providerSlotWaitingJobs.has(record.jobId) ? "waiting_for_provider_slot" : "starting_agent";
}


// B-046: last output of a running agent. Derived when read, never stored: a stored value would be
// stale the moment it was written. Empty for jobs of another bridge process and for jobs whose
// agent is not running.
function queueAgentActivity(record, now = Date.now()) {
  if (queueRunStage(record) !== "agent_running") return {};
  const lastMs = agentActivityByJobId.get(record.jobId);
  if (!Number.isFinite(lastMs)) return {};
  return { lastActivityAt: new Date(lastMs).toISOString(), idleMs: Math.max(0, now - lastMs) };
}

const {
  queueRecordSnapshot,
  queuePrivateDetails,
  queueRecordDurableSummary,
  encryptQueuePrivateDetails,
  decryptQueuePrivateDetails,
  enforceQueueResultEvidence,
  persistedQueueRecordFromRow,
  loadPersistedQueueRecord,
  applyDurableCancellationOutcome,
  cancelPersistedQueueJob,
  heartbeatOnlyQueueAdvance,
  persistTerminalQueueRecord,
  persistQueueRecord,
  updateQueueRecordDurable,
  readPersistedQueueRecord,
  listPersistedQueueRecords,
  authoritativeQueueRecord,
} = createQueueStoreRuntime({
  CONFIG,
  BRIDGE_INSTANCE_ID,
  QUEUE_JOBS,
  queueRunStage: (...args) => queueRunStage(...args),
  truncateResultText,
  truncateText,
  encryptIntegrationJournalBytes,
  decryptIntegrationJournalBytes,
  effectiveQueueMode,
  openLockDb,
  closeDb,
  stateCapacityError,
  propagatePipelineTerminalInTransaction: (...args) => propagatePipelineTerminalInTransaction(...args),
  getQueueCancellationTestHook: () => queueCancellationTestHook,
  getQueuePersistTestHook: () => queuePersistTestHook,
});











function propagatePipelineTerminalInTransaction(db, childJobId, terminalStatus, at = new Date().toISOString()) {
  const relation = db.prepare(`
    SELECT relation.pipeline_id
    FROM opencode_pipeline_children AS relation
    WHERE relation.job_id = ?
  `).get(childJobId);
  if (!relation?.pipeline_id) return null;
  const parent = db.prepare(`
    SELECT status FROM opencode_pipelines WHERE pipeline_id = ?
  `).get(relation.pipeline_id);
  if (!parent || !["planned", "running"].includes(parent.status)) {
    return {
      pipelineId: relation.pipeline_id,
      terminalStatus,
      parentStatus: parent?.status || "missing",
      allChildrenTerminal: false,
    };
  }

  const aggregate = db.prepare(`
    SELECT
      SUM(CASE WHEN job.status IN ('failed', 'interrupted', 'not_resumable') THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN job.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
      SUM(CASE WHEN job.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'not_resumable') THEN 1 ELSE 0 END) AS active_count
    FROM opencode_pipeline_children AS relation
    JOIN opencode_jobs AS job ON job.job_id = relation.job_id
    WHERE relation.pipeline_id = ?
  `).get(relation.pipeline_id);
  const failedCount = Number(aggregate?.failed_count || 0);
  const cancelledCount = Number(aggregate?.cancelled_count || 0);
  const activeCount = Number(aggregate?.active_count || 0);
  const parentStatus = failedCount > 0 ? "failed" : cancelledCount > 0 ? "cancelled" : "";

  if (parentStatus) {
    db.prepare(`
      UPDATE opencode_jobs
      SET status = 'cancelled', finished_at = ?, cancellation_requested_at = ?, updated_at = ?,
          heartbeat_at = '', lease_expires_at = '', child_process_id = 0, child_process_started_at = '',
          record_json = json_set(
            CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END,
            '$.status', 'cancelled', '$.finishedAt', ?, '$.cancellationRequested', 1,
            '$.cancellationRequestedAt', ?, '$.errorType', 'agent_cancelled'
          ),
          revision = revision + 1
      WHERE job_id IN (
        SELECT sibling.job_id FROM opencode_pipeline_children AS sibling
        WHERE sibling.pipeline_id = ? AND sibling.job_id <> ?
      )
        AND status IN ('held', 'pending', 'planned', 'blocked')
    `).run(at, at, at, at, at, relation.pipeline_id, childJobId);
    db.prepare(`
      UPDATE opencode_jobs
      SET cancellation_requested_at = CASE
            WHEN cancellation_requested_at IS NULL OR cancellation_requested_at = '' THEN ?
            ELSE cancellation_requested_at
          END,
          updated_at = ?,
          record_json = json_set(
            CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END,
            '$.cancellationRequested', 1, '$.cancellationRequestedAt', ?
          ),
          revision = revision + 1
      WHERE job_id IN (
        SELECT sibling.job_id FROM opencode_pipeline_children AS sibling
        WHERE sibling.pipeline_id = ? AND sibling.job_id <> ?
      )
        AND status IN ('running', 'validating', 'reviewing', 'testing')
    `).run(at, at, at, relation.pipeline_id, childJobId);
    db.prepare(`
      UPDATE opencode_pipelines
      SET status = ?, updated_at = ?,
          record_json = json_set(
            CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END,
            '$.status', ?, '$.finishedAt', ?
          ),
          revision = revision + 1
      WHERE pipeline_id = ? AND status IN ('planned', 'running')
    `).run(parentStatus, at, parentStatus, at, relation.pipeline_id);
  }

  return {
    pipelineId: relation.pipeline_id,
    terminalStatus,
    parentStatus,
    allChildrenTerminal: activeCount === 0,
  };
}



// Test-only: runs before every queue persistence write (a throw simulates SQLITE_BUSY).
let queuePersistTestHook = null;



function queueLockPathsForRecord(record) {
  const paths = record.mode === "read"
    ? firstNonEmptyList(record.lockedPaths, record.scopeContract?.scope?.read, [REPOSITORY_SCOPE_LOCK_PATH])
    : firstNonEmptyList(record.allowedEdits, record.lockedPaths);
  return normalizeLockPathListForCwd(paths, record.cwd || "");
}

function runningQueueRecords() {
  return [...QUEUE_JOBS.values()].filter((record) => ["running", "validating", "reviewing", "testing"].includes(record.status));
}

async function persistedRunningQueueRecords(cwd = "") {
  if (effectiveQueueMode() !== "sqlite") {
    return [];
  }

  const db = await openLockDb(cwd);
  try {
    const rows = db.prepare(
      "SELECT record_json FROM opencode_jobs WHERE status IN ('running', 'validating', 'reviewing', 'testing')"
    ).all();
    return rows.flatMap((row) => {
      try {
        return row.record_json ? [JSON.parse(row.record_json)] : [];
      } catch {
        return [];
      }
    });
  } finally {
    closeDb(db);
  }
}

async function findQueueWriteConflict(record) {
  const cwdKey = path.resolve(record.cwd || process.cwd());
  const runningById = new Map(runningQueueRecords().map((running) => [running.jobId, running]));
  if (effectiveQueueMode() === "sqlite") {
    for (const persisted of await persistedRunningQueueRecords(cwdKey)) {
      if (!runningById.has(persisted.jobId)) {
        runningById.set(persisted.jobId, persisted);
      }
    }
  }

  for (const running of runningById.values()) {
    if (running.jobId === record.jobId) {
      continue;
    }
    if (record.mode === "read" && running.mode === "read") {
      continue;
    }

    if (!recordMatchesProject(running, cwdKey)) {
      continue;
    }

    const conflict = conflictsWithActiveLock(
      { lockType: record.mode === "read" ? "read" : "write", paths: queueLockPathsForRecord(record) },
      { id: running.jobId, owner: running.ownerInstanceId || "queue", agent: running.agent, lockType: running.mode === "read" ? "read" : "write", paths: queueLockPathsForRecord(running) }
    );
    if (conflict) {
      if (!QUEUE_JOBS.has(running.jobId)) {
        const activeLocks = await listLocks(cwdKey);
        const activeOverlap = activeLocks.some((lock) => conflictsWithActiveLock(
          { lockType: record.mode === "read" ? "read" : "write", paths: queueLockPathsForRecord(record) },
          lock
        ));
        if (!activeOverlap) {
          continue;
        }
      }
      return {
        jobId: running.jobId,
        paths: conflict.overlap,
        source: "queue",
        errorType: "write_lock_conflict",
        reason: `Waiting for queued write job ${running.jobId} to release: ${(conflict.overlap || []).join(", ")}`,
      };
    }
  }

  return await findQueueRecordRepositoryBlock(record, cwdKey);
}

// What acquireHardLock would refuse for this record, read without taking anything: an
// unresolved integration operation of the repository (writers only) and active hard locks
// from direct runs, manual locks, integrations and finalizers. Without it the scheduler
// claimed the job and ran agent discovery and attestation before the lock failed, every
// poll, and reported every refusal as a queue lock conflict.
async function findQueueRecordRepositoryBlock(record, cwdKey = path.resolve(record.cwd || process.cwd())) {
  // A dry run never takes a hard lock, so nothing here could refuse it.
  if (record.dryRun || record.request?.dryRun) return null;
  const lockType = record.mode === "read" ? "read" : "write";
  const request = { lockType, paths: queueLockPathsForRecord(record), origin: "internal" };
  const db = await openLockDb(cwdKey);
  try {
    if (lockType !== "read") {
      const comparableRoot = normalizeFilesystemCase(path.resolve(cwdKey));
      const operation = db.prepare(`
        SELECT operation_id, cwd, status FROM integration_operations
        WHERE status NOT IN (${INTEGRATION_RESOLVED_SQL})
        ORDER BY updated_at, operation_id
      `).all().find((row) => normalizeFilesystemCase(path.resolve(row.cwd || "")) === comparableRoot);
      if (operation) {
        return {
          jobId: "",
          operationId: operation.operation_id,
          operationStatus: operation.status,
          paths: [REPOSITORY_SCOPE_LOCK_PATH],
          source: "integration",
          errorType: "integration_recovery_pending",
          reason: operation.status === "quarantined"
            ? `Waiting for quarantined integration operation ${operation.operation_id} of this repository to be recovered; see diagnose_opencode_bridge, and resolve_integration_quarantine if it does not clear.`
            : `Waiting for integration operation ${operation.operation_id} (${operation.status}) of this repository to finish.`,
        };
      }
    }
    for (const lock of listLocksFromDb(db)) {
      const conflict = conflictsWithActiveLock(request, lock);
      if (!conflict) continue;
      const overlap = (conflict.overlap || []).filter(Boolean);
      return {
        jobId: "",
        lockId: lock.id,
        paths: overlap.length ? overlap : conflict.paths || [],
        source: "lock",
        errorType: "write_lock_conflict",
        reason: `Waiting for the active ${lock.origin || "legacy"} ${lock.lockType} lock ${lock.id} (${lock.agent || "unknown"}) to release: ${(overlap.length ? overlap : conflict.paths || []).join(", ") || "the repository"}`,
      };
    }
    return null;
  } finally {
    closeDb(db);
  }
}

async function assessQueuePlan(lockPlans = []) {
  if (effectiveQueueMode() === "off") {
    return {
      status: "disabled",
      reason: "Queue mode is off.",
      conflictingPaths: [],
    };
  }

  for (const plan of lockPlans) {
    const candidate = {
      jobId: plan.jobId || "",
      mode: plan.lockType === "read" ? "read" : "write",
      cwd: plan.cwd,
      lockedPaths: plan.lockedPaths,
      allowedEdits: plan.allowedEdits,
      // The scheduler judges a reader by its read scope; without it a reader with no locked
      // paths counts as the whole repository and "must wait" for every writer.
      scopeContract: plan.scopeContract,
    };
    const conflict = await findQueueWriteConflict(candidate);
    if (conflict) {
      return {
        status: effectiveQueueWriteConflictPolicy() === "reject" ? "conflict" : "must_wait",
        reason: conflict.source === "queue"
          ? `Queued/running write job ${conflict.jobId} overlaps this plan on ${(conflict.paths || []).join(", ") || "the repository"}.`
          : `${conflict.reason}.`,
        conflictingPaths: conflict.paths,
      };
    }
  }

  return {
    status: "can_run_immediately",
    reason: "No queue write conflict detected.",
    conflictingPaths: [],
  };
}

async function enqueueQueueJob(job, parentJobId = "", { schedule = true, initialStatus = "pending", persist = true, recordFields = null } = {}) {
  if (effectiveQueueMode() === "off") {
    return {
      ok: false,
      errorType: "queue_disabled",
      error: "CODEX_OPENCODE_QUEUE_MODE is off.",
      suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=memory or sqlite, or call run_opencode_agent directly.",
    };
  }

  // Q-007: a retry policy (models / maxAttempts) is checked first and pins the first model.
  const retryPolicy = applyRetryPolicyToJob(job, parentJobId);
  if (!retryPolicy.ok) {
    return {
      ok: false,
      errorType: retryPolicy.errorType,
      error: retryPolicy.error,
      suggestedFix: retryPolicy.suggestedFix || "Fix models/maxAttempts (provider/model[@variant] entries from CODEX_OPENCODE_MODEL_ALLOWLIST, 1 to 10 attempts) and enqueue again.",
    };
  }
  job = retryPolicy.job;
  const normalizedJob = await normalizeJobCwd(job);
  const { error, errorType, suggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(normalizedJob);
  if (error || (hasWriteIntent(normalizedJob) && lockPlan.lockType === "read")) {
    return {
      ok: false,
      errorType: errorType || "lock_plan_rejected",
      error: error || `Write-capable agent "${normalizedJob.agent}" requires lockedPaths so the bridge can create a temporary write lock.`,
      suggestedFix: suggestedFix || "Fix the Scope Contract, lockMode, lockedPaths, and allowedEdits before enqueueing.",
      serialOnlyMatches,
      lockPlan,
    };
  }
  if (!normalizedJob.dryRun && lockPlan.lockType !== "read" && !shouldUseWorktree(normalizedJob, lockPlan)) {
    return {
      ok: false,
      errorType: "queue_write_requires_worktree",
      error: "Durable queued writers require retained Git worktree isolation so an orphaned child cannot modify the target checkout.",
      suggestedFix: "Set CODEX_OPENCODE_WORKTREE_MODE=write or all and restart the bridge before enqueueing write jobs.",
      lockPlan,
    };
  }
  const autoIntegrateError = autoIntegrateJobError(normalizedJob, lockPlan, parentJobId);
  if (autoIntegrateError) return { ok: false, ...autoIntegrateError, lockPlan };

  const now = new Date().toISOString();
  const jobId = makeQueueJobId(job.agent);
  const idempotencyKey = String(job.idempotencyKey || "").trim();
  const safeRequest = { ...normalizedJob };
  delete safeRequest.idempotencyKey;
  delete safeRequest.contractorAuthorizationToken;
  if (safeRequest.delegation) {
    safeRequest.delegation = { ...safeRequest.delegation };
    delete safeRequest.delegation.contractorAuthorizationToken;
  }
  if (lockPlan.orchestratorMode === "contractor") {
    safeRequest.internalQueueJobId = jobId;
    safeRequest.internalQueueContractorProof = makeInternalQueueContractorProof(jobId);
  }
  const requestEncrypted = effectiveQueueMode() === "sqlite"
    ? await encryptQueueRequest(safeRequest, jobId)
    : "";
  const requestFingerprint = queueRequestFingerprint(safeRequest);
  const record = {
    jobId,
    parentJobId,
    request: safeRequest,
    cwd: normalizedJob.cwd,
    agent: normalizedJob.agent,
    task: normalizedJob.task,
    idempotencyKey,
    requestEncrypted,
    requestFingerprint,
    mode: lockPlan.lockType === "read" ? "read" : "write",
    scopeContract: lockPlan.scopeContract || null,
    sanitizedWorkspace: normalizedJob.sanitizedWorkspace || null,
    sanitizedWorkspaceVerification: null,
    lockMode: lockPlan.lockMode,
    lockedPaths: lockPlan.lockedPaths,
    allowedEdits: lockPlan.allowedEdits,
    status: initialStatus === "held" ? "held" : "pending",
    createdAt: now,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    retryCount: 0,
    maxRetries: 0,
    errorType: "",
    errorReason: "",
    changedFiles: [],
    dirtyFiles: [],
    overlappingFiles: [],
    disjointFiles: [],
    validationResult: null,
    configuredProvider: "",
    configuredModel: "",
    configuredVariant: "",
    runtimeObservedProvider: "",
    runtimeObservedModel: "",
    actualProvider: "",
    actualModel: "",
    actualModelEvidence: "",
    dependencyRequest: null,
    resultText: "",
    worktreePath: "",
    worktreeBranch: "",
    worktreeBaseCommit: "",
    worktreeBaseTree: "",
    worktreePatchSha256: "",
    worktreeSourceStateSha256: "",
    ownerInstanceId: BRIDGE_INSTANCE_ID,
    ownerProcessId: process.pid,
    ownerGeneration: randomBytes(12).toString("hex"),
    heartbeatAt: now,
    leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    cancellationRequested: false,
    cancellationRequestedAt: "",
    childProcessId: 0,
    childProcessStartedAt: "",
    childProcessRole: "",
    childContainmentIdentity: "",
    containmentQuarantined: false,
    revision: 0,
    // Q-007: attempt counters of a retry policy (a requeue by the policy passes the next ones).
    ...(retryPolicy.policy ? { retryAttempt: 1, maxAttempts: retryPolicy.policy.maxAttempts } : {}),
    ...(normalizedJob.autoIntegrate === true ? { autoIntegrateRequested: true } : {}),
  };
  // Lineage fields of a requeued job (requeuedFrom, requeueSequence); set before the first write.
  if (recordFields) Object.assign(record, recordFields);
  // B-078: a new job whose every model is paused waits for the first pause to end instead of
  // failing its first attempt at the slot. The request keeps its first model (the idempotency
  // fingerprint must not depend on the pauses of the moment); a requeue chose its own start.
  if (!recordFields && retryPolicy.policy?.models?.length && !normalizedJob.dryRun) {
    const first = await chooseRetryModel(retryPolicy.policy, 0).catch(() => ({ startAfter: "" }));
    if (first.startAfter) Object.assign(record, { startAfter: first.startAfter, startAfterReason: "provider_pause" });
  }
  if (!record.startAfter) {
    delete record.startAfter;
    delete record.startAfterReason;
  }

  if (!persist) return { ok: true, record, prepared: true };

  const persistence = await persistQueueRecord(record);
  if (persistence.idempotencyConflict) {
    return {
      ok: false,
      errorType: "queue_idempotency_conflict",
      error: `Idempotency key already belongs to job ${persistence.jobId} with different request content.`,
      suggestedFix: "Reuse a key only for the exact same logical request, or generate a new key for changed work.",
    };
  }
  if (persistence.deduplicated) {
    const existing = await readPersistedQueueRecord(persistence.jobId, normalizedJob.cwd);
    return { ok: true, record: existing, deduplicated: true };
  }
  if (!persistence.persisted) {
    return {
      ok: false,
      errorType: persistence.errorType || "queue_persistence_failed",
      error: persistence.error || "The queue request was not durably accepted.",
    };
  }
  QUEUE_JOBS.set(jobId, record);
  if (schedule) {
    scheduleQueue();
  }
  return { ok: true, record };
}











// Active pauses by key (until, epoch ms), from the shared provider database.
async function activeProviderPauses() {
  const snapshot = await providerCapacitySnapshot();
  const pauses = new Map();
  for (const item of snapshot.cooldowns || []) {
    if (Number(item.remainingMs) > 0) pauses.set(item.providerKey, Date.parse(item.until));
  }
  return pauses;
}





// Self-test only: stands in for CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED (CONFIG is frozen).
let autoResumeInterruptedOverride = null;



// Q-010: auto-integration of new-file-only patches (the round-6 orchestrator's LANDED step). Up to
// 300 batches each needed a dry run, an apply and a receipt. A queued writer that asks for it
// (autoIntegrate: true) and finished with a passing validationCommand is integrated by the bridge
// itself, but only when every file of its patch is new: the dry run and the receipt-bound apply
// are the integrate_opencode_worktree engine (scope, secret and binary gates, serial lock,
// journal, validation in the target, rollback, worktree cleanup), called back to back. The files
// are then committed by explicit pathspec with the identity of the target's last commit. Jobs of
// one repository are integrated one at a time (AUTO_INTEGRATION_CHAINS); any other patch is left
// for the normal reviewed flow.
function autoIntegrateJobError(job, lockPlan, parentJobId = "") {
  if (job?.autoIntegrate === undefined || job.autoIntegrate === null || job.autoIntegrate === false) return null;
  const refuse = (errorType, error, suggestedFix = "Remove autoIntegrate, or enqueue a write job with a validationCommand.") => ({ errorType, error, suggestedFix });
  if (job.autoIntegrate !== true) return refuse("auto_integrate_invalid", "autoIntegrate must be true or false.");
  if (effectiveQueueMode() !== "sqlite") return refuse("auto_integrate_not_applicable", `autoIntegrate needs CODEX_OPENCODE_QUEUE_MODE=sqlite (the queue mode is ${effectiveQueueMode()}): its outcome is recorded on the durable job.`);
  if (!CONFIG.autoIntegrateAllowed) return refuse("auto_integrate_disabled", "The operator turned auto-integration off (CODEX_OPENCODE_AUTO_INTEGRATE=false); every patch goes through the reviewed integration.", "Remove autoIntegrate and integrate the worktree with integrate_opencode_worktree.");
  if (parentJobId) return refuse("auto_integrate_not_applicable", "A pipeline integrates its jobs itself.");
  if (lockPlan?.lockType === "read" || job.sanitizedWorkspace || job.dryRun) return refuse("auto_integrate_not_applicable", "autoIntegrate applies to write jobs that run (not read-only, sanitized or dry-run jobs).");
  if (!String(lockPlan?.validationCommand || "").trim()) return refuse("auto_integrate_needs_validation", "autoIntegrate needs a validationCommand: a patch lands without review only after its validation passed in the worktree and passes again in the target.");
  return null;
}

const AUTO_INTEGRATION_CHAINS = new Map();
// Jobs whose auto-integration waits for a lock and will be tried again by a timer of this process.
const AUTO_INTEGRATION_WAITING = new Set();
const AUTO_INTEGRATION_RETRYABLE_ERRORS = new Set(["integration_lock_conflict", "integration_preview_stale", "integration_recovery_pending"]);
// A few quick rounds for a receipt that went stale between the two calls; a lock held by another
// writer on the same paths (a builder still running on the folder) can last as long as that
// builder, so the job then waits outside the repository's chain and tries again later, for up to
// AUTO_INTEGRATION_LATER_MAX tries (an hour by default).
const AUTO_INTEGRATION_ROUNDS = 3;
const AUTO_INTEGRATION_LATER_MAX = 60;

function autoIntegrationLaterDelayMs() {
  return process.argv.includes("--self-test") ? 150 : 60_000;
}

// B-069: the commit of an auto-integration, made INSIDE the integration's serial lock (the
// engine calls these hooks after its journal operation committed and validation passed): `prepare`
// runs before the worktree cleanup and hashes each applied file of the reviewed source worktree
// (the engine just re-verified it against the receipt) with the target's attributes; `commit`
// runs after the cleanup, hashes the same paths in the target (git hash-object -w --path), refuses
// any difference, builds the tree in a temporary index (GIT_INDEX_FILE: the owner's index is not
// used for it), creates the commit with commit-tree as the author of the target's last commit and
// moves HEAD with update-ref against the expected old HEAD. Only then are exactly these paths set
// in the owner's index to the committed blobs (git update-index --cacheinfo), so `git status`
// agrees with HEAD; nothing else in the index or the working tree is touched. The paths are the
// engine's changedFiles (read with -z), never re-parsed patch headers.
const AUTO_INTEGRATION_EMPTY_INDEX_RETRIES = 5;

function autoIntegrationCommitHooks({ jobId, agent = "", model = "", worktreePath }) {
  const git = (args, cwd, env = null) => runCommand("git", args, cwd, 60_000, env);
  return {
    async prepare(result, { targetCwd }) {
      const files = [];
      for (const relative of result.changedFiles || []) {
        const sourceFile = path.join(worktreePath, ...String(relative).split("/"));
        const details = await lstat(sourceFile).catch(() => null);
        if (!details?.isFile()) return { ok: false, errorType: "auto_integration_source_unreadable", error: `The source file ${relative} is not a regular file.` };
        const hashed = await git(["hash-object", "--path", relative, sourceFile], targetCwd);
        if (hashed.exitCode !== 0) return { ok: false, errorType: "auto_integration_hash_failed", error: redactSensitiveText(hashed.stderr).slice(0, 300) };
        const executable = process.platform !== "win32" && (details.mode & 0o111) !== 0;
        files.push({ path: relative, blob: hashed.stdout.trim(), mode: executable ? "100755" : "100644" });
      }
      return files.length ? { ok: true, files } : { ok: false, errorType: "auto_integration_no_files", error: "The integration reported no changed files." };
    },
    async commit(result, { targetCwd, prepared }) {
      if (!prepared?.ok) return prepared || { ok: false, errorType: "auto_integration_not_prepared", error: "The source files were not hashed before cleanup." };
      for (const file of prepared.files) {
        const targetFile = path.join(targetCwd, ...file.path.split("/"));
        const written = await git(["hash-object", "-w", "--path", file.path, targetFile], targetCwd);
        if (written.exitCode !== 0) return { ok: false, errorType: "auto_integration_hash_failed", error: redactSensitiveText(written.stderr).slice(0, 300) };
        if (written.stdout.trim() !== file.blob) {
          return { ok: false, errorType: "auto_integration_content_mismatch", error: `${file.path} in the checkout is not the reviewed content (blob ${written.stdout.trim().slice(0, 12)}, expected ${file.blob.slice(0, 12)}); nothing was committed.` };
        }
      }
      const identity = await git(["log", "-1", "--format=%an%x00%ae"], targetCwd);
      const [name = "", email = ""] = String(identity.stdout || "").trim().split("\0");
      if (identity.exitCode !== 0 || !name.trim() || !email.trim()) {
        return { ok: false, errorType: "auto_integration_identity_missing", error: "The target repository's last commit has no author name and email to commit with." };
      }
      const oldHead = (await git(["rev-parse", "--verify", "HEAD^{commit}"], targetCwd)).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(oldHead)) return { ok: false, errorType: "auto_integration_head_unreadable", error: "The target HEAD could not be read." };
      const scratch = await mkdtemp(path.join(tmpdir(), "codex-auto-integrate-index-"));
      try {
        const indexEnv = { GIT_INDEX_FILE: path.join(scratch, "index") };
        const steps = [["read-tree", oldHead], ...prepared.files.map((file) => ["update-index", "--add", "--cacheinfo", `${file.mode},${file.blob},${file.path}`])];
        for (const step of steps) {
          const done = await git(step, targetCwd, indexEnv);
          if (done.exitCode !== 0) return { ok: false, errorType: "auto_integration_index_failed", error: redactSensitiveText(done.stderr).slice(0, 300) };
        }
        const tree = (await git(["write-tree"], targetCwd, indexEnv)).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/i.test(tree)) return { ok: false, errorType: "auto_integration_index_failed", error: "git write-tree returned no tree." };
        const message = `Auto-integrate ${jobId}: ${prepared.files.length} new file(s) by ${agent || "agent"}${model ? ` on ${model}` : ""}`;
        const created = await git(["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`, "commit-tree", tree, "-p", oldHead, "-m", message], targetCwd);
        const commit = created.stdout.trim();
        if (created.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) return { ok: false, errorType: "auto_integration_commit_failed", error: redactSensitiveText(created.stderr).slice(0, 300) };
        const moved = await git(["update-ref", "-m", `auto-integrate ${jobId}`, "HEAD", commit, oldHead], targetCwd);
        if (moved.exitCode !== 0) return { ok: false, errorType: "auto_integration_head_moved", error: `HEAD moved while committing; nothing was committed (${redactSensitiveText(moved.stderr).slice(0, 200)}).` };
        // The owner's index: exactly these paths, to the committed blobs (a concurrent git is retried).
        let indexed = null;
        for (let attempt = 0; attempt < AUTO_INTEGRATION_EMPTY_INDEX_RETRIES; attempt += 1) {
          if (attempt) await delayWithSignal(process.argv.includes("--self-test") ? 50 : 3000);
          indexed = await git(["update-index", "--add", ...prepared.files.flatMap((file) => ["--cacheinfo", `${file.mode},${file.blob},${file.path}`])], targetCwd);
          if (indexed.exitCode === 0 || !/index\.lock|unable to lock|cannot lock|File exists/i.test(indexed.stderr)) break;
        }
        return {
          ok: true,
          commit,
          parent: oldHead,
          files: prepared.files.map((file) => file.path),
          // Only the name is kept in the queue record (get_opencode_job returns it); never the email.
          authorName: name.trim(),
          indexUpdated: indexed?.exitCode === 0,
          ...(indexed?.exitCode === 0 ? {} : { indexWarning: `The commit is in place, but the index entries of these paths could not be updated (${redactSensitiveText(indexed?.stderr || "").slice(0, 200)}); run git status and git reset -- <paths> if they show as staged deletions.` }),
        };
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

const AUTO_INTEGRATION_FINAL_STATUSES = new Set(["committed", "skipped_not_new_files", "failed", "applied_not_committed"]);
const AUTO_INTEGRATION_CLAIM_STALE_MS = 30 * 60_000;

// B-074: the claimer of an auto-integration is gone when, like the recovery pass judges an owner,
// its bridge_instances lease in this database is not live AND its process id (the first part of
// BRIDGE_INSTANCE_ID) is not alive. A process that is still integrating keeps a live pid, so its
// claim is never taken over; a crashed one is taken over at once instead of after 30 minutes.
function autoIntegrationClaimerGone(db, claimedBy) {
  const instanceId = String(claimedBy || "");
  if (!instanceId) return true;
  try {
    const row = db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(instanceId);
    if (row && Date.parse(row.lease_expires_at || "") > Date.now()) return false;
  } catch {
    // No bridge_instances table: only the process id decides.
  }
  const pid = Number(/^(\d+)-/.exec(instanceId)?.[1] || 0);
  return !processIsAlive(pid);
}

async function autoIntegrateQueueJob({ cwd, jobId, agent = "", model = "", worktreePath, allowedEdits = [], forbiddenEdits = [], sharedFiles = [], serialOnly = [], validationCommand = "", laterAttempt = 0 }) {
  const projectRoot = await resolveProjectStateRoot(cwd);
  // B-069: one bridge process integrates a job: a claim on the terminal row (a restart, or two
  // processes finding the same waiting job, must not integrate it twice).
  const claimedAt = new Date().toISOString();
  const claim = await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration: { status: "integrating", claimedBy: BRIDGE_INSTANCE_ID, at: claimedAt } }, {
    onlyIf: (summary, row, db) => {
      const current = summary.autoIntegration;
      if (!current?.status) return true;
      if (AUTO_INTEGRATION_FINAL_STATUSES.has(current.status)) return false;
      return current.claimedBy === BRIDGE_INSTANCE_ID
        || autoIntegrationClaimerGone(db, current.claimedBy)
        || Date.now() - (Date.parse(current.at || "") || 0) > AUTO_INTEGRATION_CLAIM_STALE_MS;
    },
  });
  if (!claim.patched) return { status: "not_claimed", reason: claim.reason, current: claim.summary?.autoIntegration?.status || "" };
  const recordOutcome = async (fields) => {
    const autoIntegration = { at: new Date().toISOString(), claimedBy: BRIDGE_INSTANCE_ID, ...fields };
    await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration }, {
      onlyIf: (summary) => !summary.autoIntegration?.claimedBy || summary.autoIntegration.claimedBy === BRIDGE_INSTANCE_ID,
    });
    return autoIntegration;
  };
  const failed = async (stage, result) => {
    const outcome = await recordOutcome({ status: stage === "commit" ? "applied_not_committed" : "failed", stage, errorType: result?.errorType || "auto_integration_failed", error: redactSensitiveText(String(result?.error || "")).slice(0, 500), worktreePath: stage === "commit" ? "" : worktreePath });
    logEvent("warn", "queue.auto_integration_failed", {
      jobId,
      agent,
      model,
      errorType: outcome.errorType,
      summary: failureSummary(stage === "commit"
        ? `The new files were integrated but not committed: ${outcome.error}. Commit them by hand.`
        : `Auto-integration stopped at the ${stage}: ${outcome.error || outcome.errorType}. The worktree is kept for integrate_opencode_worktree.`),
    });
    return outcome;
  };
  const options = { cwd: projectRoot, worktreePath, allowedEdits, forbiddenEdits, sharedFiles, serialOnly, validationCommand, allowDirtyTarget: true, previewMode: "stat", cleanupAfterSuccess: true };
  // A lock another job holds: wait outside the chain (scheduleAutoIntegration tries again later).
  const waitLater = async (result) => {
    if (result?.errorType !== "integration_lock_conflict" || laterAttempt >= AUTO_INTEGRATION_LATER_MAX) return null;
    await recordOutcome({ status: "waiting_for_lock", tries: laterAttempt + 1, errorType: result.errorType, error: redactSensitiveText(String(result.error || "")).slice(0, 300) });
    return { retryLater: true };
  };
  let applied = null;
  for (let round = 0; round < AUTO_INTEGRATION_ROUNDS; round += 1) {
    if (round) await delayWithSignal(autoIntegrationRetryDelayMs(round - 1));
    const preview = await integratePatchSerially({ ...options, dryRun: true });
    if (!preview.ok) {
      if (AUTO_INTEGRATION_RETRYABLE_ERRORS.has(preview.errorType) && round < AUTO_INTEGRATION_ROUNDS - 1) continue;
      return (await waitLater(preview)) || await failed("dry run", preview);
    }
    const files = Array.isArray(preview.patchFiles) ? preview.patchFiles : [];
    const newFilesOnly = files.length > 0 && files.every((file) => file.created && !file.deleted);
    if (!newFilesOnly) {
      const outcome = await recordOutcome({ status: "skipped_not_new_files", files: files.map((file) => file.path), reason: "The patch changes or deletes a file that already exists; integrate it after review with integrate_opencode_worktree." });
      logEvent("info", "queue.auto_integration_skipped", { jobId, files: outcome.files.length });
      return outcome;
    }
    applied = await integratePatchSerially({ ...options, dryRun: false, reviewed: true, previewReceipt: preview.previewReceipt, afterApply: autoIntegrationCommitHooks({ jobId, agent, model, worktreePath }) });
    if (applied.ok) break;
    if (!AUTO_INTEGRATION_RETRYABLE_ERRORS.has(applied.errorType) || round === AUTO_INTEGRATION_ROUNDS - 1) return (await waitLater(applied)) || await failed("apply", applied);
  }
  if (!applied?.ok || applied.validationGate?.status !== "passed") {
    return await failed("apply", applied || { errorType: "auto_integration_failed", error: "The apply did not report a passing validation." });
  }
  const committed = applied.afterApply || { ok: false, errorType: "auto_integration_commit_missing", error: "The integration ran no commit step." };
  if (!committed.ok) return await failed("commit", committed);
  const cleanup = applied.sourceCleanup ? `${applied.sourceCleanup.cleanup}${applied.sourceCleanup.reason ? ` (${applied.sourceCleanup.reason})` : ""}` : "";
  const outcome = await recordOutcome({ status: "committed", commit: committed.commit, files: committed.files, author: committed.authorName, worktreeCleanup: cleanup, ...(committed.indexWarning ? { indexWarning: committed.indexWarning } : {}) });
  logEvent("info", "queue.auto_integrated", { jobId, files: committed.files.length, commit: committed.commit });
  return outcome;
}

// B-069: after a restart, a completed autoIntegrate job whose integration never finished (it was
// waiting for a lock, or the bridge died first) is scheduled again. Each job once per process; the
// claim in autoIntegrateQueueJob keeps two processes from integrating it twice.
const AUTO_INTEGRATION_RESCHEDULED = new Set();

async function rescheduleOpenAutoIntegrations(db) {
  if (!CONFIG.autoIntegrateAllowed) return 0;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT job_id, cwd, request_encrypted, record_json FROM opencode_jobs
      WHERE status = 'completed' AND json_valid(record_json)
        AND json_extract(record_json, '$.autoIntegrateRequested') = 1
        AND (json_extract(record_json, '$.autoIntegration.status') IS NULL
          OR json_extract(record_json, '$.autoIntegration.status') IN ('waiting_for_lock', 'integrating'))
    `).all();
  } catch {
    return 0;
  }
  let scheduled = 0;
  for (const row of rows) {
    if (AUTO_INTEGRATION_RESCHEDULED.has(row.job_id) || !row.request_encrypted) continue;
    AUTO_INTEGRATION_RESCHEDULED.add(row.job_id);
    let summary = {};
    let request = null;
    try {
      summary = JSON.parse(row.record_json || "{}");
      request = await decryptQueueRequest(row.request_encrypted, row.job_id);
    } catch {
      continue;
    }
    if (request?.autoIntegrate !== true || !summary.worktreePath || !(summary.changedFiles || []).length || !existsSync(summary.worktreePath)) continue;
    scheduleAutoIntegration({
      cwd: row.cwd || summary.cwd,
      jobId: row.job_id,
      agent: summary.agent || "",
      model: summary.configuredModel ? `${summary.configuredProvider || "?"}/${summary.configuredModel}` : "",
      worktreePath: summary.worktreePath,
      allowedEdits: summary.allowedEdits || [],
      forbiddenEdits: request.forbiddenEdits || [],
      sharedFiles: request.sharedFiles || [],
      serialOnly: request.serialOnly || [],
      validationCommand: String(request.validationCommand || request.scopeContract?.validationCommand || "").trim(),
    });
    scheduled += 1;
  }
  if (scheduled) logEvent("info", "queue.auto_integration_rescheduled", { count: scheduled });
  return scheduled;
}

// One repository's auto-integrations run one after another, each with its commit, so the next
// dry run sees a clean target and a committed HEAD.
function scheduleAutoIntegration(details) {
  // This process handles the job now; the restart scan (rescheduleOpenAutoIntegrations) skips it.
  AUTO_INTEGRATION_RESCHEDULED.add(details.jobId);
  const key = RepositoryRootSet.key(details.cwd);
  const run = (AUTO_INTEGRATION_CHAINS.get(key) || Promise.resolve())
    .then(() => autoIntegrateQueueJob(details))
    .catch((error) => {
      logEvent("warn", "queue.auto_integration_failed", { jobId: details.jobId, agent: details.agent || "", errorType: error?.errorType || "auto_integration_failed", summary: failureSummary(error?.message || String(error)) });
      return null;
    });
  AUTO_INTEGRATION_CHAINS.set(key, run);
  run.finally(() => { if (AUTO_INTEGRATION_CHAINS.get(key) === run) AUTO_INTEGRATION_CHAINS.delete(key); });
  run.then((outcome) => {
    if (!outcome?.retryLater) return;
    // B-075: a worker that drains or runs --until-empty waits for these too.
    AUTO_INTEGRATION_WAITING.add(details.jobId);
    const timer = setTimeout(() => {
      AUTO_INTEGRATION_WAITING.delete(details.jobId);
      scheduleAutoIntegration({ ...details, laterAttempt: Number(details.laterAttempt || 0) + 1 });
    }, autoIntegrationLaterDelayMs());
    timer.unref?.();
  });
  return run;
}


// node:sqlite reports constraint failures as code ERR_SQLITE_ERROR with the extended result
// code in errcode (2067 = SQLITE_CONSTRAINT_UNIQUE); there is no "SQLITE_CONSTRAINT_UNIQUE" code.
function sqliteUniqueConstraintError(error) {
  return error?.errcode === 2067 || /UNIQUE constraint failed/i.test(error?.message || "");
}

async function activatePipelineBatch(record, preparedRecords) {
  if (effectiveQueueMode() !== "sqlite") {
    return { ok: false, errorType: "pipeline_requires_sqlite_queue", error: "Atomic pipeline activation requires the SQLite queue." };
  }
  if (!Array.isArray(preparedRecords) || !preparedRecords.length || preparedRecords.some((item) => !item?.requestEncrypted)) {
    return { ok: false, errorType: "pipeline_batch_invalid", error: "Every pipeline child must be validated and encrypted before batch activation." };
  }
  const duplicateJobIds = preparedRecords.length !== new Set(preparedRecords.map((item) => item.jobId)).size;
  if (duplicateJobIds) {
    return { ok: false, errorType: "pipeline_batch_invalid", error: "Pipeline child job ids must be unique." };
  }
  await Promise.all(preparedRecords.map(async (child) => {
    child.resultEncrypted = child.resultEncrypted || await encryptQueuePrivateDetails(child);
  }));

  return await enqueuePipelinePersistence(record, async () => {
    const expectedRevision = Number(record.revision || 0);
    const activatedAt = new Date().toISOString();
    const queueJobIds = preparedRecords.map((item) => item.jobId);
    const candidate = {
      ...record,
      status: "running",
      startedAt: record.startedAt || activatedAt,
      finishedAt: "",
      queueJobIds,
      expectedChildCount: queueJobIds.length,
      batchState: "released",
      queueMode: "sqlite",
      revision: expectedRevision + 1,
      updatedAt: activatedAt,
      ownerHeartbeatAt: activatedAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      events: (record.events || []).concat({
        type: "queue_batch_activated",
        at: activatedAt,
        queueJobIds,
        expectedChildCount: queueJobIds.length,
      }),
    };
    if (typeof pipelinePersistenceTestHook === "function") await pipelinePersistenceTestHook(candidate);
    candidate.detailsEncrypted = await encryptPipelinePrivateDetails(candidate);
    const estimatedBatchBytes = Buffer.byteLength(candidate.detailsEncrypted || "", "utf8")
      + preparedRecords.reduce((total, child) => total
        + Buffer.byteLength(child.requestEncrypted || "", "utf8")
        + Buffer.byteLength(child.resultEncrypted || "", "utf8")
        + Buffer.byteLength(JSON.stringify(queueRecordDurableSummary(child)), "utf8"), 0);

    const db = await openLockDb(record.cwd);
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const commitAt = new Date().toISOString();
      const commitLeaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      candidate.updatedAt = commitAt;
      candidate.ownerHeartbeatAt = commitAt;
      candidate.ownerLeaseExpiresAt = commitLeaseExpiresAt;
      for (const child of preparedRecords) {
        child.updatedAt = commitAt;
        child.heartbeatAt = commitAt;
        child.leaseExpiresAt = commitLeaseExpiresAt;
      }
      const capacity = stateCapacityError(db, estimatedBatchBytes);
      if (capacity) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, ...capacity };
      }
      const authoritative = db.prepare(`
        SELECT status, revision, owner_instance_id, owner_generation, expected_child_count, batch_state
        FROM opencode_pipelines WHERE pipeline_id = ?
      `).get(record.pipelineId);
      const existingChildren = db.prepare(
        "SELECT COUNT(*) AS count FROM opencode_pipeline_children WHERE pipeline_id = ?"
      ).get(record.pipelineId);
      const claimMatches = authoritative
        && authoritative.status === "planned"
        && Number(authoritative.revision || 0) === expectedRevision
        && authoritative.owner_instance_id === BRIDGE_INSTANCE_ID
        && String(authoritative.owner_generation || "") === String(record.ownerGeneration || "")
        && Number(existingChildren?.count || 0) === 0
        && Number(authoritative.expected_child_count || 0) === 0
        && ["unstarted", "legacy"].includes(authoritative.batch_state || "unstarted");
      if (!claimMatches) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, errorType: "pipeline_concurrent_update", error: "Pipeline activation ownership or revision changed before the atomic batch transaction." };
      }

      const insertJob = db.prepare(`
        INSERT INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
         owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at, cancellation_requested_at,
         child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted, result_encrypted)
        VALUES (?, ?, 'held', ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, '', 0, '', 0, ?, ?, ?)
      `);
      const insertChild = db.prepare(`
        INSERT INTO opencode_pipeline_children (pipeline_id, ordinal, job_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [ordinal, child] of preparedRecords.entries()) {
        const held = { ...child, status: "held", revision: 0 };
        insertJob.run(
          held.jobId,
          held.cwd || "",
          held.agent,
          held.mode,
          held.createdAt,
          JSON.stringify(queueRecordDurableSummary(held)),
          held.ownerInstanceId || "",
          held.ownerProcessId || 0,
          held.ownerGeneration || "",
          commitAt,
          held.heartbeatAt,
          held.leaseExpiresAt,
          held.idempotencyKey || null,
          held.requestEncrypted,
          held.resultEncrypted
        );
        insertChild.run(record.pipelineId, ordinal, held.jobId, commitAt);
      }

      const releaseJob = db.prepare(`
        UPDATE opencode_jobs
        SET status = 'pending', updated_at = ?, record_json = ?, revision = revision + 1
        WHERE job_id = ? AND status = 'held' AND revision = 0
          AND owner_instance_id = ? AND owner_generation = ?
      `);
      for (const child of preparedRecords) {
        const pending = { ...child, status: "pending", revision: 1 };
        const released = releaseJob.run(
          commitAt,
          JSON.stringify(queueRecordDurableSummary(pending)),
          child.jobId,
          BRIDGE_INSTANCE_ID,
          child.ownerGeneration || ""
        );
        if (Number(released.changes || 0) !== 1) throw new Error("Pipeline child release CAS failed.");
      }

      const activated = db.prepare(`
        UPDATE opencode_pipelines
        SET status = 'running', updated_at = ?, record_json = ?, details_encrypted = ?, revision = ?,
            owner_heartbeat_at = ?, owner_lease_expires_at = ?, expected_child_count = ?,
            batch_state = 'released', cleanup_state = ?, queue_mode = 'sqlite'
        WHERE pipeline_id = ? AND revision = ? AND status = ?
          AND owner_instance_id = ? AND owner_generation = ?
          AND owner_lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM bridge_instances
            WHERE instance_id = opencode_pipelines.owner_instance_id AND lease_expires_at > ?
          )
      `).run(
        candidate.updatedAt,
        JSON.stringify(pipelineRecordDurableSummary(candidate)),
        candidate.detailsEncrypted,
        candidate.revision,
        candidate.ownerHeartbeatAt,
        candidate.ownerLeaseExpiresAt,
        candidate.expectedChildCount,
        candidate.cleanupState || "none",
        candidate.pipelineId,
        expectedRevision,
        authoritative.status,
        BRIDGE_INSTANCE_ID,
        record.ownerGeneration || "",
        commitAt,
        commitAt
      );
      if (Number(activated.changes || 0) !== 1) throw new Error("Pipeline activation CAS failed.");
      db.exec("COMMIT");
      transactionOpen = false;

      Object.assign(record, candidate);
      for (const child of preparedRecords) {
        child.status = "pending";
        child.revision = 1;
        QUEUE_JOBS.set(child.jobId, child);
      }
      PIPELINE_RUNS.set(record.pipelineId, record);
      return { ok: true, record, queueJobIds };
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the activation error. */ }
      }
      return {
        ok: false,
        errorType: sqliteUniqueConstraintError(error) ? "pipeline_batch_idempotency_conflict" : "pipeline_batch_persistence_failed",
        error: error?.message || "Pipeline batch activation failed and was rolled back.",
      };
    } finally {
      closeDb(db);
    }
  });
}

function abandonLocalQueueWorker(record, detail) {
  clearQueueLeaseFence(record);
  loseQueueOwnership(record, detail);
  if (effectiveQueueMode() === "sqlite" && QUEUE_JOBS.get(record.jobId) === record) {
    QUEUE_JOBS.delete(record.jobId);
  }
}

async function updateQueueTerminalRecordDurable(record, patch) {
  const result = await updateQueueRecordDurable(record, patch);
  if (!result.persisted && result.ownershipLost) {
    const detail = `Durable queue ownership was lost while committing terminal status ${patch.status || "unknown"}.`;
    abandonLocalQueueWorker(record, detail);
    logEvent("warn", "queue.terminal_commit_rejected", {
      jobId: record.jobId,
      ownerGeneration: record.ownerGeneration || "",
      status: result.status || "missing",
    });
  }
  return result;
}

// `evidence` is the terminal patch the worker could not commit: its result text, changed
// files, patch hash and validation result are kept on the failed record instead of being lost.
async function handleQueueWorkerInfrastructureFailure(record, error, evidence = null) {
  const errorText = truncateText(redactSensitiveText(error?.message || String(error)), 2000);
  record.abortController?.abort(error instanceof Error ? error : new Error(errorText));
  logEvent("error", "queue.worker_unhandled_failure", {
    jobId: record.jobId,
    ownerGeneration: record.ownerGeneration || "",
    error: errorText,
  });
  const intendedStatus = evidence?.status || "";
  try {
    const persisted = await updateQueueTerminalRecordDurable(record, {
      ...(evidence || {}),
      status: "failed",
      finishedAt: evidence?.finishedAt || new Date().toISOString(),
      heartbeatAt: "",
      leaseExpiresAt: "",
      errorType: "queue_worker_infrastructure_failed",
      errorReason: intendedStatus
        ? truncateText(`The job ended ${intendedStatus}${evidence?.errorType ? ` (${evidence.errorType})` : ""}, but its terminal record could not be committed: ${errorText}`, 2000)
        : errorText,
      childProcessId: evidence?.containmentQuarantined ? evidence.childProcessId || 0 : 0,
      childProcessStartedAt: evidence?.containmentQuarantined ? evidence.childProcessStartedAt || "" : "",
    });
    if (!persisted.persisted) {
      logEvent("error", "queue.worker_terminal_persistence_rejected", {
        jobId: record.jobId,
        status: persisted.status || "missing",
      });
      if (!["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(persisted.status || "")) {
        abandonLocalQueueWorker(record, "The queue worker could not durably record its terminal infrastructure failure.");
      }
    }
  } catch (persistenceError) {
    logEvent("error", "queue.worker_terminal_persistence_failed", {
      jobId: record.jobId,
      error: truncateText(redactSensitiveText(persistenceError?.message || String(persistenceError)), 2000),
    });
    abandonLocalQueueWorker(record, "Terminal queue persistence failed; local lease renewal was stopped for deterministic recovery.");
  }
}

function superviseQueueWorker(record, workerPromise) {
  const supervised = workerPromise.catch(async (error) => {
    try {
      await handleQueueWorkerInfrastructureFailure(record, error);
    } catch (handlerError) {
      logEvent("error", "queue.worker_failure_handler_failed", {
        jobId: record.jobId,
        error: truncateText(redactSensitiveText(handlerError?.message || String(handlerError)), 2000),
      });
    }
  });
  const guarded = supervised.catch((error) => {
    try {
      logEvent("error", "queue.worker_supervision_failed", {
        jobId: record.jobId,
        error: truncateText(redactSensitiveText(error?.message || String(error)), 2000),
      });
    } catch {
      // The final supervision boundary must never reject.
    }
  });
  record.executionPromise = guarded;
  return guarded;
}

async function claimQueueRecord(record) {
  const heartbeatAt = new Date().toISOString();
  const runningState = {
    status: "running",
    startedAt: record.startedAt || new Date().toISOString(),
    ownerInstanceId: BRIDGE_INSTANCE_ID,
    ownerProcessId: process.pid,
    ownerGeneration: record.ownerGeneration || randomBytes(12).toString("hex"),
    heartbeatAt,
    leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    errorType: "",
    errorReason: "",
    revision: Number(record.revision || 0) + 1,
  };
  if (effectiveQueueMode() !== "sqlite") {
    Object.assign(record, runningState);
    return { ok: true };
  }
  const db = await openLockDb(record.cwd);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare(`
      SELECT status, revision, owner_instance_id, owner_generation, lease_expires_at, cancellation_requested_at
      FROM opencode_jobs WHERE job_id = ?
    `).get(record.jobId);
    const parent = db.prepare(`
      SELECT pipeline.pipeline_id, pipeline.status, pipeline.batch_state
      FROM opencode_pipeline_children AS relation
      JOIN opencode_pipelines AS pipeline ON pipeline.pipeline_id = relation.pipeline_id
      WHERE relation.job_id = ?
    `).get(record.jobId);
    const parentAllowsClaim = !parent
      || (parent.status === "running" && parent.batch_state === "released");
    if (row && parent && parent.batch_state === "released" && parent.status !== "running"
      && ["pending", "planned", "blocked"].includes(row.status)) {
      const cancelledAt = new Date().toISOString();
      const cancelled = db.prepare(`
        UPDATE opencode_jobs
        SET status = 'cancelled', finished_at = ?, cancellation_requested_at = ?, updated_at = ?,
            heartbeat_at = '', lease_expires_at = '', child_process_id = 0, child_process_started_at = '',
            record_json = json_set(
              CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END,
              '$.status', 'cancelled', '$.finishedAt', ?, '$.cancellationRequested', 1,
              '$.cancellationRequestedAt', ?, '$.errorType', 'agent_cancelled'
            ),
            revision = revision + 1
        WHERE job_id = ? AND status = ? AND revision = ?
          AND owner_instance_id = ? AND owner_generation = ?
      `).run(
        cancelledAt,
        cancelledAt,
        cancelledAt,
        cancelledAt,
        cancelledAt,
        record.jobId,
        row.status,
        Number(row.revision || 0),
        row.owner_instance_id || "",
        row.owner_generation || ""
      );
      if (Number(cancelled.changes || 0) === 1) {
        db.exec("COMMIT");
        Object.assign(record, {
          status: "cancelled",
          finishedAt: cancelledAt,
          cancellationRequested: true,
          cancellationRequestedAt: cancelledAt,
          errorType: "agent_cancelled",
          errorReason: `Parent pipeline ${parent.pipeline_id} is already ${parent.status}.`,
          heartbeatAt: "",
          leaseExpiresAt: "",
          revision: Number(row.revision || 0) + 1,
        });
        return { ok: false, status: "cancelled", parentStatus: parent.status };
      }
      db.exec("ROLLBACK");
      return { ok: false, status: "claim_lost" };
    }
    const claimable = row
      && ["pending", "planned", "blocked"].includes(row.status)
      && parentAllowsClaim
      && row.owner_instance_id === BRIDGE_INSTANCE_ID
      && String(row.owner_generation || "") === String(record.ownerGeneration || "")
      && Number(row.revision || 0) === Number(record.revision || 0)
      && Date.parse(row.lease_expires_at || "") > Date.parse(heartbeatAt)
      && !row.cancellation_requested_at;
    if (!claimable) {
      db.exec("ROLLBACK");
      if (row?.status === "cancelled" || row?.cancellation_requested_at) {
        Object.assign(record, {
          status: "cancelled",
          cancellationRequested: true,
          cancellationRequestedAt: row.cancellation_requested_at || record.cancellationRequestedAt || new Date().toISOString(),
          finishedAt: record.finishedAt || new Date().toISOString(),
          errorType: "agent_cancelled",
          errorReason: "Cancellation won the durable claim race before execution.",
        });
      }
      return { ok: false, status: row?.status || "missing" };
    }
    const snapshot = JSON.stringify(queueRecordDurableSummary({ ...record, ...runningState }));
    const changed = db.prepare(`
      UPDATE opencode_jobs
      SET status = 'running', started_at = ?, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?,
          owner_process_id = ?, record_json = ?, revision = revision + 1
      WHERE job_id = ? AND status = ? AND revision = ? AND owner_instance_id = ? AND owner_generation = ?
        AND lease_expires_at > ?
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at = '')
        AND EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      runningState.startedAt,
      heartbeatAt,
      heartbeatAt,
      runningState.leaseExpiresAt,
      process.pid,
      snapshot,
      record.jobId,
      row.status,
      Number(record.revision || 0),
      BRIDGE_INSTANCE_ID,
      record.ownerGeneration || "",
      heartbeatAt,
      heartbeatAt
    );
    if (Number(changed.changes || 0) !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, status: "claim_lost" };
    }
    db.exec("COMMIT");
    Object.assign(record, runningState);
    return { ok: true };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve original claim error. */ }
    throw error;
  } finally {
    closeDb(db);
  }
}

// Test-only: replaces executeOpenCodeJob for queue workers so the worker's persistence paths
// can be exercised without spawning OpenCode.
let queueJobExecutorTestHook = null;
const QUEUE_ACTIVE_STATUSES = ["running", "validating", "reviewing", "testing"];
const QUEUE_TERMINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted", "not_resumable"];

const {
  markQueueJobRequeued,
  removeEmptyRetryWorktree,
  jobRetryPolicy,
  applyRetryPolicyToJob,
  chooseRetryModel,
  patchTerminalQueueSummary,
  applyQueueRetryPolicy,
  scheduleQueueRetryPolicy,
  requeueQueueJob,
  getQueueRetryPoliciesInFlight,
} = createQueueRetryRuntime({
  CONFIG,
  QUEUE_TERMINAL_STATUSES,
  QUEUE_JOBS,
  openLockDb,
  closeDb,
  runCommand,
  cleanupWorktree,
  parseModelAllowlistEntry,
  allowlistedModelOverride,
  activeModelOverrideAllowlist,
  effectiveQueueMode,
  hasWriteIntent,
  activeProviderPauses,
  providerKeyForMetadata,
  modelPauseKeyForMetadata,
  resolveProjectStateRoot,
  decryptQueueRequest,
  getAutoResumeInterruptedOverride: () => autoResumeInterruptedOverride,
  logEvent,
  jobInputShape,
  recordMatchesProject,
  processIsAlive,
  enqueueQueueJob,
});

// Lock refusals of a queued job that clear by themselves; the job waits (blocked) and retries.
const QUEUE_RETRYABLE_LOCK_ERROR_TYPES = new Set(["queue_lock_conflict", "integration_recovery_pending"]);
const QUEUE_TERMINAL_COMMIT_ATTEMPTS = 5;

// Each consecutive block of the same job after a claim doubles its wait (up to 60 s): a job
// that keeps failing its lock no longer re-runs agent discovery and attestation every poll.
function queueBlockedBackoffPatch(record, now = Date.now()) {
  const count = Number(record.queueBlockedCount || 0) + 1;
  const delayMs = Math.min(QUEUE_BLOCKED_BACKOFF_MAX_MS, Math.max(1, CONFIG.queueBlockedPollMs) * 2 ** Math.min(count - 1, 16));
  return { queueBlockedCount: count, queueBlockedRetryAt: now + delayMs };
}

async function reacquireQueueRecordLease(record) {
  if (effectiveQueueMode() !== "sqlite") return false;
  const db = await openLockDb(record.cwd);
  try {
    const heartbeatAt = new Date().toISOString();
    return reacquirePersistedQueueRecordLease(db, record, heartbeatAt, new Date(Date.now() + CONFIG.queueLeaseMs).toISOString());
  } finally {
    closeDb(db);
  }
}

// A non-terminal transition that was refused only because this owner's lease lapsed re-takes
// the lease (same generation and revision) and tries once more.
async function updateQueueRecordDurableReacquiringLease(record, patch) {
  const ownerGeneration = String(record.ownerGeneration || "");
  const result = await updateQueueRecordDurable(record, patch);
  if (result.persisted || !ownerGeneration || effectiveQueueMode() !== "sqlite") return result;
  if (record.ownerInstanceId !== BRIDGE_INSTANCE_ID
    || String(record.ownerGeneration || "") !== ownerGeneration
    || record.cancellationRequested
    || QUEUE_TERMINAL_STATUSES.includes(record.status)) return result;
  if (!(await reacquireQueueRecordLease(record))) return result;
  return await updateQueueRecordDurable(record, patch);
}

function queueRecordOwnedElsewhere(record, ownerGeneration) {
  return record.ownerInstanceId !== BRIDGE_INSTANCE_ID
    || String(record.ownerGeneration || "") !== String(ownerGeneration || "");
}

// The terminal patch is built once and committed with bounded retries: a transient error
// (SQLITE_BUSY after busy_timeout, an encryption failure) no longer turns a finished job into
// a bare failure. If every attempt fails, the failure is recorded with the job's evidence.
async function commitQueueTerminalRecord(record, patch, { attempts = QUEUE_TERMINAL_COMMIT_ATTEMPTS } = {}) {
  let lastError = null;
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delayWithSignal(Math.min(2000, 100 * 2 ** (attempt - 1)));
    try {
      lastResult = await updateQueueTerminalRecordDurable(record, patch);
      lastError = null;
      // B-056: a queued job fails in the background, never as a tool answer, so the transport
      // wrapper cannot see it; its durable failed record is logged here, once.
      if (lastResult.persisted && patch.status === "failed") {
        logEvent("warn", "queue.job_failed", {
          jobId: record.jobId,
          agent: record.agent || "",
          // Q-006: the issue log names the model a failure happened on.
          model: patch.configuredModel ? `${patch.configuredProvider || "?"}/${patch.configuredModel}` : "",
          errorType: patch.errorType || "",
          summary: failureSummary(patch.errorReason || patch.errorType || "Queued job failed."),
          durationMs: Number.isFinite(patch.durationMs) ? patch.durationMs : null,
        });
      }
      // Q-007: a job with a retry policy is requeued on its next model (or marked gave_up).
      if (lastResult.persisted && patch.status === "failed" && (record.request?.models || record.request?.maxAttempts || record.retryAttempt)) {
        scheduleQueueRetryPolicy(record.cwd, record.jobId);
      }
      // Q-006: a writer that "completed" without changing a file is the round-6 "no output file":
      // a success for the queue, a failure for the batch. Logged so the issue log shows it.
      if (lastResult.persisted && patch.status === "completed" && record.mode === "write" && patch.noChanges) {
        logEvent("warn", "queue.job_no_output", {
          jobId: record.jobId,
          agent: record.agent || "",
          model: patch.configuredModel ? `${patch.configuredProvider || "?"}/${patch.configuredModel}` : "",
          errorType: "completed_no_changes",
          summary: "The writer completed without changing any file (outcome=completed_no_changes).",
          durationMs: Number.isFinite(patch.durationMs) ? patch.durationMs : null,
        });
      }
      if (lastResult.persisted || lastResult.ownershipLost || !QUEUE_ACTIVE_STATUSES.includes(lastResult.status)) return lastResult;
    } catch (error) {
      lastError = error;
      logEvent("warn", "queue.terminal_commit_retry", {
        jobId: record.jobId,
        attempt: attempt + 1,
        status: patch.status || "",
        error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
      });
    }
  }
  await handleQueueWorkerInfrastructureFailure(
    record,
    lastError || new Error(`The terminal ${patch.status || "unknown"} record was refused ${attempts} times while this bridge still owned the running job.`),
    patch
  );
  return lastResult || { persisted: false, status: record.status };
}


// After a claimed job's lock was refused: name the real cause (an integration operation, a
// direct or manual lock), fail a request the lock layer can never accept, and otherwise
// record `blocked` with a backoff. A blocked state that cannot be persisted must not leave
// the record "running" in memory without a worker (it counted against capacity forever).
async function blockQueueRecordAfterLockRefusal(record, errorType) {
  let cause = null;
  try {
    cause = await findQueueWriteConflict(record);
  } catch (error) {
    logEvent("warn", "queue.lock_refusal_probe_failed", {
      jobId: record.jobId,
      error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
    });
  }
  if (!cause && errorType !== "integration_recovery_pending") {
    const refusal = queueHardLockRequestRefusal(record);
    if (refusal) return { outcome: "failed", errorType: "lock_request_rejected", errorReason: refusal };
  }
  const blockedErrorType = cause?.errorType === "integration_recovery_pending" || errorType === "integration_recovery_pending"
    ? "integration_recovery_pending"
    : "queue_lock_conflict";
  const errorReason = cause?.reason || (blockedErrorType === "integration_recovery_pending"
    ? "Waiting for the repository's unresolved integration operation to finish or be recovered; see diagnose_opencode_bridge."
    : "Waiting for the active cross-process reader/writer consistency lock to be released.");
  const patch = {
    status: "blocked",
    errorType: blockedErrorType,
    errorReason,
    childProcessId: 0,
    childProcessStartedAt: "",
    ...queueBlockedBackoffPatch(record),
  };
  let blocked = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delayWithSignal(100 * 2 ** (attempt - 1));
    try {
      blocked = await updateQueueRecordDurableReacquiringLease(record, patch);
      break;
    } catch (error) {
      logEvent("warn", "queue.blocked_persist_failed", {
        jobId: record.jobId,
        attempt: attempt + 1,
        error: truncateText(redactSensitiveText(error?.message || String(error)), 500),
      });
    }
  }
  if (blocked?.persisted) return { outcome: "blocked" };
  if (record.cancellationRequested) {
    await commitQueueTerminalRecord(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      heartbeatAt: "",
      leaseExpiresAt: "",
      errorType: "agent_cancelled",
      errorReason: "Cancelled by request while the job waited for its lock.",
      childProcessId: 0,
      childProcessStartedAt: "",
    });
    return { outcome: "handled" };
  }
  if (!QUEUE_TERMINAL_STATUSES.includes(record.status)) {
    abandonLocalQueueWorker(record, "The blocked queue state could not be persisted; local lease renewal was stopped for deterministic recovery.");
  }
  return { outcome: "handled" };
}

async function startQueueRecord(record) {
  const claim = await claimQueueRecord(record);
  if (!claim.ok) return false;

  record.abortController = new AbortController();
  record.queueOwnershipLost = false;
  resetQueueLeaseFence(record);
  const workerPromise = (async () => {
    const started = nowMs();
    try {
      if (record.cancellationRequested) {
        await commitQueueTerminalRecord(record, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
        });
        return;
      }

      // Only the execution is caught as a job failure. A transient error while writing the
      // terminal record used to land here too and turn a completed job into a bare
      // queue_job_failed without its result, changed files or patch evidence.
      let execution;
      try {
        execution = await providerSlotWaitStorage.run({ jobId: record.jobId }, () => (typeof queueJobExecutorTestHook === "function" ? queueJobExecutorTestHook : executeOpenCodeJob)(record.request, {
        toolStarted: started,
        jobId: record.jobId,
        fromQueue: true,
        signal: record.abortController.signal,
        assertDurableOwnership: async () => await assertQueueRecordDurableOwnership(record),
        renewDurableOwnership: async () => await renewQueueRecordDurableOwnership(record),
        onWorktreePrepared: async (worktree) => {
          const persisted = await updateQueueRecordDurable(record, {
            worktreePath: worktree.path || "",
            worktreeBranch: worktree.branch || "",
            worktreeBaseCommit: worktree.baseCommit || "",
            worktreeBaseTree: worktree.baseTree || "",
          });
          if (!persisted.persisted) {
            loseQueueOwnership(record, "Durable queue ownership changed while recording the isolated worktree.");
            throw queueOwnershipLossError("Durable queue ownership changed while recording the isolated worktree.");
          }
        },
        onChildSpawn: async ({ pid, startedAt, processRole, containmentIdentity }) => {
          const launchAuthorizedAt = new Date().toISOString();
          const persisted = await updateQueueRecordDurable(record, {
            childProcessId: pid || 0,
            childProcessStartedAt: startedAt || new Date().toISOString(),
            agentStartedAt: record.agentStartedAt || startedAt || new Date().toISOString(),
            childProcessRole: processRole || "supervisor",
            childContainmentIdentity: containmentIdentity || "",
            heartbeatAt: launchAuthorizedAt,
            leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
          });
          if (!persisted.persisted) {
            loseQueueOwnership(record, "Durable queue ownership changed while recording the process supervisor identity.");
            throw queueOwnershipLossError("The payload launch gate could not persist its process supervisor identity.");
          }
          return { ok: true, deadlineAt: Date.parse(record.leaseExpiresAt || "") };
        },
        }));
      } catch (error) {
        await commitQueueTerminalRecord(record, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: "queue_job_failed",
          errorReason: error.message || String(error),
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        return;
      }
      const validationError = execution.validation?.disallowedFiles?.length
        ? changedFileValidationErrorType(execution.validation)
        : "";
      const errorType = execution.result?.errorType || validationError || "";

      let terminalPatch = null;
      if ((record.cancellationRequested || errorType === "agent_cancelled") && errorType !== "process_tree_termination_unconfirmed") {
        terminalPatch = {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: "agent_cancelled",
          errorReason: "Cancelled by request after the OpenCode process tree terminated.",
          changedFiles: execution.result?.changedFiles || [],
          validationResult: execution.validation || null,
          sanitizedWorkspaceVerification: execution.sanitizedWorkspace || execution.result?.sanitizedWorkspaceVerification || null,
          configuredProvider: execution.result?.configuredProvider || "",
          configuredModel: execution.result?.configuredModel || "",
          configuredVariant: execution.result?.configuredVariant || "",
          runtimeObservedProvider: execution.result?.runtimeObservedProvider || "",
          runtimeObservedModel: execution.result?.runtimeObservedModel || "",
          actualProvider: execution.result?.actualProvider || "",
          actualModel: execution.result?.actualModel || "",
          actualModelEvidence: execution.result?.actualModelEvidence || "",
          dependencyRequest: execution.result?.dependencyRequest || null,
          ...queueResultFields(execution),
          worktreePath: execution.worktree?.path || "",
          worktreeBranch: execution.worktree?.branch || "",
          worktreeBaseCommit: execution.worktree?.baseCommit || "",
          worktreeBaseTree: execution.worktree?.baseTree || "",
          worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
          worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
          childProcessId: 0,
          childProcessStartedAt: "",
        };
      } else if (QUEUE_RETRYABLE_LOCK_ERROR_TYPES.has(errorType) && effectiveQueueWriteConflictPolicy() === "wait") {
        const refusal = await blockQueueRecordAfterLockRefusal(record, errorType);
        if (refusal.outcome !== "failed") return;
        terminalPatch = {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
          errorType: refusal.errorType,
          errorReason: refusal.errorReason,
          ...queueResultFields(execution),
          childProcessId: 0,
          childProcessStartedAt: "",
        };
      }

      const containmentUnconfirmed = errorType === "process_tree_termination_unconfirmed";
      // Q-007: with a retry policy the caller said this job must produce something, so a writer
      // that changed no file is a failure (the round-6 "no output file") and is retried.
      const noOutputFailure = !errorType && record.mode === "write" && Boolean(execution.result?.noChanges)
        && Boolean(record.request?.models || record.request?.maxAttempts);
      const terminalErrorType = noOutputFailure ? "writer_no_changes" : errorType;
      terminalPatch = terminalPatch || {
        status: terminalErrorType ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - started,
        heartbeatAt: "",
        leaseExpiresAt: "",
        errorType: terminalErrorType,
        errorReason: noOutputFailure
          ? "The writer finished without changing any file; with a retry policy (models/maxAttempts) that counts as no output."
          : errorType ? queueFailureReason(execution, errorType) : "",
        changedFiles: execution.result?.changedFiles || [],
        dirtyFiles: execution.result?.dirtyFiles || [],
        overlappingFiles: execution.result?.overlappingFiles || [],
        disjointFiles: execution.result?.disjointFiles || [],
        validationResult: execution.validation || null,
        sanitizedWorkspaceVerification: execution.sanitizedWorkspace || execution.result?.sanitizedWorkspaceVerification || null,
        configuredProvider: execution.result?.configuredProvider || "",
        configuredModel: execution.result?.configuredModel || "",
        configuredVariant: execution.result?.configuredVariant || "",
        runtimeObservedProvider: execution.result?.runtimeObservedProvider || "",
        runtimeObservedModel: execution.result?.runtimeObservedModel || "",
        actualProvider: execution.result?.actualProvider || "",
        actualModel: execution.result?.actualModel || "",
        actualModelEvidence: execution.result?.actualModelEvidence || "",
        dependencyRequest: execution.result?.dependencyRequest || null,
        ...queueResultFields(execution),
        providerWaitMs: execution.result?.providerConcurrencyWaitMs || 0,
        // B-078: the slot request was refused for a paused provider/model; the agent never ran.
        providerRefusedUntil: execution.result?.exitCode === "provider_capacity_unavailable" ? String(execution.result?.providerCooldownUntil || "") : "",
        providerRetryWarningCount: execution.result?.providerRetryWarningCount || 0,
        usage: execution.result?.usage || null,
        heavyToolCalls: execution.result?.heavyToolCalls?.length ? execution.result.heavyToolCalls : null,
        validationFixPass: execution.result?.validationFixPass || null,
        selfCheck: execution.result?.selfCheck || null,
        phaseTimings: execution.result?.phaseTimings || null,
        readOnlyHeadMove: execution.result?.readOnlyHeadMove || null,
        worktreePath: execution.worktree?.path || "",
        noChanges: Boolean(execution.result?.noChanges),
        worktreeBranch: execution.worktree?.branch || "",
        worktreeBaseCommit: execution.worktree?.baseCommit || "",
        worktreeBaseTree: execution.worktree?.baseTree || "",
        worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
        worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
        childProcessId: containmentUnconfirmed ? record.childProcessId : 0,
        childProcessStartedAt: containmentUnconfirmed ? record.childProcessStartedAt : "",
        containmentQuarantined: containmentUnconfirmed,
      };
      const committedTerminal = await commitQueueTerminalRecord(record, terminalPatch);
      // Q-010: a finished writer that asked for it is integrated after its lock is released (the
      // integration's serial lock would otherwise wait on the job's own write lock).
      if (committedTerminal?.persisted && terminalPatch.status === "completed" && record.request?.autoIntegrate === true
        && record.mode === "write" && !record.parentJobId && (terminalPatch.changedFiles || []).length && terminalPatch.worktreePath) {
        scheduleAutoIntegration({
          cwd: record.cwd,
          jobId: record.jobId,
          agent: record.agent || "",
          model: terminalPatch.configuredModel ? `${terminalPatch.configuredProvider || "?"}/${terminalPatch.configuredModel}` : "",
          worktreePath: terminalPatch.worktreePath,
          allowedEdits: record.allowedEdits || [],
          forbiddenEdits: record.request.forbiddenEdits || [],
          sharedFiles: record.request.sharedFiles || [],
          serialOnly: record.request.serialOnly || [],
          validationCommand: String(record.request.validationCommand || record.request.scopeContract?.validationCommand || "").trim(),
        });
      }
    } finally {
      clearQueueLeaseFence(record);
      if (record.parentJobId && ["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
        try {
          await reconcileParentPipelineAfterQueueTerminal(record);
        } catch (error) {
          logEvent("warn", "pipeline.child_terminal_reconciliation_failed", {
            pipelineId: record.parentJobId,
            jobId: record.jobId,
            errorType: error?.errorType || "pipeline_child_terminal_reconciliation_failed",
          });
        }
      }
      if (["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
        delete record.request;
        delete record.queueBlockedCount;
        delete record.queueBlockedRetryAt;
      }
      delete record.abortController;
      delete record.executionPromise;
      scheduleQueue();
    }
  })();
  superviseQueueWorker(record, workerPromise);
  return true;
}

// The stored reason of a failed queue job: the agent's stderr summary, or the error type when it
// printed nothing. B-044: a timed-out writer that left changed files in a retained worktree says so
// first, so the operator integrates (or inspects) it instead of discarding the job.
function queueFailureReason(execution, errorType) {
  const stderrSummary = summarizeStderr(execution.result?.stderr);
  const note = timedOutWriterNote({
    ...timedOutWriterEvidence(execution.result),
    errorType,
    worktreeRetained: Boolean(execution.worktree?.path),
  });
  return note ? [note, stderrSummary].filter(Boolean).join(". ") : stderrSummary || errorType;
}

// `progressed` is false when a pass advanced no record: pending records that could not be
// planned or claimed (a lost or lapsed lease) are then polled, not rescheduled at 0 ms,
// which used to spin the scheduler (encryptions, database opens, git) until the bridge exited.
function nextQueueScheduleDelay(records, hasCapacity, progressed = true, now = Date.now()) {
  if (!hasCapacity) {
    return null;
  }
  if (records.some((record) => ["pending", "planned"].includes(record.status))) {
    return progressed ? 0 : CONFIG.queueBlockedPollMs;
  }
  const blocked = records.filter((record) => record.status === "blocked");
  if (!blocked.length) return null;
  const nextRetryMs = Math.min(...blocked.map((record) => Math.max(0, Number(record.queueBlockedRetryAt || 0) - now)));
  return Math.max(CONFIG.queueBlockedPollMs, nextRetryMs);
}

// B-080: a pending job waiting (startAfter, reason provider_pause) for the pauses of its models is
// released as soon as none of them is paused any more, whoever ended the pause: resumeProvider
// clears the waits of its own process only, so a resume from Claude Code left a worker's jobs idle
// until the original pause end. One read of the provider database per scheduler poll interval, and
// only while such a job exists.
let pauseWaitCheckedAt = 0;

function pauseWaitCandidates(record) {
  const request = record.request || {};
  const models = Array.isArray(request.models) ? request.models.map((entry) => parseModelAllowlistEntry(entry)).filter(Boolean) : [];
  if (models.length) return models.map((item) => ({ provider: item.provider, model: item.model }));
  const requirement = request.scopeContract?.modelRequirement || record.scopeContract?.modelRequirement;
  return requirement?.provider ? [{ provider: requirement.provider, model: requirement.model || "" }] : [];
}

async function releaseResumedPauseWaits(now = Date.now()) {
  const waiting = [...QUEUE_JOBS.values()].filter((record) => ["pending", "planned"].includes(record.status)
    && record.startAfterReason === "provider_pause" && queueStartAfterPending(record, now));
  if (!waiting.length || now - pauseWaitCheckedAt < Math.max(250, CONFIG.queueBlockedPollMs)) return 0;
  pauseWaitCheckedAt = now;
  let pauses;
  try {
    pauses = await activeProviderPauses();
  } catch {
    return 0;
  }
  const pausedUntil = (provider, model) => Math.max(
    pauses.get(providerKeyForMetadata({ provider })) || 0,
    model ? pauses.get(modelPauseKeyForMetadata({ provider, model })) || 0 : 0,
  );
  let released = 0;
  for (const record of waiting) {
    const candidates = pauseWaitCandidates(record);
    if (!candidates.length || candidates.some((item) => pausedUntil(item.provider, item.model) > now)) continue;
    delete record.startAfter;
    delete record.startAfterReason;
    released += 1;
  }
  return released;
}

let queueWakeAt = 0;
let queueSchedulerRunning = false;
let queueScheduleRequested = false;

function scheduleQueue(delayMs = 0) {
  if (effectiveQueueMode() === "off") {
    return;
  }
  const delay = Math.max(0, Number(delayMs) || 0);
  if (queueSchedulerRunning) {
    // A pass is running: it re-checks right away when it finishes instead of polling.
    if (delay === 0) queueScheduleRequested = true;
    return;
  }
  if (queueSchedulerActive) {
    // A wake is pending; a sooner request (a new job, a finished one) must not wait behind a
    // blocked job's backoff.
    if (!queueWakeTimer || Date.now() + delay >= queueWakeAt) return;
    clearTimeout(queueWakeTimer);
    queueWakeTimer = null;
  }

  queueSchedulerActive = true;
  queueWakeAt = Date.now() + delay;
  queueWakeTimer = setTimeout(async () => {
    queueWakeTimer = null;
    queueSchedulerRunning = true;
    queueScheduleRequested = false;
    let progressed = false;
    try {
      // Q-002: a limit changed by another bridge process, or persisted before this one started.
      await refreshRuntimeConcurrency();
      const runningCount = runningQueueRecords().length;
      let capacity = Math.max(0, CONFIG.queueParallelLimit - runningCount);
      if (!capacity) {
        return;
      }

      // B-045: below the free-memory floor nothing new is planned or started, but the pass still runs
      // for everything that does not start an agent (a cancellation of a pending job is processed
      // below, so an operator cancelling queued jobs to free memory sees it happen). A pass that
      // starts nothing makes no progress, so the scheduler polls again
      // (CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS) and starts the jobs once memory recovers.
      // B-080: a pause-wait released by a resume in any process (resumeProvider frees only its own).
      await releaseResumedPauseWaits();
      const memoryGate = queueMemoryGate();
      const startableRecords = [...QUEUE_JOBS.values()].filter((record) => ["pending", "planned", "blocked"].includes(record.status));
      const holdStarts = memoryGate.blocked && startableRecords.length > 0;
      if (holdStarts) holdQueueForMemory(memoryGate, startableRecords);
      else releaseQueueMemoryHold(memoryGate);

      for (const record of QUEUE_JOBS.values()) {
        if (!capacity) {
          break;
        }

        if (!["pending", "blocked", "planned"].includes(record.status)) {
          continue;
        }
        // Progress is a record changing state or leaving this instance; a planned record
        // that is planned again and cannot be claimed is not progress.
        const statusBefore = record.status;
        try {
          if (INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(record.cwd || process.cwd()) && record.mode !== "read") {
            // Readers do not mutate the checkout, so only writers wait for journal recovery.
            if (record.errorType !== "integration_recovery_pending") {
              await updateQueueRecordDurable(record, {
                status: "blocked",
                errorType: "integration_recovery_pending",
                errorReason: "Waiting for the repository's integration journal to recover (a quarantined integration blocks writers); see diagnose_opencode_bridge.",
              });
            }
            continue;
          }

          if (record.cancellationRequested) {
            await updateQueueRecordDurable(record, {
              status: "cancelled",
              finishedAt: new Date().toISOString(),
            });
            continue;
          }

          // B-045: planning and starting wait for memory; the job stays pending (no durable write per poll).
          if (holdStarts) continue;
          // Q-007: a retry whose every model is paused waits for the first pause to end.
          if (["pending", "planned"].includes(record.status) && queueStartAfterPending(record)) continue;
          // B-075: a queue worker that is draining (a stop was requested) or has not finished taking
          // in its --enqueue file starts nothing new; the job stays pending for the next owner.
          // Checked before planning, so a held job costs no durable write per pass.
          if (queueDrainRequested()) continue;

          if (record.status === "blocked" && Number(record.queueBlockedRetryAt || 0) > Date.now()) continue;
          if (record.status === "blocked") {
            // An unchanged block needs no durable write: re-plan only once the cause is gone
            // or has changed.
            const standing = await findQueueWriteConflict(record);
            if (standing && standing.errorType === record.errorType && standing.reason === record.errorReason) continue;
          }

          const ownerGeneration = record.ownerGeneration || "";
          const plannedPersistence = await updateQueueRecordDurableReacquiringLease(record, { status: "planned" });
          if (!plannedPersistence.persisted) {
            if (queueRecordOwnedElsewhere(record, ownerGeneration) && QUEUE_JOBS.get(record.jobId) === record) {
              // Another owner or generation holds the row now: stop covering it with this
              // instance's lease so recovery can resume it.
              QUEUE_JOBS.delete(record.jobId);
              logEvent("warn", "queue.record_owned_elsewhere", { jobId: record.jobId, ownerGeneration });
            }
            continue;
          }
          if (record.status !== "planned") continue;
          const conflict = await findQueueWriteConflict(record);
          if (conflict) {
            if (effectiveQueueWriteConflictPolicy() === "reject" && conflict.errorType !== "integration_recovery_pending") {
              await updateQueueRecordDurable(record, {
                status: "failed",
                finishedAt: new Date().toISOString(),
                errorType: "write_lock_conflict",
                errorReason: `Write lock conflict on: ${conflict.paths[0] || "unknown"}`,
              });
            } else {
              await updateQueueRecordDurable(record, {
                status: "blocked",
                errorType: conflict.errorType || "write_lock_conflict",
                errorReason: conflict.reason || `Waiting for queued write job ${conflict.jobId} to release: ${conflict.paths.join(", ")}`,
              });
            }
            continue;
          }

          // The stop may have arrived while this pass awaited the plan and the conflict check.
          if (queueDrainRequested()) continue;
          const started = await startQueueRecord(record);
          if (started) capacity -= 1;
        } finally {
          if (record.status !== statusBefore || QUEUE_JOBS.get(record.jobId) !== record) progressed = true;
        }
      }
    } catch (error) {
      logEvent("warn", "queue.scheduler_failed", { error: error.message || String(error) });
    } finally {
      queueSchedulerRunning = false;
      queueSchedulerActive = false;
      const records = [...QUEUE_JOBS.values()].filter((record) =>
        record.mode === "read" || !INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(record.cwd || process.cwd())
      );
      const hasCapacity = runningQueueRecords().length < CONFIG.queueParallelLimit;
      const nextDelay = nextQueueScheduleDelay(records, hasCapacity, progressed || queueScheduleRequested);
      queueScheduleRequested = false;
      if (nextDelay !== null) {
        scheduleQueue(nextDelay);
      }
    }
  }, delay);
}




function makePipelineId(name = "pipeline") {
  return `${safeNamePart(name, "pipeline")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function pipelinePrivateDetails(record) {
  const details = sanitizePersistedValue({
    policy: record.policy || null,
    jobs: record.jobs || [],
    lockPlans: record.lockPlans || [],
    integrationQueue: record.integrationQueue || [],
    finalValidationCommand: record.finalValidationCommand || "",
    finalValidationSpec: record.finalValidationSpec || null,
    finalValidationResult: record.finalValidationResult || null,
    reviewerJob: record.reviewerJob || null,
    reviewerResult: record.reviewerResult || null,
    testerJob: record.testerJob || null,
    testerResult: record.testerResult || null,
    sourceCleanupResults: record.sourceCleanupResults || [],
    events: record.events || [],
    errors: record.errors || [],
    sanitizedWorkspaceAttestation: record.sanitizedWorkspaceAttestation || null,
  });
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, "utf8") <= CONFIG.maxSnapshotFileBytes) return details;
  const essentialCleanupAuthorization = [...(details.events || [])]
    .reverse()
    .find((event) => event?.type === "source_cleanup_authorized");
  return sanitizePersistedValue({
    policy: details.policy || null,
    jobs: [],
    lockPlans: details.lockPlans || [],
    integrationQueue: details.integrationQueue || [],
    finalValidationCommand: details.finalValidationCommand || "",
    finalValidationSpec: details.finalValidationSpec || null,
    reviewerJob: null,
    testerJob: null,
    sourceCleanupResults: details.sourceCleanupResults || [],
    events: essentialCleanupAuthorization ? [essentialCleanupAuthorization] : [],
    errors: [],
    truncated: true,
    originalChars: serialized.length,
    originalSha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

function pipelineRecordDurableSummary(record) {
  const summary = pipelineRecordSnapshot(record);
  const privateDetails = pipelinePrivateDetails(record);
  const privateJson = JSON.stringify(privateDetails);
  summary.policy = record.policy ? sanitizePersistedValue({
    path: record.policy.path || "",
    sha256: record.policy.sha256 || "",
    trustedForAuthority: Boolean(record.policy.trustedForAuthority),
  }) : null;
  summary.jobs = (record.jobs || []).map((job) => {
    const hasRawTask = Object.prototype.hasOwnProperty.call(job || {}, "task");
    return sanitizePersistedValue({
      agent: job.agent || "",
      role: job.role || "",
      write: Boolean(job.write),
      taskChars: hasRawTask ? String(job.task || "").length : Number(job.taskChars || 0),
      taskSha256: hasRawTask
        ? createHash("sha256").update(String(job.task || "")).digest("hex")
        : String(job.taskSha256 || ""),
    });
  });
  summary.lockPlans = (record.lockPlans || []).map((plan) => sanitizePersistedValue({
    index: Number(plan.index || 0),
    agent: plan.agent || "",
    cwd: plan.cwd || "",
    lockMode: plan.lockMode || "",
    lockType: plan.lockType || "",
    orchestratorMode: plan.orchestratorMode || "",
    userAuthorizedOrchestrator: Boolean(plan.userAuthorizedOrchestrator),
    contractorAuthorizationVerified: Boolean(plan.contractorAuthorizationVerified),
    lockedPaths: plan.lockedPaths || [],
    allowedEdits: plan.allowedEdits || [],
    forbiddenEdits: plan.forbiddenEdits || [],
    sharedFiles: plan.sharedFiles || [],
    serialOnly: plan.serialOnly || [],
    scopeContract: scopeContractDurableSummary(plan.scopeContract),
    timeoutMs: plan.timeoutMs || null,
    taskChars: String(plan.task || "").length,
    taskSha256: createHash("sha256").update(String(plan.task || "")).digest("hex"),
    ...commandFingerprintFields(plan.validationCommand),
  }));
  summary.integrationQueue = (record.integrationQueue || []).map((item) => sanitizePersistedValue({
    agent: item.agent || "",
    jobId: item.jobId || "",
    worktreePath: item.worktreePath || "",
    branch: item.branch || "",
    sourceBaseCommit: item.sourceBaseCommit || "",
    sourceBaseTree: item.sourceBaseTree || "",
    patchSha256: item.patchSha256 || "",
    sourceStateSha256: item.sourceStateSha256 || "",
    allowedEdits: item.allowedEdits || [],
    lockedPaths: item.lockedPaths || [],
    forbiddenEdits: item.forbiddenEdits || [],
    sharedFiles: item.sharedFiles || [],
    serialOnly: item.serialOnly || [],
    changedFiles: item.changedFiles || [],
    status: item.status || "",
    operationId: item.operationId || "",
    validationSource: item.validationSource || "",
    ...commandFingerprintFields(item.validationCommand),
    validationSpecSha256: createHash("sha256").update(JSON.stringify(item.validationSpec || null)).digest("hex"),
  }));
  summary.finalValidationCommand = "";
  summary.finalValidationSpec = null;
  summary.finalValidationResult = null;
  summary.reviewerJob = null;
  summary.reviewerResult = null;
  summary.testerJob = null;
  summary.testerResult = null;
  summary.sourceCleanupResults = [];
  summary.events = [];
  summary.errors = [];
  summary.sanitizedWorkspaceAttestation = null;
  summary.privateDetailsChars = privateJson.length;
  summary.privateDetailsSha256 = createHash("sha256").update(privateJson).digest("hex");
  summary.eventCount = (record.events || []).length;
  summary.errorCount = (record.errors || []).length;
  return sanitizePersistedValue(summary);
}

async function encryptPipelinePrivateDetails(record) {
  return encryptIntegrationJournalBytes(
    Buffer.from(JSON.stringify(pipelinePrivateDetails(record)), "utf8"),
    `pipeline-details\0${record.pipelineId}`
  );
}

async function decryptPipelinePrivateDetails(envelope, pipelineId) {
  if (!envelope) return {};
  return JSON.parse((await decryptIntegrationJournalBytes(envelope, `pipeline-details\0${pipelineId}`)).toString("utf8"));
}

function pipelineOwnedByThisInstance(record) {
  return Boolean(record?.ownerInstanceId) && record.ownerInstanceId === BRIDGE_INSTANCE_ID;
}

async function claimPersistedPipeline(record) {
  const db = await openLockDb(record.cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = db.prepare(`
      SELECT status, revision, request_encrypted, details_encrypted, record_json, owner_instance_id, owner_generation,
             owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode
      FROM opencode_pipelines WHERE pipeline_id = ?
    `).get(record.pipelineId);
    if (!row) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, reason: "missing" };
    }
    let durableSummary = {};
    try { durableSummary = JSON.parse(row.record_json || "{}"); } catch { durableSummary = {}; }
    const authoritative = {
      ...durableSummary,
      ...record,
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || record.ownerInstanceId || durableSummary.ownerInstanceId || "",
      ownerGeneration: row.owner_generation || record.ownerGeneration || durableSummary.ownerGeneration || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || record.ownerHeartbeatAt || durableSummary.ownerHeartbeatAt || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || record.ownerLeaseExpiresAt || durableSummary.ownerLeaseExpiresAt || "",
      expectedChildCount: Number(row.expected_child_count || record.expectedChildCount || durableSummary.expectedChildCount || 0),
      batchState: row.batch_state || record.batchState || durableSummary.batchState || "unstarted",
      cleanupState: row.cleanup_state || record.cleanupState || durableSummary.cleanupState || "none",
      queueMode: row.queue_mode || record.queueMode || durableSummary.queueMode || "legacy",
      requestEncrypted: row.request_encrypted || record.requestEncrypted || "",
      replayRequestAvailable: Boolean(row.request_encrypted),
    };
    if (["completed", "failed", "cancelled"].includes(authoritative.status)) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "terminal" };
    }
    if (["planned", "running"].includes(authoritative.status) && !row.request_encrypted) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "legacy_pipeline_request_unavailable" };
    }
    const now = Date.now();
    const expiresAt = Date.parse(authoritative.ownerLeaseExpiresAt || "");
    const owner = authoritative.ownerInstanceId
      ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(authoritative.ownerInstanceId)
      : null;
    const ownerExpiresAt = Date.parse(owner?.lease_expires_at || "");
    const sameOwnerGeneration = authoritative.ownerInstanceId === BRIDGE_INSTANCE_ID
      && authoritative.ownerGeneration
      && authoritative.ownerGeneration === record.ownerGeneration;
    const sameLiveOwner = sameOwnerGeneration
      && Number.isFinite(expiresAt)
      && expiresAt > now;
    if (sameLiveOwner) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      PIPELINE_RUNS.set(record.pipelineId, record);
      return { ok: true, record, alreadyOwnedLive: true };
    }
    if (sameOwnerGeneration) {
      // This instance's own generation with a lapsed lease: nobody took it (a takeover writes
      // a new generation), so renew it in place. Treating it as a foreign live owner left the
      // pipeline unclaimable and every update failing until the bridge exited.
      const renewedAt = new Date().toISOString();
      const renewedLeaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      const renewed = db.prepare(`
        UPDATE opencode_pipelines
        SET owner_heartbeat_at = ?, owner_lease_expires_at = ?
        WHERE pipeline_id = ? AND revision = ? AND owner_instance_id = ? AND owner_generation = ?
      `).run(
        renewedAt,
        renewedLeaseExpiresAt,
        record.pipelineId,
        Number(authoritative.revision || 0),
        BRIDGE_INSTANCE_ID,
        authoritative.ownerGeneration
      );
      if (Number(renewed.changes || 0) !== 1) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, reason: "concurrent_update" };
      }
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative, { ownerHeartbeatAt: renewedAt, ownerLeaseExpiresAt: renewedLeaseExpiresAt });
      PIPELINE_RUNS.set(record.pipelineId, record);
      logEvent("warn", "pipeline.lease_reacquired", { pipelineId: record.pipelineId, ownerGeneration: record.ownerGeneration });
      return { ok: true, record, reacquired: true };
    }
    if ((Number.isFinite(expiresAt) && expiresAt > now) || (Number.isFinite(ownerExpiresAt) && ownerExpiresAt > now)) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "owner_lease_active" };
    }
    const expectedRevision = Number(authoritative.revision || 0);
    const claimedAt = new Date().toISOString();
    const candidate = {
      ...authoritative,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerGeneration: randomBytes(12).toString("hex"),
      ownerHeartbeatAt: claimedAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: expectedRevision + 1,
      updatedAt: claimedAt,
    };
    const durableCandidate = sanitizePersistedValue({
      ...durableSummary,
      status: candidate.status,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
      ownerInstanceId: candidate.ownerInstanceId,
      ownerGeneration: candidate.ownerGeneration,
      ownerHeartbeatAt: candidate.ownerHeartbeatAt,
      ownerLeaseExpiresAt: candidate.ownerLeaseExpiresAt,
      queueMode: candidate.queueMode || "sqlite",
    });
    const updated = db.prepare(`
      UPDATE opencode_pipelines
      SET updated_at = ?, record_json = ?, revision = ?, owner_instance_id = ?, owner_generation = ?,
          owner_heartbeat_at = ?, owner_lease_expires_at = ?, queue_mode = ?
      WHERE pipeline_id = ? AND revision = ?
        AND owner_instance_id = ? AND owner_generation = ?
    `).run(
      candidate.updatedAt,
      JSON.stringify(durableCandidate),
      candidate.revision,
      candidate.ownerInstanceId,
      candidate.ownerGeneration,
      candidate.ownerHeartbeatAt,
      candidate.ownerLeaseExpiresAt,
      candidate.queueMode || "sqlite",
      candidate.pipelineId,
      expectedRevision,
      authoritative.ownerInstanceId || "",
      authoritative.ownerGeneration || ""
    );
    if (Number(updated.changes || 0) !== 1) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, reason: "concurrent_update" };
    }
    db.exec("COMMIT");
    transactionOpen = false;
    Object.assign(record, candidate);
    PIPELINE_RUNS.set(record.pipelineId, record);
    return { ok: true, record };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the claim error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

function pipelineOwnerRejection(record, operation) {
  return formatRejectedExecution({
    headline: `Multi-agent pipeline ${operation} rejected.`,
    errorType: "pipeline_foreign_owner",
    reason: "Persisted pipeline audit records are not replayable task payloads and may be mutated only by the bridge instance that created them.",
    requestedAgent: "pipeline_coordinator",
    actualAgent: "none",
    lockMode: operation,
    suggestedFix: "Inspect the persisted record read-only, then recreate the pipeline from the original trusted task inputs in this bridge instance if new execution is required.",
  });
}

function enqueuePipelinePersistence(record, operation) {
  const key = pipelinePersistenceKey(record);
  const previous = PIPELINE_PERSISTENCE_CHAINS.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  PIPELINE_PERSISTENCE_CHAINS.set(key, current);
  return current.finally(() => {
    if (PIPELINE_PERSISTENCE_CHAINS.get(key) === current) {
      PIPELINE_PERSISTENCE_CHAINS.delete(key);
    }
  });
}

async function writePipelineRecordSnapshot(snapshot, { create = false, expectedRevision = null } = {}) {
  const db = await openLockDb(snapshot.cwd);
  try {
    const commitAt = new Date().toISOString();
    const committedSnapshot = {
      ...snapshot,
      updatedAt: commitAt,
      ownerHeartbeatAt: commitAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    };
    if (create) {
      const capacity = stateCapacityError(db);
      if (capacity) {
        const error = new Error(capacity.error);
        error.errorType = capacity.errorType;
        throw error;
      }
      const inserted = db.prepare(`
        INSERT INTO opencode_pipelines
        (pipeline_id, cwd, status, created_at, updated_at, record_json, revision, request_encrypted, details_encrypted,
         owner_instance_id, owner_generation, owner_heartbeat_at, owner_lease_expires_at,
         expected_child_count, batch_state, cleanup_state, queue_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pipeline_id) DO NOTHING
      `).run(
        committedSnapshot.pipelineId,
        committedSnapshot.cwd || "",
        committedSnapshot.status,
        committedSnapshot.createdAt,
        committedSnapshot.updatedAt,
        pipelineRecordJson(committedSnapshot),
        Number(committedSnapshot.revision || 0),
        committedSnapshot.requestEncrypted || null,
        committedSnapshot.detailsEncrypted || null,
        committedSnapshot.ownerInstanceId || "",
        committedSnapshot.ownerGeneration || "",
        committedSnapshot.ownerHeartbeatAt || "",
        committedSnapshot.ownerLeaseExpiresAt || "",
        Number(committedSnapshot.expectedChildCount || 0),
        committedSnapshot.batchState || "unstarted",
        committedSnapshot.cleanupState || "none",
        committedSnapshot.queueMode || "sqlite"
      );
      if (inserted.changes !== 1) throw pipelineConcurrentUpdateError(snapshot);
      return committedSnapshot;
    }
    const expected = Number(expectedRevision);
    const updated = db.prepare(`
      UPDATE opencode_pipelines
      SET cwd = ?, status = ?, created_at = ?, updated_at = ?, record_json = ?, revision = ?, request_encrypted = COALESCE(?, request_encrypted),
          details_encrypted = COALESCE(?, details_encrypted),
          owner_instance_id = ?, owner_generation = ?, owner_heartbeat_at = ?, owner_lease_expires_at = ?,
          expected_child_count = ?, batch_state = ?, cleanup_state = ?, queue_mode = ?
      WHERE pipeline_id = ? AND revision = ? AND owner_instance_id = ? AND owner_generation = ?
        AND owner_generation <> ''
        AND EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_pipelines.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      committedSnapshot.cwd || "",
      committedSnapshot.status,
      committedSnapshot.createdAt,
      committedSnapshot.updatedAt,
      pipelineRecordJson(committedSnapshot),
      Number(committedSnapshot.revision || 0),
      committedSnapshot.requestEncrypted || null,
      committedSnapshot.detailsEncrypted || null,
      committedSnapshot.ownerInstanceId || "",
      committedSnapshot.ownerGeneration || "",
      committedSnapshot.ownerHeartbeatAt || "",
      committedSnapshot.ownerLeaseExpiresAt || "",
      Number(committedSnapshot.expectedChildCount || 0),
      committedSnapshot.batchState || "unstarted",
      committedSnapshot.cleanupState || "none",
      committedSnapshot.queueMode || "sqlite",
      committedSnapshot.pipelineId,
      expected,
      committedSnapshot.ownerInstanceId || "",
      committedSnapshot.ownerGeneration || "",
      commitAt
    );
    if (updated.changes !== 1) {
      const row = db.prepare(`
        SELECT status, revision, record_json, owner_instance_id, owner_generation, owner_heartbeat_at,
               owner_lease_expires_at, expected_child_count, batch_state, cleanup_state
        FROM opencode_pipelines WHERE pipeline_id = ?
      `).get(snapshot.pipelineId);
      const authoritative = row?.record_json ? {
        ...JSON.parse(row.record_json),
        status: row.status,
        revision: Number(row.revision || 0),
        ownerInstanceId: row.owner_instance_id || "",
        ownerGeneration: row.owner_generation || "",
        ownerHeartbeatAt: row.owner_heartbeat_at || "",
        ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
        expectedChildCount: Number(row.expected_child_count || 0),
        batchState: row.batch_state || "unstarted",
        cleanupState: row.cleanup_state || "none",
      } : null;
      throw pipelineConcurrentUpdateError(snapshot, authoritative);
    }
    return committedSnapshot;
  } finally {
    closeDb(db);
  }
}

function persistPipelineRecord(record) {
  if (!record.ownerInstanceId) record.ownerInstanceId = BRIDGE_INSTANCE_ID;
  if (!record.ownerGeneration) record.ownerGeneration = randomBytes(12).toString("hex");
  record.ownerHeartbeatAt = record.ownerHeartbeatAt || new Date().toISOString();
  record.ownerLeaseExpiresAt = record.ownerLeaseExpiresAt || new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  record.queueMode = "sqlite";
  return enqueuePipelinePersistence(record, async () => {
    if (typeof pipelinePersistenceTestHook === "function") await pipelinePersistenceTestHook(record);
    record.requestEncrypted = await encryptQueueRequest(pipelineReplayRequest(record), record.pipelineId);
    record.detailsEncrypted = await encryptPipelinePrivateDetails(record);
    const snapshot = pipelineRecordDurableSummary(record);
    const persisted = await writePipelineRecordSnapshot({
      ...snapshot,
      requestEncrypted: record.requestEncrypted || "",
      detailsEncrypted: record.detailsEncrypted || "",
    }, { create: true });
    record.revision = Number(persisted.revision || record.revision || 0);
    record.updatedAt = persisted.updatedAt;
    record.ownerHeartbeatAt = persisted.ownerHeartbeatAt;
    record.ownerLeaseExpiresAt = persisted.ownerLeaseExpiresAt;
    return record;
  });
}

// G-11: a pipeline in one of these states never integrates again. The check runs inside the
// serialized, revision-checked write that reserves an item for integration, and abandonment
// re-checks for a reserved item inside its own write, so either the cancellation or the
// reservation wins, never both.
const PIPELINE_INTEGRATION_CLOSED_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function updatePipelineRecord(record, patch = {}) {
  if (!pipelineOwnedByThisInstance(record)) {
    const error = new Error(`Pipeline ${record?.pipelineId || "unknown"} belongs to another bridge instance.`);
    error.code = "pipeline_foreign_owner";
    error.errorType = "pipeline_foreign_owner";
    throw error;
  }
  try {
    return await enqueuePipelinePersistence(record, async () => {
      const expectedRevision = Number(record.revision || 0);
      // A function patch is computed from the record as it stands when this write runs, so
      // two callers that each change one integration item do not overwrite each other.
      const candidate = {
        ...record,
        ...(typeof patch === "function" ? patch(record) : patch),
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        ownerHeartbeatAt: new Date().toISOString(),
        ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      };
      if (typeof pipelinePersistenceTestHook === "function") await pipelinePersistenceTestHook(candidate);
      candidate.detailsEncrypted = await encryptPipelinePrivateDetails(candidate);
      const persisted = await writePipelineRecordSnapshot({
        ...pipelineRecordDurableSummary(candidate),
        detailsEncrypted: candidate.detailsEncrypted,
      }, { expectedRevision });
      candidate.updatedAt = persisted.updatedAt;
      candidate.ownerHeartbeatAt = persisted.ownerHeartbeatAt;
      candidate.ownerLeaseExpiresAt = persisted.ownerLeaseExpiresAt;
      Object.assign(record, candidate);
      return record;
    });
  } catch (error) {
    // The authoritative row is the redacted durable summary (no final validation spec, no
    // events, items without validation specs). Copy only the ownership and state fields;
    // assigning all of it let the next write persist the stripped fields as the record.
    if (error?.authoritative) {
      for (const key of ["status", "revision", "ownerInstanceId", "ownerGeneration", "ownerHeartbeatAt", "ownerLeaseExpiresAt", "batchState", "cleanupState"]) {
        if (Object.prototype.hasOwnProperty.call(error.authoritative, key)) record[key] = error.authoritative[key];
      }
    }
    logEvent("warn", "pipeline.persist_failed", {
      pipelineId: record.pipelineId,
      error: error.message || String(error),
    });
    throw error;
  }
}

async function reconcilePipelineIntegrationOperationStates(record, { persist = true } = {}) {
  // The journal is the authority for an item whose operation was prepared: an integrating
  // item may have committed or rolled back before a crash, and a quarantined item's operation
  // may since have been requalified (recovered_noop) or recovered by the bridge.
  const statuses = new Map();
  for (const item of record.integrationQueue || []) {
    if (!["integrating", "quarantined"].includes(item.status) || !item.operationId) continue;
    const operation = await readIntegrationOperationSummary(record.cwd, item.operationId);
    const operationMatchesItem = Boolean(operation)
      && operation.pipelineId === record.pipelineId
      && operation.pipelineJobId === String(item.jobId || "")
      && (!item.patchSha256 || operation.patchSha256 === item.patchSha256)
      && (!item.sourceStateSha256 || operation.sourceStateSha256 === item.sourceStateSha256);
    let status = item.status;
    if (!operationMatchesItem) status = "quarantined";
    else if (operation.status === "committed") status = "integrated";
    // recovered_verified proved the pre-state like recovered_noop. resolved_by_operator proves
    // nothing about the patch, so its item stays quarantined; abandon the pipeline to retire it.
    else if (["rolled_back", "recovered_noop", "recovered_verified"].includes(operation.status)) status = "pending";
    else if (["quarantined", "resolved_by_operator"].includes(operation.status)) status = "quarantined";
    if (status !== item.status) statuses.set(item.operationId, { from: item.status, to: status });
  }
  if (!statuses.size) return record;
  const patch = (current) => {
    const events = [...(current.events || [])];
    const integrationQueue = (current.integrationQueue || []).map((item) => {
      const change = item.operationId ? statuses.get(item.operationId) : null;
      if (!change || item.status !== change.from) return item;
      events.push({
        type: "integration_journal_reconciled",
        at: new Date().toISOString(),
        operationId: item.operationId,
        jobId: item.jobId || "",
        status: change.to,
      });
      return { ...item, status: change.to };
    });
    // Same rule as a completed integration: the last item landing makes the pipeline finalizable.
    const allIntegrated = integrationQueue.length && integrationQueue.every((item) => item.status === "integrated");
    return {
      integrationQueue,
      events,
      status: allIntegrated && current.status === "awaiting_integration" ? "awaiting_finalization" : current.status,
    };
  };
  if (persist) await updatePipelineRecord(record, patch);
  else Object.assign(record, patch(record));
  return record;
}

async function readPersistedPipelineRecord(pipelineId, cwd = "") {
  const db = await openLockDb(cwd);
  try {
    const row = db.prepare(`
      SELECT status, revision, request_encrypted, details_encrypted, record_json, owner_instance_id, owner_generation,
             owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode
      FROM opencode_pipelines WHERE pipeline_id = ?
    `).get(pipelineId);
    if (!row?.record_json) return null;
    const record = {
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || "",
      ownerGeneration: row.owner_generation || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
      expectedChildCount: Number(row.expected_child_count || 0),
      batchState: row.batch_state || "unstarted",
      cleanupState: row.cleanup_state || "none",
      queueMode: row.queue_mode || "legacy",
    };
    if (row.details_encrypted) {
      Object.assign(record, await decryptPipelinePrivateDetails(row.details_encrypted, pipelineId));
      record.privateDetailsAvailable = true;
    }
    if (row.request_encrypted) {
      const replay = await decryptQueueRequest(row.request_encrypted, pipelineId);
      Object.assign(record, replay);
      record.replayRequestAvailable = true;
    }
    return record;
  } finally {
    closeDb(db);
  }
}

async function listPersistedPipelineRecords(cwd = "", status = "") {
  const db = await openLockDb(cwd);
  try {
    const fields = `status, revision, request_encrypted, record_json, owner_instance_id, owner_generation,
      owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode`;
    const rows = status
      ? db.prepare(`SELECT ${fields} FROM opencode_pipelines WHERE status = ? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT ${fields} FROM opencode_pipelines ORDER BY created_at DESC`).all();
    return rows.map((row) => ({
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || "",
      ownerGeneration: row.owner_generation || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
      expectedChildCount: Number(row.expected_child_count || 0),
      batchState: row.batch_state || "unstarted",
      cleanupState: row.cleanup_state || "none",
      queueMode: row.queue_mode || "legacy",
      replayRequestAvailable: Boolean(row.request_encrypted),
    }));
  } finally {
    closeDb(db);
  }
}

async function authoritativePipelineRecord(pipelineId, cwd = "") {
  if (effectiveQueueMode() !== "sqlite") return PIPELINE_RUNS.get(pipelineId) || null;
  const durable = await readPersistedPipelineRecord(pipelineId, cwd);
  if (!durable) return null;
  const local = PIPELINE_RUNS.get(pipelineId);
  const sameGeneration = local
    && local.ownerInstanceId === durable.ownerInstanceId
    && String(local.ownerGeneration || "") === String(durable.ownerGeneration || "")
    && Number(local.revision || 0) === Number(durable.revision || 0);
  if (sameGeneration) {
    Object.assign(local, durable);
    return local;
  }
  return durable;
}

async function readPersistedPipelineChildren(record) {
  const db = await openLockDb(record.cwd);
  try {
    const rows = db.prepare(`
      SELECT child.ordinal, child.job_id AS relation_job_id,
             job.status, job.started_at, job.finished_at, job.owner_instance_id, job.owner_process_id,
             job.owner_generation, job.heartbeat_at, job.lease_expires_at, job.cancellation_requested_at,
             job.child_process_id, job.child_process_started_at, job.revision, job.idempotency_key,
             job.request_encrypted, job.record_json
      FROM opencode_pipeline_children AS child
      LEFT JOIN opencode_jobs AS job ON job.job_id = child.job_id
      WHERE child.pipeline_id = ?
      ORDER BY child.ordinal
    `).all(record.pipelineId);
    const expectedIds = Array.isArray(record.queueJobIds) ? record.queueJobIds : [];
    const expectedCount = Number(record.expectedChildCount || expectedIds.length || 0);
    const missingOrdinals = [];
    const missingJobIds = [];
    let manifestMismatch = rows.length !== expectedCount || expectedIds.length !== expectedCount;
    const snapshots = [];
    for (let ordinal = 0; ordinal < expectedCount; ordinal += 1) {
      const row = rows[ordinal];
      if (!row || Number(row.ordinal) !== ordinal) {
        missingOrdinals.push(ordinal);
        manifestMismatch = true;
        continue;
      }
      const expectedJobId = expectedIds[ordinal] || "";
      if (!expectedJobId || row.relation_job_id !== expectedJobId) manifestMismatch = true;
      if (!row.record_json) {
        missingJobIds.push(row.relation_job_id || expectedJobId || `ordinal:${ordinal}`);
        manifestMismatch = true;
        continue;
      }
      snapshots.push(persistedQueueRecordFromRow(row));
    }
    return {
      ok: !manifestMismatch,
      expectedCount,
      relationCount: rows.length,
      snapshots,
      missingOrdinals,
      missingJobIds,
    };
  } finally {
    closeDb(db);
  }
}

function pipelineJobStatus(jobId, cwd = "") {
  const memory = QUEUE_JOBS.get(jobId);
  if (memory && recordMatchesProject(memory, cwd)) {
    return queueRecordSnapshot(memory, false);
  }
  return null;
}

function mergePipelineIntegrationQueue(existingQueue = [], queueSnapshots = []) {
  const existing = existingQueue.map((item) => ({ ...item }));
  const used = new Set();
  // A writer that changed nothing has its empty worktree removed and nothing to integrate;
  // an item for it could never become integrated and would block finalization for good.
  const writeSnapshots = queueSnapshots.filter((job) => job.worktreePath && !job.noChanges && (job.changedFiles || []).length);
  return writeSnapshots.map((job) => {
    let matchIndex = existing.findIndex((item, index) => !used.has(index) && item.jobId && item.jobId === job.jobId);
    if (matchIndex < 0) {
      const allowedKey = JSON.stringify(normalizeLockPathList(job.allowedEdits || []).sort());
      matchIndex = existing.findIndex((item, index) => !used.has(index)
        && (!item.agent || item.agent === job.agent)
        && JSON.stringify(normalizeLockPathList(item.allowedEdits || []).sort()) === allowedKey);
    }
    if (matchIndex < 0) {
      matchIndex = existing.findIndex((item, index) => !used.has(index) && (!item.jobId || item.jobId === job.jobId));
    }
    const prior = matchIndex >= 0 ? existing[matchIndex] : {};
    if (matchIndex >= 0) used.add(matchIndex);
    return {
      ...prior,
      jobId: job.jobId,
      agent: prior.agent || job.agent || "",
      worktreePath: job.worktreePath,
      branch: job.worktreeBranch || prior.branch || "",
      sourceBaseCommit: job.worktreeBaseCommit || prior.sourceBaseCommit || "",
      sourceBaseTree: job.worktreeBaseTree || prior.sourceBaseTree || "",
      patchSha256: job.worktreePatchSha256 || prior.patchSha256 || "",
      sourceStateSha256: job.worktreeSourceStateSha256 || prior.sourceStateSha256 || "",
      allowedEdits: job.allowedEdits || prior.allowedEdits || [],
      changedFiles: job.changedFiles || prior.changedFiles || [],
      status: ["integrated", "rejected", "integrating", "quarantined"].includes(prior.status)
        ? prior.status
        : "pending",
    };
  });
}

async function refreshPipelineRecord(record, { persist = true } = {}) {
  if (["completed", "failed", "cancelled", "cleanup_pending", "cleanup_failed", "finalizing"].includes(record.status)) {
    return record;
  }
  // A crash between the journal commit and the pipeline update leaves an item integrating
  // although its operation committed; the journal decides before the status is derived.
  await reconcilePipelineIntegrationOperationStates(record, { persist });
  // The entry check above can be stale by the time a write runs (abandonment may have committed
  // meanwhile), so each write re-checks against the record as it stands then (G-11 review).
  const frozen = (current) => ["completed", "failed", "cancelled", "cleanup_pending", "cleanup_failed", "finalizing"].includes(current.status);
  const guarded = (patch) => (current) => (frozen(current) ? {} : (typeof patch === "function" ? patch(current) : patch));
  const applyPatch = persist
    ? (patch) => updatePipelineRecord(record, guarded(patch))
    : async (patch) => Object.assign(record, guarded(patch)(record));
  let queueSnapshots = [];
  if (effectiveQueueMode() === "sqlite") {
    const children = await readPersistedPipelineChildren(record);
    if (!children.ok) {
      await applyPatch({
        status: "failed",
        finishedAt: record.finishedAt || new Date().toISOString(),
        batchState: "incomplete",
        errors: (record.errors || []).concat({
          errorType: "pipeline_child_record_missing",
          expectedChildCount: children.expectedCount,
          relationCount: children.relationCount,
          missingOrdinals: children.missingOrdinals,
          missingJobIds: children.missingJobIds,
        }),
        events: (record.events || []).concat({
          type: "pipeline_child_manifest_invalid",
          at: new Date().toISOString(),
          expectedChildCount: children.expectedCount,
          relationCount: children.relationCount,
        }),
      });
      return record;
    }
    queueSnapshots = children.snapshots;
  } else {
    for (const jobId of record.queueJobIds || []) {
      const snapshot = pipelineJobStatus(jobId, record.cwd);
      if (snapshot) queueSnapshots.push(snapshot);
    }
  }

  if (queueSnapshots.length) {
    const failed = queueSnapshots.filter((job) => ["failed", "interrupted", "not_resumable"].includes(job.status));
    const cancelled = queueSnapshots.filter((job) => job.status === "cancelled");
    const completed = queueSnapshots.filter((job) => job.status === "completed");
    const active = queueSnapshots.filter((job) => ["pending", "planned", "blocked", "running", "validating", "reviewing", "testing"].includes(job.status));
    const events = (record.events || []).filter((event) => event.type !== "queue_status");
    events.push({
      type: "queue_status",
      at: new Date().toISOString(),
      jobs: queueSnapshots.map((job) => ({
        jobId: job.jobId,
        status: job.status,
        errorType: job.errorType || "",
        worktreePath: job.worktreePath || "",
        changedFiles: job.changedFiles || [],
      })),
    });

    if (failed.length || cancelled.length) {
      await applyPatch({
        status: failed.length ? "failed" : "cancelled",
        finishedAt: record.finishedAt || new Date().toISOString(),
        events,
        errors: failed.concat(cancelled).map((job) => ({
          jobId: job.jobId,
          status: job.status,
          errorType: job.errorType || "",
          errorReason: job.errorReason || "",
        })),
      });
    } else if (completed.length === queueSnapshots.length) {
      await applyPatch((current) => {
        const integrationQueue = mergePipelineIntegrationQueue(current.integrationQueue || [], queueSnapshots);
        const allIntegrated = integrationQueue.every((item) => item.status === "integrated");
        return {
          status: allIntegrated ? "awaiting_finalization" : "awaiting_integration",
          finishedAt: current.finishedAt || new Date().toISOString(),
          events,
          integrationQueue,
        };
      });
    } else if (active.length) {
      await applyPatch({ status: "running", events });
    }
  }

  return record;
}

async function reconcileParentPipelineAfterQueueTerminal(childRecord) {
  const pipelineId = childRecord?.pipelinePropagation?.pipelineId || childRecord?.parentJobId || "";
  if (!pipelineId || effectiveQueueMode() !== "sqlite") return null;
  const parent = await readPersistedPipelineRecord(pipelineId, childRecord.cwd || "");
  if (!parent) return null;
  PIPELINE_RUNS.set(pipelineId, parent);

  if (["failed", "cancelled"].includes(parent.status)) {
    for (const siblingJobId of parent.queueJobIds || []) {
      if (siblingJobId === childRecord.jobId) continue;
      const durableSibling = await readPersistedQueueRecord(siblingJobId, parent.cwd);
      const localSibling = QUEUE_JOBS.get(siblingJobId);
      if (!durableSibling || !localSibling) continue;
      const abortController = localSibling.abortController;
      const executionPromise = localSibling.executionPromise;
      Object.assign(localSibling, durableSibling, { abortController, executionPromise });
      if (durableSibling.cancellationRequested || durableSibling.status === "cancelled") {
        abortController?.abort(new Error(`Parent pipeline ${pipelineId} became ${parent.status}.`));
      }
    }
    return parent;
  }

  if (childRecord?.pipelinePropagation?.allChildrenTerminal) {
    await refreshPipelineRecord(parent);
  }
  return parent;
}


// Finalization judges the reviewed result: HEAD, tree, status, working patch and index.
// captureIntegrationTargetState also fingerprints ignored files (mtime/ctime), so a test run
// that writes __pycache__/ or coverage/ looked like a changed target and failed the pipeline.
function trackedTargetStateSha256(state) {
  if (!state?.ok) return "";
  return createHash("sha256")
    .update([state.targetHead, state.targetTree, state.statusSha256, state.workingPatchSha256, state.indexSha256].join("\0"))
    .digest("hex");
}

// Gate and final-validation outcomes that judge the result itself end the pipeline; anything
// else (a provider rate limit, a lost lease, a snapshot fault, drift from another client) is
// retried by finalizing again.
const PIPELINE_TERMINAL_GATE_ERROR_TYPES = new Set([
  "pipeline_gate_verdict_fail",
  "pipeline_gate_agent_not_read_only",
  // A gate agent that edited files (changedFileValidationErrorType of its validation).
  ...PIPELINE_SOURCE_SCOPE_VIOLATION_TYPES,
]);
const PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES = new Set([
  "validation_command_failed",
  "validation_command_untrusted",
  "validation_command_parse_error",
  "final_validation_required",
]);

async function deferPipelineFinalization(record, { type, errorType, error, patch = {} }) {
  const at = new Date().toISOString();
  await updatePipelineRecord(record, (current) => PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status) ? {} : ({
    ...patch,
    status: "awaiting_finalization",
    finishedAt: "",
    errors: (current.errors || []).concat({ type, errorType, error, retryable: true }),
    events: (current.events || []).concat({ type: "finalization_deferred", at, errorType }),
  }));
  return {
    ok: false,
    errorType,
    error: `${error} The pipeline stays awaiting_finalization; finalize again once the cause is cleared. Source worktrees were retained.`,
    retryable: true,
    record,
  };
}

// A gate agent that ends cleanly has not therefore approved the result: its verdict is read
// from its own report, and a missing, conflicting, or unreadable verdict fails closed.
const PIPELINE_GATE_VERDICT_INSTRUCTION = [
  "Gate verdict (required): the bridge reads your verdict mechanically from your final report.",
  "The very last line of the report must be exactly GATE_VERDICT: pass or GATE_VERDICT: fail, with nothing after it: put it after any Final Report section, not inside a list, quote, or code block.",
  "Do not write the word GATE_VERDICT anywhere else in the report, not even as an example or a quote.",
  "Write fail if you found any blocking issue, if a check the task asks for fails or could not be run, or if you could not finish the review.",
  "Any other placement or form fails the gate.",
].join("\n");
// Only bold or code emphasis may wrap the verdict; a quote or list marker makes it an example.
const PIPELINE_GATE_VERDICT_LINE = /^[*_`]*GATE_VERDICT[*_`]*:[*_`]* ?[*_`]*(pass|fail)[*_`]*$/i;

function parsePipelineGateVerdict(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mentions = lines.filter((line) => /GATE_VERDICT/i.test(line));
  if (mentions.length > 1) return "ambiguous";
  const match = lines.length ? PIPELINE_GATE_VERDICT_LINE.exec(lines[lines.length - 1]) : null;
  if (!match) return mentions.length ? "misplaced" : "missing";
  return match[1].toLowerCase();
}

const PIPELINE_GATE_VERDICT_ERROR_TYPES = {
  fail: "pipeline_gate_verdict_fail",
  missing: "pipeline_gate_verdict_missing",
  misplaced: "pipeline_gate_verdict_misplaced",
  ambiguous: "pipeline_gate_verdict_ambiguous",
};

async function runPipelineReadOnlyGate(record, gateName, gateJob, signal = null, checkedTargetStateSha256 = "") {
  if (!gateJob) {
    return null;
  }

  if (!isManagedReadOnlyAgent(gateJob.agent)) {
    return {
      gate: gateName,
      status: "failed",
      errorType: "pipeline_gate_agent_not_read_only",
      changedFiles: [],
      text: `Pipeline ${gateName} gate requires a managed read-only agent; received "${gateJob.agent}".`,
    };
  }

  const executeGateJob = typeof pipelineGateExecutorTestHook === "function" ? pipelineGateExecutorTestHook : executeOpenCodeJob;
  // The integrated changes are uncommitted in record.cwd, so a gate must read that checkout:
  // under CODEX_OPENCODE_WORKTREE_MODE=all a fresh worktree from HEAD would review the
  // pre-integration tree. Each attempt gets its own job id (a retried gate reused one).
  const gateAttemptJobId = `${record.pipelineId}-${randomBytes(4).toString("hex")}-${gateName}`;
  const execution = await executeGateJob({
    ...gateJob,
    cwd: record.cwd,
    noWorktree: true,
    write: false,
    lockType: "read",
    lockMode: "off",
    allowedEdits: [],
    forbiddenEdits: mergePathLists(gateJob.forbiddenEdits, record.policy?.forbiddenEdits, record.policy?.sharedFiles, record.policy?.serialOnly),
    sharedFiles: mergePathLists(gateJob.sharedFiles, record.policy?.sharedFiles),
    sanitizedWorkspace: gateJob.sanitizedWorkspace || record.sanitizedWorkspace || undefined,
    subagentStrategy: record.sanitizedWorkspace ? "reject" : (gateJob.subagentStrategy || "reject"),
    task: [
      gateJob.task,
      "",
      `Pipeline id: ${record.pipelineId}`,
      "Review/test the integrated result only. Do not edit files.",
      "",
      PIPELINE_GATE_VERDICT_INSTRUCTION,
    ].filter(Boolean).join("\n"),
  }, { toolStarted: nowMs(), jobId: gateAttemptJobId, signal });

  // An agent that errored or edited files fails on that ground; its verdict is not consulted.
  const runErrorType = execution.result?.errorType
    || (execution.validation?.disallowedFiles?.length ? changedFileValidationErrorType(execution.validation) : "");
  // result.stdout is the agent's own final response, untruncated whenever errorType is empty
  // (a bridge-truncated response is itself the essential_output_truncated error).
  const verdict = runErrorType ? "not_read" : parsePipelineGateVerdict(execution.result?.stdout);
  const errorType = runErrorType || (verdict === "pass" ? "" : PIPELINE_GATE_VERDICT_ERROR_TYPES[verdict]);
  return {
    gate: gateName,
    status: errorType ? "failed" : "passed",
    errorType,
    verdict,
    checkedTargetStateSha256,
    changedFiles: execution.result?.changedFiles || [],
    text: truncateResultText(execution.response?.content?.[0]?.text || "", 12000),
  };
}

function cleanupAuthorizationMatchesItem(record, authorization, item) {
  if (!authorization || !item) return false;
  const cwd = record.cwd || process.cwd();
  const authorizationPath = normalizeFilesystemCase(path.resolve(String(authorization.worktreePath || "")), cwd);
  const itemPath = normalizeFilesystemCase(path.resolve(String(item.worktreePath || "")), cwd);
  return Boolean(authorization.worktreePath && item.worktreePath)
    && authorizationPath === itemPath
    && String(authorization.branch || "") === String(item.branch || "")
    && String(authorization.sourceBaseCommit || "") === String(item.sourceBaseCommit || "")
    && String(authorization.patchSha256 || "") === String(item.patchSha256 || "")
    && String(authorization.sourceStateSha256 || "") === String(item.sourceStateSha256 || "");
}

async function finalizePipelineSourceCleanup(record, {
  dryRun = false,
  authorizeCleanup = null,
  authorizedWorktrees = null,
} = {}) {
  const durableAuthorizations = Array.isArray(authorizedWorktrees) ? authorizedWorktrees : null;
  const cleanupPlan = [];
  for (const item of record.integrationQueue || []) {
    if (!item.cleanupRequested || !item.worktreePath) continue;
    if (durableAuthorizations) {
      const matchingAuthorizations = durableAuthorizations.filter((authorization) => cleanupAuthorizationMatchesItem(record, authorization, item));
      if (matchingAuthorizations.length !== 1) {
        cleanupPlan.push({
          result: {
            worktreePath: item.worktreePath,
            branch: item.branch || "",
            cleanup: "retained_for_review",
            reason: "cleanup_identity_not_durably_authorized",
          },
        });
        continue;
      }
    }
    if (dryRun) {
      cleanupPlan.push({ result: { worktreePath: item.worktreePath, cleanup: "skipped_dry_run" } });
      continue;
    }
    if (!existsSync(item.worktreePath)) {
      const branch = String(item.branch || "").trim();
      const worktrees = await runCommand("git", ["worktree", "list", "--porcelain"], record.cwd, 1000 * 15);
      const branchRef = branch
        ? await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], record.cwd, 1000 * 15)
        : { exitCode: 1 };
      // git prints `worktree C:/Users/...` (forward slashes, its own case); compare resolved,
      // case-normalized paths or a registered worktree reads as already removed on Windows.
      const itemWorktreeKey = normalizeFilesystemCase(path.resolve(item.worktreePath), record.cwd);
      const registered = worktrees.exitCode === 0
        && worktrees.stdout.split(/\r?\n/).some((line) => line.startsWith("worktree ")
          && normalizeFilesystemCase(path.resolve(line.slice("worktree ".length)), record.cwd) === itemWorktreeKey);
      cleanupPlan.push({
        result: !registered && branchRef.exitCode !== 0
          ? { worktreePath: item.worktreePath, branch, cleanup: "success", reason: "recovered_already_removed" }
          : { worktreePath: item.worktreePath, branch, cleanup: "retained_for_review", reason: "cleanup_identity_ambiguous_after_restart" },
      });
      continue;
    }
    const source = await collectIntegrationPatch({
      cwd: record.cwd,
      worktreePath: item.worktreePath,
      sourceBaseCommit: item.sourceBaseCommit || "",
    });
    if (!source.ok || source.patchSha256 !== item.patchSha256 || source.sourceStateSha256 !== item.sourceStateSha256) {
      cleanupPlan.push({
        result: {
          worktreePath: item.worktreePath,
          cleanup: "retained_for_review",
          reason: "integration_source_changed_after_review",
        },
      });
      continue;
    }
    const branch = await runCommand("git", ["branch", "--show-current"], item.worktreePath, 1000 * 15);
    if (branch.exitCode !== 0 || !branch.stdout.trim()) {
      cleanupPlan.push({
        result: {
          worktreePath: item.worktreePath,
          cleanup: "retained_for_review",
          reason: "source_branch_identity_unverified",
        },
      });
      continue;
    }
    cleanupPlan.push({
      item,
      authorization: {
        worktreePath: item.worktreePath,
        branch: branch.stdout.trim(),
        sourceBaseCommit: source.sourceBaseCommit,
        patchSha256: source.patchSha256,
        sourceStateSha256: source.sourceStateSha256,
        cleanup: "authorized",
        authorizedAt: new Date().toISOString(),
      },
    });
  }

  const authorizations = cleanupPlan.filter((entry) => entry.authorization).map((entry) => entry.authorization);
  if (authorizations.length) {
    if (typeof authorizeCleanup !== "function") {
      throw new Error("Pipeline source cleanup requires a durable authorization callback.");
    }
    await authorizeCleanup(cleanupPlan.map((entry) => entry.authorization || entry.result), authorizations);
  }

  const results = [];
  for (const entry of cleanupPlan) {
    if (!entry.authorization) {
      results.push(entry.result);
      continue;
    }
    const source = await collectIntegrationPatch({
      cwd: record.cwd,
      worktreePath: entry.item.worktreePath,
      sourceBaseCommit: entry.item.sourceBaseCommit || "",
    });
    const branch = source.ok
      ? await runCommand("git", ["branch", "--show-current"], entry.item.worktreePath, 1000 * 15)
      : null;
    if (!source.ok
      || source.patchSha256 !== entry.authorization.patchSha256
      || source.sourceStateSha256 !== entry.authorization.sourceStateSha256
      || !branch
      || branch.exitCode !== 0
      || branch.stdout.trim() !== entry.authorization.branch) {
      results.push({
        ...entry.authorization,
        cleanup: "retained_for_review",
        reason: "integration_source_changed_after_cleanup_authorization",
      });
      continue;
    }
    const cleanup = await cleanupWorktree({
      path: path.resolve(entry.item.worktreePath),
      repoRoot: path.resolve(record.cwd),
      branch: entry.authorization.branch,
    }, "always", true);
    results.push({
      ...entry.authorization,
      ...cleanup,
      completedAt: new Date().toISOString(),
    });
  }
  return results;
}

async function resumeAuthorizedPipelineCleanup(record) {
  const authorizationEvent = [...(record.events || [])].reverse().find((event) => event.type === "source_cleanup_authorized");
  const expectedTargetStateSha256 = authorizationEvent?.targetStateSha256 || "";
  const cleanupItems = (record.integrationQueue || []).filter((item) => item.cleanupRequested && item.worktreePath);
  const eventWorktrees = Array.isArray(authorizationEvent?.worktrees) ? authorizationEvent.worktrees : [];
  // Each authorization must name exactly one item and vice versa. An item that finalized as
  // retained/already removed before the crash has a terminal cleanup result and no
  // authorization; requiring one authorization per item kept every authorized worktree.
  const cwd = record.cwd || process.cwd();
  const worktreeKey = (value) => normalizeFilesystemCase(path.resolve(String(value || "")), cwd);
  // "failed" stays retryable; "authorized" is what recovery is for.
  const terminalCleanupResults = (record.sourceCleanupResults || [])
    .filter((result) => result?.worktreePath && ["success", "partial", "retained_for_review"].includes(result.cleanup));
  const terminalCleanupKeys = new Set(terminalCleanupResults.map((result) => worktreeKey(result.worktreePath)));
  const itemsAwaitingCleanup = cleanupItems.filter((item) => !terminalCleanupKeys.has(worktreeKey(item.worktreePath)));
  const authorizedWorktrees = eventWorktrees.filter((authorization) => {
    const matchingItems = itemsAwaitingCleanup.filter((item) => cleanupAuthorizationMatchesItem(record, authorization, item));
    if (matchingItems.length !== 1) return false;
    return eventWorktrees.filter((other) => cleanupAuthorizationMatchesItem(record, other, matchingItems[0])).length === 1;
  });
  const targetState = expectedTargetStateSha256 ? await captureIntegrationTargetState(record.cwd) : null;
  const expectedTrackedTargetStateSha256 = authorizationEvent?.trackedTargetStateSha256 || "";
  const targetStateMatches = expectedTrackedTargetStateSha256
    ? targetState?.ok && trackedTargetStateSha256(targetState) === expectedTrackedTargetStateSha256
    : targetState?.ok && targetState.targetStateSha256 === expectedTargetStateSha256;
  if (!expectedTargetStateSha256 || !targetStateMatches) {
    await updatePipelineRecord(record, {
      status: "completed",
      finishedAt: record.finishedAt || new Date().toISOString(),
      cleanupPending: false,
      cleanupState: "completed_with_retained_sources",
      errors: (record.errors || []).concat({
        type: "source_cleanup",
        errorType: "pipeline_cleanup_target_state_changed",
        error: "The target state no longer matches the durable cleanup authorization; source worktrees were retained.",
      }),
    });
    return { ok: true, retainedSources: true, warningType: "pipeline_cleanup_target_state_changed", record };
  }

  const resumedCleanupResults = await finalizePipelineSourceCleanup({ ...record, integrationQueue: itemsAwaitingCleanup }, {
    authorizeCleanup: async () => {},
    authorizedWorktrees,
  });
  const sourceCleanupResults = terminalCleanupResults.concat(resumedCleanupResults);
  const failures = sourceCleanupResults.filter((result) => result.cleanup === "failed");
  const retained = sourceCleanupResults.filter((result) => ["retained_for_review", "partial"].includes(result.cleanup));
  await updatePipelineRecord(record, {
    status: failures.length ? "cleanup_failed" : "completed",
    finishedAt: failures.length ? "" : (record.finishedAt || new Date().toISOString()),
    sourceCleanupResults,
    cleanupPending: failures.length > 0,
    cleanupState: failures.length ? "failed_retryable" : retained.length ? "completed_with_retained_sources" : "completed",
    events: (record.events || []).concat({
      type: failures.length ? "source_cleanup_recovery_failed" : "source_cleanup_recovered",
      at: new Date().toISOString(),
      retainedSources: retained.length,
    }),
  });
  return failures.length
    ? { ok: false, errorType: "pipeline_cleanup_failed", record }
    : { ok: true, record };
}

// The finalizer's repository lease is shared, so this set is what stops two finalizations of
// one pipeline in this process from running their gates and cleanup side by side.
const FINALIZING_PIPELINE_IDS = new Set();

async function finalizePipelineRecord(record, options = {}) {
  const pipelineKey = record.pipelineId || "";
  if (pipelineKey && FINALIZING_PIPELINE_IDS.has(pipelineKey)) {
    return {
      ok: false,
      errorType: "pipeline_finalization_in_progress",
      error: `Pipeline ${pipelineKey} is already being finalized by this bridge.`,
      record,
    };
  }
  if (pipelineKey) FINALIZING_PIPELINE_IDS.add(pipelineKey);
  try {
    return await finalizePipelineRecordUnderLease(record, options);
  } finally {
    if (pipelineKey) FINALIZING_PIPELINE_IDS.delete(pipelineKey);
  }
}

async function finalizePipelineRecordUnderLease(record, options = {}) {
  const targetCwd = await resolveProjectStateRoot(record.cwd || process.cwd());
  if (options.dryRun) {
    // A dry run reports whether finalization could start now without taking the repository
    // lease, and derives the current status in memory: it never changes the durable record.
    const conflict = (await listLocks(targetCwd))
      .map((lock) => conflictsWithActiveLock({ lockType: "read", paths: [REPOSITORY_SCOPE_LOCK_PATH] }, lock))
      .find(Boolean);
    if (conflict) {
      return {
        ok: false,
        errorType: "pipeline_finalization_lock_conflict",
        error: `Pipeline finalization requires a stable repository snapshot: active ${conflict.lockType} lock ${conflict.lockId} (${conflict.agent || "unknown"}) holds ${conflictPathsFromConflict(conflict).join(", ") || "the repository"}.`,
        conflictingPaths: conflictPathsFromConflict(conflict),
        record,
      };
    }
    const view = {
      ...record,
      integrationQueue: (record.integrationQueue || []).map((item) => ({ ...item })),
      events: [...(record.events || [])],
      errors: [...(record.errors || [])],
    };
    return { ...(await finalizePipelineRecordWhileLocked(view, options)), record };
  }
  const lockTtlMs =Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + CONFIG.readOnlyRetryMaxElapsedMs * 2 + 1000 * 60 * 5);
  const lockResult = await acquireHardLock({
    owner: "codex",
    agent: "pipeline_finalizer",
    task: `Finalize pipeline ${record.pipelineId || "unknown"}`,
    cwd: targetCwd,
    lockType: "read",
    paths: [REPOSITORY_SCOPE_LOCK_PATH],
    repositoryScope: true,
    ttlMs: lockTtlMs,
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      errorType: "pipeline_finalization_lock_conflict",
      error: `Pipeline finalization requires a stable repository snapshot: ${lockResult.error}`,
      conflictingPaths: conflictPathsFromConflict(lockResult.conflict),
      record,
    };
  }
  const heartbeat = startHardLockHeartbeat(lockResult.lock, lockTtlMs);
  try {
    return await finalizePipelineRecordWhileLocked(record, { ...options, signal: combineAbortSignals([options.signal, heartbeat.signal]) });
  } finally {
    heartbeat();
    await releaseHardLock(lockResult.lock.id, lockResult.lock.token, lockResult.lock.paths, lockResult.lock.cwd);
  }
}

async function finalizePipelineRecordWhileLocked(record, { skipReviewers = false, dryRun = false, beforeFinalValidationHook = null, signal = null } = {}) {
  // The journal decides items whose integration committed before a crash (refresh reconciles
  // them too, but returns early for a crashed "finalizing" record).
  await reconcilePipelineIntegrationOperationStates(record, { persist: !dryRun });
  await refreshPipelineRecord(record, { persist: !dryRun });
  const now = new Date().toISOString();
  const events = (record.events || []).concat({
    type: "finalization_started",
    at: now,
    dryRun,
    skipReviewers,
  });
  // A dry run reports what finalization would do; it never persists a rejection or a status.
  const recordRejection = dryRun ? async () => {} : (patch) => updatePipelineRecord(record, patch);

  // A finalized pipeline is terminal: its gates already ran against the state they recorded,
  // and running them again later would judge a different tree under the same result.
  if (record.status === "completed") {
    return { ok: true, alreadyFinalized: true, record };
  }
  if (["cleanup_pending", "cleanup_failed"].includes(record.status)) {
    return {
      ok: false,
      errorType: "pipeline_already_finalized",
      error: `Pipeline gates already passed; status is ${record.status} and source cleanup is resumed by the bridge's cleanup recovery.`,
      record,
    };
  }

  if (["failed", "cancelled"].includes(record.status)) {
    await recordRejection({
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_not_finalizable",
        error: `Pipeline status is ${record.status}.`,
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_not_finalizable",
      error: `Pipeline status is ${record.status}.`,
      record,
    };
  }

  if (pipelineHasPendingIntegrations(record)) {
    await recordRejection({
      status: ["awaiting_finalization", "finalizing"].includes(record.status) ? "awaiting_integration" : record.status,
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_pending_integrations",
        error: "All integrationQueue entries must be integrated before finalization.",
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_pending_integrations",
      error: "All integrationQueue entries must be integrated before finalization.",
      record,
    };
  }

  // refreshPipelineRecord derives awaiting_finalization from the durable children only once
  // every job completed and every integration landed; "finalizing" is a crashed finalization.
  if (!["awaiting_finalization", "finalizing"].includes(record.status)) {
    await recordRejection({
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_jobs_incomplete",
        error: `Pipeline status is ${record.status}; every job must complete before finalization.`,
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_jobs_incomplete",
      error: `Pipeline status is ${record.status}; every job must complete and be integrated before finalization.`,
      record,
    };
  }

  if (skipReviewers && (record.reviewerJob || record.testerJob)) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "pipeline_configured_gates_required",
        error: "Configured reviewer/tester gates may not be skipped before pipeline completion or cleanup.",
      }),
    });
    return {
      ok: false,
      errorType: "pipeline_configured_gates_required",
      error: "Configured reviewer/tester gates must run and pass; source worktrees were retained.",
      record,
    };
  }

  const finalValidationSource = record.finalValidationSource
    || (record.policy?.path && record.finalValidationCommand ? "legacy_unknown" : "none");
  const finalValidationSourceValid = record.finalValidationCommand
    ? ["caller", "policy"].includes(finalValidationSource)
    : finalValidationSource === "none";
  if (!finalValidationSourceValid) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "policy_validation_command_untrusted",
        error: "Final validation has missing, unknown, or inconsistent command provenance. Legacy records are audit-only.",
      }),
    });
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Final validation provenance is not trusted; source worktrees were retained.",
      record,
    };
  }
  if (["policy", "legacy_unknown"].includes(finalValidationSource) && record.finalValidationCommand && !record.finalValidationSpec) {
    await recordRejection({
      status: "awaiting_finalization",
      events,
      errors: (record.errors || []).concat({
        type: "finalization",
        errorType: "policy_validation_command_untrusted",
        error: "A policy-derived validation command lacks its exact trusted executable/argument attestation. Legacy records are audit-only.",
      }),
    });
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Policy validation attestation is missing; source worktrees were retained.",
      record,
    };
  }

  if (finalValidationSource === "legacy_unknown" && record.finalValidationSpec) {
    return {
      ok: false,
      errorType: "policy_validation_command_untrusted",
      error: "Legacy validation provenance is ambiguous; source worktrees were retained.",
      record,
    };
  }

  if (finalValidationSource === "policy" && record.policy?.path && record.finalValidationSpec) {
    const currentPolicy = await loadProjectAgentPolicy(record.cwd, record.policy.path);
    const samePolicy = currentPolicy.ok
      && currentPolicy.sha256 === record.policy.sha256
      && currentPolicy.policy?.finalValidationSpec?.commandSha256 === record.finalValidationSpec.commandSha256;
    if (!samePolicy) {
      await recordRejection({
        status: "awaiting_finalization",
        events,
        errors: (record.errors || []).concat({
          type: "finalization",
          errorType: "policy_validation_command_untrusted",
          error: currentPolicy.error || "The project policy approval, bytes, executable pin, or exact validation vector changed before finalization.",
        }),
      });
      return {
        ok: false,
        errorType: "policy_validation_command_untrusted",
        error: "Project policy trust was revoked or changed; source worktrees were retained.",
        record,
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRun: {
        finalValidationCommand: record.sanitizedWorkspace ? "" : record.finalValidationCommand || "",
        gates: skipReviewers ? [] : ["reviewer", "tester"].filter((gateName) => record[`${gateName}Job`]),
      },
      record,
    };
  }

  try {
    await updatePipelineRecord(record, (current) => {
      if (PIPELINE_INTEGRATION_CLOSED_STATUSES.has(current.status)) throw pipelineTerminalError(current);
      return { status: "finalizing", events };
    });
  } catch (error) {
    if (error?.errorType !== "pipeline_terminal") throw error;
    return { ok: false, errorType: "pipeline_terminal", error: `${error.message} Nothing was finalized and no source worktree was removed.`, record };
  }
  const sanitizedBeforeFinalGates = record.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(record.sanitizedWorkspace, "pipeline_before_final_gates")
    : null;
  if (sanitizedBeforeFinalGates && !sanitizedBeforeFinalGates.ok) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      sanitizedWorkspaceAttestation: { ...(record.sanitizedWorkspaceAttestation || {}), beforeFinalGates: sanitizedBeforeFinalGates },
      errors: (record.errors || []).concat({ type: "sanitized_workspace", errorType: sanitizedBeforeFinalGates.errorType, error: sanitizedBeforeFinalGates.error }),
    });
    return { ok: false, errorType: sanitizedBeforeFinalGates.errorType, error: "Sanitized workspace changed before final gates.", record };
  }
  let finalValidationBeforeState = null;
  let finalValidationBeforeFiles = new Map();
  let finalValidationEvidenceError = "";
  if (!record.sanitizedWorkspace && !dryRun) {
    try {
      finalValidationBeforeState = await captureIntegrationTargetState(record.cwd);
      if (!finalValidationBeforeState.ok) finalValidationEvidenceError = finalValidationBeforeState.error || "Could not capture pipeline target state before final validation.";
      else finalValidationBeforeFiles = await gitChangedFileSnapshot(record.cwd, { includeIgnored: false });
    } catch (error) {
      finalValidationEvidenceError = redactSensitiveText(error.message || String(error));
    }
  }
  if (!record.sanitizedWorkspace && !dryRun && !finalValidationEvidenceError && typeof beforeFinalValidationHook === "function") {
    await beforeFinalValidationHook({ cwd: record.cwd, record });
  }
  let finalValidationResult = record.sanitizedWorkspace
    ? { status: "manifest_only", command: "", exitCode: "not_applicable", durationMs: 0, stdout: "", stderr: "", errorType: null }
    : finalValidationEvidenceError
      ? { status: "failed", command: record.finalValidationCommand || "", exitCode: "not_run", durationMs: 0, stdout: "", stderr: finalValidationEvidenceError, errorType: "final_validation_snapshot_failed" }
      : await runValidationGate({
          command: record.finalValidationCommand,
          cwd: record.cwd,
          dryRun,
          trustedSpec: record.finalValidationSpec || null,
          signal,
        });
  let finalValidationAfterState = finalValidationBeforeState;
  let finalValidationMutationFiles = [];
  if (!record.sanitizedWorkspace && !dryRun && !finalValidationEvidenceError) {
    try {
      finalValidationAfterState = await captureIntegrationTargetState(record.cwd);
      const finalValidationAfterFiles = await gitChangedFileSnapshot(record.cwd, { includeIgnored: false });
      finalValidationMutationFiles = changedFilesBetween(finalValidationBeforeFiles, finalValidationAfterFiles);
      // Tracked state only: ignored output of the validation command (__pycache__/) is not
      // a change to the reviewed result.
      const stateChanged = !finalValidationAfterState.ok
        || trackedTargetStateSha256(finalValidationAfterState) !== trackedTargetStateSha256(finalValidationBeforeState);
      if (stateChanged || finalValidationMutationFiles.length) {
        finalValidationResult = {
          ...finalValidationResult,
          status: "failed",
          errorType: "final_validation_mutated_workspace",
          stderr: [finalValidationResult.stderr, `Final validation changed unreviewed target state${finalValidationMutationFiles.length ? `: ${finalValidationMutationFiles.join(", ")}` : "."} The changes and source worktrees were retained.`].filter(Boolean).join("\n"),
          mutationFiles: finalValidationMutationFiles,
          beforeTargetStateSha256: finalValidationBeforeState.targetStateSha256,
          afterTargetStateSha256: finalValidationAfterState.targetStateSha256 || "",
        };
      }
    } catch (error) {
      finalValidationResult = {
        ...finalValidationResult,
        status: "failed",
        errorType: "final_validation_snapshot_failed",
        stderr: [finalValidationResult.stderr, redactSensitiveText(error.message || String(error))].filter(Boolean).join("\n"),
      };
    }
  }
  const finalValidationRequired = (record.integrationQueue || []).length > 0;
  if (finalValidationResult.errorType || (finalValidationRequired && finalValidationResult.status !== "passed")) {
    const finalErrorType = finalValidationResult.errorType || "final_validation_required";
    // Only a validation that ran and failed judges the result. A snapshot fault, state drift
    // from another client, or a lost lease (an aborted command) is retried by finalizing again.
    if (signal?.aborted || !PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES.has(finalErrorType)) {
      return deferPipelineFinalization(record, {
        type: "final_validation",
        errorType: signal?.aborted ? abortSignalErrorType(signal, "read_lock_ownership_lost") : finalErrorType,
        error: finalValidationResult.stderr || finalValidationResult.stdout || "Final validation could not be completed.",
        patch: { finalValidationResult },
      });
    }
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      errors: (record.errors || []).concat({
        type: "final_validation",
        errorType: finalErrorType,
        error: finalValidationResult.stderr || finalValidationResult.stdout || "Final validation failed.",
      }),
      events: (record.events || []).concat({
        type: "finalization_failed",
        at: new Date().toISOString(),
        errorType: finalErrorType,
      }),
    });
    return {
      ok: false,
      errorType: finalErrorType,
      error: "Final validation failed.",
      record,
    };
  }

  // Both gates are read-only and inspect the same validated target state, so they run together;
  // the pre-cleanup state check below proves that state did not move while they ran.
  const gateTargetStateSha256 = finalValidationAfterState?.targetStateSha256 || "";
  const gateOutcomes = skipReviewers ? [] : await Promise.allSettled([
    runPipelineReadOnlyGate(record, "reviewer", record.reviewerJob, signal, gateTargetStateSha256),
    runPipelineReadOnlyGate(record, "tester", record.testerJob, signal, gateTargetStateSha256),
  ]);
  const gateRejection = gateOutcomes.find((outcome) => outcome.status === "rejected");
  if (gateRejection) throw gateRejection.reason;
  const [reviewerResult = null, testerResult = null] = gateOutcomes.map((outcome) => outcome.value);
  // GATE_VERDICT: fail (or a gate that is not read-only or edited files) ends the pipeline. A
  // gate that could not deliver a verdict (rate limit, lost read lease, missing or misplaced
  // verdict line) leaves it awaiting_finalization so the gates can run again.
  const failedGates = [["reviewer", reviewerResult], ["tester", testerResult]].filter(([, gateResult]) => gateResult?.status === "failed");
  const terminalGate = failedGates.find(([, gateResult]) => PIPELINE_TERMINAL_GATE_ERROR_TYPES.has(gateResult.errorType));
  const [failedGateName = "", failedGateResult = null] = terminalGate || failedGates[0] || [];
  const failedGateLabel = failedGateName === "tester" ? "Tester" : "Reviewer";
  if (failedGateResult && !terminalGate) {
    return deferPipelineFinalization(record, {
      type: failedGateName,
      errorType: failedGateResult.errorType || `${failedGateName}_gate_failed`,
      error: `${failedGateLabel} gate did not deliver a verdict (${failedGateResult.errorType || "unknown"}).`,
      patch: { finalValidationResult, reviewerResult, testerResult },
    });
  }
  if (failedGateResult) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      testerResult,
      errors: (record.errors || []).concat({
        type: failedGateName,
        errorType: failedGateResult.errorType,
        error: `${failedGateLabel} gate failed.`,
      }),
    });
    return {
      ok: false,
      errorType: failedGateResult.errorType || `${failedGateName}_gate_failed`,
      error: `${failedGateLabel} gate failed.`,
      record,
    };
  }

  const sanitizedFinal = record.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(record.sanitizedWorkspace, "pipeline_after_all_waves")
    : null;
  if (sanitizedFinal && !sanitizedFinal.ok) {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      testerResult,
      sanitizedWorkspaceAttestation: {
        ...(record.sanitizedWorkspaceAttestation || {}),
        beforeFinalGates: sanitizedBeforeFinalGates,
        afterAllWaves: sanitizedFinal,
      },
      errors: (record.errors || []).concat({ type: "sanitized_workspace", errorType: sanitizedFinal.errorType, error: sanitizedFinal.error }),
    });
    return { ok: false, errorType: sanitizedFinal.errorType, error: "Sanitized workspace changed during final pipeline gates.", record };
  }

  if (!record.sanitizedWorkspace && !dryRun && finalValidationAfterState?.ok) {
    const beforeCleanupState = await captureIntegrationTargetState(record.cwd);
    // The gates' own test runs write ignored output; only tracked state must be unchanged.
    if (!beforeCleanupState.ok || trackedTargetStateSha256(beforeCleanupState) !== trackedTargetStateSha256(finalValidationAfterState)) {
      return deferPipelineFinalization(record, {
        type: "finalization",
        errorType: "pipeline_target_changed_before_cleanup",
        error: beforeCleanupState.ok
          ? "Pipeline target changed after final validation/gates and before source cleanup."
          : beforeCleanupState.error || "Could not capture the pipeline target state before source cleanup.",
        patch: { finalValidationResult, reviewerResult, testerResult },
      });
    }
  }

  const sanitizedWorkspaceAttestation = record.sanitizedWorkspace ? {
    ...(record.sanitizedWorkspaceAttestation || {}),
    beforeFinalGates: sanitizedBeforeFinalGates,
    afterAllWaves: sanitizedFinal,
  } : null;
  if (signal?.aborted) {
    // Losing the lease says nothing about the result; finalize again under a new one.
    return deferPipelineFinalization(record, {
      type: "finalization",
      errorType: abortSignalErrorType(signal, "read_lock_ownership_lost"),
      error: signal.reason?.message || "Pipeline finalization lost its repository consistency lease.",
      patch: { finalValidationResult, reviewerResult, testerResult },
    });
  }
  const sourceCleanupResults = await finalizePipelineSourceCleanup(record, {
    dryRun,
    authorizeCleanup: async (authorizationResults, authorizations) => {
      await updatePipelineRecord(record, {
        status: "cleanup_pending",
        finishedAt: "",
        finalValidationResult,
        reviewerResult,
        testerResult,
        sanitizedWorkspaceAttestation,
        sourceCleanupResults: authorizationResults,
        cleanupPending: authorizations.length > 0,
        cleanupState: authorizations.length > 0 ? "authorized" : "none",
        events: (record.events || []).concat({
          type: "finalization_gates_passed",
          at: new Date().toISOString(),
          cleanupPending: authorizations.length > 0,
        }, {
          type: "source_cleanup_authorized",
          at: new Date().toISOString(),
          targetStateSha256: finalValidationAfterState?.targetStateSha256 || "",
          trackedTargetStateSha256: trackedTargetStateSha256(finalValidationAfterState),
          worktrees: authorizations.map((authorization) => ({
            worktreePath: authorization.worktreePath,
            branch: authorization.branch,
            sourceBaseCommit: authorization.sourceBaseCommit,
            patchSha256: authorization.patchSha256,
            sourceStateSha256: authorization.sourceStateSha256,
          })),
        }),
      });
    },
  });
  const cleanupFailures = sourceCleanupResults.filter((result) => result.cleanup === "failed");
  const retainedSources = sourceCleanupResults.filter((result) => ["retained_for_review", "partial"].includes(result.cleanup));
  await updatePipelineRecord(record, {
    status: cleanupFailures.length ? "cleanup_failed" : "completed",
    finishedAt: cleanupFailures.length ? "" : (record.finishedAt || new Date().toISOString()),
    finalValidationResult,
    reviewerResult,
    testerResult,
    sanitizedWorkspaceAttestation,
    sourceCleanupResults,
    cleanupPending: cleanupFailures.length > 0,
    cleanupState: cleanupFailures.length
      ? "failed_retryable"
      : retainedSources.length
        ? "completed_with_retained_sources"
        : "completed",
    events: (record.events || []).concat(
      (record.events || []).some((event) => event.type === "finalization_completed") ? [] : [{
        type: "finalization_completed",
        at: new Date().toISOString(),
        cleanupPending: false,
      }],
      [{
        type: "source_cleanup_completed",
        at: new Date().toISOString(),
        retainedSources: retainedSources.length,
      }]
    ),
  });

  return cleanupFailures.length
    ? { ok: false, errorType: "pipeline_cleanup_failed", error: "One or more authorized source worktrees could not be removed safely.", record }
    : { ok: true, record };
}

function createPipelinePlan({
  name = "multi-agent-pipeline",
  cwd = "",
  jobs = [],
  requiresWorktrees = true,
  finalValidationCommand = "",
  reviewerJob = null,
  testerJob = null,
  policy = null,
  policyPath = "",
  policySha256 = "",
  policyTrustedForAuthority = false,
  sanitizedWorkspace = null,
  sanitizedPreflight = null,
}) {
  const policyAdjustedJobs = applyProjectPolicyToJobs(
    jobs.map((job) => sanitizedWorkspace ? { ...job, sanitizedWorkspace: job.sanitizedWorkspace || sanitizedWorkspace, subagentStrategy: job.subagentStrategy || "reject" } : job),
    policy,
    { allowOwnershipInference: policyTrustedForAuthority }
  );
  const effectiveRequiresWorktrees = Boolean(requiresWorktrees || policy?.requiresWorktrees);
  const explicitFinalValidationCommand = String(finalValidationCommand || "").trim();
  const effectiveFinalValidationCommand = explicitFinalValidationCommand || String(policy?.finalValidationCommand || "").trim();
  const effectiveFinalValidationSpec = explicitFinalValidationCommand ? null : policy?.finalValidationSpec || null;
  const effectiveFinalValidationSource = explicitFinalValidationCommand ? "caller" : policy?.finalValidationCommand ? "policy" : "none";
  for (const [gateName, gateJob] of [["reviewer", reviewerJob], ["tester", testerJob]]) {
    if (gateJob && !isManagedReadOnlyAgent(gateJob.agent)) {
      return {
        ok: false,
        errorType: "pipeline_gate_agent_not_read_only",
        error: `Pipeline ${gateName} gate requires a managed read-only agent; received "${gateJob.agent}".`,
        suggestedFix: "Use reviewer, tester, architect, planner, or orchestrator for read-only pipeline gates.",
      };
    }
  }
  if (policyAdjustedJobs.length < 2) {
    return {
      ok: false,
      errorType: "pipeline_too_small",
      error: "Pipelines are advanced-only and require at least two jobs or ownership zones. Use validate_delegation_plan and run_opencode_agent for a single bounded task.",
      suggestedFix: "For a small single write, use Level 2: validate_delegation_plan then run_opencode_agent with one explicit Scope Contract.",
      lockPlans: [],
      executionMode: "single",
    };
  }
  const { error, errorType, suggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [], executionMode } = validateDelegationPlanInputs(policyAdjustedJobs);
  if (error) {
    return {
      ok: false,
      errorType: errorType || "pipeline_plan_rejected",
      error,
      suggestedFix: suggestedFix || "Fix ownership zones, lock modes, lockedPaths, allowedEdits, or split shared files into a serial step.",
      lockPlans,
      conflictingPaths,
      serialOnlyMatches,
      executionMode,
    };
  }

  const writePlans = lockPlans.filter((plan) => plan.lockType === "write");
  if (sanitizedWorkspace && writePlans.length) {
    return {
      ok: false,
      errorType: "sanitized_workspace_write_forbidden",
      error: "Sanitized workspace pipelines are read-only. Writer output must use separate Git worktrees.",
      suggestedFix: "Remove write jobs or use a non-sanitized Git repository with isolated worktrees for output.",
      lockPlans,
      executionMode,
    };
  }
  if (effectiveRequiresWorktrees && writePlans.length && CONFIG.worktreeMode === "off") {
    return {
      ok: false,
      errorType: "worktree_required_for_pipeline",
      error: "Multi-agent write pipelines require CODEX_OPENCODE_WORKTREE_MODE=write or all so implementation happens in isolated worktrees.",
      suggestedFix: "Set CODEX_OPENCODE_WORKTREE_MODE=write and restart the MCP server, or create the pipeline with requiresWorktrees=false.",
      lockPlans,
      executionMode,
    };
  }

  if (writePlans.length && !effectiveFinalValidationCommand) {
    return {
      ok: false,
      errorType: "final_validation_required",
      error: "Write pipelines require finalValidationCommand so the combined result has a coordinator-level verification gate.",
      suggestedFix: "Pass a finalValidationCommand such as npm test, npm run typecheck, or a project-specific integration check.",
      lockPlans,
      executionMode,
    };
  }

  const integrationQueue = writePlans.map((plan) => ({
    agent: plan.agent,
    allowedEdits: plan.allowedEdits,
    lockedPaths: plan.lockedPaths,
    forbiddenEdits: plan.forbiddenEdits,
    sharedFiles: plan.sharedFiles,
    serialOnly: plan.serialOnly,
    validationCommand: plan.validationCommand || effectiveFinalValidationCommand,
    validationSpec: plan.validationCommand || effectiveFinalValidationSource !== "policy" ? null : effectiveFinalValidationSpec,
    validationSource: plan.validationCommand ? "job" : effectiveFinalValidationSource,
    status: "planned",
  }));

  const now = new Date().toISOString();
  return {
    ok: true,
    record: {
      pipelineId: makePipelineId(name),
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerGeneration: randomBytes(12).toString("hex"),
      ownerHeartbeatAt: now,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: 0,
      name,
      cwd: cwd || jobs[0]?.cwd || process.cwd(),
      status: "planned",
      createdAt: now,
      updatedAt: now,
      startedAt: "",
      finishedAt: "",
      strategy: "queue",
      requiresWorktrees: effectiveRequiresWorktrees,
      jobs: policyAdjustedJobs.map((job) => ({ ...job })),
      lockPlans,
      queueJobIds: [],
      expectedChildCount: 0,
      batchState: "unstarted",
      cleanupState: "none",
      queueMode: "sqlite",
      integrationQueue,
      finalValidationCommand: effectiveFinalValidationCommand,
      finalValidationSource: effectiveFinalValidationSource,
      finalValidationSpec: effectiveFinalValidationSpec,
      reviewerJob,
      testerJob,
      policy: policy ? {
        path: policyPath || ".mcp/agent-policy.json",
        sha256: policySha256,
        trustedForAuthority: Boolean(policyTrustedForAuthority),
        owners: policy.owners,
        sharedFiles: policy.sharedFiles,
        serialOnly: policy.serialOnly,
        forbiddenEdits: policy.forbiddenEdits,
      } : null,
      sanitizedWorkspace: sanitizedWorkspace ? sanitizePersistedValue(sanitizedWorkspace) : null,
      sanitizedWorkspaceAttestation: sanitizedWorkspace ? { creationPreflight: sanitizedPreflight } : null,
      events: [{
        type: "planned",
        at: now,
        executionMode,
        jobs: jobs.length,
        writeJobs: writePlans.length,
      }],
      errors: [],
    },
  };
}

function verifyParallelLockResults(jobResults) {
  const violations = [];
  const changedByFile = new Map();

  for (const jobResult of jobResults) {
    const { index, lockPlan, result } = jobResult;
    const label = `JOB ${index + 1} (${lockPlan.agent})`;
    const changedFiles = result?.changedFiles || [];

    if (result?.timedOut && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`Agent timeout: ${lockPlan.agent}`);
    } else if (result && result.exitCode !== 0 && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`${label} exited with ${result.exitCode}; do not accept this parallel result without recovery.`);
    }

    if (result?.openCodeFallbackDetected) {
      violations.push(`${label} triggered OpenCode native subagent fallback; do not accept this result because the requested role may not have executed.`);
    }

    if (result?.openCodeApiErrorDetected) {
      violations.push(`${label} returned an OpenCode API error event; do not accept this result without recovery.`);
    }

    if (lockPlan.lockType === "read" && changedFiles.length) {
      violations.push(`${label} was read-only but changed files: ${changedFiles.join(", ")}.`);
    }

    if (lockPlan.lockType === "write") {
      const outsideLock = unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd);
      if (outsideLock.length) {
        violations.push(`${label} changed files outside its allowed edit paths: ${outsideLock.join(", ")}.`);
      }
    }

    const forbiddenChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd));
    if (forbiddenChanged.length) {
      violations.push(`${label} changed forbidden files: ${forbiddenChanged.join(", ")}.`);
    }

    const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);
    if (scopeViolations.outsideWriteScope.length) {
      violations.push(`${label} changed files outside its Scope Contract write paths: ${scopeViolations.outsideWriteScope.join(", ")}.`);
    }
    if (scopeViolations.forbiddenFiles.length) {
      violations.push(`${label} changed Scope Contract forbidden files: ${scopeViolations.forbiddenFiles.join(", ")}.`);
    }
    if (scopeViolations.readOnlyChangedFiles.length) {
      violations.push(`${label} violated a read-only Scope Contract by changing files: ${scopeViolations.readOnlyChangedFiles.join(", ")}.`);
    }

    const sharedChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd));
    if (sharedChanged.length) {
      violations.push(`${label} changed shared/frozen files: ${sharedChanged.join(", ")}.`);
    }

    const restrictedChanged = findSerialOnlyMatches(changedFiles);
    if (restrictedChanged.length) {
      violations.push(`${label} changed serial-only paths: ${restrictedChanged.join(", ")}.`);
    }

    for (const file of changedFiles) {
      const normalized = normalizePathForCompare(file);
      const existing = changedByFile.get(normalized) || [];
      existing.push(label);
      changedByFile.set(normalized, existing);
    }
  }

  for (const [file, labels] of changedByFile.entries()) {
    if (labels.length > 1) {
      violations.push(`Multiple parallel jobs changed the same file "${file}": ${labels.join(", ")}.`);
    }
  }

  return violations;
}

function settleIndependentParallelJobs(executionPromises) {
  return Promise.allSettled(executionPromises);
}

// Every job runs its agent, its read-only retries and its validation command under the one
// group signal, so the deadline covers the longest of those sums; the agent timeout alone
// aborted a validation that started late in a long builder run.
const PARALLEL_GROUP_DEADLINE_MARGIN_MS = 1000 * 60;

function parallelGroupDeadlineMs(lockPlans = []) {
  const budgets = lockPlans.map((plan) => {
    const agentTimeoutMs = timeoutForAgent(plan.agent, plan, plan.timeoutMs);
    // runOpenCodeWithPolicy bounds a reader's attempts by max(retry budget, timeout).
    const agentBudgetMs = plan.lockType === "read"
      ? Math.max(CONFIG.readOnlyRetryMaxElapsedMs, agentTimeoutMs)
      : agentTimeoutMs;
    const validationBudgetMs = String(plan.validationCommand || "").trim() ? CONFIG.validationCommandTimeoutMs : 0;
    return agentBudgetMs + validationBudgetMs;
  });
  return Math.max(0, ...budgets) + PARALLEL_GROUP_DEADLINE_MARGIN_MS;
}

// Group-scope check of one execution workspace after every job of a parallel batch settled.
async function parallelGroupScopeReport({ cwdKey, lockPlans, indexesForCwd, results, before, expectedHead, driftTolerated = false }) {
  const after = await gitChangedFileSnapshot(cwdKey, driftTolerated ? { includeIgnored: false } : {});
  const afterHead = await captureGitHead(cwdKey);
  const headChanged = afterHead !== expectedHead;
  let changedFiles = changedFilesBetween(before, after);
  let externalDriftFiles = [];
  if (driftTolerated && changedFiles.length) {
    // Only edit-denied readers ran here: the change is another client's, reported not rejected.
    const drift = readOnlyWorkspaceDrift(changedFiles, after, headChanged);
    externalDriftFiles = drift.files;
    changedFiles = [];
  }
  const plansForCwd = indexesForCwd.map((index) => lockPlans[index]);
  if (headChanged) {
    const readOnlyCwd = !changedFiles.length && plansForCwd.every((plan) => plan.lockType === "read");
    for (const index of indexesForCwd) {
      const jobResult = results[index];
      if (!jobResult?.result) continue;
      const move = readOnlyCwd && !jobResult.result.errorType
        ? await readOnlyHeadMove(lockPlans[index], cwdKey, expectedHead, afterHead)
        : null;
      if (move) jobResult.result.readOnlyHeadMove = move;
      else jobResult.result.errorType ||= "repository_head_changed_during_execution";
      jobResult.result.executionHeadBefore = expectedHead;
      jobResult.result.executionHeadAfter = afterHead;
    }
  }
  const writePlansForCwd = plansForCwd.filter((plan) => plan.lockType === "write");
  const allowedEditsForCwd = writePlansForCwd.flatMap((plan) => plan.allowedEdits);
  const forbiddenForCwd = plansForCwd.flatMap((plan) => plan.forbiddenEdits.concat(plan.sharedFiles));
  const serialOnlyMatches = findSerialOnlyMatches(changedFiles);
  const disallowedFiles = normalizeLockPathList([
    ...(writePlansForCwd.length ? unsafeChangedFiles(changedFiles, allowedEditsForCwd, cwdKey) : changedFiles),
    ...changedFiles.filter((file) => isWithinAnyPath(file, forbiddenForCwd, cwdKey)),
    ...changedFiles.filter((file) => findSerialOnlyMatches([file]).length),
  ]);
  const rollbackResult = disallowedFiles.length
    ? {
        rollback: "not_attempted_unattributed_changes",
        rollbackFiles: [],
        unresolvedFiles: disallowedFiles,
        reason: "Parallel path-only evidence cannot safely distinguish OpenCode output from concurrent external edits; affected worktrees/output are retained for inspection.",
      }
    : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };
  return {
    cwd: cwdKey,
    headChanged,
    expectedHead,
    actualHead: afterHead,
    changedFiles,
    disallowedFiles,
    serialOnlyMatches,
    externalDriftFiles,
    ...rollbackResult,
  };
}

function parallelExecutionOverlapEvidence(results) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    const leftIntervals = results[leftIndex]?.result?.childExecutionIntervals || [];
    for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
      const rightIntervals = results[rightIndex]?.result?.childExecutionIntervals || [];
      const overlap = leftIntervals.some((left) => rightIntervals.some((right) =>
        left?.startedAtMs && left?.finishedAtMs && right?.startedAtMs && right?.finishedAtMs
        && Math.max(left.startedAtMs, right.startedAtMs) < Math.min(left.finishedAtMs, right.finishedAtMs)
      ));
      if (overlap) pairs.push([leftIndex, rightIndex]);
    }
  }
  return { ranConcurrently: pairs.length > 0, pairs };
}

function labelParallelRunId(text, runId) {
  return String(text || "").replace(/^JOB (\d+)/, (label) => `${label}\nRun id: ${runId} (get_opencode_job finds it; not cancellable like a queue job)`);
}

server.tool(
  "run_opencode_parallel",
  "Run multiple OpenCode agents in parallel. Use only for safe independent tasks. Each job's block is compact (Run id, outcome, timing, token usage, changed files, worktree, warnings, then the agent's report) and its result text is stored under the Run id: get_opencode_job returns it again if this response is lost.",
  {
    jobs: z.array(z.object(jobInputShape)).min(1),
    detail: z.boolean().optional().describe("Append each job's bridge detail (lock and scope echo, model evidence, phase timing split, tool outcomes) to its block. Default: compact blocks; get_opencode_job with detail: true returns the same detail later."),
  },
  async ({ jobs, detail = false }) => {
    jobs = await Promise.all(jobs.map((job) => normalizeJobCwd(job)));
    const toolStarted = nowMs();
    // Provider capacity is checked per provider key once every route is attested (below),
    // before any lock, worktree or agent; each key's leases are limited separately.
    const { error: writePlanError, errorType: writePlanErrorType, suggestedFix: writePlanSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
    if (writePlanError) {
      const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "multiple";
      const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: writePlanErrorType || "parallel_plan_rejected",
                reason: writePlanError,
                requestedAgent: requestedAgents,
                actualAgent: "none",
                lockMode,
                durationMs: nowMs() - toolStarted,
                conflictingPaths,
                serialOnlyMatches,
                suggestedFix: writePlanSuggestedFix || "Read-only jobs use lockMode off. Write jobs need non-overlapping lockedPaths and explicit allowedEdits.",
              }),
          },
        ],
      };
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const validationPreflight = await validationCommandPreflightError(lockPlans[index].validationCommand, {
        dryRun: Boolean(jobs[index].dryRun),
        sanitized: Boolean(jobs[index].sanitizedWorkspace),
      });
      if (validationPreflight) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel OpenCode execution rejected before any agent started.",
          errorType: validationPreflight.errorType,
          reason: `JOB ${index + 1} validation command cannot run: ${validationPreflight.error}`,
          requestedAgent: lockPlans[index].agent,
          actualAgent: "none",
          lockMode: lockPlans[index].lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: VALIDATION_PREFLIGHT_FIX,
        }) }] };
      }
    }

    for (let index = 0; index < jobs.length; index += 1) {
      const gitState = await verifyJobWorkspaceReadiness(jobs[index], lockPlans[index]);
      if (!gitState.ok) {
        return {
          content: [{
            type: "text",
            text: formatRejectedExecution({
              headline: "Parallel protected execution rejected.",
              errorType: gitState.errorType,
              reason: gitState.error,
              requestedAgent: lockPlans[index].agent,
              actualAgent: "none",
              lockMode: lockPlans[index].lockMode,
              durationMs: nowMs() - toolStarted,
              ...dirtyCheckpointDetails(gitState),
              suggestedFix: gitState.suggestedFix,
            }),
          }],
        };
      }
    }

    const writeWithoutIsolation = jobs.find((job, index) => !job.dryRun && lockPlans[index].lockType === "write" && !shouldUseWorktree(job, lockPlans[index]));
    if (writeWithoutIsolation) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Parallel OpenCode execution rejected.",
        errorType: "parallel_write_requires_worktrees",
        reason: "Direct parallel writers require isolated worktrees so changes can be attributed, retained, reviewed, and integrated serially.",
        requestedAgent: writeWithoutIsolation.agent,
        actualAgent: "none",
        suggestedFix: "Enable CODEX_OPENCODE_WORKTREE_MODE=write or all, then retry. Queue/pipeline execution remains available for cancellation and durable status.",
      }) }] };
    }

    const parallelResolutions = [];
    const parallelAgentMetadata = [];
    const parallelSanitizedPreflight = [];
    const parallelSanitizedBefore = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const discoveryContext = sanitizedDiscoveryContext({ ...job, cwd: job.cwd || process.cwd() });
      const { forcePure, discoveryCwd } = discoveryContext;
      if (forcePure && !job.dryRun) {
        const verification = await verifySanitizedWorkspace(job.sanitizedWorkspace, "preflight_before_discovery");
        if (!verification.ok) {
          return { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Parallel sanitized-workspace preflight rejected before OpenCode discovery.",
            errorType: verification.errorType,
            reason: verification.error,
            requestedAgent: job.agent,
            actualAgent: "none",
            conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Rebuild the exact sanitized workspace from its trusted manifest before retrying the wave.",
          }) }] };
        }
        parallelSanitizedPreflight[index] = verification;
      }
      const resolution = await jobAgentRuntime().resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "reject",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT,
        lockPlan.orchestratorMode,
        discoveryContext
      );
      const routingError = resolution.error ? { errorType: "agent_routing_error", error: resolution.error } : readOnlyRoutingPolicyError(resolution, lockPlan);
      const metadata = resolution.error ? null : await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, discoveryCwd, { forcePure });
      const metadataError = resolution.error ? null : effectiveReadOnlyMetadataError(metadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
      const sanitizedMetadataError = resolution.error || !job.sanitizedWorkspace ? null : sanitizedAgentMetadataError(metadata, job.sanitizedWorkspace.root);
      const sanitizedError = sanitizedRoutingPolicyError(job, resolution, discoveryCwd);
      const preflightError = routingError || metadataError || sanitizedMetadataError || sanitizedError;
      if (preflightError) {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel route preflight rejected before locks or filesystem side effects.",
          errorType: preflightError.errorType,
          reason: preflightError.error,
          requestedAgent: resolution.requestedAgent || job.agent,
          actualAgent: resolution.actualAgent || "none",
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: "Choose an installed primary/all role with an effective policy matching the requested read/write contract.",
        }) }] };
      }
      resolution.agentMetadata = metadata?.metadata || null;
      parallelResolutions[index] = resolution;
      parallelAgentMetadata[index] = metadata;
    }

    await refreshRuntimeConcurrency();
    const capacityError = parallelBatchCapacityError(jobs, parallelProviderKeys(parallelResolutions, parallelAgentMetadata, lockPlans));
    if (capacityError) {
      return { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Parallel OpenCode execution rejected.",
        errorType: capacityError.errorType,
        reason: capacityError.error,
        requestedAgent: lockPlans.map((plan) => plan.agent).filter(Boolean).join(", ") || "multiple",
        actualAgent: "none",
        lockMode: lockPlans.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown",
        durationMs: nowMs() - toolStarted,
        suggestedFix: capacityError.suggestedFix,
      }) }] };
    }

    const acquiredLocks = [];
    const acquiredLockHeartbeats = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const shouldAcquireLock = !job.dryRun;

      if (!shouldAcquireLock) {
        acquiredLocks[index] = null;
        continue;
      }

      const requestedLockPaths = hardLockPathsForPlan(lockPlan);
      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: lockPlan.agent,
        task: lockPlan.task,
        cwd: job.cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: requestedLockPaths,
        repositoryScope: requestedLockPaths.length === 1 && requestedLockPaths[0] === REPOSITORY_SCOPE_LOCK_PATH,
        ttlMs: hardLockTtlForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        return {
          content: [
            {
              type: "text",
              text: [
                formatRejectedExecution({
                  headline: "Parallel OpenCode execution rejected.",
                  errorType: lockPlan.lockType === "read" ? "read_lock_conflict" : "write_lock_conflict",
                  reason: lockResult.error,
                  requestedAgent: lockPlan.agent,
                  actualAgent: "none",
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: "Release the existing lock or wait for it to expire, then retry with non-overlapping lockedPaths.",
                }),
                "",
                "No OpenCode jobs were started after this write-lock rejection.",
              ].join("\n"),
            },
          ],
        };
      }

      acquiredLocks[index] = lockResult.lock;
      acquiredLockHeartbeats[index] = startHardLockHeartbeat(lockResult.lock, hardLockTtlForPlan(lockPlan));
    }

    for (let index = 0; index < jobs.length; index += 1) {
      if (!shouldUseWorktree(jobs[index], lockPlans[index])) continue;
      const checkpoint = await inspectSourceCheckpointState(jobs[index].cwd || process.cwd(), {
        lockedPaths: lockPlans[index].lockedPaths,
        allowedEdits: lockPlans[index].allowedEdits,
        scopeContract: lockPlans[index].scopeContract,
      });
      if (!checkpoint.ok) {
        const dirtyDetails = dirtyCheckpointDetails(checkpoint);
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Parallel writer checkpoint preflight rejected before any worktree was created.",
          errorType: checkpoint.errorType,
          reason: checkpoint.error,
          requestedAgent: lockPlans[index].agent,
          actualAgent: parallelResolutions[index]?.actualAgent || "none",
          lockMode: lockPlans[index].lockMode,
          conflictingPaths: dirtyDetails.conflictingPaths,
          dirtyFiles: dirtyDetails.dirtyFiles,
          overlappingFiles: dirtyDetails.overlappingFiles,
          disjointFiles: dirtyDetails.disjointFiles,
          suggestedFix: "Create or select an external checkpoint for the complete source checkout; the bridge will not stash, reset, or commit it.",
        }) }] };
      }
    }

    const parallelWorktrees = [];
    // Each job gets a run id up front (writers already used one for their worktree name), so the
    // coordinator's ledger can name reviewer runs too. It is not a queue id: get_opencode_job finds
    // it in the direct-run audit (kind "parallel"); the queue still owns durable cancellation.
    const parallelRunIds = lockPlans.map((plan) => makeQueueJobId(plan.agent));
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      if (!shouldUseWorktree(job, lockPlan)) {
        parallelWorktrees[index] = null;
        continue;
      }

      const worktreeResult = await createWorktreeForJob({
        cwd: job.cwd || process.cwd(),
        agent: lockPlan.agent,
        jobId: parallelRunIds[index],
        lockedPaths: lockPlan.lockedPaths,
        allowedEdits: lockPlan.allowedEdits,
        scopeContract: lockPlan.scopeContract,
      });

      if (!worktreeResult.ok) {
        const dirtyDetails = dirtyCheckpointDetails(worktreeResult);
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        await Promise.all(parallelWorktrees.filter(Boolean).map((worktree) => cleanupWorktree(worktree, "always", true)));
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: worktreeResult.errorType || "worktree_create_failed",
                reason: worktreeResult.error || "Could not create a Git worktree for this parallel job.",
                requestedAgent: lockPlan.agent,
                actualAgent: "none",
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                lockedPaths: lockPlan.lockedPaths,
                allowedEdits: lockPlan.allowedEdits,
                conflictingPaths: worktreeResult.conflictingPaths || dirtyDetails.conflictingPaths,
                dirtyFiles: dirtyDetails.dirtyFiles,
                overlappingFiles: dirtyDetails.overlappingFiles,
                disjointFiles: dirtyDetails.disjointFiles,
                suggestedFix: worktreeResult.suggestedFix || "Create/select a clean reproducible checkpoint, choose a safe worktree root, and ensure this cwd is a Git repository with git available.",
              }),
            },
          ],
        };
      }

      parallelWorktrees[index] = worktreeResult;
    }

    const executionCwdForIndex = (index) => parallelWorktrees[index]?.path || jobs[index].cwd || process.cwd();
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const resolution = parallelResolutions[index];
      const executionCwd = executionCwdForIndex(index);
      const { forcePure } = sanitizedDiscoveryContext({ ...job, cwd: job.cwd || process.cwd() });
      const finalMetadata = await jobAgentRuntime().readAgentDebugMetadata(resolution.actualAgent, executionCwd, { forcePure });
      const metadataError = effectiveReadOnlyMetadataError(
        finalMetadata,
        lockPlan,
        agentMetadataPolicyOptions(resolution, lockPlan, parallelAgentMetadata[index]?.metadata || null)
      );
      const sanitizedMetadataError = job.sanitizedWorkspace ? sanitizedAgentMetadataError(finalMetadata, job.sanitizedWorkspace.root) : null;
      const sanitizedRoutingError = sanitizedRoutingPolicyError(job, resolution, executionCwd);
      if (metadataError || sanitizedMetadataError || sanitizedRoutingError) {
        const policyError = metadataError || sanitizedMetadataError || sanitizedRoutingError;
        acquiredLockHeartbeats.forEach((stop) => stop?.());
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        return { content: [{ type: "text", text: [
          formatRejectedExecution({
            headline: "Parallel final pre-spawn agent policy rejected.",
            errorType: policyError.errorType,
            reason: policyError.error,
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            suggestedFix: "Inspect any retained worktree and restore the exact bridge-managed effective agent definition before retrying.",
          }),
          ...parallelWorktrees.filter(Boolean).map((item) => `Retained worktree: ${item.path} (base ${item.baseCommit})`),
        ].join("\n") }] };
      }
      parallelAgentMetadata[index] = finalMetadata;
      resolution.agentMetadata = finalMetadata.metadata;
    }
    const cwdKeys = [...new Set(jobs.map((_, index) => path.resolve(executionCwdForIndex(index))))];
    const parallelSnapshottedCwds = new Set();
    const parallelBefore = new Map();
    const parallelHeadBefore = new Map();
    // A checkout used only by readers whose attested policy denies edits changes only through
    // another client, so its group check reports that drift instead of rejecting the batch.
    const parallelDriftToleratedCwds = new Set(cwdKeys.filter((cwdKey) => {
      const indexes = jobs.map((_, index) => index).filter((index) => path.resolve(executionCwdForIndex(index)) === cwdKey && !jobs[index].dryRun);
      return indexes.length > 0 && indexes.every((index) => !jobs[index].sanitizedWorkspace && readOnlyEditsDeniedByAttestation(lockPlans[index], parallelAgentMetadata[index]));
    }));
    const parallelRemovedWorktrees = new Set();
    try {
      for (const cwdKey of cwdKeys) {
        const needsGitSnapshot = jobs.some((job, index) => path.resolve(executionCwdForIndex(index)) === cwdKey && !job.dryRun && !job.sanitizedWorkspace);
        if (needsGitSnapshot) parallelSnapshottedCwds.add(cwdKey);
        parallelBefore.set(cwdKey, needsGitSnapshot ? await gitChangedFileSnapshot(cwdKey, parallelDriftToleratedCwds.has(cwdKey) ? { includeIgnored: false } : {}) : new Map());
        parallelHeadBefore.set(cwdKey, needsGitSnapshot ? await captureGitHead(cwdKey) : "");
      }
    } catch (error) {
      acquiredLockHeartbeats.forEach((stop) => stop?.());
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
      return { content: [{ type: "text", text: [
        formatRejectedExecution({
          headline: "Parallel snapshot preflight failed closed.",
          errorType: error?.errorType || "snapshot_safety_limit_exceeded",
          reason: redactSensitiveText(error?.message || String(error)),
          requestedAgent: jobs.map((job) => job.agent).join(", "),
          actualAgent: parallelResolutions.map((item) => item.actualAgent).join(", "),
          suggestedFix: "Reduce the workspace/snapshot scope or raise reviewed bounded limits; all created writer worktrees were retained.",
        }),
        ...parallelWorktrees.filter(Boolean).map((worktree) => `Retained worktree: ${worktree.path} (base ${worktree.baseCommit})`),
      ].join("\n") }] };
    }

    let results;
    const parallelRollbackReports = [];
    const groupController = new AbortController();
    for (const heartbeat of acquiredLockHeartbeats.filter(Boolean)) {
      const abortGroupForLostLock = () => {
        if (!groupController.signal.aborted) groupController.abort(heartbeat.signal.reason);
      };
      if (heartbeat.signal?.aborted) abortGroupForLostLock();
      else heartbeat.signal?.addEventListener("abort", abortGroupForLostLock, { once: true });
    }
    // Locks, worktrees and discovery attestation for all jobs happened before this point. The audit
    // start records are written before the group deadline is armed (they fail open, never throw).
    const parallelSharedSetupMs = Math.round(nowMs() - toolStarted);
    const parallelAudit = directRunAuditStore();
    const parallelAuditHandles = await Promise.all(jobs.map((job, index) => parallelAudit.start(
      { agent: lockPlans[index].agent, cwd: job.cwd || process.cwd(), dryRun: Boolean(job.dryRun) },
      { runId: parallelRunIds[index], kind: "parallel", jobId: parallelRunIds[index] }
    )));
    const parallelChildSpawned = jobs.map(() => false);
    const groupDeadlineMs = parallelGroupDeadlineMs(lockPlans);
    let groupDeadlineExpired = false;
    const groupDeadlineTimer = setTimeout(() => {
      groupDeadlineExpired = true;
      groupController.abort("parallel_group_deadline");
    }, groupDeadlineMs);
    try {
      const executionPromises = jobs.map(async (job, index) => {
        const lockPlan = lockPlans[index];
        const jobStartedAtMs = nowMs();
        const phaseClock = createPhaseClock();
        const resolution = parallelResolutions[index];
        if (resolution.error) {
          return {
            index,
            lockPlan,
            result: { changedFiles: [], exitCode: "not run", errorType: "agent_routing_error", openCodeFallbackDetected: false },
            text: [
            `JOB ${index + 1}`,
            formatRejectedExecution({
              headline: "OpenCode agent routing failed.",
              errorType: "agent_routing_error",
              reason: resolution.error,
              requestedAgent: resolution.requestedAgent,
              actualAgent: "none",
              fallback: resolution.fallbackUsed,
              fallbackReason: resolution.fallbackReason,
              lockMode: lockPlan.lockMode,
              durationMs: nowMs() - toolStarted,
              suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
            }),
            `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
            `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
            `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
            `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
            resolution.error,
            ].join("\n"),
          };
        }

        const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
        if (routingPolicyError) {
          return {
            index,
            lockPlan,
            result: {
              changedFiles: [],
              exitCode: "not run",
              errorType: routingPolicyError.errorType,
              openCodeFallbackDetected: false,
            },
            text: [
              `JOB ${index + 1}`,
              formatRejectedExecution({
                headline: "OpenCode agent routing rejected.",
                errorType: routingPolicyError.errorType,
                reason: routingPolicyError.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: routingPolicyError.suggestedFix,
              }),
            ].join("\n"),
          };
        }

        const executionCwd = executionCwdForIndex(index);
        const manifestProtected = Boolean(job.sanitizedWorkspace);
        if (manifestProtected && !job.dryRun) {
          const verification = await verifySanitizedWorkspace(job.sanitizedWorkspace, "before_wave");
          parallelSanitizedBefore[index] = verification;
          if (!verification.ok) {
            return {
              index,
              lockPlan,
              result: {
                changedFiles: normalizeLockPathList((verification.discrepancies || []).map((item) => item.path)),
                exitCode: "not_run",
                errorType: verification.errorType,
                sanitizedWorkspaceVerification: {
                  preflight: parallelSanitizedPreflight[index] || null,
                  before: verification,
                  after: null,
                },
              },
              startedAtMs: jobStartedAtMs,
              finishedAtMs: nowMs(),
              // The JOB label is what the report keys the Run id on.
              text: [
                `JOB ${index + 1}`,
                formatRejectedExecution({
                  headline: "Sanitized workspace changed between preflight and the parallel wave.",
                  errorType: verification.errorType,
                  reason: verification.error,
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
                  suggestedFix: "Retain the workspace for investigation and rebuild it from the trusted manifest.",
                }),
              ].join("\n"),
            };
          }
        }
        const readerEditsDenied = !job.dryRun && !manifestProtected && readOnlyEditsDeniedByAttestation(lockPlan, parallelAgentMetadata[index]);
        const readerSnapshotOptions = readerEditsDenied ? { includeIgnored: false } : {};
        const beforeFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
        const gitControlBefore = job.dryRun || manifestProtected || lockPlan.lockType === "read" ? null : await gitControlSurfaceFingerprint(executionCwd);
        const scopeFilesystemBefore = job.dryRun || manifestProtected || lockPlan.lockType !== "write"
          ? null
          : await captureWritableScopeFilesystemState(executionCwd, lockPlan);
        if (scopeFilesystemBefore && !scopeFilesystemBefore.ok) {
          // No agent ran, so the worktree is empty: keeping it only filled the retained-worktree cap.
          if (parallelWorktrees[index]) {
            await cleanupWorktree(parallelWorktrees[index], "always", true).catch(() => null);
            parallelWorktrees[index] = null;
          }
          return {
            index,
            lockPlan,
            result: { changedFiles: [], exitCode: "not_run", errorType: scopeFilesystemBefore.errorType },
            startedAtMs: jobStartedAtMs,
            finishedAtMs: nowMs(),
            text: [
              `JOB ${index + 1}`,
              formatRejectedExecution({
                headline: "The writable scope could not be recorded before execution.",
                errorType: scopeFilesystemBefore.errorType,
                reason: scopeFilesystemBefore.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Narrow allowedEdits to the files the job needs, or fix the permissions of the scope, and retry. No agent was started.",
              }),
            ].join("\n"),
          };
        }
        const delegation = {
          scope: job.delegation?.scope,
          lockMode: lockPlan.lockMode,
          lockType: lockPlan.lockType,
          orchestratorMode: lockPlan.orchestratorMode,
          userAuthorizedOrchestrator: lockPlan.userAuthorizedOrchestrator,
          lockedPaths: lockPlan.lockedPaths,
          allowedEdits: lockPlan.allowedEdits,
          forbiddenEdits: lockPlan.forbiddenEdits,
          sharedFiles: lockPlan.sharedFiles,
          scopeContract: lockPlan.scopeContract,
          permissions: job.delegation?.permissions || (lockPlan.lockType === "write" ? "write allowed only inside Lock granted; bash ask" : "read-only; no edits; bash ask"),
          validationCommand: lockPlan.validationCommand,
          returnFormat: job.delegation?.returnFormat,
          pathSpellings: callerPathSpellings(job),
        };

        let prompt = buildCompactPrompt(resolution.requestedAgent, job.task, delegation);
        if (resolution.proxyUsed) {
          prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
        }
        phaseClock.mark("preAgentSnapshot");
        const result = await jobAgentRuntime().runOpenCodeWithPolicy(
          resolution.actualAgent,
          prompt,
          executionCwd,
          job.dryRun || false,
          lockPlan,
          lockPlan.timeoutMs,
          {
            signal: groupController.signal,
            agentMetadata: parallelAgentMetadata[index],
            onSpawn: () => {
              parallelChildSpawned[index] = true;
              return { ok: true };
            },
          }
        );
        phaseClock.mark("openCodeRun");
        const afterFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd, readerSnapshotOptions);
        const afterFilesForValidation = job.dryRun || manifestProtected || readerEditsDenied
          ? afterFiles
          : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
        const executionHeadAfterAgent = job.dryRun || manifestProtected ? "" : await captureGitHead(executionCwd);
        const sanitizedAfter = manifestProtected && !job.dryRun
          ? await verifySanitizedWorkspace(job.sanitizedWorkspace, "after_wave")
          : null;
        result.changedFiles = sanitizedAfter && !sanitizedAfter.ok
          ? normalizeLockPathList((sanitizedAfter.discrepancies || []).map((item) => item.path))
          : changedFilesBetween(beforeFiles, afterFiles);
        const expectedExecutionHead = parallelHeadBefore.get(path.resolve(executionCwd)) || "";
        if (readerEditsDenied && result.changedFiles.length) {
          result.readOnlyWorkspaceDrift = readOnlyWorkspaceDrift(result.changedFiles, afterFiles, Boolean(executionHeadAfterAgent && executionHeadAfterAgent !== expectedExecutionHead));
          result.changedFiles = [];
        }
        if (gitControlBefore) applyGitControlSurfaceCheck(result, gitControlBefore, await gitControlSurfaceFingerprint(executionCwd));
        if (executionHeadAfterAgent && executionHeadAfterAgent !== expectedExecutionHead) {
          const move = result.changedFiles.length || result.errorType ? null : await readOnlyHeadMove(lockPlan, executionCwd, expectedExecutionHead, executionHeadAfterAgent);
          if (move) {
            result.readOnlyHeadMove = move;
          } else {
            result.errorType ||= "repository_head_changed_during_execution";
            result.stderr = [result.stderr, "Repository HEAD changed during parallel execution. The change is unattributed and the worktree/output was retained."].filter(Boolean).join("\n");
          }
        }
        result.executionHeadBefore = expectedExecutionHead;
        result.executionHeadAfter = executionHeadAfterAgent;
        if (sanitizedAfter && !sanitizedAfter.ok && !result.errorType) result.errorType = sanitizedAfter.errorType;
        result.sanitizedWorkspaceVerification = manifestProtected
          ? { preflight: parallelSanitizedPreflight[index] || null, before: parallelSanitizedBefore[index] || null, after: sanitizedAfter }
          : null;
        let unsafeFiles = lockPlan.lockType === "write" ? unsafeChangedFiles(result.changedFiles, lockPlan.allowedEdits, executionCwd) : result.changedFiles;
        const postExecutionPathError = job.dryRun ? "" : unsafePathReason(
          lockPlan.lockedPaths.concat(
            lockPlan.allowedEdits,
            lockPlan.forbiddenEdits,
            lockPlan.sharedFiles,
            scopeContractPathInputs(lockPlan.scopeContract),
            result.changedFiles
          ),
          executionCwd
        );
        if (postExecutionPathError) {
          unsafeFiles = normalizeLockPathList(unsafeFiles.concat(result.changedFiles));
          result.errorType ||= "unsafe_path_after_execution";
          result.stderr = [result.stderr, postExecutionPathError].filter(Boolean).join("\n");
        }
        const scopeFilesystemViolation = scopeFilesystemBefore
          ? writableScopeFilesystemViolation(scopeFilesystemBefore, await captureWritableScopeFilesystemState(executionCwd, lockPlan))
          : null;
        if (scopeFilesystemViolation) {
          unsafeFiles = normalizeLockPathList(unsafeFiles.concat(scopeFilesystemViolation.paths));
          result.unsafeFilesystemPaths = scopeFilesystemViolation.paths;
          result.errorType ||= scopeFilesystemViolation.errorType;
          result.stderr = [result.stderr, scopeFilesystemViolation.error].filter(Boolean).join("\n");
        }
        const validationGate = !unsafeFiles.length && !result.errorType
          ? await runValidationGate({ command: lockPlan.validationCommand, cwd: executionCwd, dryRun: job.dryRun || false, timeoutMs: CONFIG.validationCommandTimeoutMs, signal: groupController.signal })
          : {
              status: lockPlan.validationCommand ? "skipped_due_to_prior_failure" : "skipped",
              command: lockPlan.validationCommand || "",
              exitCode: "not_run",
              durationMs: 0,
              stdout: "",
              stderr: "",
              errorType: null,
            };
        if (validationGate.errorType && !result.errorType) {
          result.errorType = validationGate.errorType;
        }
        const afterValidationFiles = job.dryRun || manifestProtected ? afterFiles : await gitChangedFileSnapshot(executionCwd, { includeIgnored: false });
        const executionHeadAfterValidation = job.dryRun || manifestProtected ? executionHeadAfterAgent : await captureGitHead(executionCwd);
        const validationMutationFiles = job.dryRun || manifestProtected ? [] : changedFilesBetween(afterFilesForValidation, afterValidationFiles);
        if (executionHeadAfterValidation && executionHeadAfterValidation !== expectedExecutionHead) {
          const move = result.errorType || validationMutationFiles.length || result.changedFiles.length
            ? null
            : await readOnlyHeadMove(lockPlan, executionCwd, expectedExecutionHead, executionHeadAfterValidation);
          if (move) result.readOnlyHeadMove = move;
          else result.errorType ||= "repository_head_changed_during_execution";
          result.executionHeadAfter = executionHeadAfterValidation;
        }
        if (validationMutationFiles.length) {
          result.changedFiles = normalizeLockPathList(result.changedFiles.concat(validationMutationFiles));
          const postValidation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: true });
          unsafeFiles = normalizeLockPathList(postValidation.disallowedFiles.concat(validationMutationFiles, result.unsafeFilesystemPaths || []));
          result.validationMutationFiles = validationMutationFiles;
          result.errorType ||= "validation_mutated_workspace";
          result.stderr = [result.stderr, `Validation changed workspace paths after agent execution: ${validationMutationFiles.join(", ")}. The changes were retained as unattributed external state.`].filter(Boolean).join("\n");
        }
        const worktree = parallelWorktrees[index];
        const worktreeDiff = worktree ? await collectWorktreeDiff(worktree) : null;
        if (worktreeDiff?.errorType && !result.errorType) {
          result.errorType = worktreeDiff.errorType;
          result.stderr = [result.stderr, worktreeDiff.error].filter(Boolean).join("\n");
        }
        if (worktree && !worktreeDiff?.errorType) {
          const representablePaths = changedPathSetEvidence(result.changedFiles, worktreeDiff?.changedFiles || []);
          const unrepresentableFiles = normalizeLockPathList(representablePaths.missingFiles.concat(representablePaths.unexpectedFiles));
          if (unrepresentableFiles.length) {
            result.changedFiles = normalizeLockPathList(result.changedFiles.concat(worktreeDiff?.changedFiles || []));
            const representableValidation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: true });
            unsafeFiles = normalizeLockPathList(unsafeFiles.concat(representableValidation.disallowedFiles, unrepresentableFiles));
            result.errorType ||= "worktree_output_unrepresentable";
            result.unrepresentableFiles = unrepresentableFiles;
            result.stderr = [result.stderr, `Execution output and the integratable Git patch differ at: ${unrepresentableFiles.join(", ")}. The worktree was retained and cannot be reported as successful.`].filter(Boolean).join("\n");
          }
        }
        // Same rule as a single job: a writer whose verified diff is empty has nothing to
        // review, so its worktree is removed instead of filling the retained-worktree cap.
        const producedNothing = Boolean(worktree && worktreeDiff)
          && !worktreeDiff.errorType
          && !(worktreeDiff.changedFiles || []).length
          && !(result.changedFiles || []).length
          && !(result.unrepresentableFiles || []).length
          && !unsafeFiles.length;
        const worktreeCleanup = producedNothing
          ? { ...(await cleanupWorktree(worktree, "always", true)), errorType: undefined, reason: "the job changed no files, so there was nothing to retain" }
          : null;
        const worktreeRemoved = producedNothing && ["success", "partial"].includes(worktreeCleanup.cleanup);
        if (worktreeRemoved) parallelRemovedWorktrees.add(path.resolve(worktree.path));
        if (producedNothing) result.noChanges = true;
        phaseClock.mark("postAgentChecks");
        result.phaseTimings = { ...phaseClock.summary(result), sharedSetupMs: parallelSharedSetupMs };
        if (worktree) {
          result.worktree = {
            path: worktreeRemoved ? "" : worktree.path,
            branch: worktreeRemoved ? "" : worktree.branch,
            baseCommit: worktree.baseCommit,
            baseTree: worktree.baseTree,
            patchSha256: worktreeDiff?.patchSha256 || "",
            sourceStateSha256: worktreeDiff?.sourceStateSha256 || "",
            cleanup: worktreeCleanup?.cleanup || "retained_for_review",
            removed: worktreeRemoved,
            removedPath: worktreeRemoved ? worktree.path : "",
            changedFiles: worktreeDiff?.changedFiles || [],
            diffStat: worktreeDiff?.diffStat || "",
          };
        }
        // L-025: the block is compact: everything a caller decides on comes before the report,
        // and the long bridge preamble is `detailText` (stored with the run, shown on request).
        const singleParts = formatSingleResultParts({ resolution, result, cwd: executionCwd, lockPlan });
        const head = [
          `JOB ${index + 1}`,
          ...compactJobLines({ resolution, result, unsafeFiles }),
          formatReadOnlyWorkspaceDrift(result.readOnlyWorkspaceDrift),
          worktree ? formatWorktreeSummary(worktree, worktreeCleanup) : null,
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : null,
          validationGate.status === "skipped" ? null : formatValidationGateResult(validationGate),
          `Unsafe changed files: ${unsafeFiles.length ? compactFileList(unsafeFiles) : "none detected"}`,
        ].filter(Boolean).join("\n");
        const tail = String(result.stderr || "").trim() ? singleParts.stderr.replace(/^\n/, "") : "";
        return {
          index,
          lockPlan,
          result,
          unsafeFiles,
          worktreeCleanup,
          startedAtMs: jobStartedAtMs,
          finishedAtMs: nowMs(),
          parts: { head, report: singleParts.report, tail },
          text: [head, singleParts.report, tail].filter(Boolean).join("\n"),
          detailText: [`Temporary lock acquired: ${hardLockSummary(acquiredLocks[index])}`, singleParts.preamble.trimEnd()].join("\n"),
        };
        });
      const settled = await settleIndependentParallelJobs(executionPromises);
      results = settled.map((entry, index) => entry.status === "fulfilled" ? entry.value : ({
        index,
        lockPlan: lockPlans[index],
        result: {
          changedFiles: [],
          exitCode: "infrastructure_failure",
          errorType: "parallel_job_infrastructure_failure",
          stderr: redactSensitiveText(entry.reason?.message || String(entry.reason)),
        },
        startedAtMs: 0,
        finishedAtMs: nowMs(),
        text: `JOB ${index + 1}\n${formatRejectedExecution({
          headline: "Parallel job failed at the bridge infrastructure layer.",
          errorType: "parallel_job_infrastructure_failure",
          reason: redactSensitiveText(entry.reason?.message || String(entry.reason)),
          requestedAgent: jobs[index].agent,
          actualAgent: parallelResolutions[index]?.actualAgent || "none",
          lockMode: lockPlans[index].lockMode,
          suggestedFix: "Inspect the retained sibling worktrees and retry through the queue/pipeline if cancellation or durable status is required.",
        })}`,
      }));
      // Every block names its Run id (rejection blocks too: the JOB label is what the report keys
      // it on) before the text is stored under that id.
      results.forEach((entry, position) => {
        const runId = parallelRunIds[Number.isInteger(entry.index) ? entry.index : position];
        if (!runId) return;
        entry.text = labelParallelRunId(entry.text, runId);
        if (entry.parts) entry.parts = { ...entry.parts, head: labelParallelRunId(entry.parts.head, runId) };
      });
      const parallelAudits = await Promise.all(results.map((entry, position) => {
        const index = Number.isInteger(entry.index) ? entry.index : position;
        // L-025: the result is stored under the Run id, report-first when it must be shortened.
        const fitted = entry.parts ? fitRedactedJobResult(entry.parts) : null;
        return parallelAudit.finish(parallelAuditHandles[index], {
          execution: { result: entry.result || {} },
          childStarted: parallelChildSpawned[index],
          errorType: entry.result?.errorType || (entry.unsafeFiles?.length ? "changed_file_validation_error" : ""),
          stored: fitted
            ? { text: fitted.text, detailText: entry.detailText || "", chars: fitted.chars, reportTruncated: fitted.reportTruncated }
            : { text: entry.text, detailText: entry.detailText || "" },
        });
      }));
      results.forEach((entry, position) => {
        entry.auditNotice = parallelAudit.notice(parallelAudits[position]);
      });
      for (const cwdKey of cwdKeys) {
        if (!parallelSnapshottedCwds.has(cwdKey)) continue;
        // A writer worktree that produced nothing was removed; there is no group state left there.
        if (parallelRemovedWorktrees.has(cwdKey)) continue;
        const indexesForCwd = lockPlans.map((_, index) => index).filter((index) => path.resolve(executionCwdForIndex(index)) === cwdKey);
        // A snapshot or git failure here (limit exceeded, git error) fails this workspace's
        // check closed; it must not discard every job result and Run id with it.
        try {
          parallelRollbackReports.push(await parallelGroupScopeReport({
            cwdKey,
            lockPlans,
            indexesForCwd,
            results,
            before: parallelBefore.get(cwdKey) || new Map(),
            expectedHead: parallelHeadBefore.get(cwdKey) || "",
            driftTolerated: parallelDriftToleratedCwds.has(cwdKey),
          }));
        } catch (error) {
          const errorType = error?.errorType || "parallel_group_snapshot_failed";
          const reason = redactSensitiveText(error?.message || String(error));
          for (const index of indexesForCwd) {
            const jobResult = results[index];
            if (!jobResult?.result) continue;
            jobResult.result.errorType ||= errorType;
            jobResult.result.stderr = [jobResult.result.stderr, `Group-scope check of ${cwdKey} failed closed: ${reason}`].filter(Boolean).join("\n");
          }
          parallelRollbackReports.push({
            cwd: cwdKey,
            headChanged: false,
            expectedHead: parallelHeadBefore.get(cwdKey) || "",
            actualHead: "unknown",
            changedFiles: [],
            disallowedFiles: [],
            serialOnlyMatches: [],
            externalDriftFiles: [],
            checkFailed: true,
            errorType,
            error: reason,
            rollback: "not_attempted_check_failed",
            rollbackFiles: [],
            unresolvedFiles: [],
          });
        }
      }
    } finally {
      clearTimeout(groupDeadlineTimer);
      acquiredLockHeartbeats.forEach((stop) => stop?.());
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
    }

    const lockViolations = verifyParallelLockResults(results);
    const parallelSuccess = !lockViolations.length
      && !parallelRollbackReports.some((report) => report.disallowedFiles.length || report.checkFailed)
      && !results.some((jobResult) => jobResult.result?.errorType);
    const executionOverlap = parallelExecutionOverlapEvidence(results);
    const ranConcurrently = executionOverlap.ranConcurrently;
    const groupStatus = parallelSuccess
      ? "completed"
      : results.some((item) => !item.result?.errorType) ? "partial_failed" : groupDeadlineExpired ? "cancelled_or_timed_out" : "failed";
    const parallelWorktreeCleanupReports = parallelWorktrees
      .map((worktree, index) => ({ worktree, index }))
      .filter(({ worktree }) => Boolean(worktree))
      .map(({ worktree, index }) => {
        const cleanup = results[index]?.worktreeCleanup || null;
        return cleanup
          ? {
              index,
              path: worktree.path,
              branch: worktree.branch,
              cleanup: cleanup.cleanup,
              reason: cleanup.reason || "",
              error: cleanup.error || "",
            }
          : {
              index,
              path: worktree.path,
              branch: worktree.branch,
              cleanup: "retained_for_review",
              reason: parallelSuccess
                ? "successful output awaits reviewed serial integration"
                : "partial or failed batch output is retained for diagnosis and recovery",
            };
      });
    const retainedWorktreeCount = parallelWorktreeCleanupReports.filter((report) => report.cleanup === "retained_for_review" || report.cleanup === "failed").length;
    const verification = [
      "Parallel lock verification:",
      lockViolations.length
        ? "Rejected. Do not accept these parallel results; move to serial integration/recovery."
        : "Accepted. All detected changed files stayed inside assigned locks.",
      lockViolations.length ? lockViolations.map((violation) => `- ${violation}`).join("\n") : "- No lock violations detected.",
    ].join("\n");
    const rollbackVerification = [
      "Parallel rollback verification:",
      parallelRollbackReports.some((report) => report.checkFailed)
        ? "Rejected. A group-scope check could not complete; the affected jobs failed closed and their output was retained."
        : parallelRollbackReports.some((report) => report.disallowedFiles.length)
        // The bridge never rolls back parallel output: path-only evidence cannot attribute it.
        ? "Rejected. Disallowed changed files were detected; no rollback was attempted and the changes and worktrees were retained for inspection."
        : "Accepted. No disallowed changed files detected at group scope.",
      ...parallelRollbackReports.map((report) =>
        [
          `Workspace: ${report.cwd}`,
          report.checkFailed ? `Group check failed: ${report.errorType}: ${report.error}` : null,
          `Changed files: ${report.changedFiles.length ? report.changedFiles.join(", ") : "none detected"}`,
          report.externalDriftFiles?.length ? `External changes (another client; the attested readers cannot edit): ${report.externalDriftFiles.join(", ")}` : null,
          `HEAD changed: ${report.headChanged ? `yes (${report.expectedHead} -> ${report.actualHead})` : "no"}`,
          `Disallowed files: ${report.disallowedFiles.length ? report.disallowedFiles.join(", ") : "none detected"}`,
          `Serial-only matches: ${report.serialOnlyMatches.length ? report.serialOnlyMatches.join(", ") : "none detected"}`,
          `Rollback: ${report.rollback}`,
          `Rollback files: ${report.rollbackFiles.length ? report.rollbackFiles.join(", ") : "none"}`,
          `Unresolved files: ${report.unresolvedFiles.length ? report.unresolvedFiles.join(", ") : "none"}`,
        ].filter(Boolean).join("\n")
      ),
    ].join("\n");
    const worktreeCleanupVerification = [
      "Parallel worktree cleanup:",
      !parallelWorktreeCleanupReports.length
        ? "No worktrees used."
        : retainedWorktreeCount === parallelWorktreeCleanupReports.length
        ? "All writer worktrees were retained for review."
        : `${retainedWorktreeCount} of ${parallelWorktreeCleanupReports.length} writer worktrees were retained; writers that changed nothing had their empty worktree removed.`,
      ...parallelWorktreeCleanupReports.map((report) =>
        [
          `JOB ${report.index + 1}`,
          `Path: ${report.path}`,
          `Branch: ${report.branch}`,
          `Cleanup: ${report.cleanup}`,
          report.reason ? `Reason: ${report.reason}` : null,
          report.error ? `Error: ${report.error}` : null,
        ].filter(Boolean).join("\n")
      ),
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: [
            `Parallel group status: ${groupStatus}`,
            `Group deadline ms: ${groupDeadlineMs} (longest agent budget plus validation timeout, plus margin)${groupDeadlineExpired ? "; the deadline expired and aborted the remaining work" : ""}`,
            `Ran concurrently (OpenCode child interval overlap): ${ranConcurrently ? "yes" : "no"}`,
            `Concurrent execution pairs: ${executionOverlap.pairs.length ? executionOverlap.pairs.map(([left, right]) => `JOB ${left + 1} + JOB ${right + 1}`).join(", ") : "none"}`,
            "Cancellation: this synchronous tool has no durable operation id; use queue/pipeline tools when cancellation or restart-safe status is required.",
            verification,
            rollbackVerification,
            worktreeCleanupVerification,
            ...results.map((entry) => [
              entry.text,
              detail && entry.detailText ? `Bridge detail (get_opencode_job with detail: true returns it later):\n${entry.detailText}` : null,
              entry.auditNotice,
            ].filter(Boolean).join("\n")),
          ].join("\n\n====================\n\n"),
        },
      ],
    };
  }
);

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function listReleaseFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Bridge release integrity check failed. Symbolic links and junctions are not allowed: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listReleaseFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Bridge release integrity check failed. Unsupported filesystem entry: ${relative}`);
    }
  }
  return files;
}

async function verifyReleaseManifest(releaseRoot) {
  const expectedManifestHash = String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim().toLowerCase();
  if (!expectedManifestHash) {
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash)) {
    throw new Error("Bridge release integrity check failed. CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 must be a SHA-256 hex digest.");
  }

  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const releaseRootDetails = await lstat(resolvedReleaseRoot);
  const canonicalReleaseRoot = await realpath(resolvedReleaseRoot);
  if (
    releaseRootDetails.isSymbolicLink()
    || !releaseRootDetails.isDirectory()
    || normalizePathForCompare(canonicalReleaseRoot) !== normalizePathForCompare(resolvedReleaseRoot)
  ) {
    throw new Error("Bridge release integrity check failed. The release root and its ancestors must be real directories, not symbolic links or junctions.");
  }

  const manifestPath = path.join(resolvedReleaseRoot, "release-manifest.json");
  const manifestContent = await readFile(manifestPath);
  const actualManifestHash = createHash("sha256").update(manifestContent).digest("hex");
  if (actualManifestHash !== expectedManifestHash) {
    throw new Error(`Bridge release manifest integrity check failed. Expected ${expectedManifestHash}, got ${actualManifestHash}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString("utf8"));
  } catch (error) {
    throw new Error(`Bridge release manifest is invalid JSON: ${error.message || String(error)}`);
  }
  if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Bridge release manifest must contain version 1 and a files object.");
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  for (const required of [
    "server.js",
    "package.json",
    "package-lock.json",
    "bin/process-supervisor.js",
    "bin/tui.js",
    "bin/e2e.js",
    "bin/e2e-contractor.js",
    "bin/e2e-concurrency.js",
    "bin/build-release.js",
    "bin/fresh-healthcheck.js",
    "opencode/.gitignore",
    "opencode/opencode.jsonc",
    "opencode/antigravity.json",
    "opencode/plugin-integrity-manifest.json",
    ...RELEASE_REQUIRED_MANAGED_AGENTS.map((agent) => `opencode/agents/${agent}.md`),
    ...REQUIRED_MANAGED_SKILLS.map((skill) => `opencode/skills/${skill}/SKILL.md`),
  ]) {
    if (!expectedFiles.includes(required)) {
      throw new Error(`Bridge release manifest is missing required file: ${required}`);
    }
  }
  for (const relative of expectedFiles) {
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(String(manifest.files[relative] || ""))) {
      throw new Error(`Bridge release manifest contains an unsafe or invalid entry: ${JSON.stringify(relative)}`);
    }
  }

  const actualFiles = (await listReleaseFiles(resolvedReleaseRoot)).filter((file) => file !== "release-manifest.json").sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("Bridge release contents do not exactly match release-manifest.json; unexpected or missing files were detected.");
  }

  const concurrency = 16;
  for (let index = 0; index < expectedFiles.length; index += concurrency) {
    await Promise.all(expectedFiles.slice(index, index + concurrency).map(async (relative) => {
      const actual = await sha256File(path.join(resolvedReleaseRoot, ...relative.split("/")));
      if (actual !== manifest.files[relative]) {
        throw new Error(`Bridge release file integrity check failed for ${relative}.`);
      }
    }));
  }
}

function releaseManagedSourcePathError(releaseRoot, {
  configHome = process.env.XDG_CONFIG_HOME || path.dirname(DEFAULT_OPENCODE_CONFIG_DIR),
  agentDir = OPENCODE_AGENT_DIR,
  skillDir = OPENCODE_SKILL_DIR,
} = {}) {
  const expectedConfigHome = path.resolve(releaseRoot);
  const expectedAgentDir = path.join(path.resolve(releaseRoot), "opencode", "agents");
  const expectedSkillDir = path.join(path.resolve(releaseRoot), "opencode", "skills");
  if (normalizePathForCompare(configHome) !== normalizePathForCompare(expectedConfigHome)) {
    return `XDG_CONFIG_HOME must equal the verified release root ${expectedConfigHome}.`;
  }
  if (normalizePathForCompare(agentDir) !== normalizePathForCompare(expectedAgentDir)) {
    return `CODEX_OPENCODE_AGENT_DIR must equal the verified release path ${expectedAgentDir}.`;
  }
  if (normalizePathForCompare(skillDir) !== normalizePathForCompare(expectedSkillDir)) {
    return `CODEX_OPENCODE_SKILL_DIR must equal the verified release path ${expectedSkillDir}.`;
  }
  return "";
}

function immutableReleasePluginModeError({
  releasePinned = Boolean(String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim()),
  allowExternalPlugins = CONFIG.allowExternalPlugins,
} = {}) {
  if (releasePinned && allowExternalPlugins) {
    return "Immutable releases must use pure mode and built-in authentication; external OAuth plugins share XDG_CONFIG_HOME with credential storage and are not supported.";
  }
  return "";
}

async function verifyReleaseIntegrity() {
  const expected = String(process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 || "").trim().toLowerCase();
  // The module's own file, never argv[1]: imported (the self-test suite) argv[1] is the
  // importer, and ESM has no __filename, so an empty argv[1] threw a ReferenceError.
  const serverPath = BRIDGE_SERVER_PATH;
  if (expected) {
    const actual = await sha256File(serverPath);
    if (actual !== expected) {
      throw new Error(`Bridge release integrity check failed. Expected ${expected}, got ${actual}.`);
    }
  }
  // B-092: since the split server.js imports most of the bridge from lib/, so the server pin
  // alone no longer covers the code that runs. CODEX_OPENCODE_EXPECTED_LIB_SHA256 pins lib/
  // (bin/lib-digest.js); a server-pinned entry without it fails closed, a manifest-pinned
  // release is covered by its manifest, and with neither pin nothing is checked.
  const libError = await libPinError(BRIDGE_RUNTIME_DIR, process.env);
  if (libError) {
    throw new Error(`Bridge release integrity check failed. ${libError}`);
  }
  await verifyReleaseManifest(BRIDGE_RUNTIME_DIR);
  if (String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim()) {
    const pluginModeError = immutableReleasePluginModeError();
    if (pluginModeError) {
      throw new Error(`Bridge release integrity check failed. ${pluginModeError}`);
    }
    const sourcePathError = releaseManagedSourcePathError(BRIDGE_RUNTIME_DIR);
    if (sourcePathError) {
      throw new Error(`Bridge release integrity check failed. ${sourcePathError}`);
    }
  }
}

function reconcileLegacyPipelineBatches(db, now = Date.now()) {
  const candidates = db.prepare(`
    SELECT pipeline_id, status, revision, owner_instance_id, owner_generation,
           owner_lease_expires_at, expected_child_count, batch_state, record_json
    FROM opencode_pipelines
    WHERE status IN ('planned', 'running') AND batch_state = 'legacy'
  `).all();
  const reconciled = [];
  for (const candidateRow of candidates) {
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const row = db.prepare(`
        SELECT pipeline_id, status, revision, owner_instance_id, owner_generation,
               owner_lease_expires_at, expected_child_count, batch_state, record_json
        FROM opencode_pipelines WHERE pipeline_id = ?
      `).get(candidateRow.pipeline_id);
      if (!row || row.batch_state !== "legacy" || !["planned", "running"].includes(row.status)) {
        db.exec("COMMIT");
        transactionOpen = false;
        continue;
      }
      const pipelineLease = Date.parse(row.owner_lease_expires_at || "");
      const owner = row.owner_instance_id
        ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(row.owner_instance_id)
        : null;
      const instanceLease = Date.parse(owner?.lease_expires_at || "");
      if ((Number.isFinite(pipelineLease) && pipelineLease > now)
        || (Number.isFinite(instanceLease) && instanceLease > now)) {
        db.exec("COMMIT");
        transactionOpen = false;
        continue;
      }

      let snapshot = {};
      try { snapshot = JSON.parse(row.record_json || "{}"); } catch { snapshot = {}; }
      const queueJobIds = Array.isArray(snapshot.queueJobIds) ? snapshot.queueJobIds.map(String) : [];
      const expectedCount = Number(row.expected_child_count || queueJobIds.length || 0);
      const uniqueIds = new Set(queueJobIds);
      const manifestRows = queueJobIds.length
        ? db.prepare(`
          SELECT job_id, status, revision, request_encrypted, record_json
          FROM opencode_jobs WHERE job_id IN (${queueJobIds.map(() => "?").join(",")})
        `).all(...queueJobIds)
        : [];
      const parentRows = db.prepare(`
        SELECT job_id, status, revision, request_encrypted, record_json
        FROM opencode_jobs
        WHERE json_valid(record_json) AND json_extract(record_json, '$.parentJobId') = ?
      `).all(row.pipeline_id);
      const observedById = new Map([...manifestRows, ...parentRows].map((jobRow) => [jobRow.job_id, jobRow]));
      const complete = expectedCount > 0
        && queueJobIds.length === expectedCount
        && uniqueIds.size === expectedCount
        && observedById.size === expectedCount
        && queueJobIds.every((jobId) => observedById.has(jobId))
        && [...observedById.values()].every((jobRow) => ["held", "pending"].includes(jobRow.status) && jobRow.request_encrypted);
      const at = new Date(now).toISOString();
      if (complete) {
        const insertRelation = db.prepare(`
          INSERT INTO opencode_pipeline_children (pipeline_id, ordinal, job_id, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const [ordinal, jobId] of queueJobIds.entries()) insertRelation.run(row.pipeline_id, ordinal, jobId, at);
        const releaseHeld = db.prepare(`
          UPDATE opencode_jobs SET status = 'pending', updated_at = ?, record_json = ?, revision = revision + 1
          WHERE job_id = ? AND status = 'held' AND revision = ?
        `);
        for (const jobRow of observedById.values()) {
          if (jobRow.status !== "held") continue;
          let jobSnapshot = {};
          try { jobSnapshot = JSON.parse(jobRow.record_json || "{}"); } catch { jobSnapshot = {}; }
          const pending = { ...jobSnapshot, status: "pending", revision: Number(jobRow.revision || 0) + 1 };
          const released = releaseHeld.run(at, JSON.stringify(queueRecordDurableSummary(pending)), jobRow.job_id, Number(jobRow.revision || 0));
          if (Number(released.changes || 0) !== 1) throw new Error("Legacy pipeline child release CAS failed.");
        }
        const recovered = {
          ...snapshot,
          status: "running",
          expectedChildCount: expectedCount,
          batchState: "released",
          queueMode: "sqlite",
          revision: Number(row.revision || 0) + 1,
          updatedAt: at,
        };
        const updated = db.prepare(`
          UPDATE opencode_pipelines
          SET status = 'running', updated_at = ?, record_json = ?, revision = revision + 1,
              expected_child_count = ?, batch_state = 'released', queue_mode = 'sqlite'
          WHERE pipeline_id = ? AND revision = ? AND batch_state = 'legacy'
        `).run(at, JSON.stringify(sanitizePersistedValue(recovered)), expectedCount, row.pipeline_id, Number(row.revision || 0));
        if (Number(updated.changes || 0) !== 1) throw new Error("Legacy pipeline recovery CAS failed.");
        reconciled.push({ pipelineId: row.pipeline_id, outcome: "released" });
      } else {
        const cancelChild = db.prepare(`
          UPDATE opencode_jobs
          SET status = 'cancelled', finished_at = ?, updated_at = ?, heartbeat_at = '', lease_expires_at = '',
              record_json = ?, revision = revision + 1
          WHERE job_id = ? AND status IN ('held', 'pending', 'planned', 'blocked') AND revision = ?
        `);
        for (const jobRow of observedById.values()) {
          if (!["held", "pending", "planned", "blocked"].includes(jobRow.status)) continue;
          let jobSnapshot = {};
          try { jobSnapshot = JSON.parse(jobRow.record_json || "{}"); } catch { jobSnapshot = {}; }
          const cancelled = {
            ...jobSnapshot,
            status: "cancelled",
            finishedAt: at,
            heartbeatAt: "",
            leaseExpiresAt: "",
            errorType: "pipeline_batch_incomplete",
            revision: Number(jobRow.revision || 0) + 1,
          };
          const cancelledChild = cancelChild.run(
            at,
            at,
            JSON.stringify(queueRecordDurableSummary(cancelled)),
            jobRow.job_id,
            Number(jobRow.revision || 0)
          );
          if (Number(cancelledChild.changes || 0) !== 1) throw new Error("Legacy pipeline child cancellation CAS failed.");
        }
        const failed = {
          ...snapshot,
          status: "failed",
          finishedAt: at,
          expectedChildCount: expectedCount,
          batchState: "incomplete",
          queueMode: "sqlite",
          revision: Number(row.revision || 0) + 1,
          updatedAt: at,
          errorType: "pipeline_batch_incomplete",
          observedChildCount: observedById.size,
        };
        const updated = db.prepare(`
          UPDATE opencode_pipelines
          SET status = 'failed', updated_at = ?, record_json = ?, revision = revision + 1,
              expected_child_count = ?, batch_state = 'incomplete', queue_mode = 'sqlite'
          WHERE pipeline_id = ? AND revision = ? AND batch_state = 'legacy'
        `).run(at, JSON.stringify(sanitizePersistedValue(failed)), expectedCount, row.pipeline_id, Number(row.revision || 0));
        if (Number(updated.changes || 0) !== 1) throw new Error("Legacy pipeline failure CAS failed.");
        reconciled.push({ pipelineId: row.pipeline_id, outcome: "failed" });
      }
      db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the recovery error. */ }
      }
      throw error;
    }
  }
  return reconciled;
}

function claimPersistedQueueRecordForStartup(db, jobId, expectedRevision, request) {
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = db.prepare(`
      SELECT job_id, status, created_at, started_at, finished_at, owner_instance_id, owner_process_id,
             owner_generation, heartbeat_at, lease_expires_at, cancellation_requested_at,
             child_process_id, child_process_started_at, revision, idempotency_key, request_encrypted, record_json
      FROM opencode_jobs WHERE job_id = ?
    `).get(jobId);
    if (!row || Number(row.revision || 0) !== Number(expectedRevision || 0)
      || !["held", "pending", "planned", "blocked"].includes(row.status)) {
      db.exec("COMMIT");
      transactionOpen = false;
      return null;
    }

    const heartbeatAt = new Date().toISOString();
    const resumed = {
      ...persistedQueueRecordFromRow(row),
      jobId: row.job_id,
      request,
      task: request?.task || "",
      status: row.status === "held" ? "held" : "pending",
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerProcessId: process.pid,
      ownerGeneration: randomBytes(12).toString("hex"),
      heartbeatAt,
      leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: Number(row.revision || 0),
    };
    const takeover = db.prepare(`
      UPDATE opencode_jobs SET status = ?, owner_instance_id = ?, owner_process_id = ?, owner_generation = ?,
        heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, record_json = ?, revision = revision + 1
      WHERE job_id = ? AND revision = ? AND status IN ('held', 'pending', 'planned', 'blocked')
        AND COALESCE(owner_instance_id, '') = ? AND COALESCE(owner_generation, '') = ?
        AND (lease_expires_at IS NULL OR lease_expires_at = '' OR julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      resumed.status, resumed.ownerInstanceId, resumed.ownerProcessId, resumed.ownerGeneration,
      resumed.heartbeatAt, resumed.leaseExpiresAt, resumed.heartbeatAt,
      JSON.stringify(queueRecordDurableSummary({ ...resumed, revision: resumed.revision + 1 })),
      resumed.jobId, resumed.revision, row.owner_instance_id || "", row.owner_generation || "",
      heartbeatAt, heartbeatAt
    );
    db.exec("COMMIT");
    transactionOpen = false;
    if (Number(takeover.changes || 0) !== 1) return null;
    resumed.revision += 1;
    return resumed;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the startup claim error. */ }
    }
    throw error;
  }
}

function failPersistedQueueStartupRecovery(db, row, failedRecord, encryptedDetails = null) {
  const failedAt = failedRecord.finishedAt || new Date().toISOString();
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const failed = db.prepare(`
      UPDATE opencode_jobs SET status = 'failed', finished_at = ?, updated_at = ?, heartbeat_at = '',
        lease_expires_at = '', child_process_id = 0, child_process_started_at = '', record_json = ?,
        result_encrypted = ?, revision = revision + 1
      WHERE job_id = ? AND revision = ? AND status IN ('held', 'pending', 'planned', 'blocked')
        AND COALESCE(owner_instance_id, '') = ? AND COALESCE(owner_generation, '') = ?
        AND (lease_expires_at IS NULL OR lease_expires_at = '' OR julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_jobs.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      failedAt, failedAt, JSON.stringify(queueRecordDurableSummary(failedRecord)), encryptedDetails,
      row.job_id, Number(row.revision || 0), row.owner_instance_id || "", row.owner_generation || "",
      failedAt, failedAt
    );
    if (Number(failed.changes || 0) === 1) {
      propagatePipelineTerminalInTransaction(db, row.job_id, "failed", failedAt);
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return Number(failed.changes || 0) === 1;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the startup recovery error. */ }
    }
    throw error;
  }
}

function deferredRecoveryBaseMs() {
  return Math.max(1000, Math.min(Number(CONFIG.queueHeartbeatMs) || 5000, 5000));
}

// Busy passes (non-terminal work or a failed scan) keep the short interval; idle passes double it
// up to CONFIG.deferredRecoveryIdleMaxMs so an idle bridge stops hammering the state databases.
function nextDeferredRecoveryDelayMs(busy) {
  const base = deferredRecoveryBaseMs();
  if (busy) {
    deferredRecoveryIdlePasses = 0;
    return base;
  }
  deferredRecoveryIdlePasses = Math.min(deferredRecoveryIdlePasses + 1, 16);
  return Math.min(base * 2 ** deferredRecoveryIdlePasses, Math.max(base, CONFIG.deferredRecoveryIdleMaxMs));
}

// Size + mtime of the database and its WAL: cheap enough to run on every pass instead of opening the file.
async function stateDbFingerprint(dbPath) {
  let fingerprint = "";
  for (const file of [dbPath, `${dbPath}-wal`]) {
    try {
      const info = await stat(file);
      fingerprint += `${info.size}:${Math.trunc(info.mtimeMs)};`;
    } catch {
      fingerprint += "-;";
    }
  }
  return fingerprint;
}

function scheduleDeferredRecovery(delayMs) {
  if (process.argv.includes("--self-test") || deferredRecoveryTimer) return;
  deferredRecoveryTimer = setTimeout(() => {
    deferredRecoveryTimer = null;
    void reconcileQueueStateAtStartup({ busyTimeoutMs: 250 }).catch((error) => {
      logEvent("warn", "state.deferred_recovery_failed", {
        errorType: error?.errorType || "deferred_recovery_failed",
      });
    });
  }, delayMs);
  deferredRecoveryTimer.unref?.();
}

// { repo, dbPath, projectKey, startedAt } while this process is a queue worker.
let queueWorkerMode = null;
// The worker holds every start until its --enqueue file is in (all lines valid and enqueued).
let queueStartsHeld = false;
// A stop was requested: nothing new starts, running jobs finish.
let queueDrainFlag = false;
const {
  queueWorkerFiles,
  readQueueWorkerText,
  readQueueWorkerFile,
  assertQueueWorkerDirectory,
  writeQueueWorkerFileAtomically,
  queueWorkerPresenceRecord,
  takeOverStalePresence,
  claimQueueWorkerPresence,
  refreshQueueWorkerPresence,
  releaseQueueWorkerPresence,
  writeQueueWorkerParked,
  removeQueueWorkerParked,
  writeQueueWorkerStop,
  readQueueWorkerStop,
  foreignQueueWorkerPresence,
  forgetQueueWorkerPresent,
  noteQueueWorkerPresent,
} = createQueueWorkerFilesRuntime({
  projectStateKey,
  effectiveBridgeStateDirectory,
  BRIDGE_INSTANCE_ID,
  getQueueWorkerMode: () => queueWorkerMode,
  getQueueDrainFlag: () => queueDrainFlag,
  sameStateDbPath,
  logEvent,
});
const QUEUE_WORKER_NON_TERMINAL_STATUSES = ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"];
// Every line of an --enqueue file: the enqueue_opencode_job input, with a required idempotency key
// (re-running the same file must deduplicate instead of doubling a 220-job batch) and no unknown
// field (a misspelt option would otherwise be dropped silently). parentJobId is not offered: a
// pipeline drives its own children.
const QUEUE_WORKER_JOB_SCHEMA = z.object({
  idempotencyKey: z.string().min(1).max(200),
  ...jobInputShape,
}).strict();

function queueDrainRequested() {
  return queueStartsHeld || queueDrainFlag;
}

function sameStateDbPath(left, right) {
  return normalizeFilesystemCase(path.resolve(String(left || ""))) === normalizeFilesystemCase(path.resolve(String(right || "")));
}


















async function startWorkerMode({ repo } = {}) {
  if (queueWorkerMode) throw Object.assign(new Error("This process is already a queue worker."), { errorType: "queue_worker_already_started" });
  if (!repo || !path.isAbsolute(String(repo))) throw Object.assign(new Error("--repo must be an absolute path."), { errorType: "queue_worker_invalid_repo" });
  if (effectiveQueueMode() !== "sqlite") {
    throw Object.assign(new Error(`The queue worker needs CODEX_OPENCODE_QUEUE_MODE=sqlite (it is ${effectiveQueueMode()}): it runs durable jobs only.`), { errorType: "queue_worker_needs_sqlite" });
  }
  const top = await runCommand("git", ["rev-parse", "--show-toplevel"], path.resolve(String(repo)), 15_000);
  if (top.exitCode !== 0 || !top.stdout.trim()) {
    throw Object.assign(new Error(`${repo} is not inside a Git repository.`), { errorType: "queue_worker_invalid_repo" });
  }
  const projectRoot = await resolveProjectStateRoot(repo);
  // The main start sequence, without a transport. Failures here mean "refused to start" (exit 1);
  // a crash after the start is "stopped by an error" (exit 2).
  installProcessFailureHandlers();
  await verifyReleaseIntegrity();
  await syncManagedRuntimeAtStartup();
  const pluginPolicy = await verifyExternalPluginPolicy(projectRoot);
  if (!pluginPolicy.ok) {
    throw Object.assign(new Error(`OpenCode external plugin policy rejected startup: ${pluginPolicy.error}`), { errorType: "plugin_policy_rejected" });
  }
  queueStartsHeld = true;
  queueDrainFlag = false;
  queueWorkerMode = { repo: projectRoot, dbPath: stateDbPath(projectRoot), projectKey: projectStateKey(projectRoot), startedAt: new Date().toISOString() };
  try {
    // Recovery adopts this repository's lapsed jobs; they wait (queueStartsHeld) until the
    // worker's own file is in.
    await beginBridgeStartupRecovery();
  } catch (error) {
    stopWorkerMode();
    throw Object.assign(new Error(`Startup recovery failed: ${redactSensitiveText(error?.message || String(error))}`), { errorType: "startup_recovery_failed" });
  }
  processCrashExitCode = 2;
  ensureQueueHeartbeatTimer();
  void reclaimProvenGoneProviderQuarantines({ force: true });
  void sweepStaleIndexScratchDirs();
  return { repo: projectRoot, projectKey: queueWorkerMode.projectKey, instanceId: BRIDGE_INSTANCE_ID, adopted: [...QUEUE_JOBS.values()].filter((record) => recordMatchesProject(record, projectRoot)).length };
}

// Ends worker mode in this process (the CLI exits next; a test starts the next worker). The
// repository's jobs this process holds but does not run are forgotten, as an exit would forget
// them: this process's heartbeat stops covering them, and the next owner adopts them once their
// leases lapse. Only an exit with nothing running gets here, apart from a refused start.
function stopWorkerMode() {
  if (queueWorkerMode) {
    for (const [jobId, record] of QUEUE_JOBS) {
      if (record.ownerInstanceId === BRIDGE_INSTANCE_ID && recordMatchesProject(record, queueWorkerMode.repo)
        && !QUEUE_ACTIVE_STATUSES.includes(record.status) && !record.executionPromise) QUEUE_JOBS.delete(jobId);
    }
  }
  queueWorkerMode = null;
  queueStartsHeld = false;
  queueDrainFlag = false;
  processCrashExitCode = 1;
}

function releaseQueueStarts() {
  queueStartsHeld = false;
  scheduleQueue();
}

function requestQueueDrain() {
  queueDrainFlag = true;
}

// --stop --now: the running jobs of this process are cancelled like cancel_opencode_job does
// (cancellation persisted, then the exact process tree terminated); they end `cancelled`, which
// requeue_opencode_job accepts. Pending jobs stay pending.
async function abortRunningQueueJobs(reason = "The queue worker was stopped with --now.") {
  const aborted = [];
  for (const record of runningQueueRecords()) {
    if (record.ownerInstanceId !== BRIDGE_INSTANCE_ID) continue;
    Object.assign(record, {
      cancellationRequested: true,
      cancellationRequestedAt: new Date().toISOString(),
      errorReason: reason,
    });
    try {
      await persistQueueRecord(record);
    } catch (error) {
      logEvent("warn", "queue_worker.abort_persist_failed", { jobId: record.jobId, summary: failureSummary(error?.message || String(error)) });
    }
    record.abortController?.abort();
    aborted.push(record.jobId);
  }
  return aborted;
}

function parseQueueWorkerJobLine(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error.message})` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "a line must be one JSON object (an enqueue_opencode_job input)" };
  const parsed = QUEUE_WORKER_JOB_SCHEMA.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(object)"}: ${issue.message}${issue.keys?.length ? ` (${issue.keys.join(", ")})` : ""}`).join("; ") };
  }
  return { ok: true, job: parsed.data };
}

// The full enqueue validation without a durable write (lock plan, Scope Contract, retry policy,
// autoIntegrate, worktree requirement), plus the idempotency check against the database: an
// existing key with other content refuses the file instead of half-enqueueing it.
async function checkQueueWorkerJob(job) {
  if (!queueWorkerMode) return { ok: false, errorType: "queue_worker_not_started", error: "The queue worker is not started." };
  if (!path.isAbsolute(String(job?.cwd || ""))) return { ok: false, errorType: "queue_worker_invalid_job", error: "cwd must be an absolute path." };
  const normalized = await normalizeJobCwd(job);
  if (RepositoryRootSet.key(normalized.cwd) !== RepositoryRootSet.key(queueWorkerMode.repo)) {
    return { ok: false, errorType: "queue_worker_wrong_repository", error: `cwd ${job.cwd} is not in the worker's repository ${queueWorkerMode.repo}; start a worker per repository.` };
  }
  const prepared = await enqueueQueueJob(job, "", { persist: false, schedule: false });
  if (!prepared.ok) return { ok: false, errorType: prepared.errorType || "queue_rejected", error: prepared.error || "The job was refused.", suggestedFix: prepared.suggestedFix || "" };
  const db = await openLockDb(queueWorkerMode.repo);
  try {
    const existing = db.prepare("SELECT job_id, status, record_json FROM opencode_jobs WHERE idempotency_key = ?").get(prepared.record.idempotencyKey);
    if (!existing) return { ok: true, fingerprint: prepared.record.requestFingerprint };
    let summary = {};
    try { summary = JSON.parse(existing.record_json || "{}"); } catch { /* Unreadable evidence is a mismatch. */ }
    if (!summary.requestFingerprint || summary.requestFingerprint !== prepared.record.requestFingerprint) {
      return { ok: false, errorType: "queue_idempotency_conflict", error: `idempotencyKey ${prepared.record.idempotencyKey} already belongs to job ${existing.job_id} with different request content.` };
    }
    return { ok: true, fingerprint: prepared.record.requestFingerprint, deduplicates: existing.job_id, existingStatus: existing.status };
  } finally {
    closeDb(db);
  }
}

async function enqueueFromToolInput(job) {
  const checked = await checkQueueWorkerJob(job);
  if (!checked.ok) return checked;
  // schedule: false: the worker releases all starts at once after the last line.
  return await enqueueQueueJob(job, "", { schedule: false });
}

// Jobs this worker enqueued from a file it then refused: cancelled before anything started, so the
// refusal leaves no half batch behind (requeue_opencode_job can still run them).
async function cancelUnstartedQueueJobs(jobIds, reason) {
  const cancelled = [];
  for (const jobId of jobIds) {
    const record = QUEUE_JOBS.get(jobId);
    if (!record || !["pending", "planned", "blocked", "held"].includes(record.status)) continue;
    Object.assign(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      cancellationRequested: true,
      cancellationRequestedAt: new Date().toISOString(),
      errorType: "agent_cancelled",
      errorReason: reason,
      heartbeatAt: "",
      leaseExpiresAt: "",
    });
    const persisted = await persistQueueRecord(record);
    if (persisted?.persisted) cancelled.push(jobId);
  }
  return cancelled;
}

// B-091: --status must not create or migrate anything. A database with a -wal and -shm file has
// (or had) a writer; a read-only connection reads it through them without writing. Without them
// every page is in the main file, but even a read-only connection would create -wal and -shm, so
// the file is opened immutable, or, where node:sqlite takes no URL (Node before 22.15), read from
// a temporary copy. null when the file does not exist.
function openStateDbForStatus(dbPath) {
  let details = null;
  try { details = lstatSync(dbPath); } catch { return null; }
  if (!details.isFile()) return null;
  if (existsSync(`${dbPath}-wal`) && existsSync(`${dbPath}-shm`)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000;");
    return { db, cleanup: () => {} };
  }
  try {
    const url = pathToFileURL(dbPath);
    url.searchParams.set("immutable", "1");
    return { db: new DatabaseSync(url, { readOnly: true }), cleanup: () => {} };
  } catch {
    const scratch = mkdtempSync(path.join(tmpdir(), "codex-queue-status-"));
    const copy = path.join(scratch, "state.sqlite");
    try {
      copyFileSync(dbPath, copy);
      return { db: new DatabaseSync(copy, { readOnly: true }), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }
}

function emptyQueueWorkerCounts() {
  return { pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, notResumable: 0, waitingForPause: 0, gaveUp: 0, autoIntegrated: 0, open: 0 };
}

function countQueueWorkerJobs(db, counts) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_jobs'").get()) return counts;
  for (const row of db.prepare("SELECT status, COUNT(*) AS count FROM opencode_jobs GROUP BY status").all()) {
    const count = Number(row.count || 0);
    if (QUEUE_WORKER_NON_TERMINAL_STATUSES.includes(row.status)) counts.open += count;
    if (["held", "pending", "planned"].includes(row.status)) counts.pending += count;
    else if (QUEUE_ACTIVE_STATUSES.includes(row.status)) counts.running += count;
    else if (row.status === "blocked") counts.blocked += count;
    else if (row.status === "not_resumable") counts.notResumable += count;
    else if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] += count;
  }
  const nowIso = new Date().toISOString();
  counts.waitingForPause = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM opencode_jobs
    WHERE status IN ('pending', 'planned') AND json_valid(record_json)
      AND COALESCE(json_extract(record_json, '$.startAfter'), '') > ?
  `).get(nowIso)?.count || 0);
  counts.gaveUp = Number(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE json_valid(record_json) AND json_extract(record_json, '$.completionOutcome') = 'gave_up'").get()?.count || 0);
  counts.autoIntegrated = Number(db.prepare("SELECT COUNT(*) AS count FROM opencode_jobs WHERE json_valid(record_json) AND json_extract(record_json, '$.autoIntegration.status') = 'committed'").get()?.count || 0);
  return counts;
}

function readOnlyProviderPauses() {
  const opened = openStateDbForStatus(path.join(effectiveBridgeStateDirectory(), "provider-concurrency.sqlite"));
  if (!opened) return [];
  try {
    const now = Date.now();
    return opened.db.prepare("SELECT provider_key, until_at FROM provider_cooldowns WHERE until_at > ? ORDER BY provider_key").all(now)
      .map((row) => ({ key: row.provider_key, until: new Date(Number(row.until_at)).toISOString() }));
  } catch {
    return [];
  } finally {
    try { opened.db.close(); } catch { /* Read-only: nothing to flush. */ }
    opened.cleanup();
  }
}

// Counts of one repository's queue from its database (nothing is created when it has none yet),
// the paused provider/model keys and free memory. `open` is every job that is not terminal.
// readOnly (--status, B-091) writes nothing at all, not even a schema migration or lease cleanup.
async function queueWorkerSnapshot({ repo = queueWorkerMode?.repo || "", readOnly = false } = {}) {
  const projectRoot = await resolveProjectStateRoot(repo);
  const dbPath = stateDbPath(projectRoot);
  const counts = emptyQueueWorkerCounts();
  let pausedKeys = [];
  if (readOnly) {
    const opened = openStateDbForStatus(dbPath);
    if (opened) {
      try {
        countQueueWorkerJobs(opened.db, counts);
      } finally {
        try { opened.db.close(); } catch { /* Read-only. */ }
        opened.cleanup();
      }
    }
    pausedKeys = readOnlyProviderPauses();
  } else {
    if (existsSync(dbPath)) {
      const db = await openLockDb(projectRoot);
      try {
        countQueueWorkerJobs(db, counts);
      } finally {
        closeDb(db);
      }
    }
    try {
      pausedKeys = [...(await activeProviderPauses()).entries()].map(([key, until]) => ({ key, until: new Date(until).toISOString() }));
    } catch {
      // The provider database being busy must not stop a status line.
    }
  }
  return { repo: projectRoot, dbPath, counts, pausedKeys, freeMemoryMb: Math.round(currentFreeMemoryBytes() / 1024 / 1024) };
}

// What this process still has in hand: running jobs, auto-integrations (running, or waiting for a
// lock) and retry decisions. --until-empty waits for all of them. A stop (B-084) does not wait for
// an auto-integration that only waits for a lock: its job is completed and marked
// waiting_for_lock, and the recovery pass of the next worker (or of a bridge after --release)
// schedules it again (rescheduleOpenAutoIntegrations).
function queueWorkerActivity() {
  const running = runningQueueRecords().filter((record) => record.ownerInstanceId === BRIDGE_INSTANCE_ID).length;
  const integrating = AUTO_INTEGRATION_CHAINS.size;
  const waitingIntegrations = AUTO_INTEGRATION_WAITING.size;
  const retries = getQueueRetryPoliciesInFlight();
  return {
    running,
    autoIntegrations: integrating + waitingIntegrations,
    integrating,
    waitingIntegrations,
    retries,
    quiet: !running && !integrating && !waitingIntegrations && !retries,
    quietForStop: !running && !integrating && !retries,
  };
}

// B-086: a refused start logs one warn line with its reason; the exit handler's process.exited
// error (an incident) is for real failures.
function recordQueueWorkerRefusal(reason, fields = {}) {
  processExitLogSuppressedCode = 1;
  logEvent("warn", "queue_worker.refused", {
    projectKey: queueWorkerMode?.projectKey || fields.projectKey || "",
    errorType: String(fields.errorType || "queue_worker_refused"),
    summary: failureSummary(reason),
  });
}

// dbPath -> repository root keys with non-terminal integration operations at its last
// successful scan, so a failed scan keeps its roots blocked.
const INTEGRATION_RECOVERY_ROOTS_BY_DB = new Map();
// root key -> last requalification attempt for a repository with only quarantined operations.
const INTEGRATION_QUARANTINE_RECOVERY_ATTEMPTS = new Map();
const INTEGRATION_QUARANTINE_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

async function reconcileQueueStateAtStartup({ busyTimeoutMs = 5000 } = {}) {
  if (deferredRecoveryRunning) return;
  deferredRecoveryRunning = true;
  let passBusy = true;
  try {
  let anyPending = false;
  const queuePersistenceEnabled = effectiveQueueMode() === "sqlite";
  const stateRoot = effectiveBridgeStateDirectory();
  const candidates = [path.join(stateRoot, "bridge-state.sqlite")];
  const cleanupRecoveryCandidates = [];
  const pipelineAggregationCandidates = [];
  // root key -> { cwd, needsRecovery, quarantinedOnly }; only databases scanned in this pass.
  const integrationRecoveryCandidates = new Map();
  try {
    const projectsDir = path.join(stateRoot, "projects");
    for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        candidates.push(path.join(projectsDir, entry.name));
      }
    }
  } catch (error) {
    // A missing projects directory means no project databases yet. Any other error must not
    // abort the pass (at startup it crashed the bridge): log it and recover what is readable.
    if (error?.code !== "ENOENT") {
      anyPending = true;
      logEvent("warn", "state.recovery_projects_scan_failed", { errorCode: error?.code || "", error: redactSensitiveText(error?.message || String(error)) });
    }
  }
  for (const knownDbPath of [...INTEGRATION_RECOVERY_ROOTS_BY_DB.keys()]) {
    if (!candidates.includes(knownDbPath) || !existsSync(knownDbPath)) INTEGRATION_RECOVERY_ROOTS_BY_DB.delete(knownDbPath);
  }
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    // B-075: a queue worker recovers, adopts and schedules only its own repository's database;
    // the other repositories belong to the client bridges (or their own workers).
    if (queueWorkerMode && !sameStateDbPath(dbPath, queueWorkerMode.dbPath)) continue;
    const fingerprint = await stateDbFingerprint(dbPath);
    const memo = DEFERRED_RECOVERY_DB_MEMO.get(dbPath);
    if (memo && !memo.pending && memo.fingerprint === fingerprint) continue;
    let db = null;
    let dbPending = false;
    let dbScanFailed = false;
    let dbOperationsScanned = false;
    const dbIntegrationRoots = new Set();
    try {
      db = new DatabaseSync(dbPath);
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(5000, Number(busyTimeoutMs) || 250))};`);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA synchronous = FULL;");
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='locks'").get()
        && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get()) {
        ensureTableColumn(db, "runs", "containment", "TEXT NOT NULL DEFAULT ''");
        if (db.prepare("SELECT 1 FROM locks WHERE expires_at = ? LIMIT 1").get(Number.MAX_SAFE_INTEGER)) {
          await reclaimProvenGoneLockQuarantines(db);
          // A process dying does not touch the database file, so the unchanged-file memo
          // would skip this database; keep it pending until its quarantine is gone.
          if (db.prepare("SELECT 1 FROM locks WHERE expires_at = ? LIMIT 1").get(Number.MAX_SAFE_INTEGER)) dbPending = true;
        }
      }
      const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_jobs'").get();
      if (!hasJobs) continue;
      ensureQueueLeaseSchema(db);
      db.exec(`CREATE TABLE IF NOT EXISTS bridge_instances (
        instance_id TEXT PRIMARY KEY,
        process_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL
      )`);
      ensureIntegrationJournalSchema(db);
      const scanAt = Date.now();
      // An operation whose owner process holds a live lease while a serial-integration lock is
      // active is an ordinary integration in progress (possibly in the other client's bridge),
      // not something to recover: recovering it only failed on the serial lock and blocked
      // the repository's writers with a false "quarantined integration" reason.
      const serialIntegrationActive = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='locks'").get()
        && db.prepare("SELECT 1 FROM locks WHERE lock_mode = 'serial_integration' AND expires_at > ? LIMIT 1").get(scanAt));
      for (const row of db.prepare(`
        SELECT operation.cwd, operation.status,
               EXISTS (
                 SELECT 1 FROM bridge_instances AS instance
                 WHERE instance.instance_id = operation.owner_instance_id AND instance.lease_expires_at > ?
               ) AS owner_live
        FROM integration_operations AS operation
        WHERE operation.status NOT IN (${INTEGRATION_RESOLVED_SQL})
      `).all(new Date(scanAt).toISOString())) {
        dbPending = true;
        if (!row.cwd) continue;
        const rootKey = RepositoryRootSet.key(row.cwd);
        dbIntegrationRoots.add(rootKey);
        const live = row.status !== "quarantined" && Boolean(row.owner_live) && serialIntegrationActive;
        const candidate = integrationRecoveryCandidates.get(rootKey) || { cwd: path.resolve(row.cwd), needsRecovery: false, quarantinedOnly: true };
        if (!live) candidate.needsRecovery = true;
        if (row.status !== "quarantined") candidate.quarantinedOnly = false;
        integrationRecoveryCandidates.set(rootKey, candidate);
      }
      dbOperationsScanned = true;
      const hasPipelines = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_pipelines'").get();
      if (hasPipelines) {
        ensurePipelineRevisionSchema(db);
        ensureWorktreeArtifactSchema(db);
        await migrateLegacyEncryptedState(db, dbPath);
        const legacyBatches = reconcileLegacyPipelineBatches(db);
        if (legacyBatches.length) {
          logEvent("warn", "pipeline.legacy_batches_reconciled", {
            count: legacyBatches.length,
            outcomes: legacyBatches.map((item) => item.outcome),
          });
        }
        const nowIso = new Date().toISOString();
        db.prepare(`
          UPDATE opencode_pipelines
          SET status = 'cleanup_pending', cleanup_state = 'authorized', updated_at = ?,
              record_json = json_set(record_json, '$.status', 'cleanup_pending', '$.cleanupState', 'authorized'),
              revision = revision + 1
          WHERE status = 'completed' AND json_valid(record_json)
            AND json_extract(record_json, '$.cleanupPending') = 1
            AND (owner_lease_expires_at = '' OR owner_lease_expires_at <= ?)
            AND NOT EXISTS (
              SELECT 1 FROM bridge_instances
              WHERE instance_id = opencode_pipelines.owner_instance_id AND lease_expires_at > ?
            )
        `).run(nowIso, nowIso, nowIso);
        const cleanupRows = db.prepare(`
          SELECT pipeline_id, record_json FROM opencode_pipelines
          WHERE (status = 'cleanup_pending' AND cleanup_state = 'authorized')
             OR (status = 'cleanup_failed' AND cleanup_state = 'failed_retryable')
        `).all();
        if (cleanupRows.length) dbPending = true;
        for (const pipelineRow of cleanupRows) {
          try {
            const snapshot = JSON.parse(pipelineRow.record_json || "{}");
            if (snapshot.cwd) cleanupRecoveryCandidates.push({ pipelineId: pipelineRow.pipeline_id, cwd: snapshot.cwd });
          } catch {
            // An unreadable pipeline summary cannot authorize destructive cleanup.
          }
        }
        const aggregateRows = db.prepare(`
          SELECT pipeline.pipeline_id, pipeline.record_json
          FROM opencode_pipelines AS pipeline
          WHERE pipeline.status = 'running' AND pipeline.batch_state = 'released'
            AND pipeline.expected_child_count > 0
            AND pipeline.expected_child_count = (
              SELECT COUNT(*) FROM opencode_pipeline_children AS relation
              WHERE relation.pipeline_id = pipeline.pipeline_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM opencode_pipeline_children AS relation
              JOIN opencode_jobs AS job ON job.job_id = relation.job_id
              WHERE relation.pipeline_id = pipeline.pipeline_id
                AND job.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'not_resumable')
            )
        `).all();
        if (aggregateRows.length) dbPending = true;
        for (const pipelineRow of aggregateRows) {
          try {
            const snapshot = JSON.parse(pipelineRow.record_json || "{}");
            if (snapshot.cwd) pipelineAggregationCandidates.push({ pipelineId: pipelineRow.pipeline_id, cwd: snapshot.cwd });
          } catch {
            // An unreadable parent summary is left for operator-visible recovery diagnostics.
          }
        }
      }
      KNOWN_STATE_DB_PATHS.add(dbPath);
      if (!queuePersistenceEnabled) continue;
      // B-075: a live queue worker owns this repository's unattended jobs. Adopting its lapsed
      // pending jobs (or resuming its interrupted ones) here would make them die with this
      // client, so the queue rows are left alone while its presence file is fresh. The database
      // stays pending: the presence file going stale does not change the database file.
      const worker = foreignQueueWorkerPresence(dbPath);
      if (worker) {
        dbPending = true;
        noteQueueWorkerPresent(dbPath, worker);
        continue;
      }
      forgetQueueWorkerPresent(dbPath);
      reconcileStaleQueueRecords(db);
      await rescheduleOpenAutoIntegrations(db);
      if (db.prepare(`
        SELECT 1 FROM opencode_jobs
        WHERE status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
        LIMIT 1
      `).get()) dbPending = true;
      const resumableRows = db.prepare(`
        SELECT job_id, status, revision, owner_instance_id, owner_generation, lease_expires_at,
               record_json, idempotency_key, request_encrypted
        FROM opencode_jobs
        WHERE status IN ('held', 'pending', 'planned', 'blocked')
          AND request_encrypted IS NOT NULL AND request_encrypted <> ''
      `).all();
      for (const row of resumableRows) {
        if (QUEUE_JOBS.has(row.job_id)) continue;
        const now = Date.now();
        const jobLeaseExpiresAt = Date.parse(row.lease_expires_at || "");
        const owner = row.owner_instance_id
          ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(row.owner_instance_id)
          : null;
        const ownerLeaseExpiresAt = Date.parse(owner?.lease_expires_at || "");
        if ((Number.isFinite(jobLeaseExpiresAt) && jobLeaseExpiresAt > now)
          || (Number.isFinite(ownerLeaseExpiresAt) && ownerLeaseExpiresAt > now)) continue;
        let request;
        try {
          request = await decryptQueueRequest(row.request_encrypted, row.job_id);
          if (request?.internalQueueContractorProof) {
            request.internalQueueContractorProof = makeInternalQueueContractorProof(row.job_id, request.internalQueueContractorProof);
          }
        } catch (error) {
          logEvent("warn", "queue.request_resume_failed", { jobId: row.job_id, dbPath, error: redactSensitiveText(error.message || String(error)) });
          const failedAt = new Date().toISOString();
          let snapshot = {};
          try { snapshot = JSON.parse(row.record_json || "{}"); } catch { /* Preserve only bounded failure evidence. */ }
          Object.assign(snapshot, {
            jobId: row.job_id,
            status: "failed",
            finishedAt: failedAt,
            heartbeatAt: "",
            leaseExpiresAt: "",
            errorType: "queue_request_recovery_failed",
            errorReason: "The encrypted queue request could not be recovered. Restore the matching queue-request.key backup before retrying.",
          });
          let encryptedDetails = null;
          try { encryptedDetails = await encryptQueuePrivateDetails(snapshot); } catch { /* The summary remains fail-closed. */ }
          failPersistedQueueStartupRecovery(db, row, snapshot, encryptedDetails);
          continue;
        }
        try {
          const resumed = claimPersistedQueueRecordForStartup(db, row.job_id, row.revision, request);
          if (resumed) QUEUE_JOBS.set(resumed.jobId, resumed);
        } catch (error) {
          logEvent("warn", "queue.startup_claim_failed", {
            jobId: row.job_id,
            dbPath,
            error: error.message || String(error),
          });
        }
      }
    } catch (error) {
      dbPending = true;
      dbScanFailed = true;
      logEvent("warn", "queue.startup_recovery_failed", { dbPath, error: error.message || String(error) });
    } finally {
      if (db) closeDb(db);
      DEFERRED_RECOVERY_DB_MEMO.set(dbPath, { fingerprint, pending: dbPending });
      if (dbPending) anyPending = true;
      // A database whose scan failed (SQLITE_BUSY at the short deferred busy timeout) keeps
      // the roots it had: its quarantined repositories must not unblock for one pass.
      if (!dbScanFailed || dbOperationsScanned) INTEGRATION_RECOVERY_ROOTS_BY_DB.set(dbPath, dbIntegrationRoots);
    }
  }
  const knownIntegrationRoots = new Set();
  for (const roots of INTEGRATION_RECOVERY_ROOTS_BY_DB.values()) {
    for (const root of roots) knownIntegrationRoots.add(root);
  }
  for (const blockedRoot of [...INTEGRATION_RECOVERY_BLOCKED_ROOTS]) {
    if (!knownIntegrationRoots.has(blockedRoot)) INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(blockedRoot);
  }
  for (const [rootKey, candidate] of integrationRecoveryCandidates) {
    const { cwd } = candidate;
    if (!candidate.needsRecovery) continue;
    // A repository with only quarantined operations needs the requalification pass once per
    // start and then every few minutes, not a repository-wide serial lock every 5 s.
    const lastAttemptAt = INTEGRATION_QUARANTINE_RECOVERY_ATTEMPTS.get(rootKey) || 0;
    if (candidate.quarantinedOnly && lastAttemptAt && Date.now() - lastAttemptAt < INTEGRATION_QUARANTINE_RECOVERY_INTERVAL_MS) {
      INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(cwd);
      continue;
    }
    if (candidate.quarantinedOnly) INTEGRATION_QUARANTINE_RECOVERY_ATTEMPTS.set(rootKey, Date.now());
    try {
      const recovery = await recoverIntegrationRepositorySerially(cwd);
      if (!recovery.ok && recovery.errorType === "integration_recovery_lock_conflict") {
        // Someone holds the repository's serial lock (a live integration, the other bridge's
        // recovery): the state is unknown, so leave the blocked set as it is and retry later.
        INTEGRATION_QUARANTINE_RECOVERY_ATTEMPTS.delete(rootKey);
        logEvent("info", "integration.startup_recovery_deferred", {
          cwdSha256: createHash("sha256").update(cwd).digest("hex"),
          errorType: recovery.errorType,
        });
        continue;
      }
      if (!recovery.ok) {
        INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(cwd);
        logEvent("error", "integration.startup_recovery_blocked", {
          cwdSha256: createHash("sha256").update(cwd).digest("hex"),
          errorType: recovery.errorType || "integration_recovery_quarantined",
          operationIds: recovery.operationIds || [],
        });
      } else {
        INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(cwd);
        INTEGRATION_QUARANTINE_RECOVERY_ATTEMPTS.delete(rootKey);
      }
    } catch (error) {
      INTEGRATION_RECOVERY_BLOCKED_ROOTS.add(cwd);
      logEvent("error", "integration.startup_recovery_failed", {
        cwdSha256: createHash("sha256").update(cwd).digest("hex"),
        errorType: error?.errorType || "integration_recovery_failed",
      });
    }
  }
  for (const candidate of pipelineAggregationCandidates) {
    try {
      // A pipeline this process is finalizing or already drives live is not recovery's to touch.
      if (FINALIZING_PIPELINE_IDS.has(candidate.pipelineId)) continue;
      const record = await readPersistedPipelineRecord(candidate.pipelineId, candidate.cwd);
      if (!record) continue;
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok || claim.alreadyOwnedLive || claim.reacquired) continue;
      PIPELINE_RUNS.set(record.pipelineId, record);
      await refreshPipelineRecord(record);
    } catch (error) {
      logEvent("warn", "pipeline.aggregate_recovery_failed", {
        pipelineId: candidate.pipelineId,
        errorType: error?.errorType || "pipeline_aggregate_recovery_failed",
      });
    }
  }
  for (const candidate of cleanupRecoveryCandidates) {
    try {
      // The live finalizer removes these worktrees itself; resuming its cleanup concurrently
      // removed the same worktrees twice. Recovery resumes only cleanup nobody drives: a
      // foreign or dead owner's, or this process's own once it rests in cleanup_failed.
      if (FINALIZING_PIPELINE_IDS.has(candidate.pipelineId)) continue;
      const record = await readPersistedPipelineRecord(candidate.pipelineId, candidate.cwd);
      if (!record) continue;
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok || FINALIZING_PIPELINE_IDS.has(candidate.pipelineId)) continue;
      if ((claim.alreadyOwnedLive || claim.reacquired) && record.status !== "cleanup_failed") continue;
      PIPELINE_RUNS.set(record.pipelineId, record);
      await resumeAuthorizedPipelineCleanup(record);
    } catch (error) {
      logEvent("warn", "pipeline.cleanup_startup_recovery_failed", {
        pipelineId: candidate.pipelineId,
        errorSha256: createHash("sha256").update(error?.message || String(error)).digest("hex"),
      });
    }
  }
  if (queuePersistenceEnabled) {
    ensureQueueHeartbeatTimer();
    if (QUEUE_JOBS.size) scheduleQueue();
  }
  passBusy = anyPending;
  } finally {
    deferredRecoveryRunning = false;
    scheduleDeferredRecovery(nextDeferredRecoveryDelayMs(passBusy));
  }
}

// A release carries the reviewed agent and skill profiles. When the operator points
// the bridge at a separate runtime directory (CODEX_OPENCODE_AGENT_DIR/SKILL_DIR),
// copy the release's profiles there at startup so the runtime never lags the
// release. It runs only from a release folder, only adds or updates files, never
// deletes, and is disabled with CODEX_OPENCODE_SYNC_MANAGED_RUNTIME=false. A failed
// copy is logged and startup continues with the runtime's existing profiles.
async function syncManagedRuntimeAtStartup() {
  if (String(process.env.CODEX_OPENCODE_SYNC_MANAGED_RUNTIME || "").trim().toLowerCase() === "false") return { skipped: "disabled" };
  if (!process.env.CODEX_OPENCODE_AGENT_DIR || !process.env.CODEX_OPENCODE_SKILL_DIR) return { skipped: "runtime_dirs_not_configured" };
  if (!existsSync(path.join(BRIDGE_RUNTIME_DIR, "release-manifest.json"))) return { skipped: "not_a_release" };
  const source = path.join(BRIDGE_RUNTIME_DIR, "opencode");
  const comparable = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  if (comparable(OPENCODE_AGENT_DIR) === comparable(path.join(source, "agents"))
    && comparable(OPENCODE_SKILL_DIR) === comparable(path.join(source, "skills"))) {
    return { skipped: "runtime_is_release" };
  }
  try {
    const { runSync } = await import("./bin/sync-managed-runtime.js");
    const report = await runSync({ source, agentDir: OPENCODE_AGENT_DIR, skillDir: OPENCODE_SKILL_DIR, apply: true, removeStale: false });
    const changed = report.applied || [];
    const failed = changed.filter((item) => !item.ok);
    if (changed.length) {
      logEvent(failed.length ? "error" : "info", "runtime.managed_profiles_synced", {
        changed: changed.length,
        failed: failed.length,
        files: changed.map((item) => `${item.tree}/${item.relative}`).slice(0, 40),
      });
    }
    return { synced: changed.length - failed.length, failed: failed.length };
  } catch (error) {
    logEvent("error", "runtime.managed_profiles_sync_failed", { error: redactSensitiveText(error?.message || String(error)) });
    return { failed: 1 };
  }
}

async function runProviderLeaseWorker() {
  const marker = process.argv.indexOf("--provider-lease-worker");
  const holdMs = Math.max(50, Number(process.argv[marker + 1]) || 500);
  const lease = await acquireProviderLease({
    providerKey: CONFIG.providerConcurrencyKey,
    timeoutMs: 1000 * 30,
  });
  if (!lease.ok) throw new Error(lease.error);
  const acquiredAt = Date.now();
  process.stdout.write(`${JSON.stringify({ acquiredAt, waitedMs: lease.waitedMs, pid: process.pid })}\n`);
  try {
    await delayWithSignal(holdMs);
  } finally {
    await releaseProviderLease(lease.lease);
  }
}

// The self-test suite (tests/server-self-test.js) imports this file as a module.
// It reads internals through __selfTest.internals and sets test-only module
// variables through the live accessors in __selfTest.hooks.
export const __selfTest = {
  internals: {
    INTEGRATION_RESOLVED_STATUSES,
    integrationQuarantineStatusLine,
    resolveIntegrationQuarantine,
    agentMetadataCacheKey,
    seedIndexFromRealIndex,
    createPhaseClock,
    directRunAuditStore,
    formatIntegrationTimings,
    formatOpenCodeUsage,
    formatPhaseTimings,
    formatSingleResult,
    formatSingleResultParts,
    compactJobLines,
    fitJobResultText,
    queueResultFields,
    integrationTimingStorage,
    listRetainedWorktreeArtifacts,
    BRIDGE_INSTANCE_ID,
    BRIDGE_OPENCODE_HOME_DIR,
    BRIDGE_RUNTIME_DIR,
    BRIDGE_SERVER_PATH,
    CONFIG,
    CONTRACTOR_ALLOWED_SUBAGENTS,
    FINALIZING_PIPELINE_IDS,
    INTEGRATION_RECOVERY_BLOCKED_ROOTS,
    awaitBridgeStartupRecovery,
    blockQueueRecordAfterLockRefusal,
    bridgeLaunchedAsMain,
    claimPersistedPipeline,
    commitQueueTerminalRecord,
    heartbeatKnownQueueState,
    queueHardLockRequestRefusal,
    queueRequestFingerprint,
    reacquirePersistedQueueRecordLease,
    reconcileQueueStateAtStartup,
    scopeContractDurableSummary,
    sqliteUniqueConstraintError,
    startQueueRecord,
    DEFAULT_FORBIDDEN_EDIT_PATHS,
    DEFAULT_OPENCODE_CONFIG_DIR,
    DEFAULT_OPENCODE_DATA_DIR,
    DatabaseSync,
    GLOBALLY_REQUIRED_MANAGED_AGENTS,
    INTEGRATION_PREVIEWS,
    INTEGRATION_PREVIEW_TTL_MS,
    INTEGRATION_RECOVERY_BLOCKED_ROOTS,
    MAX_LOCK_TTL_MS,
    createPatchFromWorkingTree,
    expandIgnoredDirectoryEntries,
    formatAgentLockList,
    formatLockExpiry,
    generatedWorktreeRootForCwd,
    gitChangedFileSnapshotParts,
    gitIndexPathSnapshot,
    ignoredIntegrationSourceFiles,
    integrationJournalDiagnosis,
    integrationRecoveryBaseline,
    quarantineHardLock,
    realPathBoundaryReason,
    reconcileWorktreeArtifactRegistry,
    recoverIntegrationRepositorySerially,
    recoverSingleIntegrationOperationWhileLocked,
    reservedLockAgentError,
    MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
    MCP_ORCHESTRATOR_AGENT,
    MCP_SANITIZED_READER_AGENT,
    MCP_SANITIZED_READER_PROFILE,
    MCP_SANITIZED_READER_PROMPT,
    PIPELINE_RUNS,
    QUEUE_JOBS,
    RELEASE_REQUIRED_MANAGED_AGENTS,
    REPOSITORY_SCOPE_LOCK_PATH,
    REQUIRED_MANAGED_AGENTS,
    REQUIRED_MANAGED_SKILLS,
    STANDALONE_ORCHESTRATOR_AGENT,
    USER_HOME_DIR,
    abortSignalErrorType,
    acquireHardLock,
    activatePipelineBatch,
    allowlistedModelOverride,
    applyModelOverrideToMetadata,
    applyPatchFile,
    inspectRepositoryGitControlSurface,
    inspectRepositoryOperationState,
    captureWritableScopeFilesystemState,
    writableScopeFilesystemViolation,
    windowsStreamSyntax,
    replaceRollbackLeaf,
    writeTemporaryPatchFile,
    assert,
    assertSupportedCallerModel,
    assertSupportedQueueRetryConfig,
    assessQueuePlan,
    requalifyStateDriftQuarantine,
    quarantineIntegrationOperation,
    buildOpenCodeEnv,
    buildTrustedGitEnv,
    buildValidationEnv,
    cachedAttestation,
    cancelPersistedQueueJob,
    captureGitIndexIdentity,
    captureIntegrationTargetState,
    captureRollbackBaseline,
    changedFileValidationErrorType,
    changedFilesBetween,
    chmod,
    claimQueueRecord,
    classifyResultError,
    cleanupExpiredLocks,
    cleanupWorktree,
    clearAttestationCache,
    clearQueueLeaseFence,
    closeDb,
    collectIntegrationPatch,
    collectWorktreeDiff,
    contractorAuthorizationToken,
    contractorAuthorizationValid,
    contractorNestedAgentMetadataError,
    createHash,
    createIsolatedOpenCodeRuntime,
    createPipelinePlan,
    createWorktreeForJob,
    decryptQueueRequest,
    defaultBuilderTimeoutMs,
    defaultOrchestratorTimeoutMs,
    detectsOpenCodeApiError,
    directExecutionLockConflictDetails,
    dirtyCheckpointDetails,
    effectiveQueueMode,
    effectiveReadOnlyMetadataError,
    enqueueQueueJob,
    ensureLockTableSchema,
    exactIntegrationFileSnapshot,
    exactPluginSpecifier,
    execFileAsync,
    executeOpenCodeJob,
    existsSync,
    filesystemCaseModeForRoot,
    finalizePipelineRecord,
    findQueueWriteConflict,
    formatRejectedExecution,
    gitChangedFileSnapshot,
    gitChangedFiles,
    groupIgnoredFiles,
    binaryTextFilesInPatch,
    processDescendants,
    conflictsWithActiveLock,
    providerKeyForMetadata,
    parallelBatchCapacityError,
    hardLockTtlForPlan,
    hashExactTree,
    immutableReleasePluginModeError,
    inspectOpenCodeEventStream,
    inspectSourceCheckpointState,
    integratePatchSerially,
    integrationCleanupTargetStateError,
    integrationPreviewReceiptError,
    capturePatchedPathsState,
    collectIntegrationBatchPatch,
    integrationBatchOverlaps,
    integrationPathsTouching,
    integrationTargetMovementEvidence,
    INTEGRATION_BATCH_MAX_ITEMS,
    isManagedReadOnlyAgent,
    isOrchestratorAgent,
    isPathInside,
    isWithinAnyPath,
    link,
    listLocks,
    listPersistedQueueRecords,
    loadProjectAgentPolicy,
    lockTableHasCompositePrimaryKey,
    lstat,
    makeIntegrationPreviewReceipt,
    makeInternalQueueContractorProof,
    managedAgentSourceProfile,
    managedSkillPolicyError,
    mkdir,
    mkdtemp,
    modelEvidenceFromEvent,
    modelRequirementSchema,
    nextQueueScheduleDelay,
    normalizeAgentDebugMetadata,
    normalizeLockPath,
    normalizeLockPathForCwd,
    normalizeProjectAgentPolicy,
    normalizeScopeContract,
    compactQueueJobLines,
    essentialQueueJobView,
    diagnoseJobView,
    queueAgentTiming,
    queueRunStage,
    staleBridgeProcessHint,
    bridgeSourceFreshness,
    bridgeSourceFreshnessLines,
    truncateResultText,
    diffStatFromPatch,
    readOnlyHeadMove,
    formatReadOnlyHeadMove,
    noteQueueLeaseRenewalFailure,
    open,
    openCodeRunArgs,
    openLockDb,
    parallelExecutionOverlapEvidence,
    parseCommandLine,
    parseDependencyRequest,
    parseModelAllowlistEntry,
    parsePipelineGateVerdict,
    path,
    persistPipelineRecord,
    persistQueueRecord,
    persistTerminalQueueRecord,
    pluginSpecsFromConfigText,
    prepareIntegrationOperation,
    prepareValidationCommand,
    providerErrorTypeFromStructuredEvent,
    providerErrorTypeFromText,
    pruneInMemoryState,
    prunePersistedState,
    queueRecordDurableSummary,
    queueRecordSnapshot,
    randomBytes,
    readFile,
    readIntegrationOperationSummary,
    readOnlyResultRetryable,
    readOnlyRoutingPolicyError,
    readPersistedPipelineRecord,
    readPersistedQueueRecord,
    reconcileParentPipelineAfterQueueTerminal,
    runPipelineReadOnlyGate,
    reconcileStaleQueueRecords,
    recordMatchesProject,
    recoverIntegrationOperationsWhileLocked,
    patchLikelySecretLines,
    LIKELY_SECRET_PATTERNS,
    logEvent,
    describeFailedMcpMessage,
    installMcpFailureLogging,
    recordProcessFailure,
    rememberMcpRequest,
    containmentStillPossible,
    buildCompactPrompt,
    callerPathSpellings,
    redactLikelySecrets,
    redactSensitiveText,
    refreshPipelineRecord,
    releaseHardLock,
    releaseManagedSourcePathError,
    renewPersistedQueueRecordLease,
    resolveProjectStateRoot,
    resolveValidationExecutable,
    resumeAuthorizedPipelineCleanup,
    retryAfterMsFromText,
    rm,
    rollbackUnsafeChanges,
    rollbackVerifiedOwnedChanges,
    runCommand,
    runGitReadOnlyCommand,
    runSingleFlight,
    runSpawnCommand,
    runValidationGate,
    sanitizeLogValue,
    sanitizePersistedValue,
    sanitizedAgentMetadataError,
    sanitizedDiscoveryContext,
    sanitizedJobPolicyError,
    sanitizedRoutingPolicyError,
    scheduleQueue,
    scrubLegacyLockSecrets,
    server,
    settleIndependentParallelJobs,
    sha256File,
    shouldUseWorktree,
    spawn,
    startHardLockHeartbeat,
    startProviderLeaseHeartbeat,
    statFingerprint,
    stateDbPath,
    statePruneTimes,
    sweepIntegrationPreviews,
    symlink,
    timeoutForAgent,
    tmpdir,
    transientGitIndexReadError,
    transitionIntegrationOperation,
    trustedGitArgs,
    unsafePathReason,
    updatePipelineRecord,
    updateQueueRecordDurable,
    updateQueueTerminalRecordDurable,
    userAuthorizedOrchestrator,
    validateChangedFilesForPlan,
    validateDelegationPlanInputs,
    validateParallelWritePlan,
    validateSingleLockPlan,
    validationCommandPreflightError,
    validationCommandTrustError,
    verifyJobWorkspaceReadiness,
    verifyParallelLockResults,
    verifyProtectedGitRoot,
    verifyReleaseIntegrity,
    verifyReleaseManifest,
    verifySanitizedJobsBeforeDiscovery,
    verifySanitizedWorkspace,
    wipeIsolatedOpenCodeRuntime,
    writeFile,
    z,
    // tests/review-spawn.js
    DEFAULT_OPENCODE_CACHE_HOME,
    MAX_AGENT_TIMEOUT_MS,
    acquireProviderLease,
    commandShape,
    containmentRecord,
    expectedOpenCodePluginResolution,
    resolvePluginManifestEntryPath,
    applyGitControlSurfaceCheck,
    gitControlSurfaceChanges,
    gitControlSurfaceFingerprint,
    globToRegex,
    jobInputShape,
    openCodeCommandLineLengthError,
    openCodePromptArgument,
    openProviderLeaseDb,
    parseJsonText,
    pathSpeller,
    pluginConfigCandidatePaths,
    processTable,
    providerCapacitySnapshot,
    providerKeyLikePattern,
    quarantineProviderLease,
    readChoiceEnv,
    readNonNegativeIntEnv,
    readOnlyRetryBudgetExhaustedResult,
    releaseProviderLease,
    runOpenCode,
    // tests/review-tools-pipelines.js
    finalizePipelineRecordWhileLocked,
    finalizePipelineSourceCleanup,
    formatReadOnlyWorkspaceDrift,
    hasAmbiguousPathPattern,
    internalQueueContractorProofValid,
    mergePipelineIntegrationQueue,
    nextPipelineIntegrationItemStatus,
    parallelGroupDeadlineMs,
    parallelGroupScopeReport,
    parallelProviderKeys,
    pipelineIntegrationItemMatches,
    readOnlyEditsDeniedByAttestation,
    readOnlyWorkspaceDrift,
    reconcilePipelineIntegrationOperationStates,
    trackedTargetStateSha256,
    // tests/review-provider-quota.js
    enforceQueueResultEvidence,
    providerSlotWaitStorage,
    providerSlotWaitingJobs,
    recordProviderCooldown,
    syntheticProviderQuotaNotice,
    // tests/review-round5.js
    queueCapacityReport,
    timedOutWriterNote,
    providerErrorTypeFromDiagnosticLine,
    queueMemoryGate,
    queueMemoryStatusLines,
    queueMemoryWaitingJobs,
    agentActivityByJobId,
    formatIdleDuration,
    noteAgentActivity,
    queueAgentActivity,
    // tests/review2-a.js
    beginBridgeStartupRecovery,
    readPositiveIntEnv,
    readUserLineEndingGitConfig,
    // tests/review-queue-features.js
    ENV_PROVIDER_CONCURRENCY_LIMIT,
    ENV_QUEUE_PARALLEL_LIMIT,
    MAX_RUNTIME_CONCURRENCY_LIMIT,
    RUNTIME_CONCURRENCY,
    describeConcurrencyLimits,
    encryptQueueRequest,
    markQueueJobRequeued,
    refreshRuntimeConcurrency,
    requeueIdempotencyKey,
    requeueQueueJob,
    runtimeConcurrencyLimitError,
    setRuntimeConcurrency,
    // tests/review-flex-*.js (flexible scheduling, B-060, B-061, Q-005..Q-010)
    DEFAULT_MIN_FREE_MEMORY_MB,
    agentIdleTimeoutForModel,
    agentIdleTimeoutStatusLine,
    effectiveMinFreeMemoryMb,
    readModelDurationMapEnv,
    applyRateLimitOutcome,
    createRateLimitWatcher,
    modelPauseKeyForMetadata,
    openCodeRateLimitHit,
    parseOpenCodeLogLine,
    rateLimitPauseReason,
    readOpenCodeLogPathEnv,
    recordRateLimitPause,
    ENV_GLOBAL_WORKER_LIMIT,
    MAX_GLOBAL_WORKER_LIMIT,
    pauseProvider,
    providerPauseTarget,
    resumeProvider,
    RETRY_POLICY_ERROR_TYPES,
    applyQueueRetryPolicy,
    applyRetryPolicyToJob,
    chooseRetryModel,
    jobRetryPolicy,
    queueOnlyOptionsError,
    formatScopeContractForPrompt,
    selfCheckCommandsError,
    AUTO_INTEGRATION_CHAINS,
    autoIntegrateJobError,
    autoIntegrateQueueJob,
    autoIntegrationCommitHooks,
    autoIntegrationClaimerGone,
    rescheduleOpenAutoIntegrations,
    AUTO_INTEGRATION_RESCHEDULED,
    patchFileEntries,
    SELF_TEST_TEMP_STATE_DIR,
    effectiveBridgeStateDirectory,
  },
  hooks: {
    get attestationCacheTtlOverride() { return attestationCacheTtlOverride; },
    set attestationCacheTtlOverride(value) { attestationCacheTtlOverride = value; },
    get pipelinePersistenceTestHook() { return pipelinePersistenceTestHook; },
    set pipelinePersistenceTestHook(value) { pipelinePersistenceTestHook = value; },
    get queueCancellationTestHook() { return queueCancellationTestHook; },
    set queueCancellationTestHook(value) { queueCancellationTestHook = value; },
    get queueModeOverride() { return queueModeOverride; },
    set queueModeOverride(value) { queueModeOverride = value; },
    get queueWriteConflictPolicyOverride() { return queueWriteConflictPolicyOverride; },
    set queueWriteConflictPolicyOverride(value) { queueWriteConflictPolicyOverride = value; },
    get selfTestContractorAuthorizationSha256() { return selfTestContractorAuthorizationSha256; },
    set selfTestContractorAuthorizationSha256(value) { selfTestContractorAuthorizationSha256 = value; },
    get selfTestModelOverrideAllowlist() { return selfTestModelOverrideAllowlist; },
    set selfTestModelOverrideAllowlist(value) { selfTestModelOverrideAllowlist = value; },
    get stateDirectoryOverride() { return stateDirectoryOverride; },
    set stateDirectoryOverride(value) { stateDirectoryOverride = value; },
    get worktreeCleanupTestHook() { return worktreeTestHooks.cleanup; },
    set worktreeCleanupTestHook(value) { worktreeTestHooks.cleanup = value; },
    get integrationScratchCleanupTestHook() { return getIntegrationScratchCleanupTestHook(); },
    set integrationScratchCleanupTestHook(value) { setIntegrationScratchCleanupTestHook(value); },
    get pipelineGateExecutorTestHook() { return pipelineGateExecutorTestHook; },
    set pipelineGateExecutorTestHook(value) { pipelineGateExecutorTestHook = value; },
    get queueJobExecutorTestHook() { return queueJobExecutorTestHook; },
    set queueJobExecutorTestHook(value) { queueJobExecutorTestHook = value; },
    get queuePersistTestHook() { return queuePersistTestHook; },
    set queuePersistTestHook(value) { queuePersistTestHook = value; },
    get bridgeStartupRecovery() { return bridgeStartupRecovery; },
    set bridgeStartupRecovery(value) { bridgeStartupRecovery = value; },
    get agentRuntimeTestHook() { return agentRuntimeTestHook; },
    set agentRuntimeTestHook(value) { agentRuntimeTestHook = value; },
    get freeMemoryBytesTestHook() { return freeMemoryBytesTestHook; },
    set freeMemoryBytesTestHook(value) { freeMemoryBytesTestHook = value; },
    get minFreeMemoryMbOverride() { return minFreeMemoryMbOverride; },
    set minFreeMemoryMbOverride(value) { minFreeMemoryMbOverride = value; },
    get autoResumeInterruptedOverride() { return autoResumeInterruptedOverride; },
    set autoResumeInterruptedOverride(value) { autoResumeInterruptedOverride = process.argv.includes("--self-test") ? value : null; },
  },
};

// B-075: the surface bin/queue-worker.js drives. Importing this module starts nothing
// (bridgeLaunchedAsMain is false for the worker), so the worker decides the order.
export const queueWorkerApi = Object.freeze({
  PRESENCE_FRESH_MS: QUEUE_WORKER_PRESENCE_FRESH_MS,
  get instanceId() { return BRIDGE_INSTANCE_ID; },
  get stateDirectory() { return effectiveBridgeStateDirectory(); },
  get mode() { return queueWorkerMode ? { ...queueWorkerMode } : null; },
  startWorkerMode,
  stopWorkerMode,
  releaseQueueStarts,
  requestQueueDrain,
  abortRunningQueueJobs,
  parseJobLine: parseQueueWorkerJobLine,
  checkJob: checkQueueWorkerJob,
  enqueueFromToolInput,
  cancelUnstartedJobs: cancelUnstartedQueueJobs,
  queueWorkerSnapshot,
  activity: queueWorkerActivity,
  resolveRepository: resolveProjectStateRoot,
  files: queueWorkerFiles,
  readFile: readQueueWorkerFile,
  presenceFresh: queueWorkerPresenceFresh,
  presenceLive: queueWorkerPresenceLive,
  pidAlive: queueWorkerPidAlive,
  writeParked: writeQueueWorkerParked,
  removeParked: removeQueueWorkerParked,
  recordRefusal: recordQueueWorkerRefusal,
  claimPresence: claimQueueWorkerPresence,
  refreshPresence: refreshQueueWorkerPresence,
  releasePresence: releaseQueueWorkerPresence,
  writeStop: writeQueueWorkerStop,
  readStop: readQueueWorkerStop,
  logEvent: (level, event, data) => logEvent(level, event, data),
});

// Imported by the self-test suite: register tools only, never connect or recover.
// argv[1] is compared by real path: a launch through a junction or symlink, or as
// `node server` (Node adds the extension), used to fail the plain path comparison, do
// nothing and exit 0, which the client only saw as "connection closed".
function bridgeLaunchedAsMain(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  const resolved = path.resolve(String(argvPath));
  const launched = existsSync(resolved) ? resolved : existsSync(`${resolved}.js`) ? `${resolved}.js` : "";
  if (!launched) return false;
  try {
    return normalizeFilesystemCase(realpathSync(launched)) === normalizeFilesystemCase(realpathSync(BRIDGE_SERVER_PATH));
  } catch {
    return false;
  }
}

const BRIDGE_RUN_AS_MAIN = bridgeLaunchedAsMain();

if (!BRIDGE_RUN_AS_MAIN) {
  // Module import: the importer drives everything.
} else if (process.argv.includes("--provider-lease-worker")) {
  await verifyReleaseIntegrity();
  await runProviderLeaseWorker();
} else if (process.argv.includes("--verify-plugin-policy")) {
  await verifyReleaseIntegrity();
  process.stdout.write(`${JSON.stringify(await verifyExternalPluginPolicy(process.argv[process.argv.indexOf("--verify-plugin-policy") + 1] || process.cwd()))}\n`);
} else if (process.argv.includes("--self-test") || process.argv.includes("--self-test-events")) {
  // The suite lives in tests/server-self-test.js; keep `node server.js --self-test` working.
  const suite = path.join(BRIDGE_RUNTIME_DIR, "tests", "server-self-test.js");
  process.exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [suite, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
} else {
  // First, so a failed integrity check or plugin policy at startup (a rejected top-level
  // await reaches uncaughtException) is in the operations log too.
  installProcessFailureHandlers();
  await verifyReleaseIntegrity();
  await syncManagedRuntimeAtStartup();
  const startupPluginPolicy = await verifyExternalPluginPolicy(process.cwd());
  if (!startupPluginPolicy.ok) {
    throw new Error(`OpenCode external plugin policy rejected startup: ${startupPluginPolicy.error}`);
  }
  // Connect first so the client's MCP startup timeout never waits on recovery; tool calls
  // wait for bridgeStartupRecovery (see awaitBridgeStartupRecovery).
  beginBridgeStartupRecovery();
  const transport = new StdioServerTransport();
  // Protocol.onerror: unparseable frames, failed sends, handler errors the SDK cannot answer.
  server.server.onerror = (error) => {
    logEvent("error", "mcp.protocol_error", { errorType: String(error?.code || error?.name || ""), summary: failureSummary(error?.message || String(error)) });
  };
  await server.connect(transport);
  // After connect: the SDK sets transport.onmessage during connect (B-056).
  installMcpFailureLogging(transport);
  // A failed recovery is already logged and answered per tool call; it must not end the process.
  await bridgeStartupRecovery.catch(() => {});
  void reclaimProvenGoneProviderQuarantines({ force: true });
  void sweepStaleIndexScratchDirs();
}
