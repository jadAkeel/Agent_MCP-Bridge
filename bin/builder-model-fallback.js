// Windows has no process-group proof, so the supervisor always reports
// treeTerminationConfirmed: false there. Its contained outcomes are a payload whose direct
// child was observed to exit and close its stdio on its own, and a taskkill termination
// whose best-effort verdict (direct child gone and pipes closed) succeeded. Anything else,
// including a descendant that outlived the payload, is not contained.
export function terminationContained(result) {
  if (result?.treeTerminationConfirmed === true) return true;
  if (result?.terminationErrorType) return false;
  if (result?.containmentGuarantee === "windows_direct_child_observed") return true;
  return result?.containmentGuarantee === "windows_taskkill_best_effort" && result.terminationBestEffortSucceeded === true;
}

export function sumOpenCodeUsage(...items) {
  const present = items.filter((item) => item && typeof item === "object");
  if (!present.length) return null;
  const total = { steps: 0, inputCount: 0, outputCount: 0, reasoningCount: 0, cacheReadCount: 0, cacheWriteCount: 0, cost: 0, rootSteps: 0 };
  for (const item of present) {
    for (const key of Object.keys(total)) total[key] += Number.isFinite(Number(item[key])) ? Number(item[key]) : 0;
  }
  return total;
}

// The existing role/model policy is the candidate source; the operator allowlist still
// decides whether this exact model may be selected. Do not guess from arbitrary entries.
export function roleModelFallbackRequirement(agent) {
  return ["builder", "debugger", "tester"].includes(agent)
    ? { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" } : null;
}

function beforeAssistantOutput(result) {
  return !result?.assistantOutputStarted && !String(result?.stdout || "").length
    && !(Number(result?.usage?.outputCount) > 0) && !(Number(result?.usage?.reasoningCount) > 0)
    && !(result?.changedFiles || []).length && !(result?.toolOutcomes || []).length
    && !result?.assistantFinalResponseDetected;
}

// A pre-spawn pause has no payload to contain. A started attempt must retain every
// containment/stream/permission guard of the original builder policy, plus zero output.
export function pausedProviderFallbackEligible(agent, result, { enabled, modelRequirement, forcePure } = {}) {
  if (enabled !== true || !roleModelFallbackRequirement(agent) || modelRequirement || forcePure
    || result?.configuredProvider !== "opencode" || result?.configuredModel !== "muse-spark-1.3-contributor-free"
    || !beforeAssistantOutput(result) || result?.cancelled || result?.timedOut || result?.rawOutputTruncated
    || result?.assistantResponseTruncated || result?.openCodeFallbackDetected || result?.runtimeModelConflict
    || result?.modelEvidenceAmbiguous || result?.permissionDeniedCount || result?.invalidEventLineCount
    || result?.terminationErrorType) return false;
  if (result?.agentNeverStarted === true) {
    return ["provider_paused", "provider_rate_limited", "opencode_rate_limited", "opencode_quota_exhausted"].includes(result.errorType)
      && result.exitCode === "provider_capacity_unavailable" && result.agentTimeoutSpentMs === 0
      && Number.isFinite(Date.parse(result.providerCooldownUntil || ""))
      && Date.parse(result.providerCooldownUntil) > Date.now();
  }
  return ["provider_rate_limited", "opencode_rate_limited", "opencode_quota_exhausted"].includes(result?.errorType)
    && result?.streamIntegrity === "valid" && terminationContained(result);
}

// An explicit operator policy, bounded to a failure before any tool execution.
export function builderFallbackEligible(agent, result, { enabled, modelRequirement, forcePure } = {}) {
  return enabled === true && agent === "builder" && !modelRequirement && !forcePure
    && result?.configuredProvider === "opencode"
    && result?.configuredModel === "muse-spark-1.3-contributor-free"
    && ["opencode_auth_error", "opencode_quota_exhausted", "opencode_billing_error",
      "opencode_model_error", "opencode_rate_limited", "opencode_transient_provider_error",
      "opencode_provider_unavailable", "opencode_transport_error",
      // B-061: a run stopped by the bridge's rate-limit watcher, before any tool ran.
      "provider_rate_limited"].includes(result.errorType)
    && result.streamIntegrity === "valid" && terminationContained(result)
    && !result.cancelled && !result.timedOut && !result.rawOutputTruncated
    && !result.assistantResponseTruncated && !result.assistantFinalResponseDetected
    && !result.openCodeFallbackDetected && !result.runtimeModelConflict
    && !result.modelEvidenceAmbiguous && !result.permissionDeniedCount
    && beforeAssistantOutput(result) && !result.invalidEventLineCount;
}

export async function runBuilderModelFallback(agent, run, {
  enabled = false, modelRequirement = null, forcePure = false, timeoutMs, signal = null,
  fallbackRequirement = null,
  pauseRerouteEnabled = false,
} = {}) {
  const started = Date.now();
  const primary = await run(modelRequirement, timeoutMs);
  const pauseReroute = pausedProviderFallbackEligible(agent, primary, {
    enabled: pauseRerouteEnabled, modelRequirement, forcePure,
  });
  // Task C: startup and capacity wait do not spend the payload's timeout. Preserve
  // the original wall-clock budget for the separately opted-in legacy fallback.
  const primaryRunMs = primary.agentNeverStarted ? 0 : Math.max(0, Number(primary.durationMs || 0)
    - Number(primary.runPhaseTimings?.preSlotMs || 0) - Number(primary.providerConcurrencyWaitMs || 0));
  const remaining = timeoutMs - (pauseReroute ? primaryRunMs : Date.now() - started);
  if (!fallbackRequirement || signal?.aborted || remaining <= 0
    || !(pauseReroute || builderFallbackEligible(agent, primary, { enabled, modelRequirement, forcePure }))) return primary;
  const fallback = await run(fallbackRequirement, remaining);
  const phaseTimings = fallback.runPhaseTimings ? { ...fallback.runPhaseTimings } : null;
  if (phaseTimings) for (const key of ["preSlotMs", "providerWaitMs", "preLeaseAttestationMs", "finalAttestationMs"]) {
    phaseTimings[key] = Number(primary.runPhaseTimings?.[key] || 0) + Number(phaseTimings[key] || 0);
  }
  if (pauseReroute && fallback.agentNeverStarted === true && fallback.providerCooldownUntil) {
    return { ...primary, durationMs: (primary.durationMs || 0) + (fallback.durationMs || 0),
      modelFallbackAttempted: true, modelFallbackUsed: false, modelFallbackStarted: false,
      modelFallbackReason: primary.errorType,
      modelFallbackFrom: `${primary.configuredProvider}/${primary.configuredModel}`,
      modelFallbackTo: `${fallbackRequirement.provider}/${fallbackRequirement.model}@${fallbackRequirement.variant}`,
      modelFallbackUnavailableReason: fallback.errorType,
      providerConcurrencyWaitMs: Number(primary.providerConcurrencyWaitMs || 0) + Number(fallback.providerConcurrencyWaitMs || 0),
      providerWaitInfo: fallback.providerWaitInfo || primary.providerWaitInfo || null,
      providerWaitBudget: fallback.providerWaitBudget || primary.providerWaitBudget || null,
      ...(phaseTimings ? { runPhaseTimings: phaseTimings } : {}),
    };
  }
  return {
    ...fallback,
    durationMs: (primary.durationMs || 0) + (fallback.durationMs || 0),
    // Both attempts used provider tokens; the report counts them together.
    usage: sumOpenCodeUsage(primary.usage, fallback.usage),
    providerRetryWarningCount: (primary.providerRetryWarningCount || 0) + (fallback.providerRetryWarningCount || 0),
    childExecutionIntervals: [...(primary.childExecutionIntervals || []), ...(fallback.childExecutionIntervals || [])],
    ...(phaseTimings ? { runPhaseTimings: phaseTimings } : {}),
    providerConcurrencyWaitMs: Number(primary.providerConcurrencyWaitMs || 0) + Number(fallback.providerConcurrencyWaitMs || 0),
    modelFallbackAttempted: true,
    modelFallbackUsed: true,
    modelFallbackStarted: Boolean(fallback.childStartedAtMs || fallback.payloadProcessId),
    modelFallbackReason: primary.errorType,
    modelFallbackFrom: `${primary.configuredProvider}/${primary.configuredModel}`,
    modelFallbackTo: `${fallbackRequirement.provider}/${fallbackRequirement.model}@${fallbackRequirement.variant}`,
    modelFallbackOriginalPause: pauseReroute ? {
      providerCooldownUntil: primary.providerCooldownUntil || "",
      rateLimitPause: primary.rateLimitPause || null,
      providerConcurrencyKey: primary.providerConcurrencyKey || "",
    } : null,
  };
}
