// OpenCode run: spawning an agent under the provider lease, idle and rate-limit watchdogs, read-only retries.
// Extracted from server.js in modularization round M-001.

import { runBuilderModelFallback, sumOpenCodeUsage } from "../bin/builder-model-fallback.js";
import { failureSummary, redactLikelySecrets, redactSensitiveText } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createOpenCodeRunRuntime({ CONFIG, MCP_CONTRACTOR_ORCHESTRATOR_AGENT, OPENCODE_EXE, acquireProviderLease, agentIdleTimeoutForModel, allowlistedModelOverride, applyModelOverrideToMetadata, applyRateLimitOutcome, buildOpenCodeEnv, classifyResultError, clearAgentActivity, combineAbortSignals, commandShape, containmentRecord, createIsolatedOpenCodeRuntime, defaultWriteAgentTimeoutMs, delayWithSignal, detectsOpenCodeFallback, effectiveReadOnlyMetadataError, emptyOpenCodeUsage, inspectOpenCodeEventStream, isManagedReadOnlyAgent, isTimeoutResult, logEvent, maxReadOnlyAgentRetries, mergeHeavyToolCalls, modelPauseKeyForMetadata, noteAgentActivity, nowMs, openCodeCommandLineLengthError, openCodeRunArgs, parseDependencyRequest, providerKeyForMetadata, providerSlotWaitStorage, providerSlotWaitingJobs, quarantineProviderLease, quotaGroupProviderKeys = () => [], rateLimitPauseReason, readAgentDebugMetadata, readAgentDebugMetadataUncached, recordProviderCooldown, recordRateLimitPause, releaseProviderLease, runSpawnCommand, startProviderLeaseHeartbeat, summarizeStderr, timeoutForAgent, verifyExternalPluginPolicy, wipeIsolatedOpenCodeRuntime, externalRunnerSelection = () => null, runExternalCli = null }) {
async function runOpenCode(agent, prompt, cwd, dryRun = false, timeoutMs = defaultWriteAgentTimeoutMs, {
  signal = null,
  agentMetadata = null,
  metadataPolicyOptions = {},
  forcePure = false,
  onSpawn = null,
  onSupervisorHeartbeat = null,
} = {}) {
  const workDir = cwd || process.cwd();
  const started = nowMs();
  const metadataResult = agentMetadata || await readAgentDebugMetadata(agent, workDir, { forcePure });
  let configuredMetadata = metadataResult?.metadata || null;
  const modelOverride = allowlistedModelOverride(metadataPolicyOptions.modelRequirement, agent);

  if (dryRun) {
    configuredMetadata = applyModelOverrideToMetadata(configuredMetadata, modelOverride);
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
      providerRetryWarningCount: 0,
      usage: emptyOpenCodeUsage(),
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

  const pluginPolicy = forcePure
    ? { ok: true, mode: "pure", plugins: [] }
    : metadataResult?.pluginPolicy?.ok ? metadataResult.pluginPolicy : await verifyExternalPluginPolicy(workDir);
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

  // A prompt the platform cannot pass as one argument fails before any slot is taken.
  const promptLengthError = openCodeCommandLineLengthError(
    OPENCODE_EXE,
    openCodeRunArgs(agent, prompt, applyModelOverrideToMetadata(configuredMetadata, modelOverride), { forcePure })
  );
  if (promptLengthError) {
    return {
      stdout: "",
      stderr: promptLengthError,
      exitCode: "prompt_too_long",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: "prompt_too_long",
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
    };
  }

  // Attestation before the slot (log.md B-161): the uncached plugin-policy and agent reads below
  // are two to three OpenCode cold starts (30 to 60 s on a busy host). They used to run with the
  // provider slot already held and counted against the run budget. They now run before the slot
  // request; a slot wait longer than CODEX_OPENCODE_ATTESTATION_REVALIDATE_AFTER_MS repeats them
  // with the slot held, so the gap between the last read and the launch stays bounded.
  const revalidateAfterMs = Math.max(0, Number(CONFIG.attestationRevalidateAfterMs ?? 60_000) || 0);
  let isolatedRuntime = null;
  const failBeforeSpawn = async ({ exitCode, errorType, stderr, lease = null, stopHeartbeat = null, extra = {} }) => {
    const cleanup = isolatedRuntime ? await wipeIsolatedOpenCodeRuntime(isolatedRuntime.root) : { ok: true, error: "" };
    isolatedRuntime = null;
    if (stopHeartbeat) await stopHeartbeat();
    if (lease) await releaseProviderLease(lease);
    return {
      stdout: "",
      stderr: cleanup.ok ? stderr : `Isolated OpenCode runtime cleanup failed: ${cleanup.error}`,
      exitCode: cleanup.ok ? exitCode : "isolated_runtime_cleanup_failed",
      durationMs: nowMs() - started,
      commandShape: commandShape(agent, configuredMetadata, { forcePure }),
      dryRun: false,
      timeoutMs,
      errorType: cleanup.ok ? errorType : "isolated_runtime_cleanup_failed",
      assistantFinalResponseDetected: false,
      providerErrorType: "",
      toolOutcomes: [],
      configuredProvider: configuredMetadata?.provider || "",
      configuredModel: configuredMetadata?.model || "",
      configuredVariant: configuredMetadata?.variant || "",
      modelFallbackAllowed: false,
      ...extra,
    };
  };
  // The last read before spawn always bypasses the attestation cache: it is the
  // check that catches effective-permission drift OpenCode reports between
  // discovery and launch, which no source-file fingerprint can see.
  const attestForSpawn = async () => {
    const pluginPolicy = forcePure ? { ok: true, mode: "pure", plugins: [] } : await verifyExternalPluginPolicy(workDir);
    if (!pluginPolicy.ok) {
      return { ok: false, exitCode: "plugin_policy_rejected", errorType: pluginPolicy.errorType, stderr: pluginPolicy.error };
    }
    const metadata = await readAgentDebugMetadataUncached(agent, workDir, {
      forcePure,
      runtimeContext: isolatedRuntime,
      verifiedPluginPolicy: pluginPolicy,
    });
    const metadataError = effectiveReadOnlyMetadataError(metadata, null, {
      expectedAgent: agent,
      expectedMode: configuredMetadata?.mode || "",
      expectedMetadata: configuredMetadata,
      ...metadataPolicyOptions,
    });
    if (metadataError) {
      return { ok: false, exitCode: "agent_policy_rejected", errorType: metadataError.errorType, stderr: metadataError.error };
    }
    return { ok: true, metadata: applyModelOverrideToMetadata(metadata.metadata, modelOverride) };
  };
  if (forcePure) {
    try {
      isolatedRuntime = await createIsolatedOpenCodeRuntime();
    } catch (error) {
      return failBeforeSpawn({
        exitCode: "isolated_runtime_setup_failed",
        errorType: "isolated_runtime_setup_failed",
        stderr: `Isolated OpenCode runtime setup failed: ${redactSensitiveText(error.message || String(error))}`,
      });
    }
  }
  const preLeaseAttestationStarted = nowMs();
  const preLeaseAttestation = await attestForSpawn();
  if (!preLeaseAttestation.ok) return failBeforeSpawn(preLeaseAttestation);
  configuredMetadata = preLeaseAttestation.metadata;
  const preLeaseAttestationMs = Math.round(nowMs() - preLeaseAttestationStarted);

  // The slot belongs to the provider that will actually run: with a model override (or the
  // builder's Gemini fallback) the managed profile's provider is not the one spawned, and
  // counting the run against it over-subscribed the real provider. The key comes from the
  // attested metadata, which already carries the override.
  const providerKey = providerKeyForMetadata(configuredMetadata);
  // B-061: a rate-limit pause is recorded per provider/model; a slot request checks both keys.
  const modelPauseKey = modelPauseKeyForMetadata(configuredMetadata);
  // B-131 / Q-014a: CODEX_OPENCODE_QUOTA_GROUPS holds an OpenCode provider too (a codex pause holds
  // openai/<model> when both are in one group), not only the external runners.
  const quotaGroupKeys = quotaGroupProviderKeys(configuredMetadata?.provider || "");
  // The slot wait has its own budget. It used to come out of the run timeout, so a builder
  // that waited 25 of its 30 minutes was killed after 5 minutes of work as agent_timeout.
  const preSlotMs = Math.round(nowMs() - started);
  const slotWaitJobId = providerSlotWaitStorage.getStore()?.jobId || "";
  if (slotWaitJobId) providerSlotWaitingJobs.set(slotWaitJobId, { providerKey, since: new Date().toISOString() });
  let providerLease;
  try {
    providerLease = await acquireProviderLease({ providerKey, pauseKeys: [...new Set([modelPauseKey, ...quotaGroupKeys].filter((key) => key && key !== providerKey))], timeoutMs: CONFIG.providerWaitMaxMs, signal });
  } finally {
    if (slotWaitJobId) providerSlotWaitingJobs.delete(slotWaitJobId);
  }
  if (!providerLease.ok) {
    return failBeforeSpawn({
      exitCode: "provider_capacity_unavailable",
      errorType: providerLease.errorType,
      stderr: providerLease.error,
      extra: {
        providerErrorType: providerLease.cooldownUntil ? providerLease.errorType : "",
        retryAfterMs: Number(providerLease.retryAfterMs || 0),
        providerCooldownUntil: providerLease.cooldownUntil || "",
        providerConcurrencyKey: providerKey,
        providerConcurrencyWaitMs: providerLease.waitedMs || 0,
        providerSlotHolders: Number(providerLease.holders || 0),
        providerSlotCapacity: Number(providerLease.capacity || 0),
      },
    });
  }
  // The run budget starts once the slot is granted.
  const runStarted = nowMs();
  const stopProviderLeaseHeartbeat = startProviderLeaseHeartbeat(providerLease.lease);
  const providerExecutionSignal = combineAbortSignals([signal, stopProviderLeaseHeartbeat.signal]);
  const persistSupervisorAuthority = async (spawnIdentity) => {
    const outer = typeof onSpawn === "function" ? await onSpawn(spawnIdentity) : { ok: true };
    return {
      ok: outer?.ok !== false,
      deadlineAt: Math.min(
        Number(providerLease.lease.expiresAt || 0),
        Number(outer?.deadlineAt || Number.POSITIVE_INFINITY)
      ),
    };
  };
  const renewSupervisorAuthority = async () => {
    const providerRenewed = await stopProviderLeaseHeartbeat.pulse();
    if (!providerRenewed || providerRenewed.ok === false) return { ok: false };
    const outer = typeof onSupervisorHeartbeat === "function"
      ? await onSupervisorHeartbeat()
      : { ok: true, deadlineAt: Number.POSITIVE_INFINITY };
    return {
      ok: outer?.ok !== false,
      deadlineAt: Math.min(
        Number(providerLease.lease.expiresAt || 0),
        Number(providerRenewed?.deadlineAt || Number.POSITIVE_INFINITY),
        Number(outer?.deadlineAt || Number.POSITIVE_INFINITY)
      ),
    };
  };

  let remainingRunMs = timeoutMs - (nowMs() - runStarted);
  if (remainingRunMs <= 0) {
    return failBeforeSpawn({
      exitCode: 124,
      errorType: "agent_timeout",
      stderr: "The overall OpenCode attempt deadline expired while waiting for provider capacity.",
      lease: providerLease.lease,
      stopHeartbeat: stopProviderLeaseHeartbeat,
      extra: { timedOut: true },
    });
  }

  // A slot granted only after a long wait: repeat the uncached reads with the slot held, so the
  // launch never trusts an attestation older than the wait threshold (B-161).
  let finalAttestationMs = 0;
  if (Number(providerLease.waitedMs || 0) > revalidateAfterMs) {
    const finalAttestationStarted = nowMs();
    const finalAttestation = await attestForSpawn();
    if (!finalAttestation.ok) {
      return failBeforeSpawn({ ...finalAttestation, lease: providerLease.lease, stopHeartbeat: stopProviderLeaseHeartbeat });
    }
    const attestedProviderKey = providerKeyForMetadata(finalAttestation.metadata);
    if (attestedProviderKey !== providerKey) {
      return failBeforeSpawn({
        exitCode: "agent_policy_rejected",
        errorType: "provider_lease_key_mismatch",
        stderr: `The final pre-spawn attestation resolved provider slot ${attestedProviderKey}, but the run holds a slot on ${providerKey}. No agent was spawned.`,
        lease: providerLease.lease,
        stopHeartbeat: stopProviderLeaseHeartbeat,
        extra: { providerConcurrencyKey: providerKey },
      });
    }
    configuredMetadata = finalAttestation.metadata;
    finalAttestationMs = Math.round(nowMs() - finalAttestationStarted);
    remainingRunMs = timeoutMs - (nowMs() - runStarted);
    if (remainingRunMs <= 0) {
      return failBeforeSpawn({
        exitCode: 124,
        errorType: "agent_timeout",
        stderr: "The overall OpenCode attempt deadline expired during the final plugin-integrity check.",
        lease: providerLease.lease,
        stopHeartbeat: stopProviderLeaseHeartbeat,
        extra: { timedOut: true },
      });
    }
  }

  let result;
  let isolatedRuntimeCleanup = { ok: true, error: "" };
  let containmentUnconfirmed = false;
  let providerQuarantine = null;
  const runIdleTimeoutMs = agentIdleTimeoutForModel(configuredMetadata);
  const spawnCalledWallMs = Date.now();
  try {
    result = await runSpawnCommand(
      OPENCODE_EXE,
      openCodeRunArgs(agent, prompt, configuredMetadata, { forcePure }),
      workDir,
      remainingRunMs,
      isolatedRuntime?.env || buildOpenCodeEnv(),
      {
        signal: providerExecutionSignal,
        terminateOnProviderError: true,
        onSpawn: persistSupervisorAuthority,
        beforeHeartbeat: renewSupervisorAuthority,
        // B-046: queue jobs show their last output; the idle watchdog is off unless configured.
        onActivity: slotWaitJobId ? (atMs) => noteAgentActivity(slotWaitJobId, atMs) : null,
        idleTimeoutMs: runIdleTimeoutMs,
        rateLimitWatch: CONFIG.rateLimitHits > 0 && configuredMetadata?.model ? {
          hits: CONFIG.rateLimitHits,
          provider: configuredMetadata.provider || "",
          model: configuredMetadata.model,
          agent,
          logPath: CONFIG.openCodeLogPath,
          scanMs: CONFIG.openCodeLogScanMs,
        } : null,
      }
    );
    containmentUnconfirmed = result?.terminationErrorType === "process_tree_termination_unconfirmed";
  } finally {
    clearAgentActivity(slotWaitJobId);
    await stopProviderLeaseHeartbeat();
    if (containmentUnconfirmed) {
      providerQuarantine = await quarantineProviderLease(providerLease.lease, await containmentRecord(result));
      if (!providerQuarantine.ok) {
        logEvent("error", "provider.containment_quarantine_unconfirmed", { leaseId: providerLease.lease.id });
      }
    } else {
      await releaseProviderLease(providerLease.lease);
    }
    if (isolatedRuntime && !containmentUnconfirmed) {
      isolatedRuntimeCleanup = await wipeIsolatedOpenCodeRuntime(isolatedRuntime.root);
    }
  }
  if (!isolatedRuntimeCleanup.ok) {
    result = {
      ...result,
      stderr: `${String(result?.stderr || "")}\nIsolated OpenCode runtime cleanup failed: ${isolatedRuntimeCleanup.error}`.trim(),
      exitCode: "isolated_runtime_cleanup_failed",
    };
  }
  if (providerQuarantine && !providerQuarantine.ok) {
    result = {
      ...result,
      stderr: `${String(result?.stderr || "")}\nThe provider slot could not be quarantined for the unconfirmed process tree (${providerQuarantine.error || "no row written"}); another job may start on this provider while it still runs.`.trim(),
    };
  }

  const openCodeFallbackDetected = detectsOpenCodeFallback(result.stderr);
  const inspection = inspectOpenCodeEventStream(result.stdout, result.stderr);
  const runPhaseTimings = {
    preSlotMs,
    providerWaitMs: providerLease.waitedMs || 0,
    preLeaseAttestationMs,
    finalAttestationMs,
    spawnGateMs: Number(result?.childStartedAtMs) ? Math.max(0, Number(result.childStartedAtMs) - spawnCalledWallMs) : null,
    afterExitMs: Number(result?.childFinishedAtMs) ? Math.max(0, Date.now() - Number(result.childFinishedAtMs)) : null,
  };
  const runResult = {
    runPhaseTimings,
    supervisorProcessId: Number(result?.supervisorProcessId || 0),
    payloadProcessId: Number(result?.payloadProcessId || 0),
    stdout: redactLikelySecrets(inspection.finalText),
    stderr: summarizeStderr(result.stderr),
    exitCode: result.exitCode,
    durationMs: nowMs() - started,
    commandShape: commandShape(agent, configuredMetadata, { forcePure }),
    dryRun: false,
    timeoutMs,
    timedOut: isTimeoutResult(result),
    idleTimedOut: Boolean(result.idleTimedOut),
    idleTimeoutMs: result.idleTimedOut ? runIdleTimeoutMs : 0,
    cancelled: Boolean(result.cancelled),
    cancellationErrorType: result.cancellationErrorType || "",
    providerTerminated: Boolean(result.providerTerminated),
    treeTerminationConfirmed: result.treeTerminationConfirmed !== false,
    containmentGuarantee: result.containmentGuarantee || "",
    terminationBestEffortSucceeded: result.terminationBestEffortSucceeded === true,
    terminationErrorType: result.terminationErrorType || "",
    openCodeFallbackDetected,
    openCodeApiErrorDetected: inspection.apiErrorDetected,
    providerErrorType: inspection.providerErrorType,
    recoveredTransientProviderError: inspection.recoveredTransientProviderError,
    providerWarningType: inspection.providerWarningType,
    providerRetryWarningCount: inspection.providerRetryWarningCount || 0,
    usage: inspection.usage,
    heavyToolCalls: inspection.heavyToolCalls || [],
    retryAfterMs: inspection.retryAfterMs || 0,
    assistantFinalResponseDetected: inspection.finalResponseDetected,
    assistantResponseTruncated: inspection.finalTextTruncated,
    toolOutcomes: inspection.toolOutcomes,
    parsedEventCount: inspection.parsedEvents,
    invalidEventLineCount: inspection.invalidLines,
    malformedEventLines: inspection.malformedEventLines,
    streamIntegrity: inspection.streamIntegrity,
    permissionDeniedCount: inspection.permissionDeniedCount,
    runtimeModelConflict: inspection.runtimeModelConflict,
    modelEvidenceAmbiguous: inspection.modelEvidenceAmbiguous,
    runtimeModelIdentities: inspection.runtimeModelIdentities,
    requireRuntimeModelEvidence: CONFIG.requireRuntimeModelEvidence || metadataPolicyOptions.modelRequirement?.requireRuntimeEvidence === true,
    rawOutputTruncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
    rawStdoutChars: result.stdoutChars || 0,
    rawStderrChars: result.stderrChars || 0,
    rawStdoutSha256: result.stdoutSha256 || "",
    rawStderrSha256: result.stderrSha256 || "",
    configuredProvider: configuredMetadata?.provider || "",
    configuredModel: configuredMetadata?.model || "",
    configuredVariant: configuredMetadata?.variant || "",
    modelSelection: configuredMetadata?.modelSelection || "managed_profile",
    profileProvider: configuredMetadata?.profileProvider || configuredMetadata?.provider || "",
    profileModel: configuredMetadata?.profileModel || configuredMetadata?.model || "",
    profileVariant: configuredMetadata?.profileVariant ?? (configuredMetadata?.variant || ""),
    runtimeObservedProvider: inspection.runtimeObservedProvider || "",
    runtimeObservedModel: inspection.runtimeObservedModel || "",
    modelFallbackAllowed: false,
    providerConcurrencyKey: providerKey,
    providerConcurrencyWaitMs: providerLease.waitedMs || 0,
    providerQuarantine: providerQuarantine
      ? { ok: Boolean(providerQuarantine.ok), leaseId: providerQuarantine.leaseId || "", inserted: Boolean(providerQuarantine.inserted) }
      : null,
    spawnErrorCode: result.spawnErrorCode || "",
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
    && !inspection.runtimeModelConflict && !inspection.modelEvidenceAmbiguous
    && runResult.runtimeObservedProvider === runResult.configuredProvider
    && runResult.runtimeObservedModel === runResult.configuredModel;
  runResult.exactCliModelPin = configuredMetadata?.provider && configuredMetadata?.model
    ? `${configuredMetadata.provider}/${configuredMetadata.model}`
    : "";
  const dependencyRequest = parseDependencyRequest(runResult.stdout);
  runResult.dependencyRequest = dependencyRequest.request;
  runResult.dependencyRequestError = dependencyRequest.error;
  // B-061: stopped by the rate-limit watcher. A cancellation or a containment failure still wins
  // (classifyResultError checks those first).
  applyRateLimitOutcome(runResult, result);
  runResult.errorType = classifyResultError(runResult);
  if (!runResult.errorType && runtimeModelEvidencePresent && !runResult.modelAttested) {
    runResult.errorType = "opencode_model_mismatch";
  }
  if (runResult.errorType === "provider_rate_limited") {
    const pause = await recordRateLimitPause({
      pauseKey: modelPauseKey,
      reason: rateLimitPauseReason(runResult),
    });
    if (pause.recorded) runResult.providerCooldownUntil = new Date(pause.untilAt).toISOString();
    // B-131 / Q-014a: the providers that share this quota are paused until then too, as a runner's
    // rate limit pauses them (lib/external-runners.js).
    const groupKeys = pause.recorded ? quotaGroupKeys : [];
    for (const key of groupKeys) {
      await recordProviderCooldown({ providerKey: key, untilAt: Number(pause.untilAt), errorType: "provider_rate_limited", reason: `quota group of ${configuredMetadata?.provider || ""}: ${rateLimitPauseReason(runResult)}` });
    }
    runResult.rateLimitPause = pause.recorded ? { until: runResult.providerCooldownUntil, strikes: pause.strikes, pauseKey: modelPauseKey, reused: Boolean(pause.reused), ...(groupKeys.length ? { groupKeys } : {}) } : null;
    logEvent("warn", "provider.rate_limit_detected", {
      jobId: slotWaitJobId,
      agent,
      model: `${configuredMetadata?.provider || ""}/${configuredMetadata?.model || ""}`,
      errorType: "provider_rate_limited",
      hits: runResult.rateLimitHits,
      pausedUntil: runResult.providerCooldownUntil || "",
      summary: failureSummary(rateLimitPauseReason(runResult)),
    });
  }
  if (runResult.errorType === "opencode_quota_exhausted" && runResult.retryAfterMs > 0) {
    const cooldown = await recordProviderCooldown({
      providerKey,
      durationMs: runResult.retryAfterMs,
      errorType: runResult.errorType,
      reason: inspection.providerQuotaNotice ? `provider reported "Quota resets in ${inspection.providerQuotaNotice.resetText}"` : "provider reported a hard quota with a retry delay",
    });
    if (cooldown.recorded) runResult.providerCooldownUntil = new Date(cooldown.untilAt).toISOString();
    // B-131 / Q-014a: a hard quota of a provider in a quota group holds the group until the reset.
    for (const key of cooldown.recorded ? quotaGroupKeys.filter((item) => item !== providerKey) : []) {
      await recordProviderCooldown({ providerKey: key, untilAt: Number(cooldown.untilAt), errorType: runResult.errorType, reason: `quota group of ${configuredMetadata?.provider || ""}: provider quota exhausted` });
    }
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

async function runOpenCodeWithPolicy(agent, prompt, cwd, dryRun, lockPlan, requestedTimeoutMs = null, {
  signal = null,
  agentMetadata = null,
  onSpawn = null,
  onSupervisorHeartbeat = null,
  targetCwd = "",
} = {}) {
  const timeoutMs = timeoutForAgent(agent, lockPlan, requestedTimeoutMs);
  // Q-012: a model requirement naming an enabled external runner (codex/, agy/) runs that CLI; no
  // read-only retries and no builder model fallback. Null whenever no runner is enabled.
  const externalRunner = externalRunnerSelection(lockPlan?.scopeContract?.modelRequirement || null, agent);
  if (externalRunner && typeof runExternalCli === "function") {
    const result = await runExternalCli(externalRunner, { agent, prompt, cwd, targetCwd, dryRun, lockPlan, timeoutMs, signal, agentMetadata, onSpawn, onSupervisorHeartbeat });
    result.retryAttempt = 0;
    result.maxRetries = 0;
    logOpenCodeResult(agent, result, lockPlan);
    return result;
  }
  const forcePure = Boolean(lockPlan?.sanitizedWorkspace);
  const metadataPolicyOptions = {
    expectedAgent: agent,
    expectedMode: agentMetadata?.metadata?.mode || "",
    expectedMetadata: agentMetadata?.metadata || null,
    modelRequirement: lockPlan?.scopeContract?.modelRequirement || null,
    allowDelegation: lockPlan?.orchestratorMode === "contractor"
      && lockPlan?.contractorAuthorizationVerified
      && String(agent || "").toLowerCase() === MCP_CONTRACTOR_ORCHESTRATOR_AGENT.toLowerCase(),
  };

  if (lockPlan?.lockType !== "read") {
    const fallbackRequirement = { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" };
    const result = await runBuilderModelFallback(agent, (modelRequirement, attemptTimeoutMs) => runOpenCode(agent, prompt, cwd, dryRun, attemptTimeoutMs, {
      signal,
      agentMetadata,
      metadataPolicyOptions: { ...metadataPolicyOptions, modelRequirement },
      forcePure,
      onSpawn,
      onSupervisorHeartbeat,
    }), {
      enabled: process.env.CODEX_OPENCODE_BUILDER_MODEL_FALLBACK === "true" && !dryRun,
      modelRequirement: metadataPolicyOptions.modelRequirement,
      forcePure,
      timeoutMs,
      signal,
      fallbackRequirement: allowlistedModelOverride(fallbackRequirement, agent),
    });
    result.retryAttempt = 0;
    result.maxRetries = 0;
    logOpenCodeResult(agent, result, lockPlan);
    return result;
  }

  let lastResult = null;
  let attemptsMade = 0;
  const childExecutionIntervals = [];
  let usageTotal = null;
  let heavyToolCallsTotal = [];
  let providerRetryWarningTotal = 0;
  const policyStarted = nowMs();
  // The retry budget bounds retries; it must never shorten the first attempt below the
  // configured read-only timeout (an 8 min budget silently capped a 15 min reviewer).
  const retryBudgetMs = Math.max(CONFIG.readOnlyRetryMaxElapsedMs, Number(timeoutMs) || 0);
  for (let attempt = 0; attempt <= maxReadOnlyAgentRetries; attempt += 1) {
    const elapsedMs = nowMs() - policyStarted;
    const remainingBudgetMs = retryBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) break;
    lastResult = await runOpenCode(agent, prompt, cwd, dryRun, Math.min(timeoutMs, remainingBudgetMs), {
      signal,
      agentMetadata,
      metadataPolicyOptions,
      forcePure,
      onSpawn,
      onSupervisorHeartbeat,
    });
    attemptsMade = attempt + 1;
    childExecutionIntervals.push(...(lastResult.childExecutionIntervals || []));
    lastResult.childExecutionIntervals = [...childExecutionIntervals];
    // Every attempt used provider tokens; the last attempt's result reports all of them.
    usageTotal = sumOpenCodeUsage(usageTotal, lastResult.usage);
    heavyToolCallsTotal = mergeHeavyToolCalls(heavyToolCallsTotal, lastResult.heavyToolCalls);
    providerRetryWarningTotal += lastResult.providerRetryWarningCount || 0;
    lastResult.usage = usageTotal;
    lastResult.heavyToolCalls = heavyToolCallsTotal;
    lastResult.providerRetryWarningCount = providerRetryWarningTotal;
    lastResult.retryAttempt = attempt;
    lastResult.maxRetries = maxReadOnlyAgentRetries;
    logOpenCodeResult(agent, lastResult, lockPlan);
    if (!readOnlyResultRetryable(lastResult, agent, agentMetadata) || attempt >= maxReadOnlyAgentRetries) {
      return lastResult;
    }
    const exponential = CONFIG.readOnlyRetryBaseDelayMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 2)));
    const delayMs = Math.max(lastResult.retryAfterMs || 0, exponential + jitter);
    if (nowMs() - policyStarted + delayMs >= retryBudgetMs) {
      break;
    }
    try {
      await delayWithSignal(delayMs, signal);
    } catch {
      return { ...lastResult, cancelled: true, errorType: "agent_cancelled" };
    }
  }

  return readOnlyRetryBudgetExhaustedResult(lastResult, attemptsMade, maxReadOnlyAgentRetries);
}

// The loop above leaves early when the retry budget cannot fit another attempt. A single
// timed-out attempt was then reported as read_only_agent_unavailable "after 3 bounded
// attempts" with retryAttempt 0; report the attempts actually made, and keep agent_timeout
// when the last attempt timed out.
function readOnlyRetryBudgetExhaustedResult(lastResult, attemptsMade, maxRetries = maxReadOnlyAgentRetries) {
  const attempts = Math.max(1, Number(attemptsMade) || 0);
  const attemptText = `${attempts} bounded attempt${attempts === 1 ? "" : "s"}`;
  const timedOut = isTimeoutResult(lastResult);
  return {
    ...lastResult,
    readOnlyUnavailable: true,
    retryAttempt: attempts - 1,
    maxRetries,
    attemptsMade: attempts,
    errorType: lastResult?.idleTimedOut ? "agent_idle_timeout" : timedOut ? "agent_timeout" : "read_only_agent_unavailable",
    stderr: [
      lastResult?.stderr || "",
      timedOut
        ? `Read-only agent timed out; the retry budget left no room for another attempt after ${attemptText}.`
        : `Read-only agent remained unavailable after ${attemptText} and was marked unavailable.`,
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
  return { runOpenCode, readOnlyResultRetryable, runOpenCodeWithPolicy, readOnlyRetryBudgetExhaustedResult, logOpenCodeResult };
}
