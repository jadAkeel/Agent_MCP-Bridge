// An explicit operator policy, bounded to a failure before any tool execution.
export function builderFallbackEligible(agent, result, { enabled, modelRequirement, forcePure } = {}) {
  return enabled === true && agent === "builder" && !modelRequirement && !forcePure
    && result?.configuredProvider === "opencode"
    && result?.configuredModel === "muse-spark-1.3-contributor-free"
    && ["opencode_auth_error", "opencode_quota_exhausted", "opencode_billing_error",
      "opencode_model_error", "opencode_rate_limited", "opencode_transient_provider_error",
      "opencode_provider_unavailable", "opencode_transport_error"].includes(result.errorType)
    && result.streamIntegrity === "valid" && result.treeTerminationConfirmed === true
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
    childExecutionIntervals: [...(primary.childExecutionIntervals || []), ...(fallback.childExecutionIntervals || [])],
    modelFallbackUsed: true,
    modelFallbackReason: primary.errorType,
    modelFallbackFrom: `${primary.configuredProvider}/${primary.configuredModel}`,
    modelFallbackTo: `${fallbackRequirement.provider}/${fallbackRequirement.model}@${fallbackRequirement.variant}`,
  };
}
