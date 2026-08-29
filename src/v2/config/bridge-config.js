import { homedir } from "node:os";
import path from "node:path";

import {
  readChoiceEnv,
  readCsvEnv,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
} from "./env-readers.js";

export function resolveBridgePaths({
  runtimeDir,
  env = process.env,
  userHomeDir = homedir(),
} = {}) {
  const BRIDGE_RUNTIME_DIR = runtimeDir;
  const USER_HOME_DIR = userHomeDir;
  const DEFAULT_OPENCODE_CONFIG_DIR = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "opencode")
    : path.join(USER_HOME_DIR, ".config", "opencode");
  const DEFAULT_OPENCODE_DATA_DIR = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, "opencode")
    : path.join(USER_HOME_DIR, ".local", "share", "opencode");
  const DEFAULT_OPENCODE_CACHE_HOME = env.XDG_CACHE_HOME || path.join(USER_HOME_DIR, ".cache");
  const DEFAULT_OPENCODE_STATE_HOME = env.XDG_STATE_HOME || path.join(USER_HOME_DIR, ".local", "state");
  const CODEX_STATE_HOME = String(env.CODEX_HOME || path.join(USER_HOME_DIR, ".codex")).trim();
  const OPENCODE_EXE = String(
    env.CODEX_OPENCODE_EXECUTABLE || env.OPENCODE_EXE || "opencode"
  ).trim() || "opencode";
  const OPENCODE_AGENT_DIR = path.resolve(
    String(env.CODEX_OPENCODE_AGENT_DIR || path.join(DEFAULT_OPENCODE_CONFIG_DIR, "agents")).trim()
  );
  const OPENCODE_SKILL_DIR = path.resolve(
    String(env.CODEX_OPENCODE_SKILL_DIR || path.join(DEFAULT_OPENCODE_CONFIG_DIR, "skills")).trim()
  );
  const GLOBAL_BRIDGE_STATE_DIR = path.resolve(
    String(env.CODEX_OPENCODE_STATE_DIR || path.join(CODEX_STATE_HOME, "codex-opencode-mcp")).trim()
  );
  const BRIDGE_OPENCODE_HOME_DIR = path.join(GLOBAL_BRIDGE_STATE_DIR, "opencode-home");

  return {
    BRIDGE_RUNTIME_DIR,
    USER_HOME_DIR,
    DEFAULT_OPENCODE_CONFIG_DIR,
    DEFAULT_OPENCODE_DATA_DIR,
    DEFAULT_OPENCODE_CACHE_HOME,
    DEFAULT_OPENCODE_STATE_HOME,
    CODEX_STATE_HOME,
    OPENCODE_EXE,
    OPENCODE_AGENT_DIR,
    OPENCODE_SKILL_DIR,
    GLOBAL_BRIDGE_STATE_DIR,
    BRIDGE_OPENCODE_HOME_DIR,
  };
}
export function readBridgeConfig(env = process.env) {
  return Object.freeze({
    readOnlyAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS", 1000 * 60 * 3, env),
    writeAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS", 1000 * 60 * 10, env),
    builderTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_BUILDER_TIMEOUT_MS", 1000 * 60 * 15, env),
    orchestratorTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS", 1000 * 60 * 6, env),
    contractorOrchestratorTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS", 1000 * 60 * 20, env),
    selfTestTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_SELF_TEST_TIMEOUT_MS", 1000 * 60 * 15, env),
    validationCommandTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_VALIDATION_TIMEOUT_MS", 1000 * 60 * 5, env),
    maxReadOnlyAgentRetries: readNonNegativeIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES", 2, env),
    readOnlyRetryBaseDelayMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_RETRY_BASE_DELAY_MS", 1000, env),
    readOnlyRetryMaxElapsedMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_RETRY_MAX_ELAPSED_MS", 1000 * 60 * 8, env),
    maxProcessOutputChars: readPositiveIntEnv("CODEX_OPENCODE_MAX_PROCESS_OUTPUT_CHARS", 1024 * 1024 * 2, env),
    maxAssistantResponseChars: readPositiveIntEnv("CODEX_OPENCODE_MAX_ASSISTANT_RESPONSE_CHARS", 1024 * 128, env),
    maxIgnoredSnapshotFiles: readPositiveIntEnv("CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES", 20000, env),
    maxSnapshotFiles: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_FILES", 25000, env),
    maxSnapshotFileBytes: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES", 1024 * 1024, env),
    maxSnapshotTotalBytes: readPositiveIntEnv("CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES", 1024 * 1024 * 128, env),
    defaultReadLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE", ["off"], "off", env),
    defaultWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE", ["simple", "strict"], "simple", env),
    defaultParallelWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE", ["strict"], "strict", env),
    parallelLimit: readPositiveIntEnv("CODEX_OPENCODE_PARALLEL_LIMIT", 6, env),
    logLevel: readChoiceEnv("CODEX_OPENCODE_LOG_LEVEL", ["off", "error", "warn", "info", "debug"], "warn", env),
    worktreeMode: readChoiceEnv("CODEX_OPENCODE_WORKTREE_MODE", ["off", "write", "all"], "off", env),
    worktreeRoot: String(env.CODEX_OPENCODE_WORKTREE_ROOT || "global").trim() || "global",
    worktreeCleanup: readChoiceEnv("CODEX_OPENCODE_WORKTREE_CLEANUP", ["always", "on_success", "never"], "never", env),
    worktreeBranchPrefix: String(env.CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX || "agent").trim() || "agent",
    queueMode: readChoiceEnv("CODEX_OPENCODE_QUEUE_MODE", ["off", "memory", "sqlite"], "memory", env),
    queueParallelLimit: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT", 6, env),
    queueWriteConflictPolicy: readChoiceEnv("CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY", ["reject", "wait"], "wait", env),
    queueBlockedPollMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS", 2000, env),
    queueStaleAfterMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_STALE_AFTER_MS", 1000 * 60 * 60 * 2, env),
    queueReadOnlyRetries: readNonNegativeIntEnv("CODEX_OPENCODE_QUEUE_READONLY_RETRIES", 0, env),
    queueWriteRetries: readNonNegativeIntEnv("CODEX_OPENCODE_QUEUE_WRITE_RETRIES", 0, env),
    queueHeartbeatMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_HEARTBEAT_MS", 1000 * 15, env),
    queueLeaseMs: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_LEASE_MS", 1000 * 60, env),
    queueRetentionDays: readNonNegativeIntEnv("CODEX_OPENCODE_QUEUE_RETENTION_DAYS", 0, env),
    queueResultMaxChars: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS", 8000, env),
    integrationPreviewMaxChars: readPositiveIntEnv("CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS", 12000, env),
    allowExternalPlugins: readChoiceEnv("CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS", ["false", "true"], "false", env) === "true",
    externalPluginAllowlist: readCsvEnv("CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST", [], env),
    externalPluginManifestPath: String(env.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH || "").trim(),
    expectedExternalPluginManifestSha256: String(env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 || "").trim().toLowerCase(),
    validationExecutableAllowlist: readCsvEnv("CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST", ["git"], env),
    validationExecutableSha256Allowlist: readCsvEnv("CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST", [], env).map((item) => item.toLowerCase()),
    trustedPolicySha256: String(env.CODEX_OPENCODE_TRUSTED_POLICY_SHA256 || "").trim().toLowerCase(),
    trustedPolicyRoot: String(env.CODEX_OPENCODE_TRUSTED_POLICY_ROOT || "").trim(),
    trustedPolicyPath: String(env.CODEX_OPENCODE_TRUSTED_POLICY_PATH || "").trim(),
    providerConcurrencyLimit: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT", 2, env),
    providerLeasePollMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_LEASE_POLL_MS", 250, env),
    providerLeaseMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_LEASE_MS", 1000 * 60 * 4, env),
    providerHeartbeatMs: readPositiveIntEnv("CODEX_OPENCODE_PROVIDER_HEARTBEAT_MS", 1000 * 20, env),
    providerConcurrencyKey: String(env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY || "opencode-default-account").trim() || "opencode-default-account",
    sanitizedMaxFiles: readPositiveIntEnv("CODEX_OPENCODE_SANITIZED_MAX_FILES", 25000, env),
    sanitizedMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_SANITIZED_MAX_BYTES", 1024 * 1024 * 1024, env),
    policyMaxBytes: readPositiveIntEnv("CODEX_OPENCODE_POLICY_MAX_BYTES", 1024 * 128, env),
    contractorAuthorizationSha256: String(env.CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256 || "").trim().toLowerCase(),
  });
}
