// Scope Contract schemas, normalization, and project policy defaults.
// Extracted from server.js in modularization round M-001.

import { z } from "zod";
import { normalizeList, uniqueList, normalizeLockPath, normalizeLockPathList, normalizeLockPathListForCwd, mergePathLists, pathOverlapsSerialPattern } from "./paths.js";

// Agent timeouts are handed to the supervisor's setTimeout, which cannot represent more
// than 2^31-1 ms; larger values failed as a supervisor protocol error. 24 h is the ceiling.
export const MAX_AGENT_TIMEOUT_MS = 1000 * 60 * 60 * 24;

const SERIAL_ONLY_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.*.json",
  "vite.config.*",
  "next.config.*",
  "nuxt.config.*",
  "webpack.config.*",
  "rollup.config.*",
  "eslint.config.*",
  ".eslintrc*",
  ".prettierrc*",
  ".env",
  ".env.*",
  "README.md",
  "CHANGELOG.md",
  "src/index.*",
  "src/main.*",
  "src/app.*",
  "src/routes/**",
  "app/routes/**",
  "db/migrations/**",
  "prisma/schema.prisma",
]);

export const DEFAULT_FORBIDDEN_EDIT_PATHS = Object.freeze([
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "secrets/**",
  "**/secrets/**",
  // Git's control surface: config, hooks, refs and a worktree's .git pointer file. Git never
  // lists these as changes, so a deny rule is the only guard. The managed writer profiles
  // (opencode/agents/builder.md, debugger.md) must list exactly this set.
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
]);

const DEFAULT_SHARED_FILE_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "packages/shared/**",
  "schema/**",
  "migrations/**",
  // Python and CMake manifests are shared the same way (found porting a C++ repo to Python).
  // overlaps() compares path prefixes, not globs, so these are literal root paths.
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "requirements-dev.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "conftest.py",
  "tests/conftest.py",
  "CMakeLists.txt",
]);

export const scopePathSetSchema = z
  .object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
  })
  .strict();

export const scopeValidationSchema = z
  .object({
    changedFilesMustBeWithinWriteScope: z.boolean().optional(),
    forbiddenFilesMustNotChange: z.boolean().optional(),
    readOnlyMustNotChangeFiles: z.boolean().optional(),
  })
  .strict();

const scopeTimeoutPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
    readOnlyTimeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
    writeTimeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
  })
  .strict();

// These values become `opencode run` arguments. A value starting with "-" (variant
// "--attach=http://host:4096") was parsed by the CLI as an extra option.
// Model IDs may contain "/" (openrouter/anthropic/...); they still may not start with "-".
export const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const modelRequirementSchema = z.object({
  provider: z.string().trim().min(1).max(256).regex(MODEL_IDENTIFIER_PATTERN),
  model: z.string().trim().min(1).max(256).regex(MODEL_NAME_PATTERN),
  variant: z.string().trim().min(1).max(128).regex(MODEL_IDENTIFIER_PATTERN).optional(),
  requireRuntimeEvidence: z.boolean().optional(),
}).strict();

export const scopeContractSchema = z
  .object({
    agent: z.string().optional(),
    role: z.string().optional(),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
    shared: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    scope: scopePathSetSchema.optional(),
    actions: z.array(z.string()).optional(),
    validation: scopeValidationSchema.optional(),
    timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
    timeoutPolicy: scopeTimeoutPolicySchema.optional(),
    modelRequirement: modelRequirementSchema.optional().describe("Pin provider/model[@variant] for this job. It must be in CODEX_OPENCODE_MODEL_ALLOWLIST or match the managed profile."),
    selfCheckCommands: z.array(z.string().min(1).max(500)).max(8).optional().describe("Write jobs (builder/debugger) only: exact commands the BRIDGE runs in the worktree after the agent finished, before validationCommand, e.g. \"node tools/validate.cjs out/x.json\". A failing one gives the agent another run with its output (selfCheckPasses). The agent itself gets no shell. Each must pass the validationCommand rules (CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST, no shell, npx or inline eval) and be written without wildcards, quotes or shell operators; a script it runs must not be in allowedEdits."),
  })
  .strict();

const projectAgentPolicySchema = z
  .object({
    version: z.literal(1),
    owners: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    sharedFiles: z.array(z.string()).optional(),
    contracts: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    finalValidationCommand: z.string().max(4096).optional(),
    requiresWorktrees: z.boolean().optional(),
  })
  .strict();

function normalizeScopeMode(mode) {
  const raw = String(mode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return "";
  }
  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }
  if (raw === "write" || raw === "read") {
    return raw;
  }
  return raw;
}

function rawScopeContractInput(job) {
  if (job?.scopeContract) {
    return job.scopeContract;
  }

  if (job?.delegation?.scopeContract) {
    return job.delegation.scopeContract;
  }

  if (job?.scope && !Array.isArray(job.scope) && typeof job.scope === "object") {
    return {
      agent: job.agent,
      role: job.role,
      mode: job.mode,
      scope: job.scope,
      actions: job.actions,
      validation: job.validation,
      timeoutMs: job.timeoutMs,
      timeoutPolicy: job.timeoutPolicy,
    };
  }

  if (job?.delegation?.scope && !Array.isArray(job.delegation.scope) && typeof job.delegation.scope === "object") {
    return {
      agent: job.agent,
      role: job.delegation.role,
      mode: job.delegation.mode,
      scope: job.delegation.scope,
      actions: job.delegation.actions,
      validation: job.delegation.validation,
      timeoutMs: job.delegation.timeoutMs,
      timeoutPolicy: job.delegation.timeoutPolicy,
    };
  }

  return null;
}

export function normalizeScopeContract(job) {
  const raw = rawScopeContractInput(job);
  if (!raw) {
    return null;
  }

  const normalized = {
    ...(raw.modelRequirement !== undefined ? { modelRequirement: modelRequirementSchema.parse(raw.modelRequirement) } : {}),
    // Q-009: kept as written (validated by selfCheckCommandsError, matched exactly by OpenCode).
    ...(raw.selfCheckCommands !== undefined ? { selfCheckCommands: Array.isArray(raw.selfCheckCommands) ? raw.selfCheckCommands.map((item) => String(item).trim()) : raw.selfCheckCommands } : {}),
    agent: String(raw.agent || job.agent || "").trim(),
    role: String(raw.role || "").trim(),
    mode: normalizeScopeMode(raw.mode),
    scope: {
      read: mergePathLists(raw.scope?.read, raw.read),
      write: mergePathLists(raw.scope?.write, raw.write),
      forbidden: mergePathLists(raw.scope?.forbidden, raw.forbidden),
    },
    allowedEdits: normalizeLockPathList(raw.allowedEdits),
    shared: normalizeLockPathList(raw.shared),
    serialOnly: normalizeLockPathList(raw.serialOnly),
    validationCommand: String(raw.validationCommand || "").trim(),
    actions: uniqueList(raw.actions).map((action) => String(action).trim()).filter(Boolean),
    validation: {
      changedFilesMustBeWithinWriteScope: raw.validation?.changedFilesMustBeWithinWriteScope !== false,
      forbiddenFilesMustNotChange: raw.validation?.forbiddenFilesMustNotChange !== false,
      readOnlyMustNotChangeFiles: raw.validation?.readOnlyMustNotChangeFiles !== false,
    },
    timeoutMs: raw.timeoutMs || raw.timeoutPolicy?.timeoutMs || null,
    timeoutPolicy: {
      readOnlyTimeoutMs: raw.timeoutPolicy?.readOnlyTimeoutMs || null,
      writeTimeoutMs: raw.timeoutPolicy?.writeTimeoutMs || null,
    },
  };

  if (!normalized.mode) {
    normalized.mode = normalized.scope.write.length ? "write" : "read";
  }

  const scopeRoot = job.cwd || "";
  normalized.scope.read = normalizeLockPathListForCwd(normalized.scope.read, scopeRoot);
  normalized.scope.write = normalizeLockPathListForCwd(normalized.scope.write, scopeRoot);
  normalized.scope.forbidden = normalizeLockPathListForCwd(normalized.scope.forbidden, scopeRoot);
  normalized.allowedEdits = normalizeLockPathListForCwd(normalized.allowedEdits, scopeRoot);
  normalized.shared = normalizeLockPathListForCwd(normalized.shared, scopeRoot);
  normalized.serialOnly = normalizeLockPathListForCwd(normalized.serialOnly, scopeRoot);

  return normalized;
}

function ownerMatchesPolicyValue(owner, value) {
  if (!owner) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).includes(owner);
  }

  return String(value || "").trim() === owner;
}

export function normalizeProjectAgentPolicy(raw = {}) {
  const parsed = projectAgentPolicySchema.parse(raw);
  const owners = parsed.owners && typeof parsed.owners === "object" && !Array.isArray(parsed.owners) ? parsed.owners : {};
  return {
    owners: Object.fromEntries(
      Object.entries(owners)
        .map(([pathKey, owner]) => [normalizeLockPath(pathKey), owner])
        .filter(([pathKey]) => Boolean(pathKey))
    ),
    sharedFiles: mergePathLists(DEFAULT_SHARED_FILE_PATHS, parsed.sharedFiles, parsed.contracts),
    serialOnly: mergePathLists(SERIAL_ONLY_PATHS, parsed.serialOnly),
    forbiddenEdits: mergePathLists(DEFAULT_FORBIDDEN_EDIT_PATHS, parsed.forbiddenEdits),
    finalValidationCommand: String(parsed.finalValidationCommand || "").trim(),
    requiresWorktrees: parsed.requiresWorktrees === true ? true : null,
  };
}

export function applyProjectPolicyToJobs(jobs = [], policy = null, { allowOwnershipInference = false } = {}) {
  if (!policy) {
    return jobs.map((job) => ({ ...job }));
  }

  return jobs.map((job) => {
    const owner = String(job.owner || job.role || job.agent || "").trim();
    const ownedPaths = Object.entries(policy.owners)
      .filter(([, value]) => ownerMatchesPolicyValue(owner, value))
      .map(([ownedPath]) => ownedPath);
    const otherOwnerPaths = Object.entries(policy.owners)
      .filter(([, value]) => !ownerMatchesPolicyValue(owner, value))
      .map(([ownedPath]) => ownedPath);
    const writeScope = normalizeLockPathList(job.scope?.write || job.scopeContract?.scope?.write || job.delegation?.scopeContract?.scope?.write);
    const shouldInferWriteScope = allowOwnershipInference && (job.write === true || writeScope.length) && ownedPaths.length;
    const inferredWritePaths = shouldInferWriteScope ? ownedPaths : [];
    const lockedPaths = firstNonEmptyList(job.lockedPaths, job.ownedPaths, job.delegation?.lockedPaths, inferredWritePaths);
    const allowedEdits = firstNonEmptyList(job.allowedEdits, job.delegation?.allowedEdits, writeScope, inferredWritePaths);
    const forbiddenEdits = mergePathLists(
      job.forbiddenEdits,
      job.delegation?.forbiddenEdits,
      policy.forbiddenEdits,
      policy.sharedFiles,
      policy.serialOnly,
      otherOwnerPaths
    );
    const sharedFiles = mergePathLists(job.sharedFiles, job.delegation?.sharedFiles, policy.sharedFiles);
    const serialOnly = mergePathLists(job.serialOnly, job.delegation?.serialOnly, policy.serialOnly);
    const scopeContract = rawScopeContractInput(job)
      ? job.scopeContract
      : shouldInferWriteScope
        ? {
            agent: job.agent,
            role: owner,
            mode: "write",
            read: mergePathLists(ownedPaths, sharedFiles),
            write: allowedEdits,
            allowedEdits,
            forbidden: forbiddenEdits,
            shared: sharedFiles,
            serialOnly,
            validationCommand: job.validationCommand || job.delegation?.validationCommand || "",
          }
        : job.scopeContract;

    return {
      ...job,
      lockedPaths,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      scopeContract,
      policyOwner: owner,
      policyOwnedPaths: ownedPaths,
    };
  });
}

export function scopeContractPathInputs(scopeContract) {
  return scopeContract
    ? scopeContract.scope.read.concat(
      scopeContract.scope.write,
      scopeContract.scope.forbidden,
      scopeContract.allowedEdits,
      scopeContract.shared,
      scopeContract.serialOnly
    )
    : [];
}

// B-151: the paths a job may change (write, allowedEdits, shared, serialOnly): the scope the
// source-dirt policy unrelated_ok protects. Read and forbidden paths are not in it: an uncommitted
// file there only means the agent reads HEAD's version, which a worktree does anyway.
export function scopeContractWritePathInputs(scopeContract) {
  return scopeContract
    ? scopeContract.scope.write.concat(
      scopeContract.allowedEdits,
      scopeContract.shared,
      scopeContract.serialOnly
    )
    : [];
}

export function scopeContractTimeout(scopeContract, lockType) {
  if (!scopeContract) {
    return null;
  }
  if (scopeContract.timeoutMs) {
    return scopeContract.timeoutMs;
  }
  return lockType === "read"
    ? scopeContract.timeoutPolicy.readOnlyTimeoutMs
    : scopeContract.timeoutPolicy.writeTimeoutMs;
}

export function formatScopeContractForPrompt(scopeContract, spell = (values) => normalizeList(values)) {
  if (!scopeContract) {
    return "";
  }
  const list = (values) => spell(values).join(", ");

  return [
    `Agent: ${scopeContract.agent || "not specified"}`,
    `Role: ${scopeContract.role || "not specified"}`,
    `Mode: ${scopeContract.mode}`,
    ...(scopeContract.modelRequirement ? [
      `Required managed provider/model: ${scopeContract.modelRequirement.provider}/${scopeContract.modelRequirement.model}`,
      `Required variant: ${scopeContract.modelRequirement.variant || "not specified"}`,
      `Runtime model evidence required: ${scopeContract.modelRequirement.requireRuntimeEvidence ? "yes" : "no"}`,
    ] : []),
    `Read paths: ${scopeContract.scope.read.length ? list(scopeContract.scope.read) : "not specified"}`,
    `Write paths: ${scopeContract.scope.write.length ? list(scopeContract.scope.write) : "none"}`,
    `Allowed edits: ${scopeContract.allowedEdits.length ? list(scopeContract.allowedEdits) : "not specified"}`,
    `Forbidden paths: ${scopeContract.scope.forbidden.length ? list(scopeContract.scope.forbidden) : "none"}`,
    `Shared/frozen paths: ${scopeContract.shared.length ? list(scopeContract.shared) : "none"}`,
    `Serial-only paths: ${scopeContract.serialOnly.length ? list(scopeContract.serialOnly) : "none"}`,
    `Validation command: ${scopeContract.validationCommand || "not specified"}`,
    ...(Array.isArray(scopeContract.selfCheckCommands) && scopeContract.selfCheckCommands.length ? [
      "Self-checks: when you finish, the bridge runs these commands in your working directory (you cannot run them). If one fails, you get another run with its output; fix what it reports then:",
      ...scopeContract.selfCheckCommands.map((command) => `- ${command}`),
    ] : []),
    `Allowed actions: ${scopeContract.actions.length ? scopeContract.actions.join(", ") : "not specified"}`,
    `Validation changedFilesMustBeWithinWriteScope: ${scopeContract.validation.changedFilesMustBeWithinWriteScope ? "yes" : "no"}`,
    `Validation forbiddenFilesMustNotChange: ${scopeContract.validation.forbiddenFilesMustNotChange ? "yes" : "no"}`,
    `Validation readOnlyMustNotChangeFiles: ${scopeContract.validation.readOnlyMustNotChangeFiles ? "yes" : "no"}`,
  ].join("\n");
}

export function findSerialOnlyMatches(paths, serialOnlyPaths = []) {
  const matches = [];
  const seen = new Set();
  const patterns = mergePathLists(SERIAL_ONLY_PATHS, serialOnlyPaths);
  for (const candidate of normalizeLockPathList(paths)) {
    for (const pattern of patterns) {
      if (pathOverlapsSerialPattern(candidate, pattern)) {
        const label = `${candidate} (${pattern})`;
        if (!seen.has(label)) {
          matches.push(label);
          seen.add(label);
        }
      }
    }
  }
  return matches;
}

export function firstNonEmptyList(...values) {
  for (const value of values) {
    const list = normalizeLockPathList(value);
    if (list.length) {
      return list;
    }
  }
  return [];
}
