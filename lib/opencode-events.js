// OpenCode event parsing, response integrity, usage and tool weight estimates.
// Extracted from server.js in modularization round M-001.

import { redactSensitiveText, redactLikelySecrets } from "./redaction.js";
import { providerDiagnosticLinesFromStderr, providerErrorTypeFromText, providerErrorTypeFromStructuredEvent, providerErrorTypeFromDiagnosticLine, syntheticProviderQuotaNotice, retryAfterMsFromText } from "./rate-limit.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createOpenCodeEventRuntime({
  CONFIG,
}) {

function detectsOpenCodeFallback(stderr) {
  return /agent\s+"[^"]+"\s+is a subagent,\s+not a primary agent\.\s+Falling back to default agent/i.test(stderr || "");
}

function modelEvidenceFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const authoritative = event.type === "message.updated"
    ? (event.properties?.info || event.info || event.data?.info)
    : event.type === "assistant_message"
      ? (event.message || event.data)
      : null;
  if (!authoritative || authoritative.role !== "assistant") return null;
  const provider = authoritative.providerID || authoritative.providerId || authoritative.provider_id;
  const model = authoritative.modelID || authoritative.modelId || authoritative.model_id;
  if (typeof provider === "string" && typeof model === "string" && provider && model) {
    return { provider: provider.slice(0, 120), model: model.slice(0, 240) };
  }
  return null;
}

// Token usage from OpenCode's step_finish events (one per model step, subagent sessions included).
function emptyOpenCodeUsage() {
  // Field names avoid "token" and "input": sanitizePersistedValue drops or hashes those keys.
  return { steps: 0, inputCount: 0, outputCount: 0, reasoningCount: 0, cacheReadCount: 0, cacheWriteCount: 0, cost: 0, rootSteps: 0 };
}

function addStepFinishUsage(usage, event, rootSessionId) {
  const tokens = event?.part?.tokens;
  if (!tokens || typeof tokens !== "object") return false;
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  usage.steps += 1;
  if (!rootSessionId || String(event.sessionID || event.part?.sessionID || "") === rootSessionId) usage.rootSteps += 1;
  usage.inputCount += count(tokens.input);
  usage.outputCount += count(tokens.output);
  usage.reasoningCount += count(tokens.reasoning);
  usage.cacheReadCount += count(tokens.cache?.read);
  usage.cacheWriteCount += count(tokens.cache?.write);
  usage.cost += count(event.part.cost);
  return true;
}

function formatOpenCodeUsage(usage) {
  if (!usage || !usage.steps) return "not emitted by OpenCode";
  const cost = Math.round(Number(usage.cost || 0) * 1e6) / 1e6;
  return `steps=${usage.steps} input=${usage.inputCount} output=${usage.outputCount} reasoning=${usage.reasoningCount} cache_read=${usage.cacheReadCount} cache_write=${usage.cacheWriteCount} cost=${cost}${cost === 0 ? " (provider reported no price)" : ""}`;
}

// Q-003: OpenCode reports token counts per model step (step_finish), not per tool call. A tool
// call's cost is therefore estimated from what the stream does carry: the call's result enters
// the prompt of the step after it, so the growth of the prompt size (input + cache read + cache
// write) from one step to the next, less the assistant output of that step, is the size of that
// step's tool results; it is split over the step's calls by result length. Every later step
// sends the result again, so growth x later steps is the input the result cost. These are
// estimates for ranking ("which call read the most"), not billing figures. Field names avoid
// "token" and "input" for sanitizePersistedValue.
function emptyToolWeights() {
  return new Map();
}

function toolWeightSession(weights, sessionId) {
  if (!weights.has(sessionId)) weights.set(sessionId, { pending: [], steps: [] });
  return weights.get(sessionId);
}

function noteToolUse(weights, sessionId, part) {
  const session = toolWeightSession(weights, sessionId);
  if (session.pending.length >= 25) return;
  const input = part?.state?.input && typeof part.state.input === "object" ? part.state.input : {};
  const targetKey = ["pattern", "command", "filePath", "path", "url", "query", "description"].find((key) => typeof input[key] === "string" && input[key]);
  const label = targetKey ? `${targetKey === "filePath" || targetKey === "path" ? "" : `${targetKey}: `}${input[targetKey]}${targetKey === "pattern" && typeof input.path === "string" && input.path ? ` in ${input.path}` : ""}` : "";
  session.pending.push({
    tool: String(part?.tool || "unknown").slice(0, 40),
    target: redactSensitiveText(label).replace(/\s+/g, " ").slice(0, 120),
    outputChars: String(part?.state?.output ?? part?.state?.error ?? "").length,
  });
}

function noteStepFinish(weights, sessionId, tokens) {
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const session = toolWeightSession(weights, sessionId);
  session.steps.push({
    context: count(tokens?.input) + count(tokens?.cache?.read) + count(tokens?.cache?.write),
    output: count(tokens?.output),
    tools: session.pending,
  });
  session.pending = [];
}

function heaviestToolCalls(weights, limit = 3) {
  const calls = [];
  for (const session of weights.values()) {
    const { steps } = session;
    for (let index = 0; index < steps.length - 1; index += 1) {
      const step = steps[index];
      if (!step.tools.length) continue;
      const growth = Math.max(0, steps[index + 1].context - step.context - step.output);
      if (!growth) continue;
      const totalChars = step.tools.reduce((sum, tool) => sum + tool.outputChars, 0);
      const laterSteps = steps.length - 1 - index;
      for (const tool of step.tools) {
        const share = totalChars ? tool.outputChars / totalChars : 1 / step.tools.length;
        const added = Math.round(growth * share);
        if (added) calls.push({ tool: tool.tool, target: tool.target, addedContextCount: added, laterSteps, rereadInputCount: added * laterSteps });
      }
    }
  }
  return calls.sort((left, right) => right.rereadInputCount - left.rereadInputCount).slice(0, limit);
}

// Top calls over several runs of one job (read-only retries, a validation fix pass).
function mergeHeavyToolCalls(...lists) {
  return lists.flat().filter((call) => call && typeof call === "object")
    .sort((left, right) => Number(right.rereadInputCount || 0) - Number(left.rereadInputCount || 0)).slice(0, 3);
}

function formatHeavyToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return "";
  return `Heaviest tool calls (estimated input re-read by later steps): ${calls
    .map((call) => `${call.tool}${call.target ? ` ${call.target}` : ""} +${call.addedContextCount} context x ${call.laterSteps} steps = ~${call.rereadInputCount}`)
    .join("; ")}`;
}

function inspectOpenCodeEventStream(stdout, stderr = "") {
  const stderrDiagnosticLines = providerDiagnosticLinesFromStderr(stderr);
  const stderrProviderErrorType = providerErrorTypeFromText(stderrDiagnosticLines.slice(-100).join("\n"));
  const usage = emptyOpenCodeUsage();
  const toolWeights = emptyToolWeights();
  let providerErrorType = stderrProviderErrorType;
  let stdoutErrorDetected = false;
  const toolOutcomes = [];
  let parsedEvents = 0;
  let invalidLines = 0;
  let malformedEventLines = 0;
  let rootSessionId = "";
  let permissionDeniedCount = 0;
  let assistantOutputStarted = false;
  const runtimeModels = [];
  const sessions = new Map();
  const sessionState = (id) => {
    if (!sessions.has(id)) sessions.set(id, { lastEvent: "", messageId: "", parts: new Map() });
    return sessions.get(id);
  };

  for (const line of (stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      parsedEvents += 1;
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
        malformedEventLines += 1;
        continue;
      }
      const info = event.type === "message.updated"
        ? (event.properties?.info || event.info || event.data?.info)
        : event.type === "assistant_message" ? (event.message || event.data) : null;
      const sessionId = String(info?.sessionID || event.sessionID || event.part?.sessionID || "");
      if (!rootSessionId && ["step_start", "text", "tool_use"].includes(event.type) && event.sessionID) {
        rootSessionId = String(event.sessionID);
      }
      // B-197: incomplete or earlier text/reasoning still counts as output. A later
      // error must not make a partial attempt look empty and restart it on another model.
      const outputPart = event.part || event.properties?.part;
      if (["text", "reasoning"].includes(outputPart?.type || event.type)
        && String(outputPart?.text || event.text || event.delta || event.properties?.delta || "").length) assistantOutputStarted = true;
      if (info?.role === "assistant" && ([info.text, info.content].some(value => typeof value === "string" && value.length)
        || (Array.isArray(info.content) && info.content.length) || Number(info.tokens?.output) > 0
        || Number(info.tokens?.reasoning) > 0)) assistantOutputStarted = true;
      const state = sessionState(sessionId);
      const modelEvidence = modelEvidenceFromEvent(event);
      if (modelEvidence) runtimeModels.push({ ...modelEvidence, sessionId });
      if (event?.type === "error" || event?.type === "session.error" || event?.error || event?.data?.error || event?.properties?.error) {
        stdoutErrorDetected = true;
        providerErrorType = providerErrorTypeFromStructuredEvent(event) || providerErrorType;
        state.lastEvent = "error";
        continue;
      }
      // Not a turn boundary: step_finish follows the final text part, so it leaves lastEvent alone.
      if (event.type === "step_finish" && addStepFinishUsage(usage, event, rootSessionId)) {
        noteStepFinish(toolWeights, sessionId, event.part.tokens);
        continue;
      }
      if (event?.type === "text" && event?.part?.type === "text") {
        state.lastEvent = "incomplete_text";
        if (!event.part.time?.end) continue;
        const text = String(event.part.text || "").trim();
        if (text) {
          // Identified parts are full snapshots, not deltas. Replace repeats;
          // retain distinct parts only within the final assistant message.
          const messageId = String(event.part.messageID || event.messageID || `legacy-${parsedEvents}`);
          if (messageId !== state.messageId) state.parts.clear();
          state.messageId = messageId;
          state.parts.set(String(event.part.id || `part-${parsedEvents}`), text);
          state.lastEvent = "text";
        }
        continue;
      }
      if (event?.type === "tool_use") {
        state.lastEvent = "tool_use";
        const toolError = String(event.part?.state?.error || "");
        if (/permission.{0,40}(denied|reject)|(?:denied|reject).{0,40}permission|auto-rejecting/i.test(toolError)) {
          permissionDeniedCount += 1;
        }
        if (toolOutcomes.length < 50) {
          toolOutcomes.push({
            tool: String(event?.part?.tool || "unknown"),
            status: String(event?.part?.state?.status || "unknown"),
          });
        }
        noteToolUse(toolWeights, sessionId, event.part);
      }
    } catch {
      invalidLines += 1;
      malformedEventLines += 1;
      const detected = providerErrorTypeFromDiagnosticLine(trimmed);
      if (detected) {
        stdoutErrorDetected = true;
        providerErrorType = detected || providerErrorType;
      }
    }
  }

  const observedSessionIds = [...new Set(runtimeModels.map((item) => item.sessionId).filter(Boolean))];
  if (!rootSessionId && observedSessionIds.length === 1) rootSessionId = observedSessionIds[0];
  const modelEvidenceAmbiguous = !rootSessionId && observedSessionIds.length > 1;
  const rootModels = runtimeModels.filter((item) => !rootSessionId || item.sessionId === rootSessionId || !item.sessionId);
  const identities = [...new Map(rootModels.map(({ provider, model }) => [`${provider}\0${model}`, { provider, model }])).values()];
  const runtimeModelEvidence = identities.at(-1);
  const finalState = sessions.get(rootSessionId)?.lastEvent ? sessions.get(rootSessionId) : sessions.get("");
  const finalText = finalState ? [...finalState.parts.values()].join("\n\n") : "";
  const finalResponseDetected = finalState?.lastEvent === "text" && Boolean(finalText);
  const deniedDiagnostics = String(stderr).split(/\r?\n/)
    .filter((line) => /permission requested:.*auto-rejecting|permission.{0,30}denied/i.test(line))
    .filter((line) => !/"(?:messages|system|prompt|input)"\s*:/i.test(line));
  permissionDeniedCount = Math.max(permissionDeniedCount, deniedDiagnostics.length);
  // OpenCode logs every failed provider attempt to stderr, including ones it retried and
  // then completed; a generic APIError there must not fail a run that produced its answer.
  const recoveredTransientProviderError = !stdoutErrorDetected
    && ["opencode_transient_provider_error", "opencode_rate_limited", "opencode_provider_unavailable", "opencode_transport_error", "opencode_api_error"].includes(stderrProviderErrorType)
    && finalResponseDetected;
  if (recoveredTransientProviderError) {
    providerErrorType = "";
  }
  const quotaNotice = syntheticProviderQuotaNotice(finalText);
  if (quotaNotice) providerErrorType = quotaNotice.errorType;
  const apiErrorDetected = stdoutErrorDetected || Boolean(providerErrorType);
  const finalTextTruncated = finalText.length > CONFIG.maxAssistantResponseChars;
  return {
    apiErrorDetected,
    providerErrorType: providerErrorType || "",
    recoveredTransientProviderError: recoveredTransientProviderError && !quotaNotice,
    providerWarningType: recoveredTransientProviderError && !quotaNotice ? stderrProviderErrorType : "",
    providerQuotaNotice: quotaNotice,
    // Each classified stderr line is one provider attempt that failed (OpenCode retries some itself).
    providerRetryWarningCount: stderrDiagnosticLines.length,
    usage,
    heavyToolCalls: heaviestToolCalls(toolWeights),
    retryAfterMs: quotaNotice?.resetMs || retryAfterMsFromText(`${stderr}\n${stdout}`),
    runtimeObservedProvider: runtimeModelEvidence?.provider || "",
    runtimeObservedModel: runtimeModelEvidence?.model || "",
    runtimeModelIdentities: identities,
    runtimeModelConflict: identities.length > 1,
    modelEvidenceAmbiguous,
    rootSessionId,
    permissionDeniedCount,
    streamIntegrity: malformedEventLines ? "malformed" : "valid",
    malformedEventLines,
    finalResponseDetected,
    assistantOutputStarted,
    finalText: redactLikelySecrets(finalTextTruncated ?`${finalText.slice(0, CONFIG.maxAssistantResponseChars)}\n... [assistant response truncated by bridge]` : finalText),
    finalTextTruncated,
    toolOutcomes,
    parsedEvents,
    invalidLines,
  };
}

function detectsOpenCodeApiError(stdout, stderr = "") {
  return inspectOpenCodeEventStream(stdout, stderr).apiErrorDetected;
}

  return {
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
  };
}
