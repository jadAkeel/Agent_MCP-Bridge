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
import { libDigest, libPinError } from "./bin/lib-digest.js";
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
import { createOrchestratorPolicyRuntime } from "./lib/orchestrator-policy.js";
import { createJobDiscoveryRuntime } from "./lib/job-discovery.js";
import { createAutoIntegrationRuntime } from "./lib/queue/auto-integration.js";
import { createQueueStartRuntime } from "./lib/queue/start.js";
import { createQueueSchedulerRuntime } from "./lib/queue/scheduler.js";
import { createPipelineStoreRuntime } from "./lib/pipelines/store.js";
import { createParallelPlanRuntime } from "./lib/parallel-plan.js";
import { createPipelineFinalizeRuntime } from "./lib/pipelines/finalize.js";
import { registerLockAndStatusTools } from "./lib/tools/locks-status.js";
import { registerPipelineTools } from "./lib/tools/pipelines.js";
import { registerJobTools } from "./lib/tools/jobs.js";
import { registerIntegrationTools } from "./lib/tools/integration.js";
import { registerParallelTool } from "./lib/tools/parallel.js";
import { createProviderLeaseRuntime } from "./lib/provider-leases.js";
import { createProviderQuarantineRuntime } from "./lib/provider-quarantine.js";
import { createReleaseIntegrityRuntime } from "./lib/release-integrity.js";
import { createExternalRunnersRuntime } from "./lib/external-runners.js";

const execFileAsync = promisify(execFile);
const BRIDGE_RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SERVER_PATH = fileURLToPath(import.meta.url);
const BRIDGE_SOURCE_SHA256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
// B-103: the lib/ digest at startup (bin/lib-digest.js), so a status call can tell when a
// deploy changed lib/ (most deploys since the split) under a process Codex kept alive. "" when
// lib/ cannot be digested here (a link under it in a development tree; the pin check decides).
const BRIDGE_LIB_SHA256_AT_STARTUP = await libDigest(BRIDGE_RUNTIME_DIR).then((digest) => digest?.sha256 || "", () => "");
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
  // Q-013: the build a fault happened on; the lib pin is the digest the clients run.
  buildStamp: () => `server ${BRIDGE_SOURCE_SHA256.slice(0, 12)} lib ${String(process.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256 || "").trim().toLowerCase().slice(0, 12) || "unpinned"}`,
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
let selfTestModelOverrideAllowlist = null;
let pipelinePersistenceTestHook = null;
let queueCancellationTestHook = null;
// Self-test only: stands in for agent discovery, attestation and the OpenCode run so the job
// and parallel paths can be exercised against a real Git checkout without a provider.

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

// Q-013: a handler that throws is a defect of the bridge (every refusal it makes on purpose is
// a returned result). The SDK turns the throw into an isError answer with the message only, so
// the fault log gets the stack here; the throw itself is unchanged.
function wrapToolHandler(toolName, handler) {
  return async (...handlerArgs) => {
    const stop = startToolProgressHeartbeat(handlerArgs[handlerArgs.length - 1]);
    try {
      const recovery = await awaitBridgeStartupRecovery();
      if (!recovery.ok) return recovery.failed ? startupRecoveryFailedResult(recovery.error) : startupRecoveryPendingResult();
      return await handler(...handlerArgs);
    } catch (error) {
      try {
        logEvent("error", "tool.handler_failed", {
          tool: String(toolName || ""),
          errorType: String(error?.errorType || error?.code || error?.name || ""),
          summary: failureSummary(error?.message || String(error)),
          stack: typeof error?.stack === "string" ? error.stack.split(/\r?\n/).slice(0, 10).join("\n") : "",
        });
      } catch { /* Logging must never change the answer. */ }
      throw error;
    } finally {
      stop();
    }
  };
}

const registerToolWithoutProgress = server.tool.bind(server);
server.tool = (...registration) => {
  const handler = registration[registration.length - 1];
  if (typeof handler === "function") {
    registration[registration.length - 1] = wrapToolHandler(registration[0], handler);
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
  lockType: z.string().optional().describe("read or write (serial_integration is reserved for the bridge's own integration and refused)."),
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
  // B-171: the OpenCode executable itself is an input of every attestation (an upgrade changes
  // the effective configuration without touching any config file); only an absolute path can be
  // stat'ed, a bare command name resolves through PATH at spawn time.
  const executable = path.isAbsolute(String(OPENCODE_EXE || "")) ? [OPENCODE_EXE] : [];
  const tracked = [...configFiles, ...agentFiles, ...executable, CONFIG.externalPluginManifestPath].filter(Boolean);
  const parts = await Promise.all(tracked.map(statFingerprint));
  const skills = await managedSkillSourceEvidence();
  parts.push(`skills\0${skills.ok ? skills.sha256 : "unavailable"}\0${skills.fileCount}`);
  parts.push(`plugins\0${CONFIG.allowExternalPlugins ? CONFIG.externalPluginAllowlist.join(",") : "pure"}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// A cached value carries the time of the fresh read it came from (`attestedAtMs`) and its key
// (`attestationKey`), so a later caller can ask for the same attestation with a shorter age limit
// (`maxAgeMs`, B-171) and gets a fresh read when the entry is older than that.
function stampAttestation(value, key, at, cacheHit) {
  const clone = structuredClone(value);
  if (clone && typeof clone === "object" && !Array.isArray(clone)) {
    clone.attestedAtMs = at;
    clone.attestationKey = key;
    clone.attestationCacheHit = cacheHit;
  }
  return clone;
}

async function cachedAttestation(key, operation, cacheable, { maxAgeMs = null } = {}) {
  const ttl = attestationCacheTtlMs();
  if (ttl <= 0) return operation();
  const ageLimit = Number.isFinite(maxAgeMs) && maxAgeMs !== null ? Math.min(ttl, Math.max(0, maxAgeMs)) : ttl;
  const fingerprint = await attestationFingerprint();
  const hit = attestationCache.get(key);
  if (hit && hit.fingerprint === fingerprint && Date.now() - hit.at < ageLimit) {
    return stampAttestation(hit.value, key, hit.at, true);
  }
  const value = await runSingleFlight(attestationFlights, `${key}\0${fingerprint}`, operation);
  const at = Date.now();
  if (cacheable(value)) {
    attestationCache.set(key, { fingerprint, value: structuredClone(value), at });
  } else {
    attestationCache.delete(key);
  }
  return stampAttestation(value, key, at, false);
}

// B-171: the last attestation before a spawn. It used to be an uncached read for every job (two
// to three OpenCode cold starts, 30 to 60 s on a loaded host). The inputs it can see are all in the
// cache fingerprint (config dir, agent and skill files, plugin manifest, the OpenCode executable;
// project configuration is disabled for OpenCode here), so a result read within
// CODEX_OPENCODE_ATTESTATION_FINAL_MAX_AGE_MS is reused; older entries and a 0 setting read again.
async function reattestAgentMetadata(agent, cwd, previous, { maxAgeMs = CONFIG.attestationFinalMaxAgeMs } = {}) {
  const key = String(previous?.attestationKey || "");
  if (!(maxAgeMs > 0) || !key || attestationCacheTtlMs() <= 0) {
    return readAgentDebugMetadataUncached(agent, cwd, {});
  }
  return cachedAttestation(key, () => readAgentDebugMetadataUncached(agent, cwd, {}), (value) => Boolean(value?.ok), { maxAgeMs });
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
    // Q-013: a client probing a method the bridge does not serve (resources/templates/list,
    // prompts/list) gets -32601 by design; 35 such lines a day said nothing. A -32601 for a
    // tools/call (unknown tool) stays an error.
    if (code === -32601 && method && method !== "tools/call") return null;
    // errorType groups the incident summary by JSON-RPC code (one bucket per code, not one for all).
    return { level: "error", event: "mcp.request_failed", data: { method, tool, code, errorType: code === null ? "" : `jsonrpc_${code}`, summary: failureSummary(message.error.message || "JSON-RPC error without a message"), durationMs } };
  }
  const result = message.result;
  if (!result || typeof result !== "object") return null;
  const text = mcpAnswerText(result);
  if (result.isError === true) {
    // McpServer turns its own McpErrors (unknown tool, input validation) into isError results
    // whose text starts "MCP error <code>:"; those are request failures, not bridge refusals.
    const sdkError = /^MCP error (-?\d+):/.exec(text);
    if (sdkError) {
      return { level: "error", event: "mcp.request_failed", data: { method, tool, code: Number(sdkError[1]), errorType: `jsonrpc_${Number(sdkError[1])}`, summary: failureSummary(text), durationMs } };
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
      // Q-012: a run on an external runner names it (its job lines say "Role enforcement: none (runner codex)").
      const runner = /^Role enforcement: none \(runner ([a-z]+)\)/m.exec(text)?.[1] || "";
      return { level: "warn", event: "agent.run_failed", data: { tool, errorType: errorTypes[0], errorTypes: errorTypes.slice(0, 10), ...(runner ? { runner } : {}), summary: failureSummary(text), durationMs } };
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
  abortSignalErrorType: (...args) => abortSignalErrorType(...args),
  logEvent,
});



const { validationCommandTrustError, validationPathValue, resolveWindowsNodeShim, resolveValidationExecutable, prepareValidationCommand, VALIDATION_PREFLIGHT_FIX, validationCommandPreflightError, runValidationProcess, runValidationGate } = createValidationRuntime({
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

const { providerLimitForKey, quotaGroupProviderKeys, runtimeProviderLimitsError, perProviderLimitEntries, openProviderLeaseDb, RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING, RUNTIME_CONCURRENCY_REFRESH_MS, runtimeConcurrencyRefreshedFor, runtimeConcurrencyRefreshedAt, runtimeConcurrencyLimitError, globalWorkerLimitError, readRuntimeConcurrencyRows, applyRuntimeConcurrency, refreshRuntimeConcurrency, describeConcurrencyLimits, setRuntimeConcurrency, acquireProviderLease, PROVIDER_COOLDOWN_MAX_MS, providerSlotWaitStorage, providerSlotWaitingJobs, recordProviderCooldown, recordRateLimitPause, providerPauseTarget, pauseProvider, resumeProvider, providerLeaseOwnershipLossError, startProviderLeaseHeartbeat, releaseProviderLease } = createProviderLeaseRuntime({ BRIDGE_INSTANCE_ID, CONFIG, ENV_GLOBAL_WORKER_LIMIT, ENV_PROVIDER_CONCURRENCY_LIMIT, ENV_QUEUE_PARALLEL_LIMIT, MAX_GLOBAL_WORKER_LIMIT, MAX_RUNTIME_CONCURRENCY_LIMIT, QUEUE_JOBS, RUNTIME_CONCURRENCY, assertNoLinkedPath, closeDb, delayWithSignal, effectiveBridgeStateDirectory, ensureTableColumn, logEvent, modelPauseKeyForMetadata: (...args) => modelPauseKeyForMetadata(...args), providerKeyForMetadata: (...args) => providerKeyForMetadata(...args), reclaimProvenGoneProviderQuarantines: (...args) => reclaimProvenGoneProviderQuarantines(...args), releaseResumedPauseWaits: (...args) => releaseResumedPauseWaits(...args), scheduleQueue: (...args) => scheduleQueue(...args) });

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

const { providerQuarantineReclaimAt, reclaimProvenGoneProviderQuarantines, reclaimProvenGoneLockQuarantines, lockQuarantineReclaimAt, reclaimLockQuarantinesForRoot, quarantineProviderLease, providerKeyForMetadata, modelPauseKeyForMetadata, providerKeyLikePattern, providerCapacitySnapshot } = createProviderQuarantineRuntime({ BRIDGE_INSTANCE_ID, CONFIG, applyRuntimeConcurrency, providerLimitForKey, closeDb, containmentStillPossible, describeConcurrencyLimits, logEvent, openLockDb, openProviderLeaseDb, readRuntimeConcurrencyRows });

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
  const result = await safeOpenCodeCommand(["agent", "list"], cwd, CONFIG.attestationCommandTimeoutMs, { forcePure });
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
  const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, CONFIG.attestationCommandTimeoutMs, { forcePure });
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
  const read = () => safeOpenCodeCommand(["debug", "skill"], cwd, CONFIG.attestationCommandTimeoutMs, { forcePure, runtimeContext, verifiedPluginPolicy });
  if (forcePure || runtimeContext) return read();
  const key = normalizePathForCompare(path.resolve(cwd || process.cwd()));
  return runSingleFlight(managedSkillDebugFlights, key, read);
}

// Speed-up option 3 (user decision, 2026-09-29): a freshly created, proven-clean worktree holds
// exactly its base tree, and OpenCode's project directory there is the worktree root, so every
// such worktree of one repository attests the same as long as the repository-local OpenCode
// inputs agree (global inputs are in the cache fingerprint). B-164: the key is the repository
// plus a hash of the base tree's entries for those inputs (WORKTREE_OPENCODE_CONFIG_PATHS), not
// the base tree itself: the base tree changed with every auto-integration commit, so the cached
// worktree read missed on almost every job (39 s p50). A failed `git ls-tree` falls back to the
// base-tree key; without a worktree identity the key is the cwd. The final uncached pre-spawn
// attestation in lib/opencode-run.js still runs for every job (before the provider slot request).
function agentMetadataCacheKey(agent, cwd, worktreeIdentity = null) {
  const repoKey = worktreeIdentity?.repoRoot ? attestationCwdKey(worktreeIdentity.repoRoot) : "";
  const place = repoKey && /^[0-9a-f]{64}$/i.test(String(worktreeIdentity.configTreeHash || ""))
    ? `worktree\0${repoKey}\0cfg:${String(worktreeIdentity.configTreeHash).toLowerCase()}`
    : repoKey && /^[0-9a-f]{40,64}$/i.test(String(worktreeIdentity.baseTree || ""))
    ? `worktree\0${repoKey}\0${String(worktreeIdentity.baseTree).toLowerCase()}`
    : attestationCwdKey(cwd);
  return `agent-metadata\0${String(agent)}\0${place}`;
}

// The repository-local files `opencode debug agent` / `debug skill` (and the plugin policy's
// project checks) can read at the worktree root. Bridge children run with
// OPENCODE_DISABLE_PROJECT_CONFIG=true, so most of these are ignored anyway; the list is kept
// conservative. An empty listing (no such files) is a valid, shared key.
const WORKTREE_OPENCODE_CONFIG_PATHS = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md"];

// sha256 of `git ls-tree -r -z <baseTree> -- <config paths>` (modes, blob ids and paths), or ""
// when the tree id is malformed or git fails; the caller then keeps the base-tree key.
async function worktreeConfigTreeHash(repoRoot, baseTree) {
  if (!repoRoot || !/^[0-9a-f]{40,64}$/i.test(String(baseTree || ""))) return "";
  try {
    const listed = await runCommand(
      "git",
      ["ls-tree", "-r", "-z", String(baseTree), "--", ...WORKTREE_OPENCODE_CONFIG_PATHS],
      repoRoot,
      1000 * 15,
      buildValidationEnv({ GIT_OPTIONAL_LOCKS: "0" }),
    );
    if (listed.exitCode !== 0) return "";
    return createHash("sha256").update(String(listed.stdout || "")).digest("hex");
  } catch {
    return "";
  }
}

async function withWorktreeConfigTreeHash(worktreeIdentity) {
  if (!worktreeIdentity?.repoRoot || worktreeIdentity.configTreeHash) return worktreeIdentity;
  const configTreeHash = await worktreeConfigTreeHash(worktreeIdentity.repoRoot, worktreeIdentity.baseTree);
  return configTreeHash ? { ...worktreeIdentity, configTreeHash } : worktreeIdentity;
}

async function readAgentDebugMetadata(agent, cwd, { forcePure = false, runtimeContext = null, verifiedPluginPolicy = null, worktreeIdentity = null } = {}) {
  if (forcePure || runtimeContext) {
    return readAgentDebugMetadataUncached(agent, cwd, { forcePure, runtimeContext, verifiedPluginPolicy });
  }
  // The key costs a git call; skip it when the cache is off (cachedAttestation would ignore it).
  const identity = worktreeIdentity && attestationCacheTtlMs() > 0
    ? await withWorktreeConfigTreeHash(worktreeIdentity)
    : worktreeIdentity;
  return cachedAttestation(
    agentMetadataCacheKey(agent, cwd, identity),
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
  const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, CONFIG.attestationCommandTimeoutMs, { forcePure, runtimeContext, verifiedPluginPolicy: pluginPolicy });
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

const { readAgentDefinition, buildSubagentProxyPrompt, resolveAgent } = createAgentResolutionRuntime({ DEFAULT_SUBAGENT_PROXY_AGENT, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, MCP_SANITIZED_READER_AGENT, OPENCODE_AGENT_DIR, ORCHESTRATOR_AGENT_ALIASES, availableAgentLabels, debugAgentExists, listAvailableAgents, normalizeOrchestratorModeValue: (...args) => normalizeOrchestratorModeValue(...args), sanitizeAgentName });

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

const { callerPathSpellings, pathSpeller, buildCompactPrompt, dependencyRequestPayloadSchema, DEPENDENCY_ABSENT, parseDependencyRequest, openCodePromptArgument, openCodeRunArgs, OPENCODE_WINDOWS_COMMAND_LINE_LIMIT, OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT, openCodeCommandLineLengthError, commandShape, timeoutForAgent, unboundedTimeoutForAgent, isTimeoutResult, applyRateLimitOutcome, rateLimitPauseReason, classifyResultError, createPhaseClock, PHASE_LABELS, formatPhaseTimings } = createOpenCodeCommandRuntime({ CONFIG, DEFAULT_RETURN_FORMAT, OPENCODE_EXE, defaultBuilderTimeoutMs, defaultContractorOrchestratorTimeoutMs, defaultOrchestratorTimeoutMs, defaultReadOnlyAgentTimeoutMs, defaultWriteAgentTimeoutMs, isOrchestratorAgent: (...args) => isOrchestratorAgent(...args), nowMs });

const { runOpenCode, readOnlyResultRetryable, runOpenCodeWithPolicy, readOnlyRetryBudgetExhaustedResult, logOpenCodeResult } = createOpenCodeRunRuntime({ CONFIG, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, OPENCODE_EXE, acquireProviderLease, agentIdleTimeoutForModel, allowlistedModelOverride, applyModelOverrideToMetadata, applyRateLimitOutcome, buildOpenCodeEnv, classifyResultError, clearAgentActivity, combineAbortSignals: (...args) => combineAbortSignals(...args), commandShape, containmentRecord, createIsolatedOpenCodeRuntime, defaultWriteAgentTimeoutMs, delayWithSignal, detectsOpenCodeFallback, effectiveReadOnlyMetadataError, emptyOpenCodeUsage, inspectOpenCodeEventStream, isManagedReadOnlyAgent: (...args) => isManagedReadOnlyAgent(...args), isTimeoutResult, logEvent, maxReadOnlyAgentRetries, mergeHeavyToolCalls, modelPauseKeyForMetadata, noteAgentActivity, nowMs, openCodeCommandLineLengthError, openCodeRunArgs, parseDependencyRequest, providerKeyForMetadata, providerSlotWaitStorage, providerSlotWaitingJobs, quarantineProviderLease, quotaGroupProviderKeys, rateLimitPauseReason, readAgentDebugMetadata, readAgentDebugMetadataUncached, reattestAgentMetadata, recordProviderCooldown, recordRateLimitPause, releaseProviderLease, runSpawnCommand, startProviderLeaseHeartbeat, summarizeStderr, timeoutForAgent, verifyExternalPluginPolicy, wipeIsolatedOpenCodeRuntime, externalRunnerSelection: (...args) => externalRunnerSelection(...args), runExternalCli: (...args) => runExternalCli(...args) });
// Q-012: codex and agy as external runners; inert unless CODEX_OPENCODE_EXTERNAL_RUNNERS lists one.
const { externalRunnerName, externalRunnerSelection, externalRunnerStartupProblems, buildRunnerEnv, resolveRunnerExecutable, verifyRunnerExecutable, runExternalCli, externalRunnerStatusLines, captureTargetState, targetStateChanges } = createExternalRunnersRuntime({ acquireProviderLease, activeModelOverrideAllowlist, agentIdleTimeoutForModel, allowlistedModelOverride, classifyResultError, clearAgentActivity, closeDb, combineAbortSignals: (...args) => combineAbortSignals(...args), CONFIG, containmentRecord, DEFAULT_OPENCODE_CONFIG_DIR, effectiveBridgeStateDirectory, isOrchestratorAgent: (...args) => isOrchestratorAgent(...args), isTimeoutResult, logEvent, modelPauseKeyForMetadata, noteAgentActivity, nowMs, OPENCODE_BASE_ENV_KEYS, openCodeCommandLineLengthError, openCodePromptArgument, openLockDb, parseDependencyRequest, parseModelAllowlistEntry, providerKeyForMetadata, providerSlotWaitingJobs, providerSlotWaitStorage, quarantineProviderLease, quotaGroupProviderKeys, rateLimitPauseReason, recordProviderCooldown, recordRateLimitPause, releaseProviderLease, resolveWindowsNodeShim, runCommand, runGitReadOnlyCommand, runSpawnCommand, SENSITIVE_ENV_PATTERN, sha256File, startProviderLeaseHeartbeat, summarizeStderr, USER_HOME_DIR });

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
// B-103: server.js and the lib/ digest are both compared with their startup values; since the
// split most deploys change lib/ only, so the server hash alone said "same as at startup".
async function bridgeSourceFreshness(serverPath = BRIDGE_SERVER_PATH, startupSha256 = BRIDGE_SOURCE_SHA256, { runtimeDir = BRIDGE_RUNTIME_DIR, startupLibSha256 = BRIDGE_LIB_SHA256_AT_STARTUP } = {}) {
  const base = { startedAt: BRIDGE_PROCESS_STARTED_AT, startupSha256, startupLibSha256 };
  try {
    const onDiskSha256 = createHash("sha256").update(await readFile(serverPath)).digest("hex");
    let onDiskLibSha256 = "";
    let libError = "";
    try {
      onDiskLibSha256 = (await libDigest(runtimeDir))?.sha256 || "";
    } catch (error) {
      libError = error?.message || String(error);
    }
    const libStale = Boolean(startupLibSha256 || onDiskLibSha256) && onDiskLibSha256 !== startupLibSha256;
    return { ...base, onDiskSha256, onDiskLibSha256, libError, serverStale: onDiskSha256 !== startupSha256, libStale, stale: onDiskSha256 !== startupSha256 || libStale, error: "" };
  } catch (error) {
    return { ...base, onDiskSha256: "", onDiskLibSha256: "", libError: "", serverStale: false, libStale: false, stale: false, error: error?.message || String(error) };
  }
}

function bridgeSourceFreshnessLines(freshness) {
  if (freshness.error) return [`Bridge source on disk: unreadable (${freshness.error})`];
  const libLine = freshness.libError
    ? `Bridge lib/ digest on disk: unreadable (${freshness.libError})`
    : `Bridge lib/ digest at startup: ${freshness.startupLibSha256 || "none"}${freshness.libStale ? `; on disk ${freshness.onDiskLibSha256 || "none"} (differs from startup)` : ""}`;
  if (!freshness.stale) return ["Bridge source on disk: same as at startup", libLine];
  const changed = [freshness.serverStale ? "server.js" : "", freshness.libStale ? "lib/" : ""].filter(Boolean).join(" and ");
  return [
    freshness.serverStale ? `Bridge source on disk: ${freshness.onDiskSha256} (differs from startup)` : "Bridge source on disk: same as at startup",
    libLine,
    `Warning: ${changed} changed after this bridge process started (${freshness.startedAt}); this process still runs the old code. Restart the client that launched it (quit Claude fully, not just the window, or start a new Claude Code session; restart Codex) so it launches the current bridge.`,
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

const { integratePatchSerially, recoverIntegrationRepositorySerially, INTEGRATION_QUARANTINE_RESOLUTION_MODES, verifyQuarantinedOperationRestored, integrationQuarantineOperator, resolveIntegrationQuarantine, formatIntegrationQuarantineResolution } = createIntegrationSerialRuntime({ CONFIG, DEFAULT_LOCK_TTL_MS, INTEGRATION_RECOVERY_BLOCKED_ROOTS, INTEGRATION_RESOLVED_STATUSES, abortSignalErrorType: (...args) => abortSignalErrorType(...args), acquireHardLock: (...args) => acquireHardLock(...args), cleanupIntegratedBatchWorktreesWhileLocked: (...args) => cleanupIntegratedBatchWorktreesWhileLocked(...args), cleanupIntegratedWorktreeWhileLocked: (...args) => cleanupIntegratedWorktreeWhileLocked(...args), closeDb, conflictPathsFromConflict, exactIntegrationFileSnapshot, integratePatchWithoutSerialLock: (...args) => integratePatchWithoutSerialLock(...args), integrationJournalDiagnosis, integrationRecoveryBaseline, integrationRecoveryErrorText, logEvent, openLockDb, readIntegrationJournalFileEvidence, readIntegrationOperationSummary, recoverIntegrationOperationsWhileLocked, releaseHardLock: (...args) => releaseHardLock(...args), runCommand, startHardLockHeartbeat: (...args) => startHardLockHeartbeat(...args), transitionIntegrationOperation, truncateText });

const { integratePatchWithoutSerialLock, integrationCleanupTargetStateError, cleanupIntegratedWorktreeWhileLocked, cleanupIntegratedBatchWorktreesWhileLocked, recordChangedFiles, getIntegrationScratchCleanupTestHook, setIntegrationScratchCleanupTestHook } = createIntegrationApplyRuntime({ CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, abortSignalErrorType: (...args) => abortSignalErrorType(...args), applyPatchFile, captureGitHead, captureGitIndexIdentity, captureIntegrationTargetState, capturePatchedPathsState, captureRollbackBaseline, changedFileValidationErrorType, changedFilesBetween, changedPathSetEvidence, checkPatchApplies, cleanupWorktree, closeDb, collectIntegrationBatchPatch, collectIntegrationPatch, exactIntegrationFileSnapshot, filterGeneratedWorktreeFiles, gitChangedFileSnapshot, gitChangedFiles, gitIndexPathSnapshot, inspectRepositoryOperationState, integrationContentMismatches, integrationPreviewReceiptError, integrationRecoveryErrorText, isolatedIndexPreservationEvidence, loadProjectAgentPolicy, logEvent, makeIntegrationPreviewReceipt, openLockDb, prepareIntegrationOperation, quarantineIntegrationOperation, recoverIntegrationOperationsWhileLocked, rollbackVerifiedOwnedChanges, runCommand, runValidationGate, simulateIntegrationPatchSnapshot, snapshotMismatches, transitionIntegrationOperation, validateChangedFilesForPlan, writeTemporaryPatchFile });

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

const { reconcileStaleQueueRecords, releaseQueueJobLocks, processIsAlive, renewPersistedQueueRecordLease, QUEUE_PRE_EXECUTION_STATUSES, reacquirePersistedQueueRecordLease, queueOwnershipLossError, clearQueueLeaseFence, loseQueueOwnership, resetQueueLeaseFence, noteQueueLeaseRenewalFailure, assertQueueRecordDurableOwnership, renewQueueRecordDurableOwnership, heartbeatKnownQueueState, ensureQueueHeartbeatTimer, pruneInMemoryState, sqliteUsedBytes, stateCapacityError, prunePersistedState, maintainKnownStateDatabases, ensureStateMaintenanceTimer } = createQueueLeaseRuntime({ BRIDGE_INSTANCE_ID, CONFIG, KNOWN_STATE_DB_PATHS, PIPELINE_RUNS, QUEUE_JOBS, closeDb, effectiveQueueMode, expireLocksFromDb, foreignQueueWorkerPresence: (dbPath) => foreignQueueWorkerPresence(dbPath), logEvent, openLockDb, propagatePipelineTerminalInTransaction, scheduleQueueRetryPolicy: (...args) => scheduleQueueRetryPolicy(...args), stateDbPath, statePruneTimes });


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

const { directRunAuditStore, abortSignalErrorType, combineAbortSignals, validateDelegationPlanInputs, findActiveLockConflict, formatDelegationPlanJob } = registerLockAndStatusTools({ BRIDGE_INSTANCE_ID, BRIDGE_PROCESS_STARTED_AT, BRIDGE_RUNTIME_DIR, BRIDGE_SOURCE_SHA256, CONFIG, DEFAULT_LOCK_TTL_MS, DEFAULT_SUBAGENT_PROXY_AGENT, GLOBALLY_REQUIRED_MANAGED_AGENTS, GLOBAL_BRIDGE_STATE_DIR, MAX_LOCK_TTL_MS, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, MCP_SANITIZED_READER_AGENT, OPENCODE_AGENT_DIR, OPENCODE_EXE, OPENCODE_SKILL_DIR, QUEUE_JOBS, VALIDATION_PREFLIGHT_FIX, acquireHardLock, agentIdleTimeoutStatusLine, agentMetadataPolicyOptions, allowlistedModelOverride, applyModelOverrideToMetadata, assessQueuePlan, attestContractorNestedAgents, availableAgentLabels, bridgeSourceFreshness, bridgeSourceFreshnessLines, clearAttestationCache, closeDb, commandShape, compactQueueJobLines: (...args) => compactQueueJobLines(...args), conflictPathsFromConflict, conflictsWithActiveLock, contractorAuthorizationToken: (...args) => contractorAuthorizationToken(...args), decryptIntegrationJournalBytes, describeConcurrencyLimits, diagnoseJobView: (...args) => diagnoseJobView(...args), dirtyCheckpointDetails, effectiveContractorAuthorizationSha256: (...args) => effectiveContractorAuthorizationSha256(...args), effectiveQueueMode, effectiveQueueWriteConflictPolicy, effectiveReadOnlyMetadataError, encryptIntegrationJournalBytes, enqueueQueueJob, executeOpenCodeJob: (...args) => executeOpenCodeJob(...args), formatAgentLockList, formatLockExpiry, formatRejectedExecution, hardLockPathsForPlan, integrationJournalDiagnosis, jobAgentRuntime: (...args) => jobAgentRuntime(...args), jobInputShape, listAvailableAgents, listLocks, listPersistedPipelineRecords: (...args) => listPersistedPipelineRecords(...args), listPersistedQueueRecords: (...args) => listPersistedQueueRecords(...args), listRetainedWorktreeArtifacts: (...args) => listRetainedWorktreeArtifacts(...args), makeQueueJobId, managedSkillSourceEvidence, normalizeJobCwd, nowMs, openLockDb, parallelBatchCapacityError: (...args) => parallelBatchCapacityError(...args), parallelProviderKeys: (...args) => parallelProviderKeys(...args), pipelineOwnedByThisInstance: (...args) => pipelineOwnedByThisInstance(...args), providerCapacitySnapshot, queueAgentActivity, queueCapacityReport, queueMemoryGate, queueMemoryStatusLines, queueMemoryWaitingJobs, queueOnlyOptionsError: (...args) => queueOnlyOptionsError(...args), queueRecordSnapshot: (...args) => queueRecordSnapshot(...args), readAgentDebugMetadata, readOnlyRoutingPolicyError: (...args) => readOnlyRoutingPolicyError(...args), recordMatchesProject, refreshRuntimeConcurrency, releaseHardLock, reservedLockAgentError, resolveProjectStateRoot, retainedWorktreeView: (...args) => retainedWorktreeView(...args), runCommand, safeOpenCodeCommand, sanitizedAgentMetadataError, sanitizedDiscoveryContext: (...args) => sanitizedDiscoveryContext(...args), sanitizedRoutingPolicyError, sanitizedWorkspaceSchema, server, summarizeStderr, timeoutForAgent, userAuthorizedOrchestrator: (...args) => userAuthorizedOrchestrator(...args), validateParallelWritePlan: (...args) => validateParallelWritePlan(...args), validateSingleLockPlan: (...args) => validateSingleLockPlan(...args), validationCommandPreflightError, verifyExternalPluginPolicy, verifyJobWorkspaceReadiness, verifySanitizedJobsBeforeDiscovery: (...args) => verifySanitizedJobsBeforeDiscovery(...args), verifySanitizedWorkspace, externalRunnerStatusLines: (...args) => externalRunnerStatusLines(...args) });

const { listRetainedWorktreeArtifacts, QUEUE_JOB_RUNNING_STATUSES, retainedWorktreeView, directRunView, diagnoseJobView, ESSENTIAL_QUEUE_JOB_FIELDS, essentialQueueJobView, queueTimedOutWriterNote, compactQueueJobLines, formatToolRefusal, formatConcurrencyChange } = registerJobTools({ BRIDGE_INSTANCE_ID, CONFIG, MAX_GLOBAL_WORKER_LIMIT, MAX_RUNTIME_CONCURRENCY_LIMIT, QUEUE_JOBS, RETAINED_WORKTREE_STATUSES, assessQueuePlan, authoritativeQueueRecord: (...args) => authoritativeQueueRecord(...args), cancelPersistedQueueJob: (...args) => cancelPersistedQueueJob(...args), closeDb, describeConcurrencyLimits, directRunAuditStore, effectiveBridgeStateDirectory, effectiveQueueMode, formatIdleDuration, formatOpenCodeUsage, logEvent, nowMs, openLockDb, pauseProvider, persistQueueRecord: (...args) => persistQueueRecord(...args), processIsAlive, queueAgentActivity, queueRecordSnapshot: (...args) => queueRecordSnapshot(...args), queueRunStage, readPersistedQueueRecord: (...args) => readPersistedQueueRecord(...args), reconcileParentPipelineAfterQueueTerminal: (...args) => reconcileParentPipelineAfterQueueTerminal(...args), reconcileStaleQueueRecords, recordMatchesProject, requeueQueueJob: (...args) => requeueQueueJob(...args), resolveProjectStateRoot, resumeProvider, scheduleQueue: (...args) => scheduleQueue(...args), server, setRuntimeConcurrency, timedOutWriterNote });

registerPipelineTools({ INTEGRATION_QUARANTINE_RESOLUTION_MODES, OPERATOR_CLI_ENV, PIPELINE_RUNS, VALIDATION_PREFLIGHT_FIX, activatePipelineBatch, authoritativePipelineRecord: (...args) => authoritativePipelineRecord(...args), claimPersistedPipeline: (...args) => claimPersistedPipeline(...args), createPipelinePlan: (...args) => createPipelinePlan(...args), effectiveQueueMode, enqueueQueueJob, finalizePipelineRecord: (...args) => finalizePipelineRecord(...args), formatIntegrationQuarantineResolution, formatRejectedExecution, listPersistedPipelineRecords: (...args) => listPersistedPipelineRecords(...args), loadProjectAgentPolicy, normalizeJobCwd, persistPipelineRecord: (...args) => persistPipelineRecord(...args), pipelineOwnedByThisInstance: (...args) => pipelineOwnedByThisInstance(...args), pipelineOwnerRejection: (...args) => pipelineOwnerRejection(...args), readPersistedPipelineChildren: (...args) => readPersistedPipelineChildren(...args), recordMatchesProject, refreshPipelineRecord: (...args) => refreshPipelineRecord(...args), resolveIntegrationQuarantine, resolveProjectStateRoot, sanitizedWorkspaceSchema, scheduleQueue: (...args) => scheduleQueue(...args), server, updatePipelineRecord: (...args) => updatePipelineRecord(...args), validationCommandPreflightError, verifySanitizedWorkspace });

const { hasWriteIntent, isOrchestratorAgent, isManagedReadOnlyAgent, readOnlyRoutingPolicyError, requestedOrchestratorMode, normalizeOrchestratorModeValue, userAuthorizedOrchestrator, contractorAuthorizationToken, effectiveContractorAuthorizationSha256, internalQueueContractorBinding, currentContractorAuthorizationSha256, makeInternalQueueContractorProof, internalQueueContractorProofValid, contractorAuthorizationValid, hasOrchestratorBoundedWriterShape, normalizeOrchestratorMode, detectsOrchestratorInternalWriterRequest, detectsLargeOrchestratorTask, detectsPlanningIntent, findOrchestratorGlobalFileMatches, orchestratorPolicyError, getSelfTestContractorAuthorizationSha256, setSelfTestContractorAuthorizationSha256 } = createOrchestratorPolicyRuntime({ CONFIG, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, ORCHESTRATOR_AGENT_ALIASES, QUEUE_CAPABILITY_KEY, READ_ONLY_PARALLEL_AGENTS, WRITE_CAPABLE_AGENTS });

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
  providerLimitForKey,
});

const { sanitizedDiscoveryContext, verifySanitizedJobsBeforeDiscovery, parallelProviderKeys, jobAgentRuntime, getAgentRuntimeTestHook, setAgentRuntimeTestHook } = createJobDiscoveryRuntime({ allowlistedModelOverride, applyModelOverrideToMetadata, providerKeyForMetadata, readAgentDebugMetadata, resolveAgent, runOpenCodeWithPolicy, verifySanitizedWorkspace });

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

// Q-015: `unowned: true` (queue-worker.js --add) persists the row with no owner and no lease and
// keeps it out of this process: the running queue worker of the repository adopts it in its next
// recovery pass (an empty lease and owner are adoptable at once). Durable (sqlite) queue only.
async function enqueueQueueJob(job, parentJobId = "", { schedule = true, initialStatus = "pending", persist = true, recordFields = null, unowned = false } = {}) {
  if (unowned && effectiveQueueMode() !== "sqlite") {
    return {
      ok: false,
      errorType: "queue_worker_needs_sqlite",
      error: `A job for a running queue worker needs CODEX_OPENCODE_QUEUE_MODE=sqlite (it is ${effectiveQueueMode()}).`,
      suggestedFix: "Run queue-worker.js --add with the environment of the worker (--env-from codex or claude).",
    };
  }
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
  if (unowned) {
    Object.assign(record, { ownerInstanceId: "", ownerProcessId: 0, ownerGeneration: "", heartbeatAt: "", leaseExpiresAt: "" });
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
  // Q-015: the running worker adopts an unowned row; this process neither tracks nor starts it.
  if (unowned) return { ok: true, record, unowned: true };
  QUEUE_JOBS.set(jobId, record);
  if (schedule) {
    scheduleQueue();
  }
  return { ok: true, record };
}











// Active pauses by key (until, epoch ms), from the shared provider database.
// B-132: an unreadable provider database throws (providerCapacitySnapshot reports ok: false with no
// cooldowns): an empty map read as "nothing is paused", released every pause-wait and let the retry
// chooser pick paused models. Every caller fails closed on the throw.
async function activeProviderPauses() {
  const snapshot = await providerCapacitySnapshot();
  if (!snapshot?.ok) throw new Error(`The provider pauses could not be read: ${snapshot?.error || "provider database unavailable"}`);
  const pauses = new Map();
  for (const item of snapshot.cooldowns || []) {
    if (Number(item.remainingMs) > 0) pauses.set(item.providerKey, Date.parse(item.until));
  }
  return pauses;
}





// Self-test only: stands in for CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED (CONFIG is frozen).
let autoResumeInterruptedOverride = null;

const { autoIntegrateJobError, AUTO_INTEGRATION_CHAINS, AUTO_INTEGRATION_WAITING, AUTO_INTEGRATION_RETRYABLE_ERRORS, AUTO_INTEGRATION_LATER_ERRORS, AUTO_INTEGRATION_ROUNDS, AUTO_INTEGRATION_LATER_MAX, AUTO_INTEGRATION_HEAD_RETRIES, autoIntegrationLaterDelayMs, AUTO_INTEGRATION_EMPTY_INDEX_RETRIES, autoIntegrationCommitHooks, AUTO_INTEGRATION_FINAL_STATUSES, AUTO_INTEGRATION_CLAIM_STALE_MS, autoIntegrationClaimerGone, autoIntegrateQueueJob, AUTO_INTEGRATION_RESCHEDULED, rescheduleOpenAutoIntegrations, scheduleAutoIntegration, sweepCommittedWorktrees, autoIntegrationTestHooks } = createAutoIntegrationRuntime({ BRIDGE_INSTANCE_ID, CONFIG, RepositoryRootSet, cleanupWorktree, decryptQueueRequest, delayWithSignal, effectiveQueueMode, integratePatchSerially, logEvent, patchTerminalQueueSummary: (...args) => patchTerminalQueueSummary(...args), processIsAlive, resolveProjectStateRoot, runCommand });


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
  quotaGroupProviderKeys,
  resolveProjectStateRoot,
  decryptQueueRequest,
  getAutoResumeInterruptedOverride: () => autoResumeInterruptedOverride,
  logEvent,
  jobInputShape,
  recordMatchesProject,
  processIsAlive,
  enqueueQueueJob,
});

const { QUEUE_RETRYABLE_LOCK_ERROR_TYPES, QUEUE_TERMINAL_COMMIT_ATTEMPTS, queueBlockedBackoffPatch, reacquireQueueRecordLease, updateQueueRecordDurableReacquiringLease, queueRecordOwnedElsewhere, commitQueueTerminalRecord, blockQueueRecordAfterLockRefusal, startQueueRecord, queueFailureReason, getQueueJobExecutorTestHook, setQueueJobExecutorTestHook } = createQueueStartRuntime({ externalRunnerName, BRIDGE_INSTANCE_ID, CONFIG, QUEUE_ACTIVE_STATUSES, QUEUE_TERMINAL_STATUSES, abandonLocalQueueWorker, assertQueueRecordDurableOwnership, changedFileValidationErrorType, claimQueueRecord, clearQueueLeaseFence, closeDb, delayWithSignal, effectiveQueueMode, effectiveQueueWriteConflictPolicy, executeOpenCodeJob, findQueueWriteConflict, handleQueueWorkerInfrastructureFailure, logEvent, loseQueueOwnership, nowMs, openLockDb, providerSlotWaitStorage, queueOwnershipLossError, reacquirePersistedQueueRecordLease, reconcileParentPipelineAfterQueueTerminal: (...args) => reconcileParentPipelineAfterQueueTerminal(...args), renewQueueRecordDurableOwnership, resetQueueLeaseFence, scheduleAutoIntegration, scheduleQueue: (...args) => scheduleQueue(...args), scheduleQueueRetryPolicy, summarizeStderr, superviseQueueWorker, timedOutWriterEvidence, timedOutWriterNote, truncateText, updateQueueRecordDurable, updateQueueTerminalRecordDurable });

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

const { pauseWaitCheckedAt, pauseWaitCandidates, releaseResumedPauseWaits, queueWakeAt, queueSchedulerRunning, queueScheduleRequested, scheduleQueue } = createQueueSchedulerRuntime({ CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, QUEUE_JOBS, activeProviderPauses, effectiveQueueMode, effectiveQueueWriteConflictPolicy, findQueueWriteConflict, holdQueueForMemory, logEvent, modelPauseKeyForMetadata, nextQueueScheduleDelay, parseModelAllowlistEntry, providerKeyForMetadata, quotaGroupProviderKeys, queueDrainRequested, queueMemoryGate, queueRecordOwnedElsewhere, refreshRuntimeConcurrency, releaseQueueMemoryHold, runningQueueRecords, startQueueRecord, updateQueueRecordDurable, updateQueueRecordDurableReacquiringLease });

const { makePipelineId, pipelinePrivateDetails, pipelineRecordDurableSummary, encryptPipelinePrivateDetails, decryptPipelinePrivateDetails, pipelineOwnedByThisInstance, claimPersistedPipeline, pipelineOwnerRejection, enqueuePipelinePersistence, writePipelineRecordSnapshot, persistPipelineRecord, PIPELINE_INTEGRATION_CLOSED_STATUSES, updatePipelineRecord, reconcilePipelineIntegrationOperationStates, readPersistedPipelineRecord, listPersistedPipelineRecords, authoritativePipelineRecord, readPersistedPipelineChildren, pipelineJobStatus, mergePipelineIntegrationQueue, refreshPipelineRecord, reconcileParentPipelineAfterQueueTerminal, trackedTargetStateSha256 } = createPipelineStoreRuntime({ BRIDGE_INSTANCE_ID, CONFIG, PIPELINE_PERSISTENCE_CHAINS, PIPELINE_RUNS, QUEUE_JOBS, closeDb, decryptIntegrationJournalBytes, decryptQueueRequest, effectiveQueueMode, encryptIntegrationJournalBytes, encryptQueueRequest, formatRejectedExecution, getPipelinePersistenceTestHook: () => pipelinePersistenceTestHook, logEvent, openLockDb, persistedQueueRecordFromRow, queueRecordSnapshot, readIntegrationOperationSummary, readPersistedQueueRecord, recordMatchesProject, safeNamePart, stateCapacityError });

const { formatIntegrationBatchSummary } = registerIntegrationTools({ INTEGRATION_BATCH_MAX_ITEMS, PIPELINE_INTEGRATION_CLOSED_STATUSES, PIPELINE_RUNS, authoritativePipelineRecord, claimPersistedPipeline, formatIntegrationTargetMove, formatIntegrationTimings, formatRejectedExecution, integratePatchSerially, integrationTimingStorage, isBridgeGeneratedWorktree, loadProjectAgentPolicy, nowMs, pipelineOwnedByThisInstance, pipelineOwnerRejection, reconcilePipelineIntegrationOperationStates, refreshPipelineRecord, resolveProjectStateRoot, server, updatePipelineRecord });

const { PIPELINE_TERMINAL_GATE_ERROR_TYPES, PIPELINE_TERMINAL_FINAL_VALIDATION_ERROR_TYPES, deferPipelineFinalization, PIPELINE_GATE_VERDICT_INSTRUCTION, PIPELINE_GATE_VERDICT_LINE, parsePipelineGateVerdict, PIPELINE_GATE_VERDICT_ERROR_TYPES, runPipelineReadOnlyGate, cleanupAuthorizationMatchesItem, finalizePipelineSourceCleanup, resumeAuthorizedPipelineCleanup, FINALIZING_PIPELINE_IDS, finalizePipelineRecord, finalizePipelineRecordUnderLease, finalizePipelineRecordWhileLocked, getPipelineGateExecutorTestHook, setPipelineGateExecutorTestHook } = createPipelineFinalizeRuntime({ CONFIG, DEFAULT_LOCK_TTL_MS, PIPELINE_INTEGRATION_CLOSED_STATUSES, abortSignalErrorType, acquireHardLock, captureIntegrationTargetState, changedFileValidationErrorType, changedFilesBetween, cleanupWorktree, collectIntegrationPatch, combineAbortSignals, conflictPathsFromConflict, conflictsWithActiveLock, executeOpenCodeJob, gitChangedFileSnapshot, isManagedReadOnlyAgent, listLocks, loadProjectAgentPolicy, nowMs, reconcilePipelineIntegrationOperationStates, refreshPipelineRecord, releaseHardLock, resolveProjectStateRoot, runCommand, runValidationGate, startHardLockHeartbeat, trackedTargetStateSha256, truncateResultText, updatePipelineRecord, verifySanitizedWorkspace });

const { createPipelinePlan, verifyParallelLockResults, settleIndependentParallelJobs, PARALLEL_GROUP_DEADLINE_MARGIN_MS, parallelGroupDeadlineMs, parallelGroupScopeReport, parallelExecutionOverlapEvidence, labelParallelRunId } = createParallelPlanRuntime({ BRIDGE_INSTANCE_ID, CONFIG, captureGitHead, changedFilesBetween, gitChangedFileSnapshot, isManagedReadOnlyAgent, makePipelineId, readOnlyHeadMove, readOnlyWorkspaceDrift, scopeChangedFileViolations, timeoutForAgent, validateDelegationPlanInputs });

registerParallelTool({ CONFIG, DEFAULT_SUBAGENT_PROXY_AGENT, VALIDATION_PREFLIGHT_FIX, acquireHardLock, agentMetadataPolicyOptions, applyGitControlSurfaceCheck, buildCompactPrompt, buildSubagentProxyPrompt, callerPathSpellings, captureGitHead, changedFilesBetween, changedPathSetEvidence, cleanupWorktree, collectWorktreeDiff, compactFileList, compactJobLines, conflictPathsFromConflict, createPhaseClock, createWorktreeForJob, directRunAuditStore, dirtyCheckpointDetails, effectiveReadOnlyMetadataError, fitRedactedJobResult, formatReadOnlyWorkspaceDrift, formatRejectedExecution, formatSingleResultParts, formatWorktreeSummary, gitChangedFileSnapshot, gitControlSurfaceFingerprint, hardLockPathsForPlan, hardLockSummary, hardLockTtlForPlan, inspectSourceCheckpointState, jobAgentRuntime, jobInputShape, labelParallelRunId, makeQueueJobId, normalizeJobCwd, nowMs, parallelBatchCapacityError, parallelExecutionOverlapEvidence, parallelGroupDeadlineMs, parallelGroupScopeReport, parallelProviderKeys, readAgentDefinition, readOnlyEditsDeniedByAttestation, readOnlyHeadMove, readOnlyRoutingPolicyError, readOnlyWorkspaceDrift, refreshRuntimeConcurrency, releaseHardLock, runValidationGate, sanitizedAgentMetadataError, sanitizedDiscoveryContext, sanitizedRoutingPolicyError, server, settleIndependentParallelJobs, shouldUseWorktree, startHardLockHeartbeat, validateChangedFilesForPlan, validateParallelWritePlan, validationCommandPreflightError, verifyJobWorkspaceReadiness, verifyParallelLockResults, verifySanitizedWorkspace });

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const { listReleaseFiles, verifyReleaseManifest, releaseManagedSourcePathError, immutableReleasePluginModeError, verifyReleaseIntegrity } = createReleaseIntegrityRuntime({ BRIDGE_RUNTIME_DIR, BRIDGE_SERVER_PATH, CONFIG, DEFAULT_OPENCODE_CONFIG_DIR, OPENCODE_AGENT_DIR, OPENCODE_SKILL_DIR, RELEASE_REQUIRED_MANAGED_AGENTS, REQUIRED_MANAGED_SKILLS, sha256File });

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


















// Q-012: an allowlist entry naming a runner that is not enabled, or an enabled runner whose name the
// managed OpenCode config also defines as a provider, stops the start (like the plugin policy).
async function assertExternalRunnerConfig() {
  const problems = await externalRunnerStartupProblems();
  if (!problems.length) return;
  throw Object.assign(new Error(`External runner configuration rejected startup (${problems[0].errorType}): ${problems.map((item) => item.error).join(" ")}`), { errorType: problems[0].errorType });
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
  await assertExternalRunnerConfig();
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
      // B-126: kept through the terminal write, so the record tells --now from cancel_opencode_job.
      cancellationReason: reason,
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
// Q-015: `repo` names the worker's repository explicitly (queue-worker.js --add runs in a short
// process that is no worker itself); it defaults to this process's own worker repository.
async function checkQueueWorkerJob(job, { repo = queueWorkerMode?.repo } = {}) {
  if (!repo) return { ok: false, errorType: "queue_worker_not_started", error: "The queue worker is not started." };
  if (effectiveQueueMode() !== "sqlite") {
    return { ok: false, errorType: "queue_worker_needs_sqlite", error: `The queue worker runs durable jobs only: CODEX_OPENCODE_QUEUE_MODE must be sqlite (it is ${effectiveQueueMode()}).` };
  }
  if (!path.isAbsolute(String(job?.cwd || ""))) return { ok: false, errorType: "queue_worker_invalid_job", error: "cwd must be an absolute path." };
  const normalized = await normalizeJobCwd(job);
  if (RepositoryRootSet.key(normalized.cwd) !== RepositoryRootSet.key(repo)) {
    return { ok: false, errorType: "queue_worker_wrong_repository", error: `cwd ${job.cwd} is not in the worker's repository ${repo}; start a worker per repository.` };
  }
  const prepared = await enqueueQueueJob(job, "", { persist: false, schedule: false });
  if (!prepared.ok) return { ok: false, errorType: prepared.errorType || "queue_rejected", error: prepared.error || "The job was refused.", suggestedFix: prepared.suggestedFix || "" };
  const db = await openLockDb(repo);
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

// Q-015: `unowned` (with `repo`) enqueues for the worker running in another process (--add).
async function enqueueFromToolInput(job, { repo, unowned = false } = {}) {
  const checked = await checkQueueWorkerJob(job, { repo });
  if (!checked.ok) return checked;
  // schedule: false: the worker releases all starts at once after the last line.
  return await enqueueQueueJob(job, "", { schedule: false, unowned });
}

// Jobs this worker enqueued from a file it then refused: cancelled before anything started, so the
// refusal leaves no half batch behind (requeue_opencode_job can still run them).
// Q-015: with `repo`, a job this process does not hold (an unowned row --add wrote for the running
// worker) is cancelled in the database: a pending row at once, one the worker already started
// gets a cancellation request (cancel_opencode_job's durable path).
async function cancelUnstartedQueueJobs(jobIds, reason, { repo = "" } = {}) {
  const cancelled = [];
  const durable = [];
  for (const jobId of jobIds) {
    const record = QUEUE_JOBS.get(jobId);
    if (!record && repo) durable.push(jobId);
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
  if (durable.length) {
    const db = await openLockDb(repo);
    try {
      for (const jobId of durable) {
        const outcome = await cancelPersistedQueueJob(db, jobId);
        if (outcome?.ok && ["cancelled", "cancellation_requested"].includes(outcome.outcome)) cancelled.push(jobId);
      }
    } finally {
      closeDb(db);
    }
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

// B-124: an exit code whose stop the queue worker already logged (queue_worker.stopped after a
// third Ctrl+C) is not logged again as a process.exited error.
function suppressQueueWorkerExitLog(code) {
  processExitLogSuppressedCode = code;
}

// B-127: retries the retry policy deferred because the interrupted run's child was still alive
// (requeue_orphan_child_alive, marked retryDeferredAt). Once that child is gone the policy runs
// again, once per job and process; true while such a child still lives, so the unchanged-file memo
// keeps this database in the pass (a process ending does not touch the database file).
const QUEUE_DEFERRED_RETRIES_SCHEDULED = new Set();
function retryDeferredByOrphans(db) {
  let waiting = false;
  const rows = db.prepare(`
    SELECT job_id, cwd, record_json FROM opencode_jobs
    WHERE status = 'interrupted' AND request_encrypted IS NOT NULL AND request_encrypted <> ''
      AND json_valid(record_json)
      AND COALESCE(json_extract(record_json, '$.retryDeferredAt'), '') <> ''
      AND COALESCE(json_extract(record_json, '$.requeuedAs'), '') = ''
      AND COALESCE(json_extract(record_json, '$.completionOutcome'), '') <> 'gave_up'
  `).all();
  for (const row of rows) {
    if (QUEUE_DEFERRED_RETRIES_SCHEDULED.has(row.job_id)) continue;
    let summary = {};
    try { summary = JSON.parse(row.record_json || "{}"); } catch { continue; }
    if (summary.orphanChildProcessAlive && processIsAlive(Number(summary.orphanChildProcessId || 0))) {
      waiting = true;
      continue;
    }
    QUEUE_DEFERRED_RETRIES_SCHEDULED.add(row.job_id);
    scheduleQueueRetryPolicy(row.cwd || summary.cwd || "", row.job_id);
  }
  return waiting;
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
      if (retryDeferredByOrphans(db)) dbPending = true;
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
    worktreeConfigTreeHash,
    withWorktreeConfigTreeHash,
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
    reattestAgentMetadata,
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
    formatWorktreeSummary,
    releaseQueueJobLocks,
    sweepCommittedWorktrees,
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
    wrapToolHandler,
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
    // tests/review-flex-runners.js (Q-012)
    externalRunnerName,
    externalRunnerSelection,
    externalRunnerStartupProblems,
    buildRunnerEnv,
    resolveRunnerExecutable,
    verifyRunnerExecutable,
    runExternalCli,
    externalRunnerStatusLines,
    captureTargetState,
    targetStateChanges,
    providerLimitForKey,
    runOpenCodeWithPolicy,
    // B-131..B-134, Q-014.
    quotaGroupProviderKeys,
    perProviderLimitEntries,
    runtimeProviderLimitsError,
    activeProviderPauses,
    releaseResumedPauseWaits,
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
    get selfTestContractorAuthorizationSha256() { return getSelfTestContractorAuthorizationSha256(); },
    set selfTestContractorAuthorizationSha256(value) { setSelfTestContractorAuthorizationSha256(value); },
    get selfTestModelOverrideAllowlist() { return selfTestModelOverrideAllowlist; },
    set selfTestModelOverrideAllowlist(value) { selfTestModelOverrideAllowlist = value; },
    get stateDirectoryOverride() { return stateDirectoryOverride; },
    set stateDirectoryOverride(value) { stateDirectoryOverride = value; },
    get worktreeCleanupTestHook() { return worktreeTestHooks.cleanup; },
    set worktreeCleanupTestHook(value) { worktreeTestHooks.cleanup = value; },
    get worktreeCreateTestHook() { return worktreeTestHooks.create; },
    set worktreeCreateTestHook(value) { worktreeTestHooks.create = value; },
    get autoIntegrationTestHooks() { return autoIntegrationTestHooks; },
    get integrationScratchCleanupTestHook() { return getIntegrationScratchCleanupTestHook(); },
    set integrationScratchCleanupTestHook(value) { setIntegrationScratchCleanupTestHook(value); },
    get pipelineGateExecutorTestHook() { return getPipelineGateExecutorTestHook(); },
    set pipelineGateExecutorTestHook(value) { setPipelineGateExecutorTestHook(value); },
    get queueJobExecutorTestHook() { return getQueueJobExecutorTestHook(); },
    set queueJobExecutorTestHook(value) { setQueueJobExecutorTestHook(value); },
    get queuePersistTestHook() { return queuePersistTestHook; },
    set queuePersistTestHook(value) { queuePersistTestHook = value; },
    get bridgeStartupRecovery() { return bridgeStartupRecovery; },
    set bridgeStartupRecovery(value) { bridgeStartupRecovery = value; },
    get agentRuntimeTestHook() { return getAgentRuntimeTestHook(); },
    set agentRuntimeTestHook(value) { setAgentRuntimeTestHook(value); },
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
  suppressExitLog: suppressQueueWorkerExitLog,
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
  await assertExternalRunnerConfig();
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
