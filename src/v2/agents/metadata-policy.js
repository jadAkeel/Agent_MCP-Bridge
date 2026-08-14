import { createHash } from "node:crypto";
import path from "node:path";

export function createAgentMetadataPolicy({
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
  getEnv = () => process.env,
}) {
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
    const env = getEnv();
    const approvedRoots = [
      path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output"),
      env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "opencode", "tool-output") : "",
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
    const logicalToolDenied = (toolNames, permissionName) => {
      const presentAliases = toolNames.filter((key) => Object.hasOwn(tools, key));
      return (presentAliases.length > 0 && presentAliases.every((key) => tools[key] === false))
        || permissionDeniedAll(permissionName);
    };
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

  function effectiveReadOnlyMetadataError(metadataResult, lockPlan, {
    expectedAgent = "",
    expectedMode = "",
    expectedMetadata = null,
    allowDelegation = false,
    requireBashDenied = false,
    requireSkillDenied = false,
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
    const hasPathSuffix = (value, suffix) => value === suffix || (
      value.endsWith(suffix)
      && /[\\/]/.test(value[value.length - suffix.length - 1] || "")
    );
    const insideWorkspaceToolOutput = root
      && isPathInside(path.resolve(root), resolved)
      && hasPathSuffix(normalized, toolOutputSuffix);
    const insideIsolatedRuntime = isolatedRuntimeRoot
      && isPathInside(path.resolve(isolatedRuntimeRoot), resolved)
      && (hasPathSuffix(normalized, toolOutputSuffix) || hasPathSuffix(normalized, isolatedTempSuffix));
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

  return {
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
  };
}
