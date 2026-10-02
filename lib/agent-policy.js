// Agent model selection, permission metadata and routing policy.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { createHash } from "node:crypto";
import { normalizePathForCompare, isPathInside } from "./paths.js";
import { DEFAULT_FORBIDDEN_EDIT_PATHS, MODEL_IDENTIFIER_PATTERN, MODEL_NAME_PATTERN } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createAgentPolicyRuntime({
  USER_HOME_DIR,
  SAFE_AGENT_BASH_ALLOW_PATTERNS,
  CONTRACTOR_ALLOWED_SUBAGENTS,
  WRITE_CAPABLE_AGENTS,
  MCP_SANITIZED_READER_AGENT,
  MCP_SANITIZED_READER_PROFILE,
  MCP_SANITIZED_READER_PROMPT_SHA256,
  MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  activeModelOverrideAllowlist,
}) {

function normalizedPermissionRules(permissions, permission) {
  return permissions
    .filter((rule) => rule?.permission === permission)
    .map((rule) => ({
      permission,
      pattern: String(rule?.pattern || ""),
      action: String(rule?.action || "").toLowerCase(),
    }));
}

function permissionDefaultAndOverrides(permissions, permission) {
  const rules = normalizedPermissionRules(permissions, permission);
  let wildcardIndex = -1;
  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index].pattern === "*") wildcardIndex = index;
  }
  return {
    rules,
    defaultAction: wildcardIndex >= 0 ? rules[wildcardIndex].action : "",
    overrides: wildcardIndex >= 0 ? rules.slice(wildcardIndex + 1) : rules,
  };
}

function effectivePermissionProfileRules(permissions, isolatedRuntimeRoot = "") {
  const permissionNames = [...new Set(
    permissions.map((rule) => String(rule?.permission || "")).filter(Boolean)
  )].sort();
  return permissionNames.map((permission) => {
    const summary = permissionDefaultAndOverrides(permissions, permission);
    return {
      permission,
      defaultAction: summary.defaultAction,
      overrides: summary.overrides.map((rule) => ({
        pattern: approvedOpenCodeToolOutputPattern(rule.pattern, isolatedRuntimeRoot)
          ? "<opencode-tool-output>"
          : rule.pattern,
        action: rule.action,
      })),
    };
  });
}

function approvedOpenCodeToolOutputPattern(patternValue, additionalDataRoot = "") {
  const raw = String(patternValue || "").trim().replace(/[\\/]+\*$/, "");
  if (!raw || /[*?{}[\]!]/.test(raw)) return false;
  const approvedRoots = [
    path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output"),
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "tool-output") : "",
    additionalDataRoot ? path.join(additionalDataRoot, "opencode", "tool-output") : "",
  ].filter(Boolean).map((item) => path.resolve(item));
  return approvedRoots.some((root) => path.resolve(raw) === root);
}

function normalizeAgentDebugMetadata(parsed, expectedName = "", { isolatedRuntimeRoot = "" } = {}) {
  if (!parsed || typeof parsed !== "object" || (expectedName && parsed.name !== expectedName)) {
    return null;
  }
  const permissions = Array.isArray(parsed.permission) ? parsed.permission : [];
  const tools = parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {};
  const editToolKeys = ["apply_patch", "edit", "write"].filter((key) => Object.hasOwn(tools, key));
  const permissionDeniedAll = (permission) => {
    const summary = permissionDefaultAndOverrides(permissions, permission);
    return summary.defaultAction === "deny" && summary.overrides.every((rule) => rule.action === "deny");
  };
  const logicalToolDenied = (toolNames, permissionName) => toolNames.some((key) => Object.hasOwn(tools, key) && tools[key] === false)
    || permissionDeniedAll(permissionName);
  const external = permissionDefaultAndOverrides(permissions, "external_directory");
  const externalUnsafeOverrides = external.overrides.filter((rule) => rule.action !== "deny" && !approvedOpenCodeToolOutputPattern(rule.pattern, isolatedRuntimeRoot));
  const edit = permissionDefaultAndOverrides(permissions, "edit");
  const editProtectedDenyPatterns = edit.overrides
    .filter((rule) => rule.action === "deny")
    .map((rule) => rule.pattern);
  const bash = permissionDefaultAndOverrides(permissions, "bash");
  const bashAutomaticAllowUnsafe = bash.overrides.filter((rule) => rule.action === "allow" && !SAFE_AGENT_BASH_ALLOW_PATTERNS.has(rule.pattern));
  const task = permissionDefaultAndOverrides(permissions, "task");
  const taskAllowedPatterns = task.overrides.filter((rule) => rule.action === "allow").map((rule) => rule.pattern.toLowerCase());
  const taskDelegationAllowlistSafe = task.defaultAction === "deny"
    && task.overrides.every((rule) => rule.action === "deny" || (rule.action === "allow" && CONTRACTOR_ALLOWED_SUBAGENTS.has(rule.pattern.toLowerCase())))
    && taskAllowedPatterns.length === CONTRACTOR_ALLOWED_SUBAGENTS.size
    && [...CONTRACTOR_ALLOWED_SUBAGENTS].every((agent) => taskAllowedPatterns.includes(agent));
  const canEdit = editToolKeys.length === 0 || editToolKeys.some((key) => tools[key] !== false);
  const protectedEditsDenied = !canEdit || (
    edit.defaultAction === "allow"
    && edit.overrides.length === DEFAULT_FORBIDDEN_EDIT_PATHS.length
    && edit.overrides.every((rule) => rule.action === "deny" && DEFAULT_FORBIDDEN_EDIT_PATHS.includes(rule.pattern))
    && DEFAULT_FORBIDDEN_EDIT_PATHS.every((pattern) => editProtectedDenyPatterns.includes(pattern))
  );
  const normalized = {
    name: String(parsed.name || expectedName || ""),
    mode: String(parsed.mode || "unknown"),
    provider: String(parsed.model?.providerID || ""),
    model: String(parsed.model?.modelID || ""),
    variant: String(parsed.variant || ""),
    temperature: Number(parsed.temperature),
    promptSha256: createHash("sha256").update(String(parsed.prompt || "").trim()).digest("hex"),
    canEdit,
    protectedEditsDenied,
    canDelegate: !logicalToolDenied(["task"], "task"),
    taskDelegationAllowlistSafe,
    taskAllowedPatterns,
    externalDirectoryDenied: external.defaultAction === "deny" && externalUnsafeOverrides.length === 0,
    externalDirectoryDefaultAction: external.defaultAction,
    externalAllowedPatterns: external.overrides.filter((rule) => rule.action === "allow").map((rule) => rule.pattern),
    bashDenied: logicalToolDenied(["bash"], "bash"),
    bashAutomaticAllowSafe: logicalToolDenied(["bash"], "bash")
      || (["ask", "deny"].includes(bash.defaultAction) && bashAutomaticAllowUnsafe.length === 0),
    bashDefaultAction: bash.defaultAction,
    bashAllowedPatterns: bash.overrides.filter((rule) => rule.action === "allow").map((rule) => rule.pattern),
    webDenied: logicalToolDenied(["webfetch", "web_fetch"], "webfetch")
      && logicalToolDenied(["websearch", "web_search"], "websearch"),
    skillDenied: logicalToolDenied(["skill"], "skill"),
  };
  const normalizedPermissionProfileRules = effectivePermissionProfileRules(permissions, isolatedRuntimeRoot);
  const normalizedPermissionProfileTools = Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)));
  normalized.permissionRulesSha256 = createHash("sha256").update(JSON.stringify(normalizedPermissionProfileRules)).digest("hex");
  normalized.toolsSha256 = createHash("sha256").update(JSON.stringify(normalizedPermissionProfileTools)).digest("hex");
  normalized.permissionProfileSha256 = createHash("sha256").update(JSON.stringify({
    permissions: normalizedPermissionProfileRules,
    tools: normalizedPermissionProfileTools,
    prompt: String(parsed.prompt || "").trim(),
    temperature: Number(parsed.temperature),
  })).digest("hex");
  return normalized;
}

function parseModelAllowlistEntry(entry) {
  const raw = String(entry || "").trim();
  if (!raw) return null;
  const at = raw.lastIndexOf("@");
  const modelPart = at > 0 ? raw.slice(0, at).trim() : raw;
  const variant = at > 0 ? raw.slice(at + 1).trim() : "";
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) return null;
  if (at > 0 && !variant) return null;
  const provider = modelPart.slice(0, slash).trim();
  const model = modelPart.slice(slash + 1).trim();
  // The same identifier rules as modelRequirementSchema: these become CLI arguments.
  if (!MODEL_IDENTIFIER_PATTERN.test(provider) || !MODEL_NAME_PATTERN.test(model) || (variant && !MODEL_IDENTIFIER_PATTERN.test(variant))) return null;
  return { provider, model, variant };
}

// A job may select a model through scopeContract.modelRequirement only when the
// operator listed that provider/model (optionally pinned to one variant) in
// CODEX_OPENCODE_MODEL_ALLOWLIST. The selection becomes an explicit --model/--variant
// pin that is attested against runtime evidence exactly like the managed profile.
// The sanitized reader keeps its exact profile and is never overridable.
function allowlistedModelOverride(modelRequirement, agent = "", allowlist = activeModelOverrideAllowlist()) {
  if (!modelRequirement?.provider || !modelRequirement?.model) return null;
  if (String(agent || "").trim().toLowerCase() === MCP_SANITIZED_READER_AGENT.toLowerCase()) return null;
  for (const entry of Array.isArray(allowlist) ? allowlist : []) {
    const parsed = parseModelAllowlistEntry(entry);
    if (!parsed || parsed.provider !== modelRequirement.provider || parsed.model !== modelRequirement.model) continue;
    if (parsed.variant && modelRequirement.variant !== undefined && parsed.variant !== modelRequirement.variant) continue;
    return {
      provider: parsed.provider,
      model: parsed.model,
      variant: modelRequirement.variant !== undefined ? String(modelRequirement.variant) : parsed.variant,
      source: "operator_allowlist",
    };
  }
  return null;
}

function applyModelOverrideToMetadata(metadata, override) {
  if (!metadata || !override) return metadata;
  return {
    ...metadata,
    provider: override.provider,
    model: override.model,
    // The managed profile's variant belongs to the managed model; a different overridden
    // model runs with the override's variant only (none when the allowlist pins none).
    variant: override.variant || "",
    modelSelection: "operator_allowlist_override",
    profileProvider: metadata.provider,
    profileModel: metadata.model,
    profileVariant: metadata.variant,
  };
}

function effectiveReadOnlyMetadataError(metadataResult, lockPlan, {
  expectedAgent = "",
  expectedMode = "",
  expectedMetadata = null,
  allowDelegation = false,
  requireBashDenied = false,
  requireSkillDenied = false,
  modelRequirement = lockPlan?.scopeContract?.modelRequirement || null,
} = {}) {
  if (!metadataResult?.ok || !metadataResult.metadata) {
    return {
      errorType: metadataResult?.errorType || "agent_metadata_unavailable",
      error: metadataResult?.error || "Effective OpenCode agent permissions could not be attested.",
    };
  }
  const metadata = metadataResult.metadata;
  if (!metadata.provider || !metadata.model) {
    return {
      errorType: "agent_model_unattested",
      error: "Effective OpenCode agent metadata did not provide an exact provider and model, so the bridge cannot pin or attest execution.",
    };
  }
  if (modelRequirement && !allowlistedModelOverride(modelRequirement, metadata.name) && (
    metadata.provider !== modelRequirement.provider
    || metadata.model !== modelRequirement.model
    || (modelRequirement.variant !== undefined && metadata.variant !== modelRequirement.variant)
  )) {
    return {
      errorType: "configured_model_requirement_mismatch",
      error: `The attested managed profile uses ${metadata.provider}/${metadata.model} (variant ${metadata.variant || "unspecified"}), but the scope requires ${modelRequirement.provider}/${modelRequirement.model}${modelRequirement.variant !== undefined ? ` (variant ${modelRequirement.variant})` : ""}. No agent was spawned with a substitute model.`,
      suggestedFix: "Select an attested managed profile matching the requested model requirement, or explicitly revise the requirement. The bridge will not override the managed profile.",
    };
  }
  if (expectedAgent && metadata.name !== expectedAgent) {
    return {
      errorType: "agent_metadata_changed",
      error: `Effective agent name changed before execution (expected ${expectedAgent}, received ${metadata.name || "missing"}).`,
    };
  }
  if (!['primary', 'all'].includes(metadata.mode) || (expectedMode && metadata.mode !== expectedMode)) {
    return {
      errorType: "agent_mode_unattested",
      error: `Effective mode for ${metadata.name} is ${metadata.mode || "missing"}; the bridge requires the resolved primary/all mode${expectedMode ? ` ${expectedMode}` : ""}.`,
    };
  }
  if (expectedMetadata && (
    metadata.provider !== expectedMetadata.provider
    || metadata.model !== expectedMetadata.model
    || metadata.variant !== expectedMetadata.variant
    || metadata.permissionProfileSha256 !== expectedMetadata.permissionProfileSha256
  )) {
    const changedFields = [
      "provider",
      "model",
      "variant",
      "permissionRulesSha256",
      "toolsSha256",
      "promptSha256",
      "temperature",
      "permissionProfileSha256",
    ].filter((field) => metadata[field] !== expectedMetadata[field]);
    return {
      errorType: "agent_metadata_changed",
      error: `Effective model or permission metadata for ${metadata.name} changed between discovery and the final pre-spawn attestation (changed fields: ${changedFields.join(", ") || "unknown"}).`,
    };
  }
  if (
    (!allowDelegation && metadata.canDelegate)
    || (allowDelegation && (!metadata.canDelegate || !metadata.taskDelegationAllowlistSafe))
    || !metadata.externalDirectoryDenied
    || !metadata.webDenied
    || !metadata.bashAutomaticAllowSafe
    || (requireBashDenied && !metadata.bashDenied)
    || (requireSkillDenied && !metadata.skillDenied)
    || (metadata.canEdit && !metadata.protectedEditsDenied)
  ) {
    return {
      errorType: "agent_permissions_unsafe",
      error: `Effective permissions for ${metadata.name} cross the bridge boundary (canDelegate=${metadata.canDelegate}, taskDelegationAllowlistSafe=${metadata.taskDelegationAllowlistSafe}, externalDirectoryDenied=${metadata.externalDirectoryDenied}, webDenied=${metadata.webDenied}, bashDenied=${metadata.bashDenied}, bashAutomaticAllowSafe=${metadata.bashAutomaticAllowSafe}, skillDenied=${metadata.skillDenied}, protectedEditsDenied=${metadata.protectedEditsDenied}).`,
    };
  }
  if (lockPlan?.lockType === "read" && metadata.canEdit) {
    return {
      errorType: "read_only_agent_permissions_unsafe",
      error: `Effective permissions for ${metadata.name} are not read-only (canEdit=${metadata.canEdit}).`,
    };
  }
  return null;
}

function contractorNestedAgentMetadataError(agent, metadataResult) {
  if (!metadataResult?.ok || !metadataResult.metadata) {
    return {
      errorType: metadataResult?.errorType || "contractor_nested_agent_unattested",
      error: metadataResult?.error || `Contractor nested agent ${agent} could not be attested.`,
    };
  }
  const metadata = metadataResult.metadata;
  const writeCapable = WRITE_CAPABLE_AGENTS.has(String(agent || "").toLowerCase());
  if (
    !["primary", "all", "subagent"].includes(metadata.mode)
    || metadata.canDelegate
    || !metadata.externalDirectoryDenied
    || !metadata.webDenied
    || metadata.bashDefaultAction !== "deny"
    || !metadata.bashAutomaticAllowSafe
    || (writeCapable ? (!metadata.canEdit || !metadata.protectedEditsDenied) : metadata.canEdit)
  ) {
    return {
      errorType: "contractor_nested_agent_permissions_unsafe",
      error: `Contractor nested agent ${agent} crosses the bridge boundary (mode=${metadata.mode}, canEdit=${metadata.canEdit}, canDelegate=${metadata.canDelegate}, externalDirectoryDenied=${metadata.externalDirectoryDenied}, webDenied=${metadata.webDenied}, bashDefaultAction=${metadata.bashDefaultAction}, bashAutomaticAllowSafe=${metadata.bashAutomaticAllowSafe}, protectedEditsDenied=${metadata.protectedEditsDenied}).`,
    };
  }
  return null;
}

function sanitizedExternalPatternInsideRoot(patternValue, root, isolatedRuntimeRoot = "") {
  const raw = String(patternValue || "").trim().replace(/[\\/]+\*$/, "");
  if (!raw || /[*?{}[\]!]/.test(raw)) return false;
  const resolved = path.resolve(raw);
  const normalized = normalizePathForCompare(resolved);
  const toolOutputSuffix = normalizePathForCompare(path.join("opencode", "tool-output"));
  const isolatedTempSuffix = normalizePathForCompare(path.join("tmp", "opencode"));
  const insideWorkspaceToolOutput = root
    && isPathInside(path.resolve(root), resolved)
    && normalized.endsWith(toolOutputSuffix);
  const insideIsolatedRuntime = isolatedRuntimeRoot
    && isPathInside(path.resolve(isolatedRuntimeRoot), resolved)
    && (normalized.endsWith(toolOutputSuffix) || normalized.endsWith(isolatedTempSuffix));
  return Boolean(insideWorkspaceToolOutput || insideIsolatedRuntime);
}

function sanitizedAgentMetadataError(metadataResult, root = "") {
  if (!metadataResult?.ok || !metadataResult.metadata) {
    return {
      errorType: metadataResult?.errorType || "agent_metadata_unavailable",
      error: metadataResult?.error || "Sanitized-workspace effective agent permissions could not be attested.",
    };
  }
  const metadata = metadataResult.metadata;
  if (
    metadata.name !== MCP_SANITIZED_READER_AGENT
    || metadata.mode !== "all"
    || metadata.provider !== MCP_SANITIZED_READER_PROFILE.provider
    || metadata.model !== MCP_SANITIZED_READER_PROFILE.model
    || metadata.variant !== MCP_SANITIZED_READER_PROFILE.variant
    || metadata.temperature !== 0
    || metadata.promptSha256 !== MCP_SANITIZED_READER_PROMPT_SHA256
    || metadata.canEdit
    || metadata.canDelegate
    || metadata.externalDirectoryDefaultAction !== "deny"
    || metadata.externalAllowedPatterns.some((pattern) => !sanitizedExternalPatternInsideRoot(pattern, root, metadataResult.isolatedRuntimeRoot || ""))
    || !metadata.bashDenied
    || !metadata.webDenied
    || !metadata.skillDenied
  ) {
    return {
      errorType: "sanitized_workspace_agent_unsafe",
      error: `Sanitized execution requires exact role ${MCP_SANITIZED_READER_AGENT} (${MCP_SANITIZED_READER_PROFILE.provider}/${MCP_SANITIZED_READER_PROFILE.model}, ${MCP_SANITIZED_READER_PROFILE.variant}) with edit/task/external/shell/web/skill denial.`,
    };
  }
  return null;
}

function agentMetadataPolicyOptions(resolution, lockPlan, expectedMetadata = null) {
  const contractorDelegation = lockPlan?.orchestratorMode === "contractor"
    && lockPlan?.contractorAuthorizationVerified
    && String(resolution?.actualAgent || "").toLowerCase() === MCP_CONTRACTOR_ORCHESTRATOR_AGENT.toLowerCase();
  return {
    expectedAgent: resolution?.actualAgent || "",
    expectedMode: resolution?.actualAgentMode || resolution?.requestedAgentMode || "",
    expectedMetadata,
    modelRequirement: lockPlan?.scopeContract?.modelRequirement || null,
    allowDelegation: contractorDelegation,
    requireBashDenied: contractorDelegation,
    requireSkillDenied: contractorDelegation,
  };
}

function sanitizedRoutingPolicyError(job, resolution, executionCwd = "") {
  if (!job?.sanitizedWorkspace) return null;
  const expectedRoot = path.resolve(job.sanitizedWorkspace.root);
  if (
    resolution?.actualAgent !== MCP_SANITIZED_READER_AGENT
    || resolution?.actualAgentMode !== "all"
    || resolution?.proxyUsed
    || resolution?.fallbackUsed
    || (executionCwd && path.resolve(executionCwd) !== expectedRoot)
  ) {
    return {
      errorType: "sanitized_workspace_agent_unsafe",
      error: `Sanitized execution must use ${MCP_SANITIZED_READER_AGENT} directly in exact manifest root ${expectedRoot}, without fallback, proxying, or bridge worktrees.`,
    };
  }
  return null;
}

function availableAgentLabels(agents) {
  return [...agents.entries()].map(([name, mode]) => `${name} (${mode})`).sort();
}

  return {
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
  };
}
