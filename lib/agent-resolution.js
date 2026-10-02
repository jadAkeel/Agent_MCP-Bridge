// Agent resolution: managed agent definitions, subagent proxy prompts and the requested-to-actual agent mapping.
// Extracted from server.js in modularization round M-001.

import { readFile } from "node:fs/promises";
import path from "node:path";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createAgentResolutionRuntime({ DEFAULT_SUBAGENT_PROXY_AGENT, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, MCP_SANITIZED_READER_AGENT, OPENCODE_AGENT_DIR, ORCHESTRATOR_AGENT_ALIASES, availableAgentLabels, debugAgentExists, listAvailableAgents, normalizeOrchestratorModeValue, sanitizeAgentName }) {
async function readAgentDefinition(agent) {
  try {
    return await readFile(path.join(OPENCODE_AGENT_DIR, `${agent}.md`), "utf8");
  } catch {
    return "";
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
        error: `OpenCode agent "${agent}" is a subagent. This OpenCode CLI version does not run subagents as top-level agents through "opencode run --agent ${agent}". Use subagentStrategy "proxy" to run it through "${DEFAULT_SUBAGENT_PROXY_AGENT}".`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    // "direct" used to return the subagent as the actual agent, which could never succeed:
    // `opencode run --agent <subagent>` falls back to the default agent, so the attested
    // profile is not the one that would run, and the pre-spawn attestation requires a
    // primary/all mode. It is rejected with the reason instead of failing later.
    if (normalizedStrategy === "direct") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" is a subagent, and subagentStrategy "direct" cannot run it: "opencode run --agent ${agent}" falls back to the default agent, which the bridge cannot attest as the requested role. Use subagentStrategy "proxy" to run it through "${DEFAULT_SUBAGENT_PROXY_AGENT}".`,
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
  return { readAgentDefinition, buildSubagentProxyPrompt, resolveAgent };
}
