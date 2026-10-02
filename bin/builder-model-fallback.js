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
    && !(result.toolOutcomes || []).length && !result.invalidEventLineCount;
}

export async function runBuilderModelFallback(agent, run, {
  enabled = false, modelRequirement = null, forcePure = false, timeoutMs, signal = null,
  fallbackRequirement = null,
} = {}) {
  const started = Date.now();
  const primary = await run(modelRequirement, timeoutMs);
  const remaining = timeoutMs - (Date.now() - started);
  if (!fallbackRequirement || signal?.aborted || remaining <= 0
    || !builderFallbackEligible(agent, primary, { enabled, modelRequirement, forcePure })) return primary;
  const fallback = await run(fallbackRequirement, remaining);
  return {
    ...fallback,
    durationMs: (primary.durationMs || 0) + (fallback.durationMs || 0),
    // Both attempts used provider tokens; the report counts them together.
    usage: sumOpenCodeUsage(primary.usage, fallback.usage),
    providerRetryWarningCount: (primary.providerRetryWarningCount || 0) + (fallback.providerRetryWarningCount || 0),
    childExecutionIntervals: [...(primary.childExecutionIntervals || []), ...(fallback.childExecutionIntervals || [])],
    modelFallbackUsed: true,
    modelFallbackReason: primary.errorType,
    modelFallbackFrom: `${primary.configuredProvider}/${primary.configuredModel}`,
    modelFallbackTo: `${fallbackRequirement.provider}/${fallbackRequirement.model}@${fallbackRequirement.variant}`,
  };
}
