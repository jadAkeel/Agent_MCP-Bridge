// Bridge configuration and explicit process-local initialization.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { homedir, tmpdir, totalmem } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { readPositiveIntEnv, readNonNegativeIntEnv, readStrictPositiveIntEnv, readModelDurationMapEnv, readCsvEnv, readChoiceEnv } from "./env.js";

// Called by the composition root at the original configuration initialization point.
export function createBridgeConfig() {
const USER_HOME_DIR = homedir();
const DEFAULT_OPENCODE_CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
  : path.join(USER_HOME_DIR, ".config", "opencode");
const DEFAULT_OPENCODE_DATA_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, "opencode")
  : path.join(USER_HOME_DIR, ".local", "share", "opencode");
const DEFAULT_OPENCODE_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(USER_HOME_DIR, ".cache");
const DEFAULT_OPENCODE_STATE_HOME = process.env.XDG_STATE_HOME || path.join(USER_HOME_DIR, ".local", "state");
const CODEX_STATE_HOME = String(process.env.CODEX_HOME || path.join(USER_HOME_DIR, ".codex")).trim();
const OPENCODE_EXE = String(
  process.env.CODEX_OPENCODE_EXECUTABLE || process.env.OPENCODE_EXE || "opencode"
).trim() || "opencode";
const OPENCODE_AGENT_DIR = path.resolve(
  String(process.env.CODEX_OPENCODE_AGENT_DIR || path.join(DEFAULT_OPENCODE_CONFIG_DIR, "agents")).trim()
);
const OPENCODE_SKILL_DIR = path.resolve(
  String(process.env.CODEX_OPENCODE_SKILL_DIR || path.join(DEFAULT_OPENCODE_CONFIG_DIR, "skills")).trim()
);
const MCP_ORCHESTRATOR_AGENT = String(
  process.env.CODEX_OPENCODE_MCP_ORCHESTRATOR_AGENT || "opencode-orchestrator-mcp-planner"
).trim() || "opencode-orchestrator-mcp-planner";
const MCP_CONTRACTOR_ORCHESTRATOR_AGENT = String(
  process.env.CODEX_OPENCODE_MCP_CONTRACTOR_ORCHESTRATOR_AGENT || "opencode-orchestrator-mcp-contractor"
).trim() || "opencode-orchestrator-mcp-contractor";
const STANDALONE_ORCHESTRATOR_AGENT = "opencode-orchestrator-standalone";
const MCP_SANITIZED_READER_AGENT = "mcp-sanitized-reader";
const MCP_SANITIZED_READER_PROFILE = Object.freeze({
  mode: "all",
  provider: "openai",
  model: "gpt-5.6-terra",
  variant: "high",
});
const MCP_SANITIZED_READER_PROMPT = [
  "You are the bridge-managed reader for manifest-pinned sanitized workspaces.",
  "",
  "Use only built-in in-workspace read, glob, grep, and reasoning capabilities. Do not edit files, delegate tasks, invoke a shell, use network tools, or access paths outside the exact workspace root except OpenCode's unique bridge-isolated tool-output and temporary scratch directories. Never access the original repository or shared user data. If the task cannot be completed within those boundaries, stop and report the missing capability.",
  "",
  "Report the files inspected, conclusions, assumptions, and any evidence that could not be obtained within the sanitized boundary.",
].join("\n");
const MCP_SANITIZED_READER_PROMPT_SHA256 = createHash("sha256").update(MCP_SANITIZED_READER_PROMPT).digest("hex");
const ORCHESTRATOR_AGENT_ALIASES = new Set(["orchestrator", "principal-engineer-orchestrator", STANDALONE_ORCHESTRATOR_AGENT]);
const DEFAULT_SUBAGENT_PROXY_AGENT = "planner";
const CONTRACTOR_ALLOWED_SUBAGENTS = new Set(["planner", "architect", "builder", "debugger", "reviewer", "tester", "explore"]);
const WRITE_CAPABLE_AGENTS = new Set(["build", "builder", "debugger", "general"]);
const READ_ONLY_PARALLEL_AGENTS = new Set(["planner", "reviewer", "architect", "explore", "explorer", "tester", MCP_SANITIZED_READER_AGENT]);
const SAFE_AGENT_BASH_ALLOW_PATTERNS = new Set([
  "Get-Command git",
  "where.exe git",
  "git diff",
  "git diff --check",
  "git diff --name-only",
  "git diff --stat",
  "git status",
  "git status --short",
  "git status --porcelain",
  "git status --porcelain=v1",
  "git show",
  "git show --stat",
  "git log",
  "git log --oneline",
  "git log --oneline --decorate",
  "git rev-parse --show-toplevel",
  "git rev-parse --is-inside-work-tree",
  "git ls-files",
  "git ls-files --others --exclude-standard",
]);
const REQUIRED_MANAGED_AGENTS = Object.freeze([
  STANDALONE_ORCHESTRATOR_AGENT,
  MCP_ORCHESTRATOR_AGENT,
  MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  "planner",
  "architect",
  "builder",
  "debugger",
  "reviewer",
  "tester",
  MCP_SANITIZED_READER_AGENT,
]);
const GLOBALLY_REQUIRED_MANAGED_AGENTS = Object.freeze(
  REQUIRED_MANAGED_AGENTS.filter((agent) => agent !== MCP_SANITIZED_READER_AGENT)
);
const RELEASE_REQUIRED_MANAGED_AGENTS = Object.freeze(
  [...new Set([...REQUIRED_MANAGED_AGENTS, ...CONTRACTOR_ALLOWED_SUBAGENTS])].sort()
);
const REQUIRED_MANAGED_SKILLS = Object.freeze([
  "agent-suitability-check",
  "architecture-review",
  "builder-safety",
  "code-review-checklist",
  "debugger-safety",
  "debugging-investigation",
  "error-trace-analysis",
  "handoff-resume",
  "minimal-fix-planning",
  "project-testing",
  "regression-analysis",
  "task-packet",
  "test-failure-diagnosis",
]);
const PARALLEL_LOCK_TYPES = new Set(["read", "write", "serial_integration"]);
// B-073: a self-test run without CODEX_OPENCODE_STATE_DIR gets a per-process temporary state
// directory, never the operator's ~/.codex/codex-opencode-mcp. Suites that set only
// hooks.stateDirectoryOverride fell back to the operator's directory whenever a timer fired after
// their cleanup reset the override (job rows, empty databases and schema changes landed there).
// The variable is set too, so a child process started with this environment shares the folder.
const SELF_TEST_TEMP_STATE_DIR = process.argv.some((argument) => String(argument).startsWith("--self-test"))
  && !String(process.env.CODEX_OPENCODE_STATE_DIR || "").trim()
  ? mkdtempSync(path.join(tmpdir(), `codex-opencode-selftest-state-${process.pid}-`))
  : "";
if (SELF_TEST_TEMP_STATE_DIR) {
  process.env.CODEX_OPENCODE_STATE_DIR = SELF_TEST_TEMP_STATE_DIR;
  process.once("exit", () => {
    try { rmSync(SELF_TEST_TEMP_STATE_DIR, { recursive: true, force: true }); } catch { /* Best effort; it is in the temp folder. */ }
  });
}
const GLOBAL_BRIDGE_STATE_DIR = path.resolve(
  String(SELF_TEST_TEMP_STATE_DIR || process.env.CODEX_OPENCODE_STATE_DIR || path.join(CODEX_STATE_HOME, "codex-opencode-mcp")).trim()
);
const DISABLED_GIT_HOOKS_PATH = path.join(
  GLOBAL_BRIDGE_STATE_DIR,
  `git-hooks-disabled-${process.pid}-${randomBytes(8).toString("hex")}`
);
const BRIDGE_OPENCODE_HOME_DIR = path.join(GLOBAL_BRIDGE_STATE_DIR, "opencode-home");
const DEFAULT_LOCK_TTL_MS = 1000 * 60 * 30;
const MAX_LOCK_TTL_MS = 1000 * 60 * 60 * 24;

// Q-002: the two concurrency limits can be changed in the running process (set_opencode_concurrency),
// persisted in provider-concurrency.sqlite so a restart keeps them until cleared. CONFIG reads
// them through accessors, so every use of CONFIG.providerConcurrencyLimit / queueParallelLimit
// (slot leases, diagnose, the parallel-batch check, the scheduler) sees the effective value.
const ENV_PROVIDER_CONCURRENCY_LIMIT = readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT", 2);
const ENV_QUEUE_PARALLEL_LIMIT = readPositiveIntEnv("CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT", 6);
const MAX_RUNTIME_CONCURRENCY_LIMIT = 32;
// Q-005: one cap on running agents across every provider and every bridge process (the round-6
// orchestrator's max.txt). 0 = no cap; the per-provider limit still applies under it.
const ENV_GLOBAL_WORKER_LIMIT = readNonNegativeIntEnv("CODEX_OPENCODE_GLOBAL_WORKER_LIMIT", 0);
const MAX_GLOBAL_WORKER_LIMIT = 64;
const RUNTIME_CONCURRENCY = { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, updatedAt: "" };
// B-060: the default free-memory floor. A fixed 1024 MB would hold the queue forever on a machine
// with 1 GB or less, so it is capped at an eighth of total memory.
const DEFAULT_MIN_FREE_MEMORY_MB = Math.max(0, Math.min(1024, Math.floor(totalmem() / (1024 * 1024) / 8)));
const CONFIG = Object.freeze({
  readOnlyAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS", 1000 * 60 * 3),
  writeAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS", 1000 * 60 * 10),
  builderTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_BUILDER_TIMEOUT_MS", 1000 * 60 * 15),
  orchestratorTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS", 1000 * 60 * 6),
  contractorOrchestratorTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS", 1000 * 60 * 20),
  validationCommandTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_VALIDATION_TIMEOUT_MS", 1000 * 60 * 5),
  maxReadOnlyAgentRetries: readNonNegativeIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES", 2),
  readOnlyRetryBaseDelayMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_RETRY_BASE_DELAY_MS", 1000),
  readOnlyRetryMaxElapsedMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_RETRY_MAX_ELAPSED_MS", 1000 * 60 * 8),
  maxProcessOutputChars: readPositiveIntEnv("CODEX_OPENCODE_MAX_PROCESS_OUTPUT_CHARS", 1024 * 1024 * 2),
  maxAssistantResponseChars: readPositiveIntEnv("CODEX_OPENCODE_MAX_ASSISTANT_RESPONSE_CHARS", 1024 * 128),
  requireRuntimeModelEvidence: readChoiceEnv("CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE", ["false", "true"], "false") === "true",
  maxIgnoredSnapshotFiles: readPositiveIntEnv("CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES", 20000),
  maxSnapshotFiles: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_FILES", 25000),
  maxSnapshotFileBytes: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES", 1024 * 1024),
  maxSnapshotTotalBytes: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES", 1024 * 1024 * 128),
  defaultReadLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE", ["off"], "off"),
  defaultWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE", ["simple", "strict"], "simple"),
  defaultParallelWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE", ["strict"], "strict"),
  parallelLimit: readPositiveIntEnv("CODEX_OPENCODE_PARALLEL_LIMIT", 6),
  logLevel: readChoiceEnv("CODEX_OPENCODE_LOG_LEVEL", ["off", "error", "warn", "info", "debug"], "warn"),
  worktreeMode: readChoiceEnv("CODEX_OPENCODE_WORKTREE_MODE", ["off", "write", "all"], "off"),
  // Worktree add/remove and temp-index rebuilds rehash the whole checkout; 60 s was short
  // for a large repository on Windows.
  gitHeavyTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_GIT_HEAVY_TIMEOUT_MS", 1000 * 60 * 5),
  worktreeRoot: String(process.env.CODEX_OPENCODE_WORKTREE_ROOT || "global").trim() || "global",
  worktreeCleanup: readChoiceEnv("CODEX_OPENCODE_WORKTREE_CLEANUP", ["always", "on_success", "never"], "never"),
  sourceDirtPolicy: readChoiceEnv("CODEX_OPENCODE_SOURCE_DIRT_POLICY", ["strict", "unrelated_ok"], "strict"),
  modelOverrideAllowlist: readCsvEnv("CODEX_OPENCODE_MODEL_ALLOWLIST", []),
  worktreeBranchPrefix: String(process.env.CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX || "agent").trim() || "agent",
  queueMode: readChoiceEnv("CODEX_OPENCODE_QUEUE_MODE", ["off", "memory", "sqlite"], "sqlite"),
  get queueParallelLimit() { return RUNTIME_CONCURRENCY.queueParallelLimit ?? ENV_QUEUE_PARALLEL_LIMIT; },
  // B-045: 0 disables. While the machine has less free memory than this, the queue starts no new job
  // (twenty agent processes, their worktrees and test runs exhausted a laptop). B-060: on by
  // default (1024 MB, at most an eighth of the machine's memory), because 10 builders took the
  // owner's machine to 0.4 GB free while the floor was off.
  minFreeMemoryMb: readNonNegativeIntEnv("CODEX_OPENCODE_MIN_FREE_MEMORY_MB", DEFAULT_MIN_FREE_MEMORY_MB),
  // B-046: 0 disables. An agent that writes nothing to stdout or stderr for this long is stopped
  // through the process-tree supervisor and fails as agent_idle_timeout (a stalled provider stream
  // held a slot for 20+ minutes). Output arrives per finished step, so keep this well above the
  // longest tool call or reasoning pause a healthy agent has. B-060: 10 minutes by default (the
  // round-6 orchestrator's watchdog); CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL sets other
  // limits for models that write a whole file in one long silent step.
  agentIdleTimeoutMs: readNonNegativeIntEnv("CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS", 1000 * 60 * 10),
  agentIdleTimeoutByModel: readModelDurationMapEnv("CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL"),
  // B-061: OpenCode retries "Rate limit exceeded" by itself, silently on stdout, for as long as the
  // run timeout allows. This many rate-limit lines for the job's model with no stdout output in
  // between end the run as provider_rate_limited (0 turns the detection off).
  rateLimitHits: readNonNegativeIntEnv("CODEX_OPENCODE_RATE_LIMIT_HITS", 2),
  // The pause a detected rate limit puts on that provider/model; it doubles on the next one up to
  // the maximum (30, then 60 minutes, as the round-6 orchestrator did). 0 records no pause.
  rateLimitPauseMs: readNonNegativeIntEnv("CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS", 1000 * 60 * 30),
  rateLimitPauseMaxMs: readNonNegativeIntEnv("CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS", 1000 * 60 * 60),
  // The OpenCode log file scanned for those lines in addition to the job's own stderr ("off" stops
  // the scan). Tests point it at a scratch fixture.
  openCodeLogPath: readOpenCodeLogPathEnv(),
  openCodeLogScanMs: readPositiveIntEnv("CODEX_OPENCODE_OPENCODE_LOG_SCAN_MS", 1000 * 15),
  // Q-008: a job with a retry policy (models / maxAttempts) that a bridge restart interrupted is
  // requeued by the bridge that finds it, as one of its attempts. false leaves it interrupted.
  autoResumeInterrupted: readChoiceEnv("CODEX_OPENCODE_AUTO_RESUME_INTERRUPTED", ["true", "false"], "true") === "true",
  // Q-010: false refuses every autoIntegrate job, for an operator who wants every patch reviewed.
  autoIntegrateAllowed: readChoiceEnv("CODEX_OPENCODE_AUTO_INTEGRATE", ["true", "false"], "true") === "true",
  queueWriteConflictPolicy: readChoiceEnv("CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY", ["reject", "wait"], "wait"),
  queueBlockedPollMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS", 2000),
  queueStaleAfterMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_STALE_AFTER_MS", 1000 * 60 * 60 * 2),
  queueReadOnlyRetries: readNonNegativeIntEnv("CODEX_OPENCODE_QUEUE_READONLY_RETRIES", 0),
  queueWriteRetries: readNonNegativeIntEnv("CODEX_OPENCODE_QUEUE_WRITE_RETRIES", 0),
  queueHeartbeatMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_HEARTBEAT_MS", 1000 * 15),
  // Idle bridges re-scan the state databases for orphaned work; back off to this interval when nothing is pending.
  deferredRecoveryIdleMaxMs: readPositiveIntEnv("CODEX_OPENCODE_DEFERRED_RECOVERY_IDLE_MAX_MS", 1000 * 15),
  // 0 disables progress notifications for long tool calls.
  toolProgressIntervalMs: readNonNegativeIntEnv("CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS", 1000 * 30),
  containmentReleaseGraceMs: readNonNegativeIntEnv("CODEX_OPENCODE_CONTAINMENT_RELEASE_GRACE_MS", 1000 * 60 * 10),
  queueLeaseMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_LEASE_MS", 1000 * 60),
  queueRetentionDays: readStrictPositiveIntEnv("CODEX_OPENCODE_QUEUE_RETENTION_DAYS", 30),
  auditRetentionDays: readStrictPositiveIntEnv("CODEX_OPENCODE_AUDIT_RETENTION_DAYS", 90),
  stateDbMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_STATE_DB_MAX_BYTES", 1024 * 1024 * 1024 * 2),
  terminalJobMaxRows: readPositiveIntEnv("CODEX_OPENCODE_TERMINAL_JOB_MAX_ROWS", 50000),
  terminalPipelineMaxRows: readPositiveIntEnv("CODEX_OPENCODE_TERMINAL_PIPELINE_MAX_ROWS", 10000),
  terminalIntegrationMaxRows: readPositiveIntEnv("CODEX_OPENCODE_TERMINAL_INTEGRATION_MAX_ROWS", 10000),
  retainedWorktreeMaxCount: readPositiveIntEnv("CODEX_OPENCODE_RETAINED_WORKTREE_MAX_COUNT", 64),
  retainedWorktreeMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_RETAINED_WORKTREE_MAX_BYTES", 1024 * 1024 * 1024 * 20),
  queueResultMaxChars: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS", 24000),
  integrationPreviewMaxChars: readPositiveIntEnv("CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS", 12000),
  integrationPreviewGlobalMax: readPositiveIntEnv("CODEX_OPENCODE_INTEGRATION_PREVIEW_GLOBAL_MAX", 256),
  integrationPreviewProjectMax: readPositiveIntEnv("CODEX_OPENCODE_INTEGRATION_PREVIEW_PROJECT_MAX", 64),
  allowExternalPlugins: readChoiceEnv("CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS", ["false", "true"], "false") === "true",
  externalPluginAllowlist: readCsvEnv("CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST"),
  externalPluginManifestPath: String(process.env.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH || "").trim(),
  expectedExternalPluginManifestSha256: String(process.env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 || "").trim().toLowerCase(),
  validationExecutableAllowlist: readCsvEnv("CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST", ["git"]),
  validationExecutableSha256Allowlist: readCsvEnv("CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST").map((item) => item.toLowerCase()),
  trustedPolicySha256: String(process.env.CODEX_OPENCODE_TRUSTED_POLICY_SHA256 || "").trim().toLowerCase(),
  trustedPolicyRoot: String(process.env.CODEX_OPENCODE_TRUSTED_POLICY_ROOT || "").trim(),
  trustedPolicyPath: String(process.env.CODEX_OPENCODE_TRUSTED_POLICY_PATH || "").trim(),
  get providerConcurrencyLimit() { return RUNTIME_CONCURRENCY.providerLimit ?? ENV_PROVIDER_CONCURRENCY_LIMIT; },
  get globalWorkerLimit() { return RUNTIME_CONCURRENCY.globalWorkerLimit ?? ENV_GLOBAL_WORKER_LIMIT; },
  attestationCacheTtlMs: readNonNegativeIntEnv("CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS", 1000 * 60 * 30),
  providerLeasePollMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_LEASE_POLL_MS", 250),
  // How long a job may wait for a provider slot. The wait is not part of the agent's run
  // timeout: the run clock starts when the slot is granted.
  providerWaitMaxMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS", 1000 * 60 * 20),
  providerLeaseMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_LEASE_MS", 1000 * 60 * 4),
  providerHeartbeatMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_HEARTBEAT_MS", 1000 * 20),
  providerConcurrencyKey: String(process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY || "opencode-default-account").trim() || "opencode-default-account",
  providerConcurrencyKeyExplicit: Boolean(String(process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY || "").trim()),
  sanitizedMaxFiles: readPositiveIntEnv("CODEX_OPENCODE_SANITIZED_MAX_FILES", 25000),
  sanitizedMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_SANITIZED_MAX_BYTES", 1024 * 1024 * 1024),
  policyMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_POLICY_MAX_BYTES", 1024 * 128),
  contractorAuthorizationSha256: String(process.env.CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256 || "").trim().toLowerCase(),
  callerModel: readChoiceEnv("CODEX_OPENCODE_CALLER_MODEL", ["trusted_stdio"], "trusted_stdio"),
});
assertSupportedQueueRetryConfig(CONFIG);
assertSupportedCallerModel();
const defaultReadOnlyAgentTimeoutMs = CONFIG.readOnlyAgentTimeoutMs;
const defaultWriteAgentTimeoutMs = CONFIG.writeAgentTimeoutMs;
const defaultBuilderTimeoutMs = CONFIG.builderTimeoutMs;
const defaultOrchestratorTimeoutMs = CONFIG.orchestratorTimeoutMs;
const defaultContractorOrchestratorTimeoutMs = CONFIG.contractorOrchestratorTimeoutMs;
const maxReadOnlyAgentRetries = CONFIG.maxReadOnlyAgentRetries;

function assertSupportedQueueRetryConfig(config) {
  if (Number(config?.queueReadOnlyRetries || 0) === 0 && Number(config?.queueWriteRetries || 0) === 0) return;
  throw new Error(
    "CODEX_OPENCODE_QUEUE_READONLY_RETRIES and CODEX_OPENCODE_QUEUE_WRITE_RETRIES are unsupported and must remain 0; bounded provider retries are managed inside read-only execution."
  );
}

function assertSupportedCallerModel() {
  const configured = String(process.env.CODEX_OPENCODE_CALLER_MODEL || "trusted_stdio").trim().toLowerCase();
  if (configured === "trusted_stdio") return;
  throw new Error(
    "CODEX_OPENCODE_CALLER_MODEL only supports trusted_stdio. Shared or multiplexed callers require an external per-project capability/authentication boundary and are rejected by this bridge."
  );
}

// B-061: CODEX_OPENCODE_OPENCODE_LOG_PATH, default <OpenCode data dir>/log/opencode.log (bridge
// children write there too: they run with --print-logs, which writes the file and stderr). "off"
// disables the file scan; anything else must be an absolute path.
function readOpenCodeLogPathEnv() {
  const raw = String(process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH || "").trim();
  if (!raw) return path.join(DEFAULT_OPENCODE_DATA_DIR, "log", "opencode.log");
  if (raw.toLowerCase() === "off") return "";
  if (!path.isAbsolute(raw)) throw new Error(`CODEX_OPENCODE_OPENCODE_LOG_PATH must be an absolute path or off; got ${JSON.stringify(raw)}.`);
  return path.resolve(raw);
}

  return {
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
  };
}
