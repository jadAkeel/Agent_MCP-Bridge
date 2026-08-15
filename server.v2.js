#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentAttestation } from "./src/v2/agents/attestation.js";
import { createAgentMetadataPolicy } from "./src/v2/agents/metadata-policy.js";
import { readBridgeConfig, resolveBridgePaths } from "./src/v2/config/bridge-config.js";
import { createHardLockService } from "./src/v2/persistence/hard-locks.js";
import { createProviderLeaseService } from "./src/v2/persistence/provider-leases.js";
import { createQueueRecordCodec } from "./src/v2/persistence/queue-record-codec.js";
import { createQueueRecoveryPrimitives } from "./src/v2/persistence/queue-recovery-primitives.js";
import { createQueueRepository } from "./src/v2/persistence/queue-repository.js";
import { createQueueRequestCrypto } from "./src/v2/persistence/queue-request-crypto.js";
import { createStateRetentionService } from "./src/v2/persistence/state-retention.js";
import {
  integrationPreviewReceiptSchema,
  sanitizedWorkspaceSchema,
  scopeContractSchema,
  scopePathSetSchema,
  scopeTimeoutPolicySchema,
  scopeValidationSchema,
} from "./src/v2/policy/schemas.js";
import { DEFAULT_FORBIDDEN_EDIT_PATHS } from "./src/v2/policy/default-paths.js";
import { unsafePathReason } from "./src/v2/policy/path-boundary.js";
import {
  findSerialOnlyMatches,
  firstNonEmptyList,
  hasAmbiguousPathPattern,
  isPathInside,
  isWithinAnyPath,
  mergePathLists,
  normalizeFilesystemCase,
  normalizeList,
  normalizeLockPath,
  normalizeLockPathList,
  normalizeLockPathListForCwd,
  normalizePathForCompare,
  overlaps,
  unsafeChangedFiles,
} from "./src/v2/policy/paths.js";
import {
  applyProjectPolicyToJobs,
  normalizeProjectAgentPolicy,
} from "./src/v2/policy/project-policy.js";
import {
  formatScopeContractForPrompt,
  normalizeScopeContract,
  scopeContractPathInputs,
  scopeContractTimeout,
} from "./src/v2/policy/scope-contracts.js";
import {
  changedFileValidationErrorType,
  scopeChangedFileViolations,
  validateChangedFilesForPlan,
} from "./src/v2/policy/scope-results.js";
import { createChildEnvBuilders } from "./src/v2/runtime/child-env.js";
import { createIsolatedOpenCodeRuntimeManager } from "./src/v2/runtime/isolated-opencode-runtime.js";
import { createOpenCodeProbe } from "./src/v2/runtime/opencode-probe.js";
import { createProcessRunner } from "./src/v2/runtime/process-runner.js";
import { createProviderDiagnostics } from "./src/v2/runtime/provider-diagnostics.js";
import { delayWithSignal, nowMs, retryAfterMsFromText } from "./src/v2/runtime/timing.js";
import { assertNoLinkedPath, sha256File } from "./src/v2/security/filesystem-integrity.js";
import { createPluginAttestation } from "./src/v2/security/plugin-attestation.js";
import { redactSensitiveText, sanitizeLogValue, sanitizePersistedValue } from "./src/v2/security/redaction.js";
import { createValidationTrust } from "./src/v2/security/validation-trust.js";
import { createEventLogger } from "./src/v2/telemetry/event-logger.js";

const execFileAsync = promisify(execFile);
const BRIDGE_PATHS = resolveBridgePaths({
  runtimeDir: path.dirname(fileURLToPath(import.meta.url)),
});
const {
  BRIDGE_RUNTIME_DIR,
  USER_HOME_DIR,
  DEFAULT_OPENCODE_CONFIG_DIR,
  DEFAULT_OPENCODE_DATA_DIR,
  OPENCODE_EXE,
  OPENCODE_AGENT_DIR,
  OPENCODE_SKILL_DIR,
  GLOBAL_BRIDGE_STATE_DIR,
  BRIDGE_OPENCODE_HOME_DIR,
} = BRIDGE_PATHS;
const MCP_ORCHESTRATOR_AGENT = String(
  process.env.CODEX_OPENCODE_MCP_ORCHESTRATOR_AGENT || "mcp-orchestrator"
).trim() || "mcp-orchestrator";
const MCP_CONTRACTOR_ORCHESTRATOR_AGENT = String(
  process.env.CODEX_OPENCODE_MCP_CONTRACTOR_ORCHESTRATOR_AGENT || "mcp-contractor-orchestrator"
).trim() || "mcp-contractor-orchestrator";
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
const ORCHESTRATOR_AGENT_ALIASES = new Set(["orchestrator", "principal-engineer-orchestrator"]);
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
  "orchestrator",
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
const DEFAULT_LOCK_TTL_MS = 1000 * 60 * 30;
const CONFIG = readBridgeConfig(process.env);
const defaultReadOnlyAgentTimeoutMs = CONFIG.readOnlyAgentTimeoutMs;
const defaultWriteAgentTimeoutMs = CONFIG.writeAgentTimeoutMs;
const defaultBuilderTimeoutMs = CONFIG.builderTimeoutMs;
const defaultOrchestratorTimeoutMs = CONFIG.orchestratorTimeoutMs;
const defaultContractorOrchestratorTimeoutMs = CONFIG.contractorOrchestratorTimeoutMs;
const maxReadOnlyAgentRetries = CONFIG.maxReadOnlyAgentRetries;
const DEFAULT_RETURN_FORMAT = [
  "1. Summary",
  "2. Lock used",
  "3. Files inspected",
  "4. Files changed",
  "5. Files wanted but not edited",
  "6. Changes made or proposed",
  "7. NEEDS_INTEGRATION, if required",
  "8. Risks",
  "9. Validation performed",
  "10. Validation still recommended",
].join("\n");
const QUEUE_JOBS = new Map();
const PIPELINE_RUNS = new Map();
const PIPELINE_PERSISTENCE_CHAINS = new Map();
const BRIDGE_INSTANCE_ID = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
const QUEUE_CAPABILITY_KEY = randomBytes(32);
const INTEGRATION_PREVIEW_KEY = randomBytes(32);
const INTEGRATION_PREVIEWS = new Map();
const KNOWN_STATE_DB_PATHS = new Set();
const INTEGRATION_PREVIEW_TTL_MS = 1000 * 60 * 60;
let queueSchedulerActive = false;
let queueWakeTimer = null;
let queueHeartbeatTimer = null;
let stateDirectoryOverride = "";
let queueModeOverride = "";
let queueWriteConflictPolicyOverride = "";

function effectiveQueueMode() {
  return queueModeOverride || CONFIG.queueMode;
}

function effectiveQueueWriteConflictPolicy() {
  return queueWriteConflictPolicyOverride || CONFIG.queueWriteConflictPolicy;
}
let selfTestContractorAuthorizationSha256 = "";
let pipelinePersistenceTestHook = null;

const server = new McpServer({
  name: "codex-opencode-bridge",
  version: "1.0.0",
});

const { buildOpenCodeEnv, buildValidationEnv } = createChildEnvBuilders({
  bridgePaths: BRIDGE_PATHS,
});

const { logEvent } = createEventLogger({
  logLevel: CONFIG.logLevel,
  sanitizeLogValue,
});

const {
  pruneInMemoryState,
  prunePersistedState,
} = createStateRetentionService({
  config: CONFIG,
  queueJobs: QUEUE_JOBS,
  pipelineRuns: PIPELINE_RUNS,
});

const {
  recordChangedFiles,
  conflictsWithActiveLock,
  cleanupExpiredLocks,
  listLocks,
  acquireHardLock,
  releaseHardLock,
  startHardLockHeartbeat,
} = createHardLockService({
  openLockDb,
  resolveProjectStateRoot,
  defaultLockTtlMs: DEFAULT_LOCK_TTL_MS,
  logEvent,
  redactSensitiveText,
});

const {
  acquireProviderLease,
  startProviderLeaseHeartbeat,
  releaseProviderLease,
  providerCapacitySnapshot,
} = createProviderLeaseService({
  config: CONFIG,
  getStateDirectory: () => effectiveBridgeStateDirectory(),
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  delayWithSignal,
  logEvent,
  redactSensitiveText,
});

const {
  summarizeStderr,
  detectsOpenCodeFallback,
  providerErrorTypeFromText,
  providerErrorTypeFromDiagnosticLine,
  providerErrorTypeFromStructuredEvent,
  modelEvidenceFromEvent,
  providerDiagnosticTextFromStderr,
  inspectOpenCodeEventStream,
  detectsOpenCodeApiError,
} = createProviderDiagnostics({
  maxAssistantResponseChars: CONFIG.maxAssistantResponseChars,
});

const { runCommand, runSpawnCommand } = createProcessRunner({
  maxProcessOutputChars: CONFIG.maxProcessOutputChars,
  nowMs,
  logEvent,
  providerErrorTypeFromStructuredEvent,
  providerErrorTypeFromStderr: (stderr) => providerErrorTypeFromText(providerDiagnosticTextFromStderr(stderr)),
});

const {
  parseCommandLine,
  safeValidationPathspec,
  strictProjectGitArgsError,
  validationCommandTrustError,
  validationPathValue,
  resolveValidationExecutable,
  prepareValidationCommand,
  runValidationGate,
} = createValidationTrust({
  config: CONFIG,
  buildValidationEnv,
  runCommand,
  sha256File,
  nowMs,
  redactSensitiveText,
  truncateText,
});

const {
  exactPluginSpecifier,
  parseJsoncObject,
  pluginSpecsFromConfigText,
  hashExactTree,
  readPluginConfigSource,
  verifyNoLocalPluginDirectory,
  openCodeProjectConfigDirectories,
  managedOpenCodeConfigDirectories,
  exactPluginPackageName,
  expectedOpenCodePluginResolution,
  verifyExternalPluginPolicy,
} = createPluginAttestation({
  config: CONFIG,
  defaultOpenCodeConfigDir: DEFAULT_OPENCODE_CONFIG_DIR,
  userHomeDir: USER_HOME_DIR,
  openCodeExe: OPENCODE_EXE,
  resolveProjectStateRoot,
  normalizePathForCompare,
  isPathInside,
  assertNoLinkedPath,
  sha256File,
  runCommand,
  buildOpenCodeEnv,
  summarizeStderr,
  redactSensitiveText,
});

const { createIsolatedOpenCodeRuntime, wipeIsolatedOpenCodeRuntime } = createIsolatedOpenCodeRuntimeManager({
  bridgePaths: BRIDGE_PATHS,
  buildOpenCodeEnv,
  redactSensitiveText,
  sanitizedReaderAgent: MCP_SANITIZED_READER_AGENT,
  sanitizedReaderProfile: MCP_SANITIZED_READER_PROFILE,
  sanitizedReaderPrompt: MCP_SANITIZED_READER_PROMPT,
});

const { safeOpenCodeCommand } = createOpenCodeProbe({
  allowExternalPlugins: CONFIG.allowExternalPlugins,
  verifyExternalPluginPolicy,
  createIsolatedOpenCodeRuntime,
  wipeIsolatedOpenCodeRuntime,
  buildOpenCodeEnv,
  runCommand,
  opencodeExecutable: OPENCODE_EXE,
});

const {
  sanitizeAgentName,
  parseAgentList,
  normalizedPermissionRules,
  permissionDefaultAndOverrides,
  effectivePermissionProfileRules,
  approvedOpenCodeToolOutputPattern,
  normalizeAgentDebugMetadata,
  managedAgentSourceProfile,
  effectiveReadOnlyMetadataError,
  contractorNestedAgentMetadataError,
  sanitizedExternalPatternInsideRoot,
  sanitizedAgentMetadataError,
  agentMetadataPolicyOptions,
  sanitizedRoutingPolicyError,
} = createAgentMetadataPolicy({
  userHomeDir: USER_HOME_DIR,
  safeAgentBashAllowPatterns: SAFE_AGENT_BASH_ALLOW_PATTERNS,
  contractorAllowedSubagents: CONTRACTOR_ALLOWED_SUBAGENTS,
  defaultForbiddenEditPaths: DEFAULT_FORBIDDEN_EDIT_PATHS,
  writeCapableAgents: WRITE_CAPABLE_AGENTS,
  sanitizedReaderAgent: MCP_SANITIZED_READER_AGENT,
  sanitizedReaderProfile: MCP_SANITIZED_READER_PROFILE,
  sanitizedReaderPromptSha256: MCP_SANITIZED_READER_PROMPT_SHA256,
  contractorOrchestratorAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  normalizePathForCompare,
  isPathInside,
});

const {
  listAvailableAgents,
  debugAgentExists,
  managedSkillPolicyError,
  managedSkillSourceEvidence,
  readAgentDebugMetadata,
  attestContractorNestedAgents,
  readAgentDefinition,
} = createAgentAttestation({
  safeOpenCodeCommand,
  parseAgentList,
  normalizeAgentDebugMetadata,
  managedAgentSourceProfile,
  contractorNestedAgentMetadataError,
  assertNoLinkedPath,
  sha256File,
  normalizePathForCompare,
  redactSensitiveText,
  summarizeStderr,
  openCodeAgentDir: OPENCODE_AGENT_DIR,
  openCodeSkillDir: OPENCODE_SKILL_DIR,
  defaultOpenCodeConfigDir: DEFAULT_OPENCODE_CONFIG_DIR,
  sanitizedReaderAgent: MCP_SANITIZED_READER_AGENT,
  requiredManagedAgents: REQUIRED_MANAGED_AGENTS,
  releaseRequiredManagedAgents: RELEASE_REQUIRED_MANAGED_AGENTS,
  requiredManagedSkills: REQUIRED_MANAGED_SKILLS,
  contractorAllowedSubagents: CONTRACTOR_ALLOWED_SUBAGENTS,
});

function windowsCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }

  const normalized = String(command || "").toLowerCase();
  if (["npm", "npx", "pnpm", "yarn"].includes(normalized)) {
    return `${command}.cmd`;
  }

  return command;
}

function formatValidationGateResult(validationGate) {
  if (!validationGate || validationGate.status === "skipped") {
    return "Validation gate: skipped";
  }

  return [
    `Validation gate: ${validationGate.status}`,
    `Validation command: ${validationGate.command || "not specified"}`,
    `Validation exit code: ${validationGate.exitCode}`,
    `Validation duration ms: ${validationGate.durationMs || 0}`,
    validationGate.stdout ? `Validation stdout:\n${validationGate.stdout}` : null,
    validationGate.stderr ? `Validation stderr:\n${validationGate.stderr}` : null,
  ].filter(Boolean).join("\n");
}

function availableAgentLabels(agents) {
  return [...agents.entries()].map(([name, mode]) => `${name} (${mode})`).sort();
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
    const manifest = JSON.parse(manifestContent.toString("utf8"));
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
    const discrepancies = [];
    for (const file of expectedFileList) if (!actualFiles.includes(file)) discrepancies.push({ type: "missing", path: file });
    for (const file of actualFiles) if (!expectedFileList.includes(file)) discrepancies.push({ type: "unexpected", path: file });
    for (const directory of expectedDirectoryList) if (!actualDirectories.includes(directory)) discrepancies.push({ type: "directory_missing", path: directory });
    for (const directory of actualDirectories) if (!expectedDirectoryList.includes(directory)) discrepancies.push({ type: "directory_unexpected", path: directory });
    const requiredFiles = (parsedContract.requiredFiles || []).map(normalizedManifestRelativePath);
    const forbiddenFiles = (parsedContract.forbiddenFiles || []).map(normalizedManifestRelativePath);
    if (requiredFiles.some((item) => !item) || forbiddenFiles.some((item) => !item)) {
      throw new Error("Sanitized workspace contract contains an unsafe required/forbidden path.");
    }
    for (const required of requiredFiles) if (!actualFiles.includes(required)) discrepancies.push({ type: "required_missing", path: required });
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

function buildSubagentProxyPrompt(requestedAgent, agentDefinition, taskPrompt) {
  return [
    `You are acting as the OpenCode subagent "${requestedAgent}" for a Codex MCP delegation.`,
    "",
    "OpenCode CLI cannot run this subagent as a top-level primary agent in this environment, so the bridge is proxying the role through a primary OpenCode agent.",
    "Follow the subagent definition below as the controlling role instructions for this task.",
    "",
    "===== SUBAGENT DEFINITION BEGIN =====",
    agentDefinition || `No local definition file was found for ${requestedAgent}. Follow the requested role name and task packet strictly.`,
    "===== SUBAGENT DEFINITION END =====",
    "",
    "===== CODEX TASK BEGIN =====",
    taskPrompt,
    "===== CODEX TASK END =====",
  ].join("\n");
}

async function resolveAgent(requestedAgent, cwd, allowFallbackToBuild = false, subagentStrategy = "reject", proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT, orchestratorMode = "", { forcePure = false, discoveryCwd = cwd, routeToSanitizedAgent = false } = {}) {
  const agent = sanitizeAgentName(requestedAgent);
  const normalizedAgent = agent.toLowerCase();
  const orchestratorRequest = ORCHESTRATOR_AGENT_ALIASES.has(normalizedAgent)
    || normalizedAgent === MCP_ORCHESTRATOR_AGENT.toLowerCase()
    || normalizedAgent === MCP_CONTRACTOR_ORCHESTRATOR_AGENT.toLowerCase();
  const normalizedOrchestratorMode = normalizeOrchestratorModeValue(orchestratorMode);
  const routedAgent = routeToSanitizedAgent
    ? MCP_SANITIZED_READER_AGENT
    : orchestratorRequest
      ? sanitizeAgentName(normalizedOrchestratorMode === "contractor" ? MCP_CONTRACTOR_ORCHESTRATOR_AGENT : MCP_ORCHESTRATOR_AGENT)
      : agent;
  const normalizedStrategy = String(subagentStrategy || "reject").trim().toLowerCase();
  const normalizedProxyAgent = sanitizeAgentName(proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT);
  const { result, agents } = await listAvailableAgents(discoveryCwd, { forcePure });
  let mode = agents.get(routedAgent);

  if (!mode) {
    mode = await debugAgentExists(routedAgent, discoveryCwd, { forcePure });
  }

  if (mode && mode !== "subagent") {
    return {
      requestedAgent: agent,
      requestedAgentMode: mode,
      actualAgent: routedAgent,
      actualAgentMode: mode,
      fallbackUsed: false,
      proxyUsed: false,
      subagentStrategy: "direct",
      routingReason: routeToSanitizedAgent
        ? `Manifest-pinned sanitized execution routes requested agent "${agent}" to bridge-owned role "${routedAgent}".`
        : routedAgent === agent
        ? ""
        : normalizedOrchestratorMode === "contractor"
          ? `Explicit contractor mode routes requested agent "${agent}" to MCP contractor agent "${routedAgent}".`
          : `MCP safety routing uses read-only agent "${routedAgent}" for requested agent "${agent}".`,
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (mode === "subagent") {
    if (normalizedStrategy === "reject") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" is a subagent. This OpenCode CLI version does not run subagents as top-level agents through "opencode run --agent ${agent}". Use subagentStrategy "proxy" to run it through "${DEFAULT_SUBAGENT_PROXY_AGENT}", or "direct" only if you want to test native CLI behavior.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    if (normalizedStrategy === "direct") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: routedAgent,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: null,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    let proxyMode = agents.get(normalizedProxyAgent);
    if (!proxyMode) {
      proxyMode = await debugAgentExists(normalizedProxyAgent, discoveryCwd, { forcePure });
    }

    if (!proxyMode || proxyMode === "subagent") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" is a subagent, but proxy agent "${normalizedProxyAgent}" is not an available primary/all agent.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    return {
      requestedAgent: agent,
      requestedAgentMode: mode,
      actualAgent: normalizedProxyAgent,
      actualAgentMode: proxyMode,
      fallbackUsed: false,
      proxyUsed: true,
      subagentStrategy: normalizedStrategy || "reject",
      proxyReason: `OpenCode CLI reports "${agent}" as a subagent, so the bridge is proxying it through "${normalizedProxyAgent}".`,
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (routeToSanitizedAgent) {
    return {
      requestedAgent: agent,
      requestedAgentMode: "missing",
      actualAgent: null,
      fallbackUsed: false,
      proxyUsed: false,
      subagentStrategy: "reject",
      error: `Bridge-managed sanitized agent "${MCP_SANITIZED_READER_AGENT}" was not found. Sanitized execution will not fall back to another role.`,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (orchestratorRequest) {
    return {
      requestedAgent: agent,
      requestedAgentMode: "missing",
      actualAgent: null,
      fallbackUsed: false,
      proxyUsed: false,
      subagentStrategy: normalizedStrategy,
      error: `MCP-safe orchestrator agent "${routedAgent}" was not found. The bridge will not fall back to a write-capable agent for orchestrator planning.`,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (allowFallbackToBuild) {
    let buildMode = agents.get("build");
    if (!buildMode) {
      buildMode = await debugAgentExists("build", discoveryCwd, { forcePure });
    }

    if (!buildMode || buildMode === "subagent") {
      return {
        requestedAgent: agent,
        requestedAgentMode: "missing",
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" was not found, and fallback agent "build" was also not found.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    return {
      requestedAgent: agent,
      requestedAgentMode: "missing",
      actualAgent: "build",
      actualAgentMode: buildMode,
      fallbackUsed: true,
      fallbackReason: `Requested agent "${agent}" was not found and fallback to "build" was explicitly allowed.`,
      proxyUsed: false,
      subagentStrategy: normalizedStrategy,
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  return {
    requestedAgent: agent,
    requestedAgentMode: "missing",
    actualAgent: null,
    fallbackUsed: false,
    proxyUsed: false,
    subagentStrategy: normalizedStrategy,
    error: `OpenCode agent "${agent}" was not found. Fallback to build was not used because allowFallbackToBuild is false.`,
    availableAgents: availableAgentLabels(agents),
    discoveryExitCode: result.exitCode,
  };
}

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
    const raw = JSON.parse(content);
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

function buildCompactPrompt(agent, task, delegation = {}) {
  if (!delegation || Object.keys(delegation).length === 0) {
    return task;
  }

  return [
    `Role: ${agent}`,
    "",
    `Task: ${task}`,
    "",
    "Scope:",
    Array.isArray(delegation.scope) ? normalizeList(delegation.scope).join("\n") || "Not specified." : "Not specified.",
    "",
    "Scope Contract:",
    formatScopeContractForPrompt(delegation.scopeContract) || "Not specified.",
    "",
    `Lock mode: ${delegation.lockMode || "not specified"}`,
    "",
    `Lock type: ${delegation.lockType || "not specified"}`,
    "",
    isOrchestratorAgent(agent) ? `OpenCode Orchestrator MCP Mode: ${delegation.orchestratorMode || "planning-only"}` : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode === "contractor"
      ? "Contractor mode was explicitly authorized by the user. Act as the contracted OpenCode lead: divide the bounded task, invoke appropriate OpenCode subagents, supervise their work, review and test the combined result, and return one consolidated report. All subagent edits must stay inside the granted Scope Contract and allowedEdits. Do not invoke another orchestrator."
      : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode !== "contractor"
      ? "Planning-only mode. Do not write files or invoke writer subagents. Return an implementation plan, affected paths, allowedEdits proposal, risks, tests, and direct follow-up builder/debugger jobs for Codex to run through MCP."
      : null,
    "",
    "Lock granted:",
    normalizeList(delegation.lockedPaths).join("\n") || "Not specified.",
    "",
    "Allowed edits:",
    normalizeList(delegation.allowedEdits).join("\n") || "none",
    "",
    "Forbidden edits:",
    normalizeList(delegation.forbiddenEdits).join("\n") || "none specified",
    "",
    `Shared files frozen: ${normalizeList(delegation.sharedFiles).join(", ") || "Not specified."}`,
    "",
    "Permissions:",
    delegation.permissions || "Not specified.",
    delegation.orchestratorMode === "contractor"
      ? "The contractor parent shell is denied. Delegate repository commands or validation to one of the authorized bounded subagents, then still return the required final response."
      : "For shell diagnostics, invoke each allowlisted command separately. Never combine commands with &&, ;, pipes, command substitution, redirection, or shell wrappers. If a command is denied, continue with available read tools and still return the required final response.",
    "",
    `Validation command: ${delegation.validationCommand || "Not specified."}`,
    "",
    "If you need files outside the lock:",
    "Do not edit them. Return NEEDS_INTEGRATION with the file/path needed, reason, and recommended change.",
    "",
    "Return format:",
    delegation.returnFormat || DEFAULT_RETURN_FORMAT,
  ].join("\n");
}

function openCodeRunArgs(agent, prompt, metadata = null, { forcePure = false } = {}) {
  const args = ["--print-logs", "--log-level", "ERROR"];
  if (forcePure || !CONFIG.allowExternalPlugins) {
    args.push("--pure");
  }
  args.push("run");
  args.push("--format", "json", "--title", "Codex MCP bridge task", "--agent", agent);
  if (metadata?.provider && metadata?.model) {
    args.push("--model", `${metadata.provider}/${metadata.model}`);
  }
  if (metadata?.variant) {
    args.push("--variant", metadata.variant);
  }
  args.push(prompt);
  return args;
}

function commandShape(agent, metadata = null, { forcePure = false } = {}) {
  const pluginMode = forcePure || !CONFIG.allowExternalPlugins ? " --pure" : "";
  const model = metadata?.provider && metadata?.model ? ` --model ${metadata.provider}/${metadata.model}` : "";
  const variant = metadata?.variant ? ` --variant ${metadata.variant}` : "";
  return `${OPENCODE_EXE} --print-logs --log-level ERROR run${pluginMode} --format json --title "Codex MCP bridge task" --agent ${agent}${model}${variant} <prompt>`;
}

function timeoutForAgent(agent, lockPlan, requestedTimeoutMs = null) {
  const explicit = Number(requestedTimeoutMs);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const normalizedAgent = String(agent || "").toLowerCase();
  if (["builder", "debugger"].includes(normalizedAgent)) {
    return defaultBuilderTimeoutMs;
  }

  if (lockPlan?.orchestratorMode === "contractor") {
    return defaultContractorOrchestratorTimeoutMs;
  }

  if (isOrchestratorAgent(normalizedAgent)) {
    return defaultOrchestratorTimeoutMs;
  }

  return lockPlan?.lockType === "read" ? defaultReadOnlyAgentTimeoutMs : defaultWriteAgentTimeoutMs;
}

function isTimeoutResult(result) {
  return result?.timedOut || result?.exitCode === 124 || result?.exitCode === "timeout";
}

function classifyResultError(result) {
  if (!result) {
    return null;
  }

  if (result.cancelled) {
    return "agent_cancelled";
  }

  if (result.rawOutputTruncated || result.assistantResponseTruncated) {
    return "essential_output_truncated";
  }

  if (result.providerErrorType) {
    return result.providerErrorType;
  }

  if (result.openCodeFallbackDetected) {
    return "opencode_native_fallback";
  }

  if (result.openCodeApiErrorDetected) {
    return "opencode_api_error";
  }

  if (isTimeoutResult(result)) {
    return "agent_timeout";
  }

  if (result.exitCode !== 0) {
    return "agent_exit_nonzero";
  }

  if (!result.dryRun && !result.assistantFinalResponseDetected) {
    return "agent_empty_final_response";
  }

  return null;
}

async function runOpenCode(agent, prompt, cwd, dryRun = false, timeoutMs = defaultWriteAgentTimeoutMs, { signal = null, agentMetadata = null, metadataPolicyOptions = {}, forcePure = false, onSpawn = null } = {}) {
  const workDir = cwd || process.cwd();
  const started = nowMs();
  const metadataResult = agentMetadata || await readAgentDebugMetadata(agent, workDir, { forcePure });
  let configuredMetadata = metadataResult?.metadata || null;

  if (dryRun) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: true,
      timeoutMs,
      timedOut: false,
      errorType: null,
      openCodeFallbackDetected: false,
      openCodeApiErrorDetected: false,
      recoveredTransientProviderError: false,
      providerWarningType: "",
      assistantFinalResponseDetected: true,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      runtimeObservedProvider: "",
      runtimeObservedModel: "",
      modelFallbackAllowed: false,
    };
  }

  const pluginPolicy = forcePure ? { ok: true, mode: "pure", plugins: [] } : await verifyExternalPluginPolicy(workDir);
  if (!pluginPolicy.ok) {
    return {
      stdout: "",
      stderr: pluginPolicy.error,
      exitCode: "plugin_policy_rejected",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: pluginPolicy.errorType,
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }

  const providerKey = CONFIG.providerConcurrencyKey;
  const providerWaitBudgetMs = Math.max(1, timeoutMs - (nowMs() - started));
  const providerLease = await acquireProviderLease({ providerKey, timeoutMs: providerWaitBudgetMs, signal });
  if (!providerLease.ok) {
    return {
      stdout: "",
      stderr: providerLease.error,
      exitCode: "provider_capacity_unavailable",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: providerLease.errorType,
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }
  const stopProviderLeaseHeartbeat = startProviderLeaseHeartbeat(providerLease.lease);

  let remainingRunMs = timeoutMs - (nowMs() - started);
  if (remainingRunMs <= 0) {
    stopProviderLeaseHeartbeat();
    await releaseProviderLease(providerLease.lease);
    return {
      stdout: "",
      stderr: "The overall OpenCode attempt deadline expired while waiting for provider capacity.",
      exitCode: 124,
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      timedOut: true,
      errorType: "agent_timeout",
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }

  const preSpawnPluginPolicy = forcePure ? { ok: true, mode: "pure", plugins: [] } : await verifyExternalPluginPolicy(workDir);
  if (!preSpawnPluginPolicy.ok) {
    stopProviderLeaseHeartbeat();
    await releaseProviderLease(providerLease.lease);
    return {
      stdout: "",
      stderr: preSpawnPluginPolicy.error,
      exitCode: "plugin_policy_rejected",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: preSpawnPluginPolicy.errorType,
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }
  let isolatedRuntime = null;
  if (forcePure) {
    try {
      isolatedRuntime = await createIsolatedOpenCodeRuntime();
    } catch (error) {
      stopProviderLeaseHeartbeat();
      await releaseProviderLease(providerLease.lease);
      return {
        stdout: "",
        stderr: `Isolated OpenCode runtime setup failed: ${redactSensitiveText(error.message || String(error))}`,
        exitCode: "isolated_runtime_setup_failed",
        durationMs: nowMs() - started,
        commandShape: commandShape(agent, configuredMetadata, { forcePure }),
        dryRun: false,
        timeoutMs,
        errorType: "isolated_runtime_setup_failed",
        assistantFinalResponseDetected: false,
        providerErrorType: "",
        toolOutcomes: [],
        configuredProvider: configuredMetadata?.provider || "",
        configuredModel: configuredMetadata?.model || "",
        configuredVariant: configuredMetadata?.variant || "",
        modelFallbackAllowed: false,
      };
    }
  }
  const finalPreSpawnMetadata = await readAgentDebugMetadata(agent, workDir, { forcePure, runtimeContext: isolatedRuntime });
  const finalPreSpawnMetadataError = effectiveReadOnlyMetadataError(finalPreSpawnMetadata, null, {
    expectedAgent: agent,
    expectedMode: configuredMetadata?.mode || "",
    expectedMetadata: configuredMetadata,
    ...metadataPolicyOptions,
  });
  if (finalPreSpawnMetadataError) {
    const cleanup = isolatedRuntime ? await wipeIsolatedOpenCodeRuntime(isolatedRuntime.root) : { ok: true, error: "" };
    stopProviderLeaseHeartbeat();
    await releaseProviderLease(providerLease.lease);
    return {
      stdout: "",
      stderr: cleanup.ok ? finalPreSpawnMetadataError.error : `Isolated OpenCode runtime cleanup failed: ${cleanup.error}`,
      exitCode: cleanup.ok ? "agent_policy_rejected" : "isolated_runtime_cleanup_failed",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: cleanup.ok ? finalPreSpawnMetadataError.errorType : "isolated_runtime_cleanup_failed",
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }
  configuredMetadata = finalPreSpawnMetadata.metadata;
  remainingRunMs = timeoutMs - (nowMs() - started);
  if (remainingRunMs <= 0) {
    const cleanup = isolatedRuntime ? await wipeIsolatedOpenCodeRuntime(isolatedRuntime.root) : { ok: true, error: "" };
    stopProviderLeaseHeartbeat();
    await releaseProviderLease(providerLease.lease);
    return {
      stdout: "",
      stderr: cleanup.ok ? "The overall OpenCode attempt deadline expired during the final plugin-integrity check." : `Isolated OpenCode runtime cleanup failed: ${cleanup.error}`,
      exitCode: cleanup.ok ? 124 : "isolated_runtime_cleanup_failed",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      timedOut: true,
      errorType: cleanup.ok ? "agent_timeout" : "isolated_runtime_cleanup_failed",
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }

  let result;
  let isolatedRuntimeCleanup = { ok: true, error: "" };
  try {
    result = await runSpawnCommand(
      OPENCODE_EXE,
      openCodeRunArgs(agent, prompt, configuredMetadata, { forcePure }),
      workDir,
      remainingRunMs,
      isolatedRuntime?.env || buildOpenCodeEnv(),
      { signal, terminateOnProviderError: true, onSpawn }
    );
  } finally {
    stopProviderLeaseHeartbeat();
    await releaseProviderLease(providerLease.lease);
    if (isolatedRuntime) isolatedRuntimeCleanup = await wipeIsolatedOpenCodeRuntime(isolatedRuntime.root);
  }
  if (!isolatedRuntimeCleanup.ok) {
    result = {
      ...result,
      stderr: `${String(result?.stderr || "")}\nIsolated OpenCode runtime cleanup failed: ${isolatedRuntimeCleanup.error}`.trim(),
      exitCode: "isolated_runtime_cleanup_failed",
    };
  }

  const openCodeFallbackDetected = detectsOpenCodeFallback(result.stderr);
  const inspection = inspectOpenCodeEventStream(result.stdout, result.stderr);
  const runResult = {
    stdout: redactSensitiveText(inspection.finalText),
    stderr: summarizeStderr(result.stderr),
    exitCode: result.exitCode,
    durationMs: nowMs() - started,
    commandShape: commandShape(agent, configuredMetadata, { forcePure }),
    dryRun: false,
    timeoutMs,
    timedOut: isTimeoutResult(result),
    cancelled: Boolean(result.cancelled),
    providerTerminated: Boolean(result.providerTerminated),
    openCodeFallbackDetected,
    openCodeApiErrorDetected: inspection.apiErrorDetected,
    providerErrorType: inspection.providerErrorType,
    recoveredTransientProviderError: inspection.recoveredTransientProviderError,
    providerWarningType: inspection.providerWarningType,
    retryAfterMs: inspection.retryAfterMs || 0,
    assistantFinalResponseDetected: inspection.finalResponseDetected,
    assistantResponseTruncated: inspection.finalTextTruncated,
    toolOutcomes: inspection.toolOutcomes,
    parsedEventCount: inspection.parsedEvents,
    invalidEventLineCount: inspection.invalidLines,
    rawOutputTruncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
    rawStdoutChars: result.stdoutChars || 0,
    rawStderrChars: result.stderrChars || 0,
    rawStdoutSha256: result.stdoutSha256 || "",
    rawStderrSha256: result.stderrSha256 || "",
    configuredProvider: configuredMetadata?.provider || "",
    configuredModel: configuredMetadata?.model || "",
    configuredVariant: configuredMetadata?.variant || "",
    runtimeObservedProvider: inspection.runtimeObservedProvider || "",
    runtimeObservedModel: inspection.runtimeObservedModel || "",
    modelFallbackAllowed: false,
    providerConcurrencyKey: providerKey,
    providerConcurrencyWaitMs: providerLease.waitedMs || 0,
    childStartedAtMs: result.childStartedAtMs || 0,
    childFinishedAtMs: result.childFinishedAtMs || 0,
    childExecutionIntervals: result.childStartedAtMs && result.childFinishedAtMs
      ? [{ startedAtMs: result.childStartedAtMs, finishedAtMs: result.childFinishedAtMs }]
      : [],
  };
  const runtimeModelEvidencePresent = Boolean(runResult.runtimeObservedProvider && runResult.runtimeObservedModel);
  runResult.actualProvider = runtimeModelEvidencePresent ? runResult.runtimeObservedProvider : "not_runtime_emitted";
  runResult.actualModel = runtimeModelEvidencePresent ? runResult.runtimeObservedModel : "not_runtime_emitted";
  runResult.actualModelEvidence = runtimeModelEvidencePresent ? "authoritative_runtime_event" : "unavailable_in_opencode_json_stream";
  runResult.modelAttested = runtimeModelEvidencePresent
    && runResult.runtimeObservedProvider === runResult.configuredProvider
    && runResult.runtimeObservedModel === runResult.configuredModel;
  runResult.exactCliModelPin = configuredMetadata?.provider && configuredMetadata?.model
    ? `${configuredMetadata.provider}/${configuredMetadata.model}`
    : "";
  runResult.errorType = classifyResultError(runResult);
  if (!runResult.errorType && runtimeModelEvidencePresent && !runResult.modelAttested) {
    runResult.errorType = "opencode_model_mismatch";
  }
  return runResult;
}

function readOnlyResultRetryable(result, agent = "", agentMetadata = null) {
  if (!result || result.cancelled || result.rawOutputTruncated || result.assistantResponseTruncated) {
    return false;
  }
  if (!isManagedReadOnlyAgent(agent) || !agentMetadata?.ok || agentMetadata.metadata?.canEdit || agentMetadata.metadata?.canDelegate || !agentMetadata.metadata?.externalDirectoryDenied) {
    return false;
  }
  if (["opencode_auth_error", "opencode_quota_exhausted", "opencode_billing_error", "opencode_model_error"].includes(result.providerErrorType || result.errorType || "")) {
    return false;
  }
  if ((result.toolOutcomes || []).length || result.invalidEventLineCount > 0 || result.assistantFinalResponseDetected) {
    return false;
  }
  return isTimeoutResult(result) || [
    "opencode_rate_limited",
    "opencode_transient_provider_error",
    "opencode_provider_unavailable",
    "opencode_transport_error",
  ].includes(result.providerErrorType || result.errorType || "");
}

async function runOpenCodeWithPolicy(agent, prompt, cwd, dryRun, lockPlan, requestedTimeoutMs = null, { signal = null, agentMetadata = null, onSpawn = null } = {}) {
  const timeoutMs = timeoutForAgent(agent, lockPlan, requestedTimeoutMs);
  const forcePure = Boolean(lockPlan?.sanitizedWorkspace);
  const metadataPolicyOptions = {
    expectedAgent: agent,
    expectedMode: agentMetadata?.metadata?.mode || "",
    expectedMetadata: agentMetadata?.metadata || null,
    allowDelegation: lockPlan?.orchestratorMode === "contractor"
      && lockPlan?.contractorAuthorizationVerified
      && String(agent || "").toLowerCase() === MCP_CONTRACTOR_ORCHESTRATOR_AGENT.toLowerCase(),
  };

  if (lockPlan?.lockType !== "read") {
    const result = await runOpenCode(agent, prompt, cwd, dryRun, timeoutMs, { signal, agentMetadata, metadataPolicyOptions, forcePure, onSpawn });
    result.retryAttempt = 0;
    result.maxRetries = 0;
    logOpenCodeResult(agent, result, lockPlan);
    return result;
  }

  let lastResult = null;
  const childExecutionIntervals = [];
  const policyStarted = nowMs();
  for (let attempt = 0; attempt <= maxReadOnlyAgentRetries; attempt += 1) {
    const elapsedMs = nowMs() - policyStarted;
    const remainingBudgetMs = CONFIG.readOnlyRetryMaxElapsedMs - elapsedMs;
    if (remainingBudgetMs <= 0) break;
    lastResult = await runOpenCode(agent, prompt, cwd, dryRun, Math.min(timeoutMs, remainingBudgetMs), { signal, agentMetadata, metadataPolicyOptions, forcePure, onSpawn });
    childExecutionIntervals.push(...(lastResult.childExecutionIntervals || []));
    lastResult.childExecutionIntervals = [...childExecutionIntervals];
    lastResult.retryAttempt = attempt;
    lastResult.maxRetries = maxReadOnlyAgentRetries;
    logOpenCodeResult(agent, lastResult, lockPlan);
    if (!readOnlyResultRetryable(lastResult, agent, agentMetadata) || attempt >= maxReadOnlyAgentRetries) {
      return lastResult;
    }
    const exponential = CONFIG.readOnlyRetryBaseDelayMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 2)));
    const delayMs = Math.max(lastResult.retryAfterMs || 0, exponential + jitter);
    if (nowMs() - policyStarted + delayMs >= CONFIG.readOnlyRetryMaxElapsedMs) {
      break;
    }
    try {
      await delayWithSignal(delayMs, signal);
    } catch {
      return { ...lastResult, cancelled: true, errorType: "agent_cancelled" };
    }
  }

  return {
    ...lastResult,
    readOnlyUnavailable: true,
    errorType: "read_only_agent_unavailable",
    stderr: [
      lastResult?.stderr || "",
      `Read-only agent remained unavailable after ${maxReadOnlyAgentRetries + 1} bounded attempts and was marked unavailable.`,
    ].filter(Boolean).join("\n"),
  };
}

function logOpenCodeResult(agent, result, lockPlan = null) {
  const level = result?.errorType ? "warn" : "info";
  logEvent(level, "opencode.agent_result", {
    agent,
    command: result?.commandShape,
    durationMs: result?.durationMs ?? 0,
    lockMode: lockPlan?.lockMode || "unknown",
    lockType: lockPlan?.lockType || "unknown",
    retries: result?.retryAttempt ?? 0,
    maxRetries: result?.maxRetries ?? 0,
    exitCode: result?.exitCode ?? "not run",
    timedOut: Boolean(result?.timedOut),
    dryRun: Boolean(result?.dryRun),
  });
}

function formatSingleResult({ resolution, result, cwd, lockPlan = null }) {
  return [
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
    `Recovered transient provider error: ${result?.recoveredTransientProviderError ? "yes" : "no"}`,
    `Provider warning type: ${result?.providerWarningType || "none"}`,
    `Configured provider: ${result?.configuredProvider || "unknown"}`,
    `Configured model: ${result?.configuredModel || "unknown"}`,
    `Configured variant: ${result?.configuredVariant || "unknown"}`,
    `Runtime-observed provider: ${result?.runtimeObservedProvider || "not emitted"}`,
    `Runtime-observed model: ${result?.runtimeObservedModel || "not emitted"}`,
    `Actual provider used: ${result?.actualProvider || "unknown"}`,
    `Actual model used: ${result?.actualModel || "unknown"}`,
    `Actual model evidence: ${result?.actualModelEvidence || "unavailable"}`,
    "Silent model fallback: disabled",
    `Provider/account concurrency key: ${result?.providerConcurrencyKey || "not acquired"}`,
    `Provider capacity wait ms: ${result?.providerConcurrencyWaitMs || 0}`,
    `Assistant final response detected: ${result?.assistantFinalResponseDetected ? "yes" : "no"}`,
    `Assistant response truncated: ${result?.assistantResponseTruncated ? "yes" : "no"}`,
    `Raw process output truncated: ${result?.rawOutputTruncated ? "yes" : "no"}`,
    resolution.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Working directory: ${cwd || process.cwd()}`,
    result?.worktree ? `Worktree path: ${result.worktree.path}` : null,
    result?.worktree ? `Worktree branch: ${result.worktree.branch}` : null,
    result?.worktree ? `Worktree cleanup: ${result.worktree.cleanup}` : null,
    `Command shape: ${result?.commandShape || "not run"}`,
    `Dry run: ${result?.dryRun ? "yes" : "no"}`,
    `Error type: ${result?.errorType || "none"}`,
    result?.timedOut ? `Agent timeout: ${resolution.actualAgent || resolution.requestedAgent}` : null,
    `Timeout ms: ${result?.timeoutMs ?? "not specified"}`,
    `Timed out: ${result?.timedOut ? "yes" : "no"}`,
    `Read-only unavailable: ${result?.readOnlyUnavailable ? "yes" : "no"}`,
    `Retry attempts used: ${result?.retryAttempt ?? 0}`,
    `Max retries: ${result?.maxRetries ?? 0}`,
    `Lock mode: ${lockPlan?.lockMode || "not specified"}`,
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
    `Files changed: ${result?.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
    `Exit code: ${result?.exitCode ?? "not run"}`,
    `Duration ms: ${result?.durationMs ?? 0}`,
    "",
    `Tool outcomes: ${result?.toolOutcomes?.length ? result.toolOutcomes.map((item) => `${item.tool}:${item.status}`).join(", ") : "none"}`,
    "",
    "Assistant final response:",
    result?.stdout || "",
    "",
    "STDERR summary:",
    summarizeStderr(result?.stderr),
  ].join("\n");
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
}) {
  const conflicts = normalizeLockPathList(conflictingPaths);
  const normalizedDirtyFiles = Array.isArray(dirtyFiles) ? normalizeLockPathList(dirtyFiles) : null;
  const normalizedOverlappingFiles = Array.isArray(overlappingFiles) ? normalizeLockPathList(overlappingFiles) : null;
  const normalizedDisjointFiles = Array.isArray(disjointFiles) ? normalizeLockPathList(disjointFiles) : null;
  return [
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
    `conflictingPaths: ${conflicts.length ? conflicts.join(", ") : "none"}`,
    normalizedDirtyFiles ? `dirtyFiles: ${normalizedDirtyFiles.length ? normalizedDirtyFiles.join(", ") : "none"}` : null,
    normalizedOverlappingFiles ? `overlappingFiles: ${normalizedOverlappingFiles.length ? normalizedOverlappingFiles.join(", ") : "none"}` : null,
    normalizedDisjointFiles ? `disjointFiles: ${normalizedDisjointFiles.length ? normalizedDisjointFiles.join(", ") : "none"}` : null,
    lockedPaths.length ? `lockedPaths: ${normalizeLockPathList(lockedPaths).join(", ")}` : null,
    allowedEdits.length ? `allowedEdits: ${normalizeLockPathList(allowedEdits).join(", ")}` : null,
    scope ? `scope: ${JSON.stringify(scope)}` : null,
    changedFiles.length ? `changedFiles: ${normalizeLockPathList(changedFiles).join(", ")}` : null,
    runId ? `runId: ${runId}` : null,
    rollback ? `rollback: ${rollback}` : null,
    disallowedFiles.length ? `disallowedFiles: ${normalizeLockPathList(disallowedFiles).join(", ")}` : null,
    serialOnlyMatches.length ? `serialOnlyMatches: ${serialOnlyMatches.join(", ")}` : null,
    rollbackFiles.length ? `rollbackFiles: ${normalizeLockPathList(rollbackFiles).join(", ")}` : null,
    unresolvedFiles.length ? `unresolvedFiles: ${normalizeLockPathList(unresolvedFiles).join(", ")}` : null,
  ].filter(Boolean).join("\n");
}

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

async function gitChangedFiles(cwd, { includeIgnored = false } = {}) {
  const commands = [
    runGitReadOnlyCommand(["diff", "--name-only"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["diff", "--cached", "--name-only"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["ls-files", "--others", "--exclude-standard"], cwd, 1000 * 15),
  ];
  if (includeIgnored) {
    commands.push(runGitReadOnlyCommand(["ls-files", "--others", "--ignored", "--exclude-standard"], cwd, 1000 * 30));
  }
  const [workingTreeDiff, stagedDiff, untracked, ignored] = await Promise.all(commands);
  const failedChecks = [
    ["working tree", workingTreeDiff],
    ["staged files", stagedDiff],
    ["untracked files", untracked],
    ...(ignored ? [["ignored files", ignored]] : []),
  ].filter(([, result]) => result.exitCode !== 0);
  if (failedChecks.length) {
    const details = failedChecks
      .map(([label, result]) => `${label}: ${summarizeStderr(result.stderr || result.stdout) || `exit ${result.exitCode}`}`)
      .join("; ");
    throw new Error(`Git changed-file inspection failed closed (${details}).`);
  }

  return [
    ...new Set(
      [workingTreeDiff.stdout, stagedDiff.stdout, untracked.stdout, ignored?.stdout || ""]
        .join("\n")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].sort();
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

async function fileFingerprint(cwd, file, { metadataOnly = false } = {}) {
  const base = cwd || process.cwd();
  try {
    if (metadataOnly) {
      const details = await lstat(path.resolve(base, file));
      return `metadata:${details.size}:${details.mtimeMs}:${details.ctimeMs}:${details.mode}:${details.isSymbolicLink() ? "link" : "file"}`;
    }
    const content = await readFile(path.resolve(base, file));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "missing";
  }
}

async function exactIntegrationFileSnapshot(cwd, files) {
  const snapshot = new Map();
  let totalBytes = 0;
  for (const file of normalizeLockPathList(files)) {
    const absolute = path.resolve(cwd || process.cwd(), file);
    try {
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        snapshot.set(file, `link:${await readlink(absolute)}`);
        continue;
      }
      if (!details.isFile()) {
        const error = new Error(`Integration evidence contains an unsupported non-file path: ${file}`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      if (details.size > CONFIG.maxSnapshotFileBytes) {
        const error = new Error(`Integration file ${file} is ${details.size} bytes, above CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES=${CONFIG.maxSnapshotFileBytes}; exact rollback evidence is unavailable.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      totalBytes += details.size;
      if (totalBytes > CONFIG.maxSnapshotTotalBytes) {
        const error = new Error(`Integration evidence exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      const content = await readFile(absolute);
      snapshot.set(file, `file:${details.mode & 0o111}:${createHash("sha256").update(content).digest("hex")}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        snapshot.set(file, "missing");
        continue;
      }
      throw error;
    }
  }
  return snapshot;
}

function snapshotMismatches(expected, actual, files) {
  return normalizeLockPathList(files).filter((file) => expected.get(file) !== actual.get(file));
}

function regularFileFingerprint(value) {
  const match = /^file:(\d+):([0-9a-f]{64})$/.exec(String(value || ""));
  return match ? { mode: match[1], sha256: match[2] } : null;
}

function crlfToLfBytes(content) {
  const output = Buffer.allocUnsafe(content.length);
  let outputLength = 0;
  let converted = false;
  for (let index = 0; index < content.length; index += 1) {
    const byte = content[index];
    if (byte === 0x0d) {
      if (content[index + 1] !== 0x0a) return null;
      output[outputLength] = 0x0a;
      outputLength += 1;
      index += 1;
      converted = true;
      continue;
    }
    output[outputLength] = byte;
    outputLength += 1;
  }
  return converted ? output.subarray(0, outputLength) : null;
}

function gitEolRecordsFromOutput(stdout) {
  const records = new Map();
  for (const record of String(stdout || "").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const file = normalizeLockPath(record.slice(separator + 1));
    if (file) records.set(file, record.slice(0, separator));
  }
  return records;
}

async function integrationContentMismatches(cwd, expected, actual, files, { eolRecords = null } = {}) {
  const mismatches = [];
  for (const file of normalizeLockPathList(files)) {
    const expectedValue = expected.get(file);
    const actualValue = actual.get(file);
    if (expectedValue === actualValue) continue;
    const expectedFile = regularFileFingerprint(expectedValue);
    const actualFile = regularFileFingerprint(actualValue);
    if (!expectedFile || !actualFile || expectedFile.mode !== actualFile.mode) {
      mismatches.push(file);
      continue;
    }
    let eolRecord = eolRecords instanceof Map ? String(eolRecords.get(file) || "") : "";
    if (!(eolRecords instanceof Map)) {
      const eol = await runGitReadOnlyCommand(["ls-files", "--eol", "-z", "--", file], cwd, 1000 * 15);
      eolRecord = eol.exitCode === 0 ? (String(eol.stdout || "").split("\0").find(Boolean) || "") : "";
    }
    if (!/^i\/lf\s+w\/crlf\s+/.test(eolRecord)) {
      mismatches.push(file);
      continue;
    }
    try {
      const content = await readFile(path.resolve(cwd, file));
      const physicalSha256 = createHash("sha256").update(content).digest("hex");
      const normalized = physicalSha256 === actualFile.sha256 ? crlfToLfBytes(content) : null;
      const normalizedSha256 = normalized ? createHash("sha256").update(normalized).digest("hex") : "";
      if (normalizedSha256 !== expectedFile.sha256) mismatches.push(file);
    } catch {
      mismatches.push(file);
    }
  }
  return mismatches;
}

function changedPathSetEvidence(expectedFiles, actualFiles) {
  const expected = normalizeLockPathList(expectedFiles);
  const actual = normalizeLockPathList(actualFiles);
  const expectedKeys = new Set(expected.map(normalizeFilesystemCase));
  const actualKeys = new Set(actual.map(normalizeFilesystemCase));
  return {
    missingFiles: expected.filter((file) => !actualKeys.has(normalizeFilesystemCase(file))),
    unexpectedFiles: actual.filter((file) => !expectedKeys.has(normalizeFilesystemCase(file))),
  };
}

async function shouldAvoidSnapshotContent(cwd, file) {
  if (isWithinAnyPath(file, DEFAULT_FORBIDDEN_EDIT_PATHS, cwd)) {
    return true;
  }
  try {
    const details = await lstat(path.resolve(cwd || process.cwd(), file));
    return details.size > CONFIG.maxSnapshotFileBytes || details.isSymbolicLink();
  } catch {
    return false;
  }
}

async function gitChangedFileSnapshot(cwd, { includeIgnored = true } = {}) {
  const ordinaryFiles = await gitChangedFiles(cwd, { includeIgnored: false });
  const allFiles = includeIgnored ? await gitChangedFiles(cwd, { includeIgnored: true }) : ordinaryFiles;
  const ordinarySet = new Set(ordinaryFiles);
  const ignoredFiles = allFiles.filter((file) => !ordinarySet.has(file));
  if (allFiles.length > CONFIG.maxSnapshotFiles) {
    const error = new Error(`Changed-file snapshot limit exceeded: ${allFiles.length} files exceeds CODEX_OPENCODE_MAX_SNAPSHOT_FILES=${CONFIG.maxSnapshotFiles}.`);
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  if (ignoredFiles.length > CONFIG.maxIgnoredSnapshotFiles) {
    const error = new Error(`Ignored-file snapshot limit exceeded: ${ignoredFiles.length} files exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${CONFIG.maxIgnoredSnapshotFiles}.`);
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  const snapshot = new Map();
  for (const file of ordinaryFiles) {
    snapshot.set(file, await fileFingerprint(cwd, file, { metadataOnly: await shouldAvoidSnapshotContent(cwd, file) }));
  }
  for (const file of ignoredFiles) {
    snapshot.set(file, await fileFingerprint(cwd, file, { metadataOnly: true }));
  }
  return snapshot;
}

function changedFilesBetween(before, after) {
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  return files.filter((file) => before.get(file) !== after.get(file));
}

function snapshotIdentitySha256(snapshot) {
  const hash = createHash("sha256");
  for (const [file, fingerprint] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(file);
    hash.update("\0");
    hash.update(String(fingerprint));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readFileIfExists(filePath) {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile()) return { exists: true, content: null, restorable: false };
    return { exists: true, content: await readFile(filePath), mode: details.mode & 0o111, restorable: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { exists: false, content: null };
  }
}

async function captureRollbackBaseline(cwd) {
  const base = cwd || process.cwd();
  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], base, 1000 * 15);
  if (baseCommitResult.exitCode !== 0 || !baseCommitResult.stdout.trim()) {
    const error = new Error("Rollback snapshot could not pin the repository base commit.");
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  const ordinaryFiles = await gitChangedFiles(base, { includeIgnored: false });
  const allFiles = await gitChangedFiles(base, { includeIgnored: true });
  const ordinarySet = new Set(ordinaryFiles);
  const ignoredFiles = allFiles.filter((file) => !ordinarySet.has(file));
  if (allFiles.length > CONFIG.maxSnapshotFiles) {
    throw new Error(`Rollback snapshot limit exceeded: ${allFiles.length} files exceeds CODEX_OPENCODE_MAX_SNAPSHOT_FILES=${CONFIG.maxSnapshotFiles}.`);
  }
  if (ignoredFiles.length > CONFIG.maxIgnoredSnapshotFiles) {
    throw new Error(`Ignored-file rollback limit exceeded: ${ignoredFiles.length} files exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${CONFIG.maxIgnoredSnapshotFiles}.`);
  }
  const preExisting = new Map();
  let totalRestorableBytes = 0;
  for (const file of ordinaryFiles) {
    if (await shouldAvoidSnapshotContent(base, file)) {
      preExisting.set(file, { exists: true, content: null, restorable: false, protected: true });
    } else {
      const captured = await readFileIfExists(path.resolve(base, file));
      totalRestorableBytes += captured.content?.length || 0;
      if (totalRestorableBytes > CONFIG.maxSnapshotTotalBytes) {
        const error = new Error(`Rollback snapshot byte limit exceeded: ${totalRestorableBytes} bytes exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      preExisting.set(file, captured);
    }
  }
  for (const file of ignoredFiles) {
    preExisting.set(file, { exists: true, content: null, restorable: false, ignored: true });
  }
  return { cwd: base, baseCommit: baseCommitResult.stdout.trim(), totalRestorableBytes, preExisting };
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function safeRollbackParent(cwd, target) {
  const base = path.resolve(cwd || process.cwd());
  const parent = path.dirname(path.resolve(target));
  if (parent !== base && !isPathInside(base, parent)) throw new Error("Rollback target escaped the repository root.");
  await assertNoLinkedPath(parent, "Rollback parent");
  const [realBase, realParent] = await Promise.all([realpath(base), realpath(parent)]);
  if (realParent !== realBase && !isPathInside(realBase, realParent)) throw new Error("Rollback parent resolved outside the repository root.");
  return parent;
}

async function removeRollbackLeaf(target) {
  try {
    const details = await lstat(target);
    if (details.isDirectory() && !details.isSymbolicLink()) return false;
    await rm(target, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function replaceRollbackLeaf({ cwd, target, kind, content, mode = 0 }) {
  const parent = await safeRollbackParent(cwd, target);
  if (!await removeRollbackLeaf(target)) return false;
  const temporary = path.join(parent, `.codex-rollback-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    if (kind === "link") {
      await symlink(String(content), temporary, process.platform === "win32" ? "file" : undefined);
    } else {
      await writeFile(temporary, content, { flag: "wx", mode: mode ? 0o755 : 0o644 });
      await chmod(temporary, mode ? 0o755 : 0o644);
    }
    await assertNoLinkedPath(parent, "Rollback parent");
    await rename(temporary, target);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

async function restoreFromGitHead(cwd, file, baseCommit = "HEAD") {
  try {
    const normalizedFile = file.replace(/\\/g, "/");
    const entry = await runCommand("git", ["ls-tree", "-z", baseCommit, "--", normalizedFile], cwd || process.cwd(), 1000 * 15, buildValidationEnv());
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec((entry.stdout || "").split("\0")[0] || "");
    if (entry.exitCode !== 0 || !match) return false;
    const [, gitMode, objectId] = match;
    const result = await execFileAsync("git", ["cat-file", "blob", objectId], {
      cwd: cwd || process.cwd(),
      shell: false,
      timeout: 1000 * 15,
      maxBuffer: 1024 * 1024 * 30,
      encoding: "buffer",
    });
    const target = path.resolve(cwd || process.cwd(), file);
    await ensureParentDir(target);
    const restored = await replaceRollbackLeaf({
      cwd,
      target,
      kind: gitMode === "120000" ? "link" : "file",
      content: gitMode === "120000" ? result.stdout.toString("utf8") : result.stdout,
      mode: gitMode === "100755" ? 0o111 : 0,
    });
    if (!restored) return false;
    const actual = await exactIntegrationFileSnapshot(cwd || process.cwd(), [file]);
    const expected = gitMode === "120000"
      ? `link:${result.stdout.toString("utf8")}`
      : `file:${gitMode === "100755" ? 0o111 : 0}:${createHash("sha256").update(result.stdout).digest("hex")}`;
    return actual.get(normalizeLockPath(file)) === expected;
  } catch {
    return false;
  }
}

async function fileExistsInGitCommit(cwd, file, baseCommit = "HEAD") {
  const result = await runCommand(
    "git",
    ["cat-file", "-e", `${baseCommit}:${file.replace(/\\/g, "/")}`],
    cwd || process.cwd(),
    1000 * 15,
    buildValidationEnv()
  );
  return result.exitCode === 0;
}

async function rollbackUnsafeChanges({ cwd, baseline, files }) {
  const base = cwd || process.cwd();
  const rollbackFiles = [];
  const unresolvedFiles = [];
  const uniqueFiles = normalizeLockPathList(files);

  for (const file of uniqueFiles) {
    const target = path.resolve(base, file);
    const before = baseline?.preExisting?.get(file);
    try {
      if (before) {
        if (before.exists) {
          if (before.restorable === false || before.content === null) {
            unresolvedFiles.push(file);
            continue;
          }
          await ensureParentDir(target);
          if (!await replaceRollbackLeaf({ cwd: base, target, kind: "file", content: before.content, mode: before.mode || 0 })) {
            unresolvedFiles.push(file);
            continue;
          }
        } else {
          if (!await removeRollbackLeaf(target)) {
            unresolvedFiles.push(file);
            continue;
          }
        }
        rollbackFiles.push(file);
        continue;
      }

      const baseCommit = baseline?.baseCommit || "HEAD";
      if (await fileExistsInGitCommit(base, file, baseCommit)) {
        if (await restoreFromGitHead(base, file, baseCommit)) {
          rollbackFiles.push(file);
        } else {
          // Never convert an unreadable/oversized tracked file into a deletion.
          unresolvedFiles.push(file);
        }
        continue;
      }

      if (!await removeRollbackLeaf(target)) {
        unresolvedFiles.push(file);
        continue;
      }
      rollbackFiles.push(file);
    } catch {
      unresolvedFiles.push(file);
    }
  }

  return {
    rollback: unresolvedFiles.length ? (rollbackFiles.length ? "partial" : "failed") : uniqueFiles.length ? "success" : "not_needed",
    rollbackFiles,
    unresolvedFiles,
  };
}

async function rollbackVerifiedOwnedChanges({ cwd, baseline, files, ownedSnapshot }) {
  const uniqueFiles = normalizeLockPathList(files);
  if (!(ownedSnapshot instanceof Map)) {
    return {
      rollback: uniqueFiles.length ? "not_attempted_unattributed_changes" : "not_needed",
      rollbackFiles: [],
      unresolvedFiles: uniqueFiles,
      ownershipMismatches: uniqueFiles,
    };
  }

  const verifiedOwnedFiles = [];
  const ownershipMismatches = [];
  for (const file of uniqueFiles) {
    try {
      const current = await exactIntegrationFileSnapshot(cwd, [file]);
      if (current.get(file) === ownedSnapshot.get(file)) {
        verifiedOwnedFiles.push(file);
      } else {
        ownershipMismatches.push(file);
      }
    } catch {
      ownershipMismatches.push(file);
    }
  }

  const result = verifiedOwnedFiles.length
    ? await rollbackUnsafeChanges({ cwd, baseline, files: verifiedOwnedFiles })
    : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };
  const unresolvedFiles = normalizeLockPathList(result.unresolvedFiles.concat(ownershipMismatches));
  return {
    ...result,
    rollback: unresolvedFiles.length
      ? (result.rollbackFiles.length ? "partial" : "not_attempted_unattributed_changes")
      : result.rollback,
    unresolvedFiles,
    ownershipMismatches,
  };
}

function safeNamePart(value, fallback = "item") {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

function projectStateKey(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function recordMatchesProject(record, projectRoot = "") {
  if (!projectRoot) {
    return true;
  }

  return normalizeFilesystemCase(path.resolve(record?.cwd || process.cwd()))
    === normalizeFilesystemCase(path.resolve(projectRoot));
}

function effectiveBridgeStateDirectory() {
  return stateDirectoryOverride || GLOBAL_BRIDGE_STATE_DIR;
}

function makeQueueJobId(agent = "agent") {
  return `${safeNamePart(agent, "agent")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

const {
  queueRequestFingerprint,
  encryptQueueRequest,
  decryptQueueRequest,
} = createQueueRequestCrypto({
  getStateDirectory: () => effectiveBridgeStateDirectory(),
});

const {
  queueRecordSnapshot,
  enforceQueueResultEvidence,
  tryPersistedQueueRecordFromRow,
  persistedQueueRecordFromRow,
  loadPersistedQueueRecord,
} = createQueueRecordCodec({
  config: CONFIG,
});

const {
  stampPersistedQueueCancellation,
  persistTerminalQueueRecord,
  persistQueueRecord,
  updateQueueRecordDurable,
  persistedRunningQueueRecords,
  claimQueueRecord,
  readPersistedQueueRecord,
  listPersistedQueueRecords,
} = createQueueRepository({
  config: CONFIG,
  effectiveQueueMode,
  openLockDb,
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  getProcessId: () => process.pid,
  clockNow: () => Date.now(),
  randomBytes,
  queueRecordSnapshot,
  enforceQueueResultEvidence,
  tryPersistedQueueRecordFromRow,
  persistedQueueRecordFromRow,
  loadPersistedQueueRecord,
  closeDb,
});

const {
  reconcileStaleQueueRecords,
  processIsAlive,
  renewPersistedQueueRecordLease,
} = createQueueRecoveryPrimitives({
  config: CONFIG,
  queueJobs: QUEUE_JOBS,
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  persistedQueueRecordFromRow,
  sanitizePersistedValue,
  logEvent,
});

function truncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

function generatedWorktreeRootForCwd(cwd) {
  const base = cwd || process.cwd();
  const configured = String(CONFIG.worktreeRoot || "").trim();
  if (!configured) {
    return "";
  }

  if (configured.toLowerCase() === "global") {
    return path.join(effectiveBridgeStateDirectory(), "worktrees", projectStateKey(base));
  }

  return path.resolve(path.isAbsolute(configured) ? configured : path.join(base, configured));
}

function filterGeneratedWorktreeFiles(files, cwd) {
  const root = generatedWorktreeRootForCwd(cwd);
  const filtered = normalizeLockPathList(files);
  if (!root || !isPathInside(cwd || process.cwd(), root)) {
    return filtered;
  }

  const relativeRoot = normalizeLockPath(path.relative(path.resolve(cwd || process.cwd()), root));
  return filtered.filter((file) => !isWithinAnyPath(file, [relativeRoot], cwd));
}

function resolveWorktreeRoot(repoRoot) {
  const configured = String(CONFIG.worktreeRoot || "global").trim();
  if (!configured || /[\x00-\x1F\x7F]/.test(configured) || configured.startsWith("~")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Unsafe worktree root: ${JSON.stringify(configured)}`,
    };
  }

  const normalized = configured.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Worktree root must not contain parent traversal: ${JSON.stringify(configured)}`,
    };
  }

  const resolved = configured.toLowerCase() === "global"
    ? path.join(effectiveBridgeStateDirectory(), "worktrees", projectStateKey(repoRoot))
    : path.resolve(path.isAbsolute(configured) ? configured : path.join(repoRoot, configured));
  if (resolved === path.parse(resolved).root) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Worktree root resolved to a filesystem root.",
    };
  }

  return { ok: true, root: resolved };
}

function shouldUseWorktree(job, lockPlan, worktreeMode = CONFIG.worktreeMode) {
  if (job.dryRun || !lockPlan) {
    return false;
  }

  if (job.sanitizedWorkspace || lockPlan.sanitizedWorkspace) {
    return false;
  }

  if (lockPlan.orchestratorMode === "contractor") {
    return true;
  }

  if (worktreeMode === "all") {
    return true;
  }

  return worktreeMode === "write" && lockPlan.lockType === "write";
}

function makeWorktreeBranchName(agent, jobId) {
  return [
    safeNamePart(CONFIG.worktreeBranchPrefix, "agent"),
    safeNamePart(agent, "agent"),
    safeNamePart(jobId, "job"),
  ].join("/");
}

async function inspectSourceCheckpointState(cwd, { lockedPaths = [], allowedEdits = [], scopeContract = null } = {}) {
  const result = await runCommand("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], cwd, 1000 * 30, buildValidationEnv());
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "dirty_worktree_preflight_failed",
      error: result.stderr || result.stdout || "Could not inspect the source checkout before worktree creation.",
      dirtyEntries: [],
      dirtyFiles: [],
      overlappingFiles: [],
      disjointFiles: [],
      conflictingPaths: [],
    };
  }
  const tokens = String(result.stdout || "").split("\0").filter(Boolean);
  const dirtyEntries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const file = normalizeLockPath(token.slice(3));
    if (!file) continue;
    dirtyEntries.push({ status, file });
    if (/[RC]/.test(status) && tokens[index + 1]) {
      const original = normalizeLockPath(tokens[index + 1]);
      if (original) dirtyEntries.push({ status: `${status}:source`, file: original });
      index += 1;
    }
  }
  const dirtyFiles = normalizeLockPathList(dirtyEntries.map((entry) => entry.file));
  const scopePaths = mergePathLists(lockedPaths, allowedEdits, scopeContractPathInputs(scopeContract));
  const overlappingFiles = dirtyFiles.filter((file) => Boolean(overlaps([file], scopePaths)));
  const disjointFiles = dirtyFiles.filter((file) => !overlappingFiles.includes(file));
  const conflictingPaths = overlappingFiles.length ? overlappingFiles : dirtyFiles;
  return {
    ok: dirtyFiles.length === 0,
    errorType: dirtyFiles.length ? "dirty_worktree_requires_checkpoint" : null,
    error: dirtyFiles.length
      ? "The source checkout contains staged, unstaged, untracked, conflicted, or submodule changes. A HEAD-based worktree would omit that state. The bridge will not stash, reset, commit, or overlay it; create or select an external checkpoint and retry. Unrelated dirt is also rejected because the base must be fully reproducible."
      : "",
    dirtyEntries,
    dirtyFiles,
    overlappingFiles,
    disjointFiles,
    conflictingPaths,
  };
}

function dirtyCheckpointDetails(checkpoint = {}) {
  const dirtyFiles = normalizeLockPathList(checkpoint.dirtyFiles || []);
  const overlappingFiles = normalizeLockPathList(checkpoint.overlappingFiles || []);
  const disjointFiles = normalizeLockPathList(checkpoint.disjointFiles || []);
  const conflictingPaths = overlappingFiles.length ? overlappingFiles : dirtyFiles;
  return { dirtyFiles, overlappingFiles, disjointFiles, conflictingPaths };
}

async function createWorktreeForJob({ cwd, agent, jobId, lockedPaths = [], allowedEdits = [], scopeContract = null }) {
  const baseCwd = cwd || process.cwd();
  const gitVersion = await runCommand("git", ["--version"], baseCwd, 1000 * 15);
  if (gitVersion.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: gitVersion.stderr || "git is not available.",
    };
  }

  const repoRootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], baseCwd, 1000 * 15);
  if (repoRootResult.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: repoRootResult.stderr || "Current working directory is not inside a Git repository.",
    };
  }

  const repoRoot = path.resolve(repoRootResult.stdout.trim());
  const checkpointState = await inspectSourceCheckpointState(repoRoot, { lockedPaths, allowedEdits, scopeContract });
  if (!checkpointState.ok) {
    return checkpointState;
  }
  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15);
  if (baseCommitResult.exitCode !== 0 || !baseCommitResult.stdout.trim()) {
    return {
      ok: false,
      errorType: "worktree_base_invalid",
      error: baseCommitResult.stderr || "Could not capture the repository HEAD before creating the worktree.",
    };
  }
  const baseCommit = baseCommitResult.stdout.trim();
  const baseTreeResult = await runCommand("git", ["rev-parse", `${baseCommit}^{tree}`], repoRoot, 1000 * 15);
  if (baseTreeResult.exitCode !== 0 || !baseTreeResult.stdout.trim()) {
    return {
      ok: false,
      errorType: "worktree_base_invalid",
      error: baseTreeResult.stderr || "Could not capture the repository base tree.",
    };
  }
  const rootResult = resolveWorktreeRoot(repoRoot);
  if (!rootResult.ok) {
    return rootResult;
  }

  const branch = makeWorktreeBranchName(agent, jobId);
  const worktreePath = path.resolve(rootResult.root, `${safeNamePart(agent, "agent")}-${safeNamePart(jobId, "job")}`);
  if (!isPathInside(rootResult.root, worktreePath) || path.resolve(worktreePath) === repoRoot) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Generated worktree path is outside the configured worktree root or matches the main repository.",
    };
  }

  await mkdir(rootResult.root, { recursive: true });
  const branchExists = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repoRoot, 1000 * 15);
  if (branchExists.exitCode === 0) {
    return {
      ok: false,
      errorType: "worktree_checkout_failed",
      error: `Worktree branch already exists: ${branch}`,
    };
  }

  const created = await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot, 1000 * 60);
  if (created.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_create_failed",
      error: created.stderr || created.stdout || "git worktree add failed.",
      repoRoot,
      branch,
      path: worktreePath,
    };
  }

  const [postCheckpointState, postHead, createdWorktreeState] = await Promise.all([
    inspectSourceCheckpointState(repoRoot, { lockedPaths, allowedEdits, scopeContract }),
    runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15, buildValidationEnv()),
    inspectSourceCheckpointState(worktreePath),
  ]);
  if (!postCheckpointState.ok || postHead.exitCode !== 0 || postHead.stdout.trim() !== baseCommit) {
    let preExecutionCleanup = { cleanup: "retained", reason: "new worktree was not proven clean" };
    if (createdWorktreeState.ok) {
      preExecutionCleanup = await cleanupWorktree({ repoRoot, path: worktreePath, branch }, "always", true);
    }
    return {
      ok: false,
      errorType: !postCheckpointState.ok ? postCheckpointState.errorType : "worktree_source_checkpoint_changed",
      error: !postCheckpointState.ok
        ? `${postCheckpointState.error} The source changed during worktree creation, so no agent was started.`
        : "Repository HEAD changed during worktree creation, so the new worktree no longer represents the current source checkpoint.",
      dirtyEntries: postCheckpointState.dirtyEntries || [],
      dirtyFiles: postCheckpointState.dirtyFiles || [],
      overlappingFiles: postCheckpointState.overlappingFiles || [],
      disjointFiles: postCheckpointState.disjointFiles || [],
      conflictingPaths: dirtyCheckpointDetails(postCheckpointState).conflictingPaths,
      repoRoot,
      path: worktreePath,
      branch,
      baseCommit,
      preExecutionCleanup,
    };
  }

  return {
    ok: true,
    repoRoot,
    path: worktreePath,
    branch,
    baseCommit,
    baseTree: baseTreeResult.stdout.trim(),
    cleanup: "not_attempted",
  };
}

async function collectWorktreeDiff(worktree) {
  if (!worktree?.path) {
    return null;
  }
  const patch = await createPatchFromWorkingTree(worktree.path, worktree.baseCommit || "HEAD", { rejectIgnoredSource: true });
  if (!patch.ok) {
    return {
      changedFiles: [],
      diffStat: "",
      patchPreview: "",
      patchSha256: "",
      errorType: patch.errorType,
      error: patch.error,
    };
  }
  const diffStat = await runCommand("git", ["diff", "--stat", worktree.baseCommit || "HEAD", "--"], worktree.path, 1000 * 15);
  return {
    changedFiles: patch.changedFiles,
    diffStat: diffStat.exitCode === 0 ? diffStat.stdout.trim() : "",
    patchPreview: truncateText(redactSensitiveText(patch.patch)),
    patchSha256: patch.patchSha256,
    sourceStateSha256: patch.sourceStateSha256,
    sourceBaseCommit: patch.baseCommit,
    sourceHead: patch.sourceHead,
    errorType: null,
    error: "",
  };
}

async function cleanupWorktree(worktree, cleanupMode, success) {
  if (!worktree?.path || cleanupMode === "never") {
    return {
      cleanup: "skipped",
      reason: cleanupMode === "never" ? "configured never" : "no worktree",
    };
  }

  if (cleanupMode === "on_success" && !success) {
    return {
      cleanup: "skipped",
      reason: "job did not finish successfully",
    };
  }

  const removeArgs = ["worktree", "remove"];
  if (cleanupMode === "always" || cleanupMode === "on_success") {
    removeArgs.push("--force");
  }
  removeArgs.push(worktree.path);

  const removed = await runCommand("git", removeArgs, worktree.repoRoot, 1000 * 60);
  if (removed.exitCode !== 0) {
    return {
      cleanup: "failed",
      errorType: "worktree_cleanup_failed",
      error: removed.stderr || removed.stdout || "git worktree remove failed.",
    };
  }

  if (!worktree.branch || worktree.branch === "HEAD") {
    return {
      cleanup: "success",
      branchCleanup: "skipped",
      reason: "worktree had no removable local branch",
    };
  }

  const deletedBranch = await runCommand("git", ["branch", "-D", worktree.branch], worktree.repoRoot, 1000 * 30);
  return {
    cleanup: deletedBranch.exitCode === 0 ? "success" : "partial",
    branchCleanup: deletedBranch.exitCode === 0 ? "success" : "failed",
    error: deletedBranch.exitCode === 0 ? "" : deletedBranch.stderr || deletedBranch.stdout || "git branch cleanup failed.",
  };
}

function formatWorktreeSummary(worktree, cleanupResult = null) {
  if (!worktree) {
    return "Worktree: not used";
  }

  return [
    "Worktree: used",
    `Worktree path: ${worktree.path}`,
    `Worktree branch: ${worktree.branch}`,
    `Worktree cleanup: ${cleanupResult?.cleanup || "not attempted"}`,
    cleanupResult?.reason ? `Worktree cleanup reason: ${cleanupResult.reason}` : null,
    cleanupResult?.error ? `Worktree cleanup error: ${cleanupResult.error}` : null,
  ].filter(Boolean).join("\n");
}

async function markUntrackedFilesForDiff(cwd) {
  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd, 1000 * 15);
  const files = untracked.exitCode === 0
    ? untracked.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (!files.length) {
    return { ok: untracked.exitCode === 0, files: [], errors: untracked.exitCode === 0 ? [] : [untracked.stderr || "Could not list untracked files."] };
  }

  const errors = [];
  for (let index = 0; index < files.length; index += 50) {
    const batch = files.slice(index, index + 50);
    const marked = await runCommand("git", ["add", "-N", "--", ...batch], cwd, 1000 * 30);
    if (marked.exitCode !== 0) {
      errors.push(marked.stderr || marked.stdout || `Could not mark untracked files: ${batch.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, files, errors };
}

async function ignoredIntegrationSourceFiles(cwd) {
  const result = await runCommand(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    cwd,
    1000 * 30,
    buildValidationEnv()
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "integration_patch_create_failed",
      error: result.stderr || result.stdout || "Could not inspect ignored source paths.",
      files: [],
    };
  }
  const files = normalizeLockPathList(result.stdout.split("\0"));
  if (files.length > CONFIG.maxIgnoredSnapshotFiles) {
    return {
      ok: false,
      errorType: "snapshot_safety_limit_exceeded",
      error: `Ignored integration source path limit exceeded: ${files.length} files exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${CONFIG.maxIgnoredSnapshotFiles}.`,
      files,
    };
  }
  return { ok: true, files };
}

async function captureGitIndexIdentity(cwd) {
  const result = await runGitReadOnlyCommand(
    ["ls-files", "--stage", "-z", "--"],
    cwd || process.cwd(),
    1000 * 30
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "integration_index_snapshot_failed",
      error: result.stderr || result.stdout || "Could not capture the exact Git index identity.",
    };
  }
  const entries = result.stdout.split("\0").filter(Boolean);
  const bytes = Buffer.byteLength(result.stdout || "", "utf8");
  if (entries.length > CONFIG.maxSnapshotFiles || bytes > CONFIG.maxSnapshotTotalBytes) {
    return {
      ok: false,
      errorType: "snapshot_safety_limit_exceeded",
      error: `Git index identity exceeds the configured snapshot limits (${entries.length} entries, ${bytes} bytes).`,
    };
  }
  return {
    ok: true,
    entryCount: entries.length,
    bytes,
    indexSha256: createHash("sha256").update(result.stdout || "").digest("hex"),
  };
}

async function createPatchFromWorkingTree(cwd, baseCommit = "HEAD", { rejectIgnoredSource = false } = {}) {
  let scratch = "";
  try {
    const sourcePath = path.resolve(cwd || process.cwd());
    scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-index-"));
    const indexPath = path.join(scratch, "index");
    const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
    const base = await runCommand("git", ["rev-parse", baseCommit], sourcePath, 1000 * 15);
    const head = await runCommand("git", ["rev-parse", "HEAD"], sourcePath, 1000 * 15);
    if (base.exitCode !== 0 || head.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: base.stderr || head.stderr || "Could not resolve source commits." };
    }
    const realIndex = await captureGitIndexIdentity(sourcePath);
    if (!realIndex.ok) return realIndex;
    if (rejectIgnoredSource) {
      const ignored = await ignoredIntegrationSourceFiles(sourcePath);
      if (!ignored.ok) return ignored;
      if (ignored.files.length) {
        return {
          ok: false,
          errorType: "integration_source_unrepresentable",
          error: `The source contains ignored paths that are absent from the reviewable Git patch: ${ignored.files.join(", ")}. The bridge retained the source and will not report or clean it as successfully integrated.`,
          ignoredFiles: ignored.files,
          unresolvedFiles: ignored.files,
        };
      }
    }
    const readTree = await runCommand("git", ["read-tree", base.stdout.trim()], sourcePath, 1000 * 30, gitEnv);
    if (readTree.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: readTree.stderr || "Could not create an isolated temporary Git index." };
    }
    const add = await runCommand("git", ["add", "-A", "--", "."], sourcePath, 1000 * 60, gitEnv);
    if (add.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: add.stderr || "Could not populate the isolated temporary Git index." };
    }
    const [diff, changed, status] = await Promise.all([
      runCommand("git", ["diff", "--cached", "--binary", "--no-renames", base.stdout.trim(), "--"], sourcePath, 1000 * 60, gitEnv),
      runCommand("git", ["diff", "--cached", "--name-only", "-z", "--no-renames", base.stdout.trim(), "--"], sourcePath, 1000 * 30, gitEnv),
      runGitReadOnlyCommand(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], sourcePath, 1000 * 30),
    ]);
    if (diff.exitCode !== 0 || changed.exitCode !== 0 || status.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: diff.stderr || changed.stderr || status.stderr || "Could not create a complete source patch." };
    }
    const patch = diff.stdout || "";
    const patchSha256 = createHash("sha256").update(patch).digest("hex");
    const sourceStateSha256 = createHash("sha256")
      .update([base.stdout.trim(), head.stdout.trim(), status.stdout || "", patchSha256, realIndex.indexSha256].join("\0"))
      .digest("hex");
    return {
      ok: true,
      baseCommit: base.stdout.trim(),
      sourceHead: head.stdout.trim(),
      changedFiles: normalizeLockPathList(changed.stdout.split("\0")),
      patch,
      patchSha256,
      indexSha256: realIndex.indexSha256,
      sourceStateSha256,
    };
  } catch (error) {
    return {
      ok: false,
      errorType: "integration_patch_create_failed",
      error: redactSensitiveText(error?.message || String(error)),
    };
  } finally {
    if (scratch) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (error) {
        logEvent("warn", "integration.temporary_index_cleanup_failed", { error: error.message || String(error) });
      }
    }
  }
}

async function collectIntegrationPatch({ cwd, worktreePath = "", branch = "", sourceBaseCommit = "" }) {
  const repoRoot = path.resolve(cwd || process.cwd());
  if (worktreePath) {
    const sourcePath = path.resolve(worktreePath);
    if (path.resolve(sourcePath) === path.resolve(repoRoot)) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "worktreePath must not be the same as the target repository path.",
      };
    }

    const sourceRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], sourcePath, 1000 * 15);
    if (sourceRoot.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: sourceRoot.stderr || "worktreePath is not a Git worktree or repository.",
      };
    }
    if (normalizePathForCompare(path.resolve(sourceRoot.stdout.trim())) !== normalizePathForCompare(sourcePath)) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "worktreePath must be the canonical Git worktree root; subdirectory integration would omit sibling source changes.",
      };
    }

    const [targetCommonDir, sourceCommonDir, sourceHead] = await Promise.all([
      runCommand("git", ["rev-parse", "--git-common-dir"], repoRoot, 1000 * 15),
      runCommand("git", ["rev-parse", "--git-common-dir"], sourcePath, 1000 * 15),
      runCommand("git", ["rev-parse", "HEAD"], sourcePath, 1000 * 15),
    ]);
    if (targetCommonDir.exitCode !== 0 || sourceCommonDir.exitCode !== 0 || sourceHead.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "Could not verify that the source worktree belongs to the target repository.",
      };
    }

    const targetCommonPath = path.resolve(repoRoot, targetCommonDir.stdout.trim());
    const sourceCommonPath = path.resolve(sourcePath, sourceCommonDir.stdout.trim());
    const normalizedTargetCommonPath = process.platform === "win32" ? targetCommonPath.toLowerCase() : targetCommonPath;
    const normalizedSourceCommonPath = process.platform === "win32" ? sourceCommonPath.toLowerCase() : sourceCommonPath;
    if (normalizedTargetCommonPath !== normalizedSourceCommonPath) {
      return {
        ok: false,
        errorType: "integration_source_repository_mismatch",
        error: "worktreePath must belong to the same Git repository as the integration target.",
      };
    }

    let baseCommit = String(sourceBaseCommit || "").trim();
    if (!baseCommit) {
      const targetHead = await runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15);
      const mergeBase = targetHead.exitCode === 0
        ? await runCommand("git", ["merge-base", targetHead.stdout.trim(), sourceHead.stdout.trim()], repoRoot, 1000 * 15)
        : { exitCode: 1, stdout: "", stderr: targetHead.stderr };
      baseCommit = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : sourceHead.stdout.trim();
    }
    const createdPatch = await createPatchFromWorkingTree(sourcePath, baseCommit, { rejectIgnoredSource: true });
    if (!createdPatch.ok) return createdPatch;

    return {
      ok: true,
      sourceType: "worktree",
      source: sourcePath,
      changedFiles: createdPatch.changedFiles,
      patch: createdPatch.patch,
      patchSha256: createdPatch.patchSha256,
      sourceStateSha256: createdPatch.sourceStateSha256,
      sourceBaseCommit: createdPatch.baseCommit,
      sourceHead: createdPatch.sourceHead,
    };
  }

  if (branch) {
    const verified = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repoRoot, 1000 * 15);
    if (verified.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: `Branch not found: ${branch}`,
      };
    }

    const base = await runCommand("git", ["rev-parse", sourceBaseCommit || "HEAD"], repoRoot, 1000 * 15);
    if (base.exitCode !== 0) {
      return { ok: false, errorType: "integration_source_invalid", error: base.stderr || "Could not resolve the reviewed branch base commit." };
    }
    const changed = await runCommand("git", ["diff", "--name-only", "-z", "--no-renames", `${base.stdout.trim()}..${branch}`, "--"], repoRoot, 1000 * 15);
    const diff = await runCommand("git", ["diff", "--binary", "--no-renames", `${base.stdout.trim()}..${branch}`, "--"], repoRoot, 1000 * 30);
    if (diff.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_patch_create_failed",
        error: diff.stderr || diff.stdout || "Could not create patch from branch.",
      };
    }

    return {
      ok: true,
      sourceType: "branch",
      source: branch,
      changedFiles: changed.exitCode === 0 ? normalizeLockPathList(changed.stdout.split("\0")) : [],
      patch: diff.stdout || "",
      patchSha256: createHash("sha256").update(diff.stdout || "").digest("hex"),
      sourceStateSha256: createHash("sha256").update([branch, verified.stdout || "", diff.stdout || ""].join("\0")).digest("hex"),
      sourceBaseCommit: base.stdout.trim(),
      sourceHead: verified.stdout.trim().split(/\s+/)[0] || "",
    };
  }

  return {
    ok: false,
    errorType: "integration_source_missing",
    error: "Provide either worktreePath or branch.",
  };
}

async function writeTemporaryPatchFile(patch) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-opencode-patch-"));
  const patchFile = path.join(dir, "changes.patch");
  await writeFile(patchFile, patch, "utf8");
  return { dir, patchFile };
}

async function checkPatchApplies({ cwd, patchFile }) {
  const check = await runCommand("git", ["apply", "--check", "--3way", patchFile], cwd || process.cwd(), 1000 * 60, buildValidationEnv());
  return {
    ok: check.exitCode === 0,
    errorType: check.exitCode === 0 ? null : "integration_merge_conflict",
    stdout: check.stdout || "",
    stderr: check.stderr || "",
  };
}

async function applyPatchFile({ cwd, patchFile, targetHead, files = [] }) {
  const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-apply-index-"));
  const indexFile = path.join(scratch, "index");
  try {
    if (!isPathInside(tmpdir(), scratch) || !isPathInside(scratch, indexFile)) {
      return { exitCode: 1, stdout: "", stderr: "Temporary integration index escaped its bounded root." };
    }
    const env = buildValidationEnv({ GIT_INDEX_FILE: indexFile });
    const seeded = await runCommand("git", ["read-tree", targetHead], cwd || process.cwd(), 1000 * 30, env);
    if (seeded.exitCode !== 0) {
      return { exitCode: seeded.exitCode, stdout: seeded.stdout || "", stderr: seeded.stderr || "Could not seed the isolated integration index." };
    }
    const refreshPaths = normalizeLockPathList(files);
    if (refreshPaths.length) {
      const trackedAtTarget = await runCommand(
        "git",
        ["ls-tree", "-r", "--name-only", "-z", targetHead, "--", ...refreshPaths],
        cwd || process.cwd(),
        1000 * 30,
        env
      );
      if (trackedAtTarget.exitCode !== 0) {
        return {
          exitCode: trackedAtTarget.exitCode,
          stdout: trackedAtTarget.stdout || "",
          stderr: trackedAtTarget.stderr || "Could not identify target paths in the isolated integration index.",
        };
      }
      const trackedRefreshPaths = normalizeLockPathList(trackedAtTarget.stdout.split("\0"));
      if (trackedRefreshPaths.length) {
      const refreshed = await runCommand(
        "git",
        ["update-index", "--refresh", "--ignore-submodules", "--", ...trackedRefreshPaths],
        cwd || process.cwd(),
        1000 * 30,
        env
      );
      // `update-index --refresh` may report an unrelated dirty path even with a
      // pathspec. The reviewed-path snapshots and target receipt were already
      // checked; the isolated `git apply --3way` below remains authoritative and
      // fails closed if any reviewed target path does not match the seeded index.
      void refreshed;
      }
    }
    const applied = await runCommand("git", ["apply", "--3way", patchFile], cwd || process.cwd(), 1000 * 60, env);
    if (applied.exitCode !== 0) return applied;
    const eol = await runCommand("git", ["ls-files", "--eol", "-z", "--", ...normalizeLockPathList(files)], cwd || process.cwd(), 1000 * 30, env);
    return {
      ...applied,
      isolatedEolRecords: eol.exitCode === 0 ? gitEolRecordsFromOutput(eol.stdout) : new Map(),
      isolatedEolError: eol.exitCode === 0 ? "" : (eol.stderr || eol.stdout || "Could not capture isolated-index EOL evidence."),
    };
  } finally {
    if (isPathInside(tmpdir(), scratch)) await rm(scratch, { recursive: true, force: true });
  }
}

async function simulateIntegrationPatchSnapshot({ cwd, targetHead, patchFile, files }) {
  const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-integration-sim-"));
  const gitDir = path.join(scratch, "repo.git");
  const workTree = path.join(scratch, "worktree");
  const indexFile = path.join(scratch, "index");
  try {
    if (!isPathInside(tmpdir(), scratch) || !isPathInside(scratch, gitDir) || !isPathInside(scratch, workTree)) {
      return { ok: false, errorType: "integration_simulation_failed", error: "Temporary integration simulation path escaped its bounded root." };
    }
    await mkdir(workTree, { recursive: true });
    const [objectFormat, objectDirectory] = await Promise.all([
      runCommand("git", ["rev-parse", "--show-object-format"], cwd, 1000 * 15, buildValidationEnv()),
      runCommand("git", ["rev-parse", "--git-path", "objects"], cwd, 1000 * 15, buildValidationEnv()),
    ]);
    if (objectFormat.exitCode !== 0 || objectDirectory.exitCode !== 0 || !objectDirectory.stdout.trim()) {
      return { ok: false, errorType: "integration_simulation_failed", error: "Could not resolve the target Git object store for isolated patch simulation." };
    }
    const format = objectFormat.stdout.trim();
    if (!["sha1", "sha256"].includes(format)) {
      return { ok: false, errorType: "integration_simulation_failed", error: `Unsupported Git object format: ${format || "unknown"}.` };
    }
    const targetObjects = path.resolve(cwd, objectDirectory.stdout.trim());
    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    const init = await runCommand(
      "git",
      ["init", "--bare", `--object-format=${format}`, gitDir],
      scratch,
      1000 * 30,
      buildValidationEnv({ GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig })
    );
    if (init.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: init.stderr || init.stdout || "Could not create an isolated Git index." };
    }
    const gitEnv = buildValidationEnv({
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: indexFile,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: targetObjects,
      GIT_CONFIG_GLOBAL: nullConfig,
      GIT_CONFIG_SYSTEM: nullConfig,
    });
    const readTree = await runCommand("git", ["read-tree", targetHead], cwd, 1000 * 30, gitEnv);
    if (readTree.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: readTree.stderr || "Could not seed the isolated integration index." };
    }
    const applied = await runCommand("git", ["apply", "--cached", "--3way", patchFile], cwd, 1000 * 60, gitEnv);
    if (applied.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: applied.stderr || applied.stdout || "Patch could not be simulated in the isolated integration index." };
    }

    const snapshot = new Map();
    const indexSnapshot = new Map();
    let totalBytes = 0;
    for (const file of normalizeLockPathList(files)) {
      const entry = await runCommand("git", ["ls-files", "--stage", "-z", "--", file], cwd, 1000 * 15, gitEnv);
      if (entry.exitCode !== 0) {
        return { ok: false, errorType: "integration_simulation_failed", error: entry.stderr || `Could not inspect simulated index entry: ${file}` };
      }
      const record = entry.stdout.split("\0").find(Boolean) || "";
      indexSnapshot.set(file, entry.stdout || "");
      if (!record) {
        snapshot.set(file, "missing");
        continue;
      }
      const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(record);
      if (!match) {
        return { ok: false, errorType: "integration_simulation_failed", error: `Simulated index entry was ambiguous or conflicted: ${file}` };
      }
      const [, mode, objectId] = match;
      if (mode === "160000") {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence contains an unsupported submodule entry: ${file}` };
      }
      const sizeResult = await runCommand("git", ["cat-file", "-s", objectId], cwd, 1000 * 15, gitEnv);
      const size = Number(sizeResult.stdout.trim());
      if (sizeResult.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0) {
        return { ok: false, errorType: "integration_simulation_failed", error: sizeResult.stderr || `Could not size simulated blob: ${file}` };
      }
      if (size > CONFIG.maxSnapshotFileBytes) {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration file ${file} is ${size} bytes, above CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES=${CONFIG.maxSnapshotFileBytes}; exact ownership evidence is unavailable.` };
      }
      totalBytes += size;
      if (totalBytes > CONFIG.maxSnapshotTotalBytes) {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.` };
      }
      let blob;
      try {
        const result = await execFileAsync("git", ["cat-file", "blob", objectId], {
          cwd,
          shell: false,
          timeout: 1000 * 15,
          maxBuffer: CONFIG.maxSnapshotFileBytes + 1024,
          encoding: "buffer",
          env: gitEnv,
        });
        blob = result.stdout;
      } catch (error) {
        return { ok: false, errorType: "integration_simulation_failed", error: redactSensitiveText(error?.message || `Could not read simulated blob: ${file}`) };
      }
      if (mode === "120000") {
        snapshot.set(file, `link:${blob.toString("utf8")}`);
      } else if (mode === "100644" || mode === "100755") {
        snapshot.set(file, `file:${mode === "100755" ? 0o111 : 0}:${createHash("sha256").update(blob).digest("hex")}`);
      } else {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence contains unsupported Git mode ${mode}: ${file}` };
      }
    }
    return { ok: true, snapshot, indexSnapshot };
  } finally {
    if (isPathInside(tmpdir(), scratch)) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function gitIndexPathSnapshot(cwd, files = []) {
  const snapshot = new Map();
  for (const file of normalizeLockPathList(files)) {
    const result = await runGitReadOnlyCommand(
      ["ls-files", "--stage", "-z", "--", file],
      cwd || process.cwd(),
      1000 * 15
    );
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || `Could not capture exact Git index evidence for ${file}.`);
      error.errorType = "integration_index_snapshot_failed";
      throw error;
    }
    snapshot.set(file, result.stdout || "");
  }
  return snapshot;
}

async function isolatedIndexPreservationEvidence({ cwd, files, baselineSnapshot }) {
  const uniqueFiles = normalizeLockPathList(files);
  if (!(baselineSnapshot instanceof Map)) {
    return { ok: false, resetFiles: [], ownershipMismatches: uniqueFiles, errors: ["Pre-apply index evidence is unavailable; the bridge did not write or reset the real index."], isolatedIndex: true };
  }
  let current;
  try {
    current = await gitIndexPathSnapshot(cwd, uniqueFiles);
  } catch (error) {
    return { ok: false, resetFiles: [], ownershipMismatches: uniqueFiles, errors: [error.message || String(error)], isolatedIndex: true };
  }
  const ownershipMismatches = uniqueFiles.filter((file) => current.get(file) !== baselineSnapshot.get(file));
  return {
    ok: ownershipMismatches.length === 0,
    resetFiles: [],
    ownershipMismatches,
    errors: ownershipMismatches.length ? ["The real Git index changed concurrently; it was preserved byte-for-byte by the isolated-index integration path."] : [],
    isolatedIndex: true,
  };
}

async function captureIntegrationTargetState(cwd) {
  const [head, tree, status] = await Promise.all([
    runGitReadOnlyCommand(["rev-parse", "HEAD"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["rev-parse", "HEAD^{tree}"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], cwd, 1000 * 30),
  ]);
  if (head.exitCode !== 0 || tree.exitCode !== 0 || status.exitCode !== 0) {
    return { ok: false, errorType: "integration_target_state_failed", error: head.stderr || tree.stderr || status.stderr || "Could not capture integration target identity." };
  }
  const targetHead = head.stdout.trim();
  const targetTree = tree.stdout.trim();
  const statusSha256 = createHash("sha256").update(status.stdout || "").digest("hex");
  const workingPatch = await createPatchFromWorkingTree(cwd, targetHead);
  if (!workingPatch.ok) {
    return { ok: false, errorType: "integration_target_state_failed", error: workingPatch.error || "Could not hash integration target working content." };
  }
  let workingState;
  try {
    // Git status and patches intentionally omit ignored files. A bounded metadata-only
    // identity for ignored/protected content makes preview receipts stale when those
    // files change without persisting their contents.
    workingState = await gitChangedFileSnapshot(cwd, { includeIgnored: true });
  } catch (error) {
    return {
      ok: false,
      errorType: error?.errorType || "integration_target_state_failed",
      error: error?.message || "Could not capture bounded ignored-file integration evidence.",
    };
  }
  const workingStateSha256 = snapshotIdentitySha256(workingState);
  return {
    ok: true,
    targetHead,
    targetTree,
    statusSha256,
    workingPatchSha256: workingPatch.patchSha256,
    indexSha256: workingPatch.indexSha256,
    workingStateSha256,
    targetStateSha256: createHash("sha256").update([targetHead, targetTree, statusSha256, workingPatch.patchSha256, workingPatch.indexSha256, workingStateSha256].join("\0")).digest("hex"),
  };
}

async function captureGitHead(cwd) {
  const result = await runCommand("git", ["rev-parse", "HEAD"], cwd, 1000 * 15, buildValidationEnv());
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const error = new Error(result.stderr || "Could not capture the integration target HEAD.");
    error.errorType = "integration_target_state_failed";
    throw error;
  }
  return result.stdout.trim();
}

function integrationContractSha256({ cwd, worktreePath, branch, allowedEdits, forbiddenEdits, sharedFiles, serialOnly, validationCommand, allowDirtyTarget }) {
  const value = {
    cwd: path.resolve(cwd || process.cwd()),
    worktreePath: worktreePath ? path.resolve(worktreePath) : "",
    branch: String(branch || ""),
    allowedEdits: normalizeLockPathList(allowedEdits).sort(),
    forbiddenEdits: normalizeLockPathList(forbiddenEdits).sort(),
    sharedFiles: normalizeLockPathList(sharedFiles).sort(),
    serialOnly: normalizeLockPathList(serialOnly).sort(),
    validationCommand: String(validationCommand || "").trim(),
    allowDirtyTarget: Boolean(allowDirtyTarget),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeIntegrationPreviewReceipt({ patch, targetState, contractSha256 }) {
  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + INTEGRATION_PREVIEW_TTL_MS).toISOString();
  const identity = {
    createdAt,
    expiresAt,
    patchSha256: patch.patchSha256,
    sourceBaseCommit: patch.sourceBaseCommit,
    sourceStateSha256: patch.sourceStateSha256,
    targetHead: targetState.targetHead,
    targetStateSha256: targetState.targetStateSha256,
    contractSha256,
  };
  const previewId = createHmac("sha256", INTEGRATION_PREVIEW_KEY).update(JSON.stringify(identity)).digest("hex");
  const receipt = {
    previewId,
    ...identity,
  };
  INTEGRATION_PREVIEWS.set(previewId, { identity, expiresAt: Date.parse(expiresAt) });
  return receipt;
}

function integrationPreviewReceiptError(receipt, expected, consume = false) {
  if (!receipt) return "A reviewed apply requires the exact previewReceipt returned by a prior dry run.";
  let parsed;
  try {
    parsed = integrationPreviewReceiptSchema.parse(receipt);
  } catch (error) {
    return `Invalid integration preview receipt: ${error.message || String(error)}`;
  }
  const expiresAt = Date.parse(parsed.expiresAt);
  const createdAt = Date.parse(parsed.createdAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || createdAt > Date.now() + 1000 * 60 || expiresAt <= Date.now() || expiresAt - createdAt > INTEGRATION_PREVIEW_TTL_MS) {
    return "The integration preview receipt has invalid or expired timestamps.";
  }
  const fields = ["patchSha256", "sourceBaseCommit", "sourceStateSha256", "targetHead", "targetStateSha256", "contractSha256"];
  for (const field of fields) {
    if (parsed[field] !== expected[field]) return `Integration preview is stale: ${field} changed after review.`;
  }
  const identity = {
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    patchSha256: parsed.patchSha256,
    sourceBaseCommit: parsed.sourceBaseCommit,
    sourceStateSha256: parsed.sourceStateSha256,
    targetHead: parsed.targetHead,
    targetStateSha256: parsed.targetStateSha256,
    contractSha256: parsed.contractSha256,
  };
  const expectedId = createHmac("sha256", INTEGRATION_PREVIEW_KEY).update(JSON.stringify(identity)).digest("hex");
  const receivedBytes = Buffer.from(parsed.previewId, "hex");
  const expectedBytes = Buffer.from(expectedId, "hex");
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
    return "Integration preview receipt identity is invalid.";
  }
  const issued = INTEGRATION_PREVIEWS.get(parsed.previewId);
  if (!issued || issued.expiresAt !== expiresAt || JSON.stringify(issued.identity) !== JSON.stringify(identity)) {
    return "Integration preview receipt was not issued by this bridge process or was already consumed.";
  }
  if (consume) INTEGRATION_PREVIEWS.delete(parsed.previewId);
  for (const [previewId, entry] of INTEGRATION_PREVIEWS) {
    if (entry.expiresAt <= Date.now()) INTEGRATION_PREVIEWS.delete(previewId);
  }
  return "";
}

async function integratePatchSerially(options) {
  const requestedCwd = path.resolve(options.cwd || process.cwd());
  const targetRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], requestedCwd, 1000 * 15);
  if (targetRoot.exitCode !== 0 || !targetRoot.stdout.trim()) {
    return {
      ok: false,
      errorType: "integration_target_invalid",
      error: targetRoot.stderr || "Integration target is not inside a Git repository.",
    };
  }

  const targetCwd = path.resolve(targetRoot.stdout.trim());
  const normalizedAllowed = normalizeLockPathListForCwd(options.allowedEdits, targetCwd);
  if (!normalizedAllowed.length) {
    return integratePatchWithoutSerialLock({ ...options, cwd: targetCwd });
  }

  const lockResult = await acquireHardLock({
    owner: "codex",
    agent: "merge_manager",
    task: "Serial worktree/branch integration",
    cwd: targetCwd,
    lockType: "serial_integration",
    paths: normalizedAllowed,
    ttlMs: Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10),
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      errorType: "integration_lock_conflict",
      error: `Serial integration could not acquire the repository lock: ${lockResult.error}`,
      conflictingPaths: conflictPathsFromConflict(lockResult.conflict),
      suggestedFix: "Wait for active readers/writers/integrations in this repository to finish, then retry the reviewed integration.",
    };
  }

  const integrationLockTtlMs = Math.max(DEFAULT_LOCK_TTL_MS, CONFIG.validationCommandTimeoutMs + 1000 * 60 * 10);
  const stopIntegrationHeartbeat = startHardLockHeartbeat(lockResult.lock, integrationLockTtlMs);
  try {
    const result = await integratePatchWithoutSerialLock({
      ...options,
      cwd: targetCwd,
      allowedEdits: normalizedAllowed,
    });
    if (options.cleanupAfterSuccess && options.worktreePath) {
      await cleanupIntegratedWorktreeWhileLocked({
        result,
        cwd: targetCwd,
        worktreePath: options.worktreePath,
        deferCleanup: Boolean(options.deferCleanup),
        beforeCleanupHook: options.beforeCleanupHook,
      });
    }
    result.integrationLock = {
      id: lockResult.lock.id,
      type: lockResult.lock.lockType,
      paths: lockResult.lock.paths,
    };
    return result;
  } finally {
    stopIntegrationHeartbeat();
    const released = await releaseHardLock(
      lockResult.lock.id,
      lockResult.lock.token,
      lockResult.lock.paths,
      lockResult.lock.cwd
    );
    if (!released.ok) {
      logEvent("warn", "integration.lock_release_failed", {
        lockId: lockResult.lock.id,
        error: released.error,
      });
    }
  }
}

async function integratePatchWithoutSerialLock({
  cwd,
  worktreePath = "",
  branch = "",
  allowedEdits = [],
  forbiddenEdits = [],
  sharedFiles = [],
  serialOnly = [],
  validationCommand = "",
  validationTrustedSpec = null,
  validationPolicyTrust = null,
  dryRun = false,
  allowDirtyTarget = false,
  reviewed = false,
  previewReceipt = null,
  expectedSourceIdentity = null,
  beforeApplyHook = null,
  beforeValidationHook = null,
}) {
  const requestedCwd = path.resolve(cwd || process.cwd());
  const targetRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], requestedCwd, 1000 * 15);
  if (targetRoot.exitCode !== 0 || !targetRoot.stdout.trim()) {
    return {
      ok: false,
      errorType: "integration_target_invalid",
      error: targetRoot.stderr || "Integration target is not inside a Git repository.",
    };
  }
  const targetCwd = path.resolve(targetRoot.stdout.trim());

  const targetState = await captureIntegrationTargetState(targetCwd);
  if (!targetState.ok) return targetState;
  const patch = await collectIntegrationPatch({
    cwd: targetCwd,
    worktreePath,
    branch,
    sourceBaseCommit: expectedSourceIdentity?.sourceBaseCommit || previewReceipt?.sourceBaseCommit || "",
  });
  if (!patch.ok) {
    return patch;
  }
  if (expectedSourceIdentity) {
    const sourceMatches = patch.sourceBaseCommit === expectedSourceIdentity.sourceBaseCommit
      && patch.patchSha256 === expectedSourceIdentity.patchSha256
      && patch.sourceStateSha256 === expectedSourceIdentity.sourceStateSha256;
    if (!sourceMatches) {
      return {
        ok: false,
        errorType: "pipeline_source_identity_changed",
        error: "The pipeline worktree changed after its completed queue result. Re-run the writer and review a new pipeline output; the mutated source was not applied.",
        changedFiles: patch.changedFiles,
        expectedSourceIdentity,
        actualSourceIdentity: {
          sourceBaseCommit: patch.sourceBaseCommit,
          patchSha256: patch.patchSha256,
          sourceStateSha256: patch.sourceStateSha256,
        },
      };
    }
  }

  const contractSha256 = integrationContractSha256({
    cwd: targetCwd,
    worktreePath,
    branch,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    validationCommand,
    allowDirtyTarget,
  });
  const currentPreviewIdentity = {
    patchSha256: patch.patchSha256,
    sourceBaseCommit: patch.sourceBaseCommit,
    sourceStateSha256: patch.sourceStateSha256,
    targetHead: targetState.targetHead,
    targetStateSha256: targetState.targetStateSha256,
    contractSha256,
  };
  if (!dryRun && reviewed) {
    const earlyReceiptError = integrationPreviewReceiptError(previewReceipt, currentPreviewIdentity);
    if (earlyReceiptError) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        error: earlyReceiptError,
        changedFiles: patch.changedFiles,
        patchSha256: patch.patchSha256,
        targetStateSha256: targetState.targetStateSha256,
      };
    }
  }

  const targetChanges = filterGeneratedWorktreeFiles(await gitChangedFiles(targetCwd), targetCwd);
  if (!allowDirtyTarget && targetChanges.length) {
    return {
      ok: false,
      errorType: "integration_dirty_target",
      error: "Target repository has existing changes. Set allowDirtyTarget only when the coordinator has reviewed them.",
      changedFiles: targetChanges,
    };
  }

  const dirtyOverlap = allowDirtyTarget ? overlaps(targetChanges, patch.changedFiles) : null;
  if (dirtyOverlap) {
    return {
      ok: false,
      errorType: "integration_dirty_target_overlap",
      error: "The integration source overlaps existing target changes; applying it would make rollback unsafe.",
      changedFiles: targetChanges,
      disallowedFiles: dirtyOverlap,
    };
  }

  const normalizedAllowed = normalizeLockPathList(allowedEdits);
  if (!normalizedAllowed.length) {
    return {
      ok: false,
      errorType: "empty_allowed_edits",
      error: "Serial integration requires explicit allowedEdits.",
      changedFiles: patch.changedFiles,
    };
  }

  if (!patch.patch.trim()) {
    return {
      ok: true,
      status: "no_changes",
      sourceType: patch.sourceType,
      source: patch.source,
      changedFiles: [],
      appliedFiles: [],
      dryRun,
      validationGate: { status: "skipped", command: "", exitCode: "not_run", durationMs: 0 },
    };
  }

  const lockPlan = {
    agent: "merge_manager",
    cwd: targetCwd,
    lockType: "write",
    lockMode: "serial_integration",
    lockedPaths: normalizedAllowed,
    allowedEdits: normalizedAllowed,
    forbiddenEdits: mergePathLists(DEFAULT_FORBIDDEN_EDIT_PATHS, forbiddenEdits),
    sharedFiles: normalizeLockPathList(sharedFiles),
    serialOnly: normalizeLockPathList(serialOnly),
    scopeContract: null,
  };
  const sourceValidation = validateChangedFilesForPlan({ changedFiles: patch.changedFiles, lockPlan, parallel: false });
  if (sourceValidation.disallowedFiles.length) {
    return {
      ok: false,
      errorType: changedFileValidationErrorType(sourceValidation),
      error: "Integration source contains files outside allowedEdits or inside forbidden/shared paths.",
      changedFiles: patch.changedFiles,
      disallowedFiles: sourceValidation.disallowedFiles,
      serialOnlyMatches: sourceValidation.serialOnlyMatches,
    };
  }

  const { dir, patchFile } = await writeTemporaryPatchFile(patch.patch);
  let rollbackBaseline = null;
  let before = null;
  let patchApplied = false;
  let preApplyExactSnapshot = null;
  let preApplyIndexSnapshot = null;
  let preApplyFullIndexSha256 = "";
  let expectedPostApplySnapshot = null;
  let ownedPostApplySnapshot = null;
  try {
    const applyCheck = await checkPatchApplies({ cwd: targetCwd, patchFile });
    if (!applyCheck.ok) {
      return {
        ok: false,
        errorType: applyCheck.errorType,
        error: applyCheck.stderr || applyCheck.stdout || "Patch does not apply cleanly.",
        changedFiles: patch.changedFiles,
      };
    }

    if (dryRun) {
      const safePatchPreview = redactSensitiveText(patch.patch);
      if (safePatchPreview !== patch.patch) {
        return {
          ok: false,
          status: "preview_rejected",
          errorType: "integration_preview_contains_sensitive_text",
          error: "The patch matched credential-redaction rules. No review receipt was issued because the bridge cannot expose or silently redact essential review evidence.",
          changedFiles: patch.changedFiles,
          patchSha256: patch.patchSha256,
          patchPreview: "",
          patchPreviewTruncated: false,
          previewReceipt: null,
        };
      }
      if (patch.patch.length > CONFIG.integrationPreviewMaxChars) {
        return {
          ok: false,
          status: "preview_rejected",
          errorType: "integration_preview_truncated",
          error: `The exact patch is ${patch.patch.length} characters, above CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS=${CONFIG.integrationPreviewMaxChars}. No review receipt was issued because essential evidence would be truncated.`,
          sourceType: patch.sourceType,
          source: patch.source,
          changedFiles: patch.changedFiles,
          appliedFiles: [],
          dryRun: true,
          patchSha256: patch.patchSha256,
          sourceBaseCommit: patch.sourceBaseCommit,
          sourceHead: patch.sourceHead,
          sourceStateSha256: patch.sourceStateSha256,
          targetHead: targetState.targetHead,
          targetTree: targetState.targetTree,
          targetStateSha256: targetState.targetStateSha256,
          contractSha256,
          patchPreview: "",
          patchPreviewTruncated: true,
          previewReceipt: null,
        };
      }
      const generatedReceipt = makeIntegrationPreviewReceipt({ patch, targetState, contractSha256 });
      return {
        ok: true,
        status: "dry_run_passed",
        sourceType: patch.sourceType,
        source: patch.source,
        changedFiles: patch.changedFiles,
        appliedFiles: [],
        dryRun: true,
        patchSha256: patch.patchSha256,
        sourceBaseCommit: patch.sourceBaseCommit,
        sourceHead: patch.sourceHead,
        sourceStateSha256: patch.sourceStateSha256,
        targetHead: targetState.targetHead,
        targetTree: targetState.targetTree,
        targetStateSha256: targetState.targetStateSha256,
        contractSha256,
        patchPreview: safePatchPreview,
        patchPreviewTruncated: false,
        preExistingTargetChanges: targetChanges,
        allowDirtyTarget: Boolean(allowDirtyTarget),
        previewReceipt: generatedReceipt,
        validationGate: { status: "skipped_dry_run", command: validationCommand, exitCode: "not_run", durationMs: 0 },
      };
    }

    if (!reviewed) {
      return {
        ok: false,
        errorType: "integration_requires_review",
        error: "Serial integration requires an explicit Codex review confirmation before applying a worktree or branch patch.",
        suggestedFix: "Run a dryRun first, inspect the patch preview/changed files, then retry with reviewed: true when Codex approves the integration.",
        changedFiles: patch.changedFiles,
      };
    }


    const receiptError = integrationPreviewReceiptError(previewReceipt, currentPreviewIdentity, true);
    if (receiptError) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        error: receiptError,
        changedFiles: patch.changedFiles,
        patchSha256: patch.patchSha256,
        targetStateSha256: targetState.targetStateSha256,
      };
    }

    const immediateTargetState = await captureIntegrationTargetState(targetCwd);
    if (!immediateTargetState.ok || immediateTargetState.targetStateSha256 !== previewReceipt.targetStateSha256) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        error: "Integration target changed after preview and before patch application.",
        changedFiles: patch.changedFiles,
      };
    }

    const simulation = await simulateIntegrationPatchSnapshot({
      cwd: targetCwd,
      targetHead: immediateTargetState.targetHead,
      patchFile,
      files: patch.changedFiles,
    });
    if (!simulation.ok) {
      return {
        ok: false,
        errorType: simulation.errorType,
        error: `${simulation.error} The target was not modified and the source was retained.`,
        changedFiles: patch.changedFiles,
      };
    }
    expectedPostApplySnapshot = simulation.snapshot;
    preApplyExactSnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
    preApplyIndexSnapshot = await gitIndexPathSnapshot(targetCwd, patch.changedFiles);
    rollbackBaseline = await captureRollbackBaseline(targetCwd);
    before = await gitChangedFileSnapshot(targetCwd);
    const finalPreApplyState = await captureIntegrationTargetState(targetCwd);
    if (!finalPreApplyState.ok
      || rollbackBaseline.baseCommit !== previewReceipt.targetHead
      || finalPreApplyState.targetStateSha256 !== previewReceipt.targetStateSha256) {
      return {
        ok: false,
        errorType: "integration_preview_stale",
        error: "Integration target changed during final preparation. The patch was not applied and the source was retained.",
        changedFiles: patch.changedFiles,
        expectedTargetHead: previewReceipt.targetHead,
        actualTargetHead: finalPreApplyState.targetHead || rollbackBaseline.baseCommit || "",
      };
    }
    preApplyFullIndexSha256 = finalPreApplyState.indexSha256;
    if (typeof beforeApplyHook === "function") {
      await beforeApplyHook({ targetCwd, patch, targetState: finalPreApplyState });
    }
    const immediatePreApplyState = await captureIntegrationTargetState(targetCwd);
    if (!immediatePreApplyState.ok || immediatePreApplyState.targetStateSha256 !== previewReceipt.targetStateSha256) {
      let unresolvedFiles = [];
      try {
        unresolvedFiles = changedFilesBetween(before, await gitChangedFileSnapshot(targetCwd));
      } catch {
        unresolvedFiles = patch.changedFiles;
      }
      const headChanged = Boolean(
        immediatePreApplyState.targetHead
        && immediatePreApplyState.targetHead !== previewReceipt.targetHead
      );
      if (headChanged) {
        const committedChanges = await runCommand(
          "git",
          ["diff", "--name-only", "-z", "--no-renames", `${previewReceipt.targetHead}..${immediatePreApplyState.targetHead}`, "--"],
          targetCwd,
          1000 * 15,
        );
        unresolvedFiles = normalizeLockPathList(
          unresolvedFiles.concat(committedChanges.exitCode === 0 ? committedChanges.stdout.split("\0") : patch.changedFiles),
        );
      }
      return {
        ok: false,
        errorType: headChanged ? "integration_target_head_changed" : "integration_preview_stale",
        error: "Integration target changed immediately before patch application. The reviewed patch was not applied, external state was retained, and the source remains available.",
        changedFiles: patch.changedFiles,
        unexpectedTargetChanges: unresolvedFiles,
        expectedTargetHead: previewReceipt.targetHead,
        actualTargetHead: immediatePreApplyState.targetHead || "",
        rollback: {
          rollback: headChanged || unresolvedFiles.length ? "not_attempted_unattributed_changes" : "not_needed",
          rollbackFiles: [],
          unresolvedFiles,
          ownershipMismatches: unresolvedFiles,
        },
      };
    }
    const applied = await applyPatchFile({ cwd: targetCwd, patchFile, targetHead: previewReceipt.targetHead, files: patch.changedFiles });
    if (applied.exitCode !== 0) {
      const indexReset = await isolatedIndexPreservationEvidence({ cwd: targetCwd, files: patch.changedFiles, baselineSnapshot: preApplyIndexSnapshot });
      let changedSincePreApply = patch.changedFiles;
      try {
        const failedApplySnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
        changedSincePreApply = snapshotMismatches(preApplyExactSnapshot, failedApplySnapshot, patch.changedFiles);
      } catch {
        // Without exact evidence, retain every potentially changed file.
      }
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: changedSincePreApply,
        ownedSnapshot: expectedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: "integration_apply_failed",
        error: `${applied.stderr || applied.stdout || "Patch apply failed."} Only files still matching exact bridge-owned post-patch bytes were eligible for rollback; ambiguous files were retained.`,
        changedFiles: patch.changedFiles,
        indexReset,
        rollback,
      };
    }
    patchApplied = true;

    const postApplyHead = await captureGitHead(targetCwd);
    if (postApplyHead !== previewReceipt.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed during patch application. No rollback or index reset was attempted because ownership is ambiguous; the source was retained.",
        changedFiles: patch.changedFiles,
        expectedTargetHead: previewReceipt.targetHead,
        actualTargetHead: postApplyHead,
        indexReset: { ok: false, resetFiles: [], ownershipMismatches: patch.changedFiles, errors: ["Target HEAD changed; index ownership is ambiguous."] },
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: patch.changedFiles, ownershipMismatches: patch.changedFiles },
      };
    }

    ownedPostApplySnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
    const postApplyContentMismatches = await integrationContentMismatches(
      targetCwd,
      expectedPostApplySnapshot,
      ownedPostApplySnapshot,
      patch.changedFiles,
      { eolRecords: applied.isolatedEolRecords },
    );
    const actualPostApplyIndexSnapshot = await gitIndexPathSnapshot(targetCwd, patch.changedFiles);
    const postApplyIndexMismatches = snapshotMismatches(preApplyIndexSnapshot, actualPostApplyIndexSnapshot, patch.changedFiles);
    if (postApplyContentMismatches.length || postApplyIndexMismatches.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: expectedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: postApplyContentMismatches.length
          ? "integration_post_apply_content_mismatch"
          : "integration_post_apply_index_mismatch",
        error: "Target bytes did not exactly match the reviewed patch or the real Git index changed concurrently. The bridge used an isolated index and never reset the real index; exact bridge-owned worktree state was rolled back while ambiguous external changes were retained.",
        changedFiles: patch.changedFiles,
        contentMismatches: postApplyContentMismatches,
        indexMismatches: postApplyIndexMismatches,
        indexReset,
        rollback,
      };
    }

    const after = await gitChangedFileSnapshot(targetCwd);
    const appliedFiles = changedFilesBetween(before, after);
    const appliedPathEvidence = changedPathSetEvidence(patch.changedFiles, appliedFiles);
    const appliedValidation = validateChangedFilesForPlan({ changedFiles: appliedFiles, lockPlan, parallel: false });
    if (appliedValidation.disallowedFiles.length
      || appliedPathEvidence.missingFiles.length
      || appliedPathEvidence.unexpectedFiles.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({ cwd: targetCwd, baseline: rollbackBaseline, files: patch.changedFiles, ownedSnapshot: ownedPostApplySnapshot });
      return {
        ok: false,
        errorType: appliedValidation.disallowedFiles.length
          ? changedFileValidationErrorType(appliedValidation)
          : "integration_post_apply_path_mismatch",
        error: "The target path set did not exactly match the reviewed patch. Matching bridge-owned state was rolled back; unexpected external paths and the source were retained.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        missingFiles: appliedPathEvidence.missingFiles,
        unexpectedFiles: appliedPathEvidence.unexpectedFiles,
        disallowedFiles: appliedValidation.disallowedFiles,
        indexReset,
        rollback,
      };
    }

    if (validationPolicyTrust) {
      const currentPolicy = await loadProjectAgentPolicy(targetCwd, validationPolicyTrust.path);
      const stillTrusted = currentPolicy.ok
        && currentPolicy.sha256 === validationPolicyTrust.sha256
        && currentPolicy.policy?.finalValidationSpec?.commandSha256 === validationPolicyTrust.commandSha256;
      if (!stillTrusted) {
        const indexReset = await isolatedIndexPreservationEvidence({
          cwd: targetCwd,
          files: patch.changedFiles,
          baselineSnapshot: preApplyIndexSnapshot,
        });
        const rollback = await rollbackVerifiedOwnedChanges({
          cwd: targetCwd,
          baseline: rollbackBaseline,
          files: appliedFiles.length ? appliedFiles : patch.changedFiles,
          ownedSnapshot: ownedPostApplySnapshot,
        });
        return {
          ok: false,
          errorType: "policy_validation_command_untrusted",
          error: "Project policy trust changed after patch application and before validation; target rollback was attempted and the source was retained.",
          changedFiles: patch.changedFiles,
          appliedFiles,
          indexReset,
          rollback,
        };
      }
    }

    if (typeof beforeValidationHook === "function") {
      await beforeValidationHook({ targetCwd, patch, appliedFiles });
    }
    const validationGate = await runValidationGate({ command: validationCommand, cwd: targetCwd, trustedSpec: validationTrustedSpec });
    const afterValidation = await gitChangedFileSnapshot(targetCwd);
    const postValidationIndex = await captureGitIndexIdentity(targetCwd);
    const validationIndexChanged = !postValidationIndex.ok || postValidationIndex.indexSha256 !== preApplyFullIndexSha256;
    const postValidationFiles = changedFilesBetween(before, afterValidation);
    const validationMutationFiles = changedFilesBetween(after, afterValidation);
    const postValidation = validateChangedFilesForPlan({ changedFiles: postValidationFiles, lockPlan, parallel: false });
    let postValidationContentMismatches = patch.changedFiles;
    try {
      const postValidationExactSnapshot = await exactIntegrationFileSnapshot(targetCwd, patch.changedFiles);
      postValidationContentMismatches = snapshotMismatches(ownedPostApplySnapshot, postValidationExactSnapshot, patch.changedFiles);
    } catch {
      // Exact evidence is mandatory for acceptance; retain potentially external content.
    }
    const postValidationHead = await captureGitHead(targetCwd);
    if (postValidationHead !== previewReceipt.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed during validation. No rollback or index reset was attempted because ownership is ambiguous; the source was retained.",
        changedFiles: patch.changedFiles,
        appliedFiles: postValidationFiles,
        expectedTargetHead: previewReceipt.targetHead,
        actualTargetHead: postValidationHead,
        validationGate,
        indexReset: { ok: false, resetFiles: [], ownershipMismatches: patch.changedFiles, errors: ["Target HEAD changed; index ownership is ambiguous."] },
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: normalizeLockPathList(patch.changedFiles.concat(validationMutationFiles)), ownershipMismatches: normalizeLockPathList(patch.changedFiles.concat(validationMutationFiles)) },
      };
    }
    if (validationGate.errorType
      || validationIndexChanged
      || validationMutationFiles.length
      || postValidation.disallowedFiles.length
      || postValidationContentMismatches.length) {
      const indexReset = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: ownedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: validationIndexChanged
          ? "integration_validation_mutated_unapproved_files"
          : validationMutationFiles.length || postValidation.disallowedFiles.length || postValidationContentMismatches.length
          ? (postValidation.disallowedFiles.length || validationMutationFiles.some((file) => !patch.changedFiles.includes(file))
            ? "integration_validation_mutated_unapproved_files"
            : "integration_validation_mutated_reviewed_files")
          : validationGate.errorType,
        error: validationGate.errorType && !validationIndexChanged && !validationMutationFiles.length && !postValidationContentMismatches.length
          ? "Validation command failed after serial integration; exact bridge-owned state was rolled back and the source was retained."
          : validationIndexChanged
            ? "Validation or concurrent activity changed the exact real Git index. The bridge preserved that external index state, rolled back only exact bridge-owned worktree bytes, and retained the source."
            : "Validation or concurrent activity changed target content after the reviewed patch was applied. Only exact bridge-owned patch state was rolled back; external paths, ambiguous state, and the source were retained.",
        changedFiles: patch.changedFiles,
        appliedFiles: postValidationFiles,
        validationMutationFiles,
        disallowedFiles: postValidation.disallowedFiles,
        contentMismatches: postValidationContentMismatches,
        validationIndexChanged,
        expectedIndexSha256: preApplyFullIndexSha256,
        actualIndexSha256: postValidationIndex.indexSha256 || "",
        indexIdentityError: postValidationIndex.ok ? "" : postValidationIndex.error,
        validationGate,
        indexReset,
        rollback,
      };
    }

    const indexReset = await isolatedIndexPreservationEvidence({
      cwd: targetCwd,
      files: patch.changedFiles,
      baselineSnapshot: preApplyIndexSnapshot,
    });
    if (!indexReset.ok) {
      const rollback = await rollbackVerifiedOwnedChanges({ cwd: targetCwd, baseline: rollbackBaseline, files: patch.changedFiles, ownedSnapshot: ownedPostApplySnapshot });
      return {
        ok: false,
        errorType: "integration_index_changed",
        error: "The real Git index changed concurrently. The bridge never wrote or reset it, rejected the integration, and retained the external staged state and source.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        validationGate,
        indexReset,
        rollback,
      };
    }

    const finalTargetHead = await captureGitHead(targetCwd);
    if (finalTargetHead !== previewReceipt.targetHead) {
      return {
        ok: false,
        errorType: "integration_target_head_changed",
        error: "Target HEAD changed before integration completion. The isolated real index was preserved, no ambiguous rollback was attempted, and the source was retained.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        expectedTargetHead: previewReceipt.targetHead,
        actualTargetHead: finalTargetHead,
        validationGate,
        indexReset,
        rollback: { rollback: "not_attempted_unattributed_changes", rollbackFiles: [], unresolvedFiles: patch.changedFiles, ownershipMismatches: patch.changedFiles },
      };
    }

    const integratedTargetState = await captureIntegrationTargetState(targetCwd);
    if (!integratedTargetState.ok) {
      const error = new Error(integratedTargetState.error || "Could not capture the exact integrated target state before completion.");
      error.errorType = integratedTargetState.errorType || "integration_target_state_failed";
      throw error;
    }
    if (integratedTargetState.indexSha256 !== preApplyFullIndexSha256) {
      const finalIndexEvidence = await isolatedIndexPreservationEvidence({
        cwd: targetCwd,
        files: patch.changedFiles,
        baselineSnapshot: preApplyIndexSnapshot,
      });
      const rollback = await rollbackVerifiedOwnedChanges({
        cwd: targetCwd,
        baseline: rollbackBaseline,
        files: patch.changedFiles,
        ownedSnapshot: ownedPostApplySnapshot,
      });
      return {
        ok: false,
        errorType: "integration_index_changed",
        error: "The exact real Git index changed before integration completion. The bridge preserved the external index state, rolled back only exact bridge-owned worktree bytes, and retained the source.",
        changedFiles: patch.changedFiles,
        appliedFiles,
        validationGate,
        expectedIndexSha256: preApplyFullIndexSha256,
        actualIndexSha256: integratedTargetState.indexSha256,
        indexReset: finalIndexEvidence,
        rollback,
      };
    }

    return {
      ok: true,
      status: "applied",
      sourceType: patch.sourceType,
      source: patch.source,
      changedFiles: patch.changedFiles,
      appliedFiles,
      dryRun: false,
      validationGate,
      patchSha256: patch.patchSha256,
      sourceBaseCommit: patch.sourceBaseCommit,
      sourceStateSha256: patch.sourceStateSha256,
      targetPreviewStateSha256: targetState.targetStateSha256,
      integratedTargetStateSha256: integratedTargetState.targetStateSha256,
      contractSha256,
      previewId: previewReceipt.previewId,
      preExistingTargetChanges: targetChanges,
      allowDirtyTarget: Boolean(allowDirtyTarget),
    };
  } catch (error) {
    let indexReset = null;
    let rollback = null;
    if (patchApplied && rollbackBaseline) {
      try {
        indexReset = await isolatedIndexPreservationEvidence({
          cwd: targetCwd,
          files: patch.changedFiles,
          baselineSnapshot: preApplyIndexSnapshot,
        });
      } catch (resetError) {
        indexReset = { ok: false, error: resetError.message || String(resetError) };
      }
      try {
        rollback = await rollbackVerifiedOwnedChanges({
          cwd: targetCwd,
          baseline: rollbackBaseline,
          files: patch.changedFiles,
          ownedSnapshot: ownedPostApplySnapshot,
        });
      } catch (rollbackError) {
        rollback = { ok: false, unresolvedFiles: patch.changedFiles, errors: [rollbackError.message || String(rollbackError)] };
      }
    }
    return {
      ok: false,
      errorType: "integration_transaction_failed",
      error: `Serial integration encountered an infrastructure error${patchApplied ? " after patch application; rollback was attempted" : " before patch application"}. The source was retained. ${redactSensitiveText(error.message || String(error))}`,
      changedFiles: patch.changedFiles,
      indexReset,
      rollback,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function integrationCleanupTargetStateError(cwd, expectedTargetStateSha256) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedTargetStateSha256 || ""))) {
    return "The integrated target state was not attested; the recovery source was retained.";
  }
  const current = await captureIntegrationTargetState(cwd);
  if (!current.ok) return current.error || "The target state could not be reverified immediately before source cleanup.";
  return current.targetStateSha256 === expectedTargetStateSha256
    ? ""
    : "The target changed after reviewed integration; the recovery source was retained.";
}

async function cleanupIntegratedWorktreeWhileLocked({
  result,
  cwd,
  worktreePath,
  deferCleanup = false,
  beforeCleanupHook = null,
}) {
  if (!result?.ok || result.status !== "applied" || !worktreePath) return;
  if (result.validationGate?.status !== "passed") {
    result.sourceCleanup = {
      cleanup: "retained_for_review",
      reason: "cleanup requires an explicit passing validation gate; skipped validation is not success",
    };
    return;
  }

  const sourceMatches = async () => {
    const current = await collectIntegrationPatch({
      cwd,
      worktreePath,
      sourceBaseCommit: result.sourceBaseCommit,
    });
    return current.ok
      && current.patchSha256 === result.patchSha256
      && current.sourceStateSha256 === result.sourceStateSha256;
  };
  if (!await sourceMatches()) {
    result.sourceCleanup = { cleanup: "retained_for_review", reason: "integration_source_changed_after_review" };
    result.cleanupWarning = "The source worktree changed during or after integration validation; it was retained and not force-removed.";
    return;
  }
  if (deferCleanup) {
    result.sourceCleanup = {
      cleanup: "deferred_until_pipeline_finalization",
      reason: "pipeline final validation, reviewer, and tester gates must all pass before deletion",
    };
    return;
  }

  const preliminaryTargetError = await integrationCleanupTargetStateError(cwd, result.integratedTargetStateSha256);
  if (preliminaryTargetError) {
    result.sourceCleanup = { cleanup: "retained_for_review", reason: "integration_target_changed_before_cleanup", error: preliminaryTargetError };
    result.cleanupWarning = preliminaryTargetError;
    return;
  }
  if (typeof beforeCleanupHook === "function") {
    await beforeCleanupHook({ targetCwd: cwd, worktreePath, result });
  }

  const sourceBranch = await runCommand("git", ["branch", "--show-current"], worktreePath, 1000 * 15);
  const finalTargetError = await integrationCleanupTargetStateError(cwd, result.integratedTargetStateSha256);
  const finalSourceMatches = await sourceMatches();
  if (finalTargetError || !finalSourceMatches || sourceBranch.exitCode !== 0 || !sourceBranch.stdout.trim()) {
    result.sourceCleanup = {
      cleanup: "retained_for_review",
      reason: finalTargetError
        ? "integration_target_changed_before_cleanup"
        : !finalSourceMatches
          ? "integration_source_changed_after_review"
          : "source_branch_identity_unverified",
      error: finalTargetError || (!finalSourceMatches
        ? "The source worktree changed before destructive cleanup."
        : sourceBranch.stderr || "The source branch could not be verified immediately before cleanup."),
    };
    result.cleanupWarning = result.sourceCleanup.error;
    return;
  }

  result.sourceCleanup = await cleanupWorktree(
    {
      path: path.resolve(worktreePath),
      repoRoot: path.resolve(cwd),
      branch: sourceBranch.stdout.trim(),
    },
    "always",
    true
  );
  if (result.sourceCleanup.cleanup === "failed") {
    result.cleanupWarning = result.sourceCleanup.error || "Integrated source worktree could not be removed.";
  }
}

function stateDbPath(cwd = "") {
  const root = cwd ? path.resolve(cwd) : "";
  const stateRoot = effectiveBridgeStateDirectory();
  if (root && root !== path.parse(root).root) {
    return path.join(stateRoot, "projects", `${projectStateKey(root)}.sqlite`);
  }
  return path.join(stateRoot, "bridge-state.sqlite");
}

function heartbeatKnownQueueState() {
  const heartbeatAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  for (const dbPath of KNOWN_STATE_DB_PATHS) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA synchronous = FULL;");
      db.exec("PRAGMA secure_delete = ON;");
      db.prepare(`
        INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          process_id = excluded.process_id,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
      `).run(BRIDGE_INSTANCE_ID, process.pid, heartbeatAt, heartbeatAt, leaseExpiresAt);
      db.prepare("DELETE FROM bridge_instances WHERE lease_expires_at < ?").run(new Date(Date.now() - CONFIG.queueStaleAfterMs).toISOString());
      const localRecords = [...QUEUE_JOBS.values()].filter((record) =>
        record.ownerInstanceId === BRIDGE_INSTANCE_ID
        && ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"].includes(record.status)
        && stateDbPath(record.cwd) === dbPath
      );
      for (const record of localRecords) {
        renewPersistedQueueRecordLease(db, record, heartbeatAt, leaseExpiresAt);
      }
      const cancellationRows = db.prepare(`
        SELECT job_id, revision, cancellation_requested_at FROM opencode_jobs
        WHERE owner_instance_id = ? AND cancellation_requested_at IS NOT NULL AND cancellation_requested_at <> ''
          AND status IN ('held', 'pending', 'planned', 'blocked', 'running', 'validating', 'reviewing', 'testing')
      `).all(BRIDGE_INSTANCE_ID);
      for (const row of cancellationRows) {
        const record = QUEUE_JOBS.get(row.job_id);
        if (record) {
          record.revision = Number(row.revision || record.revision || 0);
          record.cancellationRequested = true;
          record.cancellationRequestedAt = row.cancellation_requested_at || record.cancellationRequestedAt || "";
          record.abortController?.abort();
        }
      }
      reconcileStaleQueueRecords(db, Date.now());
    } catch (error) {
      logEvent("warn", "queue.heartbeat_failed", { dbPath, error: error.message || String(error) });
    } finally {
      if (db) closeDb(db);
    }
  }
  for (const record of QUEUE_JOBS.values()) {
    if (["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"].includes(record.status) && record.ownerInstanceId === BRIDGE_INSTANCE_ID) {
      record.heartbeatAt = heartbeatAt;
      record.leaseExpiresAt = leaseExpiresAt;
    }
  }
}

function ensureQueueHeartbeatTimer() {
  if (process.argv.includes("--self-test")) return;
  if (queueHeartbeatTimer) return;
  queueHeartbeatTimer = setInterval(heartbeatKnownQueueState, CONFIG.queueHeartbeatMs);
  queueHeartbeatTimer.unref?.();
}

async function resolveProjectStateRoot(cwd = "") {
  const base = path.resolve(cwd || process.cwd());
  const repoRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], base, 1000 * 15);
  return repoRoot.exitCode === 0 && repoRoot.stdout.trim()
    ? path.resolve(repoRoot.stdout.trim())
    : base;
}

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

function lockTableHasCompositePrimaryKey(db) {
  const primaryKeyColumns = db.prepare("PRAGMA table_info(locks)").all()
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  return primaryKeyColumns.length === 2
    && primaryKeyColumns[0] === "normalized_path"
    && primaryKeyColumns[1] === "run_id";
}

function ensureLockTableSchema(db) {
  if (lockTableHasCompositePrimaryKey(db)) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!lockTableHasCompositePrimaryKey(db)) {
      db.exec(`
        ALTER TABLE locks RENAME TO locks_legacy_single_path;
        CREATE TABLE locks (
          normalized_path TEXT NOT NULL,
          owner_agent TEXT NOT NULL,
          acquisition_origin TEXT NOT NULL DEFAULT 'legacy',
          run_id TEXT NOT NULL,
          token TEXT NOT NULL,
          lock_mode TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          cwd TEXT,
          task TEXT,
          PRIMARY KEY (normalized_path, run_id)
        );
        INSERT OR IGNORE INTO locks
          (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task)
        SELECT normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task
        FROM locks_legacy_single_path;
        DROP TABLE locks_legacy_single_path;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

function ensureTableColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || String(error))) throw error;
    }
  }
}

function ensureQueueLeaseSchema(db) {
  ensureTableColumn(db, "opencode_jobs", "owner_instance_id", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "owner_process_id", "INTEGER");
  ensureTableColumn(db, "opencode_jobs", "owner_generation", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "updated_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "heartbeat_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "lease_expires_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "cancellation_requested_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "child_process_id", "INTEGER");
  ensureTableColumn(db, "opencode_jobs", "child_process_started_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, "opencode_jobs", "idempotency_key", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "request_encrypted", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS opencode_jobs_idempotency_idx ON opencode_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';");
}

function ensurePipelineRevisionSchema(db) {
  ensureTableColumn(db, "opencode_pipelines", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, "opencode_pipelines", "request_encrypted", "TEXT");
}

function scrubLegacyLockSecrets(db) {
  const rows = db.prepare("SELECT rowid, token, task FROM locks").all();
  const update = db.prepare("UPDATE locks SET token = ?, task = ? WHERE rowid = ?");
  for (const row of rows) {
    const token = String(row.token || "");
    const task = String(row.task || "");
    const tokenDigest = /^sha256:[a-f0-9]{64}$/i.test(token)
      ? token.toLowerCase()
      : `sha256:${createHash("sha256").update(token).digest("hex")}`;
    const taskDigest = /^sha256:[a-f0-9]{64}$/i.test(task)
      ? task.toLowerCase()
      : `sha256:${createHash("sha256").update(task).digest("hex")}`;
    if (token !== tokenDigest || task !== taskDigest) update.run(tokenDigest, taskDigest, row.rowid);
  }
}

async function openLockDb(cwd = "") {
  const dbPath = stateDbPath(await resolveProjectStateRoot(cwd));
  await mkdir(path.dirname(dbPath), { recursive: true });
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA secure_delete = ON;");
      const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode || "").toLowerCase();
      if (journalMode !== "wal") {
        db.exec("PRAGMA journal_mode = WAL;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS locks (
          normalized_path TEXT NOT NULL,
          owner_agent TEXT NOT NULL,
          acquisition_origin TEXT NOT NULL DEFAULT 'legacy',
          run_id TEXT NOT NULL,
          token TEXT NOT NULL,
          lock_mode TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          cwd TEXT,
          task TEXT,
          PRIMARY KEY (normalized_path, run_id)
        );
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          status TEXT NOT NULL,
          lock_mode TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS changed_files (
          run_id TEXT NOT NULL,
          path TEXT NOT NULL,
          allowed INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS opencode_jobs (
          job_id TEXT PRIMARY KEY,
          cwd TEXT,
          status TEXT NOT NULL,
          agent TEXT NOT NULL,
          mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          record_json TEXT NOT NULL,
          idempotency_key TEXT,
          request_encrypted TEXT
        );
        CREATE TABLE IF NOT EXISTS opencode_pipelines (
          pipeline_id TEXT PRIMARY KEY,
          cwd TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          record_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          request_encrypted TEXT
        );
        CREATE TABLE IF NOT EXISTS bridge_instances (
          instance_id TEXT PRIMARY KEY,
          process_id INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        );
      `);
      ensureLockTableSchema(db);
      ensureTableColumn(db, "locks", "acquisition_origin", "TEXT NOT NULL DEFAULT 'legacy'");
      ensureQueueLeaseSchema(db);
      ensurePipelineRevisionSchema(db);
      scrubLegacyLockSecrets(db);
      const heartbeatAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      db.prepare(`
        INSERT INTO bridge_instances (instance_id, process_id, started_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          process_id = excluded.process_id,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
      `).run(BRIDGE_INSTANCE_ID, process.pid, heartbeatAt, heartbeatAt, leaseExpiresAt);
      db.exec("CREATE INDEX IF NOT EXISTS locks_expires_at_idx ON locks (expires_at)");
      db.exec("CREATE INDEX IF NOT EXISTS opencode_jobs_lease_idx ON opencode_jobs (status, lease_expires_at)");
      KNOWN_STATE_DB_PATHS.add(dbPath);
      ensureQueueHeartbeatTimer();
      prunePersistedState(db, dbPath);
      return db;
    } catch (error) {
      if (db) {
        closeDb(db);
      }
      const retryable = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error));
      if (!retryable || attempt === maxAttempts - 1) {
        throw error;
      }
      const delayMs = Math.min(1000, 25 * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("SQLite lock database could not be opened.");
}

function closeDb(db) {
  try {
    db.close();
  } catch {
    // Nothing useful to do during cleanup.
  }
}

function hardLockPathsForPlan(lockPlan) {
  return firstNonEmptyList(lockPlan.allowedEdits, lockPlan.lockedPaths);
}

function hardLockTtlForPlan(lockPlan) {
  const executionTimeoutMs = timeoutForAgent(lockPlan?.agent, lockPlan, lockPlan?.timeoutMs);
  const safetyMarginMs = CONFIG.validationCommandTimeoutMs + 1000 * 60 * 5;
  return Math.max(DEFAULT_LOCK_TTL_MS, executionTimeoutMs + safetyMarginMs);
}

function hardLockSummary(acquiredLock) {
  if (!acquiredLock) {
    return "not acquired";
  }

  return `${acquiredLock.id} (${acquiredLock.lockType}: ${acquiredLock.paths.join(", ")})`;
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
  return [
    `JOB ${index + 1}`,
    `Requested agent: ${resolution?.requestedAgent || lockPlan.agent}`,
    `Requested agent mode: ${resolution?.requestedAgentMode || "unknown"}`,
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
    "Silent model fallback: disabled",
    `Effective edit permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canEdit ? "enabled" : "denied") : "unattested"}`,
    `Effective task permission: ${resolution?.agentMetadata ? (resolution.agentMetadata.canDelegate ? "enabled" : "denied") : "unattested"}`,
    `Effective external-directory permission denied: ${resolution?.agentMetadata?.externalDirectoryDenied ? "yes" : "no/unattested"}`,
    `Would run: ${resolution?.actualAgent ? commandShape(resolution.actualAgent, resolution.agentMetadata) : "no"}`,
    `Would acquire lock: ${lockPlan.lockType === "read" ? "no" : "yes"}`,
    `Lock mode: ${lockPlan.lockMode}`,
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
    cwd: z.string().optional().describe("Repository path."),
    lockType: z.enum(["read", "write", "serial_integration"]).optional(),
    paths: z.array(z.string()).min(1).describe("Concrete files or directories to lock."),
    ttlMs: z.number().int().positive().optional().describe("Lease duration in milliseconds. Defaults to 30 minutes."),
  },
  async ({ owner = "codex", agent = "opencode", task = "", cwd = "", lockType = "write", paths, ttlMs = DEFAULT_LOCK_TTL_MS }) => {
    const result = await acquireHardLock({ owner, agent, origin: "manual", task, cwd, lockType, paths, ttlMs });
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
                `Expires at: ${new Date(result.lock.expiresAt).toISOString()}`,
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
    cwd: z.string().optional().describe("Repository path for the lock registry."),
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
                `Active locks remaining: ${result.activeLocksUnavailable ? "unavailable" : result.activeLocks.length}`,
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
    cwd: z.string().optional().describe("Repository path for the lock registry."),
  },
  async ({ cwd = "" }) => {
    const locks = await listLocks(cwd);

    return {
      content: [
        {
          type: "text",
          text: locks.length
            ? [
                "Active temporary locks:",
                "",
                ...locks.map((lock) =>
                  [
                    `- ${lock.id}`,
                    `  owner: ${lock.owner}`,
                    `  agent: ${lock.agent}`,
                    `  type: ${lock.lockType}`,
                    `  paths: ${lock.paths.join(", ")}`,
                    `  expires: ${new Date(lock.expiresAt).toISOString()}`,
                  ].join("\n")
                ),
              ].join("\n")
            : "No active temporary locks.",
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
    cwd: z.string().optional(),
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
  "Check OpenCode, Git, agent discovery, and the bridge's effective safety configuration.",
  {
    cwd: z.string().optional().describe("Repository path used for command and agent discovery checks."),
  },
  async ({ cwd }) => {
    const pluginPolicy = await verifyExternalPluginPolicy(cwd);
    if (!pluginPolicy.ok) {
      return { content: [{ type: "text", text: `OpenCode MCP bridge status: attention required.\n\nPlugin policy: rejected\nReason: ${pluginPolicy.error}` }] };
    }
    const [openCodeVersion, gitVersion, agentDiscovery, safeOrchestratorDebug, contractorOrchestratorMetadata, contractorNestedAttestation, sanitizedReaderMetadata, managedSkillEvidence, providerCapacity] = await Promise.all([
      safeOpenCodeCommand(["--version"], cwd, 1000 * 30),
      runCommand("git", ["--version"], cwd, 1000 * 30),
      listAvailableAgents(cwd),
      safeOpenCodeCommand(["debug", "agent", MCP_ORCHESTRATOR_AGENT], cwd, 1000 * 30),
      readAgentDebugMetadata(MCP_CONTRACTOR_ORCHESTRATOR_AGENT, cwd || process.cwd()),
      attestContractorNestedAgents(cwd || process.cwd()),
      readAgentDebugMetadata(MCP_SANITIZED_READER_AGENT, cwd || process.cwd(), { forcePure: true }),
      managedSkillSourceEvidence(),
      providerCapacitySnapshot(),
    ]);
    const availableAgents = availableAgentLabels(agentDiscovery.agents);
    const missingRequiredAgents = GLOBALLY_REQUIRED_MANAGED_AGENTS.filter((agent) => !agentDiscovery.agents.has(agent));
    const sanitizedReaderPolicyError = sanitizedAgentMetadataError(sanitizedReaderMetadata, path.resolve(cwd || process.cwd()));
    let safeOrchestratorPolicy = null;
    try {
      safeOrchestratorPolicy = JSON.parse(safeOrchestratorDebug.stdout);
    } catch {
      safeOrchestratorPolicy = null;
    }
    const safeOrchestratorEnforced = safeOrchestratorDebug.exitCode === 0
      && safeOrchestratorPolicy?.name === MCP_ORCHESTRATOR_AGENT
      && safeOrchestratorPolicy?.tools?.apply_patch === false
      && safeOrchestratorPolicy?.tools?.task === false;
    const contractorOrchestratorPolicy = contractorOrchestratorMetadata?.metadata || null;
    const contractorOrchestratorEnforced = contractorOrchestratorMetadata?.ok
      && contractorOrchestratorPolicy?.name === MCP_CONTRACTOR_ORCHESTRATOR_AGENT
      && contractorOrchestratorPolicy?.canEdit === false
      && contractorOrchestratorPolicy?.canDelegate === true
      && contractorOrchestratorPolicy?.bashDenied === true
      && contractorOrchestratorPolicy?.skillDenied === true;
    const contractorSubagentAllowlistEnforced = contractorOrchestratorPolicy?.taskDelegationAllowlistSafe === true;
    const healthy = openCodeVersion.exitCode === 0
      && gitVersion.exitCode === 0
      && agentDiscovery.result.exitCode === 0
      && missingRequiredAgents.length === 0
      && safeOrchestratorEnforced
      && contractorOrchestratorEnforced
      && contractorSubagentAllowlistEnforced
      && contractorNestedAttestation.ok
      && managedSkillEvidence.ok
      && !sanitizedReaderPolicyError;

    return {
      content: [
        {
          type: "text",
          text: [
            healthy ? "OpenCode MCP bridge status: healthy." : "OpenCode MCP bridge status: attention required.",
            "",
            `OpenCode executable: ${OPENCODE_EXE}`,
            `OpenCode version: ${(openCodeVersion.stdout || openCodeVersion.stderr || "unavailable").trim()}`,
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
            `MCP orchestrator edit permission denied: ${safeOrchestratorPolicy?.tools?.apply_patch === false ? "yes" : "no"}`,
            `MCP orchestrator nested task permission denied: ${safeOrchestratorPolicy?.tools?.task === false ? "yes" : "no"}`,
            `MCP contractor orchestrator execution agent: ${MCP_CONTRACTOR_ORCHESTRATOR_AGENT}`,
            `MCP contractor direct edit permission denied: ${contractorOrchestratorPolicy?.canEdit === false ? "yes" : "no"}`,
            `MCP contractor nested task permission enabled: ${contractorOrchestratorPolicy?.canDelegate === true ? "yes" : "no"}`,
            `MCP contractor shell permission denied: ${contractorOrchestratorPolicy?.bashDenied === true ? "yes" : "no"}`,
            `MCP contractor skill permission denied: ${contractorOrchestratorPolicy?.skillDenied === true ? "yes" : "no"}`,
            `MCP contractor subagent allowlist enforced: ${contractorSubagentAllowlistEnforced ? "yes" : "no"}`,
            `MCP contractor nested agent profiles attested: ${contractorNestedAttestation.ok ? "yes" : "no"}`,
            `MCP contractor nested agent policy error: ${contractorNestedAttestation.ok ? "none" : contractorNestedAttestation.error}`,
            `MCP sanitized reader isolated policy attested: ${sanitizedReaderPolicyError ? "no" : "yes"}`,
            `MCP sanitized reader policy error: ${sanitizedReaderPolicyError?.error || "none"}`,
            `Agent discovery exit code: ${agentDiscovery.result.exitCode}`,
            `Available agents: ${availableAgents.length ? availableAgents.join(", ") : "none discovered"}`,
            `Missing required managed agents: ${missingRequiredAgents.length ? missingRequiredAgents.join(", ") : "none"}`,
            "",
            `Worktree mode: ${CONFIG.worktreeMode}`,
            `Worktree root: ${CONFIG.worktreeRoot}`,
            `Worktree cleanup: ${CONFIG.worktreeCleanup}`,
            `Queue mode: ${effectiveQueueMode()}`,
            `Queue write conflict policy: ${effectiveQueueWriteConflictPolicy()}`,
            `Queue blocked poll ms: ${CONFIG.queueBlockedPollMs}`,
            `Queue stale after ms: ${CONFIG.queueStaleAfterMs}`,
            `Read lock mode: ${CONFIG.defaultReadLockMode}`,
            `Write lock mode: ${CONFIG.defaultWriteLockMode}`,
            `Parallel write lock mode: ${CONFIG.defaultParallelWriteLockMode}`,
            `Contractor orchestrator timeout ms: ${CONFIG.contractorOrchestratorTimeoutMs}`,
            `Bridge state directory: ${GLOBAL_BRIDGE_STATE_DIR}`,
            `OpenCode external plugins: ${CONFIG.allowExternalPlugins ? "enabled (exact allowlist and pinned tree verified)" : "disabled (--pure)"}`,
            `External plugin manifest SHA-256: ${pluginPolicy.manifestSha256 || "not applicable"}`,
            `Provider/account concurrency limit: ${CONFIG.providerConcurrencyLimit}`,
            `Provider active leases: ${providerCapacity.leases.length}`,
            ...providerCapacity.leases.map((lease) => `- provider lease ${lease.leaseId}: pid=${lease.ownerProcessId}, remainingMs=${lease.remainingMs}, heartbeat=${lease.heartbeatAt || "none"}`),
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
    const [jobs, pipelines, locks, provider] = await Promise.all([
      listPersistedQueueRecords(projectRoot),
      listPersistedPipelineRecords(projectRoot),
      listLocks(projectRoot),
      providerCapacitySnapshot(),
    ]);
    const nonterminal = jobs.filter((job) => !["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    const failed = jobs.filter((job) => ["failed", "cancelled", "interrupted", "not_resumable"].includes(job.status));
    const report = {
      generatedAt: new Date().toISOString(),
      cwd: projectRoot,
      summary: {
        jobs: jobs.length,
        nonterminalJobs: nonterminal.length,
        failedJobs: failed.length,
        pipelines: pipelines.length,
        nonterminalPipelines: pipelines.filter((item) => !["completed", "failed", "cancelled"].includes(item.status)).length,
        locks: locks.length,
        providerCapacity: provider.capacity,
        providerActiveLeases: provider.leases.length,
      },
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        pipelineId: job.parentJobId || "",
        status: job.status,
        stage: job.status,
        errorType: job.errorType || "",
        failureReason: job.errorReason || "",
        requestedAgent: job.agent || "",
        actualModel: job.actualModel || job.runtimeObservedModel || "",
        childProcessId: job.childProcessId || job.orphanChildProcessId || 0,
        worktreePath: job.worktreePath || "",
        workPreserved: Boolean(job.worktreePath),
        retrySafe: job.mode === "read" && !["running", "validating", "reviewing", "testing"].includes(job.status),
        recoveryAction: job.worktreePath
          ? `Inspect preserved work: git -C "${job.worktreePath}" status --short and git diff --binary before retrying.`
          : job.status === "not_resumable"
          ? "Re-enqueue with a stable idempotencyKey; legacy records without encrypted requests cannot be replayed."
          : job.status === "interrupted"
          ? "Inspect the target repository and recorded child identity before retrying with the same idempotencyKey."
          : "No manual SQLite edit is required; follow the stable error type and wait for active leases/locks to expire or complete.",
      })),
      pipelines: pipelines.map((pipeline) => ({
        pipelineId: pipeline.pipelineId,
        status: pipeline.status,
        ownerInstanceId: pipeline.ownerInstanceId || "",
        ownerLeaseExpiresAt: pipeline.ownerLeaseExpiresAt || "",
        recoverableByThisInstance: pipelineOwnedByThisInstance(pipeline) || Date.parse(pipeline.ownerLeaseExpiresAt || "") <= Date.now(),
        pendingIntegrations: (pipeline.integrationQueue || []).filter((item) => item.status === "pending").length,
        errors: pipeline.errors || [],
      })),
      locks,
      provider,
    };
    return { content: [{ type: "text", text: JSON.stringify(sanitizePersistedValue(report), null, 2) }] };
  }
);

server.tool(
  "validate_delegation_plan",
  "Preflight a single or parallel OpenCode delegation plan without running OpenCode agents or acquiring locks.",
  {
    jobs: z.array(
      z.object({
        agent: z.string(),
        task: z.string(),
        cwd: z.string().optional(),
        allowFallbackToBuild: z.boolean().optional(),
        subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional().describe("OpenCode orchestrator MCP mode. Contractor requires explicit per-task user authorization; bounded-writer is retained only for compatibility and is rejected."),
        userAuthorizedOrchestrator: z.boolean().optional().describe("Set true only when the user explicitly requested the OpenCode Orchestrator by name for this task."),
        contractorAuthorizationToken: z.string().optional().describe("Secret contractor capability; required with the explicit user flag and never returned or persisted."),
        role: z.string().optional().describe("Optional Scope Contract role label."),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
        scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
        actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
        validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
        timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
        scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
        write: z.boolean().optional().describe("Whether this job may edit files. Write jobs require lockedPaths."),
        lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
        lockType: z.string().optional().describe("read, write, or serial_integration."),
        timeoutMs: z.number().int().positive().optional().describe("Optional per-job timeout in milliseconds."),
        lockedPaths: z.array(z.string()).optional().describe("Paths to lock. Wildcard suffixes like apps/web/** are normalized to apps/web."),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        sanitizedWorkspace: sanitizedWorkspaceSchema.optional(),
        delegation: z
          .object({
            scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
            role: z.string().optional(),
            mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
            actions: z.array(z.string()).optional(),
            validation: scopeValidationSchema.optional(),
            timeoutPolicy: scopeTimeoutPolicySchema.optional(),
            scopeContract: scopeContractSchema.optional(),
            lockMode: z.string().optional(),
            lockType: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
            orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional(),
            userAuthorizedOrchestrator: z.boolean().optional(),
            contractorAuthorizationToken: z.string().optional(),
            lockedPaths: z.array(z.string()).optional(),
            allowedEdits: z.array(z.string()).optional(),
            forbiddenEdits: z.array(z.string()).optional(),
            sharedFiles: z.array(z.string()).optional(),
            serialOnly: z.array(z.string()).optional(),
            permissions: z.string().optional(),
            validationCommand: z.string().optional(),
            returnFormat: z.string().optional(),
          })
          .optional(),
      })
    ).min(1),
  },
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
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const discoveryContext = sanitizedDiscoveryContext(job);
      const resolution = await resolveAgent(
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

      const metadata = await readAgentDebugMetadata(
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

      plannedJobs.push(formatDelegationPlanJob({ index, job, lockPlan, resolution }));
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
  {
    agent: z.string().describe("Agent name, for example planner, architect, builder, reviewer, tester, or explore."),
    task: z.string().describe("Task prompt to send to the OpenCode agent."),
    cwd: z.string().optional().describe("Repository path where OpenCode should run."),
    allowFallbackToBuild: z.boolean().optional().describe("Use build only when the requested agent is missing. Defaults to false."),
    subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional().describe("How to handle OpenCode agents listed as subagent. Defaults to reject; proxy is an explicit compatibility opt-in."),
    proxyAgent: z.string().optional().describe("Primary/all OpenCode agent used when subagentStrategy is proxy. Defaults to the read-only planner."),
    orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional().describe("OpenCode orchestrator MCP mode. Contractor requires explicit per-task user authorization; bounded-writer is retained only for compatibility and is rejected."),
    userAuthorizedOrchestrator: z.boolean().optional().describe("Set true only when the user explicitly requested the OpenCode Orchestrator by name for this task."),
    contractorAuthorizationToken: z.string().optional().describe("Secret contractor capability; required with the explicit user flag and never returned or persisted."),
    role: z.string().optional().describe("Optional Scope Contract role label."),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
    scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
    actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
    validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
    timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
    scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
    sanitizedWorkspace: sanitizedWorkspaceSchema.optional().describe("Optional exact hash-pinned workspace contract. Sanitized jobs must be read-only, direct, and use a managed read-only agent."),
    dryRun: z.boolean().optional().describe("Validate routing and command construction without running OpenCode."),
    write: z.boolean().optional().describe("Whether this job may edit files. Write jobs receive a temporary MCP-managed lock."),
    lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
    lockType: z.string().optional().describe("read, write, or serial_integration."),
    timeoutMs: z.number().int().positive().optional().describe("Optional per-run timeout in milliseconds."),
    lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner. Wildcard suffixes like apps/web/** are normalized to apps/web."),
    ownedPaths: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    sharedFiles: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    delegation: z
      .object({
        scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
        role: z.string().optional(),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
        actions: z.array(z.string()).optional(),
        validation: scopeValidationSchema.optional(),
        timeoutPolicy: scopeTimeoutPolicySchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional(),
        userAuthorizedOrchestrator: z.boolean().optional(),
        contractorAuthorizationToken: z.string().optional(),
        lockedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        permissions: z.string().optional(),
        validationCommand: z.string().optional(),
        returnFormat: z.string().optional(),
      })
      .optional()
      .describe("Optional compact delegation packet fields to avoid sending unrelated context."),
  },
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
    delegation,
  }) => {
    const toolStarted = nowMs();
    const requestedJob = {
      agent,
      task,
      cwd,
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
      delegation,
    };
    const execution = await executeOpenCodeJob(await normalizeJobCwd(requestedJob), { toolStarted });
    return execution.response;
  }
);

server.tool(
  "enqueue_opencode_job",
  "Enqueue one OpenCode job for MCP-managed scheduling. Uses the same validation as run_opencode_agent.",
  {
    parentJobId: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional().describe("Stable caller-generated key. Repeating it returns the original durable job instead of creating duplicate work."),
    agent: z.string().describe("Agent name, for example planner, architect, builder, reviewer, tester, or explore."),
    task: z.string().describe("Task prompt to send to the OpenCode agent."),
    cwd: z.string().optional().describe("Repository path where OpenCode should run."),
    allowFallbackToBuild: z.boolean().optional().describe("Use build only when the requested agent is missing. Defaults to false."),
    subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
    proxyAgent: z.string().optional(),
    orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional().describe("OpenCode orchestrator MCP mode. Contractor requires explicit per-task user authorization; bounded-writer is retained only for compatibility and is rejected."),
    userAuthorizedOrchestrator: z.boolean().optional().describe("Set true only when the user explicitly requested the OpenCode Orchestrator by name for this task."),
    contractorAuthorizationToken: z.string().optional().describe("Secret contractor capability; required with the explicit user flag and never returned or persisted."),
    role: z.string().optional().describe("Optional Scope Contract role label."),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
    scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
    actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
    validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
    timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
    scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
    sanitizedWorkspace: sanitizedWorkspaceSchema.optional().describe("Optional exact hash-pinned workspace contract for a read-only queued job."),
    dryRun: z.boolean().optional().describe("Validate routing and command construction without running OpenCode."),
    write: z.boolean().optional().describe("Whether this job may edit files. Write jobs receive a temporary MCP-managed lock."),
    lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
    lockType: z.string().optional().describe("read, write, or serial_integration."),
    timeoutMs: z.number().int().positive().optional().describe("Optional per-run timeout in milliseconds."),
    lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner."),
    ownedPaths: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    sharedFiles: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    delegation: z
      .object({
        scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
        role: z.string().optional(),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
        actions: z.array(z.string()).optional(),
        validation: scopeValidationSchema.optional(),
        timeoutPolicy: scopeTimeoutPolicySchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional(),
        userAuthorizedOrchestrator: z.boolean().optional(),
        contractorAuthorizationToken: z.string().optional(),
        lockedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        permissions: z.string().optional(),
        validationCommand: z.string().optional(),
        returnFormat: z.string().optional(),
      })
      .optional(),
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

    const queueAssessment = await assessQueuePlan([{
      lockType: enqueued.record.mode === "read" ? "read" : "write",
      cwd: enqueued.record.cwd,
      lockedPaths: enqueued.record.lockedPaths,
      allowedEdits: enqueued.record.allowedEdits,
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
    cwd: z.string().optional().describe("Optional repository path for sqlite-backed job listing."),
    status: z.enum(["pending", "planned", "blocked", "running", "validating", "reviewing", "testing", "completed", "failed", "cancelled", "interrupted", "not_resumable"]).optional(),
  },
  async ({ cwd = "", status = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecords = [...QUEUE_JOBS.values()]
      .filter((record) => recordMatchesProject(record, projectRoot))
      .map((record) => queueRecordSnapshot(record, false))
      .filter((record) => !status || record.status === status);
    const persistedRecords = await listPersistedQueueRecords(projectRoot || cwd, status);
    const byId = new Map();
    for (const record of persistedRecords.concat(memoryRecords)) {
      byId.set(record.jobId, record);
    }
    const records = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return {
      content: [
        {
          type: "text",
          text: [
            `Queue mode: ${effectiveQueueMode()}`,
            `Jobs: ${records.length}`,
            JSON.stringify(records, null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_opencode_job",
  "Get one queued OpenCode job, including result text when available.",
  {
    jobId: z.string(),
    cwd: z.string().optional().describe("Optional repository path for sqlite-backed job lookup."),
  },
  async ({ jobId, cwd = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecord = QUEUE_JOBS.get(jobId);
    const record = memoryRecord && recordMatchesProject(memoryRecord, projectRoot) ? memoryRecord : null;
    const snapshot = record ? queueRecordSnapshot(record) : await readPersistedQueueRecord(jobId, projectRoot || cwd);
    if (!snapshot) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job not found: ${jobId}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(snapshot, null, 2),
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
    cwd: z.string().optional().describe("Repository path required to address a sqlite-backed job owned by another bridge instance."),
  },
  async ({ jobId, cwd = "" }) => {
    const record = QUEUE_JOBS.get(jobId);
    if (!record) {
      if (effectiveQueueMode() === "sqlite" && cwd) {
        const db = await openLockDb(cwd);
        try {
          const row = db.prepare(`
            SELECT job_id, cwd, status, agent, mode, created_at, started_at, finished_at,
                   owner_instance_id, owner_process_id, owner_generation, heartbeat_at, lease_expires_at,
                   cancellation_requested_at, child_process_id, child_process_started_at, revision,
                   idempotency_key, record_json
            FROM opencode_jobs WHERE job_id = ?
          `).get(jobId);
          if (row && !["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(row.status)) {
            const requestedAt = row.cancellation_requested_at || new Date().toISOString();
            let snapshot = persistedQueueRecordFromRow(row);
            if (["held", "pending", "planned", "blocked"].includes(row.status)) {
              snapshot = sanitizePersistedValue({
                ...snapshot,
                status: "cancelled",
                finishedAt: requestedAt,
                cancellationRequested: true,
                cancellationRequestedAt: requestedAt,
                errorType: "agent_cancelled",
                errorReason: "Cancelled before execution by an operator on another bridge instance.",
              });
              const changed = db.prepare(`
                UPDATE opencode_jobs
                SET status = 'cancelled', finished_at = ?, cancellation_requested_at = ?, updated_at = ?, record_json = ?, revision = revision + 1
                WHERE job_id = ? AND status = ?
              `).run(requestedAt, requestedAt, requestedAt, JSON.stringify(snapshot), jobId, row.status);
              if (Number(changed.changes || 0) > 0) {
                return { content: [{ type: "text", text: `OpenCode job ${jobId} was cancelled atomically before execution.` }] };
              }
            } else {
              snapshot = sanitizePersistedValue({ ...snapshot, cancellationRequested: true, cancellationRequestedAt: requestedAt });
              const changed = stampPersistedQueueCancellation(db, {
                jobId,
                status: row.status,
                requestedAt,
                recordJson: JSON.stringify(snapshot),
              });
              if (Number(changed.changes || 0) > 0) {
                return { content: [{ type: "text", text: `Cross-process cancellation requested for OpenCode job ${jobId}; the owning bridge heartbeat will terminate its exact child process tree.` }] };
              }
            }
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
    await persistQueueRecord(record);
    scheduleQueue();
    return {
      content: [
        {
          type: "text",
          text: `OpenCode queue job cancelled: ${jobId}`,
        },
      ],
    };
  }
);

server.tool(
  "create_multi_agent_pipeline",
  "Create a multi-agent execution pipeline with ownership, worktree, integration, and final-validation policy checks.",
  {
    name: z.string().optional(),
    cwd: z.string().optional(),
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
        timeoutMs: z.number().int().positive().optional(),
        scope: scopePathSetSchema.optional(),
        validation: scopeValidationSchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        allowFallbackToBuild: z.boolean().optional(),
        subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
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
    const pipelineJobs = sanitizedWorkspace
      ? jobs.map((job) => ({ ...job, cwd: targetCwd, sanitizedWorkspace, subagentStrategy: "reject", write: false, lockType: "read", lockMode: "off" }))
      : jobs;
    const normalizedJobs = await Promise.all(pipelineJobs.map((job) => normalizeJobCwd(job)));
    const foreignJob = normalizedJobs.find((job) => path.resolve(job.cwd) !== path.resolve(targetCwd));
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
    cwd: z.string().optional(),
  },
  async ({ pipelineId, cwd = "" }) => {
    if (effectiveQueueMode() === "off") {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Multi-agent pipeline rejected.",
              errorType: "queue_disabled",
              reason: "run_multi_agent_pipeline requires the MCP queue.",
              requestedAgent: "pipeline_coordinator",
              actualAgent: "none",
              suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=memory or sqlite, then restart the MCP server.",
            }),
          },
        ],
      };
    }

    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecord = PIPELINE_RUNS.get(pipelineId);
    const record = memoryRecord && recordMatchesProject(memoryRecord, projectRoot)
      ? memoryRecord
      : await readPersistedPipelineRecord(pipelineId, projectRoot || cwd);
    if (!record) {
      return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
    }

    if (!pipelineOwnedByThisInstance(record)) {
      const claim = await claimPersistedPipeline(record);
      if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(record, "start") }] };
    }

    if (!["planned", "failed"].includes(record.status) || record.queueJobIds?.length) {
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

    await updatePipelineRecord(record, {
      status: "running",
      startedAt: record.startedAt || new Date().toISOString(),
      events: (record.events || []).concat({
        type: "start_claimed",
        at: new Date().toISOString(),
        ownerInstanceId: BRIDGE_INSTANCE_ID,
      }),
    });

    const queueJobIds = [];
    const errors = [];
    for (const job of record.jobs || []) {
      const enqueued = await enqueueQueueJob({ ...job, cwd: job.cwd || record.cwd }, pipelineId, { schedule: false, initialStatus: "held" });
      if (!enqueued.ok) {
        errors.push({
          agent: job.agent,
          errorType: enqueued.errorType,
          error: enqueued.error,
          suggestedFix: enqueued.suggestedFix,
        });
        continue;
      }
      queueJobIds.push(enqueued.record.jobId);
    }

    if (errors.length) {
      for (const jobId of queueJobIds) {
        const queued = QUEUE_JOBS.get(jobId);
        if (!queued) continue;
        Object.assign(queued, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          errorType: "pipeline_batch_aborted",
          errorReason: "Pipeline enqueue preflight failed; no held job was released for execution.",
        });
        delete queued.request;
        await persistQueueRecord(queued);
      }
      await updatePipelineRecord(record, {
        status: "failed",
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

    await updatePipelineRecord(record, {
      status: "running",
      queueJobIds,
      events: (record.events || []).concat({
        type: "queue_batch_held",
        at: new Date().toISOString(),
        queueJobIds,
      }),
    });

    for (const jobId of queueJobIds) {
      const queued = QUEUE_JOBS.get(jobId);
      if (!queued || queued.status !== "held") continue;
      queued.status = "pending";
      await persistQueueRecord(queued);
    }

    await updatePipelineRecord(record, {
      status: "running",
      queueJobIds,
      events: (record.events || []).concat({
        type: "started",
        at: new Date().toISOString(),
        queueJobIds,
      }),
    });
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
    cwd: z.string().optional(),
  },
  async ({ pipelineId, cwd = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecord = PIPELINE_RUNS.get(pipelineId);
    const record = memoryRecord && recordMatchesProject(memoryRecord, projectRoot)
      ? memoryRecord
      : await readPersistedPipelineRecord(pipelineId, projectRoot || cwd);
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
  "finalize_multi_agent_pipeline",
  "Finalize a multi-agent pipeline after all integrations by running final validation and optional read-only reviewer/tester gates.",
  {
    pipelineId: z.string(),
    cwd: z.string().optional(),
    skipReviewers: z.boolean().optional().describe("Skip configured reviewer/tester gates and run only final validation."),
    dryRun: z.boolean().optional().describe("Do not run final validation or reviewer/tester commands; record skipped dry-run gates."),
  },
  async ({ pipelineId, cwd = "", skipReviewers = false, dryRun = false }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecord = PIPELINE_RUNS.get(pipelineId);
    const record = memoryRecord && recordMatchesProject(memoryRecord, projectRoot)
      ? memoryRecord
      : await readPersistedPipelineRecord(pipelineId, projectRoot || cwd);
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
            "Multi-agent pipeline finalized.",
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
    cwd: z.string().optional(),
    status: z.enum(["planned", "running", "awaiting_integration", "awaiting_finalization", "finalizing", "integrating", "completed", "failed", "cancelled"]).optional(),
  },
  async ({ cwd = "", status = "" }) => {
    const projectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
    const memoryRecords = [...PIPELINE_RUNS.values()]
      .filter((record) => recordMatchesProject(record, projectRoot))
      .map((record) => pipelineRecordSnapshot(record))
      .filter((record) => !status || record.status === status);
    const persistedRecords = await listPersistedPipelineRecords(projectRoot || cwd, status);
    const byId = new Map();
    for (const record of persistedRecords.concat(memoryRecords)) {
      byId.set(record.pipelineId, record);
    }
    const records = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      content: [
        {
          type: "text",
          text: [
            `Pipelines: ${records.length}`,
            JSON.stringify(records, null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "integrate_opencode_worktree",
  "Serially integrate one OpenCode worktree or branch after ownership, patch, conflict, and validation checks.",
  {
    cwd: z.string().optional().describe("Target repository path where the patch should be checked or applied."),
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
    cleanupAfterSuccess: z.boolean().optional().describe("Remove the source worktree and its local branch only after reviewed integration and validation succeed. Defaults to false."),
    allowDirtyTarget: z.boolean().optional().describe("Allow integration into a target repo that already has changes. Defaults to false."),
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
    cleanupAfterSuccess = false,
    allowDirtyTarget = false,
  }) => {
    const started = nowMs();
    let pipeline = null;
    let pipelineItem = null;
    let validationTrustedSpec = null;
    let validationPolicyTrust = null;
    if (pipelineId) {
      const requestedProjectRoot = cwd ? await resolveProjectStateRoot(cwd) : "";
      const memoryPipeline = PIPELINE_RUNS.get(pipelineId);
      pipeline = memoryPipeline && recordMatchesProject(memoryPipeline, requestedProjectRoot)
        ? memoryPipeline
        : await readPersistedPipelineRecord(pipelineId, requestedProjectRoot || cwd);
      if (!pipeline) {
        return { content: [{ type: "text", text: `Multi-agent pipeline not found: ${pipelineId}` }] };
      }
      if (!pipelineOwnedByThisInstance(pipeline)) {
        const claim = await claimPersistedPipeline(pipeline);
        if (!claim.ok) return { content: [{ type: "text", text: pipelineOwnerRejection(pipeline, "integration") }] };
      }
      if (!PIPELINE_RUNS.has(pipelineId)) PIPELINE_RUNS.set(pipelineId, pipeline);
      await refreshPipelineRecord(pipeline);
      const candidates = (pipeline.integrationQueue || []).filter((item) => {
        const sameWorktree = worktreePath && item.worktreePath && path.resolve(item.worktreePath) === path.resolve(worktreePath);
        const sameBranch = branch && item.branch === branch;
        return sameWorktree || sameBranch;
      });
      if (candidates.length !== 1 || candidates[0].status !== "pending") {
        return { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Pipeline integration rejected.",
          errorType: "pipeline_integration_item_invalid",
          reason: candidates.length !== 1
            ? "The source did not identify exactly one planned pipeline integration item."
            : `The matched integration item is ${candidates[0].status}, not pending.`,
          requestedAgent: "merge_manager",
          actualAgent: "none",
          suggestedFix: "Use the exact retained worktree/branch reported by the completed pipeline queue item and do not replay an integration.",
        }) }] };
      }
      pipelineItem = candidates[0];
      if (!pipelineItem.sourceBaseCommit || !/^[a-f0-9]{64}$/i.test(pipelineItem.patchSha256 || "") || !/^[a-f0-9]{64}$/i.test(pipelineItem.sourceStateSha256 || "")) {
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
    const result = await integratePatchSerially({
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
      cleanupAfterSuccess,
      deferCleanup: Boolean(pipelineId),
      expectedSourceIdentity: pipelineItem ? {
        sourceBaseCommit: pipelineItem.sourceBaseCommit,
        patchSha256: pipelineItem.patchSha256,
        sourceStateSha256: pipelineItem.sourceStateSha256,
      } : null,
    });
    if (pipelineId) {
      if (pipeline) {
        const events = (pipeline.events || []).concat({
          type: "integration",
          at: new Date().toISOString(),
          ok: Boolean(result.ok),
          status: result.status || "rejected",
          errorType: result.errorType || "",
          sourceType: result.sourceType || (worktreePath ? "worktree" : branch ? "branch" : "unknown"),
          source: result.source || worktreePath || branch || "",
          changedFiles: result.changedFiles || [],
          appliedFiles: result.appliedFiles || [],
        });
        const nextIntegrationQueue = (pipeline.integrationQueue || []).map((item) => {
          const sameWorktree = worktreePath && item.worktreePath && path.resolve(item.worktreePath) === path.resolve(worktreePath);
          const sameBranch = branch && item.branch === branch;
          return sameWorktree || sameBranch
            ? {
                ...item,
                status: result.ok && result.status === "applied" ? "integrated" : result.ok ? item.status : "rejected",
                errorType: result.errorType || "",
                cleanupRequested: Boolean(result.ok && result.status === "applied" && result.validationGate?.status === "passed" && cleanupAfterSuccess && worktreePath),
                sourceBaseCommit: result.sourceBaseCommit || "",
                patchSha256: result.patchSha256 || "",
                sourceStateSha256: result.sourceStateSha256 || "",
              }
            : item;
        });
        const applied = Boolean(result.ok && result.status === "applied");
        const allIntegrated = nextIntegrationQueue.length && nextIntegrationQueue.every((item) => item.status === "integrated");
        await updatePipelineRecord(pipeline, {
          status: applied && allIntegrated ? "awaiting_finalization" : pipeline.status,
          finishedAt: applied && allIntegrated ? "" : pipeline.finishedAt,
          integrationQueue: nextIntegrationQueue,
          events,
          errors: result.ok ? pipeline.errors || [] : (pipeline.errors || []).concat({
            type: "integration",
            errorType: result.errorType || "integration_rejected",
            error: result.error || "",
          }),
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
                conflictingPaths: result.disallowedFiles || result.changedFiles || [],
                allowedEdits,
                rollback: result.rollback?.rollback || "",
                rollbackFiles: result.rollback?.rollbackFiles || [],
                unresolvedFiles: result.rollback?.unresolvedFiles || [],
                suggestedFix: "Resolve conflicts, narrow allowedEdits, move shared/global files to a serial contract step, or rerun with a passing validation command.",
              }),
              result.validationGate ? formatValidationGateResult(result.validationGate) : null,
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
            result.patchPreview ? `Patch preview:\n${result.patchPreview}` : null,
            result.patchPreviewTruncated ? "Patch preview truncated: yes (apply remains blocked on the full patch SHA-256)" : null,
            `Allowed edits: ${normalizeLockPathList(allowedEdits).join(", ")}`,
            `Forbidden edits: ${normalizeLockPathList(forbiddenEdits).length ? normalizeLockPathList(forbiddenEdits).join(", ") : "none specified"}`,
            `Shared files frozen: ${normalizeLockPathList(sharedFiles).length ? normalizeLockPathList(sharedFiles).join(", ") : "none specified"}`,
            result.sourceCleanup ? `Source worktree cleanup: ${result.sourceCleanup.cleanup}` : "Source worktree cleanup: not requested",
            result.sourceCleanup?.branchCleanup ? `Source branch cleanup: ${result.sourceCleanup.branchCleanup}` : null,
            result.cleanupWarning ? `Cleanup warning: ${result.cleanupWarning}` : null,
            formatValidationGateResult(result.validationGate),
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

function makeInternalQueueContractorProof(jobId) {
  return createHmac("sha256", QUEUE_CAPABILITY_KEY).update(`contractor\0${jobId}`).digest("hex");
}

function internalQueueContractorProofValid(job) {
  const jobId = String(job?.internalQueueJobId || "");
  const proof = String(job?.internalQueueContractorProof || "");
  if (!jobId || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = makeInternalQueueContractorProof(jobId);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
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

function normalizeLockType(lockType, job) {
  const raw = String(lockType || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return hasWriteIntent(job) ? "write" : "read";
  }

  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }

  if (raw === "serial" || raw === "integration" || raw === "serial_integration_lock") {
    return "serial_integration";
  }

  return raw;
}

function normalizeLockMode(lockMode, lockType) {
  const raw = String(lockMode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (lockType === "read") {
    return raw && !["none", "off", "read", "read_only", "readonly"].includes(raw) ? raw : CONFIG.defaultReadLockMode;
  }

  if (!raw) {
    return CONFIG.defaultWriteLockMode;
  }

  if (raw === "none" || raw === "read" || raw === "read_only" || raw === "readonly") {
    return "off";
  }

  if (raw === "auto" || raw === "temporary") {
    return CONFIG.defaultWriteLockMode;
  }

  return raw;
}

function createLockPlan(job, index) {
  const cwd = job.cwd || "";
  const lockType = normalizeLockType(job.lockType || job.delegation?.lockType, job);
  const lockMode = normalizeLockMode(job.lockMode || job.delegation?.lockMode, lockType);
  const scopeContract = normalizeScopeContract(job);
  const hasExplicitScopeContract = Boolean(job.scopeContract || job.delegation?.scopeContract);
  const legacyScopeWriteFallback = hasExplicitScopeContract ? [] : scopeContract?.scope.write;
  const lockedPaths = normalizeLockPathListForCwd(
    firstNonEmptyList(job.lockedPaths, job.ownedPaths, job.delegation?.lockedPaths),
    cwd
  );
  const allowedEdits = normalizeLockPathListForCwd(
    firstNonEmptyList(job.allowedEdits, job.delegation?.allowedEdits, scopeContract?.allowedEdits, legacyScopeWriteFallback),
    cwd
  );
  const forbiddenEdits = normalizeLockPathListForCwd(
    mergePathLists(
      DEFAULT_FORBIDDEN_EDIT_PATHS,
      job.forbiddenEdits,
      job.delegation?.forbiddenEdits,
      scopeContract?.scope.forbidden
    ),
    cwd
  );
  const sharedFiles = normalizeLockPathListForCwd(
    firstNonEmptyList(job.sharedFiles, job.delegation?.sharedFiles, scopeContract?.shared),
    cwd
  );
  const serialOnly = normalizeLockPathListForCwd(
    firstNonEmptyList(job.serialOnly, job.delegation?.serialOnly, scopeContract?.serialOnly),
    cwd
  );
  const orchestratorMode = normalizeOrchestratorMode(job);
  const explicitUserAuthorization = userAuthorizedOrchestrator(job);
  const contractTimeoutMs = scopeContractTimeout(scopeContract, lockType);

  return {
    index,
    agent: job.agent,
    task: job.task,
    cwd,
    lockMode,
    lockType,
    orchestratorMode,
    userAuthorizedOrchestrator: explicitUserAuthorization,
    contractorAuthorizationVerified: orchestratorMode === "contractor" && contractorAuthorizationValid(job),
    lockedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    serialOnly,
    scopeContract,
    sanitizedWorkspace: job.sanitizedWorkspace || null,
    validationCommand: job.validationCommand || job.delegation?.validationCommand || scopeContract?.validationCommand || "",
    timeoutMs: job.timeoutMs || job.delegation?.timeoutMs || contractTimeoutMs || null,
  };
}

function directExecutionLockConflictDetails(lockResult, queueConflict = false) {
  if (queueConflict) {
    return {
      headline: "Queued write job is waiting for an active lock.",
      errorType: "queue_lock_conflict",
      suggestedFix: "The queue will retry after the active write lock is released.",
    };
  }
  if (lockResult?.conflict?.origin === "internal") {
    return {
      headline: "Write job is waiting for an active writer.",
      errorType: "write_lock_conflict",
      suggestedFix: "Wait for the active writer to finish, retry later, or choose a non-overlapping lockedPaths scope.",
    };
  }
  return {
    headline: "Manual lock already exists. Do not pre-acquire locks before run_opencode_agent.",
    errorType: "manual_lock_misuse",
    suggestedFix: "Release the existing manual lock or wait for it to expire, then call run_opencode_agent with lockedPaths only.",
  };
}

function validateScopeContract(job, lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  if (!scopeContract) {
    if (lockPlan.lockType === "write" || job.write === true) {
      return {
        errorType: "missing_scope_contract",
        error: "Every write job must include an explicit Scope Contract. Scope Contract is the source of truth for read, write, allowed, forbidden, shared, serial-only, and validation boundaries.",
        suggestedFix: "Pass scopeContract with mode write, non-empty write and allowedEdits paths, forbidden/shared/serialOnly lists as needed, and validationCommand for risky work.",
      };
    }
    return null;
  }

  if (scopeContract.agent && scopeContract.agent !== lockPlan.agent) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract agent "${scopeContract.agent}" does not match requested agent "${lockPlan.agent}".`,
      suggestedFix: "Use a Scope Contract for the same agent being delegated.",
    };
  }

  if (!["read", "write"].includes(scopeContract.mode)) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract mode "${scopeContract.mode}" is invalid. Use read or write.`,
      suggestedFix: "Set Scope Contract mode to read or write.",
    };
  }

  const unsafeReason = unsafePathReason(scopeContractPathInputs(scopeContract), lockPlan.cwd || process.cwd());
  if (unsafeReason) {
    return {
      errorType: "scope_path_unsafe",
      error: `Scope Contract has unsafe path input: ${unsafeReason}`,
      suggestedFix: "Use repo-relative bounded paths without parent traversal, home shortcuts, control characters, or outside-repo absolute paths.",
    };
  }

  if (scopeContract.mode === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: "Read-only Scope Contract cannot include write paths.",
      suggestedFix: "Remove scope.write for read-only agents, or change the contract mode and job to write with explicit locks.",
    };
  }

  if (READ_ONLY_PARALLEL_AGENTS.has(String(lockPlan.agent || "").trim().toLowerCase()) && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or delegate write work to builder/debugger with explicit locks.",
    };
  }

  if (lockPlan.lockType === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or run a write-capable agent with write true and lockedPaths.",
    };
  }

  if (lockPlan.lockType === "write" && scopeContract.mode !== "write") {
    return {
      errorType: "scope_contract_invalid",
      error: "Write jobs with a Scope Contract must use mode write.",
      suggestedFix: "Set Scope Contract mode to write and provide scope.write paths.",
    };
  }

  if (scopeContract.mode === "write" && !scopeContract.scope.write.length) {
    return {
      errorType: "empty_allowed_edits",
      error: "Write Scope Contract requires non-empty scope.write paths.",
      suggestedFix: "Add bounded scope.write paths and matching allowedEdits.",
    };
  }

  if (scopeContract.mode === "write" && !lockPlan.allowedEdits.length) {
    return {
      errorType: "empty_allowed_edits",
      error: "Write Scope Contract requires non-empty allowedEdits.",
      suggestedFix: "Add explicit allowedEdits; do not rely on lockedPaths as the edit allowlist.",
    };
  }

  if (scopeContract.allowedEdits.length) {
    const outsideScope = scopeContract.scope.write.length
      ? unsafeChangedFiles(scopeContract.allowedEdits, scopeContract.scope.write, lockPlan.cwd)
      : [];
    if (outsideScope.length) {
      return {
        errorType: "scope_write_forbidden",
        error: `Scope Contract allowedEdits contains paths outside scope.write: ${outsideScope.join(", ")}.`,
        conflictingPaths: outsideScope,
        suggestedFix: "Keep allowedEdits inside scope.write, or expand scope.write explicitly.",
      };
    };
  }

  const forbiddenWriteOverlap = overlaps(scopeContract.scope.write, scopeContract.scope.forbidden);
  if (forbiddenWriteOverlap) {
    return {
      errorType: "scope_write_forbidden",
      error: `Scope Contract write path is forbidden: ${forbiddenWriteOverlap[0]} / ${forbiddenWriteOverlap[1]}.`,
      conflictingPaths: forbiddenWriteOverlap,
      suggestedFix: "Remove the forbidden path from scope.write, or narrow the write scope so forbidden paths are excluded.",
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (scopeContract.scope.write.length && !isWithinAnyPath(allowedPath, scopeContract.scope.write, lockPlan.cwd)) {
      return {
        errorType: "scope_write_forbidden",
        error: `Allowed edit path is outside Scope Contract write paths: ${allowedPath}.`,
        conflictingPaths: [allowedPath],
        suggestedFix: "Keep allowedEdits inside scope.write, or expand scope.write explicitly.",
      };
    }
  }

  return null;
}

function sanitizedJobPolicyError(job) {
  if (!job?.sanitizedWorkspace) return null;
  if (hasWriteIntent(job) || job.lockType === "write" || job.lockType === "serial_integration") {
    return {
      error: "Sanitized workspace execution is read-only. Writers require a separate Git worktree/output root.",
      errorType: "sanitized_workspace_write_forbidden",
      suggestedFix: "Use a managed read-only agent with lockType read/off, or create a separate Git worktree for output.",
    };
  }
  if (String(job.validationCommand || job.scopeContract?.validationCommand || job.delegation?.validationCommand || "").trim()) {
    return {
      error: "Sanitized workspace jobs may not execute repository validation commands; verification is manifest-based before and after the wave.",
      errorType: "sanitized_workspace_command_forbidden",
      suggestedFix: "Remove validationCommand and use verify_sanitized_workspace plus an externally trusted validation environment.",
    };
  }
  if (job.subagentStrategy && job.subagentStrategy !== "reject") {
    return {
      error: "Sanitized workspace jobs require subagentStrategy=reject so the resolved agent is the directly attested read-only role.",
      errorType: "sanitized_workspace_subagent_forbidden",
      suggestedFix: "Set subagentStrategy to reject and choose a primary/all managed read-only agent.",
    };
  }
  return null;
}

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

function validateParallelWritePlan(jobs) {
  const lockPlans = jobs.map((job, index) => createLockPlan(job, index));
  if (jobs.length > CONFIG.parallelLimit) {
    return {
      error: `Parallel job count ${jobs.length} exceeds CODEX_OPENCODE_PARALLEL_LIMIT ${CONFIG.parallelLimit}.`,
      errorType: "parallel_plan_rejected",
      lockPlans,
    };
  }

  const writePlans = lockPlans.filter((plan) => plan.lockType === "write");
  if (writePlans.length > 1) {
    for (const plan of writePlans) {
      plan.lockMode = CONFIG.defaultParallelWriteLockMode;
    }
  }

  for (const plan of lockPlans) {
    const job = jobs[plan.index];
    const sanitizedError = sanitizedJobPolicyError(job);
    if (sanitizedError) {
      return { ...sanitizedError, lockPlans };
    }
    const planPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.forbiddenEdits, plan.sharedFiles, plan.serialOnly, scopeContractPathInputs(plan.scopeContract));
    const orchestratorError = orchestratorPolicyError(job, plan, "parallel");
    if (orchestratorError) {
      return {
        ...orchestratorError,
        serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
        lockPlans,
      };
    }

    const scopeError = validateScopeContract(job, plan);
    if (scopeError) {
      return {
        ...scopeError,
        conflictingPaths: scopeError.conflictingPaths || [],
        lockPlans,
      };
    }

    if (!PARALLEL_LOCK_TYPES.has(plan.lockType)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockType "${plan.lockType}". Use read, write, or serial_integration.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    if (!["off", "simple", "strict"].includes(plan.lockMode)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockMode "${plan.lockMode}". Use off, simple, or strict.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode off for read-only jobs, simple for one writer, and strict for parallel writers.",
        lockPlans,
      };
    }

    const unsafeReason = unsafePathReason(planPathInputs, plan.cwd);
    if (unsafeReason) {
      return {
        error: `Parallel job for agent "${plan.agent}" has unsafe path input: ${unsafeReason}`,
        errorType: "unsafe_path",
        lockPlans,
      };
    }

    if (plan.lockType !== "read" && plan.lockMode === "off") {
      return {
        error: `Parallel write job for agent "${plan.agent}" cannot use lockMode off.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode strict for parallel write jobs.",
        lockPlans,
      };
    }

    if (plan.lockType === "serial_integration") {
      return {
        error: `Parallel job for agent "${plan.agent}" requested a serial integration lock. Serial integration locks must run as a single non-parallel integration step.`,
        errorType: "serial_only_parallel_write",
        suggestedFix: "Run this task serially, then run reviewer/tester validation.",
        lockPlans,
      };
    }

    if (plan.lockType === "read") {
      if (job.write === true || plan.allowedEdits.length) {
        return {
          error: `Read-only job for agent "${plan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
          lockPlans,
        };
      }
      if (WRITE_CAPABLE_AGENTS.has(String(plan.agent || "").trim().toLowerCase())) {
        return {
          error: `Write-capable agent "${plan.agent}" cannot run against the target repository under a read-only lock.`,
          errorType: "read_only_agent_required",
          suggestedFix: "Use planner, architect, reviewer, tester, or orchestrator for read-only work. Run builder/debugger only as bounded worktree writers.",
          lockPlans,
        };
      }
      continue;
    }

    if (!plan.lockedPaths.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: lockedPaths.`,
        errorType: "missing_locked_paths",
        suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
        lockPlans,
      };
    }

    if (!plan.allowedEdits.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: allowedEdits.`,
        errorType: "empty_allowed_edits",
        suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
        lockPlans,
      };
    }

    const ambiguousPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.sharedFiles, plan.scopeContract?.scope.write || []);
    if (hasAmbiguousPathPattern(ambiguousPathInputs)) {
      return {
        error: `Parallel write job for agent "${plan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks, or run serially.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    const serialOnlyMatches = findSerialOnlyMatches(plan.lockedPaths.concat(plan.allowedEdits), plan.serialOnly);
    if (serialOnlyMatches.length) {
      return {
        error: "This file or path is global/risky and cannot be edited during parallel execution.",
        errorType: "serial_only_parallel_write",
        suggestedFix: "Run this task serially, then run reviewer/tester validation.",
        serialOnlyMatches,
        lockPlans,
      };
    }

    const sharedOverlap = overlaps(plan.allowedEdits, plan.sharedFiles);
    if (sharedOverlap) {
      return {
        error: `Parallel write job for agent "${plan.agent}" attempts to edit a shared/frozen path: ${sharedOverlap[0]} / ${sharedOverlap[1]}.`,
        errorType: "shared_file_parallel_write",
        suggestedFix: "Move shared/frozen changes to a separate serial writer step reviewed by Codex.",
        conflictingPaths: sharedOverlap,
        lockPlans,
      };
    }

    for (const allowedPath of plan.allowedEdits) {
      if (!isWithinAnyPath(allowedPath, plan.lockedPaths, plan.cwd)) {
        return {
          error: `Parallel write job for agent "${plan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
          errorType: "parallel_plan_rejected",
          lockPlans,
        };
      }
    }

    const forbiddenOverlap = overlaps(plan.allowedEdits, plan.forbiddenEdits);
    const forbiddenAllowedPaths = plan.allowedEdits.filter((allowedPath) =>
      isWithinAnyPath(allowedPath, plan.forbiddenEdits, plan.cwd)
    );
    if (forbiddenOverlap || forbiddenAllowedPaths.length) {
      const conflictingPaths = forbiddenOverlap || forbiddenAllowedPaths;
      return {
        error: `Parallel write job for agent "${plan.agent}" allows a forbidden edit path: ${conflictingPaths.join(" / ")}.`,
        errorType: "parallel_plan_rejected",
        conflictingPaths,
        lockPlans,
      };
    }

  }

  if (writePlans.length > 1) {
    for (let i = 0; i < writePlans.length; i += 1) {
      for (let j = i + 1; j < writePlans.length; j += 1) {
        const overlap = overlaps(
          writePlans[i].allowedEdits.concat(writePlans[i].lockedPaths),
          writePlans[j].allowedEdits.concat(writePlans[j].lockedPaths)
        );
        if (overlap) {
          return {
            error: `Parallel write jobs overlap: "${writePlans[i].agent}" and "${writePlans[j].agent}" both include ${overlap[0]} / ${overlap[1]}.`,
            errorType: "parallel_plan_rejected",
            conflictingPaths: overlap,
            lockPlans,
          };
        }
      }
    }
  }

  return { error: null, lockPlans };
}

function validateSingleLockPlan(job) {
  const sanitizedError = sanitizedJobPolicyError(job);
  if (sanitizedError) {
    return {
      ...sanitizedError,
      lockPlan: createLockPlan({ ...job, write: false, lockType: "read", lockMode: "off" }, 0),
    };
  }
  const lockPlan = createLockPlan(job, 0);
  const planPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.forbiddenEdits, lockPlan.sharedFiles, lockPlan.serialOnly, scopeContractPathInputs(lockPlan.scopeContract));
  const orchestratorError = orchestratorPolicyError(job, lockPlan, "single");
  if (orchestratorError) {
    return {
      ...orchestratorError,
      serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
      lockPlan,
    };
  }

  const scopeError = validateScopeContract(job, lockPlan);
  if (scopeError) {
    return {
      ...scopeError,
      conflictingPaths: scopeError.conflictingPaths || [],
      lockPlan,
    };
  }

  if (!PARALLEL_LOCK_TYPES.has(lockPlan.lockType)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockType "${lockPlan.lockType}". Use read, write, or serial_integration.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  if (!["off", "simple", "strict"].includes(lockPlan.lockMode)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockMode "${lockPlan.lockMode}". Use off, simple, or strict.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode off for read-only jobs and simple/strict for write jobs.",
      lockPlan,
    };
  }

  if (lockPlan.lockType !== "read" && lockPlan.lockMode === "off") {
    return {
      error: `Write job for agent "${lockPlan.agent}" cannot use lockMode off.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode simple for a single writer or strict for coordinated writer work.",
      lockPlan,
    };
  }

  const unsafeReason = unsafePathReason(planPathInputs, lockPlan.cwd);
  if (unsafeReason) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has unsafe path input: ${unsafeReason}`,
      errorType: "unsafe_path",
      lockPlan,
    };
  }

  if (lockPlan.lockType === "read") {
    if (job.write === true || lockPlan.allowedEdits.length) {
      return {
        error: `Read-only job for agent "${lockPlan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
        errorType: "read_only_edit_forbidden",
        lockPlan,
      };
    }
    if (WRITE_CAPABLE_AGENTS.has(String(lockPlan.agent || "").trim().toLowerCase())) {
      return {
        error: `Write-capable agent "${lockPlan.agent}" cannot run against the target repository under a read-only lock.`,
        errorType: "read_only_agent_required",
        suggestedFix: "Use planner, architect, reviewer, tester, or orchestrator for read-only work. Run builder/debugger only as bounded worktree writers.",
        lockPlan,
      };
    }
    return { error: null, lockPlan };
  }

  if (!lockPlan.lockedPaths.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: lockedPaths.`,
      errorType: "missing_locked_paths",
      suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
      lockPlan,
    };
  }

  if (!lockPlan.allowedEdits.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: allowedEdits.`,
      errorType: "empty_allowed_edits",
      suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
      lockPlan,
    };
  }

  const ambiguousPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.sharedFiles, lockPlan.scopeContract?.scope.write || []);
  if (hasAmbiguousPathPattern(ambiguousPathInputs)) {
    return {
      error: `Write job for agent "${lockPlan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (!isWithinAnyPath(allowedPath, lockPlan.lockedPaths, lockPlan.cwd)) {
      return {
        error: `Write job for agent "${lockPlan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
        errorType: "lock_plan_rejected",
        lockPlan,
      };
    }
  }

  const forbiddenOverlap = overlaps(lockPlan.allowedEdits, lockPlan.forbiddenEdits);
  const forbiddenAllowedPaths = lockPlan.allowedEdits.filter((allowedPath) =>
    isWithinAnyPath(allowedPath, lockPlan.forbiddenEdits, lockPlan.cwd)
  );
  if (forbiddenOverlap || forbiddenAllowedPaths.length) {
    const conflictingPaths = forbiddenOverlap || forbiddenAllowedPaths;
    return {
      error: `Write job for agent "${lockPlan.agent}" allows a forbidden edit path: ${conflictingPaths.join(" / ")}.`,
      errorType: "lock_plan_rejected",
      conflictingPaths,
      lockPlan,
    };
  }

  return { error: null, lockPlan };
}

async function executeOpenCodeJob(requestedJob, { toolStarted = nowMs(), jobId = null, fromQueue = false, signal = null, onChildSpawn = null, onWorktreePrepared = null } = {}) {
  const {
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "reject",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    dryRun = false,
    delegation,
  } = requestedJob;
  const effectiveJobId = jobId || makeQueueJobId(agent);
  const { error: lockPlanError, errorType: lockPlanErrorType, suggestedFix: lockPlanSuggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(requestedJob);

  if (lockPlanError || (hasWriteIntent(requestedJob) && lockPlan.lockType === "read")) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              errorType: lockPlanErrorType || "lock_plan_rejected",
              reason: lockPlanError || `Write-capable agent "${agent}" requires lockedPaths so the bridge can create a temporary write lock.`,
              requestedAgent: agent,
              actualAgent: "none",
              lockMode: lockPlan?.lockMode || "unknown",
              durationMs: nowMs() - toolStarted,
              lockedPaths: lockPlan?.lockedPaths || [],
              allowedEdits: lockPlan?.allowedEdits || [],
              serialOnlyMatches,
              suggestedFix: lockPlanSuggestedFix || "Pass lockedPaths and allowedEdits to run_opencode_agent; do not pre-acquire locks manually.",
            }),
          },
        ],
      },
      result: {
        errorType: lockPlanErrorType || "lock_plan_rejected",
        changedFiles: [],
      },
      lockPlan,
    };
  }

  const sanitizedPreflight = requestedJob.sanitizedWorkspace && !dryRun
    ? await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "preflight_before_discovery")
    : null;
  if (sanitizedPreflight && !sanitizedPreflight.ok) {
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Sanitized workspace preflight rejected before OpenCode discovery.",
        errorType: sanitizedPreflight.errorType,
        reason: sanitizedPreflight.error,
        requestedAgent: agent,
        actualAgent: "none",
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        conflictingPaths: sanitizedPreflight.discrepancies?.map((item) => item.path) || [],
        suggestedFix: "Rebuild the sanitized workspace from its trusted manifest; do not allow OpenCode to inspect it until verification passes.",
      }) }] },
      result: { errorType: sanitizedPreflight.errorType, changedFiles: [] },
      lockPlan,
      sanitizedWorkspace: { preflight: sanitizedPreflight, before: null, after: null },
    };
  }

  if (!dryRun && !requestedJob.sanitizedWorkspace) {
    const gitState = await verifyProtectedGitRoot(cwd);
    if (!gitState.ok) {
      return {
        response: {
          content: [{
            type: "text",
            text: formatRejectedExecution({
              headline: "Protected execution rejected.",
              errorType: gitState.errorType,
              reason: gitState.error,
              requestedAgent: agent,
              actualAgent: "none",
              lockMode: lockPlan.lockMode,
              durationMs: nowMs() - toolStarted,
              suggestedFix: "Run the job inside a Git repository, or use dryRun for routing-only validation.",
            }),
          }],
        },
        result: { errorType: gitState.errorType, changedFiles: [] },
        lockPlan,
      };
    }
  }

  const discoveryContext = sanitizedDiscoveryContext({ ...requestedJob, cwd: cwd || process.cwd() });
  const { forcePure, discoveryCwd } = discoveryContext;
  const resolution = await resolveAgent(
    agent,
    cwd,
    allowFallbackToBuild,
    subagentStrategy,
    proxyAgent,
    lockPlan.orchestratorMode,
    discoveryContext
  );
  if (resolution.error) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: [
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
              "",
              `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
              `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
              `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
              `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
              `Discovery exit code: ${resolution.discoveryExitCode}`,
              `Available agents parsed: ${resolution.availableAgents.join(", ") || "none parsed"}`,
            ].join("\n"),
          },
        ],
      },
      result: {
        errorType: "agent_routing_error",
        changedFiles: [],
      },
      lockPlan,
      resolution,
    };
  }

  const routingPolicyError = readOnlyRoutingPolicyError(resolution, lockPlan);
  if (routingPolicyError) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "OpenCode agent routing rejected.",
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
      },
      result: {
        errorType: routingPolicyError.errorType,
        changedFiles: [],
      },
      lockPlan,
      resolution,
    };
  }

  let agentMetadata = await readAgentDebugMetadata(resolution.actualAgent, discoveryCwd, { forcePure });
  const metadataPolicyError = effectiveReadOnlyMetadataError(agentMetadata, lockPlan, agentMetadataPolicyOptions(resolution, lockPlan));
  const contractorNestedAttestation = lockPlan.orchestratorMode === "contractor"
    ? await attestContractorNestedAgents(discoveryCwd, { forcePure })
    : { ok: true };
  const contractorNestedError = contractorNestedAttestation.ok ? null : contractorNestedAttestation;
  const sanitizedMetadataError = requestedJob.sanitizedWorkspace ? sanitizedAgentMetadataError(agentMetadata, requestedJob.sanitizedWorkspace.root) : null;
  const sanitizedRoutingError = sanitizedRoutingPolicyError(requestedJob, resolution, discoveryCwd);
  if (metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError) {
    const policyError = metadataPolicyError || contractorNestedError || sanitizedMetadataError || sanitizedRoutingError;
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "Effective OpenCode agent policy rejected.",
        errorType: policyError.errorType,
        reason: policyError.error,
        requestedAgent: resolution.requestedAgent,
        actualAgent: resolution.actualAgent,
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        suggestedFix: "Use a directly runnable managed read-only agent whose exact-cwd effective debug policy denies editing, delegation, external-directory access, shell execution, and web/network tools.",
      }) }] },
      result: { errorType: policyError.errorType, changedFiles: [] },
      lockPlan,
      resolution,
    };
  }
  resolution.agentMetadata = agentMetadata.metadata || null;

  const normalizedDelegation = {
    ...delegation,
    lockMode: lockPlan.lockMode,
    lockType: lockPlan.lockType,
    orchestratorMode: lockPlan.orchestratorMode,
    userAuthorizedOrchestrator: lockPlan.userAuthorizedOrchestrator,
    lockedPaths: lockPlan.lockedPaths,
    allowedEdits: lockPlan.allowedEdits,
    forbiddenEdits: lockPlan.forbiddenEdits,
    sharedFiles: lockPlan.sharedFiles,
    scopeContract: lockPlan.scopeContract,
    validationCommand: lockPlan.validationCommand,
  };

  let prompt = buildCompactPrompt(resolution.requestedAgent, task, normalizedDelegation);
  if (resolution.proxyUsed) {
    prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
  }

  let acquiredLock = null;
  let stopLockHeartbeat = () => {};
  let worktree = null;
  let worktreeDiff = null;
  let worktreeCleanup = null;
  const shouldAcquireLock = !dryRun && lockPlan.lockType !== "read";
  let executionCwd = cwd || process.cwd();
  let sanitizedBefore = null;

  try {
    if (shouldAcquireLock) {
      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: resolution.requestedAgent,
        task,
        cwd: cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: hardLockPathsForPlan(lockPlan),
        ttlMs: hardLockTtlForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        const queueConflict = fromQueue && effectiveQueueWriteConflictPolicy() === "wait";
        const conflictDetails = directExecutionLockConflictDetails(lockResult, queueConflict);
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: conflictDetails.headline,
                  errorType: conflictDetails.errorType,
                  reason: lockResult.error,
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: conflictDetails.suggestedFix,
                }),
              },
            ],
          },
          result: {
            errorType: conflictDetails.errorType,
            changedFiles: [],
          },
          lockPlan,
          resolution,
        };
      }

      acquiredLock = lockResult.lock;
      stopLockHeartbeat = startHardLockHeartbeat(acquiredLock, hardLockTtlForPlan(lockPlan));
    }

    if (shouldUseWorktree(requestedJob, lockPlan)) {
      const worktreeResult = await createWorktreeForJob({
        cwd: cwd || process.cwd(),
        agent: resolution.requestedAgent,
        jobId: effectiveJobId,
        lockedPaths: lockPlan.lockedPaths,
        allowedEdits: lockPlan.allowedEdits,
        scopeContract: lockPlan.scopeContract,
      });

      if (!worktreeResult.ok) {
        const dirtyDetails = dirtyCheckpointDetails(worktreeResult);
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: "Worktree setup failed.",
                  errorType: worktreeResult.errorType || "worktree_create_failed",
                  reason: worktreeResult.error || "Could not create a Git worktree for this job.",
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  lockedPaths: lockPlan.lockedPaths,
                  allowedEdits: lockPlan.allowedEdits,
                  conflictingPaths: dirtyDetails.conflictingPaths,
                  dirtyFiles: dirtyDetails.dirtyFiles,
                  overlappingFiles: dirtyDetails.overlappingFiles,
                  disjointFiles: dirtyDetails.disjointFiles,
                  suggestedFix: "Create/select a clean reproducible checkpoint, choose a safe worktree root, and ensure this cwd is a Git repository with git available.",
                }),
              },
            ],
          },
          result: {
            errorType: worktreeResult.errorType || "worktree_create_failed",
            changedFiles: [],
            dirtyFiles: dirtyDetails.dirtyFiles,
            overlappingFiles: dirtyDetails.overlappingFiles,
            disjointFiles: dirtyDetails.disjointFiles,
            conflictingPaths: dirtyDetails.conflictingPaths,
          },
          lockPlan,
          resolution,
          worktree: worktreeResult,
        };
      }

      worktree = worktreeResult;
      executionCwd = worktree.path;
      if (typeof onWorktreePrepared === "function") await onWorktreePrepared(worktree);
    }

    const manifestProtected = Boolean(requestedJob.sanitizedWorkspace);
    if (manifestProtected && !dryRun) {
      sanitizedBefore = await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "before_wave");
      if (!sanitizedBefore.ok) {
        return {
          response: { content: [{ type: "text", text: formatRejectedExecution({
            headline: "Sanitized workspace changed between preflight and execution.",
            errorType: sanitizedBefore.errorType,
            reason: sanitizedBefore.error,
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: nowMs() - toolStarted,
            conflictingPaths: sanitizedBefore.discrepancies?.map((item) => item.path) || [],
            suggestedFix: "Retain the workspace for investigation and rebuild it from its trusted manifest before retrying.",
          }) }] },
          result: { errorType: sanitizedBefore.errorType, changedFiles: [] },
          lockPlan,
          resolution,
          sanitizedWorkspace: { preflight: sanitizedPreflight, before: sanitizedBefore, after: null },
        };
      }
    }
    const finalAgentMetadata = await readAgentDebugMetadata(resolution.actualAgent, executionCwd, { forcePure });
    const finalMetadataPolicyError = effectiveReadOnlyMetadataError(
      finalAgentMetadata,
      lockPlan,
      agentMetadataPolicyOptions(resolution, lockPlan, agentMetadata.metadata)
    );
    const finalContractorNestedAttestation = lockPlan.orchestratorMode === "contractor"
      ? await attestContractorNestedAgents(executionCwd, { forcePure })
      : { ok: true };
    const finalContractorNestedError = finalContractorNestedAttestation.ok ? null : finalContractorNestedAttestation;
    const finalSanitizedMetadataError = manifestProtected ? sanitizedAgentMetadataError(finalAgentMetadata, requestedJob.sanitizedWorkspace.root) : null;
    const finalSanitizedRoutingError = sanitizedRoutingPolicyError(requestedJob, resolution, executionCwd);
    if (finalMetadataPolicyError || finalContractorNestedError || finalSanitizedMetadataError || finalSanitizedRoutingError) {
      const policyError = finalMetadataPolicyError || finalContractorNestedError || finalSanitizedMetadataError || finalSanitizedRoutingError;
      return {
        response: { content: [{ type: "text", text: formatRejectedExecution({
          headline: "Final pre-spawn OpenCode agent policy rejected.",
          errorType: policyError.errorType,
          reason: policyError.error,
          requestedAgent: resolution.requestedAgent,
          actualAgent: resolution.actualAgent,
          lockMode: lockPlan.lockMode,
          durationMs: nowMs() - toolStarted,
          suggestedFix: worktree
            ? `Inspect the retained worktree ${worktree.path}; its effective agent definition differs from the attested source policy.`
            : "Restore the bridge-managed effective agent definition and retry.",
        }) }] },
        result: { errorType: policyError.errorType, changedFiles: [] },
        lockPlan,
        resolution,
        worktree,
        sanitizedWorkspace: manifestProtected ? { preflight: sanitizedPreflight, before: sanitizedBefore, after: null } : null,
      };
    }
    agentMetadata = finalAgentMetadata;
    resolution.agentMetadata = finalAgentMetadata.metadata;
    const beforeFiles = dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd);
    const executionHeadBefore = dryRun || manifestProtected ? "" : await captureGitHead(executionCwd);
    let result = await runOpenCodeWithPolicy(resolution.actualAgent, prompt, executionCwd, dryRun, lockPlan, lockPlan.timeoutMs, { signal, agentMetadata, onSpawn: onChildSpawn });
    const afterFiles = dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd);
    const executionHeadAfterAgent = dryRun || manifestProtected ? executionHeadBefore : await captureGitHead(executionCwd);
    const sanitizedAfter = manifestProtected && !dryRun
      ? await verifySanitizedWorkspace(requestedJob.sanitizedWorkspace, "after_wave")
      : null;
    result.changedFiles = sanitizedAfter && !sanitizedAfter.ok
      ? normalizeLockPathList((sanitizedAfter.discrepancies || []).map((item) => item.path))
      : changedFilesBetween(beforeFiles, afterFiles);
    if (executionHeadAfterAgent !== executionHeadBefore && !result.errorType) {
      result.errorType = "repository_head_changed_during_execution";
      result.stderr = [result.stderr, "Repository HEAD changed during OpenCode execution. The change is unattributed and was retained for review."].filter(Boolean).join("\n");
    }
    result.executionHeadBefore = executionHeadBefore;
    result.executionHeadAfter = executionHeadAfterAgent;
    if (sanitizedAfter && !sanitizedAfter.ok && !result.errorType) {
      result.errorType = sanitizedAfter.errorType;
      result.stderr = [result.stderr, sanitizedAfter.error].filter(Boolean).join("\n");
    }
    result.sanitizedWorkspaceVerification = manifestProtected ? { preflight: sanitizedPreflight, before: sanitizedBefore, after: sanitizedAfter } : null;

    let validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
    const postExecutionPathError = dryRun ? "" : unsafePathReason(
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
      validation.disallowedFiles = normalizeLockPathList(validation.disallowedFiles.concat(result.changedFiles));
      result.errorType ||= "unsafe_path_after_execution";
      result.stderr = [result.stderr, postExecutionPathError].filter(Boolean).join("\n");
    }
    const validationGate = manifestProtected
      ? { status: sanitizedAfter?.ok ? "passed_manifest" : "failed_manifest", command: "", exitCode: sanitizedAfter?.ok ? 0 : 1, durationMs: 0, stdout: "", stderr: sanitizedAfter?.error || "", errorType: sanitizedAfter?.ok ? null : sanitizedAfter?.errorType }
      : !validation.disallowedFiles.length && !result.errorType
      ? await runValidationGate({ command: lockPlan.validationCommand, cwd: executionCwd, dryRun, timeoutMs: CONFIG.validationCommandTimeoutMs })
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

    const afterValidationFiles = dryRun || manifestProtected ? afterFiles : await gitChangedFileSnapshot(executionCwd);
    const executionHeadAfterValidation = dryRun || manifestProtected ? executionHeadAfterAgent : await captureGitHead(executionCwd);
    const validationMutationFiles = dryRun || manifestProtected ? [] : changedFilesBetween(afterFiles, afterValidationFiles);
    if (executionHeadAfterValidation !== executionHeadBefore) {
      result.errorType ||= "repository_head_changed_during_execution";
      result.stderr = [result.stderr, "Repository HEAD changed before execution validation completed. The change is unattributed and was retained for review."].filter(Boolean).join("\n");
      result.executionHeadAfter = executionHeadAfterValidation;
    }
    if (validationMutationFiles.length) {
      result.changedFiles = changedFilesBetween(beforeFiles, afterValidationFiles);
      validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
      result.validationMutationFiles = validationMutationFiles;
      result.errorType ||= "validation_mutated_workspace";
      result.stderr = [result.stderr, `Validation changed workspace paths after agent execution: ${validationMutationFiles.join(", ")}. The changes were retained as unattributed external state.`].filter(Boolean).join("\n");
      const postValidationPathError = unsafePathReason(
        lockPlan.lockedPaths.concat(
          lockPlan.allowedEdits,
          lockPlan.forbiddenEdits,
          lockPlan.sharedFiles,
          scopeContractPathInputs(lockPlan.scopeContract),
          result.changedFiles
        ),
        executionCwd
      );
      if (postValidationPathError) {
        validation.disallowedFiles = normalizeLockPathList(validation.disallowedFiles.concat(validationMutationFiles));
        result.stderr = [result.stderr, postValidationPathError].filter(Boolean).join("\n");
      }
    }

    const unresolvedValidationFiles = normalizeLockPathList(validation.disallowedFiles.concat(validationMutationFiles));
    const rollbackResult = unresolvedValidationFiles.length && !dryRun && !manifestProtected
      ? {
          rollback: "not_attempted_unattributed_changes",
          rollbackFiles: [],
          unresolvedFiles: unresolvedValidationFiles,
          reason: worktree
            ? "Rejected output was retained in the bridge-owned worktree for exact inspection; the bridge cannot distinguish a concurrent external edit by path alone."
            : "The bridge did not overwrite or delete changes in the user's workspace because path-only evidence cannot attribute them to OpenCode or validation rather than a concurrent user or process.",
        }
      : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };

    if (worktree) {
      worktreeDiff = await collectWorktreeDiff(worktree);
      if (worktreeDiff?.errorType && !result.errorType) {
        result.errorType = worktreeDiff.errorType;
        result.stderr = [result.stderr, worktreeDiff.error].filter(Boolean).join("\n");
      }
      if (!worktreeDiff?.errorType) {
        const representablePaths = changedPathSetEvidence(result.changedFiles, worktreeDiff?.changedFiles || []);
        const unrepresentableFiles = normalizeLockPathList(representablePaths.missingFiles.concat(representablePaths.unexpectedFiles));
        if (unrepresentableFiles.length) {
          result.changedFiles = normalizeLockPathList(result.changedFiles.concat(worktreeDiff?.changedFiles || []));
          validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
          result.errorType ||= "worktree_output_unrepresentable";
          result.unrepresentableFiles = unrepresentableFiles;
          result.stderr = [
            result.stderr,
            `Execution output and the integratable Git patch differ at: ${unrepresentableFiles.join(", ")}. Ignored, committed-during-run, or otherwise unrepresentable output was retained in the worktree and cannot be reported as successful.`,
          ].filter(Boolean).join("\n");
          rollbackResult.rollback = "not_attempted_unattributed_changes";
          rollbackResult.unresolvedFiles = normalizeLockPathList(rollbackResult.unresolvedFiles.concat(unrepresentableFiles));
        }
      }
      worktreeCleanup = {
        cleanup: "retained_for_review",
        reason: result.errorType || validation.disallowedFiles.length
          ? "failed or rejected write output is retained for diagnosis and recovery"
          : "successful write output is retained until reviewed integration and a passing validation gate",
      };
      result.worktree = {
        path: worktree.path,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
        baseTree: worktree.baseTree,
        patchSha256: worktreeDiff?.patchSha256 || "",
        sourceStateSha256: worktreeDiff?.sourceStateSha256 || "",
        cleanup: worktreeCleanup.cleanup,
        changedFiles: worktreeDiff?.changedFiles || [],
        diffStat: worktreeDiff?.diffStat || "",
      };
      if (worktreeCleanup.errorType && !result.errorType) {
        result.errorType = worktreeCleanup.errorType;
      }
    }

    await recordChangedFiles(acquiredLock?.id, cwd, result.changedFiles, validation.disallowedFiles);
    const validationErrorType = validation.disallowedFiles.length && worktree && changedFileValidationErrorType(validation) === "changed_file_validation_error"
      ? "worktree_changed_file_validation_error"
      : changedFileValidationErrorType(validation);
    const lockViolation = validation.disallowedFiles.length
      ? [
          "",
          "Write lock verification:",
          formatRejectedExecution({
            headline: "OpenCode result rejected.",
            errorType: validationErrorType,
            reason: "The OpenCode result changed files outside the granted allowedEdits or Scope Contract, touched forbidden/shared paths, or a read-only agent edited files.",
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: result.durationMs ?? nowMs() - toolStarted,
            conflictingPaths: validation.disallowedFiles,
            lockedPaths: lockPlan.lockedPaths,
            allowedEdits: lockPlan.allowedEdits,
            runId: acquiredLock?.id || "",
            rollback: rollbackResult.rollback,
            disallowedFiles: validation.disallowedFiles,
            serialOnlyMatches: validation.serialOnlyMatches,
            rollbackFiles: rollbackResult.rollbackFiles,
            unresolvedFiles: rollbackResult.unresolvedFiles,
            suggestedFix: "Inspect any unresolved files, then rerun with explicit lockedPaths and allowedEdits or handle the work serially.",
          }),
        ].join("\n")
      : ["", "Write lock verification:", "Accepted. Detected changed files stayed inside allowedEdits and did not touch forbidden/shared paths."].join("\n");
    const nativeFallbackViolation = result.openCodeFallbackDetected
      ? [
          "",
          "OpenCode native fallback verification:",
          "Rejected. The requested role may not have executed because OpenCode fell back internally.",
        ].join("\n")
      : ["", "OpenCode native fallback verification:", "Accepted. No native fallback detected."].join("\n");
    const apiErrorViolation = result.openCodeApiErrorDetected
      ? [
          "",
          "OpenCode API error verification:",
          "Rejected. OpenCode returned an API error event even though the process may have exited successfully.",
        ].join("\n")
      : ["", "OpenCode API error verification:", "Accepted. No OpenCode API error detected."].join("\n");
    const finalResponseViolation = !dryRun && !result.assistantFinalResponseDetected
      ? ["", "OpenCode final response verification:", "Rejected. OpenCode did not emit a non-empty terminal assistant text event."].join("\n")
      : ["", "OpenCode final response verification:", dryRun ? "Skipped for dry run." : "Accepted. A terminal assistant response was detected."].join("\n");
    const worktreeReview = worktree
      ? [
          "",
          "Worktree review:",
          formatWorktreeSummary(worktree, worktreeCleanup),
          `Worktree changed files: ${(worktreeDiff?.changedFiles || []).length ? worktreeDiff.changedFiles.join(", ") : "none detected"}`,
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : "Worktree diff stat: none",
          worktreeDiff?.patchPreview ? `Worktree patch preview:\n${worktreeDiff.patchPreview}` : "Worktree patch preview: none",
        ].join("\n")
      : ["", "Worktree review:", "Worktree: not used"].join("\n");

    return {
      response: {
        content: [
          {
            type: "text",
            text: [
              `Temporary lock acquired: ${hardLockSummary(acquiredLock)}`,
              `Temporary lock released: ${acquiredLock ? "yes" : "not needed"}`,
              formatSingleResult({ resolution, result, cwd: executionCwd, lockPlan }),
              worktreeReview,
              nativeFallbackViolation,
              apiErrorViolation,
              finalResponseViolation,
              formatValidationGateResult(validationGate),
              lockViolation,
            ].join("\n"),
          },
        ],
      },
      result,
      lockPlan,
      resolution,
      validation,
      worktree,
      worktreeCleanup,
      sanitizedWorkspace: result.sanitizedWorkspaceVerification || null,
    };
  } catch (error) {
    let retainedDiff = null;
    if (worktree) {
      try { retainedDiff = await collectWorktreeDiff(worktree); } catch { retainedDiff = null; }
    }
    const worktreeDetails = worktree ? {
      path: worktree.path,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      baseTree: worktree.baseTree,
      patchSha256: retainedDiff?.patchSha256 || "",
      sourceStateSha256: retainedDiff?.sourceStateSha256 || "",
      cleanup: "retained_for_review",
      changedFiles: retainedDiff?.changedFiles || [],
      diffStat: retainedDiff?.diffStat || "",
    } : null;
    const errorText = redactSensitiveText(error.message || String(error));
    return {
      response: { content: [{ type: "text", text: formatRejectedExecution({
        headline: "OpenCode job infrastructure failed closed.",
        errorType: "job_infrastructure_failed",
        reason: `${errorText}${worktree ? " The isolated worktree and branch were retained for recovery." : " No broad rollback was attempted because concurrent or pre-existing user changes cannot be distinguished safely after this infrastructure fault."}`,
        requestedAgent: resolution.requestedAgent,
        actualAgent: resolution.actualAgent,
        lockMode: lockPlan.lockMode,
        durationMs: nowMs() - toolStarted,
        unresolvedFiles: worktreeDetails?.changedFiles || [],
        suggestedFix: "Inspect the retained worktree or target checkout before retrying; do not discard recovery evidence.",
      }) }] },
      result: {
        errorType: "job_infrastructure_failed",
        error: errorText,
        changedFiles: worktreeDetails?.changedFiles || [],
        worktree: worktreeDetails,
      },
      lockPlan,
      resolution,
      worktree,
      worktreeCleanup: worktree ? { cleanup: "retained_for_review", reason: "infrastructure failure" } : null,
    };
  } finally {
    stopLockHeartbeat();
    if (acquiredLock) {
      await releaseHardLock(acquiredLock.id, acquiredLock.token, acquiredLock.paths, acquiredLock.cwd);
    }
  }
}

function queueMaxRetriesForPlan(lockPlan) {
  void lockPlan;
  return 0;
}

function queueLockPathsForRecord(record) {
  return normalizeLockPathList(record.allowedEdits?.length ? record.allowedEdits : record.lockedPaths);
}

function runningQueueRecords() {
  return [...QUEUE_JOBS.values()].filter((record) => ["running", "validating", "reviewing", "testing"].includes(record.status));
}

async function findQueueWriteConflict(record) {
  if (record.mode !== "write") {
    return null;
  }

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
    if (running.mode !== "write") {
      continue;
    }

    if (path.resolve(running.cwd || process.cwd()) !== cwdKey) {
      continue;
    }

    const overlap = overlaps(queueLockPathsForRecord(record), queueLockPathsForRecord(running));
    if (overlap) {
      if (!QUEUE_JOBS.has(running.jobId)) {
        const activeLocks = await listLocks(cwdKey);
        const activeOverlap = activeLocks.some((lock) => overlaps(overlap, lock.paths));
        if (!activeOverlap) {
          continue;
        }
      }
      return {
        jobId: running.jobId,
        paths: overlap,
      };
    }
  }

  return null;
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
      mode: plan.lockType === "read" ? "read" : "write",
      cwd: plan.cwd,
      lockedPaths: plan.lockedPaths,
      allowedEdits: plan.allowedEdits,
    };
    const conflict = await findQueueWriteConflict(candidate);
    if (conflict) {
      return {
        status: effectiveQueueWriteConflictPolicy() === "reject" ? "conflict" : "must_wait",
        reason: `Queued/running write job ${conflict.jobId} overlaps this plan.`,
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

async function enqueueQueueJob(job, parentJobId = "", { schedule = true, initialStatus = "pending" } = {}) {
  if (effectiveQueueMode() === "off") {
    return {
      ok: false,
      errorType: "queue_disabled",
      error: "CODEX_OPENCODE_QUEUE_MODE is off.",
      suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=memory or sqlite, or call run_opencode_agent directly.",
    };
  }

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
    maxRetries: queueMaxRetriesForPlan(lockPlan),
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
    revision: 0,
  };

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
    return { ok: false, errorType: "queue_persistence_failed", error: "The queue request was not durably accepted." };
  }
  QUEUE_JOBS.set(jobId, record);
  if (schedule) {
    scheduleQueue();
  }
  return { ok: true, record };
}

function shouldRetryQueueJob(record, execution) {
  void record;
  void execution;
  return false;
}

async function startQueueRecord(record) {
  const claim = await claimQueueRecord(record);
  if (!claim.ok) return false;

  record.abortController = new AbortController();
  record.executionPromise = (async () => {
    const started = nowMs();
    try {
      if (record.cancellationRequested) {
        await updateQueueRecordDurable(record, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
          heartbeatAt: "",
          leaseExpiresAt: "",
        });
        return;
      }

      const execution = await executeOpenCodeJob(record.request, {
        toolStarted: started,
        jobId: record.jobId,
        fromQueue: true,
        signal: record.abortController.signal,
        onWorktreePrepared: async (worktree) => {
          await updateQueueRecordDurable(record, {
            worktreePath: worktree.path || "",
            worktreeBranch: worktree.branch || "",
            worktreeBaseCommit: worktree.baseCommit || "",
            worktreeBaseTree: worktree.baseTree || "",
          });
        },
        onChildSpawn: async ({ pid, startedAt }) => {
          record.childProcessId = pid || 0;
          record.childProcessStartedAt = startedAt || new Date().toISOString();
          await persistQueueRecord(record);
        },
      });
      const validationError = execution.validation?.disallowedFiles?.length
        ? changedFileValidationErrorType(execution.validation)
        : "";
      const errorType = execution.result?.errorType || validationError || "";

      if (record.cancellationRequested || errorType === "agent_cancelled") {
        await updateQueueRecordDurable(record, {
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
          resultText: execution.response?.content?.[0]?.text || "",
          worktreePath: execution.worktree?.path || "",
          worktreeBranch: execution.worktree?.branch || "",
          worktreeBaseCommit: execution.worktree?.baseCommit || "",
          worktreeBaseTree: execution.worktree?.baseTree || "",
          worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
          worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        return;
      }

      if (errorType === "queue_lock_conflict" && effectiveQueueWriteConflictPolicy() === "wait") {
        await updateQueueRecordDurable(record, {
          status: "blocked",
          errorType,
          errorReason: "Waiting for the active cross-process write lock to be released.",
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        return;
      }

      if (shouldRetryQueueJob(record, execution)) {
        await updateQueueRecordDurable(record, {
          status: "pending",
          retryCount: record.retryCount + 1,
          errorType,
          errorReason: "Retrying safe read-only job after timeout.",
          childProcessId: 0,
          childProcessStartedAt: "",
        });
        return;
      }

      await updateQueueRecordDurable(record, {
        status: errorType ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - started,
        heartbeatAt: "",
        leaseExpiresAt: "",
        errorType,
        errorReason: errorType ? summarizeStderr(execution.result?.stderr) || errorType : "",
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
        resultText: execution.response?.content?.[0]?.text || "",
        worktreePath: execution.worktree?.path || "",
        worktreeBranch: execution.worktree?.branch || "",
        worktreeBaseCommit: execution.worktree?.baseCommit || "",
        worktreeBaseTree: execution.worktree?.baseTree || "",
        worktreePatchSha256: execution.result?.worktree?.patchSha256 || "",
        worktreeSourceStateSha256: execution.result?.worktree?.sourceStateSha256 || "",
        childProcessId: 0,
        childProcessStartedAt: "",
      });
    } catch (error) {
      await updateQueueRecordDurable(record, {
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
    } finally {
      if (["completed", "failed", "cancelled", "interrupted", "not_resumable"].includes(record.status)) {
        delete record.request;
      }
      delete record.abortController;
      delete record.executionPromise;
      scheduleQueue();
    }
  })();
  return true;
}

function nextQueueScheduleDelay(records, hasCapacity) {
  if (!hasCapacity) {
    return null;
  }
  if (records.some((record) => ["pending", "planned"].includes(record.status))) {
    return 0;
  }
  return records.some((record) => record.status === "blocked")
    ? CONFIG.queueBlockedPollMs
    : null;
}

function scheduleQueue(delayMs = 0) {
  if (effectiveQueueMode() === "off" || queueSchedulerActive) {
    return;
  }

  queueSchedulerActive = true;
  queueWakeTimer = setTimeout(async () => {
    queueWakeTimer = null;
    try {
      const runningCount = runningQueueRecords().length;
      let capacity = Math.max(0, CONFIG.queueParallelLimit - runningCount);
      if (!capacity) {
        return;
      }

      for (const record of QUEUE_JOBS.values()) {
        if (!capacity) {
          break;
        }

        if (!["pending", "blocked", "planned"].includes(record.status)) {
          continue;
        }

        if (record.cancellationRequested) {
          await updateQueueRecordDurable(record, {
            status: "cancelled",
            finishedAt: new Date().toISOString(),
          });
          continue;
        }

        const plannedPersistence = await updateQueueRecordDurable(record, { status: "planned" });
        if (!plannedPersistence.persisted || record.status !== "planned") continue;
        const conflict = await findQueueWriteConflict(record);
        if (conflict) {
          if (effectiveQueueWriteConflictPolicy() === "reject") {
            await updateQueueRecordDurable(record, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              errorType: "write_lock_conflict",
              errorReason: `Write lock conflict on: ${conflict.paths[0] || "unknown"}`,
            });
          } else {
            await updateQueueRecordDurable(record, {
              status: "blocked",
              errorType: "write_lock_conflict",
              errorReason: `Waiting for queued write job ${conflict.jobId} to release: ${conflict.paths.join(", ")}`,
            });
          }
          continue;
        }

        const started = await startQueueRecord(record);
        if (started) capacity -= 1;
      }
    } catch (error) {
      logEvent("warn", "queue.scheduler_failed", { error: error.message || String(error) });
    } finally {
      queueSchedulerActive = false;
      const records = [...QUEUE_JOBS.values()];
      const hasCapacity = runningQueueRecords().length < CONFIG.queueParallelLimit;
      const nextDelay = nextQueueScheduleDelay(records, hasCapacity);
      if (nextDelay !== null) {
        scheduleQueue(nextDelay);
      }
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function makePipelineId(name = "pipeline") {
  return `${safeNamePart(name, "pipeline")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function pipelineRecordSnapshot(record) {
  const finalValidationSource = record.finalValidationSource
    || (record.policy?.path && record.finalValidationCommand ? "legacy_unknown" : "none");
  return sanitizePersistedValue({
    pipelineId: record.pipelineId,
    revision: Number(record.revision || 0),
    ownerInstanceId: record.ownerInstanceId || BRIDGE_INSTANCE_ID,
    ownerHeartbeatAt: record.ownerHeartbeatAt || new Date().toISOString(),
    ownerLeaseExpiresAt: record.ownerLeaseExpiresAt || new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    name: record.name || "",
    cwd: record.cwd || "",
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt || "",
    finishedAt: record.finishedAt || "",
    strategy: record.strategy || "queue",
    requiresWorktrees: Boolean(record.requiresWorktrees),
    policy: record.policy || null,
    jobs: record.jobs || [],
    lockPlans: record.lockPlans || [],
    queueJobIds: record.queueJobIds || [],
    integrationQueue: record.integrationQueue || [],
    finalValidationCommand: record.finalValidationCommand || "",
    finalValidationSource,
    finalValidationSpec: record.finalValidationSpec || null,
    finalValidationResult: record.finalValidationResult || null,
    reviewerJob: record.reviewerJob || null,
    reviewerResult: record.reviewerResult || null,
    testerJob: record.testerJob || null,
    testerResult: record.testerResult || null,
    sourceCleanupResults: record.sourceCleanupResults || [],
    cleanupPending: Boolean(record.cleanupPending),
    events: record.events || [],
    errors: record.errors || [],
    sanitizedWorkspace: record.sanitizedWorkspace || null,
    sanitizedWorkspaceAttestation: record.sanitizedWorkspaceAttestation || null,
  });
}

function pipelineReplayRequest(record) {
  return {
    jobs: record.jobs || [],
    reviewerJob: record.reviewerJob || null,
    testerJob: record.testerJob || null,
    finalValidationCommand: record.finalValidationCommand || "",
  };
}

function pipelinePersistenceKey(record) {
  return JSON.stringify([record.cwd || "", record.pipelineId]);
}

function pipelineOwnedByThisInstance(record) {
  return Boolean(record?.ownerInstanceId) && record.ownerInstanceId === BRIDGE_INSTANCE_ID;
}

async function claimPersistedPipeline(record) {
  if (pipelineOwnedByThisInstance(record)) return { ok: true, record };
  if (["planned", "running"].includes(record?.status) && !record.requestEncrypted && !record.replayRequestAvailable) {
    return { ok: false, reason: "legacy_pipeline_request_unavailable" };
  }
  const db = await openLockDb(record.cwd);
  try {
    const now = Date.now();
    const expiresAt = Date.parse(record?.ownerLeaseExpiresAt || "");
    const owner = record?.ownerInstanceId
      ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(record.ownerInstanceId)
      : null;
    const ownerExpiresAt = Date.parse(owner?.lease_expires_at || "");
    if ((Number.isFinite(expiresAt) && expiresAt > now)
      || (Number.isFinite(ownerExpiresAt) && ownerExpiresAt > now)) return { ok: false, reason: "owner_lease_active" };
    const expectedRevision = Number(record.revision || 0);
    const claimedAt = new Date().toISOString();
    const candidate = {
      ...record,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerHeartbeatAt: now,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      ownerHeartbeatAt: claimedAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: expectedRevision + 1,
      updatedAt: claimedAt,
      events: (record.events || []).concat({ type: "pipeline_owner_recovered", at: claimedAt, ownerInstanceId: BRIDGE_INSTANCE_ID }),
    };
    const updated = db.prepare(`
      UPDATE opencode_pipelines SET updated_at = ?, record_json = ?, revision = ?
      WHERE pipeline_id = ? AND revision = ?
    `).run(candidate.updatedAt, JSON.stringify(pipelineRecordSnapshot(candidate)), candidate.revision, candidate.pipelineId, expectedRevision);
    if (Number(updated.changes || 0) !== 1) return { ok: false, reason: "concurrent_update" };
    Object.assign(record, candidate);
    PIPELINE_RUNS.set(record.pipelineId, record);
    return { ok: true, record };
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

function pipelineConcurrentUpdateError(snapshot, authoritative = null) {
  const error = new Error(`Pipeline ${snapshot.pipelineId} changed in another process; the stale update was rejected.`);
  error.code = "pipeline_concurrent_update";
  error.errorType = "pipeline_concurrent_update";
  error.authoritative = authoritative;
  return error;
}

async function writePipelineRecordSnapshot(snapshot, { create = false, expectedRevision = null } = {}) {
  if (typeof pipelinePersistenceTestHook === "function") {
    await pipelinePersistenceTestHook(snapshot);
  }
  const db = await openLockDb(snapshot.cwd);
  try {
    if (create) {
      const inserted = db.prepare(`
        INSERT INTO opencode_pipelines
        (pipeline_id, cwd, status, created_at, updated_at, record_json, revision, request_encrypted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pipeline_id) DO NOTHING
      `).run(
        snapshot.pipelineId,
        snapshot.cwd || "",
        snapshot.status,
        snapshot.createdAt,
        snapshot.updatedAt,
        JSON.stringify(pipelineRecordSnapshot(snapshot)),
        Number(snapshot.revision || 0),
        snapshot.requestEncrypted || null
      );
      if (inserted.changes !== 1) throw pipelineConcurrentUpdateError(snapshot);
      return snapshot;
    }
    const expected = Number(expectedRevision);
    const updated = db.prepare(`
      UPDATE opencode_pipelines
      SET cwd = ?, status = ?, created_at = ?, updated_at = ?, record_json = ?, revision = ?, request_encrypted = COALESCE(?, request_encrypted)
      WHERE pipeline_id = ? AND revision = ?
    `).run(
      snapshot.cwd || "",
      snapshot.status,
      snapshot.createdAt,
      snapshot.updatedAt,
      JSON.stringify(pipelineRecordSnapshot(snapshot)),
      Number(snapshot.revision || 0),
      snapshot.requestEncrypted || null,
      snapshot.pipelineId,
      expected
    );
    if (updated.changes !== 1) {
      const row = db.prepare("SELECT status, revision, record_json FROM opencode_pipelines WHERE pipeline_id = ?").get(snapshot.pipelineId);
      const authoritative = row?.record_json ? {
        ...JSON.parse(row.record_json),
        status: row.status,
        revision: Number(row.revision || 0),
      } : null;
      throw pipelineConcurrentUpdateError(snapshot, authoritative);
    }
    return snapshot;
  } finally {
    closeDb(db);
  }
}

function persistPipelineRecord(record) {
  if (!record.ownerInstanceId) record.ownerInstanceId = BRIDGE_INSTANCE_ID;
  record.ownerHeartbeatAt = record.ownerHeartbeatAt || new Date().toISOString();
  record.ownerLeaseExpiresAt = record.ownerLeaseExpiresAt || new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  return enqueuePipelinePersistence(record, async () => {
    if (effectiveQueueMode() === "sqlite" && !record.requestEncrypted) {
      record.requestEncrypted = await encryptQueueRequest(pipelineReplayRequest(record), record.pipelineId);
    }
    const snapshot = pipelineRecordSnapshot(record);
    await writePipelineRecordSnapshot({ ...snapshot, requestEncrypted: record.requestEncrypted || "" }, { create: true });
    record.revision = Number(snapshot.revision || record.revision || 0);
    return record;
  });
}

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
      const candidate = {
        ...record,
        ...patch,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        ownerHeartbeatAt: new Date().toISOString(),
        ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      };
      await writePipelineRecordSnapshot(pipelineRecordSnapshot(candidate), { expectedRevision });
      Object.assign(record, candidate);
      return record;
    });
  } catch (error) {
    if (error?.authoritative) Object.assign(record, error.authoritative);
    logEvent("warn", "pipeline.persist_failed", {
      pipelineId: record.pipelineId,
      error: error.message || String(error),
    });
    throw error;
  }
}

async function readPersistedPipelineRecord(pipelineId, cwd = "") {
  const db = await openLockDb(cwd);
  try {
    const row = db.prepare("SELECT status, revision, request_encrypted, record_json FROM opencode_pipelines WHERE pipeline_id = ?").get(pipelineId);
    if (!row?.record_json) return null;
    const record = {
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
    };
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
    const rows = status
      ? db.prepare("SELECT status, revision, request_encrypted, record_json FROM opencode_pipelines WHERE status = ? ORDER BY created_at DESC").all(status)
      : db.prepare("SELECT status, revision, request_encrypted, record_json FROM opencode_pipelines ORDER BY created_at DESC").all();
    return rows.map((row) => ({
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
      replayRequestAvailable: Boolean(row.request_encrypted),
    }));
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
  const writeSnapshots = queueSnapshots.filter((job) => job.worktreePath);
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
      status: prior.status === "integrated" ? "integrated" : prior.status === "rejected" ? "rejected" : "pending",
    };
  });
}

async function refreshPipelineRecord(record) {
  const queueSnapshots = [];
  for (const jobId of record.queueJobIds || []) {
    const snapshot = pipelineJobStatus(jobId, record.cwd) || await readPersistedQueueRecord(jobId, record.cwd);
    if (snapshot) {
      queueSnapshots.push(snapshot);
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
      await updatePipelineRecord(record, {
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
      const integrationQueue = mergePipelineIntegrationQueue(record.integrationQueue || [], queueSnapshots);
      const allIntegrated = integrationQueue.every((item) => item.status === "integrated");
      await updatePipelineRecord(record, {
        status: allIntegrated ? "awaiting_finalization" : "awaiting_integration",
        finishedAt: record.finishedAt || new Date().toISOString(),
        events,
        integrationQueue,
      });
    } else if (active.length) {
      await updatePipelineRecord(record, { status: "running", events });
    }
  }

  return record;
}

function pipelineHasPendingIntegrations(record) {
  const queue = record.integrationQueue || [];
  return queue.some((item) => item.status !== "integrated");
}

async function runPipelineReadOnlyGate(record, gateName, gateJob) {
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

  const execution = await executeOpenCodeJob({
    ...gateJob,
    cwd: gateJob.cwd || record.cwd,
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
    ].filter(Boolean).join("\n"),
  }, { toolStarted: nowMs(), jobId: `${record.pipelineId}-${gateName}` });

  const result = {
    gate: gateName,
    status: execution.result?.errorType || execution.validation?.disallowedFiles?.length ? "failed" : "passed",
    errorType: execution.result?.errorType || (execution.validation?.disallowedFiles?.length ? changedFileValidationErrorType(execution.validation) : ""),
    changedFiles: execution.result?.changedFiles || [],
    text: truncateText(execution.response?.content?.[0]?.text || "", 12000),
  };
  return result;
}

async function finalizePipelineSourceCleanup(record, { dryRun = false, authorizeCleanup = null } = {}) {
  const cleanupPlan = [];
  for (const item of record.integrationQueue || []) {
    if (!item.cleanupRequested || !item.worktreePath) continue;
    if (dryRun) {
      cleanupPlan.push({ result: { worktreePath: item.worktreePath, cleanup: "skipped_dry_run" } });
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

async function finalizePipelineRecord(record, { skipReviewers = false, dryRun = false, beforeFinalValidationHook = null } = {}) {
  await refreshPipelineRecord(record);
  const now = new Date().toISOString();
  const events = (record.events || []).concat({
    type: "finalization_started",
    at: now,
    dryRun,
    skipReviewers,
  });

  if (["failed", "cancelled"].includes(record.status)) {
    await updatePipelineRecord(record, {
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
    await updatePipelineRecord(record, {
      status: record.status === "planned" ? "planned" : "awaiting_integration",
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

  if (skipReviewers && (record.reviewerJob || record.testerJob)) {
    await updatePipelineRecord(record, {
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
    await updatePipelineRecord(record, {
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
    await updatePipelineRecord(record, {
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
      await updatePipelineRecord(record, {
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

  await updatePipelineRecord(record, { status: "finalizing", events });
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
      else finalValidationBeforeFiles = await gitChangedFileSnapshot(record.cwd);
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
        });
  let finalValidationAfterState = finalValidationBeforeState;
  let finalValidationMutationFiles = [];
  if (!record.sanitizedWorkspace && !dryRun && !finalValidationEvidenceError) {
    try {
      finalValidationAfterState = await captureIntegrationTargetState(record.cwd);
      const finalValidationAfterFiles = await gitChangedFileSnapshot(record.cwd);
      finalValidationMutationFiles = changedFilesBetween(finalValidationBeforeFiles, finalValidationAfterFiles);
      const stateChanged = !finalValidationAfterState.ok
        || finalValidationAfterState.targetStateSha256 !== finalValidationBeforeState.targetStateSha256;
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

  const reviewerResult = skipReviewers ? null : await runPipelineReadOnlyGate(record, "reviewer", record.reviewerJob);
  if (reviewerResult?.status === "failed") {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      errors: (record.errors || []).concat({
        type: "reviewer",
        errorType: reviewerResult.errorType,
        error: "Reviewer gate failed.",
      }),
    });
    return {
      ok: false,
      errorType: reviewerResult.errorType || "reviewer_gate_failed",
      error: "Reviewer gate failed.",
      record,
    };
  }

  const testerResult = skipReviewers ? null : await runPipelineReadOnlyGate(record, "tester", record.testerJob);
  if (testerResult?.status === "failed") {
    await updatePipelineRecord(record, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      finalValidationResult,
      reviewerResult,
      testerResult,
      errors: (record.errors || []).concat({
        type: "tester",
        errorType: testerResult.errorType,
        error: "Tester gate failed.",
      }),
    });
    return {
      ok: false,
      errorType: testerResult.errorType || "tester_gate_failed",
      error: "Tester gate failed.",
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
    if (!beforeCleanupState.ok || beforeCleanupState.targetStateSha256 !== finalValidationAfterState.targetStateSha256) {
      await updatePipelineRecord(record, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        finalValidationResult,
        reviewerResult,
        testerResult,
        errors: (record.errors || []).concat({
          type: "finalization",
          errorType: "pipeline_target_changed_before_cleanup",
          error: "Pipeline target changed after final validation/gates and before source cleanup.",
        }),
      });
      return { ok: false, errorType: "pipeline_target_changed_before_cleanup", error: "Pipeline target changed before cleanup; source worktrees were retained.", record };
    }
  }

  const sanitizedWorkspaceAttestation = record.sanitizedWorkspace ? {
    ...(record.sanitizedWorkspaceAttestation || {}),
    beforeFinalGates: sanitizedBeforeFinalGates,
    afterAllWaves: sanitizedFinal,
  } : null;
  const sourceCleanupResults = await finalizePipelineSourceCleanup(record, {
    dryRun,
    authorizeCleanup: async (authorizationResults, authorizations) => {
      await updatePipelineRecord(record, {
        status: "completed",
        finishedAt: record.finishedAt || new Date().toISOString(),
        finalValidationResult,
        reviewerResult,
        testerResult,
        sanitizedWorkspaceAttestation,
        sourceCleanupResults: authorizationResults,
        cleanupPending: authorizations.length > 0,
        events: (record.events || []).concat({
          type: "finalization_completed",
          at: new Date().toISOString(),
          cleanupPending: authorizations.length > 0,
        }, {
          type: "source_cleanup_authorized",
          at: new Date().toISOString(),
          targetStateSha256: finalValidationAfterState?.targetStateSha256 || "",
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
  await updatePipelineRecord(record, {
    status: "completed",
    finishedAt: record.finishedAt || new Date().toISOString(),
    finalValidationResult,
    reviewerResult,
    testerResult,
    sanitizedWorkspaceAttestation,
    sourceCleanupResults,
    cleanupPending: false,
    events: (record.events || []).concat(
      (record.events || []).some((event) => event.type === "finalization_completed") ? [] : [{
        type: "finalization_completed",
        at: new Date().toISOString(),
        cleanupPending: false,
      }],
      [{
        type: "source_cleanup_completed",
        at: new Date().toISOString(),
      }]
    ),
  });

  return { ok: true, record };
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

server.tool(
  "run_opencode_parallel",
  "Run multiple OpenCode agents in parallel. Use only for safe independent tasks.",
  {
    jobs: z.array(
      z.object({
        agent: z.string(),
        task: z.string(),
        cwd: z.string().optional(),
        allowFallbackToBuild: z.boolean().optional(),
        subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional().describe("OpenCode orchestrator MCP mode. Contractor requires explicit per-task user authorization; bounded-writer is retained only for compatibility and is rejected."),
        userAuthorizedOrchestrator: z.boolean().optional().describe("Set true only when the user explicitly requested the OpenCode Orchestrator by name for this task."),
        contractorAuthorizationToken: z.string().optional().describe("Secret contractor capability; required with the explicit user flag and never returned or persisted."),
        role: z.string().optional().describe("Optional Scope Contract role label."),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
        scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
        actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
        validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
        timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
        scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
        dryRun: z.boolean().optional(),
        write: z.boolean().optional().describe("Whether this job may edit files. Required for explicit write planning."),
        lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
        lockType: z.string().optional().describe("read, write, or serial_integration. serial_integration is rejected in parallel."),
        timeoutMs: z.number().int().positive().optional().describe("Optional per-job timeout in milliseconds."),
        lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner. Use concrete file or directory paths."),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        serialOnly: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        sanitizedWorkspace: sanitizedWorkspaceSchema.optional(),
        delegation: z
          .object({
            scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
            role: z.string().optional(),
            mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
            actions: z.array(z.string()).optional(),
            validation: scopeValidationSchema.optional(),
            timeoutPolicy: scopeTimeoutPolicySchema.optional(),
            scopeContract: scopeContractSchema.optional(),
            lockMode: z.string().optional(),
            lockType: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
            orchestratorMode: z.enum(["planning-only", "contractor", "bounded-writer"]).optional(),
            userAuthorizedOrchestrator: z.boolean().optional(),
            contractorAuthorizationToken: z.string().optional(),
            lockedPaths: z.array(z.string()).optional(),
            allowedEdits: z.array(z.string()).optional(),
            forbiddenEdits: z.array(z.string()).optional(),
            sharedFiles: z.array(z.string()).optional(),
            serialOnly: z.array(z.string()).optional(),
            permissions: z.string().optional(),
            validationCommand: z.string().optional(),
            returnFormat: z.string().optional(),
          })
          .optional(),
      })
    ).min(1),
  },
  async ({ jobs }) => {
    jobs = await Promise.all(jobs.map((job) => normalizeJobCwd(job)));
    const toolStarted = nowMs();
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
      if (jobs[index].dryRun) continue;
      if (jobs[index].sanitizedWorkspace) continue;
      const gitState = await verifyProtectedGitRoot(jobs[index].cwd);
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
              suggestedFix: "Run every non-dry-run job inside a Git repository.",
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
      const resolution = await resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "reject",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT,
        lockPlan.orchestratorMode,
        discoveryContext
      );
      const routingError = resolution.error ? { errorType: "agent_routing_error", error: resolution.error } : readOnlyRoutingPolicyError(resolution, lockPlan);
      const metadata = resolution.error ? null : await readAgentDebugMetadata(resolution.actualAgent, discoveryCwd, { forcePure });
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

    const acquiredLocks = [];
    const acquiredLockHeartbeats = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const shouldAcquireLock = !job.dryRun && lockPlan.lockType !== "read";

      if (!shouldAcquireLock) {
        acquiredLocks[index] = null;
        continue;
      }

      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: lockPlan.agent,
        task: lockPlan.task,
        cwd: job.cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: lockPlan.lockType === "read" ? lockPlan.lockedPaths : hardLockPathsForPlan(lockPlan),
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
                  errorType: "write_lock_conflict",
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
        jobId: makeQueueJobId(lockPlan.agent),
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
                conflictingPaths: dirtyDetails.conflictingPaths,
                dirtyFiles: dirtyDetails.dirtyFiles,
                overlappingFiles: dirtyDetails.overlappingFiles,
                disjointFiles: dirtyDetails.disjointFiles,
                suggestedFix: "Create/select a clean reproducible checkpoint, choose a safe worktree root, and ensure this cwd is a Git repository with git available.",
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
      const finalMetadata = await readAgentDebugMetadata(resolution.actualAgent, executionCwd, { forcePure });
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
    try {
      for (const cwdKey of cwdKeys) {
        const needsGitSnapshot = jobs.some((job, index) => path.resolve(executionCwdForIndex(index)) === cwdKey && !job.dryRun && !job.sanitizedWorkspace);
        if (needsGitSnapshot) parallelSnapshottedCwds.add(cwdKey);
        parallelBefore.set(cwdKey, needsGitSnapshot ? await gitChangedFileSnapshot(cwdKey) : new Map());
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
    const groupDeadlineMs = Math.max(...lockPlans.map((plan) => timeoutForAgent(plan.agent, plan, plan.timeoutMs))) + 1000 * 60;
    let groupDeadlineExpired = false;
    const groupDeadlineTimer = setTimeout(() => {
      groupDeadlineExpired = true;
      groupController.abort("parallel_group_deadline");
    }, groupDeadlineMs);
    try {
      const executionPromises = jobs.map(async (job, index) => {
        const lockPlan = lockPlans[index];
        const jobStartedAtMs = nowMs();
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
              text: formatRejectedExecution({
                headline: "Sanitized workspace changed between preflight and the parallel wave.",
                errorType: verification.errorType,
                reason: verification.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: resolution.actualAgent,
                conflictingPaths: verification.discrepancies?.map((item) => item.path) || [],
                suggestedFix: "Retain the workspace for investigation and rebuild it from the trusted manifest.",
              }),
            };
          }
        }
        const beforeFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd);
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
        };

        let prompt = buildCompactPrompt(resolution.requestedAgent, job.task, delegation);
        if (resolution.proxyUsed) {
          prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
        }
        const result = await runOpenCodeWithPolicy(
          resolution.actualAgent,
          prompt,
          executionCwd,
          job.dryRun || false,
          lockPlan,
          lockPlan.timeoutMs,
          { signal: groupController.signal, agentMetadata: parallelAgentMetadata[index] }
        );
        const afterFiles = job.dryRun || manifestProtected ? new Map() : await gitChangedFileSnapshot(executionCwd);
        const executionHeadAfterAgent = job.dryRun || manifestProtected ? "" : await captureGitHead(executionCwd);
        const sanitizedAfter = manifestProtected && !job.dryRun
          ? await verifySanitizedWorkspace(job.sanitizedWorkspace, "after_wave")
          : null;
        result.changedFiles = sanitizedAfter && !sanitizedAfter.ok
          ? normalizeLockPathList((sanitizedAfter.discrepancies || []).map((item) => item.path))
          : changedFilesBetween(beforeFiles, afterFiles);
        const expectedExecutionHead = parallelHeadBefore.get(path.resolve(executionCwd)) || "";
        if (executionHeadAfterAgent && executionHeadAfterAgent !== expectedExecutionHead) {
          result.errorType ||= "repository_head_changed_during_execution";
          result.stderr = [result.stderr, "Repository HEAD changed during parallel execution. The change is unattributed and the worktree/output was retained."].filter(Boolean).join("\n");
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
        const validationGate = !unsafeFiles.length && !result.errorType
          ? await runValidationGate({ command: lockPlan.validationCommand, cwd: executionCwd, dryRun: job.dryRun || false, timeoutMs: CONFIG.validationCommandTimeoutMs })
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
        const afterValidationFiles = job.dryRun || manifestProtected ? afterFiles : await gitChangedFileSnapshot(executionCwd);
        const executionHeadAfterValidation = job.dryRun || manifestProtected ? executionHeadAfterAgent : await captureGitHead(executionCwd);
        const validationMutationFiles = job.dryRun || manifestProtected ? [] : changedFilesBetween(afterFiles, afterValidationFiles);
        if (executionHeadAfterValidation && executionHeadAfterValidation !== expectedExecutionHead) {
          result.errorType ||= "repository_head_changed_during_execution";
          result.executionHeadAfter = executionHeadAfterValidation;
        }
        if (validationMutationFiles.length) {
          result.changedFiles = changedFilesBetween(beforeFiles, afterValidationFiles);
          const postValidation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: true });
          unsafeFiles = normalizeLockPathList(postValidation.disallowedFiles.concat(validationMutationFiles));
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
        if (worktree) {
          result.worktree = {
            path: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
            baseTree: worktree.baseTree,
            patchSha256: worktreeDiff?.patchSha256 || "",
            sourceStateSha256: worktreeDiff?.sourceStateSha256 || "",
            cleanup: "retained_for_review",
            changedFiles: worktreeDiff?.changedFiles || [],
            diffStat: worktreeDiff?.diffStat || "",
          };
        }
        return {
          index,
          lockPlan,
          result,
          startedAtMs: jobStartedAtMs,
          finishedAtMs: nowMs(),
          text: [
          `JOB ${index + 1}`,
          `Temporary lock acquired: ${hardLockSummary(acquiredLocks[index])}`,
          formatSingleResult({
            resolution,
            result,
            cwd: executionCwd,
            lockPlan,
          }),
          formatWorktreeSummary(worktree, null),
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : null,
          formatValidationGateResult(validationGate),
          `Unsafe changed files: ${unsafeFiles.length ? unsafeFiles.join(", ") : "none detected"}`,
          ].filter(Boolean).join("\n"),
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
      for (const cwdKey of cwdKeys) {
        if (!parallelSnapshottedCwds.has(cwdKey)) continue;
        const after = await gitChangedFileSnapshot(cwdKey);
        const afterHead = await captureGitHead(cwdKey);
        const expectedHead = parallelHeadBefore.get(cwdKey) || "";
        const headChanged = afterHead !== expectedHead;
        if (headChanged) {
          for (const jobResult of results.filter((_, index) => path.resolve(executionCwdForIndex(index)) === cwdKey)) {
            jobResult.result.errorType ||= "repository_head_changed_during_execution";
            jobResult.result.executionHeadBefore = expectedHead;
            jobResult.result.executionHeadAfter = afterHead;
          }
        }
        const changedFiles = changedFilesBetween(parallelBefore.get(cwdKey) || new Map(), after);
        const plansForCwd = lockPlans.filter((_, index) => path.resolve(executionCwdForIndex(index)) === cwdKey);
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
        parallelRollbackReports.push({
          cwd: cwdKey,
          headChanged,
          expectedHead,
          actualHead: afterHead,
          changedFiles,
          disallowedFiles,
          serialOnlyMatches,
          ...rollbackResult,
        });
      }
    } finally {
      clearTimeout(groupDeadlineTimer);
      acquiredLockHeartbeats.forEach((stop) => stop?.());
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
    }

    const lockViolations = verifyParallelLockResults(results);
    const parallelSuccess = !lockViolations.length
      && !parallelRollbackReports.some((report) => report.disallowedFiles.length)
      && !results.some((jobResult) => jobResult.result?.errorType);
    const executionOverlap = parallelExecutionOverlapEvidence(results);
    const ranConcurrently = executionOverlap.ranConcurrently;
    const groupStatus = parallelSuccess
      ? "completed"
      : results.some((item) => !item.result?.errorType) ? "partial_failed" : groupDeadlineExpired ? "cancelled_or_timed_out" : "failed";
    const parallelWorktreeCleanupReports = parallelWorktrees
      .map((worktree, index) => ({ worktree, index }))
      .filter(({ worktree }) => Boolean(worktree))
      .map(({ worktree, index }) => ({
        index,
        path: worktree.path,
        branch: worktree.branch,
        cleanup: "retained_for_review",
        reason: parallelSuccess
          ? "successful output awaits reviewed serial integration"
          : "partial or failed batch output is retained for diagnosis and recovery",
      }));
    const verification = [
      "Parallel lock verification:",
      lockViolations.length
        ? "Rejected. Do not accept these parallel results; move to serial integration/recovery."
        : "Accepted. All detected changed files stayed inside assigned locks.",
      lockViolations.length ? lockViolations.map((violation) => `- ${violation}`).join("\n") : "- No lock violations detected.",
    ].join("\n");
    const rollbackVerification = [
      "Parallel rollback verification:",
      parallelRollbackReports.some((report) => report.disallowedFiles.length)
        ? "Rejected. Disallowed changed files were detected and rollback was attempted."
        : "Accepted. No disallowed changed files detected at group scope.",
      ...parallelRollbackReports.map((report) =>
        [
          `Workspace: ${report.cwd}`,
          `Changed files: ${report.changedFiles.length ? report.changedFiles.join(", ") : "none detected"}`,
          `HEAD changed: ${report.headChanged ? `yes (${report.expectedHead} -> ${report.actualHead})` : "no"}`,
          `Disallowed files: ${report.disallowedFiles.length ? report.disallowedFiles.join(", ") : "none detected"}`,
          `Serial-only matches: ${report.serialOnlyMatches.length ? report.serialOnlyMatches.join(", ") : "none detected"}`,
          `Rollback: ${report.rollback}`,
          `Rollback files: ${report.rollbackFiles.length ? report.rollbackFiles.join(", ") : "none"}`,
          `Unresolved files: ${report.unresolvedFiles.length ? report.unresolvedFiles.join(", ") : "none"}`,
        ].join("\n")
      ),
    ].join("\n");
    const worktreeCleanupVerification = [
      "Parallel worktree cleanup:",
      parallelWorktreeCleanupReports.length ? "All writer worktrees were retained for review." : "No worktrees used.",
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
            `Ran concurrently (OpenCode child interval overlap): ${ranConcurrently ? "yes" : "no"}`,
            `Concurrent execution pairs: ${executionOverlap.pairs.length ? executionOverlap.pairs.map(([left, right]) => `JOB ${left + 1} + JOB ${right + 1}`).join(", ") : "none"}`,
            "Cancellation: this synchronous tool has no durable operation id; use queue/pipeline tools when cancellation or restart-safe status is required.",
            verification,
            rollbackVerification,
            worktreeCleanupVerification,
            ...results.map((result) => result.text),
          ].join("\n\n====================\n\n"),
        },
      ],
    };
  }
);

async function runSelfTests() {
  const selfTestProgress = (stage) => console.log(`[${new Date().toISOString()}] self-test: ${stage}`);
  selfTestProgress("start");
  selfTestProgress("core validation/security");
  const previewTimingFixture = makeIntegrationPreviewReceipt({
    patch: {
      patchSha256: "a".repeat(64),
      sourceBaseCommit: "b".repeat(40),
      sourceStateSha256: "c".repeat(64),
    },
    targetState: {
      targetHead: "d".repeat(40),
      targetStateSha256: "e".repeat(64),
    },
    contractSha256: "f".repeat(64),
  });
  assert.equal(
    Date.parse(previewTimingFixture.expiresAt) - Date.parse(previewTimingFixture.createdAt),
    INTEGRATION_PREVIEW_TTL_MS
  );
  INTEGRATION_PREVIEWS.delete(previewTimingFixture.previewId);
  assert.equal(transientGitIndexReadError({ stderr: "fatal: .git/index: index file open failed: Permission denied" }), true);
  assert.equal(transientGitIndexReadError({ stderr: "fatal: not a git repository" }), false);
  let gitIndexReadAttempts = 0;
  const retriedGitIndexRead = await runGitReadOnlyCommand(["diff", "--cached", "--name-only"], process.cwd(), 1000, async () => {
    gitIndexReadAttempts += 1;
    return gitIndexReadAttempts < 3
      ? { exitCode: 1, stdout: "", stderr: "fatal: .git/index: index file open failed: Permission denied" }
      : { exitCode: 0, stdout: "", stderr: "" };
  });
  assert.equal(retriedGitIndexRead.exitCode, 0);
  assert.equal(gitIndexReadAttempts, 3);
  assert.deepEqual(parallelExecutionOverlapEvidence([
    { result: { childExecutionIntervals: [{ startedAtMs: 10, finishedAtMs: 20 }] } },
    { result: { childExecutionIntervals: [{ startedAtMs: 20, finishedAtMs: 30 }] } },
  ]), { ranConcurrently: false, pairs: [] });
  assert.deepEqual(parallelExecutionOverlapEvidence([
    { result: { childExecutionIntervals: [{ startedAtMs: 10, finishedAtMs: 25 }] } },
    { result: { childExecutionIntervals: [{ startedAtMs: 20, finishedAtMs: 30 }] } },
  ]), { ranConcurrently: true, pairs: [[0, 1]] });
  let independentSiblingCompleted = false;
  const independentSettled = await settleIndependentParallelJobs([
    Promise.reject(new Error("parallel infrastructure self-test")),
    new Promise((resolve) => setImmediate(() => {
      independentSiblingCompleted = true;
      resolve("sibling completed");
    })),
  ]);
  assert.equal(independentSettled[0].status, "rejected");
  assert.equal(independentSettled[1].status, "fulfilled");
  assert.equal(independentSiblingCompleted, true);
  assert.deepEqual(
    directExecutionLockConflictDetails({ conflict: { origin: "internal" } }),
    {
      headline: "Write job is waiting for an active writer.",
      errorType: "write_lock_conflict",
      suggestedFix: "Wait for the active writer to finish, retry later, or choose a non-overlapping lockedPaths scope.",
    }
  );
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "manual" } }).errorType, "manual_lock_misuse");
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "legacy" } }).errorType, "manual_lock_misuse");
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "internal" } }, true).errorType, "queue_lock_conflict");
  const disjointDirtyDetails = dirtyCheckpointDetails({
    dirtyFiles: ["src/disjoint.txt"],
    overlappingFiles: [],
    disjointFiles: ["src/disjoint.txt"],
  });
  assert.deepEqual(disjointDirtyDetails.conflictingPaths, ["src/disjoint.txt"]);
  const mixedDirtyDetails = dirtyCheckpointDetails({
    dirtyFiles: ["src/allowed.txt", "src/disjoint.txt"],
    overlappingFiles: ["src/allowed.txt"],
    disjointFiles: ["src/disjoint.txt"],
  });
  assert.deepEqual(mixedDirtyDetails.conflictingPaths, ["src/allowed.txt"]);
  const dirtyRejectionText = formatRejectedExecution({
    conflictingPaths: mixedDirtyDetails.conflictingPaths,
    dirtyFiles: mixedDirtyDetails.dirtyFiles,
    overlappingFiles: mixedDirtyDetails.overlappingFiles,
    disjointFiles: mixedDirtyDetails.disjointFiles,
  });
  assert.match(dirtyRejectionText, /dirtyFiles: src\/allowed\.txt, src\/disjoint\.txt/);
  assert.match(dirtyRejectionText, /overlappingFiles: src\/allowed\.txt/);
  assert.match(dirtyRejectionText, /disjointFiles: src\/disjoint\.txt/);
  const managedSkillFixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-managed-skill-self-test-"));
  const managedSkillSourceRoot = path.join(managedSkillFixtureRoot, "managed-skill-source");
  const managedSkillConfigRoot = path.join(managedSkillFixtureRoot, "managed-skill-config");
  const managedSkillEffectiveRoot = path.join(managedSkillConfigRoot, "skills");
  const managedSkillDebug = [];
  for (const skill of REQUIRED_MANAGED_SKILLS) {
    const sourcePath = path.join(managedSkillSourceRoot, skill, "SKILL.md");
    const effectivePath = path.join(managedSkillEffectiveRoot, skill, "SKILL.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(effectivePath), { recursive: true });
    await writeFile(sourcePath, `${skill}\n`, "utf8");
    await writeFile(effectivePath, `${skill}\n`, "utf8");
    managedSkillDebug.push({ name: skill, location: effectivePath, content: `${skill}\n` });
  }
  managedSkillDebug.push({ name: "customize-opencode", location: "<built-in>", content: "built in" });
  assert.equal(await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  }), null);
  assert.equal(await managedSkillPolicyError(MCP_ORCHESTRATOR_AGENT, {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
    metadata: { skillDenied: false },
  }), null);
  assert.equal(await managedSkillPolicyError(MCP_CONTRACTOR_ORCHESTRATOR_AGENT, {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: null,
    metadata: { skillDenied: true },
  }), null);
  await writeFile(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "SKILL.md.bak"), "ignored backup\n", "utf8");
  assert.equal(await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  }), null);
  await writeFile(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "unexpected.txt"), "unexpected\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await rm(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "unexpected.txt"), { force: true });
  await writeFile(path.join(managedSkillEffectiveRoot, "builder-safety", "SKILL.md"), "mutated\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await writeFile(path.join(managedSkillEffectiveRoot, "builder-safety", "SKILL.md"), "builder-safety\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: [...managedSkillDebug, { ...managedSkillDebug[0] }],
  })).errorType, "managed_skill_integrity_failed");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug.map((skill) => skill.name === "builder-safety"
      ? { ...skill, location: path.join(managedSkillFixtureRoot, "alternate-skills", "builder-safety", "SKILL.md") }
      : skill),
  })).errorType, "managed_skill_integrity_failed");
  const linkedManagedSkill = path.join(managedSkillEffectiveRoot, "linked-skill");
  await symlink(
    path.join(managedSkillSourceRoot, "builder-safety"),
    linkedManagedSkill,
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await rm(linkedManagedSkill, { recursive: true, force: true });
  await rm(managedSkillFixtureRoot, { recursive: true, force: true });
  const sanitizedPolicyFixture = { root: "sanitized" };
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, subagentStrategy: "direct" }).errorType, "sanitized_workspace_subagent_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, validationCommand: "git status --short" }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, scopeContract: { validationCommand: "git diff --check" } }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, delegation: { validationCommand: "git status --short" } }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, subagentStrategy: "reject" }), null);
  assert.deepEqual(sanitizedDiscoveryContext({ cwd: "sensitive-data", sanitizedWorkspace: sanitizedPolicyFixture }), {
    forcePure: true,
    routeToSanitizedAgent: true,
    discoveryCwd: "sensitive-data",
  });
  assert.deepEqual(sanitizedDiscoveryContext({ cwd: "ordinary-repo" }), {
    forcePure: false,
    routeToSanitizedAgent: false,
    discoveryCwd: "ordinary-repo",
  });
  assert.equal(shouldUseWorktree({ dryRun: false, sanitizedWorkspace: sanitizedPolicyFixture }, { lockType: "read", sanitizedWorkspace: sanitizedPolicyFixture }, "all"), false);
  assert.equal(REQUIRED_MANAGED_AGENTS.includes(MCP_SANITIZED_READER_AGENT), true);
  assert.equal(GLOBALLY_REQUIRED_MANAGED_AGENTS.includes(MCP_SANITIZED_READER_AGENT), false);
  const sanitizedAgentSource = await readFile(path.join(BRIDGE_RUNTIME_DIR, "opencode", "agents", `${MCP_SANITIZED_READER_AGENT}.md`), "utf8");
  assert.equal(sanitizedAgentSource.split(/^---\s*$/m).slice(2).join("---").trim(), MCP_SANITIZED_READER_PROMPT);
  const sanitizedRouteFixture = {
    requestedAgent: "reviewer",
    actualAgent: MCP_SANITIZED_READER_AGENT,
    actualAgentMode: "all",
    proxyUsed: false,
    fallbackUsed: false,
  };
  assert.equal(sanitizedRoutingPolicyError(
    { sanitizedWorkspace: { root: "sensitive-data" } },
    sanitizedRouteFixture,
    path.resolve("sensitive-data")
  ), null);
  assert.equal(sanitizedRoutingPolicyError(
    { sanitizedWorkspace: { root: "sensitive-data" } },
    { ...sanitizedRouteFixture, actualAgent: "reviewer" },
    path.resolve("sensitive-data")
  ).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedSafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, edit: false, write: false, task: false, bash: true, webfetch: true, websearch: true, skill: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "*", action: "deny" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: sanitizedSafeMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_SANITIZED_READER_AGENT, expectedMode: "all" }
  ), null);
  const sanitizedMetadataRoot = path.resolve("sensitive-data");
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedSafeMetadata }, sanitizedMetadataRoot), null);
  const sanitizedRuntimeRoot = path.join(tmpdir(), `codex-opencode-sanitized-${process.pid}-metadata-fixture`);
  const sanitizedRootToolOutputMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, edit: false, write: false, task: false, bash: true, webfetch: true, websearch: true, skill: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: `${path.join(sanitizedRuntimeRoot, "opencode", "tool-output")}\\*`, action: "allow" },
      { permission: "external_directory", pattern: `${path.join(sanitizedRuntimeRoot, "tmp", "opencode")}\\*`, action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "*", action: "deny" },
    ],
  }, MCP_SANITIZED_READER_AGENT, { isolatedRuntimeRoot: sanitizedRuntimeRoot });
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedRootToolOutputMetadata, isolatedRuntimeRoot: sanitizedRuntimeRoot }, sanitizedMetadataRoot), null);
  const sanitizedSharedTempMetadata = {
    ...sanitizedRootToolOutputMetadata,
    externalAllowedPatterns: [`${path.join(tmpdir(), "opencode")}\\*`],
  };
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedSharedTempMetadata, isolatedRuntimeRoot: sanitizedRuntimeRoot }, sanitizedMetadataRoot).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedGlobalToolOutputMetadata = {
    ...sanitizedRootToolOutputMetadata,
    externalAllowedPatterns: [`${path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output")}\\*`],
  };
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedGlobalToolOutputMetadata }, sanitizedMetadataRoot).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedBashUnsafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedBashUnsafeMetadata }).errorType, "sanitized_workspace_agent_unsafe");
  const shadowedPermissionFixture = {
    name: "reviewer",
    mode: "all",
    model: { providerID: "provider", modelID: "model" },
    variant: "high",
    temperature: 0,
    tools: { apply_patch: false, edit: false, task: false },
  };
  const shadowedPermissionA = normalizeAgentDebugMetadata({
    ...shadowedPermissionFixture,
    permission: [
      { permission: "external_directory", pattern: path.join("skills", "a", "*"), action: "allow" },
      { permission: "external_directory", pattern: path.join("skills", "b", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  const shadowedPermissionB = normalizeAgentDebugMetadata({
    ...shadowedPermissionFixture,
    permission: [
      { permission: "external_directory", pattern: path.join("skills", "b", "*"), action: "allow" },
      { permission: "external_directory", pattern: path.join("skills", "a", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  assert.equal(shadowedPermissionA.permissionRulesSha256, shadowedPermissionB.permissionRulesSha256);
  assert.equal(shadowedPermissionA.permissionProfileSha256, shadowedPermissionB.permissionProfileSha256);
  const sanitizedWebUnsafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, task: false, bash: false, webfetch: true, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "allow" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedWebUnsafeMetadata }).errorType, "sanitized_workspace_agent_unsafe");
  const flattenedReviewerMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: path.join(tmpdir(), "opencode", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git status --short", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: `${path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output")}\\*`, action: "allow" },
    ],
  }, "reviewer");
  assert.equal(flattenedReviewerMetadata.externalDirectoryDenied, true);
  assert.equal(flattenedReviewerMetadata.bashAutomaticAllowSafe, true);
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: flattenedReviewerMetadata }, { lockType: "read" }), null);
  const unsafeTrailingExternalMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: false, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: path.join(tmpdir(), "secret", "*"), action: "allow" },
    ],
  }, "reviewer");
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: unsafeTrailingExternalMetadata }, { lockType: "read" }).errorType, "agent_permissions_unsafe");
  const unsafeWriterMetadata = normalizeAgentDebugMetadata({
    name: "builder",
    mode: "all",
    model: { providerID: "google", modelID: "writer-model" },
    variant: "high",
    tools: { apply_patch: true, task: true, bash: true, webfetch: true, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  }, "builder");
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: unsafeWriterMetadata }, { lockType: "write" }).errorType, "agent_permissions_unsafe");
  const managedWriterFixture = (protectedPatterns = DEFAULT_FORBIDDEN_EDIT_PATHS, bashDefaultAction = "deny") => normalizeAgentDebugMetadata({
    name: "builder",
    mode: "all",
    model: { providerID: "google", modelID: "writer-model" },
    variant: "high",
    tools: { apply_patch: true, edit: true, write: true, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "edit", pattern: "*", action: "allow" },
      ...protectedPatterns.map((pattern) => ({ permission: "edit", pattern, action: "deny" })),
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: bashDefaultAction },
      { permission: "bash", pattern: "git status --short", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
    ],
  }, "builder");
  const safeManagedWriterMetadata = managedWriterFixture();
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: safeManagedWriterMetadata }, { lockType: "write" }), null);
  const interactiveNestedWriterMetadata = managedWriterFixture(DEFAULT_FORBIDDEN_EDIT_PATHS, "ask");
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: interactiveNestedWriterMetadata }).errorType, "contractor_nested_agent_permissions_unsafe");
  const missingProtectedWriterMetadata = managedWriterFixture(DEFAULT_FORBIDDEN_EDIT_PATHS.filter((pattern) => pattern !== "*.pem"));
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: missingProtectedWriterMetadata }, { lockType: "write" }).errorType, "agent_permissions_unsafe");
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: flattenedReviewerMetadata },
    { lockType: "read" },
    { expectedAgent: "reviewer", expectedMode: "primary" }
  ).errorType, "agent_mode_unattested");
  const changedReviewerMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "git diff", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: changedReviewerMetadata },
    { lockType: "read" },
    { expectedAgent: "reviewer", expectedMode: "all", expectedMetadata: flattenedReviewerMetadata }
  ).errorType, "agent_metadata_changed");
  const contractorMetadataFixture = (extraTaskRules = [], bash = false, skill = false) => normalizeAgentDebugMetadata({
    name: MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: true, bash, skill, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      ...[...CONTRACTOR_ALLOWED_SUBAGENTS].map((agent) => ({ permission: "task", pattern: agent, action: "allow" })),
      ...extraTaskRules,
    ],
  }, MCP_CONTRACTOR_ORCHESTRATOR_AGENT);
  const safeContractorMetadata = contractorMetadataFixture();
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: safeContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ), null);
  const shellEnabledContractorMetadata = contractorMetadataFixture([], true);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: shellEnabledContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const skillEnabledContractorMetadata = contractorMetadataFixture([], false, true);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: skillEnabledContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const wildcardContractorMetadata = contractorMetadataFixture([{ permission: "task", pattern: "*", action: "allow" }]);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: wildcardContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const managedSourceFixture = managedAgentSourceProfile([
    "---",
    "mode: all",
    "model: openai/gpt-5.6-terra",
    "variant: high",
    "temperature: 0",
    "---",
    "Exact managed prompt.",
  ].join("\n"), "managed-fixture");
  assert.deepEqual(managedSourceFixture, {
    name: "managed-fixture",
    mode: "all",
    provider: "openai",
    model: "gpt-5.6-terra",
    variant: "high",
    temperature: 0,
    promptSha256: createHash("sha256").update("Exact managed prompt.").digest("hex"),
  });
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: safeManagedWriterMetadata }), null);
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: unsafeWriterMetadata }).errorType, "contractor_nested_agent_permissions_unsafe");
  assert.equal(contractorNestedAgentMetadataError("reviewer", { ok: true, metadata: flattenedReviewerMetadata }), null);
  assert.equal(providerErrorTypeFromText("429 RESOURCE_EXHAUSTED rateLimitExceeded"), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromText("daily project quota exceeded"), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("OAuth invalid_grant: refresh token revoked"), "opencode_auth_error");
  assert.equal(providerErrorTypeFromText("HTTP 503 service unavailable"), "opencode_provider_unavailable");
  assert.equal(providerErrorTypeFromText("read ECONNRESET"), "opencode_transport_error");
  assert.equal(providerErrorTypeFromText("HTTP 403 rateLimitExceeded"), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromText("HTTP 403"), "");
  assert.equal(providerErrorTypeFromText("Error in src/billing/formatter.js"), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "fixture contains billing error handling" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "Assertion text: 429 rate limit expected" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "Source note: model unavailable branch" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { statusCode: 429, code: "rateLimitExceeded", message: "request rejected" } }), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { name: "CreditsError", message: "No payment method" } }), "opencode_billing_error");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "ProviderAuthError", data: { providerID: "google", message: "invalid API key" } } },
  }), "opencode_auth_error");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "APIError", data: { message: "service unavailable", statusCode: 503, isRetryable: true } } },
  }), "opencode_provider_unavailable");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } },
  }), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "error",
    error: { name: "ModelValidationError", message: "Local fixture says model unavailable" },
  }), "");
  assert.equal(retryAfterMsFromText('{"retryAfterMs":1500}'), 1500);
  assert.equal(retryAfterMsFromText('{"retryAfter":"2.5"}'), 2500);
  assert.equal(retryAfterMsFromText('RetryInfo retryDelay: "12s"'), 12000);
  const retryDateBase = Date.parse("2026-08-09T00:00:00.000Z");
  assert.equal(retryAfterMsFromText("Retry-After: Sun, 09 Aug 2026 00:00:05 GMT", retryDateBase), 5000);
  assert.equal(validationCommandTrustError(["cmd", "/c", "echo", "unsafe"]).length > 0, true);
  assert.equal(validationCommandTrustError(["node", "-e", "process.exit(0)"]).length > 0, true);
  assert.equal(validationCommandTrustError(["git", "status"]), "");
  assert.equal(validationCommandTrustError(["git", "diff", "--check", "--", "src"], { strictProjectPolicy: true }), "");
  assert.match(validationCommandTrustError(["git", "diff", "--check", "HEAD", "HEAD"], { strictProjectPolicy: true }), /before --/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--no-index", "--", "src"], { strictProjectPolicy: true }), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--output=outside.txt"], { strictProjectPolicy: true }), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--output=outside.txt"]), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--", "../secret"], { strictProjectPolicy: true }), /unsafe/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--", "C:secret"], { strictProjectPolicy: true }), /unsafe/);
  assert.match(validationCommandTrustError(parseCommandLine("git status ; node malicious.js"), { strictProjectPolicy: true }), /bounded porcelain/);
  assert.equal(exactPluginSpecifier("@scope/plugin@1.2.3"), "@scope/plugin@1.2.3");
  assert.equal(exactPluginSpecifier("@scope/plugin@latest"), "");
  assert.equal(exactPluginSpecifier("plugin@^1.2.3"), "");
  assert.deepEqual(pluginSpecsFromConfigText('{"pl\\u0075gin" /* pinned */ : ["plugin@1.2.3",],}'), ["plugin@1.2.3"]);
  assert.throws(() => pluginSpecsFromConfigText('{"plugin": ["plugin@1.2.3"], "pl\\u0075gin": []}'), /duplicate property/i);
  const readOnlyMetadataFixture = {
    name: "planner",
    mode: "primary",
    model: { providerID: "google", modelID: "test-model" },
    permission: [{ permission: "external_directory", pattern: "*", action: "deny" }],
    tools: { apply_patch: false, task: false },
  };
  assert.equal(normalizeAgentDebugMetadata(readOnlyMetadataFixture, "planner").canEdit, false);
  assert.equal(normalizeAgentDebugMetadata({ ...readOnlyMetadataFixture, tools: { task: false } }, "planner").canEdit, true);
  assert.equal(normalizeAgentDebugMetadata({ ...readOnlyMetadataFixture, tools: { apply_patch: false, edit: true, task: false } }, "planner").canEdit, true);
  const attestedReadOnlyMetadata = { ok: true, metadata: normalizeAgentDebugMetadata(readOnlyMetadataFixture, "planner") };
  assert.equal(readOnlyResultRetryable({ timedOut: true, toolOutcomes: [], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), true);
  assert.equal(readOnlyResultRetryable({ timedOut: true, providerErrorType: "opencode_auth_error", toolOutcomes: [], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), false);
  assert.equal(readOnlyResultRetryable({ timedOut: true, toolOutcomes: [{ tool: "bash", status: "running" }], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), false);
  assert.deepEqual(modelEvidenceFromEvent({ type: "message.updated", properties: { info: { role: "assistant", providerID: "google", modelID: "pinned-model" } } }), { provider: "google", model: "pinned-model" });
  assert.equal(modelEvidenceFromEvent({ type: "text", part: { metadata: { role: "assistant", providerID: "spoof", modelID: "spoof" } } }), null);
  const secretSentinel = "secret-sentinel-bridge-test";
  const validationEnvProbe = await runSpawnCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.BRIDGE_SECRET_SENTINEL || 'absent')"],
    process.cwd(),
    1000 * 15,
    buildValidationEnv(),
  );
  assert.equal(validationEnvProbe.stdout, "absent");
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  assert.equal(Boolean(inheritedPathKey && Object.keys(buildOpenCodeEnv()).some((key) => key.toUpperCase() === "PATH")), true);
  const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
  const previousGeminiDump = process.env.GEMINI_DUMP;
  process.env.OPENCODE_CONFIG_CONTENT = '{"plugin":["evil@1.0.0"]}';
  process.env.GEMINI_DUMP = "true";
  assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(buildOpenCodeEnv().GEMINI_DUMP, undefined);
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_SHARE, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DB, ":memory:");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_CHANNEL_DB, "true");
  assert.equal(path.resolve(buildOpenCodeEnv().HOME), BRIDGE_OPENCODE_HOME_DIR);
  assert.equal(path.resolve(buildOpenCodeEnv().USERPROFILE), BRIDGE_OPENCODE_HOME_DIR);
  assert.equal(path.resolve(buildOpenCodeEnv().XDG_CONFIG_HOME), path.dirname(DEFAULT_OPENCODE_CONFIG_DIR));
  assert.equal(path.resolve(buildOpenCodeEnv().XDG_DATA_HOME), path.dirname(DEFAULT_OPENCODE_DATA_DIR));
  assert.equal(path.resolve(buildOpenCodeEnv({ HOME: "isolated-home", USERPROFILE: "isolated-profile" }).HOME), path.resolve("isolated-home"));
  assert.equal(openCodeRunArgs("mcp-orchestrator", "probe").includes("--pure"), !CONFIG.allowExternalPlugins);
  assert.equal(buildValidationEnv().GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(buildValidationEnv().GIT_ATTR_NOSYSTEM, undefined);
  const safeDiffValidationFixture = await prepareValidationCommand("git diff --check");
  assert.equal(safeDiffValidationFixture.ok, true);
  assert.deepEqual(safeDiffValidationFixture.args.slice(0, 3), ["diff", "--no-ext-diff", "--no-textconv"]);
  const isolatedRuntimeFixture = await createIsolatedOpenCodeRuntime();
  assert.equal(isPathInside(path.resolve(tmpdir()), isolatedRuntimeFixture.root), true);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.HOME), path.join(isolatedRuntimeFixture.root, "home"));
  assert.equal(isolatedRuntimeFixture.env.USERPROFILE, isolatedRuntimeFixture.env.HOME);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_DATA_HOME), isolatedRuntimeFixture.root);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_CONFIG_HOME), path.join(isolatedRuntimeFixture.root, "config"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_CACHE_HOME), path.join(isolatedRuntimeFixture.root, "cache"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_STATE_HOME), path.join(isolatedRuntimeFixture.root, "state"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.TEMP), path.join(isolatedRuntimeFixture.root, "tmp"));
  assert.equal(isolatedRuntimeFixture.env.TMP, isolatedRuntimeFixture.env.TEMP);
  assert.equal(isolatedRuntimeFixture.env.TMPDIR, isolatedRuntimeFixture.env.TEMP);
  assert.equal(existsSync(isolatedRuntimeFixture.env.TEMP), true);
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DB, ":memory:");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_CHANNEL_DB, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_CLAUDE_CODE, "true");
  const isolatedConfigFixture = JSON.parse(isolatedRuntimeFixture.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(isolatedConfigFixture.plugin, []);
  assert.deepEqual(isolatedConfigFixture.mcp, {});
  assert.equal(isolatedConfigFixture.share, "disabled");
  assert.equal(isolatedConfigFixture.agent[MCP_SANITIZED_READER_AGENT].tools.skill, false);
  const isolatedSensitiveFile = path.join(isolatedRuntimeFixture.root, "opencode", "tool-output", "sensitive.txt");
  await mkdir(path.dirname(isolatedSensitiveFile), { recursive: true });
  await writeFile(isolatedSensitiveFile, "isolated-sensitive-sentinel", "utf8");
  assert.equal((await wipeIsolatedOpenCodeRuntime(isolatedRuntimeFixture.root)).ok, true);
  assert.equal(existsSync(isolatedRuntimeFixture.root), false);
  if (previousConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent;
  if (previousGeminiDump === undefined) delete process.env.GEMINI_DUMP;
  else process.env.GEMINI_DUMP = previousGeminiDump;
  const jsonSecret = "opaque-access-token-sentinel-123456";
  assert.doesNotMatch(redactSensitiveText(`{"access_token":"${jsonSecret}","api_key":"AIza123456789012345678901234"}`), /opaque-access-token|AIza123/);
  assert.doesNotMatch(JSON.stringify(sanitizePersistedValue({ contractorAuthorizationToken: secretSentinel, resultText: `Authorization: Bearer ${secretSentinel}` })), new RegExp(secretSentinel));
  assert.equal(classifyResultError({ exitCode: 0, assistantFinalResponseDetected: true, rawOutputTruncated: true }), "essential_output_truncated");
  assert.equal(detectsOpenCodeApiError('{"type":"error","message":"No payment method"}\n'), true);
  assert.equal(detectsOpenCodeApiError('{"type":"text","message":"ok"}\n'), false);
  assert.equal(detectsOpenCodeApiError("APIError: request failed\n"), true);
  const validFinalStream = [
    JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
    JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
  ].join("\n");
  const validFinalInspection = inspectOpenCodeEventStream(validFinalStream);
  assert.equal(validFinalInspection.finalResponseDetected, true);
  assert.equal(validFinalInspection.finalText, "done");
  assert.deepEqual(validFinalInspection.toolOutcomes, [{ tool: "read", status: "completed" }]);
  const localPhraseInspection = inspectOpenCodeEventStream(
    JSON.stringify({ type: "error", error: { message: "fixture contains billing, 429 rate limit, and model unavailable assertions" } })
  );
  assert.equal(localPhraseInspection.apiErrorDetected, true);
  assert.equal(localPhraseInspection.providerErrorType, "");
  const localStderrInspection = inspectOpenCodeEventStream(validFinalStream, "Error: fixture contains billing error handling");
  assert.equal(localStderrInspection.apiErrorDetected, false);
  assert.equal(localStderrInspection.providerErrorType, "");
  const recoveredTransientInspection = inspectOpenCodeEventStream(
    validFinalStream,
    'level=ERROR message="stream error" error.error="ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"'
  );
  assert.equal(recoveredTransientInspection.apiErrorDetected, false);
  assert.equal(recoveredTransientInspection.providerErrorType, "");
  assert.equal(recoveredTransientInspection.recoveredTransientProviderError, true);
  assert.equal(recoveredTransientInspection.providerWarningType, "opencode_transient_provider_error");
  const unrecoveredTransientInspection = inspectOpenCodeEventStream(
    JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
    "ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"
  );
  assert.equal(unrecoveredTransientInspection.apiErrorDetected, true);
  assert.equal(unrecoveredTransientInspection.providerErrorType, "opencode_transient_provider_error");
  assert.equal(unrecoveredTransientInspection.recoveredTransientProviderError, false);
  const structuredErrorThenTextInspection = inspectOpenCodeEventStream([
    JSON.stringify({ type: "error", error: "ProviderHeaderTimeoutError" }),
    JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
  ].join("\n"));
  assert.equal(structuredErrorThenTextInspection.apiErrorDetected, true);
  assert.equal(structuredErrorThenTextInspection.recoveredTransientProviderError, false);
  const hardAuthErrorWithFinalInspection = inspectOpenCodeEventStream(validFinalStream, "401 Unauthorized invalid API key");
  assert.equal(hardAuthErrorWithFinalInspection.apiErrorDetected, true);
  assert.equal(hardAuthErrorWithFinalInspection.providerErrorType, "opencode_auth_error");
  assert.equal(hardAuthErrorWithFinalInspection.recoveredTransientProviderError, false);
  const toolOnlyInspection = inspectOpenCodeEventStream(JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "error" } } }));
  assert.equal(toolOnlyInspection.finalResponseDetected, false);
  assert.equal(classifyResultError({ exitCode: 0, dryRun: false, assistantFinalResponseDetected: false }), "agent_empty_final_response");
  assert.equal(classifyResultError({ exitCode: 124, timedOut: true, providerErrorType: "opencode_quota_exhausted" }), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("429 RESOURCE_EXHAUSTED daily request quota exceeded"), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("401 Unauthorized invalid API key"), "opencode_auth_error");
  assert.equal(
    providerErrorTypeFromText("ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"),
    "opencode_transient_provider_error"
  );

  assert.equal(normalizeLockPath("apps/web/**"), "apps/web");
  assert.equal(normalizeLockPath("packages/shared/**"), "packages/shared");
  assert.equal(normalizeLockPath("apps/api/**"), "apps/api");
  assert.equal(normalizeLockPath("apps/api/app/**"), "apps/api/app");
  assert.equal(normalizeLockPath("apps\\api\\app\\**\\"), "apps/api/app");
  assert.equal(normalizeLockPath("apps/web///"), "apps/web");
  assert.equal(normalizeLockPath("./apps/web/*"), "apps/web");
  assert.equal(normalizeLockPath("README.md"), "README.md");
  assert.equal(isWithinAnyPath("src/file.js", ["src"], process.cwd()), true);
  assert.equal(
    isWithinAnyPath("SRC/file.js", ["src"], process.cwd()),
    process.platform === "win32"
  );
  assert.equal(isWithinAnyPath("private.key", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(isWithinAnyPath("apps/web/.env.local", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(isWithinAnyPath("apps/api/secrets/token.txt", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(recordMatchesProject({ cwd: process.cwd() }, process.cwd()), true);
  assert.equal(recordMatchesProject({ cwd: path.join(process.cwd(), "other-project") }, process.cwd()), false);
  assert.equal(nextQueueScheduleDelay([{ status: "pending" }], true), 0);
  assert.equal(nextQueueScheduleDelay([{ status: "blocked" }], true), CONFIG.queueBlockedPollMs);
  assert.equal(nextQueueScheduleDelay([{ status: "blocked" }], false), null);
  assert.equal(isOrchestratorAgent("principal-engineer-orchestrator"), true);
  assert.equal(isManagedReadOnlyAgent("principal-engineer-orchestrator"), true);
  assert.match(unsafePathReason(["../secrets"]), /parent traversal/);
  assert.match(unsafePathReason(["~/secret"]), /home-directory/);
  assert.match(unsafePathReason(["."]), /filesystem root/);
  assert.equal(defaultBuilderTimeoutMs, 1000 * 60 * 15);
  assert.equal(defaultOrchestratorTimeoutMs, 1000 * 60 * 6);
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-secret";
  assert.equal(buildOpenCodeEnv().OPENAI_API_KEY, undefined);
  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
  if (process.platform === "win32") {
    const previousPathExt = process.env.PATHEXT;
    delete process.env.PATHEXT;
    assert.equal(buildOpenCodeEnv().PATHEXT, ".COM;.EXE;.BAT;.CMD");
    if (previousPathExt !== undefined) {
      process.env.PATHEXT = previousPathExt;
    }
  }
  assert.equal(timeoutForAgent("orchestrator", { lockType: "write" }), defaultOrchestratorTimeoutMs);
  assert.equal(timeoutForAgent(MCP_ORCHESTRATOR_AGENT, { lockType: "read" }), defaultOrchestratorTimeoutMs);
  assert.equal(timeoutForAgent("debugger", { lockType: "write" }), defaultBuilderTimeoutMs);
  assert.equal(
    hardLockTtlForPlan({ agent: "builder", lockType: "write", timeoutMs: 1000 * 60 * 40 }),
    1000 * 60 * 50
  );
  assert.deepEqual(parseCommandLine('npm run "test:unit" -- --watch=false'), ["npm", "run", "test:unit", "--", "--watch=false"]);
  assert.deepEqual(
    parseCommandLine('node "C:\\Program Files\\Example\\check.js" C:\\repo\\src'),
    ["node", "C:\\Program Files\\Example\\check.js", "C:\\repo\\src"]
  );
  const validationVersionProbe = await runValidationGate({ command: "git --version", cwd: process.cwd() });
  assert.equal(validationVersionProbe.status, "passed", JSON.stringify(validationVersionProbe));
  assert.equal((await runValidationGate({ command: '"unterminated', cwd: process.cwd() })).errorType, "validation_command_parse_error");
  const timeoutProbe = await runSpawnCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], process.cwd(), 100);
  assert.equal(timeoutProbe.exitCode, 124);
  assert.equal(timeoutProbe.timedOut, true);
  const cancellationController = new AbortController();
  const cancellationProbePromise = runSpawnCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { signal: cancellationController.signal }
  );
  setTimeout(() => cancellationController.abort(), 100);
  const cancellationProbe = await cancellationProbePromise;
  assert.equal(cancellationProbe.exitCode, 130);
  assert.equal(cancellationProbe.cancelled, true);
  const providerFailureProbe = await runSpawnCommand(
    process.execPath,
    ["-e", "console.error('APIError: 429 RESOURCE_EXHAUSTED daily quota exceeded'); setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { terminateOnProviderError: true }
  );
  assert.equal(providerFailureProbe.exitCode, 1);
  assert.equal(providerFailureProbe.providerTerminated, true);

  const formattedRejection = formatRejectedExecution({
    errorType: "test_error",
    reason: "Testing structured failure output.",
    requestedAgent: "builder",
    actualAgent: "none",
    lockMode: "simple",
    durationMs: 7,
  });
  assert.match(formattedRejection, /errorType: test_error/);
  assert.match(formattedRejection, /requestedAgent: builder/);
  assert.match(formattedRejection, /actualAgent: none/);
  assert.match(formattedRejection, /durationMs: 7/);

  const writeScope = (paths, options = {}) => ({
    mode: "write",
    read: options.read || paths,
    write: paths,
    allowedEdits: options.allowedEdits || paths,
    forbidden: options.forbidden || [],
    shared: options.shared || [],
    serialOnly: options.serialOnly || [],
    validationCommand: options.validationCommand || "",
  });

  const wildcardSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit only the web app.",
    write: true,
    lockedPaths: ["apps/web/**"],
    allowedEdits: ["apps/web/**"],
    scopeContract: writeScope(["apps/web/**"]),
  });
  assert.equal(wildcardSingle.error, null);
  assert.deepEqual(wildcardSingle.lockPlan.lockedPaths, ["apps/web"]);
  assert.deepEqual(wildcardSingle.lockPlan.allowedEdits, ["apps/web"]);
  assert.equal(wildcardSingle.lockPlan.lockMode, "simple");

  const orchestratorWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Coordinate and edit files.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(orchestratorWrite.errorType, "orchestrator_write_visibility_risk");
  assert.equal(orchestratorWrite.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorPromptWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Please spawn builder and modify code files.",
  });
  assert.equal(orchestratorPromptWrite.errorType, "orchestrator_write_visibility_risk");

  const orchestratorPlanningOnly = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Plan the complete billing service architecture and return affected files and test plan.",
    orchestratorMode: "planning-only",
  });
  assert.equal(orchestratorPlanningOnly.error, null);
  assert.equal(orchestratorPlanningOnly.lockPlan.lockType, "read");
  assert.equal(orchestratorPlanningOnly.lockPlan.orchestratorMode, "planning-only");

  const orchestratorLargeAutoPlanning = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build a complete billing service.",
  });
  assert.equal(orchestratorLargeAutoPlanning.error, null);
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.lockType, "read");
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.orchestratorMode, "planning-only");

  const selfTestContractorToken = "self-test-contractor-capability";
  selfTestContractorAuthorizationSha256 = createHash("sha256").update(selfTestContractorToken).digest("hex");
  const contractorMissingAuthorization = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder for the billing service.",
    orchestratorMode: "contractor",
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorMissingAuthorization.errorType, "orchestrator_user_authorization_required");

  const contractorInvalidCapability = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder for the billing service.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: "wrong-capability",
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorInvalidCapability.errorType, "orchestrator_contractor_capability_invalid");

  const contractorAuthorized = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder, reviewer, and tester for the billing service.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: selfTestContractorToken,
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorAuthorized.error, null);
  assert.equal(contractorAuthorized.lockPlan.orchestratorMode, "contractor");
  assert.equal(contractorAuthorized.lockPlan.userAuthorizedOrchestrator, true);
  assert.equal(shouldUseWorktree({ dryRun: false }, contractorAuthorized.lockPlan), true);

  const contractorParallel = validateParallelWritePlan([{
    agent: "orchestrator",
    task: "Contract the work and invoke builder for billing.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: selfTestContractorToken,
    write: true,
    lockMode: "strict",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  }]);
  assert.equal(contractorParallel.errorType, "orchestrator_contractor_must_run_alone");
  const internalContractorJobId = "internal-contractor-self-test";
  const internalContractorProof = makeInternalQueueContractorProof(internalContractorJobId);
  assert.equal(contractorAuthorizationValid({
    internalQueueJobId: internalContractorJobId,
    internalQueueContractorProof: internalContractorProof,
  }), true);
  assert.equal(contractorAuthorizationValid({
    internalQueueJobId: internalContractorJobId,
    internalQueueContractorProof: "0".repeat(64),
  }), false);
  selfTestContractorAuthorizationSha256 = "";

  const orchestratorBoundedWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build the isolated billing service only inside apps/billing.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
    scopeContract: writeScope(["apps/billing/**"]),
  });
  assert.equal(orchestratorBoundedWriter.errorType, "orchestrator_write_visibility_risk");
  assert.equal(orchestratorBoundedWriter.lockPlan.lockType, "write");
  assert.equal(orchestratorBoundedWriter.lockPlan.lockMode, "simple");
  assert.equal(orchestratorBoundedWriter.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorBoundedMissingScope = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing.",
    write: true,
    lockedPaths: ["apps/billing/**"],
  });
  assert.equal(orchestratorBoundedMissingScope.errorType, "orchestrator_write_visibility_risk");

  const orchestratorBoundedInternalWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and run builder internally for the database layer.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
    scopeContract: writeScope(["apps/billing/**"]),
  });
  assert.equal(orchestratorBoundedInternalWriter.errorType, "orchestrator_write_visibility_risk");

  const orchestratorBoundedGlobal = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and update package metadata.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["package.json"],
    allowedEdits: ["package.json"],
    scopeContract: writeScope(["package.json"]),
  });
  assert.equal(orchestratorBoundedGlobal.errorType, "orchestrator_write_visibility_risk");

  const orchestratorParallelWriter = validateParallelWritePlan([
    {
      agent: "orchestrator",
      task: "Build billing only.",
      orchestratorMode: "bounded-writer",
      write: true,
      lockMode: "simple",
      lockedPaths: ["apps/billing/**"],
      allowedEdits: ["apps/billing/**"],
      scopeContract: writeScope(["apps/billing/**"]),
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(orchestratorParallelWriter.errorType, "orchestrator_write_visibility_risk");

  const missingLockedPaths = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(missingLockedPaths.errorType, "missing_locked_paths");

  const missingAllowedEdits = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockedPaths: ["apps/web"],
    scopeContract: { ...writeScope(["apps/web"]), allowedEdits: [] },
  });
  assert.equal(missingAllowedEdits.errorType, "empty_allowed_edits");

  const invalidWriteLockMode = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockMode: "off",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(invalidWriteLockMode.errorType, "invalid_write_lock_mode");

  const defaultSecretWrite = validateSingleLockPlan({
    agent: "builder",
    task: "Edit a secret file.",
    write: true,
    lockedPaths: ["apps/web/.env.local"],
    allowedEdits: ["apps/web/.env.local"],
    scopeContract: writeScope(["apps/web/.env.local"]),
  });
  assert.equal(defaultSecretWrite.errorType, "lock_plan_rejected");

  const singlePreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Preflight one writer.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
  ]);
  assert.equal(singlePreflight.error, null);
  assert.equal(singlePreflight.executionMode, "single");
  assert.equal(singlePreflight.lockPlans[0].lockMode, "simple");
  assert.deepEqual(singlePreflight.lockPlans[0].lockedPaths, ["apps/web"]);

  const unsafeSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Do unsafe edit.",
    write: true,
    lockedPaths: ["../outside"],
    allowedEdits: ["../outside"],
    scopeContract: writeScope(["../outside"]),
  });
  assert.equal(unsafeSingle.errorType, "scope_path_unsafe");

  const readOnlySingle = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review without editing.",
  });
  assert.equal(readOnlySingle.error, null);
  assert.equal(readOnlySingle.lockPlan.lockType, "read");
  assert.equal(readOnlySingle.lockPlan.lockMode, "off");
  const readOnlyBuilder = validateSingleLockPlan({
    agent: "builder",
    task: "Inspect only.",
    write: false,
    lockType: "read",
    lockMode: "off",
  });
  assert.equal(readOnlyBuilder.errorType, "read_only_agent_required");
  assert.equal(
    readOnlyRoutingPolicyError(
      { requestedAgent: "planner", actualAgent: "build" },
      { lockType: "read" }
    ).errorType,
    "read_only_proxy_unsafe"
  );

  const validReadOnlyScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review web and UI only.",
    scope: {
      read: ["apps\\web\\**", "packages/ui/**"],
      forbidden: [".env", "apps/api/**"],
    },
    actions: ["read_files"],
  });
  assert.equal(validReadOnlyScope.error, null);
  assert.equal(validReadOnlyScope.lockPlan.scopeContract.mode, "read");
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.read, ["apps/web", "packages/ui"]);
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.forbidden, [".env", "apps/api"]);

  const validWriteScope = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web only.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      read: ["apps/web/**", "packages/ui/**"],
      write: ["apps/web/**"],
      forbidden: [".env", ".env.*", "apps/api/**", "package-lock.json"],
    },
    actions: ["read_files", "edit_files", "run_tests"],
    validation: {
      changedFilesMustBeWithinWriteScope: true,
      forbiddenFilesMustNotChange: true,
      readOnlyMustNotChangeFiles: true,
    },
  });
  assert.equal(validWriteScope.error, null);
  assert.deepEqual(validWriteScope.lockPlan.allowedEdits, ["apps/web"]);
  assert.deepEqual(validWriteScope.lockPlan.scopeContract.scope.write, ["apps/web"]);

  const forbiddenOverridesWrite = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web but forbid secrets.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
      forbidden: ["apps/web/.env"],
    },
  });
  assert.equal(forbiddenOverridesWrite.errorType, "scope_write_forbidden");

  const readOnlyAgentWithWriteScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review but has write scope.",
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
    },
  });
  assert.equal(readOnlyAgentWithWriteScope.errorType, "scope_readonly_write_scope");

  const unsafeScopePath = validateSingleLockPlan({
    agent: "builder",
    task: "Unsafe scope.",
    write: true,
    lockedPaths: ["apps/web"],
    scope: {
      write: ["..\\outside"],
    },
  });
  assert.equal(unsafeScopePath.errorType, "scope_path_unsafe");

  const nonOverlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(nonOverlappingParallel.error, null);
  assert.deepEqual(nonOverlappingParallel.lockPlans[0].allowedEdits, ["apps/web"]);
  assert.equal(nonOverlappingParallel.lockPlans[0].lockMode, "strict");

  const absoluteWebPath = path.join(process.cwd(), "apps", "web");
  const mixedAbsoluteRelativeParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web with a relative scope.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web"],
      allowedEdits: ["apps/web"],
      scopeContract: writeScope(["apps/web"]),
    },
    {
      agent: "debugger",
      task: "Edit the same web path with an absolute scope.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: [absoluteWebPath],
      allowedEdits: [absoluteWebPath],
      scopeContract: writeScope([absoluteWebPath]),
    },
  ]);
  assert.equal(mixedAbsoluteRelativeParallel.errorType, "parallel_plan_rejected");
  assert.deepEqual(mixedAbsoluteRelativeParallel.conflictingPaths, ["apps/web", "apps/web"]);

  const parallelPreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(parallelPreflight.error, null);
  assert.equal(parallelPreflight.executionMode, "parallel");
  assert.deepEqual(parallelPreflight.lockPlans.map((plan) => plan.lockMode), ["strict", "strict"]);

  const pipelineTooSmall = createPipelinePlan({
    name: "too-small",
    requiresWorktrees: false,
    jobs: [{
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    }],
  });
  assert.equal(pipelineTooSmall.errorType, "pipeline_too_small");

  const pipelineMissingFinalValidation = createPipelinePlan({
    name: "missing-final-validation",
    requiresWorktrees: false,
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineMissingFinalValidation.errorType, "final_validation_required");

  const pipelineUnsafeReviewer = createPipelinePlan({
    name: "unsafe-reviewer",
    requiresWorktrees: false,
    finalValidationCommand: "git status --short",
    reviewerJob: { agent: "builder", task: "Review the result." },
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineUnsafeReviewer.errorType, "pipeline_gate_agent_not_read_only");

  const pipelineWithoutWorktrees = createPipelinePlan({
    name: "bounded-pipeline",
    requiresWorktrees: false,
    finalValidationCommand: "git status --short",
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineWithoutWorktrees.ok, true);
  assert.equal(pipelineWithoutWorktrees.record.status, "planned");
  assert.equal(pipelineWithoutWorktrees.record.integrationQueue.length, 2);

  if (CONFIG.worktreeMode === "off") {
    const pipelineRequiresWorktrees = createPipelinePlan({
      name: "requires-worktrees",
      finalValidationCommand: "git status --short",
      jobs: [{
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      }],
    });
    assert.equal(pipelineRequiresWorktrees.errorType, "worktree_required_for_pipeline");
  }

  const tooManyParallelJobs = validateParallelWritePlan(
    Array.from({ length: CONFIG.parallelLimit + 1 }, (_, index) => ({
      agent: "reviewer",
      task: `Read-only review ${index}.`,
    }))
  );
  assert.match(tooManyParallelJobs.error, /CODEX_OPENCODE_PARALLEL_LIMIT/);

  const overlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "builder",
      task: "Edit web components.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
      scopeContract: writeScope(["apps/web/src/**"]),
    },
  ]);
  assert.match(overlappingParallel.error, /Parallel write jobs overlap/);

  const overlappingParallelScopes = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      scope: { write: ["apps/web/**"] },
    },
    {
      agent: "debugger",
      task: "Edit web src.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      scope: { write: ["apps/web/src/**"] },
    },
  ]);
  assert.match(overlappingParallelScopes.error, /Parallel write jobs overlap/);

  const serialOnlyParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit package metadata.",
      write: true,
      lockedPaths: ["package.json"],
      allowedEdits: ["package.json"],
      scopeContract: writeScope(["package.json"]),
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api"],
      allowedEdits: ["apps/api"],
      scopeContract: writeScope(["apps/api"]),
    },
  ]);
  assert.equal(serialOnlyParallel.errorType, "serial_only_parallel_write");

  const serialOnlySingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit README serially.",
    write: true,
    lockedPaths: ["README.md"],
    allowedEdits: ["README.md"],
    scopeContract: writeScope(["README.md"]),
  });
  assert.equal(serialOnlySingle.error, null);

  const readWithScopeParallel = validateParallelWritePlan([
    {
      agent: "reviewer",
      task: "Review web while builder edits web.",
      lockedPaths: ["apps/web/**"],
    },
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
  ]);
  assert.equal(readWithScopeParallel.error, null);

  const readOnlyTimeoutViolations = verifyParallelLockResults([
    {
      index: 0,
      lockPlan: {
        agent: "reviewer",
        lockType: "read",
        lockMode: "off",
        cwd: "",
        allowedEdits: [],
        forbiddenEdits: [],
        sharedFiles: [],
      },
      result: {
        exitCode: 124,
        readOnlyUnavailable: true,
        timedOut: true,
        changedFiles: [],
        openCodeFallbackDetected: false,
        openCodeApiErrorDetected: false,
      },
    },
  ]);
  assert.deepEqual(readOnlyTimeoutViolations, []);

  selfTestProgress("queue/lock/recovery");
  if (effectiveQueueMode() !== "off") {
    QUEUE_JOBS.clear();
    const queuedReadOnly = await enqueueQueueJob({
      agent: "reviewer",
      task: "Review only.",
      dryRun: true,
    }, "", { schedule: false });
    assert.equal(queuedReadOnly.ok, true);
    assert.equal(queuedReadOnly.record.mode, "read");
    assert.equal(queuedReadOnly.record.maxRetries, 0);
    if (effectiveQueueMode() === "sqlite") {
      assert.ok(queuedReadOnly.record.requestEncrypted);
      assert.equal((await decryptQueueRequest(queuedReadOnly.record.requestEncrypted, queuedReadOnly.record.jobId)).task, "Review only.");
      const idempotencyKey = `self-test-${randomBytes(6).toString("hex")}`;
      const first = await enqueueQueueJob({ agent: "reviewer", task: "Idempotent review.", dryRun: true, idempotencyKey }, "", { schedule: false });
      const second = await enqueueQueueJob({ agent: "reviewer", task: "Idempotent review.", dryRun: true, idempotencyKey }, "", { schedule: false });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(second.deduplicated, true);
      assert.equal(second.record.jobId, first.record.jobId);
      const conflict = await enqueueQueueJob({ agent: "reviewer", task: "Different request.", dryRun: true, idempotencyKey }, "", { schedule: false });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.errorType, "queue_idempotency_conflict");
    }

    const queuedWrite = await enqueueQueueJob({
      agent: "builder",
      task: "Edit web.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    }, "", { schedule: false });
    assert.equal(queuedWrite.ok, true);
    assert.equal(queuedWrite.record.mode, "write");
    assert.deepEqual(queuedWrite.record.lockedPaths, ["apps/web"]);
    assert.deepEqual(queuedWrite.record.allowedEdits, ["apps/web"]);

    assert.equal((await updateQueueRecordDurable(queuedWrite.record, { status: "running" })).persisted, true);
    const queuedBlocked = await enqueueQueueJob({
      agent: "debugger",
      task: "Edit web src.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
      scopeContract: writeScope(["apps/web/src/**"]),
    }, "", { schedule: false });
    assert.equal(queuedBlocked.ok, true);
    const queueConflict = await findQueueWriteConflict(queuedBlocked.record);
    assert.equal(queueConflict.jobId, queuedWrite.record.jobId);
    assert.deepEqual(queueConflict.paths, ["apps/web/src", "apps/web"]);
    const queueAssessment = await assessQueuePlan([{
      lockType: "write",
      cwd: queuedBlocked.record.cwd,
      lockedPaths: queuedBlocked.record.lockedPaths,
      allowedEdits: queuedBlocked.record.allowedEdits,
    }]);
    assert.match(queueAssessment.status, /must_wait|conflict/);
    assert.equal(shouldRetryQueueJob(queuedReadOnly.record, { result: { errorType: "read_only_agent_unavailable" } }), false);
    assert.equal(shouldRetryQueueJob(queuedWrite.record, { result: { errorType: "agent_timeout" } }), false);
    assert.equal(queueRecordSnapshot(queuedReadOnly.record).status, "pending");
    assert.equal((await updateQueueRecordDurable(queuedBlocked.record, { status: "cancelled", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(queueRecordSnapshot(queuedBlocked.record).status, "cancelled");
    QUEUE_JOBS.clear();
  }

  const expiredCreatedAt = new Date(Date.now() - (CONFIG.queueRetentionDays + 1) * 24 * 60 * 60 * 1000).toISOString();
  QUEUE_JOBS.set("expired-memory-job", { jobId: "expired-memory-job", status: "completed", createdAt: expiredCreatedAt });
  PIPELINE_RUNS.set("expired-memory-pipeline", { pipelineId: "expired-memory-pipeline", status: "failed", createdAt: expiredCreatedAt });
  pruneInMemoryState();
  assert.equal(QUEUE_JOBS.has("expired-memory-job"), CONFIG.queueRetentionDays <= 0);
  assert.equal(PIPELINE_RUNS.has("expired-memory-pipeline"), CONFIG.queueRetentionDays <= 0);
  QUEUE_JOBS.delete("expired-memory-job");
  PIPELINE_RUNS.delete("expired-memory-pipeline");

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-opencode-mcp-"));
  const tempStateDir = `${tempDir}-state`;
  const outsideLinkTarget = `${tempDir}-outside`;
  const nonGitFixture = `${tempDir}-non-git`;
  const previousStateDirectoryOverride = stateDirectoryOverride;
  stateDirectoryOverride = tempStateDir;
  try {
    await mkdir(nonGitFixture, { recursive: true });
    assert.equal((await verifyProtectedGitRoot(nonGitFixture)).errorType, "git_state_required");
    await assert.rejects(gitChangedFiles(nonGitFixture), /Git changed-file inspection failed closed/);
    const init = await runCommand("git", ["init"], tempDir, 1000 * 15);
    assert.equal(init.exitCode, 0);
    assert.equal((await runCommand("git", ["config", "core.autocrlf", "false"], tempDir, 1000 * 15)).exitCode, 0);
    const pluginFixtureHome = path.join(tempDir, "plugin-home");
    const pluginFixtureSpec = "bridge-plugin-fixture@1.2.3";
    const pluginFixtureRoot = path.join(pluginFixtureHome, ".cache", "opencode", "packages", pluginFixtureSpec);
    const pluginFixturePackageRoot = path.join(pluginFixtureRoot, "node_modules", "bridge-plugin-fixture");
    const pluginFixtureConfigDir = path.join(pluginFixtureHome, ".config", "opencode");
    const pluginFixtureConfigPath = path.join(pluginFixtureConfigDir, "opencode.jsonc");
    const pluginFixtureSettingsPath = path.join(pluginFixtureConfigDir, "plugin-security.json");
    const pluginFixtureManifestPath = path.join(pluginFixtureHome, "plugin-manifest.json");
    const pluginFixtureHostScript = path.join(pluginFixtureHome, process.platform === "win32" ? "fake-opencode.c" : "fake-opencode.cjs");
    const pluginFixtureHostExecutable = process.platform === "win32"
      ? path.join(pluginFixtureHome, "fake-opencode.exe")
      : path.join(pluginFixtureHome, "fake-opencode");
    await mkdir(pluginFixturePackageRoot, { recursive: true });
    await mkdir(pluginFixtureConfigDir, { recursive: true });
    await writeFile(path.join(pluginFixtureRoot, "package-lock.json"), "{}\n", "utf8");
    await writeFile(path.join(pluginFixtureRoot, "package.json"), JSON.stringify({ private: true, dependencies: { "bridge-plugin-fixture": "1.2.3" } }), "utf8");
    await writeFile(path.join(pluginFixturePackageRoot, "package.json"), JSON.stringify({ name: "bridge-plugin-fixture", version: "1.2.3", main: "index.js", type: "module" }), "utf8");
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default async () => ({})\n", "utf8");
    const pluginFixtureConfig = `${JSON.stringify({ plugin: [pluginFixtureSpec] }, null, 2)}\n`;
    const pluginFixtureSettings = `${JSON.stringify({ debug: false })}\n`;
    await writeFile(pluginFixtureConfigPath, pluginFixtureConfig, "utf8");
    await writeFile(pluginFixtureSettingsPath, pluginFixtureSettings, "utf8");
    const pluginFixtureEffectiveConfig = JSON.stringify({
      plugin: [pluginFixtureSpec],
      plugin_origins: [{ spec: pluginFixtureSpec, source: pluginFixtureConfigDir, scope: "global" }],
    });
    if (process.platform === "win32") {
      await writeFile(pluginFixtureHostScript, [
        "#include <stdio.h>",
        "#include <string.h>",
        "int main(int argc, char **argv) {",
        "  for (int i = 1; i < argc; i += 1) { if (strcmp(argv[i], \"--version\") == 0) { fputs(\"1.17.13\\n\", stdout); return 0; } }",
        `  if (argc == 3 && strcmp(argv[1], "debug") == 0 && strcmp(argv[2], "config") == 0) { fputs(${JSON.stringify(pluginFixtureEffectiveConfig)}, stdout); return 0; }`,
        "  fputs(\"unexpected fake OpenCode arguments\", stderr); return 2;",
        "}",
      ].join("\n"), "utf8");
      const compilerCandidates = ["gcc", "C:\\MinGW\\bin\\gcc.exe"];
      const compilerFailures = [];
      let compiled = false;
      for (const compiler of compilerCandidates) {
        try {
          await execFileAsync(compiler, [pluginFixtureHostScript, "-O2", "-o", pluginFixtureHostExecutable], {
            cwd: pluginFixtureHome,
            windowsHide: true,
            timeout: 1000 * 30,
          });
          compiled = true;
          break;
        } catch (error) {
          compilerFailures.push(`${compiler}: ${error.message || String(error)}`);
        }
      }
      assert.equal(compiled, true, `A C compiler is required for the deterministic Windows plugin-policy host.\n${compilerFailures.join("\n")}`);
    } else {
      await writeFile(pluginFixtureHostScript, [
        `const args = process.argv.slice(2);`,
        `if (args.includes("--version")) { process.stdout.write("1.17.13\\n"); process.exit(0); }`,
        `if (args.join(" ") === "debug config") { process.stdout.write(${JSON.stringify(pluginFixtureEffectiveConfig)}); process.exit(0); }`,
        `process.stderr.write("unexpected fake OpenCode arguments: " + args.join(" ")); process.exit(2);`,
      ].join("\n"), "utf8");
      await writeFile(pluginFixtureHostExecutable, `#!/bin/sh\nexec "${process.execPath}" "${pluginFixtureHostScript}" "$@"\n`, "utf8");
      await chmod(pluginFixtureHostExecutable, 0o755);
    }
    const pluginFixtureTree = await hashExactTree(pluginFixtureRoot);
    const pluginFixtureManifest = {
      version: 1,
      openCodeVersion: "1.17.13",
      plugins: [{
        specifier: pluginFixtureSpec,
        root: pluginFixtureRoot,
        packageRoot: pluginFixturePackageRoot,
        fileCount: pluginFixtureTree.fileCount,
        entryCount: pluginFixtureTree.entryCount,
        packageLockSha256: await sha256File(path.join(pluginFixtureRoot, "package-lock.json")),
        treeSha256: pluginFixtureTree.treeSha256,
      }],
      configs: [{
        path: pluginFixtureConfigPath,
        sha256: await sha256File(pluginFixtureConfigPath),
        scope: "global",
        plugins: [pluginFixtureSpec],
      }],
      settings: [{
        path: pluginFixtureSettingsPath,
        sha256: await sha256File(pluginFixtureSettingsPath),
        requiredValues: { debug: false },
      }],
    };
    const writePluginFixtureManifest = async () => {
      const content = `${JSON.stringify(pluginFixtureManifest, null, 2)}\n`;
      await writeFile(pluginFixtureManifestPath, content, "utf8");
      return createHash("sha256").update(content).digest("hex");
    };
    const runPluginFixtureProbe = async (manifestSha256) => runSpawnCommand(
      process.execPath,
      [path.resolve(process.argv[1]), "--verify-plugin-policy", tempDir],
      tempDir,
      1000 * 90,
      {
        ...buildValidationEnv(),
        HOME: pluginFixtureHome,
        USERPROFILE: pluginFixtureHome,
        XDG_CONFIG_HOME: path.join(pluginFixtureHome, ".config"),
        CODEX_OPENCODE_EXECUTABLE: pluginFixtureHostExecutable,
        CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
        CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: pluginFixtureSpec,
        CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: pluginFixtureManifestPath,
        CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: manifestSha256,
      }
    );
    const pluginFixtureManifestSha256 = await writePluginFixtureManifest();
    const acceptedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(acceptedPluginProbe.exitCode, 0, acceptedPluginProbe.stderr);
    assert.equal(JSON.parse(acceptedPluginProbe.stdout).ok, true, acceptedPluginProbe.stdout);
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default { tampered: true }\n", "utf8");
    const tamperedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(tamperedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default async () => ({})\n", "utf8");
    const badManifestHashProbe = await runPluginFixtureProbe("0".repeat(64));
    assert.equal(JSON.parse(badManifestHashProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureConfigPath, `${JSON.stringify({ plugin: [pluginFixtureSpec, "unexpected-plugin@9.9.9"] })}\n`, "utf8");
    const unexpectedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(unexpectedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureConfigPath, pluginFixtureConfig, "utf8");
    await writeFile(pluginFixtureSettingsPath, `${JSON.stringify({ debug: true })}\n`, "utf8");
    const settingsTamperProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(settingsTamperProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureSettingsPath, pluginFixtureSettings, "utf8");
    await mkdir(outsideLinkTarget, { recursive: true });
    await symlink(outsideLinkTarget, path.join(pluginFixtureRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linkedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(linkedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await rm(path.join(pluginFixtureRoot, "linked"), { recursive: true, force: true });
    pluginFixtureManifest.plugins[0].root = path.join(tempDir, "plugin-copy-b");
    pluginFixtureManifest.plugins[0].packageRoot = path.join(tempDir, "plugin-copy-b", "node_modules", "bridge-plugin-fixture");
    const wrongResolutionManifestSha256 = await writePluginFixtureManifest();
    const wrongResolutionProbe = await runPluginFixtureProbe(wrongResolutionManifestSha256);
    assert.equal(JSON.parse(wrongResolutionProbe.stdout).errorType, "external_plugin_integrity_failed");
    pluginFixtureManifest.plugins[0].root = pluginFixtureRoot;
    pluginFixtureManifest.plugins[0].packageRoot = pluginFixturePackageRoot;
    assert.equal(await writePluginFixtureManifest(), pluginFixtureManifestSha256);
    await rm(pluginFixtureHome, { recursive: true, force: true });
    assert.match(unsafePathReason(["C:/Windows"], tempDir), /outside the allowed root|filesystem root/);
    await mkdir(outsideLinkTarget, { recursive: true });
    await symlink(outsideLinkTarget, path.join(tempDir, "outside-link"), process.platform === "win32" ? "junction" : "dir");
    assert.match(unsafePathReason(["outside-link/escape.txt"], tempDir), /symlink|junction/i);
    const linkedPolicy = await loadProjectAgentPolicy(tempDir, "outside-link/agent-policy.json");
    assert.equal(linkedPolicy.ok, false);
    assert.equal(linkedPolicy.errorType, "policy_path_unsafe");
    await rm(path.join(tempDir, "outside-link"), { recursive: true, force: true });
    const releaseFixture = path.join(tempDir, "release-fixture");
    assert.equal(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), "");
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: path.join(tempDir, "mutable-config"),
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), /XDG_CONFIG_HOME/);
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(tempDir, "mutable-agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), /CODEX_OPENCODE_AGENT_DIR/);
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(tempDir, "mutable-skills"),
    }), /CODEX_OPENCODE_SKILL_DIR/);
    assert.equal(immutableReleasePluginModeError({ releasePinned: true, allowExternalPlugins: false }), "");
    assert.match(
      immutableReleasePluginModeError({ releasePinned: true, allowExternalPlugins: true }),
      /Immutable releases must use pure mode/
    );
    assert.equal(immutableReleasePluginModeError({ releasePinned: false, allowExternalPlugins: true }), "");
    const releaseFixtureFiles = [
      "server.js",
      "package.json",
      "package-lock.json",
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
    ];
    const releaseManifestFiles = {};
    for (const relative of releaseFixtureFiles) {
      const absolute = path.join(releaseFixture, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relative}\n`, "utf8");
      releaseManifestFiles[relative] = await sha256File(absolute);
    }
    const releaseManifestContent = `${JSON.stringify({ version: 1, files: releaseManifestFiles }, null, 2)}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), releaseManifestContent, "utf8");
    const previousManifestHash = process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(releaseManifestContent).digest("hex");
    await verifyReleaseManifest(releaseFixture);
    const releaseRootJunction = path.join(tempDir, "release-root-junction");
    await symlink(releaseFixture, releaseRootJunction, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyReleaseManifest(releaseRootJunction), /release root and its ancestors.*symbolic links or junctions/i);
    await rm(releaseRootJunction, { recursive: true, force: true });
    const releaseAncestorJunction = path.join(outsideLinkTarget, "release-ancestor-junction");
    await symlink(tempDir, releaseAncestorJunction, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      verifyReleaseManifest(path.join(releaseAncestorJunction, "release-fixture")),
      /release root and its ancestors.*symbolic links or junctions/i
    );
    await rm(releaseAncestorJunction, { recursive: true, force: true });
    await writeFile(path.join(releaseFixture, "server.js"), "tampered\n", "utf8");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /server\.js/);
    await writeFile(path.join(releaseFixture, "server.js"), "server.js\n", "utf8");
    await writeFile(path.join(releaseFixture, "unexpected.txt"), "unexpected\n", "utf8");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unexpected or missing files/);
    await rm(path.join(releaseFixture, "unexpected.txt"), { force: true });
    await rm(path.join(releaseFixture, "bin", "e2e-concurrency.js"), { force: true });
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unexpected or missing files/);
    await writeFile(path.join(releaseFixture, "bin", "e2e-concurrency.js"), "bin/e2e-concurrency.js\n", "utf8");
    await writeFile(path.join(releaseFixture, "bin", "fresh-healthcheck.js"), "bin/fresh-healthcheck.js\n", "utf8");
    await symlink(outsideLinkTarget, path.join(releaseFixture, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /symbolic links|junctions/);
    await rm(path.join(releaseFixture, "linked"), { recursive: true, force: true });
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = "0".repeat(64);
    await assert.rejects(verifyReleaseManifest(releaseFixture), /manifest integrity/);
    const invalidSchemaContent = `${JSON.stringify({ version: 2, files: releaseManifestFiles })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), invalidSchemaContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(invalidSchemaContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /version 1/);
    const unsafePathContent = `${JSON.stringify({ version: 1, files: { ...releaseManifestFiles, "../escape": "0".repeat(64) } })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), unsafePathContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(unsafePathContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unsafe or invalid entry/);
    const invalidDigestContent = `${JSON.stringify({ version: 1, files: { ...releaseManifestFiles, "server.js": "invalid" } })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), invalidDigestContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(invalidDigestContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unsafe or invalid entry/);
    await writeFile(path.join(releaseFixture, "release-manifest.json"), releaseManifestContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(releaseManifestContent).digest("hex");
    await verifyReleaseManifest(releaseFixture);
    if (previousManifestHash === undefined) {
      delete process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    } else {
      process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = previousManifestHash;
    }
    const sanitizedRoot = path.join(nonGitFixture, "sanitized");
    const sanitizedManifestPath = path.join(nonGitFixture, "sanitized-manifest.json");
    await mkdir(path.join(sanitizedRoot, "nested"), { recursive: true });
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "sanitized\n", "utf8");
    await writeFile(path.join(sanitizedRoot, "nested", "data.json"), "{}\n", "utf8");
    const sanitizedManifestContent = `${JSON.stringify({
      version: 1,
      directories: ["nested"],
      files: {
        "allowed.txt": await sha256File(path.join(sanitizedRoot, "allowed.txt")),
        "nested/data.json": await sha256File(path.join(sanitizedRoot, "nested", "data.json")),
      },
    }, null, 2)}\n`;
    await writeFile(sanitizedManifestPath, sanitizedManifestContent, "utf8");
    const sanitizedContract = {
      root: sanitizedRoot,
      manifestPath: sanitizedManifestPath,
      manifestSha256: createHash("sha256").update(sanitizedManifestContent).digest("hex"),
      requiredFiles: ["allowed.txt"],
      forbiddenFiles: ["raw/**"],
    };
    const sanitizedPassed = await verifySanitizedWorkspace(sanitizedContract, "before_wave");
    assert.equal(sanitizedPassed.ok, true, JSON.stringify(sanitizedPassed, null, 2));
    const sanitizedPlanPassed = await verifySanitizedJobsBeforeDiscovery(
      [{ agent: "reviewer", cwd: sanitizedRoot, sanitizedWorkspace: sanitizedContract }],
      "delegation_plan_preflight_before_discovery"
    );
    assert.equal(sanitizedPlanPassed.ok, true, JSON.stringify(sanitizedPlanPassed, null, 2));
    await writeFile(path.join(sanitizedRoot, "unexpected.txt"), "unexpected\n", "utf8");
    const sanitizedAdded = await verifySanitizedWorkspace(sanitizedContract, "after_wave");
    assert.equal(sanitizedAdded.ok, false);
    assert.ok(sanitizedAdded.discrepancies.some((item) => item.type === "unexpected" && item.path === "unexpected.txt"));
    const sanitizedPlanRejected = await verifySanitizedJobsBeforeDiscovery(
      [{ agent: "reviewer", cwd: sanitizedRoot, sanitizedWorkspace: sanitizedContract }],
      "delegation_plan_preflight_before_discovery"
    );
    assert.equal(sanitizedPlanRejected.ok, false);
    assert.equal(sanitizedPlanRejected.index, 0);
    assert.ok(sanitizedPlanRejected.verification.discrepancies.some((item) => item.type === "unexpected" && item.path === "unexpected.txt"));
    await rm(path.join(sanitizedRoot, "unexpected.txt"), { force: true });
    const sanitizedForbidden = await verifySanitizedWorkspace({ ...sanitizedContract, forbiddenFiles: ["allowed.txt"] });
    assert.equal(sanitizedForbidden.ok, false);
    assert.ok(sanitizedForbidden.discrepancies.some((item) => item.type === "forbidden_present"));
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "mutated\n", "utf8");
    const sanitizedMutated = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedMutated.ok, false);
    assert.ok(sanitizedMutated.discrepancies.some((item) => item.type === "hash_mismatch"));
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "sanitized\n", "utf8");
    await rm(path.join(sanitizedRoot, "nested", "data.json"), { force: true });
    const sanitizedRemoved = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedRemoved.ok, false);
    assert.ok(sanitizedRemoved.discrepancies.some((item) => item.type === "missing" && item.path === "nested/data.json"));
    await writeFile(path.join(sanitizedRoot, "nested", "data.json"), "{}\n", "utf8");
    await symlink(outsideLinkTarget, path.join(sanitizedRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const sanitizedLinked = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedLinked.ok, false);
    assert.match(sanitizedLinked.error, /symbolic link|junction/i);
    await rm(path.join(sanitizedRoot, "linked"), { recursive: true, force: true });
    await writeFile(path.join(tempDir, ".gitignore"), "ignored.log\n", "utf8");

    await writeFile(path.join(tempDir, "already-untracked.txt"), "before\n", "utf8");
    const before = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "already-untracked.txt"), "after\n", "utf8");
    const after = await gitChangedFileSnapshot(tempDir);
    assert.deepEqual(changedFilesBetween(before, after), ["already-untracked.txt"]);
    await writeFile(path.join(tempDir, "ignored.log"), "first\n", "utf8");
    const ignoredBefore = await gitChangedFileSnapshot(tempDir);
    assert.match(ignoredBefore.get("ignored.log"), /^metadata:/);
    await writeFile(path.join(tempDir, "ignored.log"), "second\n", "utf8");
    const ignoredAfter = await gitChangedFileSnapshot(tempDir);
    assert.deepEqual(changedFilesBetween(ignoredBefore, ignoredAfter), ["ignored.log"]);

    const legacyLockDb = new DatabaseSync(":memory:");
    try {
      legacyLockDb.exec(`
        CREATE TABLE locks (
          normalized_path TEXT PRIMARY KEY,
          owner_agent TEXT NOT NULL,
          run_id TEXT NOT NULL,
          token TEXT NOT NULL,
          lock_mode TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          cwd TEXT,
          task TEXT
        );
      `);
      const legacyRawToken = "a".repeat(64);
      legacyLockDb.prepare("INSERT INTO locks (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("src", "builder", "legacy-run", legacyRawToken, "write", Date.now() + 60000, Date.now(), tempDir, secretSentinel);
      ensureLockTableSchema(legacyLockDb);
      assert.equal(lockTableHasCompositePrimaryKey(legacyLockDb), true);
      assert.equal(legacyLockDb.prepare("SELECT acquisition_origin FROM locks WHERE run_id = ?").get("legacy-run").acquisition_origin, "legacy");
      scrubLegacyLockSecrets(legacyLockDb);
      const scrubbedLegacyLock = legacyLockDb.prepare("SELECT token, task FROM locks WHERE run_id = ?").get("legacy-run");
      assert.match(scrubbedLegacyLock.token, /^sha256:[a-f0-9]{64}$/);
      assert.notEqual(scrubbedLegacyLock.token, legacyRawToken);
      assert.match(scrubbedLegacyLock.task, /^sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(scrubbedLegacyLock), new RegExp(secretSentinel));
    } finally {
      closeDb(legacyLockDb);
    }

    const readLockA = await acquireHardLock({
      owner: "codex",
      agent: "reviewer",
      cwd: tempDir,
      lockType: "read",
      paths: ["apps/web"],
    });
    const readLockB = await acquireHardLock({
      owner: "codex",
      agent: "tester",
      cwd: tempDir,
      lockType: "read",
      paths: ["apps/web"],
    });
    assert.equal(readLockA.ok, true);
    assert.equal(readLockB.ok, true);
    const blockedWriterByReaders = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(blockedWriterByReaders.ok, false);
    await releaseHardLock(readLockA.lock.id, readLockA.lock.token, readLockA.lock.paths, tempDir);
    await releaseHardLock(readLockB.lock.id, readLockB.lock.token, readLockB.lock.paths, tempDir);

    const lockA = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      task: `Review ${secretSentinel}`,
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockA.ok, true);
    const lockSecretDb = await openLockDb(tempDir);
    try {
      const rawLockRow = lockSecretDb.prepare("SELECT token, task FROM locks WHERE run_id = ? LIMIT 1").get(lockA.lock.id);
      assert.match(rawLockRow.token, /^sha256:[a-f0-9]{64}$/);
      assert.match(rawLockRow.task, /^sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(rawLockRow), new RegExp(secretSentinel));
      assert.doesNotMatch(JSON.stringify(await listLocks(tempDir)), new RegExp(lockA.lock.token));
    } finally {
      closeDb(lockSecretDb);
    }
    assert.equal((await releaseHardLock(lockA.lock.id, "wrong-token", lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).released, true);

    const relativeLock = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    const absoluteConflict = await acquireHardLock({
      owner: "codex",
      agent: "debugger",
      cwd: tempDir,
      lockType: "write",
      paths: [path.join(tempDir, "apps", "web")],
    });
    assert.equal(relativeLock.ok, true);
    assert.equal(absoluteConflict.ok, false);
    await releaseHardLock(relativeLock.lock.id, relativeLock.lock.token, relativeLock.lock.paths, tempDir);

    const ordinaryWriter = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/api"],
    });
    const disjointSerialIntegration = await acquireHardLock({
      owner: "codex",
      agent: "merge_manager",
      cwd: tempDir,
      lockType: "serial_integration",
      paths: ["apps/web"],
    });
    assert.equal(ordinaryWriter.ok, true);
    assert.equal(disjointSerialIntegration.ok, false);
    await releaseHardLock(ordinaryWriter.lock.id, ordinaryWriter.lock.token, ordinaryWriter.lock.paths, tempDir);

    const lockB = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockB.ok, true);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await listLocks(tempDir)).length, 1);
    const db = await openLockDb(tempDir);
    try {
      db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ?").run(Date.now() - 1, lockB.lock.id);
    } finally {
      closeDb(db);
    }
    await cleanupExpiredLocks(tempDir);
    assert.equal((await listLocks(tempDir)).length, 0);

    const staleQueueDb = await openLockDb(tempDir);
    try {
      const oldCreatedAt = new Date(Date.now() - CONFIG.queueStaleAfterMs - 1000).toISOString();
      const recentCreatedAt = new Date().toISOString();
      const insertQueueRecord = staleQueueDb.prepare(`
        INSERT OR REPLACE INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of [
        { jobId: "stale-self-test", createdAt: oldCreatedAt, status: "pending" },
        { jobId: "recent-self-test", createdAt: recentCreatedAt, status: "running" },
      ]) {
        const snapshot = {
          jobId: record.jobId,
          cwd: tempDir,
          status: record.status,
          agent: "reviewer",
          mode: "read",
          createdAt: record.createdAt,
        };
        insertQueueRecord.run(
          snapshot.jobId,
          snapshot.cwd,
          snapshot.status,
          snapshot.agent,
          snapshot.mode,
          snapshot.createdAt,
          "",
          "",
          JSON.stringify(snapshot)
        );
      }
      insertQueueRecord.run(
        "stale-invalid-self-test",
        tempDir,
        "pending",
        "reviewer",
        "read",
        oldCreatedAt,
        "",
        "",
        "null"
      );

      assert.deepEqual(reconcileStaleQueueRecords(staleQueueDb), ["stale-self-test", "stale-invalid-self-test"]);
      const staleRow = staleQueueDb.prepare(
        "SELECT status, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get("stale-self-test");
      const recentRow = staleQueueDb.prepare(
        "SELECT status, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get("recent-self-test");
      assert.equal(staleRow.status, "not_resumable");
      assert.equal(JSON.parse(staleRow.record_json).errorType, "queue_job_not_resumable");
      const staleInvalidRow = staleQueueDb.prepare(
        "SELECT status, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get("stale-invalid-self-test");
      assert.equal(staleInvalidRow.status, "not_resumable");
      assert.equal(JSON.parse(staleInvalidRow.record_json).jobId, "stale-invalid-self-test");
      assert.equal(JSON.parse(staleInvalidRow.record_json).errorType, "queue_job_not_resumable");
      assert.equal(recentRow.status, "running");
      assert.equal(JSON.parse(recentRow.record_json).errorType, undefined);
      const expiredLease = new Date(Date.now() - 1000).toISOString();
      const futureLease = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      const insertLeased = staleQueueDb.prepare(`
        INSERT OR REPLACE INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
         owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const leased of [
        { jobId: "crashed-self-test", lease: expiredLease },
        { jobId: "crashed-live-child-self-test", lease: expiredLease },
        { jobId: "cancelled-orphan-self-test", lease: expiredLease },
        { jobId: "live-lease-self-test", lease: futureLease },
      ]) {
        const snapshot = {
          jobId: leased.jobId,
          cwd: tempDir,
          status: "running",
          agent: "reviewer",
          mode: "read",
          createdAt: oldCreatedAt,
          startedAt: oldCreatedAt,
          ownerInstanceId: "foreign-dead-instance",
          ownerProcessId: leased.jobId === "crashed-self-test" ? process.pid : 999999,
          ownerGeneration: "generation-a",
          heartbeatAt: oldCreatedAt,
          leaseExpiresAt: leased.lease,
        };
        insertLeased.run(
          snapshot.jobId, tempDir, snapshot.status, snapshot.agent, snapshot.mode,
          snapshot.createdAt, snapshot.startedAt, "", JSON.stringify(snapshot),
          snapshot.ownerInstanceId, snapshot.ownerProcessId, snapshot.ownerGeneration,
          snapshot.heartbeatAt, snapshot.heartbeatAt, snapshot.leaseExpiresAt
        );
      }
      staleQueueDb.prepare("UPDATE opencode_jobs SET child_process_id = ?, child_process_started_at = ? WHERE job_id = ?")
        .run(process.pid, oldCreatedAt, "crashed-live-child-self-test");
      staleQueueDb.prepare("UPDATE opencode_jobs SET cancellation_requested_at = ? WHERE job_id = ?")
        .run(oldCreatedAt, "cancelled-orphan-self-test");
      assert.deepEqual(new Set(reconcileStaleQueueRecords(staleQueueDb)), new Set([
        "crashed-self-test",
        "crashed-live-child-self-test",
        "cancelled-orphan-self-test",
      ]));
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("crashed-self-test").status, "interrupted");
      const liveChildOrphan = staleQueueDb.prepare("SELECT status, record_json FROM opencode_jobs WHERE job_id = ?").get("crashed-live-child-self-test");
      assert.equal(liveChildOrphan.status, "interrupted");
      assert.equal(JSON.parse(liveChildOrphan.record_json).orphanChildProcessAlive, true);
      assert.equal(JSON.parse(liveChildOrphan.record_json).orphanChildProcessId, process.pid);
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("cancelled-orphan-self-test").status, "cancelled");
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("live-lease-self-test").status, "running");

      const terminalRaceRecord = {
        jobId: "terminal-cancel-race-self-test",
        cwd: tempDir,
        status: "running",
        agent: "reviewer",
        mode: "read",
        createdAt: recentCreatedAt,
        startedAt: recentCreatedAt,
        ownerInstanceId: BRIDGE_INSTANCE_ID,
        ownerProcessId: process.pid,
        ownerGeneration: "terminal-race-generation",
        heartbeatAt: recentCreatedAt,
        leaseExpiresAt: futureLease,
        cancellationRequested: false,
        cancellationRequestedAt: "",
        childProcessId: 0,
        childProcessStartedAt: "",
        revision: 0,
      };
      insertLeased.run(
        terminalRaceRecord.jobId, tempDir, terminalRaceRecord.status, terminalRaceRecord.agent, terminalRaceRecord.mode,
        terminalRaceRecord.createdAt, terminalRaceRecord.startedAt, "", JSON.stringify(queueRecordSnapshot(terminalRaceRecord)),
        terminalRaceRecord.ownerInstanceId, terminalRaceRecord.ownerProcessId, terminalRaceRecord.ownerGeneration,
        terminalRaceRecord.heartbeatAt, terminalRaceRecord.heartbeatAt, terminalRaceRecord.leaseExpiresAt
      );
      staleQueueDb.prepare("UPDATE opencode_jobs SET cancellation_requested_at = '' WHERE job_id = ?")
        .run(terminalRaceRecord.jobId);
      const initialCancellation = stampPersistedQueueCancellation(staleQueueDb, {
        jobId: terminalRaceRecord.jobId,
        status: terminalRaceRecord.status,
        requestedAt: recentCreatedAt,
        recordJson: JSON.stringify(queueRecordSnapshot({
          ...terminalRaceRecord,
          cancellationRequested: true,
          cancellationRequestedAt: recentCreatedAt,
        })),
      });
      assert.equal(Number(initialCancellation.changes || 0), 1);
      const laterCancellationAt = new Date(Date.parse(recentCreatedAt) + 1000).toISOString();
      stampPersistedQueueCancellation(staleQueueDb, {
        jobId: terminalRaceRecord.jobId,
        status: terminalRaceRecord.status,
        requestedAt: laterCancellationAt,
        recordJson: JSON.stringify(queueRecordSnapshot({
          ...terminalRaceRecord,
          cancellationRequested: true,
          cancellationRequestedAt: laterCancellationAt,
        })),
      });
      assert.equal(
        staleQueueDb.prepare("SELECT cancellation_requested_at FROM opencode_jobs WHERE job_id = ?").get(terminalRaceRecord.jobId).cancellation_requested_at,
        recentCreatedAt
      );
      Object.assign(terminalRaceRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
        resultText: "A completion result that must not outrun durable cancellation.",
      });
      const terminalRace = persistTerminalQueueRecord(staleQueueDb, terminalRaceRecord);
      assert.equal(terminalRace.persisted, true);
      assert.equal(terminalRace.cancellationWon, true);
      assert.equal(terminalRaceRecord.status, "cancelled");
      const terminalRaceRow = staleQueueDb.prepare(
        "SELECT status, cancellation_requested_at, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get(terminalRaceRecord.jobId);
      assert.equal(terminalRaceRow.status, "cancelled");
      assert.equal(terminalRaceRow.cancellation_requested_at, recentCreatedAt);
      assert.equal(JSON.parse(terminalRaceRow.record_json).status, "cancelled");
      assert.equal(JSON.parse(terminalRaceRow.record_json).cancellationRequestedAt, recentCreatedAt);
      Object.assign(terminalRaceRecord, { status: "failed", errorType: "late_failure" });
      const terminalReplay = persistTerminalQueueRecord(staleQueueDb, terminalRaceRecord);
      assert.equal(terminalReplay.persisted, false);
      assert.equal(terminalRaceRecord.status, "cancelled");

      const currentOwnerRecord = {
        ...terminalRaceRecord,
        jobId: "terminal-owner-generation-self-test",
        status: "running",
        finishedAt: "",
        cancellationRequested: false,
        cancellationRequestedAt: "",
        errorType: "",
        errorReason: "",
        ownerGeneration: "current-owner-generation",
      };
      insertLeased.run(
        currentOwnerRecord.jobId, tempDir, currentOwnerRecord.status, currentOwnerRecord.agent, currentOwnerRecord.mode,
        currentOwnerRecord.createdAt, currentOwnerRecord.startedAt, "", JSON.stringify(queueRecordSnapshot(currentOwnerRecord)),
        currentOwnerRecord.ownerInstanceId, currentOwnerRecord.ownerProcessId, currentOwnerRecord.ownerGeneration,
        currentOwnerRecord.heartbeatAt, currentOwnerRecord.heartbeatAt, currentOwnerRecord.leaseExpiresAt
      );
      const staleOwnerRecord = {
        ...currentOwnerRecord,
        status: "failed",
        finishedAt: new Date().toISOString(),
        ownerGeneration: "stale-owner-generation",
        errorType: "late_failure",
      };
      const staleOwnerTerminal = persistTerminalQueueRecord(staleQueueDb, staleOwnerRecord);
      assert.equal(staleOwnerTerminal.persisted, false);
      assert.equal(staleOwnerRecord.status, "running");
      assert.equal(staleOwnerRecord.ownerGeneration, "current-owner-generation");
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(currentOwnerRecord.jobId).status, "running");
      Object.assign(currentOwnerRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
      });
      const currentOwnerTerminal = persistTerminalQueueRecord(staleQueueDb, currentOwnerRecord);
      assert.equal(currentOwnerTerminal.persisted, true);
      assert.equal(currentOwnerTerminal.cancellationWon, false);
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(currentOwnerRecord.jobId).status, "completed");

      staleQueueDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "stale-self-test",
        "stale-invalid-self-test",
        "recent-self-test",
        "crashed-self-test",
        "crashed-live-child-self-test",
        "cancelled-orphan-self-test",
        "live-lease-self-test",
        terminalRaceRecord.jobId,
        currentOwnerRecord.jobId
      );
    } finally {
      closeDb(staleQueueDb);
    }

    const previousQueuePersistenceMode = queueModeOverride;
    queueModeOverride = "sqlite";
    const makeQueuePersistenceRecord = (jobId) => ({
      jobId,
      parentJobId: "",
      cwd: tempDir,
      agent: "reviewer",
      task: "Queue persistence self-test",
      mode: "read",
      lockMode: "read",
      lockedPaths: [],
      allowedEdits: [],
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: "",
      finishedAt: "",
      errorType: "",
      errorReason: "",
      resultText: "",
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerProcessId: process.pid,
      ownerGeneration: randomBytes(12).toString("hex"),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      cancellationRequested: false,
      cancellationRequestedAt: "",
      childProcessId: 0,
      childProcessStartedAt: "",
      revision: 0,
    });

    const preExecutionFailureRecord = makeQueuePersistenceRecord("pre-execution-failure-self-test");
    assert.equal((await persistQueueRecord(preExecutionFailureRecord)).persisted, true);
    assert.equal((await updateQueueRecordDurable(preExecutionFailureRecord, { status: "planned" })).persisted, true);
    const preExecutionFailure = await updateQueueRecordDurable(preExecutionFailureRecord, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorType: "write_lock_conflict",
      errorReason: "Deterministic pre-execution conflict rejection.",
    });
    assert.equal(preExecutionFailure.persisted, true);
    assert.equal(preExecutionFailureRecord.status, "failed");
    assert.equal((await readPersistedQueueRecord(preExecutionFailureRecord.jobId, tempDir)).status, "failed");

    const scheduledConflictRecord = makeQueuePersistenceRecord("scheduled-conflict-reject-self-test");
    Object.assign(scheduledConflictRecord, {
      mode: "write",
      lockMode: "write",
      lockedPaths: ["src/conflict.txt"],
      allowedEdits: ["src/conflict.txt"],
    });
    const runningConflictRecord = {
      ...makeQueuePersistenceRecord("scheduled-conflict-running-self-test"),
      mode: "write",
      lockMode: "write",
      lockedPaths: ["src/conflict.txt"],
      allowedEdits: ["src/conflict.txt"],
      status: "running",
    };
    assert.equal((await persistQueueRecord(scheduledConflictRecord)).persisted, true);
    QUEUE_JOBS.set(runningConflictRecord.jobId, runningConflictRecord);
    QUEUE_JOBS.set(scheduledConflictRecord.jobId, scheduledConflictRecord);
    const previousQueueConflictPolicy = queueWriteConflictPolicyOverride;
    try {
      queueWriteConflictPolicyOverride = "reject";
      scheduleQueue();
      let persistedScheduledConflict = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (scheduledConflictRecord.status === "failed") {
          persistedScheduledConflict = await readPersistedQueueRecord(scheduledConflictRecord.jobId, tempDir);
          if (persistedScheduledConflict?.status === "failed") break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(scheduledConflictRecord.status, "failed");
      assert.equal(scheduledConflictRecord.errorType, "write_lock_conflict");
      assert.equal(persistedScheduledConflict?.status, "failed");
    } finally {
      queueWriteConflictPolicyOverride = previousQueueConflictPolicy;
      QUEUE_JOBS.delete(runningConflictRecord.jobId);
      QUEUE_JOBS.delete(scheduledConflictRecord.jobId);
    }

    const staleRevisionRecord = makeQueuePersistenceRecord("stale-revision-self-test");
    assert.equal((await persistQueueRecord(staleRevisionRecord)).persisted, true);
    const staleRevisionClone = structuredClone(staleRevisionRecord);
    assert.equal((await updateQueueRecordDurable(staleRevisionRecord, { status: "planned" })).persisted, true);
    assert.equal((await claimQueueRecord(staleRevisionRecord)).ok, true);
    staleRevisionClone.status = "blocked";
    const staleRevisionPersistence = await persistQueueRecord(staleRevisionClone);
    assert.equal(staleRevisionPersistence.persisted, false);
    assert.equal(staleRevisionClone.status, "running");
    assert.equal((await readPersistedQueueRecord(staleRevisionRecord.jobId, tempDir)).status, "running");
    assert.equal((await updateQueueRecordDurable(staleRevisionRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);

    const heartbeatRevisionRecord = makeQueuePersistenceRecord("heartbeat-revision-self-test");
    assert.equal((await persistQueueRecord(heartbeatRevisionRecord)).persisted, true);
    const heartbeatRevisionBefore = heartbeatRevisionRecord.revision;
    const heartbeatRevisionDb = await openLockDb(tempDir);
    try {
      const heartbeatAt = new Date().toISOString();
      assert.equal(renewPersistedQueueRecordLease(
        heartbeatRevisionDb,
        heartbeatRevisionRecord,
        heartbeatAt,
        new Date(Date.now() + CONFIG.queueLeaseMs).toISOString()
      ), true);
    } finally {
      closeDb(heartbeatRevisionDb);
    }
    const persistedHeartbeatRevision = await readPersistedQueueRecord(heartbeatRevisionRecord.jobId, tempDir);
    assert.ok(heartbeatRevisionRecord.revision > heartbeatRevisionBefore);
    assert.equal(heartbeatRevisionRecord.revision, persistedHeartbeatRevision.revision);
    assert.equal((await updateQueueRecordDurable(heartbeatRevisionRecord, { status: "cancelled", finishedAt: new Date().toISOString() })).persisted, true);

    const truncatedQueueRecord = makeQueuePersistenceRecord("queue-result-truncation-self-test");
    assert.equal((await persistQueueRecord(truncatedQueueRecord)).persisted, true);
    assert.equal((await claimQueueRecord(truncatedQueueRecord)).ok, true);
    const truncatedQueuePersistence = await updateQueueRecordDurable(truncatedQueueRecord, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      resultText: "x".repeat(CONFIG.queueResultMaxChars + 1),
    });
    assert.equal(truncatedQueuePersistence.persisted, true);
    assert.equal(truncatedQueueRecord.status, "completed");
    assert.equal(truncatedQueueRecord.errorType, "");
    assert.equal(truncatedQueueRecord.completionOutcome, "completed_with_truncated_output");
    const noResultTruncatedQueueSnapshot = queueRecordSnapshot(truncatedQueueRecord, false);
    assert.equal(noResultTruncatedQueueSnapshot.status, "completed");
    assert.equal(noResultTruncatedQueueSnapshot.completionOutcome, "completed_with_truncated_output");
    assert.equal(noResultTruncatedQueueSnapshot.resultText, "");
    const persistedTruncatedQueue = await readPersistedQueueRecord(truncatedQueueRecord.jobId, tempDir);
    assert.equal(persistedTruncatedQueue.status, "completed");
    assert.equal(persistedTruncatedQueue.errorType, "");
    assert.equal(persistedTruncatedQueue.completionOutcome, "completed_with_truncated_output");
    assert.equal(persistedTruncatedQueue.resultTextTruncated, true);
    assert.equal(persistedTruncatedQueue.resultTextChars, CONFIG.queueResultMaxChars + 1);
    assert.equal(persistedTruncatedQueue.resultTextSha256, createHash("sha256").update("x".repeat(CONFIG.queueResultMaxChars + 1)).digest("hex"));
    const listedTruncatedQueue = (await listPersistedQueueRecords(tempDir, "completed"))
      .find((record) => record.jobId === truncatedQueueRecord.jobId);
    assert.ok(listedTruncatedQueue);
    assert.equal(listedTruncatedQueue.status, "completed");
    assert.equal(listedTruncatedQueue.completionOutcome, "completed_with_truncated_output");

    const missingFinalQueueRecord = makeQueuePersistenceRecord("queue-missing-final-self-test");
    assert.equal((await persistQueueRecord(missingFinalQueueRecord)).persisted, true);
    assert.equal((await claimQueueRecord(missingFinalQueueRecord)).ok, true);
    assert.equal((await updateQueueRecordDurable(missingFinalQueueRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(missingFinalQueueRecord.status, "failed");
    assert.equal(missingFinalQueueRecord.errorType, "completion_evidence_missing");

    const missingWriteEvidenceRecord = makeQueuePersistenceRecord("queue-missing-write-evidence-self-test");
    Object.assign(missingWriteEvidenceRecord, { mode: "write", resultText: "Finished without durable change evidence." });
    assert.equal((await persistQueueRecord(missingWriteEvidenceRecord)).persisted, true);
    assert.equal((await claimQueueRecord(missingWriteEvidenceRecord)).ok, true);
    assert.equal((await updateQueueRecordDurable(missingWriteEvidenceRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(missingWriteEvidenceRecord.status, "failed");
    assert.equal(missingWriteEvidenceRecord.errorType, "write_completion_evidence_missing");

    const queuePersistenceCleanupDb = await openLockDb(tempDir);
    try {
      queuePersistenceCleanupDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?, ?, ?, ?, ?, ?)").run(
        preExecutionFailureRecord.jobId,
        scheduledConflictRecord.jobId,
        staleRevisionRecord.jobId,
        heartbeatRevisionRecord.jobId,
        truncatedQueueRecord.jobId,
        missingFinalQueueRecord.jobId,
        missingWriteEvidenceRecord.jobId
      );
    } finally {
      closeDb(queuePersistenceCleanupDb);
    }
    queueModeOverride = previousQueuePersistenceMode;

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "allowed\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "api\n", "utf8");
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "clean\n", "utf8");
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "secret\n", "utf8");
    await runCommand("git", ["add", "."], tempDir, 1000 * 15);
    const commit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], tempDir, 1000 * 15);
    assert.equal(commit.exitCode, 0);
    assert.equal(await resolveProjectStateRoot(path.join(tempDir, "src")), path.resolve(tempDir));
    const initialHead = (await runCommand("git", ["rev-parse", "HEAD"], tempDir, 1000 * 15)).stdout.trim();
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "unstaged checkpoint test\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "staged checkpoint test\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "untracked-checkpoint.txt"), "untracked checkpoint test\n", "utf8");
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "overlapping checkpoint test\n", "utf8");
    const dirtyStatusBefore = (await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], tempDir, 1000 * 15)).stdout;
    const dirtyIndexBefore = (await runCommand("git", ["diff", "--cached", "--binary"], tempDir, 1000 * 15)).stdout;
    const dirtyIndexFileShaBefore = await sha256File(path.join(tempDir, ".git", "index"));
    const dirtyPreflight = await inspectSourceCheckpointState(tempDir, {
      lockedPaths: ["src/allowed.txt"],
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(dirtyPreflight.ok, false);
    assert.equal(dirtyPreflight.errorType, "dirty_worktree_requires_checkpoint");
    assert.ok(dirtyPreflight.dirtyFiles.includes("src/api.txt"));
    assert.ok(dirtyPreflight.dirtyFiles.includes("src/blocked.txt"));
    assert.ok(dirtyPreflight.dirtyFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyPreflight.overlappingFiles, ["src/allowed.txt"]);
    assert.ok(dirtyPreflight.disjointFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyPreflight.conflictingPaths, ["src/allowed.txt"]);
    const dirtyWorktreeRejected = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "dirty-source-rejected",
      lockedPaths: ["src/allowed.txt"],
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(dirtyWorktreeRejected.ok, false);
    assert.equal(dirtyWorktreeRejected.errorType, "dirty_worktree_requires_checkpoint");
    assert.ok(dirtyWorktreeRejected.dirtyFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyCheckpointDetails(dirtyWorktreeRejected).conflictingPaths, ["src/allowed.txt"]);
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], tempDir, 1000 * 15)).stdout.trim(), initialHead);
    assert.equal((await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], tempDir, 1000 * 15)).stdout, dirtyStatusBefore);
    assert.equal((await runCommand("git", ["diff", "--cached", "--binary"], tempDir, 1000 * 15)).stdout, dirtyIndexBefore);
    assert.equal(await sha256File(path.join(tempDir, ".git", "index")), dirtyIndexFileShaBefore);
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/allowed.txt", "src/api.txt", "src/blocked.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await rm(path.join(tempDir, "untracked-checkpoint.txt"), { force: true });
    assert.deepEqual(await gitChangedFiles(tempDir), []);

    const rollbackSymlinkBaseline = await captureRollbackBaseline(tempDir);
    const externalRollbackSentinel = path.join(outsideLinkTarget, "rollback-sentinel.txt");
    await mkdir(outsideLinkTarget, { recursive: true });
    await writeFile(externalRollbackSentinel, "external sentinel unchanged\n", "utf8");
    const rollbackVictim = path.join(tempDir, "src", "allowed.txt");
    await rm(rollbackVictim, { force: true });
    if (process.platform === "win32") {
      // File symlinks normally require Developer Mode on Windows. A hard link
      // exercises the same critical invariant: rollback must replace the leaf,
      // never write through a link to external bytes.
      await link(externalRollbackSentinel, rollbackVictim);
    } else {
      await symlink(externalRollbackSentinel, rollbackVictim);
    }
    const maliciousLinkSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    const safeSymlinkRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: rollbackSymlinkBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: maliciousLinkSnapshot,
    });
    assert.equal(safeSymlinkRollback.rollback, "success");
    assert.equal(await readFile(externalRollbackSentinel, "utf8"), "external sentinel unchanged\n");
    assert.equal((await lstat(rollbackVictim)).isSymbolicLink(), false);
    assert.equal(await readFile(rollbackVictim, "utf8"), "allowed\n");

    const rollbackModeBaseline = await captureRollbackBaseline(tempDir);
    await chmod(rollbackVictim, 0o755);
    const executableOwnedSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    if (process.platform !== "win32") {
      assert.equal(executableOwnedSnapshot.get("src/allowed.txt").startsWith("file:73:"), true);
    }
    const safeModeRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: rollbackModeBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: executableOwnedSnapshot,
    });
    assert.equal(safeModeRollback.rollback, "success");
    if (process.platform !== "win32") assert.equal((await lstat(rollbackVictim)).mode & 0o111, 0);
    assert.equal(await readFile(rollbackVictim, "utf8"), "allowed\n");

    const basePinnedWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "base-pin-test" });
    assert.equal(basePinnedWorktree.ok, true, JSON.stringify(basePinnedWorktree, null, 2));
    assert.equal(basePinnedWorktree.baseCommit, initialHead);
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], basePinnedWorktree.path, 1000 * 15)).stdout.trim(), initialHead);
    await cleanupWorktree(basePinnedWorktree, "always", true);

    if (effectiveQueueMode() === "sqlite") {
      const crossProcessLock = await acquireHardLock({
        owner: "other-bridge",
        agent: "builder",
        cwd: tempDir,
        lockType: "write",
        paths: ["src/cross-process"],
      });
      assert.equal(crossProcessLock.ok, true);
      const crossProcessDb = await openLockDb(tempDir);
      try {
        const crossProcessRecord = {
          jobId: "cross-process-running",
          cwd: tempDir,
          mode: "write",
          status: "running",
          agent: "builder",
          task: "cross-process test",
          createdAt: new Date().toISOString(),
          lockedPaths: ["src/cross-process"],
          allowedEdits: ["src/cross-process"],
        };
        crossProcessDb.prepare(`
          INSERT OR REPLACE INTO opencode_jobs
          (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crossProcessRecord.jobId,
          tempDir,
          crossProcessRecord.status,
          crossProcessRecord.agent,
          crossProcessRecord.mode,
          crossProcessRecord.createdAt,
          crossProcessRecord.createdAt,
          "",
          JSON.stringify(crossProcessRecord)
        );
      } finally {
        closeDb(crossProcessDb);
      }
      const crossProcessConflict = await findQueueWriteConflict({
        jobId: "cross-process-candidate",
        cwd: tempDir,
        mode: "write",
        lockedPaths: ["src/cross-process"],
        allowedEdits: ["src/cross-process"],
      });
      assert.equal(crossProcessConflict.jobId, "cross-process-running");
      const cleanupCrossProcessDb = await openLockDb(tempDir);
      try {
        cleanupCrossProcessDb.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("cross-process-running");
      } finally {
        closeDb(cleanupCrossProcessDb);
      }
      await releaseHardLock(crossProcessLock.lock.id, crossProcessLock.lock.token, crossProcessLock.lock.paths, tempDir);
    }

    await writeFile(path.join(tempDir, "src", "api.txt"), "staged api   \n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.ok((await gitChangedFiles(tempDir)).includes("src/api.txt"));
    assert.equal((await runValidationGate({ command: "git diff --check", cwd: tempDir })).status, "failed");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.deepEqual(await gitChangedFiles(tempDir), []);

    selfTestProgress("pipeline persistence");
    const previousPipelinePersistenceMode = queueModeOverride;
    queueModeOverride = "sqlite";
    const pipelinePersistenceTask = "Persist this full pipeline task only in the encrypted replay request.";
    const pipelinePersistenceIsolationRecord = {
      pipelineId: "pipeline-task-persistence-self-test",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobs: [{ agent: "builder", task: pipelinePersistenceTask }],
      events: [],
      errors: [],
    };
    try {
      await persistPipelineRecord(pipelinePersistenceIsolationRecord);
      assert.equal(pipelinePersistenceIsolationRecord.jobs[0].task, pipelinePersistenceTask);
      const pipelinePersistenceDb = await openLockDb(tempDir);
      let rawPersistedPipeline = null;
      try {
        rawPersistedPipeline = pipelinePersistenceDb.prepare(
          "SELECT record_json, request_encrypted FROM opencode_pipelines WHERE pipeline_id = ?"
        ).get(pipelinePersistenceIsolationRecord.pipelineId);
      } finally {
        closeDb(pipelinePersistenceDb);
      }
      const rawPipelineRecord = JSON.parse(rawPersistedPipeline.record_json);
      assert.equal(rawPipelineRecord.jobs[0].task, undefined);
      assert.equal(rawPipelineRecord.jobs[0].taskChars, pipelinePersistenceTask.length);
      assert.equal(rawPipelineRecord.jobs[0].taskSha256, createHash("sha256").update(pipelinePersistenceTask).digest("hex"));
      assert.doesNotMatch(rawPersistedPipeline.record_json, new RegExp(pipelinePersistenceTask));
      assert.ok(rawPersistedPipeline.request_encrypted);
      const replayedPipeline = await readPersistedPipelineRecord(pipelinePersistenceIsolationRecord.pipelineId, tempDir);
      assert.equal(replayedPipeline.jobs[0].task, pipelinePersistenceTask);
    } finally {
      const pipelinePersistenceDb = await openLockDb(tempDir);
      try {
        pipelinePersistenceDb.prepare("DELETE FROM opencode_pipelines WHERE pipeline_id = ?").run(pipelinePersistenceIsolationRecord.pipelineId);
      } finally {
        closeDb(pipelinePersistenceDb);
      }
      queueModeOverride = previousPipelinePersistenceMode;
    }

    const persistenceOrderRecord = {
      pipelineId: "pipeline-persistence-order",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      errors: [],
    };
    await persistPipelineRecord(persistenceOrderRecord);
    let releaseFirstPipelineWrite = null;
    let markFirstPipelineWriteStarted = null;
    const firstPipelineWriteStarted = new Promise((resolve) => {
      markFirstPipelineWriteStarted = resolve;
    });
    const firstPipelineWriteRelease = new Promise((resolve) => {
      releaseFirstPipelineWrite = resolve;
    });
    const observedPipelineWrites = [];
    const orderedPipelineWrites = [];
    try {
      pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId !== persistenceOrderRecord.pipelineId) return;
        observedPipelineWrites.push(snapshot.status);
        if (snapshot.status === "running") {
          markFirstPipelineWriteStarted();
          await firstPipelineWriteRelease;
        }
      };
      orderedPipelineWrites.push(updatePipelineRecord(persistenceOrderRecord, { status: "running" }));
      await firstPipelineWriteStarted;
      orderedPipelineWrites.push(updatePipelineRecord(persistenceOrderRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(observedPipelineWrites, ["running"]);
      releaseFirstPipelineWrite();
      await Promise.all(orderedPipelineWrites);
      assert.deepEqual(observedPipelineWrites, ["running", "completed"]);
      const orderedPersistedPipeline = await readPersistedPipelineRecord(persistenceOrderRecord.pipelineId, tempDir);
      assert.equal(orderedPersistedPipeline.status, "completed");
    } finally {
      releaseFirstPipelineWrite?.();
      await Promise.allSettled(orderedPipelineWrites);
      pipelinePersistenceTestHook = null;
    }

    const crossProcessPipelineRecord = {
      pipelineId: "pipeline-cross-process-cas",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      errors: [],
    };
    await persistPipelineRecord(crossProcessPipelineRecord);
    const pipelineWriterA = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    const pipelineWriterB = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    await updatePipelineRecord(pipelineWriterA, { status: "running" });
    await assert.rejects(
      updatePipelineRecord(pipelineWriterB, { status: "completed", finishedAt: new Date().toISOString() }),
      (error) => error?.errorType === "pipeline_concurrent_update"
    );
    assert.equal(pipelineWriterB.status, "running");
    assert.equal(pipelineWriterB.revision, pipelineWriterA.revision);
    const pipelineCasPersisted = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    assert.equal(pipelineCasPersisted.status, "running");
    assert.equal(pipelineCasPersisted.revision, 1);

    const persistedPipelinePlan = createPipelinePlan({
      name: "persisted-pipeline",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [
        {
          agent: "builder",
          task: "Edit allowed file.",
          cwd: tempDir,
          write: true,
          lockedPaths: ["src/allowed.txt"],
          allowedEdits: ["src/allowed.txt"],
          scopeContract: writeScope(["src/allowed.txt"]),
        },
        {
          agent: "debugger",
          task: "Edit api file.",
          cwd: tempDir,
          write: true,
          lockedPaths: ["src/api.txt"],
          allowedEdits: ["src/api.txt"],
          scopeContract: writeScope(["src/api.txt"]),
        },
      ],
    });
    assert.equal(persistedPipelinePlan.ok, true, JSON.stringify(persistedPipelinePlan, null, 2));
    await persistPipelineRecord(persistedPipelinePlan.record);
    const restoredPipeline = await readPersistedPipelineRecord(persistedPipelinePlan.record.pipelineId, tempDir);
    assert.equal(restoredPipeline.pipelineId, persistedPipelinePlan.record.pipelineId);
    assert.equal(restoredPipeline.status, "planned");
    const pendingFinalize = await finalizePipelineRecord(persistedPipelinePlan.record, { skipReviewers: true, dryRun: true });
    assert.equal(pendingFinalize.ok, false);
    assert.equal(pendingFinalize.errorType, "pipeline_pending_integrations");
    await updatePipelineRecord(persistedPipelinePlan.record, {
      status: "awaiting_finalization",
      integrationQueue: persistedPipelinePlan.record.integrationQueue.map((item) => ({ ...item, status: "integrated" })),
    });
    const finalizedPipeline = await finalizePipelineRecord(persistedPipelinePlan.record, { skipReviewers: true });
    assert.equal(finalizedPipeline.ok, true);
    assert.equal(persistedPipelinePlan.record.status, "completed");
    assert.equal(persistedPipelinePlan.record.finalValidationResult.status, "passed");
    const durablyFinalizedPipeline = await readPersistedPipelineRecord(persistedPipelinePlan.record.pipelineId, tempDir);
    assert.equal(durablyFinalizedPipeline.status, "completed");
    assert.ok(durablyFinalizedPipeline.events.some((event) => event.type === "finalization_completed"));

    const finalValidationCleanupCandidate = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-final-validation-mutation",
    });
    assert.equal(finalValidationCleanupCandidate.ok, true, JSON.stringify(finalValidationCleanupCandidate, null, 2));
    const finalValidationCleanupIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: finalValidationCleanupCandidate.path,
      sourceBaseCommit: finalValidationCleanupCandidate.baseCommit,
    });
    assert.equal(finalValidationCleanupIdentity.ok, true);
    const mutationPipelineRecord = {
      ...structuredClone(persistedPipelinePlan.record),
      pipelineId: "pipeline-final-validation-mutation",
      revision: 0,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      status: "awaiting_finalization",
      queueJobIds: [],
      finalValidationCommand: "git status --short",
      finalValidationSource: "caller",
      finalValidationSpec: null,
      finalValidationResult: null,
      reviewerJob: null,
      testerJob: null,
      reviewerResult: null,
      testerResult: null,
      sourceCleanupResults: [],
      events: [],
      errors: [],
      finishedAt: "",
      integrationQueue: [{
        status: "integrated",
        cleanupRequested: true,
        worktreePath: finalValidationCleanupCandidate.path,
        branch: finalValidationCleanupCandidate.branch,
        sourceBaseCommit: finalValidationCleanupIdentity.sourceBaseCommit,
        patchSha256: finalValidationCleanupIdentity.patchSha256,
        sourceStateSha256: finalValidationCleanupIdentity.sourceStateSha256,
      }],
    };
    await persistPipelineRecord(mutationPipelineRecord);
    const mutationPipelineFinalized = await finalizePipelineRecord(mutationPipelineRecord, {
      skipReviewers: true,
      beforeFinalValidationHook: async ({ cwd: validationCwd }) => {
        await writeFile(path.join(validationCwd, "src", "final-validation-extra.txt"), "unreviewed validator output\n", "utf8");
      },
    });
    assert.equal(mutationPipelineFinalized.ok, false);
    assert.equal(mutationPipelineFinalized.errorType, "final_validation_mutated_workspace");
    assert.deepEqual(mutationPipelineRecord.finalValidationResult.mutationFiles, ["src/final-validation-extra.txt"]);
    assert.equal((await lstat(finalValidationCleanupCandidate.path)).isDirectory(), true);
    assert.deepEqual(mutationPipelineRecord.sourceCleanupResults, []);
    await rm(path.join(tempDir, "src", "final-validation-extra.txt"), { force: true });
    assert.equal((await cleanupWorktree(finalValidationCleanupCandidate, "always", true)).cleanup, "success");

    const cleanupFaultRecord = (pipelineId, worktree, identity) => ({
      ...structuredClone(persistedPipelinePlan.record),
      pipelineId,
      revision: 0,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      status: "awaiting_finalization",
      queueJobIds: [],
      finalValidationCommand: "git status --short",
      finalValidationSource: "caller",
      finalValidationSpec: null,
      finalValidationResult: null,
      reviewerJob: null,
      testerJob: null,
      reviewerResult: null,
      testerResult: null,
      sourceCleanupResults: [],
      events: [],
      errors: [],
      finishedAt: "",
      integrationQueue: [{
        status: "integrated",
        cleanupRequested: true,
        worktreePath: worktree.path,
        branch: worktree.branch,
        sourceBaseCommit: identity.sourceBaseCommit,
        patchSha256: identity.patchSha256,
        sourceStateSha256: identity.sourceStateSha256,
      }],
    });

    const authorizationFaultWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-cleanup-authorization-fault",
    });
    assert.equal(authorizationFaultWorktree.ok, true, JSON.stringify(authorizationFaultWorktree, null, 2));
    const authorizationFaultIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: authorizationFaultWorktree.path,
      sourceBaseCommit: authorizationFaultWorktree.baseCommit,
    });
    assert.equal(authorizationFaultIdentity.ok, true);
    const authorizationFaultPipeline = cleanupFaultRecord(
      "pipeline-cleanup-authorization-fault",
      authorizationFaultWorktree,
      authorizationFaultIdentity
    );
    await persistPipelineRecord(authorizationFaultPipeline);
    try {
      pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId === authorizationFaultPipeline.pipelineId
          && snapshot.events.some((event) => event.type === "source_cleanup_authorized")) {
          throw new Error("injected cleanup authorization persistence failure");
        }
      };
      await assert.rejects(
        finalizePipelineRecord(authorizationFaultPipeline, { skipReviewers: true }),
        /injected cleanup authorization persistence failure/
      );
    } finally {
      pipelinePersistenceTestHook = null;
    }
    assert.equal((await lstat(authorizationFaultWorktree.path)).isDirectory(), true);
    const authorizationFaultPersisted = await readPersistedPipelineRecord(authorizationFaultPipeline.pipelineId, tempDir);
    assert.equal(authorizationFaultPersisted.status, "finalizing");
    assert.equal(authorizationFaultPersisted.events.some((event) => event.type === "source_cleanup_authorized"), false);
    assert.deepEqual(authorizationFaultPersisted.sourceCleanupResults, []);
    assert.equal((await cleanupWorktree(authorizationFaultWorktree, "always", true)).cleanup, "success");

    const terminalFaultWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-terminal-persistence-fault",
    });
    assert.equal(terminalFaultWorktree.ok, true, JSON.stringify(terminalFaultWorktree, null, 2));
    const terminalFaultIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: terminalFaultWorktree.path,
      sourceBaseCommit: terminalFaultWorktree.baseCommit,
    });
    assert.equal(terminalFaultIdentity.ok, true);
    const terminalFaultPipeline = cleanupFaultRecord(
      "pipeline-terminal-persistence-fault",
      terminalFaultWorktree,
      terminalFaultIdentity
    );
    await persistPipelineRecord(terminalFaultPipeline);
    try {
      pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId === terminalFaultPipeline.pipelineId && snapshot.status === "completed") {
          throw new Error("injected terminal pipeline persistence failure");
        }
      };
      await assert.rejects(
        finalizePipelineRecord(terminalFaultPipeline, { skipReviewers: true }),
        /injected terminal pipeline persistence failure/
      );
    } finally {
      pipelinePersistenceTestHook = null;
    }
    assert.equal((await lstat(terminalFaultWorktree.path)).isDirectory(), true);
    assert.equal(terminalFaultPipeline.status, "finalizing");
    assert.deepEqual(terminalFaultPipeline.sourceCleanupResults, []);
    const terminalFaultPersisted = await readPersistedPipelineRecord(terminalFaultPipeline.pipelineId, tempDir);
    assert.equal(terminalFaultPersisted.status, "finalizing");
    assert.deepEqual(terminalFaultPersisted.sourceCleanupResults, []);
    assert.equal(terminalFaultPersisted.events.some((event) => event.type === "source_cleanup_authorized"), false);
    assert.equal(terminalFaultPersisted.events.some((event) => event.type === "finalization_completed"), false);
    assert.equal((await cleanupWorktree(terminalFaultWorktree, "always", true)).cleanup, "success");

    await mkdir(path.join(tempDir, ".mcp"), { recursive: true });
    const policyContent = JSON.stringify({
        version: 1,
        owners: {
          "src/allowed.txt": "builder",
          "src/blocked.txt": "debugger",
        },
        sharedFiles: ["src/forbidden.txt"],
        serialOnly: ["README.md"],
        finalValidationCommand: "git status --short",
      });
    await writeFile(path.join(tempDir, ".mcp", "agent-policy.json"), policyContent, "utf8");
    const policySha256 = createHash("sha256").update(policyContent).digest("hex");
    const untrustedPolicy = await loadProjectAgentPolicy(tempDir);
    assert.equal(untrustedPolicy.ok, false);
    assert.equal(untrustedPolicy.errorType, "policy_validation_command_untrusted");
    const callerHashOnlyPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/agent-policy.json", policySha256);
    assert.equal(callerHashOnlyPolicy.ok, false);
    assert.equal(callerHashOnlyPolicy.errorType, "policy_validation_command_untrusted");
    const testGitExecutable = await resolveValidationExecutable("git");
    const loadedPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/agent-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(loadedPolicy.ok, true);
    const copiedPolicyRoot = path.join(tempDir, "copied-policy-root");
    await mkdir(path.join(copiedPolicyRoot, ".mcp"), { recursive: true });
    await writeFile(path.join(copiedPolicyRoot, ".mcp", "agent-policy.json"), policyContent, "utf8");
    const copiedRootPolicy = await loadProjectAgentPolicy(copiedPolicyRoot, ".mcp/agent-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(copiedRootPolicy.ok, false);
    assert.equal(copiedRootPolicy.errorType, "policy_validation_command_untrusted");
    await rm(copiedPolicyRoot, { recursive: true, force: true });
    await writeFile(path.join(tempDir, ".mcp", "copied-policy.json"), policyContent, "utf8");
    const copiedPathPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/copied-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(copiedPathPolicy.ok, false);
    assert.equal(copiedPathPolicy.errorType, "policy_validation_command_untrusted");
    await rm(path.join(tempDir, ".mcp", "copied-policy.json"), { force: true });
    assert.throws(() => normalizeProjectAgentPolicy({ unexpected: true }), z.ZodError);
    const weakPolicyPath = path.join(tempDir, ".mcp", "weak-policy.json");
    const weakPolicyContent = JSON.stringify({ version: 1, requiresWorktrees: false });
    await writeFile(weakPolicyPath, weakPolicyContent, "utf8");
    const weakPolicy = await loadProjectAgentPolicy(
      tempDir,
      ".mcp/weak-policy.json",
      { operatorTrustedPolicySha256: createHash("sha256").update(weakPolicyContent).digest("hex") }
    );
    assert.equal(weakPolicy.ok, false);
    assert.equal(weakPolicy.errorType, "policy_safety_weakening");
    await rm(weakPolicyPath, { force: true });
    assert.ok(loadedPolicy.policy.sharedFiles.includes("src/forbidden.txt"));
    assert.ok(loadedPolicy.policy.forbiddenEdits.includes(".env"));
    const untrustedOwnersOnlyPolicy = normalizeProjectAgentPolicy({
      version: 1,
      owners: { "src/allowed.txt": "builder" },
    });
    const untrustedOwnershipPlan = createPipelinePlan({
      name: "untrusted-policy-cannot-grant-write-scope",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [
        { agent: "builder", task: "Attempt write authority inferred only from untrusted policy.", write: true },
        { agent: "reviewer", task: "Review." },
      ],
      policy: untrustedOwnersOnlyPolicy,
      policyTrustedForAuthority: false,
    });
    assert.equal(untrustedOwnershipPlan.ok, false);
    assert.equal(untrustedOwnershipPlan.errorType, "missing_scope_contract");
    const policyPipeline = createPipelinePlan({
      name: "policy-pipeline",
      cwd: tempDir,
      requiresWorktrees: false,
      jobs: [
        {
          agent: "builder",
          task: "Edit owned file inferred from policy.",
          write: true,
        },
        {
          agent: "debugger",
          task: "Edit debugger-owned file inferred from policy.",
          write: true,
        },
      ],
      policy: loadedPolicy.policy,
      policyPath: ".mcp/agent-policy.json",
      policyTrustedForAuthority: loadedPolicy.trustedForAuthority,
    });
    assert.equal(policyPipeline.ok, true, JSON.stringify(policyPipeline, null, 2));
    assert.deepEqual(policyPipeline.record.jobs[0].allowedEdits, ["src/allowed.txt"]);
    assert.deepEqual(policyPipeline.record.jobs[1].allowedEdits, ["src/blocked.txt"]);
    assert.ok(policyPipeline.record.jobs[0].forbiddenEdits.includes("src/blocked.txt"));
    assert.equal(policyPipeline.record.finalValidationCommand, "git status --short");
    assert.equal(policyPipeline.record.requiresWorktrees, false);

    const policyOwnerViolation = createPipelinePlan({
      name: "policy-owner-violation",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [{
        agent: "builder",
        task: "Try to edit debugger-owned file.",
        write: true,
        lockedPaths: ["src/blocked.txt"],
        allowedEdits: ["src/blocked.txt"],
        scopeContract: writeScope(["src/blocked.txt"]),
      },
      {
        agent: "reviewer",
        task: "Review the policy violation.",
      }],
      policy: loadedPolicy.policy,
      policyTrustedForAuthority: loadedPolicy.trustedForAuthority,
    });
    assert.equal(policyOwnerViolation.ok, false);
    assert.equal(policyOwnerViolation.errorType, "parallel_plan_rejected");
    assert.equal((await runCommand("git", ["add", "--", ".mcp/agent-policy.json"], tempDir, 1000 * 15)).exitCode, 0);
    const policyCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add agent policy"], tempDir, 1000 * 15);
    assert.equal(policyCommit.exitCode, 0);

    selfTestProgress("integration/receipts");
    const worktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "self-test",
    });
    assert.equal(worktree.ok, true);
    const worktreePreserve = await cleanupWorktree(worktree, "never", false);
    assert.equal(worktreePreserve.cleanup, "skipped");
    await writeFile(path.join(worktree.path, "src", "allowed.txt"), "worktree allowed\n", "utf8");
    let worktreeChangedFiles = await gitChangedFiles(worktree.path);
    const worktreePlan = validateSingleLockPlan({
      agent: "builder",
      task: "Validate worktree allowed file.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    worktreePlan.cwd = tempDir;
    let worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.deepEqual(worktreeValidation.disallowedFiles, []);
    await writeFile(path.join(worktree.path, "src", "forbidden.txt"), "worktree forbidden\n", "utf8");
    worktreeChangedFiles = await gitChangedFiles(worktree.path);
    worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.equal(changedFileValidationErrorType(worktreeValidation), "forbidden_file_changed");
    assert.ok(worktreeValidation.disallowedFiles.includes("src/forbidden.txt"));
    const worktreeDiff = await collectWorktreeDiff(worktree);
    assert.ok(worktreeDiff.changedFiles.includes("src/allowed.txt"));
    const worktreeCleanup = await cleanupWorktree(worktree, "always", true);
    assert.notEqual(worktreeCleanup.cleanup, "failed");

    const ignoredSourceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-ignored-source",
    });
    assert.equal(ignoredSourceWorktree.ok, true, JSON.stringify(ignoredSourceWorktree, null, 2));
    await writeFile(path.join(ignoredSourceWorktree.path, "src", "allowed.txt"), "reviewable tracked output\n", "utf8");
    await writeFile(path.join(ignoredSourceWorktree.path, "ignored.log"), "unique ignored recovery bytes\n", "utf8");
    const ignoredSourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: ignoredSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(ignoredSourcePreview.ok, false);
    assert.equal(ignoredSourcePreview.errorType, "integration_source_unrepresentable");
    assert.deepEqual(ignoredSourcePreview.ignoredFiles, ["ignored.log"]);
    assert.equal(await readFile(path.join(ignoredSourceWorktree.path, "ignored.log"), "utf8"), "unique ignored recovery bytes\n");
    assert.equal((await lstat(ignoredSourceWorktree.path)).isDirectory(), true);
    assert.equal((await cleanupWorktree(ignoredSourceWorktree, "always", true)).cleanup, "success");

    const subdirectorySourceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-subdirectory-source",
    });
    assert.equal(subdirectorySourceWorktree.ok, true, JSON.stringify(subdirectorySourceWorktree, null, 2));
    await writeFile(path.join(subdirectorySourceWorktree.path, "src", "allowed.txt"), "nested-only partial patch attempt\n", "utf8");
    const subdirectorySourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: path.join(subdirectorySourceWorktree.path, "src"),
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(subdirectorySourcePreview.ok, false);
    assert.equal(subdirectorySourcePreview.errorType, "integration_source_invalid");
    assert.match(subdirectorySourcePreview.error, /canonical Git worktree root/i);
    assert.equal((await cleanupWorktree(subdirectorySourceWorktree, "always", true)).cleanup, "success");

    const sourceIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-source-index-identity",
    });
    assert.equal(sourceIndexWorktree.ok, true, JSON.stringify(sourceIndexWorktree, null, 2));
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], sourceIndexWorktree.path, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source worktree B\n", "utf8");
    const sourceIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: sourceIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(sourceIndexPreview.ok, true, JSON.stringify(sourceIndexPreview, null, 2));
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source staged C\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], sourceIndexWorktree.path, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source worktree B\n", "utf8");
    const sourceIndexChanged = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: sourceIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: sourceIndexPreview.previewReceipt,
    });
    assert.equal(sourceIndexChanged.ok, false);
    assert.equal(sourceIndexChanged.errorType, "integration_preview_stale");
    assert.match(sourceIndexChanged.error, /sourceStateSha256/i);
    assert.equal((await cleanupWorktree(sourceIndexWorktree, "always", true)).cleanup, "success");

    const integrationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-pass",
    });
    assert.equal(integrationWorktree.ok, true);
    await writeFile(path.join(integrationWorktree.path, "src", "allowed.txt"), "integrated allowed\n", "utf8");
    const integrationBlocker = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["src/api.txt"],
    });
    assert.equal(integrationBlocker.ok, true);
    const integrationWhileWriterActive = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      reviewed: true,
    });
    assert.equal(integrationWhileWriterActive.ok, false);
    assert.equal(integrationWhileWriterActive.errorType, "integration_lock_conflict");
    await releaseHardLock(
      integrationBlocker.lock.id,
      integrationBlocker.lock.token,
      integrationBlocker.lock.paths,
      tempDir
    );
    const integrationDryRun = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      dryRun: true,
    });
    assert.equal(integrationDryRun.ok, true);
    assert.equal(integrationDryRun.status, "dry_run_passed");
    assert.deepEqual(integrationDryRun.changedFiles, ["src/allowed.txt"]);
    const integrationApplied = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      reviewed: true,
      previewReceipt: integrationDryRun.previewReceipt,
    });
    assert.equal(integrationApplied.ok, true, JSON.stringify(integrationApplied, null, 2));
    assert.equal(integrationApplied.status, "applied");
    assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8")).replace(/\r\n/g, "\n"), "integrated allowed\n");
    assert.deepEqual(
      (await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.split(/\r?\n/).filter((line) => line.trim()),
      [" M src/allowed.txt"]
    );
    await writeFile(path.join(tempDir, "src", "api.txt"), "changed between integration and cleanup\n", "utf8");
    assert.match(
      await integrationCleanupTargetStateError(tempDir, integrationApplied.integratedTargetStateSha256),
      /target changed after reviewed integration/i
    );
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal(await integrationCleanupTargetStateError(tempDir, integrationApplied.integratedTargetStateSha256), "");
    assert.equal((await cleanupWorktree(integrationWorktree, "always", true)).cleanup, "success");

    await runCommand("git", ["add", "."], tempDir, 1000 * 15);
    const integrationCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "integrated allowed"], tempDir, 1000 * 15);
    assert.equal(integrationCommit.exitCode, 0);

    const cleanupRaceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-cleanup-race",
    });
    assert.equal(cleanupRaceWorktree.ok, true, JSON.stringify(cleanupRaceWorktree, null, 2));
    await writeFile(path.join(cleanupRaceWorktree.path, "src", "allowed.txt"), "cleanup race integrated bytes\n", "utf8");
    const cleanupRacePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: cleanupRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(cleanupRacePreview.ok, true, JSON.stringify(cleanupRacePreview, null, 2));
    const cleanupRaceResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: cleanupRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: cleanupRacePreview.previewReceipt,
      cleanupAfterSuccess: true,
      beforeCleanupHook: async ({ targetCwd }) => {
        const competingLock = await acquireHardLock({
          owner: "codex",
          agent: "builder",
          cwd: targetCwd,
          lockType: "write",
          paths: ["src/allowed.txt"],
        });
        assert.equal(competingLock.ok, false, "The serial integration lease must remain held through cleanup authorization and deletion.");
        assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).exitCode, 0);
      },
    });
    assert.equal(cleanupRaceResult.ok, true, JSON.stringify(cleanupRaceResult, null, 2));
    assert.equal(cleanupRaceResult.sourceCleanup.cleanup, "retained_for_review");
    assert.equal(cleanupRaceResult.sourceCleanup.reason, "integration_target_changed_before_cleanup");
    assert.equal((await lstat(cleanupRaceWorktree.path)).isDirectory(), true);
    assert.equal((await cleanupWorktree(cleanupRaceWorktree, "always", true)).cleanup, "success");

    const targetIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-target-index-identity",
    });
    assert.equal(targetIndexWorktree.ok, true, JSON.stringify(targetIndexWorktree, null, 2));
    await writeFile(path.join(targetIndexWorktree.path, "src", "allowed.txt"), "target index source patch\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "target staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target worktree B\n", "utf8");
    const targetIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: targetIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      dryRun: true,
    });
    assert.equal(targetIndexPreview.ok, true, JSON.stringify(targetIndexPreview, null, 2));
    await writeFile(path.join(tempDir, "src", "api.txt"), "target staged C\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target worktree B\n", "utf8");
    const targetIndexChanged = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: targetIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      reviewed: true,
      previewReceipt: targetIndexPreview.previewReceipt,
    });
    assert.equal(targetIndexChanged.ok, false);
    assert.equal(targetIndexChanged.errorType, "integration_preview_stale");
    assert.match(targetIndexChanged.error, /targetStateSha256/i);
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(targetIndexWorktree, "always", true)).cleanup, "success");

    const validationIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-index-identity",
    });
    assert.equal(validationIndexWorktree.ok, true, JSON.stringify(validationIndexWorktree, null, 2));
    await writeFile(path.join(validationIndexWorktree.path, "src", "allowed.txt"), "validation index source patch\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "validation staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "validation worktree B\n", "utf8");
    const validationIndexBefore = await captureGitIndexIdentity(tempDir);
    assert.equal(validationIndexBefore.ok, true);
    const validationIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      dryRun: true,
    });
    assert.equal(validationIndexPreview.ok, true, JSON.stringify(validationIndexPreview, null, 2));
    const validationIndexResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      reviewed: true,
      previewReceipt: validationIndexPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "api.txt"), "validation staged C\n", "utf8");
        assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        await writeFile(path.join(targetCwd, "src", "api.txt"), "validation worktree B\n", "utf8");
      },
    });
    assert.equal(validationIndexResult.ok, false);
    assert.equal(validationIndexResult.errorType, "integration_validation_mutated_unapproved_files", JSON.stringify(validationIndexResult, null, 2));
    assert.equal(validationIndexResult.validationIndexChanged, true);
    const validationIndexAfter = await captureGitIndexIdentity(tempDir);
    assert.equal(validationIndexAfter.ok, true);
    assert.notEqual(validationIndexAfter.indexSha256, validationIndexBefore.indexSha256);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal(await readFile(path.join(tempDir, "src", "api.txt"), "utf8"), "validation worktree B\n");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(validationIndexWorktree, "always", true)).cleanup, "success");

    await writeFile(path.join(tempDir, "src", "delete-me.txt"), "delete rollback sentinel\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/delete-me.txt"], tempDir, 1000 * 15)).exitCode, 0);
    const deletionFixtureCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add deletion fixture"], tempDir, 1000 * 15);
    assert.equal(deletionFixtureCommit.exitCode, 0, deletionFixtureCommit.stderr);

    const deleteSuccessWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-delete-success" });
    assert.equal(deleteSuccessWorktree.ok, true, JSON.stringify(deleteSuccessWorktree, null, 2));
    await rm(path.join(deleteSuccessWorktree.path, "src", "delete-me.txt"));
    const deleteSuccessPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteSuccessWorktree.path,
      allowedEdits: ["src/delete-me.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(deleteSuccessPreview.ok, true, JSON.stringify(deleteSuccessPreview, null, 2));
    const deleteSuccessIndexBefore = await captureGitIndexIdentity(tempDir);
    const deleteSuccessResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteSuccessWorktree.path,
      allowedEdits: ["src/delete-me.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: deleteSuccessPreview.previewReceipt,
    });
    assert.equal(deleteSuccessResult.ok, true, JSON.stringify(deleteSuccessResult, null, 2));
    await assert.rejects(lstat(path.join(tempDir, "src", "delete-me.txt")), (error) => error?.code === "ENOENT");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, deleteSuccessIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(deleteSuccessWorktree, "always", true)).cleanup, "success");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/delete-me.txt"], tempDir, 1000 * 15)).exitCode, 0);

    const deleteRollbackWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-delete-rollback" });
    assert.equal(deleteRollbackWorktree.ok, true, JSON.stringify(deleteRollbackWorktree, null, 2));
    await rm(path.join(deleteRollbackWorktree.path, "src", "delete-me.txt"));
    await writeFile(path.join(deleteRollbackWorktree.path, "src", "allowed.txt"), "delete rollback validation failure \n", "utf8");
    const deleteRollbackPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteRollbackWorktree.path,
      allowedEdits: ["src/delete-me.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(deleteRollbackPreview.ok, true, JSON.stringify(deleteRollbackPreview, null, 2));
    const deleteRollbackIndexBefore = await captureGitIndexIdentity(tempDir);
    const deleteRollbackResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteRollbackWorktree.path,
      allowedEdits: ["src/delete-me.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: deleteRollbackPreview.previewReceipt,
    });
    assert.equal(deleteRollbackResult.ok, false);
    assert.equal(deleteRollbackResult.errorType, "validation_command_failed");
    assert.equal(deleteRollbackResult.rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "delete-me.txt"), "utf8"), "delete rollback sentinel\n");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, deleteRollbackIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(deleteRollbackWorktree, "always", true)).cleanup, "success");

    const createRollbackWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-create-rollback" });
    assert.equal(createRollbackWorktree.ok, true, JSON.stringify(createRollbackWorktree, null, 2));
    await writeFile(path.join(createRollbackWorktree.path, "src", "created-rollback.txt"), "new file validation failure \n", "utf8");
    await writeFile(path.join(createRollbackWorktree.path, "src", "allowed.txt"), "tracked validation failure \n", "utf8");
    const createRollbackPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: createRollbackWorktree.path,
      allowedEdits: ["src/created-rollback.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(createRollbackPreview.ok, true, JSON.stringify(createRollbackPreview, null, 2));
    const createRollbackIndexBefore = await captureGitIndexIdentity(tempDir);
    const createRollbackResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: createRollbackWorktree.path,
      allowedEdits: ["src/created-rollback.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: createRollbackPreview.previewReceipt,
    });
    assert.equal(createRollbackResult.ok, false);
    assert.equal(createRollbackResult.errorType, "validation_command_failed");
    assert.equal(createRollbackResult.rollback.rollback, "success");
    await assert.rejects(lstat(path.join(tempDir, "src", "created-rollback.txt")), (error) => error?.code === "ENOENT");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, createRollbackIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(createRollbackWorktree, "always", true)).cleanup, "success");

    const staleSourceWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-source" });
    assert.equal(staleSourceWorktree.ok, true);
    await writeFile(path.join(staleSourceWorktree.path, "src", "allowed.txt"), "previewed source\n", "utf8");
    const staleSourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleSourcePreview.ok, true);
    await writeFile(path.join(staleSourceWorktree.path, "src", "allowed.txt"), "changed after preview\n", "utf8");
    const staleSourceApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleSourcePreview.previewReceipt,
    });
    assert.equal(staleSourceApply.ok, false);
    assert.equal(staleSourceApply.errorType, "integration_preview_stale");
    assert.equal((await cleanupWorktree(staleSourceWorktree, "always", true)).cleanup, "success");

    const staleTargetWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-target" });
    assert.equal(staleTargetWorktree.ok, true);
    await writeFile(path.join(staleTargetWorktree.path, "src", "allowed.txt"), "target preview\n", "utf8");
    const staleTargetPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleTargetWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleTargetPreview.ok, true);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target changed after preview\n", "utf8");
    const staleTargetApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleTargetWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleTargetPreview.previewReceipt,
    });
    assert.equal(staleTargetApply.ok, false);
    assert.equal(staleTargetApply.errorType, "integration_preview_stale");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(staleTargetWorktree, "always", true)).cleanup, "success");

    const staleIgnoredWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-ignored-target" });
    assert.equal(staleIgnoredWorktree.ok, true);
    await writeFile(path.join(staleIgnoredWorktree.path, "src", "allowed.txt"), "ignored target preview\n", "utf8");
    const staleIgnoredPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleIgnoredWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleIgnoredPreview.ok, true, JSON.stringify(staleIgnoredPreview, null, 2));
    await writeFile(path.join(tempDir, "ignored.log"), "changed ignored target after preview\n", "utf8");
    const staleIgnoredApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleIgnoredWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleIgnoredPreview.previewReceipt,
    });
    assert.equal(staleIgnoredApply.ok, false);
    assert.equal(staleIgnoredApply.errorType, "integration_preview_stale");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    await writeFile(path.join(tempDir, "ignored.log"), "second\n", "utf8");
    assert.equal((await cleanupWorktree(staleIgnoredWorktree, "always", true)).cleanup, "success");

    const untrackedIntegrationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-untracked",
    });
    assert.equal(untrackedIntegrationWorktree.ok, true);
    await writeFile(path.join(untrackedIntegrationWorktree.path, "src", "new.txt"), "new file\n", "utf8");
    const untrackedIntegrationPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: untrackedIntegrationWorktree.path,
      allowedEdits: ["src/new.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(untrackedIntegrationPreview.ok, true);
    const untrackedIntegration = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: untrackedIntegrationWorktree.path,
      allowedEdits: ["src/new.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: untrackedIntegrationPreview.previewReceipt,
    });
    assert.equal(untrackedIntegration.ok, true, JSON.stringify(untrackedIntegration, null, 2));
    assert.deepEqual(untrackedIntegration.changedFiles, ["src/new.txt"]);
    assert.equal((await readFile(path.join(tempDir, "src", "new.txt"), "utf8")).replace(/\r\n/g, "\n"), "new file\n");
    assert.equal((await cleanupWorktree(untrackedIntegrationWorktree, "always", true)).cleanup, "success");
    assert.equal((await runCommand("git", ["add", "--", "src/new.txt"], tempDir, 1000 * 15)).exitCode, 0);
    const untrackedIntegrationCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "integrate new file"], tempDir, 1000 * 15);
    assert.equal(untrackedIntegrationCommit.exitCode, 0);

    const integrationRejectWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-reject",
    });
    assert.equal(integrationRejectWorktree.ok, true);
    await writeFile(path.join(integrationRejectWorktree.path, "src", "blocked.txt"), "blocked integration\n", "utf8");
    const integrationRejected = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationRejectWorktree.path,
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(integrationRejected.ok, false);
    assert.ok(integrationRejected.disallowedFiles.includes("src/blocked.txt"));
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");
    assert.equal((await cleanupWorktree(integrationRejectWorktree, "always", true)).cleanup, "success");

    const validationFailWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-fail",
    });
    assert.equal(validationFailWorktree.ok, true);
    await writeFile(path.join(validationFailWorktree.path, "src", "allowed.txt"), "validation should roll back \n", "utf8");
    const validationFailPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationFailWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(validationFailPreview.ok, true);
    const validationFailed = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationFailWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: validationFailPreview.previewReceipt,
    });
    assert.equal(validationFailed.ok, false);
    assert.equal(validationFailed.errorType, "validation_command_failed");
    assert.equal(validationFailed.rollback.rollback, "success");
    assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8")).replace(/\r\n/g, "\n"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.trim(), "");
    assert.equal((await cleanupWorktree(validationFailWorktree, "always", true)).cleanup, "success");

    const externalOwnershipBaseline = await captureRollbackBaseline(tempDir);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "bridge-owned exact bytes\n", "utf8");
    const bridgeOwnedSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "concurrent external bytes\n", "utf8");
    const ambiguousRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: externalOwnershipBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: bridgeOwnedSnapshot,
    });
    assert.equal(ambiguousRollback.rollback, "not_attempted_unattributed_changes");
    assert.deepEqual(ambiguousRollback.unresolvedFiles, ["src/allowed.txt"]);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "concurrent external bytes\n");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.trim(), "");

    const validationMutationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-content-mutation",
    });
    assert.equal(validationMutationWorktree.ok, true, JSON.stringify(validationMutationWorktree, null, 2));
    await writeFile(path.join(validationMutationWorktree.path, "src", "allowed.txt"), "reviewed exact content\n", "utf8");
    const validationMutationCommand = "git diff --check";
    const validationMutationPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationMutationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: validationMutationCommand,
      dryRun: true,
    });
    assert.equal(validationMutationPreview.ok, true);
    const validationMutationResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationMutationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: validationMutationCommand,
      reviewed: true,
      previewReceipt: validationMutationPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "allowed.txt"), "concurrent validation bytes\n", "utf8");
      },
    });
    assert.equal(validationMutationResult.ok, false);
    assert.equal(validationMutationResult.errorType, "integration_validation_mutated_reviewed_files");
    assert.deepEqual(validationMutationResult.contentMismatches, ["src/allowed.txt"]);
    assert.deepEqual(validationMutationResult.rollback.unresolvedFiles, ["src/allowed.txt"]);
    assert.notEqual(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(validationMutationWorktree, "always", true)).cleanup, "success");

    const extraPathWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-extra-allowed-path",
    });
    assert.equal(extraPathWorktree.ok, true, JSON.stringify(extraPathWorktree, null, 2));
    await writeFile(path.join(extraPathWorktree.path, "src", "allowed.txt"), "reviewed path-set content\n", "utf8");
    const extraPathPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: extraPathWorktree.path,
      allowedEdits: ["src"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(extraPathPreview.ok, true);
    const extraPathResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: extraPathWorktree.path,
      allowedEdits: ["src"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: extraPathPreview.previewReceipt,
      beforeApplyHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "external-extra.txt"), "external path\n", "utf8");
      },
    });
    assert.equal(extraPathResult.ok, false);
    assert.equal(extraPathResult.errorType, "integration_preview_stale");
    assert.deepEqual(extraPathResult.unexpectedTargetChanges, ["src/external-extra.txt"]);
    assert.equal(await readFile(path.join(tempDir, "src", "external-extra.txt"), "utf8"), "external path\n");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    await rm(path.join(tempDir, "src", "external-extra.txt"), { force: true });
    assert.equal((await cleanupWorktree(extraPathWorktree, "always", true)).cleanup, "success");

    const stagedOwnershipWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-index-ownership",
    });
    assert.equal(stagedOwnershipWorktree.ok, true, JSON.stringify(stagedOwnershipWorktree, null, 2));
    await writeFile(path.join(stagedOwnershipWorktree.path, "src", "allowed.txt"), "reviewed index content\n", "utf8");
    const stagedOwnershipPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: stagedOwnershipWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(stagedOwnershipPreview.ok, true);
    let concurrentCachedDiff = "";
    const stagedOwnershipResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: stagedOwnershipWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: stagedOwnershipPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        concurrentCachedDiff = (await runCommand("git", ["diff", "--cached", "--binary", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).stdout;
      },
    });
    assert.equal(stagedOwnershipResult.ok, false);
    assert.equal(stagedOwnershipResult.errorType, "integration_validation_mutated_unapproved_files");
    assert.equal(stagedOwnershipResult.validationIndexChanged, true);
    assert.deepEqual(stagedOwnershipResult.indexReset.ownershipMismatches, ["src/allowed.txt"]);
    assert.equal((await runCommand("git", ["diff", "--cached", "--binary", "--", "src/allowed.txt"], tempDir, 1000 * 15)).stdout, concurrentCachedDiff);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(stagedOwnershipWorktree, "always", true)).cleanup, "success");

    const headRaceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-head-race",
    });
    assert.equal(headRaceWorktree.ok, true, JSON.stringify(headRaceWorktree, null, 2));
    await writeFile(path.join(headRaceWorktree.path, "src", "allowed.txt"), "reviewed before head race\n", "utf8");
    const headRacePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: headRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(headRacePreview.ok, true);
    const headRaceResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: headRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: headRacePreview.previewReceipt,
      beforeApplyHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "api.txt"), "concurrent committed head\n", "utf8");
        assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        const committed = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "concurrent head"], targetCwd, 1000 * 15);
        assert.equal(committed.exitCode, 0, committed.stderr);
      },
    });
    assert.equal(headRaceResult.ok, false);
    assert.equal(headRaceResult.errorType, "integration_target_head_changed");
    assert.notEqual(headRaceResult.actualTargetHead, headRacePreview.targetHead);
    assert.deepEqual(headRaceResult.unexpectedTargetChanges, ["src/api.txt"]);
    assert.equal(headRaceResult.rollback.rollback, "not_attempted_unattributed_changes");
    const headRaceCleanup = await runCommand("git", ["reset", "--hard", headRacePreview.targetHead], tempDir, 1000 * 30);
    assert.equal(headRaceCleanup.exitCode, 0, headRaceCleanup.stderr);
    assert.equal((await cleanupWorktree(headRaceWorktree, "always", true)).cleanup, "success");

    if (process.platform === "win32") {
      assert.equal((await runCommand("git", ["config", "core.autocrlf", "true"], tempDir, 1000 * 15)).exitCode, 0);
      const crlfIntegrationWorktree = await createWorktreeForJob({
        cwd: tempDir,
        agent: "builder",
        jobId: "integration-crlf-checkout",
      });
      assert.equal(crlfIntegrationWorktree.ok, true, JSON.stringify(crlfIntegrationWorktree, null, 2));
      await writeFile(path.join(crlfIntegrationWorktree.path, "src", "allowed.txt"), "reviewed crlf bytes\r\n", "utf8");
      const crlfIntegrationPreview = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfIntegrationWorktree.path,
        allowedEdits: ["src/allowed.txt"],
        validationCommand: "git diff --check",
        dryRun: true,
      });
      assert.equal(crlfIntegrationPreview.ok, true, JSON.stringify(crlfIntegrationPreview, null, 2));
      const crlfIntegrationResult = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfIntegrationWorktree.path,
        allowedEdits: ["src/allowed.txt"],
        validationCommand: "git diff --check",
        reviewed: true,
        previewReceipt: crlfIntegrationPreview.previewReceipt,
      });
      assert.equal(crlfIntegrationResult.ok, true, JSON.stringify(crlfIntegrationResult, null, 2));
      assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"))).equals(Buffer.from("reviewed crlf bytes\r\n")), true);
      assert.equal((await cleanupWorktree(crlfIntegrationWorktree, "always", true)).cleanup, "success");
      assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);

      const crlfNewFileWorktree = await createWorktreeForJob({
        cwd: tempDir,
        agent: "builder",
        jobId: "integration-crlf-new-file",
      });
      assert.equal(crlfNewFileWorktree.ok, true, JSON.stringify(crlfNewFileWorktree, null, 2));
      await writeFile(path.join(crlfNewFileWorktree.path, "src", "crlf-new.txt"), "new reviewed file\n", "utf8");
      const crlfNewFilePreview = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfNewFileWorktree.path,
        allowedEdits: ["src/crlf-new.txt"],
        validationCommand: "git diff --check",
        dryRun: true,
      });
      assert.equal(crlfNewFilePreview.ok, true, JSON.stringify(crlfNewFilePreview, null, 2));
      const crlfNewFileResult = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfNewFileWorktree.path,
        allowedEdits: ["src/crlf-new.txt"],
        validationCommand: "git diff --check",
        reviewed: true,
        previewReceipt: crlfNewFilePreview.previewReceipt,
      });
      assert.equal(crlfNewFileResult.ok, true, JSON.stringify(crlfNewFileResult, null, 2));
      assert.equal((await readFile(path.join(tempDir, "src", "crlf-new.txt"))).equals(Buffer.from("new reviewed file\r\n")), true);
      assert.equal((await cleanupWorktree(crlfNewFileWorktree, "always", true)).cleanup, "success");
      await rm(path.join(tempDir, "src", "crlf-new.txt"), { force: true });

      assert.equal((await runCommand("git", ["config", "core.autocrlf", "false"], tempDir, 1000 * 15)).exitCode, 0);
      assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
      assert.deepEqual(await gitChangedFiles(tempDir), []);
    }

    const writerPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit allowed only.",
      write: true,
      lockedPaths: ["src"],
      allowedEdits: ["src/allowed.txt"],
    }).lockPlan;
    writerPlan.cwd = tempDir;

    let rollbackBaseline = await captureRollbackBaseline(tempDir);
    let beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent changed\n", "utf8");
    let afterRun = await gitChangedFileSnapshot(tempDir);
    let changedFiles = changedFilesBetween(beforeRun, afterRun);
    let validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/blocked.txt"]);
    let rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    const scopeWriterPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit through Scope Contract.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    scopeWriterPlan.cwd = tempDir;
    assert.deepEqual(scopeWriterPlan.allowedEdits, ["src/allowed.txt"]);

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "outside scope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "changed_file_validation_error");
    assert.deepEqual(validation.scopeViolations.outsideWriteScope, ["src/blocked.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "changed forbidden\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "forbidden_file_changed");
    assert.deepEqual(validation.scopeViolations.forbiddenFiles, ["src/forbidden.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "forbidden.txt"), "utf8"), "secret\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "created.txt"), "nope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/created.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    await assert.rejects(readFile(path.join(tempDir, "src", "created.txt"), "utf8"));

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await rm(path.join(tempDir, "src", "blocked.txt"), { force: true });
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    await writeFile(path.join(tempDir, "src", "blocked.txt"), "user dirty\n", "utf8");
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent overwrote dirty file\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "user dirty\n");

    const readOnlyPlan = validateSingleLockPlan({
      agent: "reviewer",
      task: "Review only.",
    }).lockPlan;
    readOnlyPlan.cwd = tempDir;
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "reviewer edited\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: readOnlyPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/allowed.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
  } finally {
    selfTestProgress("cleanup");
    stateDirectoryOverride = previousStateDirectoryOverride;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(tempStateDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(outsideLinkTarget, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(nonGitFixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }

  selfTestProgress("end");
  console.log("Self tests passed.");
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
  const serverPath = path.resolve(process.argv[1] || __filename);
  if (expected) {
    const actual = await sha256File(serverPath);
    if (actual !== expected) {
      throw new Error(`Bridge release integrity check failed. Expected ${expected}, got ${actual}.`);
    }
  }
  await verifyReleaseManifest(path.dirname(serverPath));
  if (String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim()) {
    const pluginModeError = immutableReleasePluginModeError();
    if (pluginModeError) {
      throw new Error(`Bridge release integrity check failed. ${pluginModeError}`);
    }
    const sourcePathError = releaseManagedSourcePathError(path.dirname(serverPath));
    if (sourcePathError) {
      throw new Error(`Bridge release integrity check failed. ${sourcePathError}`);
    }
  }
}

async function reconcileQueueStateAtStartup() {
  if (effectiveQueueMode() !== "sqlite") return;
  const stateRoot = effectiveBridgeStateDirectory();
  const candidates = [path.join(stateRoot, "bridge-state.sqlite")];
  try {
    const projectsDir = path.join(stateRoot, "projects");
    for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        candidates.push(path.join(projectsDir, entry.name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000;");
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
      KNOWN_STATE_DB_PATHS.add(dbPath);
      reconcileStaleQueueRecords(db);
      const resumableRows = db.prepare(`
        SELECT job_id, cwd, status, agent, mode, created_at, started_at, finished_at,
               owner_instance_id, owner_process_id, owner_generation, heartbeat_at, lease_expires_at,
               cancellation_requested_at, child_process_id, child_process_started_at, revision,
               idempotency_key, record_json, request_encrypted
        FROM opencode_jobs
        WHERE status IN ('held', 'pending', 'planned', 'blocked')
          AND request_encrypted IS NOT NULL AND request_encrypted <> ''
      `).all();
      for (const row of resumableRows) {
        if (QUEUE_JOBS.has(row.job_id)) continue;
        try {
          const now = Date.now();
          const jobLeaseExpiresAt = Date.parse(row.lease_expires_at || "");
          const owner = row.owner_instance_id
            ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(row.owner_instance_id)
            : null;
          const ownerLeaseExpiresAt = Date.parse(owner?.lease_expires_at || "");
          if ((Number.isFinite(jobLeaseExpiresAt) && jobLeaseExpiresAt > now)
            || (Number.isFinite(ownerLeaseExpiresAt) && ownerLeaseExpiresAt > now)) continue;
          const decoded = tryPersistedQueueRecordFromRow(row);
          if (!decoded.ok) {
            const failedAt = new Date().toISOString();
            const invalidRecord = {
              ...decoded.record,
              status: "failed",
              finishedAt: failedAt,
              errorType: "queue_record_invalid",
              errorReason: "The persisted queue record was invalid and could not be resumed.",
            };
            db.prepare(`
              UPDATE opencode_jobs SET status = 'failed', finished_at = ?, updated_at = ?, record_json = ?, revision = revision + 1
              WHERE job_id = ? AND revision = ? AND status IN ('held', 'pending', 'planned', 'blocked')
            `).run(failedAt, failedAt, JSON.stringify(sanitizePersistedValue(invalidRecord)), row.job_id, Number(row.revision || 0));
            logEvent("warn", "queue.record_invalid", { jobId: row.job_id, dbPath });
            continue;
          }
          const snapshot = decoded.record;
          const request = await decryptQueueRequest(row.request_encrypted, row.job_id);
          if (request?.internalQueueContractorProof) {
            request.internalQueueContractorProof = makeInternalQueueContractorProof(row.job_id);
          }
          const resumed = {
            ...snapshot,
            jobId: row.job_id,
            request,
            task: request?.task || "",
            status: row.status === "held" ? "held" : "pending",
            ownerInstanceId: BRIDGE_INSTANCE_ID,
            ownerProcessId: process.pid,
            ownerGeneration: randomBytes(12).toString("hex"),
            heartbeatAt: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
            revision: Number(row.revision || 0),
          };
          const takeover = db.prepare(`
            UPDATE opencode_jobs SET status = ?, owner_instance_id = ?, owner_process_id = ?, owner_generation = ?,
              heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, record_json = ?, revision = revision + 1
            WHERE job_id = ? AND revision = ? AND status IN ('held', 'pending', 'planned', 'blocked')
          `).run(
            resumed.status, resumed.ownerInstanceId, resumed.ownerProcessId, resumed.ownerGeneration,
            resumed.heartbeatAt, resumed.leaseExpiresAt, resumed.heartbeatAt,
            JSON.stringify(queueRecordSnapshot({ ...resumed, revision: resumed.revision + 1 })),
            resumed.jobId, resumed.revision
          );
          if (Number(takeover.changes || 0) === 1) {
            resumed.revision += 1;
            QUEUE_JOBS.set(resumed.jobId, resumed);
          }
        } catch (error) {
          logEvent("warn", "queue.request_resume_failed", { jobId: row.job_id, dbPath, error: redactSensitiveText(error.message || String(error)) });
          const failedAt = new Date().toISOString();
          const snapshot = {
            ...persistedQueueRecordFromRow(row),
            status: "failed",
            finishedAt: failedAt,
            errorType: "queue_request_recovery_failed",
            errorReason: "The encrypted queue request could not be recovered. Restore the matching queue-request.key backup before retrying.",
          };
          db.prepare(`
            UPDATE opencode_jobs SET status = 'failed', finished_at = ?, updated_at = ?, record_json = ?, revision = revision + 1
            WHERE job_id = ? AND revision = ? AND status IN ('held', 'pending', 'planned', 'blocked')
          `).run(failedAt, failedAt, JSON.stringify(sanitizePersistedValue(snapshot)), row.job_id, Number(row.revision || 0));
        }
      }
    } catch (error) {
      logEvent("warn", "queue.startup_recovery_failed", { dbPath, error: error.message || String(error) });
    } finally {
      if (db) closeDb(db);
    }
  }
  ensureQueueHeartbeatTimer();
  if (QUEUE_JOBS.size) scheduleQueue();
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

if (process.argv.includes("--provider-lease-worker")) {
  await verifyReleaseIntegrity();
  await runProviderLeaseWorker();
} else if (process.argv.includes("--verify-plugin-policy")) {
  await verifyReleaseIntegrity();
  process.stdout.write(`${JSON.stringify(await verifyExternalPluginPolicy(process.argv[process.argv.indexOf("--verify-plugin-policy") + 1] || process.cwd()))}\n`);
} else if (process.argv.includes("--self-test")) {
  await verifyReleaseIntegrity();
  await runSelfTests();
} else {
  await verifyReleaseIntegrity();
  const startupPluginPolicy = await verifyExternalPluginPolicy(process.cwd());
  if (!startupPluginPolicy.ok) {
    throw new Error(`OpenCode external plugin policy rejected startup: ${startupPluginPolicy.error}`);
  }
  await reconcileQueueStateAtStartup();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
