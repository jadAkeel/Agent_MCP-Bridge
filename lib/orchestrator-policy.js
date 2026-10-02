// Orchestrator policy: write intent, orchestrator modes, contractor authorization and the orchestrator routing rules.
// Extracted from server.js in modularization round M-001.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeList, normalizeLockPathList } from "./paths.js";
import { findSerialOnlyMatches, normalizeScopeContract } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createOrchestratorPolicyRuntime({ CONFIG, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, MCP_ORCHESTRATOR_AGENT, ORCHESTRATOR_AGENT_ALIASES, QUEUE_CAPABILITY_KEY, READ_ONLY_PARALLEL_AGENTS, WRITE_CAPABLE_AGENTS }) {
let selfTestContractorAuthorizationSha256 = "";
// Self-test access to the state above (the module owns it since the split).
function getSelfTestContractorAuthorizationSha256() { return selfTestContractorAuthorizationSha256; }
function setSelfTestContractorAuthorizationSha256(value) { selfTestContractorAuthorizationSha256 = value; }

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
  return { hasWriteIntent, isOrchestratorAgent, isManagedReadOnlyAgent, readOnlyRoutingPolicyError, requestedOrchestratorMode, normalizeOrchestratorModeValue, userAuthorizedOrchestrator, contractorAuthorizationToken, effectiveContractorAuthorizationSha256, internalQueueContractorBinding, currentContractorAuthorizationSha256, makeInternalQueueContractorProof, internalQueueContractorProofValid, contractorAuthorizationValid, hasOrchestratorBoundedWriterShape, normalizeOrchestratorMode, detectsOrchestratorInternalWriterRequest, detectsLargeOrchestratorTask, detectsPlanningIntent, findOrchestratorGlobalFileMatches, orchestratorPolicyError, getSelfTestContractorAuthorizationSha256, setSelfTestContractorAuthorizationSha256 };
}
