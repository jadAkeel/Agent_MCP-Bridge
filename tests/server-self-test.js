#!/usr/bin/env node

// Self-test suite for server.js, moved out of the production file. It imports the
// bridge as a module (tools register; nothing connects), then runs the same suites.
//   node tests/server-self-test.js                     full suite
//   node tests/server-self-test.js --self-test-events  event-evidence suite only
// "--self-test" is added to process.argv before the import because server.js keys
// its test-mode guards (background timers, attestation cache TTL) on that flag.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  BRIDGE_INSTANCE_ID,
  BRIDGE_OPENCODE_HOME_DIR,
  BRIDGE_RUNTIME_DIR,
  BRIDGE_SERVER_PATH,
  CONFIG,
  CONTRACTOR_ALLOWED_SUBAGENTS,
  DEFAULT_FORBIDDEN_EDIT_PATHS,
  DEFAULT_OPENCODE_CONFIG_DIR,
  DEFAULT_OPENCODE_DATA_DIR,
  DatabaseSync,
  GLOBALLY_REQUIRED_MANAGED_AGENTS,
  INTEGRATION_PREVIEWS,
  INTEGRATION_PREVIEW_TTL_MS,
  MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  MCP_ORCHESTRATOR_AGENT,
  MCP_SANITIZED_READER_AGENT,
  MCP_SANITIZED_READER_PROFILE,
  MCP_SANITIZED_READER_PROMPT,
  PIPELINE_RUNS,
  QUEUE_JOBS,
  RELEASE_REQUIRED_MANAGED_AGENTS,
  REPOSITORY_SCOPE_LOCK_PATH,
  REQUIRED_MANAGED_AGENTS,
  REQUIRED_MANAGED_SKILLS,
  STANDALONE_ORCHESTRATOR_AGENT,
  USER_HOME_DIR,
  abortSignalErrorType,
  acquireHardLock,
  activatePipelineBatch,
  allowlistedModelOverride,
  applyModelOverrideToMetadata,
  assert,
  assertSupportedCallerModel,
  assertSupportedQueueRetryConfig,
  assessQueuePlan,
  buildOpenCodeEnv,
  buildTrustedGitEnv,
  buildValidationEnv,
  cachedAttestation,
  cancelPersistedQueueJob,
  captureGitIndexIdentity,
  captureIntegrationTargetState,
  captureRollbackBaseline,
  changedFileValidationErrorType,
  changedFilesBetween,
  chmod,
  claimQueueRecord,
  classifyResultError,
  cleanupExpiredLocks,
  cleanupWorktree,
  clearAttestationCache,
  clearQueueLeaseFence,
  closeDb,
  collectIntegrationPatch,
  collectWorktreeDiff,
  contractorAuthorizationToken,
  contractorAuthorizationValid,
  contractorNestedAgentMetadataError,
  createHash,
  createIsolatedOpenCodeRuntime,
  createPipelinePlan,
  createWorktreeForJob,
  decryptQueueRequest,
  defaultBuilderTimeoutMs,
  defaultOrchestratorTimeoutMs,
  detectsOpenCodeApiError,
  directExecutionLockConflictDetails,
  dirtyCheckpointDetails,
  effectiveQueueMode,
  effectiveReadOnlyMetadataError,
  enqueueQueueJob,
  ensureLockTableSchema,
  exactIntegrationFileSnapshot,
  exactPluginSpecifier,
  execFileAsync,
  executeOpenCodeJob,
  existsSync,
  filesystemCaseModeForRoot,
  finalizePipelineRecord,
  findQueueWriteConflict,
  formatRejectedExecution,
  gitChangedFileSnapshot,
  gitChangedFiles,
  hardLockTtlForPlan,
  hashExactTree,
  immutableReleasePluginModeError,
  inspectOpenCodeEventStream,
  inspectSourceCheckpointState,
  integratePatchSerially,
  integrationCleanupTargetStateError,
  integrationPreviewReceiptError,
  isManagedReadOnlyAgent,
  isOrchestratorAgent,
  isPathInside,
  isWithinAnyPath,
  link,
  listLocks,
  listPersistedQueueRecords,
  loadProjectAgentPolicy,
  lockTableHasCompositePrimaryKey,
  lstat,
  makeIntegrationPreviewReceipt,
  makeInternalQueueContractorProof,
  managedAgentSourceProfile,
  managedSkillPolicyError,
  mkdir,
  mkdtemp,
  modelEvidenceFromEvent,
  modelRequirementSchema,
  nextQueueScheduleDelay,
  normalizeAgentDebugMetadata,
  normalizeLockPath,
  normalizeLockPathForCwd,
  normalizeProjectAgentPolicy,
  normalizeScopeContract,
  noteQueueLeaseRenewalFailure,
  open,
  openCodeRunArgs,
  openLockDb,
  parallelExecutionOverlapEvidence,
  parseCommandLine,
  parseDependencyRequest,
  parseModelAllowlistEntry,
  path,
  persistPipelineRecord,
  persistQueueRecord,
  persistTerminalQueueRecord,
  pluginSpecsFromConfigText,
  prepareIntegrationOperation,
  prepareValidationCommand,
  providerErrorTypeFromStructuredEvent,
  providerErrorTypeFromText,
  pruneInMemoryState,
  prunePersistedState,
  queueRecordDurableSummary,
  queueRecordSnapshot,
  randomBytes,
  readFile,
  readIntegrationOperationSummary,
  readOnlyResultRetryable,
  readOnlyRoutingPolicyError,
  readPersistedPipelineRecord,
  readPersistedQueueRecord,
  reconcileParentPipelineAfterQueueTerminal,
  reconcileStaleQueueRecords,
  recordMatchesProject,
  recoverIntegrationOperationsWhileLocked,
  redactSensitiveText,
  refreshPipelineRecord,
  releaseHardLock,
  releaseManagedSourcePathError,
  renewPersistedQueueRecordLease,
  resolveProjectStateRoot,
  resolveValidationExecutable,
  resumeAuthorizedPipelineCleanup,
  retryAfterMsFromText,
  rm,
  rollbackUnsafeChanges,
  rollbackVerifiedOwnedChanges,
  runCommand,
  runGitReadOnlyCommand,
  runSingleFlight,
  runSpawnCommand,
  runValidationGate,
  sanitizeLogValue,
  sanitizePersistedValue,
  sanitizedAgentMetadataError,
  sanitizedDiscoveryContext,
  sanitizedJobPolicyError,
  sanitizedRoutingPolicyError,
  scheduleQueue,
  scrubLegacyLockSecrets,
  server,
  settleIndependentParallelJobs,
  sha256File,
  shouldUseWorktree,
  spawn,
  startHardLockHeartbeat,
  startProviderLeaseHeartbeat,
  statFingerprint,
  stateDbPath,
  statePruneTimes,
  sweepIntegrationPreviews,
  symlink,
  timeoutForAgent,
  tmpdir,
  transientGitIndexReadError,
  transitionIntegrationOperation,
  trustedGitArgs,
  unsafePathReason,
  updatePipelineRecord,
  updateQueueRecordDurable,
  updateQueueTerminalRecordDurable,
  userAuthorizedOrchestrator,
  validateChangedFilesForPlan,
  validateDelegationPlanInputs,
  validateParallelWritePlan,
  validateSingleLockPlan,
  validationCommandPreflightError,
  validationCommandTrustError,
  verifyJobWorkspaceReadiness,
  verifyParallelLockResults,
  verifyProtectedGitRoot,
  verifyReleaseIntegrity,
  verifyReleaseManifest,
  verifySanitizedJobsBeforeDiscovery,
  verifySanitizedWorkspace,
  wipeIsolatedOpenCodeRuntime,
  writeFile,
  z,
} = __selfTest.internals;

function runEventEvidenceSelfTests() {
  const requiredModel = { provider: "fixture", model: "model-a", variant: "high", requireRuntimeEvidence: true };
  assert.deepEqual(modelRequirementSchema.parse(requiredModel), requiredModel);
  assert.equal(modelRequirementSchema.safeParse({ ...requiredModel, endpoint: "https://example.invalid" }).success, false);
  assert.equal(modelRequirementSchema.safeParse({ ...requiredModel, variant: "high\n" }).success, true);
  assert.equal(modelRequirementSchema.safeParse({ ...requiredModel, model: "model\ninvalid" }).success, false);
  const requiredScope = { mode: "read", read: ["src"], modelRequirement: requiredModel };
  assert.deepEqual(normalizeScopeContract({ agent: "planner", scopeContract: requiredScope }).modelRequirement, requiredModel);
  assert.deepEqual(normalizeScopeContract({ agent: "planner", delegation: { scopeContract: requiredScope } }).modelRequirement, requiredModel);
  const normalizedRequiredScope = normalizeScopeContract({ agent: "planner", scopeContract: requiredScope });
  assert.deepEqual(normalizeScopeContract({ agent: "planner", scopeContract: normalizedRequiredScope }).modelRequirement, requiredModel);
  const modelMetadata = { ok: true, metadata: {
    name: "planner", mode: "all", provider: "fixture", model: "model-a", variant: "high",
    canDelegate: false, externalDirectoryDenied: true, webDenied: true, bashAutomaticAllowSafe: true, canEdit: false,
  } };
  const requiredLock = { lockType: "read", scopeContract: normalizedRequiredScope };
  assert.equal(effectiveReadOnlyMetadataError(modelMetadata, requiredLock), null);
  for (const changed of [{ model: "other" }, { provider: "other" }, { variant: "low" }]) {
    assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: { ...modelMetadata.metadata, ...changed } }, requiredLock).errorType,
      "configured_model_requirement_mismatch");
  }
  assert.deepEqual(parseModelAllowlistEntry("opencode/gpt-5.3-codex@high"), { provider: "opencode", model: "gpt-5.3-codex", variant: "high" });
  assert.deepEqual(parseModelAllowlistEntry(" openai/gpt-5.6-terra "), { provider: "openai", model: "gpt-5.6-terra", variant: "" });
  assert.equal(parseModelAllowlistEntry("nomodel"), null);
  assert.equal(parseModelAllowlistEntry("provider/"), null);
  assert.equal(parseModelAllowlistEntry("provider/model@"), null);
  assert.equal(parseModelAllowlistEntry(""), null);
  const overrideRequirement = { provider: "opencode", model: "gpt-5.3-codex", variant: "high" };
  assert.equal(allowlistedModelOverride(overrideRequirement, "planner", []), null);
  assert.deepEqual(
    allowlistedModelOverride(overrideRequirement, "planner", ["opencode/gpt-5.3-codex@high"]),
    { provider: "opencode", model: "gpt-5.3-codex", variant: "high", source: "operator_allowlist" }
  );
  assert.equal(allowlistedModelOverride(overrideRequirement, "planner", ["opencode/gpt-5.3-codex@low"]), null);
  assert.equal(allowlistedModelOverride({ provider: "opencode", model: "gpt-5.3-codex" }, "planner", ["opencode/gpt-5.3-codex@high"]).variant, "high");
  assert.equal(allowlistedModelOverride({ provider: "opencode", model: "gpt-5.3-codex" }, "planner", ["opencode/gpt-5.3-codex"]).variant, "");
  assert.equal(allowlistedModelOverride(overrideRequirement, MCP_SANITIZED_READER_AGENT, ["opencode/gpt-5.3-codex@high"]), null);
  assert.equal(allowlistedModelOverride(overrideRequirement, "planner", ["opencode/other@high", "bad-entry", ""]), null);
  assert.equal(allowlistedModelOverride(null, "planner", ["opencode/gpt-5.3-codex"]), null);
  const overriddenMetadata = applyModelOverrideToMetadata(
    modelMetadata.metadata,
    allowlistedModelOverride(overrideRequirement, "planner", ["opencode/gpt-5.3-codex"])
  );
  assert.equal(overriddenMetadata.provider, "opencode");
  assert.equal(overriddenMetadata.model, "gpt-5.3-codex");
  assert.equal(overriddenMetadata.variant, "high");
  assert.equal(overriddenMetadata.modelSelection, "operator_allowlist_override");
  assert.equal(overriddenMetadata.profileProvider, "fixture");
  assert.equal(overriddenMetadata.profileModel, "model-a");
  assert.equal(overriddenMetadata.canEdit, false);
  assert.equal(applyModelOverrideToMetadata(modelMetadata.metadata, null), modelMetadata.metadata);
  assert.equal(applyModelOverrideToMetadata(null, { provider: "x", model: "y", variant: "" }), null);
  assert.ok(openCodeRunArgs("planner", "probe", overriddenMetadata).join(" ").includes("--model opencode/gpt-5.3-codex --variant high"));
  selfTestHooks.selfTestModelOverrideAllowlist = ["opencode/gpt-5.3-codex@high"];
  try {
    const overrideScope = normalizeScopeContract({ agent: "planner", scopeContract: { mode: "read", read: ["src"], modelRequirement: overrideRequirement } });
    assert.equal(effectiveReadOnlyMetadataError(modelMetadata, { lockType: "read", scopeContract: overrideScope }), null);
    const unlistedScope = normalizeScopeContract({ agent: "planner", scopeContract: { mode: "read", read: ["src"], modelRequirement: { ...overrideRequirement, model: "not-allowlisted" } } });
    assert.equal(effectiveReadOnlyMetadataError(modelMetadata, { lockType: "read", scopeContract: unlistedScope }).errorType, "configured_model_requirement_mismatch");
    const sanitizedMetadata = { ok: true, metadata: { ...modelMetadata.metadata, name: MCP_SANITIZED_READER_AGENT } };
    assert.equal(effectiveReadOnlyMetadataError(sanitizedMetadata, { lockType: "read", scopeContract: overrideScope }).errorType, "configured_model_requirement_mismatch");
  } finally {
    selfTestHooks.selfTestModelOverrideAllowlist = null;
  }
  const text = (value, messageID = "final", id = "part-1", sessionID = "root") => ({
    type: "text", sessionID, part: { type: "text", text: value, id, messageID, time: { end: 1 } },
  });
  const model = (modelID, sessionID = "root") => ({
    type: "message.updated", properties: { info: { role: "assistant", providerID: "fixture", modelID, sessionID } },
  });
  const inspect = (events, stderr = "") => inspectOpenCodeEventStream(
    events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n"), stderr
  );
  const classify = (inspection, extra = {}) => classifyResultError({
    exitCode: 0, assistantFinalResponseDetected: inspection.finalResponseDetected,
    streamIntegrity: inspection.streamIntegrity, malformedEventLines: inspection.malformedEventLines,
    runtimeModelConflict: inspection.runtimeModelConflict, modelEvidenceAmbiguous: inspection.modelEvidenceAmbiguous,
    permissionDeniedCount: inspection.permissionDeniedCount, ...extra,
  });
  for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]) {
    const canary = prefix + "A".repeat(36);
    for (const value of [canary, `api_key=${canary}`, `https://example.invalid/?value=${canary}`, JSON.stringify({ output: canary })]) {
      assert.equal(redactSensitiveText(value).includes(canary), false, `GitHub ${prefix} canary must be redacted.`);
      assert.equal(JSON.stringify(sanitizePersistedValue({ resultText: value })).includes(canary), false);
      assert.equal(JSON.stringify(sanitizeLogValue({ evidence: value })).includes(canary), false);
    }
  }
  assert.equal(redactSensitiveText("github_pat_example ghp_short normal report"), "github_pat_example ghp_short normal report");
  const multipart = inspect([text("draft", "commentary"), text("A"), text("A revised"), text("B", "final", "part-2")]);
  assert.equal(multipart.finalText, "A revised\n\nB");
  assert.equal(multipart.finalResponseDetected, true);
  assert.equal(inspect([text("old", "before"), text("new", "after")]).finalText, "new");
  assert.equal(inspect([text("old"), { type: "tool_use", sessionID: "root", part: { tool: "read", state: { status: "completed" } } }]).finalResponseDetected, false);
  assert.equal(inspect([text("old"), { type: "text", sessionID: "root", part: { type: "text", text: "unfinished", time: {} } }]).finalResponseDetected, false);
  const switched = inspect([model("model-a"), model("model-b"), text("done")]);
  assert.equal(switched.runtimeModelConflict, true);
  assert.equal(switched.runtimeObservedModel, "model-b");
  assert.equal(classify(switched), "opencode_model_mismatch");
  const child = inspect([
    { type: "step_start", sessionID: "root" }, model("parent"),
    model("child", "child-session"), text("child answer", "child-final", "child-part", "child-session"),
    text("parent answer"),
  ]);
  assert.equal(child.runtimeObservedModel, "parent");
  assert.equal(child.runtimeModelConflict, false);
  assert.equal(child.finalText, "parent answer");
  const ambiguous = inspect([model("a", "left"), model("b", "right")]);
  assert.equal(ambiguous.modelEvidenceAmbiguous, true);
  const missing = inspect([text("done")]);
  assert.equal(missing.runtimeObservedModel, "");
  assert.equal(classify(missing), null);
  assert.equal(classify(missing, { requireRuntimeModelEvidence: true }), "opencode_model_evidence_required");
  assert.equal(classify(missing, { requireRuntimeModelEvidence: true, modelAttested: true }), null);
  assert.equal(inspect([text("my model is fixture/model-a")]).runtimeObservedModel, "");
  for (const malformed of ["{cut-off", "null", "[]", "42", JSON.stringify({ unexpected: "object" })]) {
    const result = inspect([malformed, text("done")]);
    assert.equal(result.streamIntegrity, "malformed");
    assert.equal(classify(result), "opencode_stream_malformed");
  }
  const denial = "permission requested: bash (git log --oneline --decorate -10); auto-rejecting";
  const denied = inspect([{ type: "tool_use", sessionID: "root", part: { tool: "bash", state: { status: "error" } } }], denial);
  assert.equal(classify(denied), "agent_permission_denied_without_final_response");
  assert.equal(classify(inspect([text("Partial report: shell was denied.")], denial)), null);
  assert.equal(classify(inspect([])), "agent_empty_final_response");
  console.log("Event evidence and redaction regression tests passed.");
}

async function runSelfTests() {
  runEventEvidenceSelfTests();
  const selfTestProgress = (stage) => console.log(`[${new Date().toISOString()}] self-test: ${stage}`);
  selfTestProgress("start");
  const initialSelfTestStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
  const earlySelfTestStateDir = await mkdtemp(path.join(tmpdir(), "codex-opencode-self-test-state-"));
  selfTestHooks.stateDirectoryOverride = earlySelfTestStateDir;
  selfTestProgress("core validation/security");
  {
    const flights = new Map();
    let calls = 0;
    let releaseFlight;
    const gate = new Promise((resolve) => { releaseFlight = resolve; });
    const operation = async () => {
      calls += 1;
      await gate;
      return { ok: true, call: calls };
    };
    const first = runSingleFlight(flights, "same", operation);
    const second = runSingleFlight(flights, "same", operation);
    releaseFlight();
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true, call: 1 }, { ok: true, call: 1 }]);
    assert.equal(calls, 1, "Concurrent single-flight callers must share one operation.");
    assert.equal(flights.size, 0, "A completed single-flight operation must not remain cached.");
    await runSingleFlight(flights, "same", async () => ({ ok: ++calls, call: calls }));
    assert.equal(calls, 2, "A later caller must re-run the operation instead of using a settled cache entry.");

    let failureCalls = 0;
    const fail = () => runSingleFlight(flights, "failure", async () => {
      failureCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("single-flight-test-failure");
    });
    await assert.rejects(Promise.all([fail(), fail()]), /single-flight-test-failure/);
    assert.equal(failureCalls, 1, "Concurrent failures must share one fail-closed operation.");
    assert.equal(flights.size, 0, "A failed single-flight operation must be removed immediately.");
    assert.deepEqual(
      await runSingleFlight(flights, "failure", async () => ({ ok: true })),
      { ok: true },
      "A failure must never be cached for a later caller."
    );
  }
  const previewReceiptIdentityArguments = {
    patch: {
      patchSha256: "a".repeat(64),
      sourceBaseCommit: "b".repeat(40),
      sourceStateSha256: "c".repeat(64),
    },
    targetState: {
      targetHead: "d".repeat(40),
      targetStateSha256: "e".repeat(64),
    },
    contractSha256: "f".repeat(64),
    projectKey: process.cwd(),
  };
  const previewTimingFixture = await makeIntegrationPreviewReceipt(previewReceiptIdentityArguments);
  assert.equal(
    Date.parse(previewTimingFixture.expiresAt) - Date.parse(previewTimingFixture.createdAt),
    INTEGRATION_PREVIEW_TTL_MS
  );
  INTEGRATION_PREVIEWS.delete(previewTimingFixture.previewId);
  INTEGRATION_PREVIEWS.set("expired-preview-self-test", {
    identity: {},
    expiresAt: Date.now() - 1,
    projectKey: path.resolve(process.cwd()),
  });
  sweepIntegrationPreviews();
  assert.equal(INTEGRATION_PREVIEWS.has("expired-preview-self-test"), false);
  {
    const previewExpectedIdentity = {
      patchSha256: previewReceiptIdentityArguments.patch.patchSha256,
      sourceBaseCommit: previewReceiptIdentityArguments.patch.sourceBaseCommit,
      sourceStateSha256: previewReceiptIdentityArguments.patch.sourceStateSha256,
      targetHead: previewReceiptIdentityArguments.targetState.targetHead,
      targetStateSha256: previewReceiptIdentityArguments.targetState.targetStateSha256,
      contractSha256: previewReceiptIdentityArguments.contractSha256,
    };
    assert.equal(
      await integrationPreviewReceiptError(previewTimingFixture, previewExpectedIdentity, true, previewReceiptIdentityArguments.projectKey),
      "",
      "A valid unconsumed receipt must be accepted."
    );
    INTEGRATION_PREVIEWS.delete(previewTimingFixture.previewId);
    assert.equal(
      await integrationPreviewReceiptError(previewTimingFixture, previewExpectedIdentity, true, previewReceiptIdentityArguments.projectKey),
      "Integration preview receipt was already consumed.",
      "A consumed receipt must stay single-use after process memory is lost."
    );
    const restartPreviewFixture = await makeIntegrationPreviewReceipt(previewReceiptIdentityArguments);
    assert.notEqual(restartPreviewFixture.previewId, previewTimingFixture.previewId);
    INTEGRATION_PREVIEWS.delete(restartPreviewFixture.previewId);
    assert.equal(
      await integrationPreviewReceiptError(restartPreviewFixture, previewExpectedIdentity, true, previewReceiptIdentityArguments.projectKey),
      "",
      "An unconsumed receipt lost to a bridge restart must still be accepted once."
    );
    assert.equal(
      await integrationPreviewReceiptError(restartPreviewFixture, previewExpectedIdentity, true, previewReceiptIdentityArguments.projectKey),
      "Integration preview receipt was already consumed.",
      "The restart receipt consumption must be durable."
    );
    const previewStateRoot = await resolveProjectStateRoot(previewReceiptIdentityArguments.projectKey);
    const previewDbPath = stateDbPath(previewStateRoot);
    const previewDb = await openLockDb(previewReceiptIdentityArguments.projectKey);
    try {
      const expiredPreviewId = "0".repeat(64);
      previewDb.prepare(`
        INSERT INTO consumed_integration_previews (preview_id, expires_at, consumed_at)
        VALUES (?, ?, ?)
      `).run(expiredPreviewId, Date.now() - 1, Date.now() - 2);
      statePruneTimes.delete(previewDbPath);
      prunePersistedState(previewDb, previewDbPath);
      assert.equal(
        previewDb.prepare("SELECT 1 FROM consumed_integration_previews WHERE preview_id = ?").get(expiredPreviewId),
        undefined,
        "Expired integration preview consumption records must be pruned."
      );
      assert.ok(
        previewDb.prepare("SELECT 1 FROM consumed_integration_previews WHERE preview_id = ?").get(restartPreviewFixture.previewId),
        "Unexpired integration preview consumption records must be retained."
      );
    } finally {
      closeDb(previewDb);
    }
  }
  const exampleConfigPath = path.join(BRIDGE_RUNTIME_DIR, "codex", "config.example.toml");
  if (existsSync(exampleConfigPath)) {
    const exampleConfig = await readFile(exampleConfigPath, "utf8");
    const retentionMatch = exampleConfig.match(/^CODEX_OPENCODE_QUEUE_RETENTION_DAYS\s*=\s*"(\d+)"/m);
    assert.ok(retentionMatch, "config.example.toml pins CODEX_OPENCODE_QUEUE_RETENTION_DAYS.");
    assert.ok(
      Number(retentionMatch[1]) > 0,
      "config.example.toml QUEUE_RETENTION_DAYS must be strictly positive; zero crashes startup."
    );
  }
  {
    const quoteFixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-quotepath-self-test-"));
    try {
      const unicodeFileName = "\u0645\u0644\u0641.txt";
      await runCommand("git", ["init", "-q"], quoteFixtureRoot, 1000 * 30);
      await runCommand("git", ["config", "user.email", "bridge-self-test@example.invalid"], quoteFixtureRoot, 1000 * 30);
      await runCommand("git", ["config", "user.name", "bridge-self-test"], quoteFixtureRoot, 1000 * 30);
      await writeFile(path.join(quoteFixtureRoot, unicodeFileName), "one\n", "utf8");
      await runCommand("git", ["add", "-A"], quoteFixtureRoot, 1000 * 30);
      await runCommand("git", ["commit", "-qm", "seed"], quoteFixtureRoot, 1000 * 30);
      await writeFile(path.join(quoteFixtureRoot, unicodeFileName), "two\n", "utf8");
      const changedUnicodeFiles = await gitChangedFiles(quoteFixtureRoot);
      assert.deepEqual(
        changedUnicodeFiles,
        [unicodeFileName],
        "Changed-file validation must observe non-ASCII paths verbatim (core.quotePath=false)."
      );
    } finally {
      await rm(quoteFixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
  }
  assert.doesNotThrow(() => assertSupportedQueueRetryConfig({ queueReadOnlyRetries: 0, queueWriteRetries: 0 }));
  assert.throws(
    () => assertSupportedQueueRetryConfig({ queueReadOnlyRetries: 1, queueWriteRetries: 0 }),
    /unsupported and must remain 0/
  );
  const previousCallerModel = process.env.CODEX_OPENCODE_CALLER_MODEL;
  try {
    process.env.CODEX_OPENCODE_CALLER_MODEL = "multiplexed";
    assert.throws(() => assertSupportedCallerModel(), /only supports trusted_stdio/);
  } finally {
    if (previousCallerModel === undefined) delete process.env.CODEX_OPENCODE_CALLER_MODEL;
    else process.env.CODEX_OPENCODE_CALLER_MODEL = previousCallerModel;
  }
  assert.equal(transientGitIndexReadError({ stderr: "fatal: .git/index: index file open failed: Permission denied" }), true);
  assert.equal(transientGitIndexReadError({ stderr: "fatal: not a git repository" }), false);
  let gitIndexReadAttempts = 0;
  const retriedGitIndexRead = await runGitReadOnlyCommand(["diff", "--cached", "--name-only"], process.cwd(), 1000, async () => {
    gitIndexReadAttempts += 1;
    return gitIndexReadAttempts < 3
      ? { exitCode: 1, stdout: "", stderr: "fatal: .git/index: index file open failed: Permission denied" }
      : { exitCode: 0, stdout: "", stderr: "" };
  });
  assert.equal(retriedGitIndexRead.exitCode, 0);
  assert.equal(gitIndexReadAttempts, 3);
  assert.deepEqual(parallelExecutionOverlapEvidence([
    { result: { childExecutionIntervals: [{ startedAtMs: 10, finishedAtMs: 20 }] } },
    { result: { childExecutionIntervals: [{ startedAtMs: 20, finishedAtMs: 30 }] } },
  ]), { ranConcurrently: false, pairs: [] });
  assert.deepEqual(parallelExecutionOverlapEvidence([
    { result: { childExecutionIntervals: [{ startedAtMs: 10, finishedAtMs: 25 }] } },
    { result: { childExecutionIntervals: [{ startedAtMs: 20, finishedAtMs: 30 }] } },
  ]), { ranConcurrently: true, pairs: [[0, 1]] });
  let independentSiblingCompleted = false;
  const independentSettled = await settleIndependentParallelJobs([
    Promise.reject(new Error("parallel infrastructure self-test")),
    new Promise((resolve) => setImmediate(() => {
      independentSiblingCompleted = true;
      resolve("sibling completed");
    })),
  ]);
  assert.equal(independentSettled[0].status, "rejected");
  assert.equal(independentSettled[1].status, "fulfilled");
  assert.equal(independentSiblingCompleted, true);
  assert.deepEqual(
    directExecutionLockConflictDetails({ conflict: { origin: "internal" } }),
    {
      headline: "Write job is waiting for an active writer.",
      errorType: "write_lock_conflict",
      suggestedFix: "Wait for the active writer to finish, retry later, or choose a non-overlapping lockedPaths scope.",
    }
  );
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "manual" } }).errorType, "manual_lock_misuse");
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "legacy" } }).errorType, "manual_lock_misuse");
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "internal" } }, { queueConflict: true }).errorType, "queue_lock_conflict");
  assert.equal(directExecutionLockConflictDetails({ conflict: { origin: "internal" } }, { lockType: "read" }).errorType, "read_lock_conflict");
  const disjointDirtyDetails = dirtyCheckpointDetails({
    dirtyFiles: ["src/disjoint.txt"],
    overlappingFiles: [],
    disjointFiles: ["src/disjoint.txt"],
  });
  assert.deepEqual(disjointDirtyDetails.conflictingPaths, ["src/disjoint.txt"]);
  const mixedDirtyDetails = dirtyCheckpointDetails({
    dirtyFiles: ["src/allowed.txt", "src/disjoint.txt"],
    overlappingFiles: ["src/allowed.txt"],
    disjointFiles: ["src/disjoint.txt"],
  });
  assert.deepEqual(mixedDirtyDetails.conflictingPaths, ["src/allowed.txt"]);
  const dirtyRejectionText = formatRejectedExecution({
    conflictingPaths: mixedDirtyDetails.conflictingPaths,
    dirtyFiles: mixedDirtyDetails.dirtyFiles,
    overlappingFiles: mixedDirtyDetails.overlappingFiles,
    disjointFiles: mixedDirtyDetails.disjointFiles,
  });
  assert.match(dirtyRejectionText, /dirtyFiles: src\/allowed\.txt, src\/disjoint\.txt/);
  assert.match(dirtyRejectionText, /overlappingFiles: src\/allowed\.txt/);
  assert.match(dirtyRejectionText, /disjointFiles: src\/disjoint\.txt/);
  const managedSkillFixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-managed-skill-self-test-"));
  const managedSkillSourceRoot = path.join(managedSkillFixtureRoot, "managed-skill-source");
  const managedSkillConfigRoot = path.join(managedSkillFixtureRoot, "managed-skill-config");
  const managedSkillEffectiveRoot = path.join(managedSkillConfigRoot, "skills");
  const managedSkillDebug = [];
  for (const skill of REQUIRED_MANAGED_SKILLS) {
    const sourcePath = path.join(managedSkillSourceRoot, skill, "SKILL.md");
    const effectivePath = path.join(managedSkillEffectiveRoot, skill, "SKILL.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(effectivePath), { recursive: true });
    await writeFile(sourcePath, `${skill}\n`, "utf8");
    await writeFile(effectivePath, `${skill}\n`, "utf8");
    managedSkillDebug.push({ name: skill, location: effectivePath, content: `${skill}\n` });
  }
  managedSkillDebug.push({ name: "customize-opencode", location: "<built-in>", content: "built in" });
  assert.equal(await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  }), null);
  assert.equal(await managedSkillPolicyError(MCP_ORCHESTRATOR_AGENT, {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
    metadata: { skillDenied: false },
  }), null);
  assert.equal(await managedSkillPolicyError(MCP_CONTRACTOR_ORCHESTRATOR_AGENT, {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: null,
    metadata: { skillDenied: true },
  }), null);
  await writeFile(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "SKILL.md.bak"), "ignored backup\n", "utf8");
  assert.equal(await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  }), null);
  await writeFile(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "unexpected.txt"), "unexpected\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await rm(path.join(managedSkillEffectiveRoot, "agent-suitability-check", "unexpected.txt"), { force: true });
  await writeFile(path.join(managedSkillEffectiveRoot, "builder-safety", "SKILL.md"), "mutated\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await writeFile(path.join(managedSkillEffectiveRoot, "builder-safety", "SKILL.md"), "builder-safety\n", "utf8");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: [...managedSkillDebug, { ...managedSkillDebug[0] }],
  })).errorType, "managed_skill_integrity_failed");
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug.map((skill) => skill.name === "builder-safety"
      ? { ...skill, location: path.join(managedSkillFixtureRoot, "alternate-skills", "builder-safety", "SKILL.md") }
      : skill),
  })).errorType, "managed_skill_integrity_failed");
  const linkedManagedSkill = path.join(managedSkillEffectiveRoot, "linked-skill");
  await symlink(
    path.join(managedSkillSourceRoot, "builder-safety"),
    linkedManagedSkill,
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.equal((await managedSkillPolicyError("builder", {
    sourceRoot: managedSkillSourceRoot,
    effectiveConfigRoot: managedSkillConfigRoot,
    debugSkills: managedSkillDebug,
  })).errorType, "managed_skill_integrity_failed");
  await rm(linkedManagedSkill, { recursive: true, force: true });
  await rm(managedSkillFixtureRoot, { recursive: true, force: true });
  const sanitizedPolicyFixture = { root: "sanitized" };
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, subagentStrategy: "direct" }).errorType, "sanitized_workspace_subagent_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, validationCommand: "git status --short" }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, scopeContract: { validationCommand: "git diff --check" } }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, delegation: { validationCommand: "git status --short" } }).errorType, "sanitized_workspace_command_forbidden");
  assert.equal(sanitizedJobPolicyError({ sanitizedWorkspace: sanitizedPolicyFixture, subagentStrategy: "reject" }), null);
  assert.deepEqual(sanitizedDiscoveryContext({ cwd: "sensitive-data", sanitizedWorkspace: sanitizedPolicyFixture }), {
    forcePure: true,
    routeToSanitizedAgent: true,
    discoveryCwd: "sensitive-data",
  });
  assert.deepEqual(sanitizedDiscoveryContext({ cwd: "ordinary-repo" }), {
    forcePure: false,
    routeToSanitizedAgent: false,
    discoveryCwd: "ordinary-repo",
  });
  assert.equal(shouldUseWorktree({ dryRun: false, sanitizedWorkspace: sanitizedPolicyFixture }, { lockType: "read", sanitizedWorkspace: sanitizedPolicyFixture }, "all"), false);
  assert.equal(REQUIRED_MANAGED_AGENTS.includes(MCP_SANITIZED_READER_AGENT), true);
  assert.equal(GLOBALLY_REQUIRED_MANAGED_AGENTS.includes(MCP_SANITIZED_READER_AGENT), false);
  const sanitizedAgentSource = await readFile(path.join(BRIDGE_RUNTIME_DIR, "opencode", "agents", `${MCP_SANITIZED_READER_AGENT}.md`), "utf8");
  assert.equal(
    sanitizedAgentSource.split(/^---\s*$/m).slice(2).join("---").trim().replace(/\r\n/g, "\n"),
    MCP_SANITIZED_READER_PROMPT
  );
  const sanitizedRouteFixture = {
    requestedAgent: "reviewer",
    actualAgent: MCP_SANITIZED_READER_AGENT,
    actualAgentMode: "all",
    proxyUsed: false,
    fallbackUsed: false,
  };
  assert.equal(sanitizedRoutingPolicyError(
    { sanitizedWorkspace: { root: "sensitive-data" } },
    sanitizedRouteFixture,
    path.resolve("sensitive-data")
  ), null);
  assert.equal(sanitizedRoutingPolicyError(
    { sanitizedWorkspace: { root: "sensitive-data" } },
    { ...sanitizedRouteFixture, actualAgent: "reviewer" },
    path.resolve("sensitive-data")
  ).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedSafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, edit: false, write: false, task: false, bash: true, webfetch: true, websearch: true, skill: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "*", action: "deny" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: sanitizedSafeMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_SANITIZED_READER_AGENT, expectedMode: "all" }
  ), null);
  const sanitizedMetadataRoot = path.resolve("sensitive-data");
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedSafeMetadata }, sanitizedMetadataRoot), null);
  const sanitizedRuntimeRoot = path.join(tmpdir(), `codex-opencode-sanitized-${process.pid}-metadata-fixture`);
  const sanitizedRootToolOutputMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, edit: false, write: false, task: false, bash: true, webfetch: true, websearch: true, skill: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: `${path.join(sanitizedRuntimeRoot, "opencode", "tool-output")}\\*`, action: "allow" },
      { permission: "external_directory", pattern: `${path.join(sanitizedRuntimeRoot, "tmp", "opencode")}\\*`, action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "*", action: "deny" },
    ],
  }, MCP_SANITIZED_READER_AGENT, { isolatedRuntimeRoot: sanitizedRuntimeRoot });
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedRootToolOutputMetadata, isolatedRuntimeRoot: sanitizedRuntimeRoot }, sanitizedMetadataRoot), null);
  const sanitizedSharedTempMetadata = {
    ...sanitizedRootToolOutputMetadata,
    externalAllowedPatterns: [`${path.join(tmpdir(), "opencode")}\\*`],
  };
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedSharedTempMetadata, isolatedRuntimeRoot: sanitizedRuntimeRoot }, sanitizedMetadataRoot).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedGlobalToolOutputMetadata = {
    ...sanitizedRootToolOutputMetadata,
    externalAllowedPatterns: [`${path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output")}\\*`],
  };
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedGlobalToolOutputMetadata }, sanitizedMetadataRoot).errorType, "sanitized_workspace_agent_unsafe");
  const sanitizedBashUnsafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedBashUnsafeMetadata }).errorType, "sanitized_workspace_agent_unsafe");
  const shadowedPermissionFixture = {
    name: "reviewer",
    mode: "all",
    model: { providerID: "provider", modelID: "model" },
    variant: "high",
    temperature: 0,
    tools: { apply_patch: false, edit: false, task: false },
  };
  const shadowedPermissionA = normalizeAgentDebugMetadata({
    ...shadowedPermissionFixture,
    permission: [
      { permission: "external_directory", pattern: path.join("skills", "a", "*"), action: "allow" },
      { permission: "external_directory", pattern: path.join("skills", "b", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  const shadowedPermissionB = normalizeAgentDebugMetadata({
    ...shadowedPermissionFixture,
    permission: [
      { permission: "external_directory", pattern: path.join("skills", "b", "*"), action: "allow" },
      { permission: "external_directory", pattern: path.join("skills", "a", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  assert.equal(shadowedPermissionA.permissionRulesSha256, shadowedPermissionB.permissionRulesSha256);
  assert.equal(shadowedPermissionA.permissionProfileSha256, shadowedPermissionB.permissionProfileSha256);
  const sanitizedWebUnsafeMetadata = normalizeAgentDebugMetadata({
    name: MCP_SANITIZED_READER_AGENT,
    mode: "all",
    model: { providerID: MCP_SANITIZED_READER_PROFILE.provider, modelID: MCP_SANITIZED_READER_PROFILE.model },
    variant: MCP_SANITIZED_READER_PROFILE.variant,
    temperature: 0,
    prompt: MCP_SANITIZED_READER_PROMPT,
    tools: { apply_patch: false, task: false, bash: false, webfetch: true, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "allow" },
    ],
  }, MCP_SANITIZED_READER_AGENT);
  assert.equal(sanitizedAgentMetadataError({ ok: true, metadata: sanitizedWebUnsafeMetadata }).errorType, "sanitized_workspace_agent_unsafe");
  const flattenedReviewerMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: path.join(tmpdir(), "opencode", "*"), action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git status --short", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: `${path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output")}\\*`, action: "allow" },
    ],
  }, "reviewer");
  assert.equal(flattenedReviewerMetadata.externalDirectoryDenied, true);
  assert.equal(flattenedReviewerMetadata.bashAutomaticAllowSafe, true);
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: flattenedReviewerMetadata }, { lockType: "read" }), null);
  const unsafeTrailingExternalMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: false, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: path.join(tmpdir(), "secret", "*"), action: "allow" },
    ],
  }, "reviewer");
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: unsafeTrailingExternalMetadata }, { lockType: "read" }).errorType, "agent_permissions_unsafe");
  const unsafeWriterMetadata = normalizeAgentDebugMetadata({
    name: "builder",
    mode: "all",
    model: { providerID: "google", modelID: "writer-model" },
    variant: "high",
    tools: { apply_patch: true, task: true, bash: true, webfetch: true, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  }, "builder");
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: unsafeWriterMetadata }, { lockType: "write" }).errorType, "agent_permissions_unsafe");
  const managedWriterFixture = (protectedPatterns = DEFAULT_FORBIDDEN_EDIT_PATHS, bashDefaultAction = "deny") => normalizeAgentDebugMetadata({
    name: "builder",
    mode: "all",
    model: { providerID: "google", modelID: "writer-model" },
    variant: "high",
    tools: { apply_patch: true, edit: true, write: true, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "edit", pattern: "*", action: "allow" },
      ...protectedPatterns.map((pattern) => ({ permission: "edit", pattern, action: "deny" })),
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: bashDefaultAction },
      { permission: "bash", pattern: "git status --short", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
    ],
  }, "builder");
  const safeManagedWriterMetadata = managedWriterFixture();
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: safeManagedWriterMetadata }, { lockType: "write" }), null);
  const interactiveNestedWriterMetadata = managedWriterFixture(DEFAULT_FORBIDDEN_EDIT_PATHS, "ask");
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: interactiveNestedWriterMetadata }).errorType, "contractor_nested_agent_permissions_unsafe");
  const missingProtectedWriterMetadata = managedWriterFixture(DEFAULT_FORBIDDEN_EDIT_PATHS.filter((pattern) => pattern !== "*.pem"));
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: missingProtectedWriterMetadata }, { lockType: "write" }).errorType, "agent_permissions_unsafe");
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: flattenedReviewerMetadata },
    { lockType: "read" },
    { expectedAgent: "reviewer", expectedMode: "primary" }
  ).errorType, "agent_mode_unattested");
  const changedReviewerMetadata = normalizeAgentDebugMetadata({
    name: "reviewer",
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: false, bash: true, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "git diff", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
    ],
  }, "reviewer");
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: changedReviewerMetadata },
    { lockType: "read" },
    { expectedAgent: "reviewer", expectedMode: "all", expectedMetadata: flattenedReviewerMetadata }
  ).errorType, "agent_metadata_changed");
  const contractorMetadataFixture = (extraTaskRules = [], bash = false, skill = false) => normalizeAgentDebugMetadata({
    name: MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
    mode: "all",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
    tools: { apply_patch: false, task: true, bash, skill, webfetch: false, websearch: false },
    permission: [
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      ...[...CONTRACTOR_ALLOWED_SUBAGENTS].map((agent) => ({ permission: "task", pattern: agent, action: "allow" })),
      ...extraTaskRules,
    ],
  }, MCP_CONTRACTOR_ORCHESTRATOR_AGENT);
  const safeContractorMetadata = contractorMetadataFixture();
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: safeContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ), null);
  const shellEnabledContractorMetadata = contractorMetadataFixture([], true);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: shellEnabledContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const skillEnabledContractorMetadata = contractorMetadataFixture([], false, true);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: skillEnabledContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const wildcardContractorMetadata = contractorMetadataFixture([{ permission: "task", pattern: "*", action: "allow" }]);
  assert.equal(effectiveReadOnlyMetadataError(
    { ok: true, metadata: wildcardContractorMetadata },
    { lockType: "read" },
    { expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, expectedMode: "all", allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }
  ).errorType, "agent_permissions_unsafe");
  const managedSourceFixture = managedAgentSourceProfile([
    "---",
    "mode: all",
    "model: openai/gpt-5.6-terra",
    "variant: high",
    "temperature: 0",
    "---",
    "Exact managed prompt.",
  ].join("\n"), "managed-fixture");
  assert.deepEqual(managedSourceFixture, {
    name: "managed-fixture",
    mode: "all",
    provider: "openai",
    model: "gpt-5.6-terra",
    variant: "high",
    temperature: 0,
    promptSha256: createHash("sha256").update("Exact managed prompt.").digest("hex"),
  });
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: safeManagedWriterMetadata }), null);
  assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: unsafeWriterMetadata }).errorType, "contractor_nested_agent_permissions_unsafe");
  assert.equal(contractorNestedAgentMetadataError("reviewer", { ok: true, metadata: flattenedReviewerMetadata }), null);
  assert.equal(providerErrorTypeFromText("429 RESOURCE_EXHAUSTED rateLimitExceeded"), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromText("daily project quota exceeded"), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("OAuth invalid_grant: refresh token revoked"), "opencode_auth_error");
  assert.equal(providerErrorTypeFromText("HTTP 503 service unavailable"), "opencode_provider_unavailable");
  assert.equal(providerErrorTypeFromText("read ECONNRESET"), "opencode_transport_error");
  assert.equal(providerErrorTypeFromText("HTTP 403 rateLimitExceeded"), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromText("HTTP 403"), "");
  assert.equal(providerErrorTypeFromText("Error in src/billing/formatter.js"), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "fixture contains billing error handling" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "Assertion text: 429 rate limit expected" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "Source note: model unavailable branch" } }), "");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { statusCode: 429, code: "rateLimitExceeded", message: "request rejected" } }), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { name: "CreditsError", message: "No payment method" } }), "opencode_billing_error");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "ProviderAuthError", data: { providerID: "google", message: "invalid API key" } } },
  }), "opencode_auth_error");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "APIError", data: { message: "service unavailable", statusCode: 503, isRetryable: true } } },
  }), "opencode_provider_unavailable");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "session.error",
    properties: { error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } },
  }), "opencode_rate_limited");
  assert.equal(providerErrorTypeFromStructuredEvent({
    type: "error",
    error: { name: "ModelValidationError", message: "Local fixture says model unavailable" },
  }), "");
  assert.equal(retryAfterMsFromText('{"retryAfterMs":1500}'), 1500);
  assert.equal(retryAfterMsFromText('{"retryAfter":"2.5"}'), 2500);
  assert.equal(retryAfterMsFromText('RetryInfo retryDelay: "12s"'), 12000);
  const retryDateBase = Date.parse("2026-08-09T00:00:00.000Z");
  assert.equal(retryAfterMsFromText("Retry-After: Sun, 09 Aug 2026 00:00:05 GMT", retryDateBase), 5000);
  assert.equal(validationCommandTrustError(["cmd", "/c", "echo", "unsafe"]).length > 0, true);
  assert.equal(validationCommandTrustError(["node", "-e", "process.exit(0)"]).length > 0, true);
  assert.equal(validationCommandTrustError(["git", "status"]), "");
  assert.equal(await validationCommandPreflightError(""), null);
  assert.equal(await validationCommandPreflightError("git status"), null);
  assert.equal((await validationCommandPreflightError("evil-tool --run")).errorType, "validation_command_untrusted");
  assert.equal((await validationCommandPreflightError("npx vitest")).errorType, "validation_command_untrusted");
  assert.equal((await validationCommandPreflightError("git status 'unterminated")).errorType, "validation_command_parse_error");
  assert.equal(await validationCommandPreflightError("evil-tool --run", { dryRun: true }), null);
  assert.equal(await validationCommandPreflightError("evil-tool --run", { sanitized: true }), null);
  {
    // Attestation cache: hits reuse results, failures are never cached, callers cannot
    // mutate cached state, a clear or TTL 0 forces re-attestation, and file edits
    // change the fingerprint inputs.
    selfTestHooks.attestationCacheTtlOverride = 60_000;
    clearAttestationCache();
    let calls = 0;
    const attest = async () => ({ ok: true, call: ++calls });
    const okOnly = (value) => Boolean(value?.ok);
    assert.equal((await cachedAttestation("self-test\0hit", attest, okOnly)).call, 1);
    const reused = await cachedAttestation("self-test\0hit", attest, okOnly);
    assert.equal(reused.call, 1);
    assert.equal(calls, 1);
    reused.call = 99;
    assert.equal((await cachedAttestation("self-test\0hit", attest, okOnly)).call, 1);
    let failures = 0;
    const failing = async () => ({ ok: false, attempt: ++failures });
    await cachedAttestation("self-test\0fail", failing, okOnly);
    await cachedAttestation("self-test\0fail", failing, okOnly);
    assert.equal(failures, 2);
    clearAttestationCache();
    await cachedAttestation("self-test\0hit", attest, okOnly);
    assert.equal(calls, 2);
    selfTestHooks.attestationCacheTtlOverride = 0;
    await cachedAttestation("self-test\0hit", attest, okOnly);
    await cachedAttestation("self-test\0hit", attest, okOnly);
    assert.equal(calls, 4);
    selfTestHooks.attestationCacheTtlOverride = null;
    clearAttestationCache();
    const fingerprintDir = await mkdtemp(path.join(tmpdir(), "bridge-attestation-fingerprint-"));
    try {
      const tracked = path.join(fingerprintDir, "agent.md");
      await writeFile(tracked, "first", "utf8");
      const before = await statFingerprint(tracked);
      await writeFile(tracked, "second version", "utf8");
      assert.notEqual(await statFingerprint(tracked), before);
      assert.match(await statFingerprint(path.join(fingerprintDir, "missing.md")), /missing$/);
    } finally {
      await rm(fingerprintDir, { recursive: true, force: true });
    }
  }
  assert.equal(validationCommandTrustError(["git", "diff", "--check", "--", "src"], { strictProjectPolicy: true }), "");
  assert.match(validationCommandTrustError(["git", "diff", "--check", "HEAD", "HEAD"], { strictProjectPolicy: true }), /before --/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--no-index", "--", "src"], { strictProjectPolicy: true }), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--output=outside.txt"], { strictProjectPolicy: true }), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--output=outside.txt"]), /forbidden/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--", "../secret"], { strictProjectPolicy: true }), /unsafe/);
  assert.match(validationCommandTrustError(["git", "diff", "--check", "--", "C:secret"], { strictProjectPolicy: true }), /unsafe/);
  assert.match(validationCommandTrustError(parseCommandLine("git status ; node malicious.js"), { strictProjectPolicy: true }), /bounded porcelain/);
  assert.equal(exactPluginSpecifier("@scope/plugin@1.2.3"), "@scope/plugin@1.2.3");
  assert.equal(exactPluginSpecifier("@scope/plugin@latest"), "");
  assert.equal(exactPluginSpecifier("plugin@^1.2.3"), "");
  assert.deepEqual(pluginSpecsFromConfigText('{"pl\\u0075gin" /* pinned */ : ["plugin@1.2.3",],}'), ["plugin@1.2.3"]);
  assert.throws(() => pluginSpecsFromConfigText('{"plugin": ["plugin@1.2.3"], "pl\\u0075gin": []}'), /duplicate property/i);
  const readOnlyMetadataFixture = {
    name: "planner",
    mode: "primary",
    model: { providerID: "google", modelID: "test-model" },
    permission: [{ permission: "external_directory", pattern: "*", action: "deny" }],
    tools: { apply_patch: false, task: false },
  };
  assert.equal(normalizeAgentDebugMetadata(readOnlyMetadataFixture, "planner").canEdit, false);
  assert.equal(normalizeAgentDebugMetadata({ ...readOnlyMetadataFixture, tools: { task: false } }, "planner").canEdit, true);
  assert.equal(normalizeAgentDebugMetadata({ ...readOnlyMetadataFixture, tools: { apply_patch: false, edit: true, task: false } }, "planner").canEdit, true);
  const attestedReadOnlyMetadata = { ok: true, metadata: normalizeAgentDebugMetadata(readOnlyMetadataFixture, "planner") };
  assert.equal(readOnlyResultRetryable({ timedOut: true, toolOutcomes: [], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), true);
  assert.equal(readOnlyResultRetryable({ timedOut: true, providerErrorType: "opencode_auth_error", toolOutcomes: [], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), false);
  assert.equal(readOnlyResultRetryable({ timedOut: true, toolOutcomes: [{ tool: "bash", status: "running" }], invalidEventLineCount: 0, assistantFinalResponseDetected: false }, "planner", attestedReadOnlyMetadata), false);
  assert.deepEqual(modelEvidenceFromEvent({ type: "message.updated", properties: { info: { role: "assistant", providerID: "google", modelID: "pinned-model" } } }), { provider: "google", model: "pinned-model" });
  assert.equal(modelEvidenceFromEvent({ type: "text", part: { metadata: { role: "assistant", providerID: "spoof", modelID: "spoof" } } }), null);
  const secretSentinel = "secret-sentinel-bridge-test";
  const validationEnvProbe = await runSpawnCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.BRIDGE_SECRET_SENTINEL || 'absent')"],
    process.cwd(),
    1000 * 15,
    buildValidationEnv(),
  );
  assert.equal(validationEnvProbe.stdout, "absent");
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  assert.equal(Boolean(inheritedPathKey && Object.keys(buildOpenCodeEnv()).some((key) => key.toUpperCase() === "PATH")), true);
  const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
  const previousGeminiDump = process.env.GEMINI_DUMP;
  process.env.OPENCODE_CONFIG_CONTENT = '{"plugin":["evil@1.0.0"]}';
  process.env.GEMINI_DUMP = "true";
  assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(buildOpenCodeEnv().GEMINI_DUMP, undefined);
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_SHARE, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, "true");
  assert.equal(buildOpenCodeEnv().OPENCODE_DB, ":memory:");
  assert.equal(buildOpenCodeEnv().OPENCODE_DISABLE_CHANNEL_DB, "true");
  assert.equal(path.resolve(buildOpenCodeEnv().HOME), BRIDGE_OPENCODE_HOME_DIR);
  assert.equal(path.resolve(buildOpenCodeEnv().USERPROFILE), BRIDGE_OPENCODE_HOME_DIR);
  assert.equal(path.resolve(buildOpenCodeEnv().XDG_CONFIG_HOME), path.dirname(DEFAULT_OPENCODE_CONFIG_DIR));
  assert.equal(path.resolve(buildOpenCodeEnv().XDG_DATA_HOME), path.dirname(DEFAULT_OPENCODE_DATA_DIR));
  assert.equal(path.resolve(buildOpenCodeEnv({ HOME: "isolated-home", USERPROFILE: "isolated-profile" }).HOME), path.resolve("isolated-home"));
  assert.equal(openCodeRunArgs(MCP_ORCHESTRATOR_AGENT, "probe").includes("--pure"), !CONFIG.allowExternalPlugins);
  assert.equal(buildValidationEnv().GIT_CONFIG_NOSYSTEM, undefined);
  if (process.platform === "win32") {
    const trustedGitEnvFixture = buildTrustedGitEnv();
    assert.equal(trustedGitEnvFixture.GIT_CONFIG_KEY_5, "core.longpaths");
    assert.equal(trustedGitEnvFixture.GIT_CONFIG_VALUE_5, "true");
    assert.equal(trustedGitEnvFixture.GIT_CONFIG_COUNT, "6");
    assert.equal(trustedGitArgs(["worktree", "add"]).includes("core.longpaths=true"), true);
    assert.equal(buildValidationEnv().GIT_CONFIG_KEY_2, "core.longpaths");
    assert.equal(buildValidationEnv().GIT_CONFIG_COUNT, "3");
  }
  assert.equal(buildValidationEnv().GIT_ATTR_NOSYSTEM, undefined);
  const safeDiffValidationFixture = await prepareValidationCommand("git diff --check");
  assert.equal(safeDiffValidationFixture.ok, true);
  assert.deepEqual(safeDiffValidationFixture.args.slice(0, 3), ["diff", "--no-ext-diff", "--no-textconv"]);
  const isolatedRuntimeFixture = await createIsolatedOpenCodeRuntime();
  assert.equal(isPathInside(path.resolve(tmpdir()), isolatedRuntimeFixture.root), true);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.HOME), path.join(isolatedRuntimeFixture.root, "home"));
  assert.equal(isolatedRuntimeFixture.env.USERPROFILE, isolatedRuntimeFixture.env.HOME);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_DATA_HOME), isolatedRuntimeFixture.root);
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_CONFIG_HOME), path.join(isolatedRuntimeFixture.root, "config"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_CACHE_HOME), path.join(isolatedRuntimeFixture.root, "cache"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.XDG_STATE_HOME), path.join(isolatedRuntimeFixture.root, "state"));
  assert.equal(path.resolve(isolatedRuntimeFixture.env.TEMP), path.join(isolatedRuntimeFixture.root, "tmp"));
  assert.equal(isolatedRuntimeFixture.env.TMP, isolatedRuntimeFixture.env.TEMP);
  assert.equal(isolatedRuntimeFixture.env.TMPDIR, isolatedRuntimeFixture.env.TEMP);
  assert.equal(existsSync(isolatedRuntimeFixture.env.TEMP), true);
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DB, ":memory:");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_CHANNEL_DB, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
  assert.equal(isolatedRuntimeFixture.env.OPENCODE_DISABLE_CLAUDE_CODE, "true");
  const isolatedConfigFixture = JSON.parse(isolatedRuntimeFixture.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(isolatedConfigFixture.plugin, []);
  assert.deepEqual(isolatedConfigFixture.mcp, {});
  assert.equal(isolatedConfigFixture.share, "disabled");
  assert.equal(isolatedConfigFixture.agent[MCP_SANITIZED_READER_AGENT].tools.skill, false);
  const isolatedSensitiveFile = path.join(isolatedRuntimeFixture.root, "opencode", "tool-output", "sensitive.txt");
  await mkdir(path.dirname(isolatedSensitiveFile), { recursive: true });
  await writeFile(isolatedSensitiveFile, "isolated-sensitive-sentinel", "utf8");
  assert.equal((await wipeIsolatedOpenCodeRuntime(isolatedRuntimeFixture.root)).ok, true);
  assert.equal(existsSync(isolatedRuntimeFixture.root), false);
  if (previousConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent;
  if (previousGeminiDump === undefined) delete process.env.GEMINI_DUMP;
  else process.env.GEMINI_DUMP = previousGeminiDump;
  const jsonSecret = "opaque-access-token-sentinel-123456";
  assert.doesNotMatch(redactSensitiveText(`{"access_token":"${jsonSecret}","api_key":"AIza123456789012345678901234"}`), /opaque-access-token|AIza123/);
  assert.doesNotMatch(JSON.stringify(sanitizePersistedValue({ contractorAuthorizationToken: secretSentinel, resultText: `Authorization: Bearer ${secretSentinel}` })), new RegExp(secretSentinel));
  assert.equal(classifyResultError({ exitCode: 0, assistantFinalResponseDetected: true, rawOutputTruncated: true }), "essential_output_truncated");
  const dependencyRequestFixture = parseDependencyRequest('before\nDEPENDENCY_REQUIRED {"packages":[{"name":"@scope/example","version":"^1.2.3","reason":"required by the requested feature"}],"reason":"package manifest is frozen"}\nafter');
  assert.equal(dependencyRequestFixture.error, "");
  assert.equal(dependencyRequestFixture.request.packages[0].name, "@scope/example");
  assert.equal(classifyResultError({ exitCode: 0, assistantFinalResponseDetected: true, dependencyRequest: dependencyRequestFixture.request }), "dependency_required");
  const invalidDependencyRequestFixture = parseDependencyRequest('DEPENDENCY_REQUIRED {"packages":[],"reason":"missing package"}');
  assert.equal(invalidDependencyRequestFixture.request, null);
  assert.match(invalidDependencyRequestFixture.error, /required schema/);
  assert.equal(classifyResultError({ exitCode: 0, assistantFinalResponseDetected: true, dependencyRequestError: invalidDependencyRequestFixture.error }), "dependency_request_invalid");
  assert.equal(detectsOpenCodeApiError('{"type":"error","message":"No payment method"}\n'), true);
  assert.equal(detectsOpenCodeApiError('{"type":"text","message":"ok"}\n'), false);
  assert.equal(detectsOpenCodeApiError("APIError: request failed\n"), true);
  const validFinalStream = [
    JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
    JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
  ].join("\n");
  const validFinalInspection = inspectOpenCodeEventStream(validFinalStream);
  assert.equal(validFinalInspection.finalResponseDetected, true);
  assert.equal(validFinalInspection.finalText, "done");
  assert.deepEqual(validFinalInspection.toolOutcomes, [{ tool: "read", status: "completed" }]);
  const localPhraseInspection = inspectOpenCodeEventStream(
    JSON.stringify({ type: "error", error: { message: "fixture contains billing, 429 rate limit, and model unavailable assertions" } })
  );
  assert.equal(localPhraseInspection.apiErrorDetected, true);
  assert.equal(localPhraseInspection.providerErrorType, "");
  const localStderrInspection = inspectOpenCodeEventStream(validFinalStream, "Error: fixture contains billing error handling");
  assert.equal(localStderrInspection.apiErrorDetected, false);
  assert.equal(localStderrInspection.providerErrorType, "");
  const recoveredTransientInspection = inspectOpenCodeEventStream(
    validFinalStream,
    'level=ERROR message="stream error" error.error="ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"'
  );
  assert.equal(recoveredTransientInspection.apiErrorDetected, false);
  assert.equal(recoveredTransientInspection.providerErrorType, "");
  assert.equal(recoveredTransientInspection.recoveredTransientProviderError, true);
  assert.equal(recoveredTransientInspection.providerWarningType, "opencode_transient_provider_error");
  const unrecoveredTransientInspection = inspectOpenCodeEventStream(
    JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
    "ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"
  );
  assert.equal(unrecoveredTransientInspection.apiErrorDetected, true);
  assert.equal(unrecoveredTransientInspection.providerErrorType, "opencode_transient_provider_error");
  assert.equal(unrecoveredTransientInspection.recoveredTransientProviderError, false);
  const structuredErrorThenTextInspection = inspectOpenCodeEventStream([
    JSON.stringify({ type: "error", error: "ProviderHeaderTimeoutError" }),
    JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
  ].join("\n"));
  assert.equal(structuredErrorThenTextInspection.apiErrorDetected, true);
  assert.equal(structuredErrorThenTextInspection.recoveredTransientProviderError, false);
  const hardAuthErrorWithFinalInspection = inspectOpenCodeEventStream(validFinalStream, "401 Unauthorized invalid API key");
  assert.equal(hardAuthErrorWithFinalInspection.apiErrorDetected, true);
  assert.equal(hardAuthErrorWithFinalInspection.providerErrorType, "opencode_auth_error");
  assert.equal(hardAuthErrorWithFinalInspection.recoveredTransientProviderError, false);
  const toolOnlyInspection = inspectOpenCodeEventStream(JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "error" } } }));
  assert.equal(toolOnlyInspection.finalResponseDetected, false);
  assert.equal(classifyResultError({ exitCode: 0, dryRun: false, assistantFinalResponseDetected: false }), "agent_empty_final_response");
  assert.equal(classifyResultError({ exitCode: 124, timedOut: true, providerErrorType: "opencode_quota_exhausted" }), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("429 RESOURCE_EXHAUSTED daily request quota exceeded"), "opencode_quota_exhausted");
  assert.equal(providerErrorTypeFromText("401 Unauthorized invalid API key"), "opencode_auth_error");
  assert.equal(
    providerErrorTypeFromText("ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"),
    "opencode_transient_provider_error"
  );

  assert.equal(normalizeLockPath("apps/web/**"), "apps/web");
  assert.equal(normalizeLockPath("packages/shared/**"), "packages/shared");
  assert.equal(normalizeLockPath("apps/api/**"), "apps/api");
  assert.equal(normalizeLockPath("apps/api/app/**"), "apps/api/app");
  assert.equal(normalizeLockPath("apps\\api\\app\\**\\"), "apps/api/app");
  assert.equal(normalizeLockPath("apps/web///"), "apps/web");
  assert.equal(normalizeLockPath("./apps/web/*"), "apps/web");
  assert.equal(normalizeLockPath("src/./file.js"), "src/file.js");
  assert.equal(normalizeLockPath("src/."), "src");
  assert.equal(normalizeLockPath("README.md"), "README.md");
  assert.equal(isWithinAnyPath("src/file.js", ["src"], process.cwd()), true);
  assert.equal(
    isWithinAnyPath("SRC/file.js", ["src"], process.cwd()),
    filesystemCaseModeForRoot(process.cwd()) !== "sensitive"
  );
  const canonicalFilePath = normalizeLockPathForCwd("src/file.js", process.cwd());
  for (const alias of ["src/./file.js", "src//file.js", "./src/file.js"]) {
    assert.equal(normalizeLockPathForCwd(alias, process.cwd()), canonicalFilePath);
  }
  assert.equal(normalizeLockPathForCwd("src/a/../file.js", process.cwd()), "src/a/../file.js");
  assert.equal(isWithinAnyPath("private.key", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(isWithinAnyPath("apps/web/.env.local", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(isWithinAnyPath("apps/api/secrets/token.txt", DEFAULT_FORBIDDEN_EDIT_PATHS, process.cwd()), true);
  assert.equal(recordMatchesProject({ cwd: process.cwd() }, process.cwd()), true);
  assert.equal(recordMatchesProject({ cwd: path.join(process.cwd(), "other-project") }, process.cwd()), false);
  assert.equal(nextQueueScheduleDelay([{ status: "pending" }], true), 0);
  assert.equal(nextQueueScheduleDelay([{ status: "blocked" }], true), CONFIG.queueBlockedPollMs);
  assert.equal(nextQueueScheduleDelay([{ status: "blocked" }], false), null);
  assert.equal(isOrchestratorAgent("principal-engineer-orchestrator"), true);
  assert.equal(isManagedReadOnlyAgent("principal-engineer-orchestrator"), true);
  assert.equal(isOrchestratorAgent(STANDALONE_ORCHESTRATOR_AGENT), true);
  assert.equal(isManagedReadOnlyAgent(STANDALONE_ORCHESTRATOR_AGENT), true);
  assert.equal(isOrchestratorAgent(MCP_ORCHESTRATOR_AGENT), true);
  assert.equal(isOrchestratorAgent(MCP_CONTRACTOR_ORCHESTRATOR_AGENT), true);
  assert.equal(isManagedReadOnlyAgent(MCP_CONTRACTOR_ORCHESTRATOR_AGENT), false);
  assert.equal(REQUIRED_MANAGED_AGENTS.includes(STANDALONE_ORCHESTRATOR_AGENT), true);
  assert.equal(REQUIRED_MANAGED_AGENTS.includes("orchestrator"), false);
  assert.match(unsafePathReason(["../secrets"]), /parent traversal/);
  assert.match(unsafePathReason(["src/a/../file.js"]), /parent traversal/);
  assert.match(unsafePathReason(["src/foo/.."]), /parent traversal/);
  assert.match(unsafePathReason(["~/secret"]), /home-directory/);
  assert.match(unsafePathReason(["."]), /filesystem root/);
  assert.equal(defaultBuilderTimeoutMs, 1000 * 60 * 15);
  assert.equal(defaultOrchestratorTimeoutMs, 1000 * 60 * 6);
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-secret";
  assert.equal(buildOpenCodeEnv().OPENAI_API_KEY, undefined);
  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
  if (process.platform === "win32") {
    const previousPathExt = process.env.PATHEXT;
    delete process.env.PATHEXT;
    assert.equal(buildOpenCodeEnv().PATHEXT, ".COM;.EXE;.BAT;.CMD");
    if (previousPathExt !== undefined) {
      process.env.PATHEXT = previousPathExt;
    }
  }
  assert.equal(timeoutForAgent("orchestrator", { lockType: "write" }), defaultOrchestratorTimeoutMs);
  assert.equal(timeoutForAgent(MCP_ORCHESTRATOR_AGENT, { lockType: "read" }), defaultOrchestratorTimeoutMs);
  assert.equal(timeoutForAgent("debugger", { lockType: "write" }), defaultBuilderTimeoutMs);
  assert.equal(
    hardLockTtlForPlan({ agent: "builder", lockType: "write", timeoutMs: 1000 * 60 * 40 }),
    1000 * 60 * 50
  );
  assert.deepEqual(parseCommandLine('npm run "test:unit" -- --watch=false'), ["npm", "run", "test:unit", "--", "--watch=false"]);
  assert.deepEqual(
    parseCommandLine('node "C:\\Program Files\\Example\\check.js" C:\\repo\\src'),
    ["node", "C:\\Program Files\\Example\\check.js", "C:\\repo\\src"]
  );
  const validationVersionProbe = await runValidationGate({ command: "git --version", cwd: process.cwd() });
  assert.equal(validationVersionProbe.status, "passed", JSON.stringify(validationVersionProbe));
  assert.equal((await runValidationGate({ command: '"unterminated', cwd: process.cwd() })).errorType, "validation_command_parse_error");
  const timeoutProbe = await runSpawnCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], process.cwd(), 100);
  assert.equal(timeoutProbe.exitCode, 124);
  assert.equal(timeoutProbe.timedOut, true);
  const cancellationController = new AbortController();
  const cancellationProbePromise = runSpawnCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { signal: cancellationController.signal }
  );
  setTimeout(() => cancellationController.abort(), 100);
  const cancellationProbe = await cancellationProbePromise;
  assert.equal(cancellationProbe.exitCode, 130);
  assert.equal(cancellationProbe.cancelled, true);
  let transientHeartbeatCalls = 0;
  const transientHeartbeat = startHardLockHeartbeat({
    id: "transient-heartbeat",
    token: "transient-token",
    lockType: "write",
    expiresAt: Date.now() + 300,
  }, 300, {
    intervalMs: 50,
    refreshLease: async () => {
      transientHeartbeatCalls += 1;
      if (transientHeartbeatCalls === 1) throw new Error("injected transient heartbeat failure");
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(transientHeartbeat.signal.aborted, false, "One transient hard-lock heartbeat failure must not abort a healthy owner.");
  transientHeartbeat();
  const sustainedHeartbeat = startHardLockHeartbeat({
    id: "sustained-heartbeat",
    token: "sustained-token",
    lockType: "write",
    expiresAt: Date.now() + 300,
  }, 300, {
    intervalMs: 50,
    refreshLease: async () => { throw new Error("injected sustained heartbeat failure"); },
  });
  const sustainedWriter = runSpawnCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { signal: sustainedHeartbeat.signal }
  );
  const sustainedWriterResult = await sustainedWriter;
  assert.equal(sustainedHeartbeat.signal.aborted, true);
  assert.equal(sustainedWriterResult.cancellationErrorType, "write_lock_ownership_lost");
  sustainedHeartbeat();
  let transientProviderHeartbeatCalls = 0;
  const transientProviderHeartbeat = startProviderLeaseHeartbeat({
    id: "transient-provider-heartbeat",
    expiresAt: Date.now() + 300,
  }, {
    intervalMs: 50,
    refreshLease: async () => {
      transientProviderHeartbeatCalls += 1;
      if (transientProviderHeartbeatCalls === 1) throw new Error("injected transient provider heartbeat failure");
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(transientProviderHeartbeat.signal.aborted, false, "One transient provider-lease failure must not abort a healthy execution.");
  transientProviderHeartbeat();
  const sustainedProviderHeartbeat = startProviderLeaseHeartbeat({
    id: "sustained-provider-heartbeat",
    expiresAt: Date.now() + 300,
  }, {
    intervalMs: 50,
    refreshLease: async () => { throw new Error("injected sustained provider heartbeat failure"); },
  });
  const providerBoundExecution = await runSpawnCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { signal: sustainedProviderHeartbeat.signal }
  );
  assert.equal(sustainedProviderHeartbeat.signal.aborted, true);
  assert.equal(providerBoundExecution.cancellationErrorType, "provider_lease_ownership_lost");
  sustainedProviderHeartbeat();
  const transientQueueLeaseRecord = {
    jobId: "transient-queue-lease",
    status: "running",
    ownerGeneration: "generation-a",
    leaseExpiresAt: new Date(Date.now() + CONFIG.queueHeartbeatMs * 3).toISOString(),
    abortController: new AbortController(),
  };
  noteQueueLeaseRenewalFailure(transientQueueLeaseRecord, { detail: "injected transient queue heartbeat failure" });
  assert.equal(transientQueueLeaseRecord.abortController.signal.aborted, false);
  transientQueueLeaseRecord.leaseExpiresAt = new Date(Date.now() + Math.max(1, CONFIG.queueHeartbeatMs - 1)).toISOString();
  noteQueueLeaseRenewalFailure(transientQueueLeaseRecord, { detail: "injected sustained queue heartbeat failure" });
  assert.equal(transientQueueLeaseRecord.abortController.signal.aborted, true);
  assert.equal(abortSignalErrorType(transientQueueLeaseRecord.abortController.signal), "queue_ownership_lost");
  clearQueueLeaseFence(transientQueueLeaseRecord);
  const providerFailureProbe = await runSpawnCommand(
    process.execPath,
    ["-e", "console.error('APIError: 429 RESOURCE_EXHAUSTED daily quota exceeded'); setTimeout(() => {}, 10000)"],
    process.cwd(),
    10000,
    {},
    { terminateOnProviderError: true }
  );
  assert.equal(providerFailureProbe.exitCode, 1);
  assert.equal(providerFailureProbe.providerTerminated, true);

  const formattedRejection = formatRejectedExecution({
    errorType: "test_error",
    reason: "Testing structured failure output.",
    requestedAgent: "builder",
    actualAgent: "none",
    lockMode: "simple",
    durationMs: 7,
  });
  assert.match(formattedRejection, /errorType: test_error/);
  assert.match(formattedRejection, /requestedAgent: builder/);
  assert.match(formattedRejection, /actualAgent: none/);
  assert.match(formattedRejection, /durationMs: 7/);

  const writeScope = (paths, options = {}) => ({
    mode: "write",
    read: options.read || paths,
    write: paths,
    allowedEdits: options.allowedEdits || paths,
    forbidden: options.forbidden || [],
    shared: options.shared || [],
    serialOnly: options.serialOnly || [],
    validationCommand: options.validationCommand || "",
  });

  const wildcardSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit only the web app.",
    write: true,
    lockedPaths: ["apps/web/**"],
    allowedEdits: ["apps/web/**"],
    scopeContract: writeScope(["apps/web/**"]),
  });
  assert.equal(wildcardSingle.error, null);
  assert.deepEqual(wildcardSingle.lockPlan.lockedPaths, ["apps/web"]);
  assert.deepEqual(wildcardSingle.lockPlan.allowedEdits, ["apps/web"]);
  assert.equal(wildcardSingle.lockPlan.lockMode, "simple");

  const orchestratorWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Coordinate and edit files.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(orchestratorWrite.errorType, "orchestrator_write_visibility_risk");
  assert.equal(orchestratorWrite.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorPromptWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Please spawn builder and modify code files.",
  });
  assert.equal(orchestratorPromptWrite.errorType, "orchestrator_write_visibility_risk");

  const orchestratorPlanningOnly = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Plan the complete billing service architecture and return affected files and test plan.",
    orchestratorMode: "planning-only",
  });
  assert.equal(orchestratorPlanningOnly.error, null);
  assert.equal(orchestratorPlanningOnly.lockPlan.lockType, "read");
  assert.equal(orchestratorPlanningOnly.lockPlan.orchestratorMode, "planning-only");

  const orchestratorLargeAutoPlanning = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build a complete billing service.",
  });
  assert.equal(orchestratorLargeAutoPlanning.error, null);
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.lockType, "read");
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.orchestratorMode, "planning-only");

  const selfTestContractorToken = "self-test-contractor-capability";
  selfTestHooks.selfTestContractorAuthorizationSha256 = createHash("sha256").update(selfTestContractorToken).digest("hex");
  const contractorMissingAuthorization = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder for the billing service.",
    orchestratorMode: "contractor",
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorMissingAuthorization.errorType, "orchestrator_user_authorization_required");

  const contractorInvalidCapability = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder for the billing service.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: "wrong-capability",
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorInvalidCapability.errorType, "orchestrator_contractor_capability_invalid");

  const contractorAuthorized = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Contract the work and invoke builder, reviewer, and tester for the billing service.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: selfTestContractorToken,
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  });
  assert.equal(contractorAuthorized.error, null);
  assert.equal(contractorAuthorized.lockPlan.orchestratorMode, "contractor");
  assert.equal(contractorAuthorized.lockPlan.userAuthorizedOrchestrator, true);
  assert.equal(shouldUseWorktree({ dryRun: false }, contractorAuthorized.lockPlan), true);

  const contractorParallel = validateParallelWritePlan([{
    agent: "orchestrator",
    task: "Contract the work and invoke builder for billing.",
    orchestratorMode: "contractor",
    userAuthorizedOrchestrator: true,
    contractorAuthorizationToken: selfTestContractorToken,
    write: true,
    lockMode: "strict",
    lockType: "write",
    lockedPaths: ["apps/billing"],
    allowedEdits: ["apps/billing"],
    scopeContract: writeScope(["apps/billing"]),
  }]);
  assert.equal(contractorParallel.errorType, "orchestrator_contractor_must_run_alone");
  const internalContractorJobId = "internal-contractor-self-test";
  const internalContractorProof = makeInternalQueueContractorProof(internalContractorJobId);
  assert.equal(contractorAuthorizationValid({
    internalQueueJobId: internalContractorJobId,
    internalQueueContractorProof: internalContractorProof,
  }), true);
  assert.equal(contractorAuthorizationValid({
    internalQueueJobId: internalContractorJobId,
    internalQueueContractorProof: "0".repeat(64),
  }), false);
  selfTestHooks.selfTestContractorAuthorizationSha256 = "";

  const orchestratorBoundedWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build the isolated billing service only inside apps/billing.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
    scopeContract: writeScope(["apps/billing/**"]),
  });
  assert.equal(orchestratorBoundedWriter.errorType, "orchestrator_write_visibility_risk");
  assert.equal(orchestratorBoundedWriter.lockPlan.lockType, "write");
  assert.equal(orchestratorBoundedWriter.lockPlan.lockMode, "simple");
  assert.equal(orchestratorBoundedWriter.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorBoundedMissingScope = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing.",
    write: true,
    lockedPaths: ["apps/billing/**"],
  });
  assert.equal(orchestratorBoundedMissingScope.errorType, "orchestrator_write_visibility_risk");

  const orchestratorBoundedInternalWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and run builder internally for the database layer.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
    scopeContract: writeScope(["apps/billing/**"]),
  });
  assert.equal(orchestratorBoundedInternalWriter.errorType, "orchestrator_write_visibility_risk");

  const orchestratorBoundedGlobal = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and update package metadata.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["package.json"],
    allowedEdits: ["package.json"],
    scopeContract: writeScope(["package.json"]),
  });
  assert.equal(orchestratorBoundedGlobal.errorType, "orchestrator_write_visibility_risk");

  const orchestratorParallelWriter = validateParallelWritePlan([
    {
      agent: "orchestrator",
      task: "Build billing only.",
      orchestratorMode: "bounded-writer",
      write: true,
      lockMode: "simple",
      lockedPaths: ["apps/billing/**"],
      allowedEdits: ["apps/billing/**"],
      scopeContract: writeScope(["apps/billing/**"]),
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(orchestratorParallelWriter.errorType, "orchestrator_write_visibility_risk");

  const missingLockedPaths = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(missingLockedPaths.errorType, "missing_locked_paths");

  const missingAllowedEdits = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockedPaths: ["apps/web"],
    scopeContract: { ...writeScope(["apps/web"]), allowedEdits: [] },
  });
  assert.equal(missingAllowedEdits.errorType, "empty_allowed_edits");

  const invalidWriteLockMode = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockMode: "off",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
    scopeContract: writeScope(["apps/web"]),
  });
  assert.equal(invalidWriteLockMode.errorType, "invalid_write_lock_mode");

  const defaultSecretWrite = validateSingleLockPlan({
    agent: "builder",
    task: "Edit a secret file.",
    write: true,
    lockedPaths: ["apps/web/.env.local"],
    allowedEdits: ["apps/web/.env.local"],
    scopeContract: writeScope(["apps/web/.env.local"]),
  });
  assert.equal(defaultSecretWrite.errorType, "lock_plan_rejected");

  const singlePreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Preflight one writer.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
  ]);
  assert.equal(singlePreflight.error, null);
  assert.equal(singlePreflight.executionMode, "single");
  assert.equal(singlePreflight.lockPlans[0].lockMode, "simple");
  assert.deepEqual(singlePreflight.lockPlans[0].lockedPaths, ["apps/web"]);

  const unsafeSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Do unsafe edit.",
    write: true,
    lockedPaths: ["../outside"],
    allowedEdits: ["../outside"],
    scopeContract: writeScope(["../outside"]),
  });
  assert.equal(unsafeSingle.errorType, "scope_path_unsafe");

  const readOnlySingle = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review without editing.",
  });
  assert.equal(readOnlySingle.error, null);
  assert.equal(readOnlySingle.lockPlan.lockType, "read");
  assert.equal(readOnlySingle.lockPlan.lockMode, "off");
  const readOnlyBuilder = validateSingleLockPlan({
    agent: "builder",
    task: "Inspect only.",
    write: false,
    lockType: "read",
    lockMode: "off",
  });
  assert.equal(readOnlyBuilder.errorType, "read_only_agent_required");
  assert.equal(
    readOnlyRoutingPolicyError(
      { requestedAgent: "planner", actualAgent: "build" },
      { lockType: "read" }
    ).errorType,
    "read_only_proxy_unsafe"
  );

  const validReadOnlyScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review web and UI only.",
    scope: {
      read: ["apps\\web\\**", "packages/ui/**"],
      forbidden: [".env", "apps/api/**"],
    },
    actions: ["read_files"],
  });
  assert.equal(validReadOnlyScope.error, null);
  assert.equal(validReadOnlyScope.lockPlan.scopeContract.mode, "read");
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.read, ["apps/web", "packages/ui"]);
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.forbidden, [".env", "apps/api"]);

  const validWriteScope = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web only.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      read: ["apps/web/**", "packages/ui/**"],
      write: ["apps/web/**"],
      forbidden: [".env", ".env.*", "apps/api/**", "package-lock.json"],
    },
    actions: ["read_files", "edit_files", "run_tests"],
    validation: {
      changedFilesMustBeWithinWriteScope: true,
      forbiddenFilesMustNotChange: true,
      readOnlyMustNotChangeFiles: true,
    },
  });
  assert.equal(validWriteScope.error, null);
  assert.deepEqual(validWriteScope.lockPlan.allowedEdits, ["apps/web"]);
  assert.deepEqual(validWriteScope.lockPlan.scopeContract.scope.write, ["apps/web"]);

  const forbiddenOverridesWrite = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web but forbid secrets.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
      forbidden: ["apps/web/.env"],
    },
  });
  assert.equal(forbiddenOverridesWrite.errorType, "scope_write_forbidden");

  const readOnlyAgentWithWriteScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review but has write scope.",
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
    },
  });
  assert.equal(readOnlyAgentWithWriteScope.errorType, "scope_readonly_write_scope");

  const unsafeScopePath = validateSingleLockPlan({
    agent: "builder",
    task: "Unsafe scope.",
    write: true,
    lockedPaths: ["apps/web"],
    scope: {
      write: ["..\\outside"],
    },
  });
  assert.equal(unsafeScopePath.errorType, "scope_path_unsafe");

  const nonOverlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(nonOverlappingParallel.error, null);
  assert.deepEqual(nonOverlappingParallel.lockPlans[0].allowedEdits, ["apps/web"]);
  assert.equal(nonOverlappingParallel.lockPlans[0].lockMode, "strict");

  const absoluteWebPath = path.join(process.cwd(), "apps", "web");
  const mixedAbsoluteRelativeParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web with a relative scope.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web"],
      allowedEdits: ["apps/web"],
      scopeContract: writeScope(["apps/web"]),
    },
    {
      agent: "debugger",
      task: "Edit the same web path with an absolute scope.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: [absoluteWebPath],
      allowedEdits: [absoluteWebPath],
      scopeContract: writeScope([absoluteWebPath]),
    },
  ]);
  assert.equal(mixedAbsoluteRelativeParallel.errorType, "parallel_plan_rejected");
  assert.deepEqual(mixedAbsoluteRelativeParallel.conflictingPaths, ["apps/web", "apps/web"]);
  const aliasedParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit canonical path.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: ["src/file.js"],
      allowedEdits: ["src/file.js"],
      scopeContract: writeScope(["src/file.js"]),
    },
    {
      agent: "debugger",
      task: "Edit dot-aliased path.",
      cwd: process.cwd(),
      write: true,
      lockType: "write",
      lockedPaths: ["src/./file.js"],
      allowedEdits: ["./src//file.js"],
      scopeContract: writeScope(["src/./file.js"], { allowedEdits: ["./src//file.js"] }),
    },
  ]);
  assert.equal(aliasedParallel.errorType, "parallel_plan_rejected");
  assert.deepEqual(aliasedParallel.conflictingPaths, [canonicalFilePath, canonicalFilePath]);

  const parallelPreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
      scopeContract: writeScope(["apps/api/**"]),
    },
  ]);
  assert.equal(parallelPreflight.error, null);
  assert.equal(parallelPreflight.executionMode, "parallel");
  assert.deepEqual(parallelPreflight.lockPlans.map((plan) => plan.lockMode), ["strict", "strict"]);

  const pipelineTooSmall = createPipelinePlan({
    name: "too-small",
    requiresWorktrees: false,
    jobs: [{
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    }],
  });
  assert.equal(pipelineTooSmall.errorType, "pipeline_too_small");

  const pipelineMissingFinalValidation = createPipelinePlan({
    name: "missing-final-validation",
    requiresWorktrees: false,
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineMissingFinalValidation.errorType, "final_validation_required");

  const pipelineUnsafeReviewer = createPipelinePlan({
    name: "unsafe-reviewer",
    requiresWorktrees: false,
    finalValidationCommand: "git status --short",
    reviewerJob: { agent: "builder", task: "Review the result." },
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineUnsafeReviewer.errorType, "pipeline_gate_agent_not_read_only");

  const pipelineWithoutWorktrees = createPipelinePlan({
    name: "bounded-pipeline",
    requiresWorktrees: false,
    finalValidationCommand: "git status --short",
    jobs: [
      {
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      },
    ],
  });
  assert.equal(pipelineWithoutWorktrees.ok, true);
  assert.equal(pipelineWithoutWorktrees.record.status, "planned");
  assert.equal(pipelineWithoutWorktrees.record.integrationQueue.length, 2);

  if (CONFIG.worktreeMode === "off") {
    const pipelineRequiresWorktrees = createPipelinePlan({
      name: "requires-worktrees",
      finalValidationCommand: "git status --short",
      jobs: [{
        agent: "builder",
        task: "Edit web.",
        write: true,
        lockedPaths: ["apps/web/**"],
        allowedEdits: ["apps/web/**"],
        scopeContract: writeScope(["apps/web/**"]),
      },
      {
        agent: "debugger",
        task: "Edit api.",
        write: true,
        lockedPaths: ["apps/api/**"],
        allowedEdits: ["apps/api/**"],
        scopeContract: writeScope(["apps/api/**"]),
      }],
    });
    assert.equal(pipelineRequiresWorktrees.errorType, "worktree_required_for_pipeline");
  }

  const tooManyParallelJobs = validateParallelWritePlan(
    Array.from({ length: CONFIG.parallelLimit + 1 }, (_, index) => ({
      agent: "reviewer",
      task: `Read-only review ${index}.`,
    }))
  );
  assert.match(tooManyParallelJobs.error, /CODEX_OPENCODE_PARALLEL_LIMIT/);

  const overlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
    {
      agent: "builder",
      task: "Edit web components.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
      scopeContract: writeScope(["apps/web/src/**"]),
    },
  ]);
  assert.match(overlappingParallel.error, /Parallel write jobs overlap/);

  const overlappingParallelScopes = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      scope: { write: ["apps/web/**"] },
    },
    {
      agent: "debugger",
      task: "Edit web src.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      scope: { write: ["apps/web/src/**"] },
    },
  ]);
  assert.match(overlappingParallelScopes.error, /Parallel write jobs overlap/);

  const serialOnlyParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit package metadata.",
      write: true,
      lockedPaths: ["package.json"],
      allowedEdits: ["package.json"],
      scopeContract: writeScope(["package.json"]),
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api"],
      allowedEdits: ["apps/api"],
      scopeContract: writeScope(["apps/api"]),
    },
  ]);
  assert.equal(serialOnlyParallel.errorType, "serial_only_parallel_write");

  const serialOnlySingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit README serially.",
    write: true,
    lockedPaths: ["README.md"],
    allowedEdits: ["README.md"],
    scopeContract: writeScope(["README.md"]),
  });
  assert.equal(serialOnlySingle.error, null);

  const readWithScopeParallel = validateParallelWritePlan([
    {
      agent: "reviewer",
      task: "Review web while builder edits web.",
      lockedPaths: ["apps/web/**"],
    },
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
  ]);
  assert.equal(readWithScopeParallel.errorType, "parallel_read_write_conflict");
  const disjointReadWriteParallel = validateParallelWritePlan([
    {
      agent: "reviewer",
      task: "Review api while builder edits web.",
      scopeContract: { mode: "read", read: ["apps/api"], write: [], allowedEdits: [], forbidden: [], shared: [], serialOnly: [], validationCommand: "" },
    },
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    },
  ]);
  assert.equal(disjointReadWriteParallel.error, null);

  const readOnlyTimeoutViolations = verifyParallelLockResults([
    {
      index: 0,
      lockPlan: {
        agent: "reviewer",
        lockType: "read",
        lockMode: "off",
        cwd: "",
        allowedEdits: [],
        forbiddenEdits: [],
        sharedFiles: [],
      },
      result: {
        exitCode: 124,
        readOnlyUnavailable: true,
        timedOut: true,
        changedFiles: [],
        openCodeFallbackDetected: false,
        openCodeApiErrorDetected: false,
      },
    },
  ]);
  assert.deepEqual(readOnlyTimeoutViolations, []);

  selfTestProgress("queue/lock/recovery");
  if (effectiveQueueMode() !== "off") {
    QUEUE_JOBS.clear();
    const durableQueueSelfTestJobIds = [];
    const queuedReadOnly = await enqueueQueueJob({
      agent: "reviewer",
      task: "Review only.",
      dryRun: true,
    }, "", { schedule: false });
    assert.equal(queuedReadOnly.ok, true);
    durableQueueSelfTestJobIds.push(queuedReadOnly.record.jobId);
    assert.equal(queuedReadOnly.record.mode, "read");
    assert.equal(queuedReadOnly.record.maxRetries, 0);
    if (effectiveQueueMode() === "sqlite") {
      assert.ok(queuedReadOnly.record.requestEncrypted);
      assert.equal((await decryptQueueRequest(queuedReadOnly.record.requestEncrypted, queuedReadOnly.record.jobId)).task, "Review only.");
      const idempotencyKey = `self-test-${randomBytes(6).toString("hex")}`;
      const first = await enqueueQueueJob({ agent: "reviewer", task: "Idempotent review.", dryRun: true, idempotencyKey }, "", { schedule: false });
      const second = await enqueueQueueJob({ agent: "reviewer", task: "Idempotent review.", dryRun: true, idempotencyKey }, "", { schedule: false });
      assert.equal(first.ok, true);
      durableQueueSelfTestJobIds.push(first.record.jobId);
      assert.equal(second.ok, true);
      assert.equal(second.deduplicated, true);
      assert.equal(second.record.jobId, first.record.jobId);
      const conflict = await enqueueQueueJob({ agent: "reviewer", task: "Different request.", dryRun: true, idempotencyKey }, "", { schedule: false });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.errorType, "queue_idempotency_conflict");
    }

    const queuedWrite = await enqueueQueueJob({
      agent: "builder",
      task: "Edit web.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
      scopeContract: writeScope(["apps/web/**"]),
    }, "", { schedule: false });
    assert.equal(queuedWrite.ok, true);
    durableQueueSelfTestJobIds.push(queuedWrite.record.jobId);
    assert.equal(queuedWrite.record.mode, "write");
    assert.deepEqual(queuedWrite.record.lockedPaths, ["apps/web"]);
    assert.deepEqual(queuedWrite.record.allowedEdits, ["apps/web"]);

    assert.equal((await updateQueueRecordDurable(queuedWrite.record, { status: "running" })).persisted, true);
    const queuedBlocked = await enqueueQueueJob({
      agent: "debugger",
      task: "Edit web src.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
      scopeContract: writeScope(["apps/web/src/**"]),
    }, "", { schedule: false });
    assert.equal(queuedBlocked.ok, true);
    durableQueueSelfTestJobIds.push(queuedBlocked.record.jobId);
    const queueConflict = await findQueueWriteConflict(queuedBlocked.record);
    assert.equal(queueConflict.jobId, queuedWrite.record.jobId);
    assert.deepEqual(queueConflict.paths, ["apps/web/src", "apps/web"]);
    const queuedReaderConflict = await findQueueWriteConflict({
      jobId: "queued-reader-conflict",
      cwd: queuedWrite.record.cwd,
      mode: "read",
      scopeContract: { scope: { read: ["apps/web"] } },
      lockedPaths: [],
      allowedEdits: [],
    });
    assert.equal(queuedReaderConflict.jobId, queuedWrite.record.jobId);
    const queuedDisjointReaderConflict = await findQueueWriteConflict({
      jobId: "queued-reader-disjoint",
      cwd: queuedWrite.record.cwd,
      mode: "read",
      scopeContract: { scope: { read: ["apps/api"] } },
      lockedPaths: [],
      allowedEdits: [],
    });
    assert.equal(queuedDisjointReaderConflict, null);
    const queueAssessment = await assessQueuePlan([{
      lockType: "write",
      cwd: queuedBlocked.record.cwd,
      lockedPaths: queuedBlocked.record.lockedPaths,
      allowedEdits: queuedBlocked.record.allowedEdits,
    }]);
    assert.match(queueAssessment.status, /must_wait|conflict/);
    assert.equal(queueRecordSnapshot(queuedReadOnly.record).status, "pending");
    assert.equal((await updateQueueRecordDurable(queuedBlocked.record, { status: "cancelled", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(queueRecordSnapshot(queuedBlocked.record).status, "cancelled");
    if (CONFIG.worktreeMode === "off") {
      const unsafeQueuedWriter = await enqueueQueueJob({
        agent: "builder",
        task: "Attempt a durable direct writer.",
        write: true,
        lockedPaths: ["apps/api"],
        allowedEdits: ["apps/api"],
        scopeContract: writeScope(["apps/api"]),
      }, "", { schedule: false });
      assert.equal(unsafeQueuedWriter.ok, false);
      assert.equal(unsafeQueuedWriter.errorType, "queue_write_requires_worktree");
    }
    if (effectiveQueueMode() === "sqlite") {
      const queueSelfTestDb = await openLockDb(queuedReadOnly.record.cwd);
      let queueSelfTestTransactionOpen = false;
      try {
        queueSelfTestDb.exec("BEGIN IMMEDIATE");
        queueSelfTestTransactionOpen = true;
        const deleteQueueSelfTestJob = queueSelfTestDb.prepare("DELETE FROM opencode_jobs WHERE job_id = ?");
        for (const jobId of new Set(durableQueueSelfTestJobIds)) {
          deleteQueueSelfTestJob.run(jobId);
        }
        queueSelfTestDb.exec("COMMIT");
        queueSelfTestTransactionOpen = false;
      } catch (error) {
        if (queueSelfTestTransactionOpen) {
          try { queueSelfTestDb.exec("ROLLBACK"); } catch { /* Preserve the self-test error. */ }
        }
        throw error;
      } finally {
        closeDb(queueSelfTestDb);
      }
    }
    QUEUE_JOBS.clear();
  }

  const expiredCreatedAt = new Date(Date.now() - (CONFIG.queueRetentionDays + 1) * 24 * 60 * 60 * 1000).toISOString();
  QUEUE_JOBS.set("expired-memory-job", { jobId: "expired-memory-job", status: "completed", createdAt: expiredCreatedAt });
  PIPELINE_RUNS.set("expired-memory-pipeline", { pipelineId: "expired-memory-pipeline", status: "failed", createdAt: expiredCreatedAt });
  pruneInMemoryState();
  assert.equal(QUEUE_JOBS.has("expired-memory-job"), CONFIG.queueRetentionDays <= 0);
  assert.equal(PIPELINE_RUNS.has("expired-memory-pipeline"), CONFIG.queueRetentionDays <= 0);
  QUEUE_JOBS.delete("expired-memory-job");
  PIPELINE_RUNS.delete("expired-memory-pipeline");

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-opencode-mcp-"));
  const clearSelfTestIntegrationQuarantine = async () => {
    const db = await openLockDb(tempDir);
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const rows = db.prepare(`
        SELECT operation_id FROM integration_operations
        WHERE cwd = ? AND status = 'quarantined'
        ORDER BY operation_id
      `).all(path.resolve(tempDir));
      assert.ok(rows.length > 0, "The ambiguity fixture must leave durable quarantine evidence.");
      db.prepare("DELETE FROM integration_operations WHERE cwd = ? AND status = 'quarantined'")
        .run(path.resolve(tempDir));
      db.exec("COMMIT");
      transactionOpen = false;
      return rows.map((row) => row.operation_id);
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the self-test error. */ }
      }
      throw error;
    } finally {
      closeDb(db);
    }
  };
  const tempStateDir = `${tempDir}-state`;
  const outsideLinkTarget = `${tempDir}-outside`;
  const nonGitFixture = `${tempDir}-non-git`;
  selfTestHooks.stateDirectoryOverride = tempStateDir;
  try {
    await mkdir(nonGitFixture, { recursive: true });
    assert.equal((await verifyProtectedGitRoot(nonGitFixture)).errorType, "git_state_required");
    const readinessReaderPlan = { lockType: "read", lockedPaths: [], allowedEdits: [] };
    const readinessReaderJob = { agent: "reviewer", task: "Workspace readiness regression", cwd: nonGitFixture, write: false, lockMode: "off" };
    assert.equal((await verifyJobWorkspaceReadiness(readinessReaderJob, readinessReaderPlan)).errorType, "git_state_required");
    assert.deepEqual(await verifyJobWorkspaceReadiness({ ...readinessReaderJob, dryRun: true }, readinessReaderPlan), { ok: true, skipped: "routing_only" });
    assert.equal((await executeOpenCodeJob(readinessReaderJob)).result.errorType, "git_state_required");
    // An unrunnable validation command is rejected before workspace readiness, routing, or any spawn.
    const untrustedValidationExecution = await executeOpenCodeJob({ ...readinessReaderJob, validationCommand: "evil-tool --run" });
    assert.equal(untrustedValidationExecution.result.errorType, "validation_command_untrusted");
    assert.equal(untrustedValidationExecution.result.validationGate.status, "failed");
    assert.equal(untrustedValidationExecution.resolution, undefined);
    assert.match(untrustedValidationExecution.response.content[0].text, /no agent was started/);
    assert.equal((await executeOpenCodeJob({ ...readinessReaderJob, dryRun: true, validationCommand: "evil-tool --run" })).result.errorType === "validation_command_untrusted", false);
    await assert.rejects(gitChangedFiles(nonGitFixture), /Git changed-file inspection failed closed/);
    const init = await runCommand("git", ["init"], tempDir, 1000 * 15);
    assert.equal(init.exitCode, 0);
    assert.equal((await verifyJobWorkspaceReadiness({ ...readinessReaderJob, cwd: tempDir }, readinessReaderPlan)).errorType, "git_head_required");
    assert.equal((await executeOpenCodeJob({ ...readinessReaderJob, cwd: tempDir })).result.errorType, "git_head_required");
    assert.equal((await runCommand("git", ["config", "core.autocrlf", "false"], tempDir, 1000 * 15)).exitCode, 0);
    const pluginFixtureHome = path.join(tempDir, "plugin-home");
    const pluginFixtureSpec = "bridge-plugin-fixture@1.2.3";
    const pluginFixtureRoot = path.join(pluginFixtureHome, ".cache", "opencode", "packages", pluginFixtureSpec);
    const pluginFixturePackageRoot = path.join(pluginFixtureRoot, "node_modules", "bridge-plugin-fixture");
    const pluginFixtureConfigDir = path.join(pluginFixtureHome, ".config", "opencode");
    const pluginFixtureConfigPath = path.join(pluginFixtureConfigDir, "opencode.jsonc");
    const pluginFixtureSettingsPath = path.join(pluginFixtureConfigDir, "plugin-security.json");
    const pluginFixtureManifestPath = path.join(pluginFixtureHome, "plugin-manifest.json");
    const pluginFixtureHostScript = path.join(pluginFixtureHome, process.platform === "win32" ? "fake-opencode.c" : "fake-opencode.cjs");
    const pluginFixtureHostExecutable = process.platform === "win32"
      ? path.join(pluginFixtureHome, "fake-opencode.exe")
      : path.join(pluginFixtureHome, "fake-opencode");
    await mkdir(pluginFixturePackageRoot, { recursive: true });
    await mkdir(pluginFixtureConfigDir, { recursive: true });
    await writeFile(path.join(pluginFixtureRoot, "package-lock.json"), "{}\n", "utf8");
    await writeFile(path.join(pluginFixtureRoot, "package.json"), JSON.stringify({ private: true, dependencies: { "bridge-plugin-fixture": "1.2.3" } }), "utf8");
    await writeFile(path.join(pluginFixturePackageRoot, "package.json"), JSON.stringify({ name: "bridge-plugin-fixture", version: "1.2.3", main: "index.js", type: "module" }), "utf8");
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default async () => ({})\n", "utf8");
    const pluginFixtureConfig = `${JSON.stringify({ plugin: [pluginFixtureSpec] }, null, 2)}\n`;
    const pluginFixtureSettings = `${JSON.stringify({ debug: false })}\n`;
    await writeFile(pluginFixtureConfigPath, pluginFixtureConfig, "utf8");
    await writeFile(pluginFixtureSettingsPath, pluginFixtureSettings, "utf8");
    const pluginFixtureEffectiveConfig = JSON.stringify({
      plugin: [pluginFixtureSpec],
      plugin_origins: [{ spec: pluginFixtureSpec, source: pluginFixtureConfigDir, scope: "global" }],
    });
    if (process.platform === "win32") {
      await writeFile(pluginFixtureHostScript, [
        "#include <stdio.h>",
        "#include <string.h>",
        "int main(int argc, char **argv) {",
        "  for (int i = 1; i < argc; i += 1) { if (strcmp(argv[i], \"--version\") == 0) { fputs(\"1.17.13\\n\", stdout); return 0; } }",
        `  if (argc == 3 && strcmp(argv[1], "debug") == 0 && strcmp(argv[2], "config") == 0) { fputs(${JSON.stringify(pluginFixtureEffectiveConfig)}, stdout); return 0; }`,
        "  fputs(\"unexpected fake OpenCode arguments\", stderr); return 2;",
        "}",
      ].join("\n"), "utf8");
      const compilerCandidates = ["gcc", "C:\\MinGW\\bin\\gcc.exe"];
      const compilerFailures = [];
      let compiled = false;
      for (const compiler of compilerCandidates) {
        try {
          await execFileAsync(compiler, [pluginFixtureHostScript, "-O2", "-o", pluginFixtureHostExecutable], {
            cwd: pluginFixtureHome,
            windowsHide: true,
            timeout: 1000 * 30,
          });
          compiled = true;
          break;
        } catch (error) {
          compilerFailures.push(`${compiler}: ${error.message || String(error)}`);
        }
      }
      assert.equal(compiled, true, `A C compiler is required for the deterministic Windows plugin-policy host.\n${compilerFailures.join("\n")}`);
    } else {
      await writeFile(pluginFixtureHostScript, [
        `const args = process.argv.slice(2);`,
        `if (args.includes("--version")) { process.stdout.write("1.17.13\\n"); process.exit(0); }`,
        `if (args.join(" ") === "debug config") { process.stdout.write(${JSON.stringify(pluginFixtureEffectiveConfig)}); process.exit(0); }`,
        `process.stderr.write("unexpected fake OpenCode arguments: " + args.join(" ")); process.exit(2);`,
      ].join("\n"), "utf8");
      await writeFile(pluginFixtureHostExecutable, `#!/bin/sh\nexec "${process.execPath}" "${pluginFixtureHostScript}" "$@"\n`, "utf8");
      await chmod(pluginFixtureHostExecutable, 0o755);
    }
    const pluginFixtureTree = await hashExactTree(pluginFixtureRoot);
    const pluginFixtureManifest = {
      version: 1,
      openCodeVersion: "1.17.13",
      plugins: [{
        specifier: pluginFixtureSpec,
        root: pluginFixtureRoot,
        packageRoot: pluginFixturePackageRoot,
        fileCount: pluginFixtureTree.fileCount,
        entryCount: pluginFixtureTree.entryCount,
        packageLockSha256: await sha256File(path.join(pluginFixtureRoot, "package-lock.json")),
        treeSha256: pluginFixtureTree.treeSha256,
      }],
      configs: [{
        path: pluginFixtureConfigPath,
        sha256: await sha256File(pluginFixtureConfigPath),
        scope: "global",
        plugins: [pluginFixtureSpec],
      }],
      settings: [{
        path: pluginFixtureSettingsPath,
        sha256: await sha256File(pluginFixtureSettingsPath),
        requiredValues: { debug: false },
      }],
    };
    const writePluginFixtureManifest = async () => {
      const content = `${JSON.stringify(pluginFixtureManifest, null, 2)}\n`;
      await writeFile(pluginFixtureManifestPath, content, "utf8");
      return createHash("sha256").update(content).digest("hex");
    };
    const runPluginFixtureProbe = async (manifestSha256) => runSpawnCommand(
      process.execPath,
      [BRIDGE_SERVER_PATH, "--verify-plugin-policy", tempDir],
      tempDir,
      1000 * 90,
      {
        ...buildValidationEnv(),
        HOME: pluginFixtureHome,
        USERPROFILE: pluginFixtureHome,
        XDG_CONFIG_HOME: path.join(pluginFixtureHome, ".config"),
        CODEX_OPENCODE_EXECUTABLE: pluginFixtureHostExecutable,
        CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
        CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: pluginFixtureSpec,
        CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: pluginFixtureManifestPath,
        CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: manifestSha256,
      }
    );
    const pluginFixtureManifestSha256 = await writePluginFixtureManifest();
    const acceptedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(acceptedPluginProbe.exitCode, 0, acceptedPluginProbe.stderr);
    assert.equal(JSON.parse(acceptedPluginProbe.stdout).ok, true, acceptedPluginProbe.stdout);
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default { tampered: true }\n", "utf8");
    const tamperedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(tamperedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(path.join(pluginFixturePackageRoot, "index.js"), "export default async () => ({})\n", "utf8");
    const badManifestHashProbe = await runPluginFixtureProbe("0".repeat(64));
    assert.equal(JSON.parse(badManifestHashProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureConfigPath, `${JSON.stringify({ plugin: [pluginFixtureSpec, "unexpected-plugin@9.9.9"] })}\n`, "utf8");
    const unexpectedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(unexpectedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureConfigPath, pluginFixtureConfig, "utf8");
    await writeFile(pluginFixtureSettingsPath, `${JSON.stringify({ debug: true })}\n`, "utf8");
    const settingsTamperProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(settingsTamperProbe.stdout).errorType, "external_plugin_integrity_failed");
    await writeFile(pluginFixtureSettingsPath, pluginFixtureSettings, "utf8");
    await mkdir(outsideLinkTarget, { recursive: true });
    await symlink(outsideLinkTarget, path.join(pluginFixtureRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linkedPluginProbe = await runPluginFixtureProbe(pluginFixtureManifestSha256);
    assert.equal(JSON.parse(linkedPluginProbe.stdout).errorType, "external_plugin_integrity_failed");
    await rm(path.join(pluginFixtureRoot, "linked"), { recursive: true, force: true });
    pluginFixtureManifest.plugins[0].root = path.join(tempDir, "plugin-copy-b");
    pluginFixtureManifest.plugins[0].packageRoot = path.join(tempDir, "plugin-copy-b", "node_modules", "bridge-plugin-fixture");
    const wrongResolutionManifestSha256 = await writePluginFixtureManifest();
    const wrongResolutionProbe = await runPluginFixtureProbe(wrongResolutionManifestSha256);
    assert.equal(JSON.parse(wrongResolutionProbe.stdout).errorType, "external_plugin_integrity_failed");
    pluginFixtureManifest.plugins[0].root = pluginFixtureRoot;
    pluginFixtureManifest.plugins[0].packageRoot = pluginFixturePackageRoot;
    assert.equal(await writePluginFixtureManifest(), pluginFixtureManifestSha256);
    await rm(pluginFixtureHome, { recursive: true, force: true });
    assert.match(unsafePathReason(["C:/Windows"], tempDir), /outside the allowed root|filesystem root/);
    await mkdir(outsideLinkTarget, { recursive: true });
    await symlink(outsideLinkTarget, path.join(tempDir, "outside-link"), process.platform === "win32" ? "junction" : "dir");
    assert.match(unsafePathReason(["outside-link/escape.txt"], tempDir), /symlink|junction/i);
    const linkedPolicy = await loadProjectAgentPolicy(tempDir, "outside-link/agent-policy.json");
    assert.equal(linkedPolicy.ok, false);
    assert.equal(linkedPolicy.errorType, "policy_path_unsafe");
    await rm(path.join(tempDir, "outside-link"), { recursive: true, force: true });
    const releaseFixture = path.join(tempDir, "release-fixture");
    assert.equal(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), "");
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: path.join(tempDir, "mutable-config"),
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), /XDG_CONFIG_HOME/);
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(tempDir, "mutable-agents"),
      skillDir: path.join(releaseFixture, "opencode", "skills"),
    }), /CODEX_OPENCODE_AGENT_DIR/);
    assert.match(releaseManagedSourcePathError(releaseFixture, {
      configHome: releaseFixture,
      agentDir: path.join(releaseFixture, "opencode", "agents"),
      skillDir: path.join(tempDir, "mutable-skills"),
    }), /CODEX_OPENCODE_SKILL_DIR/);
    assert.equal(immutableReleasePluginModeError({ releasePinned: true, allowExternalPlugins: false }), "");
    assert.match(
      immutableReleasePluginModeError({ releasePinned: true, allowExternalPlugins: true }),
      /Immutable releases must use pure mode/
    );
    assert.equal(immutableReleasePluginModeError({ releasePinned: false, allowExternalPlugins: true }), "");
    const releaseFixtureFiles = [
      "server.js",
      "package.json",
      "package-lock.json",
      "bin/process-supervisor.js",
      "bin/tui.js",
      "bin/e2e.js",
      "bin/e2e-contractor.js",
      "bin/e2e-concurrency.js",
      "bin/build-release.js",
      "bin/fresh-healthcheck.js",
      "opencode/.gitignore",
      "opencode/opencode.jsonc",
      "opencode/antigravity.json",
      "opencode/plugin-integrity-manifest.json",
      ...RELEASE_REQUIRED_MANAGED_AGENTS.map((agent) => `opencode/agents/${agent}.md`),
      ...REQUIRED_MANAGED_SKILLS.map((skill) => `opencode/skills/${skill}/SKILL.md`),
    ];
    const releaseManifestFiles = {};
    for (const relative of releaseFixtureFiles) {
      const absolute = path.join(releaseFixture, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relative}\n`, "utf8");
      releaseManifestFiles[relative] = await sha256File(absolute);
    }
    const releaseManifestContent = `${JSON.stringify({ version: 1, files: releaseManifestFiles }, null, 2)}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), releaseManifestContent, "utf8");
    const previousManifestHash = process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(releaseManifestContent).digest("hex");
    await verifyReleaseManifest(releaseFixture);
    const releaseRootJunction = path.join(tempDir, "release-root-junction");
    await symlink(releaseFixture, releaseRootJunction, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyReleaseManifest(releaseRootJunction), /release root and its ancestors.*symbolic links or junctions/i);
    await rm(releaseRootJunction, { recursive: true, force: true });
    const releaseAncestorJunction = path.join(outsideLinkTarget, "release-ancestor-junction");
    await symlink(tempDir, releaseAncestorJunction, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      verifyReleaseManifest(path.join(releaseAncestorJunction, "release-fixture")),
      /release root and its ancestors.*symbolic links or junctions/i
    );
    await rm(releaseAncestorJunction, { recursive: true, force: true });
    await writeFile(path.join(releaseFixture, "server.js"), "tampered\n", "utf8");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /server\.js/);
    await writeFile(path.join(releaseFixture, "server.js"), "server.js\n", "utf8");
    await writeFile(path.join(releaseFixture, "unexpected.txt"), "unexpected\n", "utf8");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unexpected or missing files/);
    await rm(path.join(releaseFixture, "unexpected.txt"), { force: true });
    await rm(path.join(releaseFixture, "bin", "e2e-concurrency.js"), { force: true });
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unexpected or missing files/);
    await writeFile(path.join(releaseFixture, "bin", "e2e-concurrency.js"), "bin/e2e-concurrency.js\n", "utf8");
    await writeFile(path.join(releaseFixture, "bin", "fresh-healthcheck.js"), "bin/fresh-healthcheck.js\n", "utf8");
    await symlink(outsideLinkTarget, path.join(releaseFixture, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /symbolic links|junctions/);
    await rm(path.join(releaseFixture, "linked"), { recursive: true, force: true });
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = "0".repeat(64);
    await assert.rejects(verifyReleaseManifest(releaseFixture), /manifest integrity/);
    const invalidSchemaContent = `${JSON.stringify({ version: 2, files: releaseManifestFiles })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), invalidSchemaContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(invalidSchemaContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /version 1/);
    const unsafePathContent = `${JSON.stringify({ version: 1, files: { ...releaseManifestFiles, "../escape": "0".repeat(64) } })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), unsafePathContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(unsafePathContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unsafe or invalid entry/);
    const invalidDigestContent = `${JSON.stringify({ version: 1, files: { ...releaseManifestFiles, "server.js": "invalid" } })}\n`;
    await writeFile(path.join(releaseFixture, "release-manifest.json"), invalidDigestContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(invalidDigestContent).digest("hex");
    await assert.rejects(verifyReleaseManifest(releaseFixture), /unsafe or invalid entry/);
    await writeFile(path.join(releaseFixture, "release-manifest.json"), releaseManifestContent, "utf8");
    process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = createHash("sha256").update(releaseManifestContent).digest("hex");
    await verifyReleaseManifest(releaseFixture);
    if (previousManifestHash === undefined) {
      delete process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    } else {
      process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = previousManifestHash;
    }
    const sanitizedRoot = path.join(nonGitFixture, "sanitized");
    const sanitizedManifestPath = path.join(nonGitFixture, "sanitized-manifest.json");
    await mkdir(path.join(sanitizedRoot, "nested"), { recursive: true });
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "sanitized\n", "utf8");
    await writeFile(path.join(sanitizedRoot, "nested", "data.json"), "{}\n", "utf8");
    const sanitizedManifestContent = `${JSON.stringify({
      version: 1,
      directories: ["nested"],
      files: {
        "allowed.txt": await sha256File(path.join(sanitizedRoot, "allowed.txt")),
        "nested/data.json": await sha256File(path.join(sanitizedRoot, "nested", "data.json")),
      },
    }, null, 2)}\n`;
    await writeFile(sanitizedManifestPath, sanitizedManifestContent, "utf8");
    const sanitizedContract = {
      root: sanitizedRoot,
      manifestPath: sanitizedManifestPath,
      manifestSha256: createHash("sha256").update(sanitizedManifestContent).digest("hex"),
      requiredFiles: ["allowed.txt"],
      forbiddenFiles: ["raw/**"],
    };
    const sanitizedPassed = await verifySanitizedWorkspace(sanitizedContract, "before_wave");
    assert.equal(sanitizedPassed.ok, true, JSON.stringify(sanitizedPassed, null, 2));
    const sanitizedPlanPassed = await verifySanitizedJobsBeforeDiscovery(
      [{ agent: "reviewer", cwd: sanitizedRoot, sanitizedWorkspace: sanitizedContract }],
      "delegation_plan_preflight_before_discovery"
    );
    assert.equal(sanitizedPlanPassed.ok, true, JSON.stringify(sanitizedPlanPassed, null, 2));
    assert.deepEqual(await verifyJobWorkspaceReadiness({
      ...readinessReaderJob,
      cwd: sanitizedRoot,
      sanitizedWorkspace: sanitizedContract,
    }, readinessReaderPlan, "all"), { ok: true, skipped: "manifest_protected" });
    await writeFile(path.join(sanitizedRoot, "unexpected.txt"), "unexpected\n", "utf8");
    const sanitizedAdded = await verifySanitizedWorkspace(sanitizedContract, "after_wave");
    assert.equal(sanitizedAdded.ok, false);
    assert.ok(sanitizedAdded.discrepancies.some((item) => item.type === "unexpected" && item.path === "unexpected.txt"));
    const sanitizedPlanRejected = await verifySanitizedJobsBeforeDiscovery(
      [{ agent: "reviewer", cwd: sanitizedRoot, sanitizedWorkspace: sanitizedContract }],
      "delegation_plan_preflight_before_discovery"
    );
    assert.equal(sanitizedPlanRejected.ok, false);
    assert.equal(sanitizedPlanRejected.index, 0);
    assert.ok(sanitizedPlanRejected.verification.discrepancies.some((item) => item.type === "unexpected" && item.path === "unexpected.txt"));
    await rm(path.join(sanitizedRoot, "unexpected.txt"), { force: true });
    const sanitizedForbidden = await verifySanitizedWorkspace({ ...sanitizedContract, forbiddenFiles: ["allowed.txt"] });
    assert.equal(sanitizedForbidden.ok, false);
    assert.ok(sanitizedForbidden.discrepancies.some((item) => item.type === "forbidden_present"));
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "mutated\n", "utf8");
    const sanitizedMutated = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedMutated.ok, false);
    assert.ok(sanitizedMutated.discrepancies.some((item) => item.type === "hash_mismatch"));
    await writeFile(path.join(sanitizedRoot, "allowed.txt"), "sanitized\n", "utf8");
    await rm(path.join(sanitizedRoot, "nested", "data.json"), { force: true });
    const sanitizedRemoved = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedRemoved.ok, false);
    assert.ok(sanitizedRemoved.discrepancies.some((item) => item.type === "missing" && item.path === "nested/data.json"));
    await writeFile(path.join(sanitizedRoot, "nested", "data.json"), "{}\n", "utf8");
    await symlink(outsideLinkTarget, path.join(sanitizedRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const sanitizedLinked = await verifySanitizedWorkspace(sanitizedContract);
    assert.equal(sanitizedLinked.ok, false);
    assert.match(sanitizedLinked.error, /symbolic link|junction/i);
    await rm(path.join(sanitizedRoot, "linked"), { recursive: true, force: true });
    await writeFile(path.join(tempDir, ".gitignore"), "ignored.log\n", "utf8");

    await writeFile(path.join(tempDir, "already-untracked.txt"), "before\n", "utf8");
    const before = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "already-untracked.txt"), "after\n", "utf8");
    const after = await gitChangedFileSnapshot(tempDir);
    assert.deepEqual(changedFilesBetween(before, after), ["already-untracked.txt"]);
    await writeFile(path.join(tempDir, "ignored.log"), "first\n", "utf8");
    const ignoredBefore = await gitChangedFileSnapshot(tempDir);
    assert.match(ignoredBefore.get("ignored.log"), /^metadata:/);
    await writeFile(path.join(tempDir, "ignored.log"), "second\n", "utf8");
    const ignoredAfter = await gitChangedFileSnapshot(tempDir);
    assert.deepEqual(changedFilesBetween(ignoredBefore, ignoredAfter), ["ignored.log"]);

    const legacyLockDb = new DatabaseSync(":memory:");
    try {
      legacyLockDb.exec(`
        CREATE TABLE locks (
          normalized_path TEXT PRIMARY KEY,
          owner_agent TEXT NOT NULL,
          run_id TEXT NOT NULL,
          token TEXT NOT NULL,
          lock_mode TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          cwd TEXT,
          task TEXT
        );
      `);
      const legacyRawToken = "a".repeat(64);
      legacyLockDb.prepare("INSERT INTO locks (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("src", "builder", "legacy-run", legacyRawToken, "write", Date.now() + 60000, Date.now(), tempDir, secretSentinel);
      ensureLockTableSchema(legacyLockDb);
      assert.equal(lockTableHasCompositePrimaryKey(legacyLockDb), true);
      assert.equal(legacyLockDb.prepare("SELECT acquisition_origin FROM locks WHERE run_id = ?").get("legacy-run").acquisition_origin, "legacy");
      scrubLegacyLockSecrets(legacyLockDb);
      const scrubbedLegacyLock = legacyLockDb.prepare("SELECT token, task FROM locks WHERE run_id = ?").get("legacy-run");
      assert.match(scrubbedLegacyLock.token, /^sha256:[a-f0-9]{64}$/);
      assert.notEqual(scrubbedLegacyLock.token, legacyRawToken);
      assert.match(scrubbedLegacyLock.task, /^sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(scrubbedLegacyLock), new RegExp(secretSentinel));
    } finally {
      closeDb(legacyLockDb);
    }

    const readLockA = await acquireHardLock({
      owner: "codex",
      agent: "reviewer",
      cwd: tempDir,
      lockType: "read",
      paths: ["apps/web"],
    });
    const readLockB = await acquireHardLock({
      owner: "codex",
      agent: "tester",
      cwd: tempDir,
      lockType: "read",
      paths: ["apps/web"],
    });
    assert.equal(readLockA.ok, true);
    assert.equal(readLockB.ok, true);
    const blockedWriterByReaders = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(blockedWriterByReaders.ok, false);
    await releaseHardLock(readLockA.lock.id, readLockA.lock.token, readLockA.lock.paths, tempDir);
    await releaseHardLock(readLockB.lock.id, readLockB.lock.token, readLockB.lock.paths, tempDir);

    const repositoryReaderA = await acquireHardLock({
      owner: "codex", agent: "reviewer", cwd: tempDir, lockType: "read",
      paths: [REPOSITORY_SCOPE_LOCK_PATH], repositoryScope: true,
    });
    const repositoryReaderB = await acquireHardLock({
      owner: "codex", agent: "tester", cwd: tempDir, lockType: "read",
      paths: [REPOSITORY_SCOPE_LOCK_PATH], repositoryScope: true,
    });
    assert.equal(repositoryReaderA.ok, true);
    assert.equal(repositoryReaderB.ok, true);
    const writerBlockedByRepositoryReader = await acquireHardLock({ owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["apps/api"] });
    assert.equal(writerBlockedByRepositoryReader.ok, false);
    await releaseHardLock(repositoryReaderA.lock.id, repositoryReaderA.lock.token, repositoryReaderA.lock.paths, tempDir);
    await releaseHardLock(repositoryReaderB.lock.id, repositoryReaderB.lock.token, repositoryReaderB.lock.paths, tempDir);
    const scopedReader = await acquireHardLock({ owner: "codex", agent: "reviewer", cwd: tempDir, lockType: "read", paths: ["apps/web"] });
    const disjointWriterDuringRead = await acquireHardLock({ owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["apps/api"] });
    assert.equal(scopedReader.ok, true);
    assert.equal(disjointWriterDuringRead.ok, true);
    await releaseHardLock(scopedReader.lock.id, scopedReader.lock.token, scopedReader.lock.paths, tempDir);
    await releaseHardLock(disjointWriterDuringRead.lock.id, disjointWriterDuringRead.lock.token, disjointWriterDuringRead.lock.paths, tempDir);

    const lockA = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      task: `Review ${secretSentinel}`,
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockA.ok, true);
    const lockSecretDb = await openLockDb(tempDir);
    try {
      const rawLockRow = lockSecretDb.prepare("SELECT token, task FROM locks WHERE run_id = ? LIMIT 1").get(lockA.lock.id);
      assert.match(rawLockRow.token, /^sha256:[a-f0-9]{64}$/);
      assert.match(rawLockRow.task, /^sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(rawLockRow), new RegExp(secretSentinel));
      assert.doesNotMatch(JSON.stringify(await listLocks(tempDir)), new RegExp(lockA.lock.token));
    } finally {
      closeDb(lockSecretDb);
    }
    assert.equal((await releaseHardLock(lockA.lock.id, "wrong-token", lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).released, true);

    const relativeLock = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    const absoluteConflict = await acquireHardLock({
      owner: "codex",
      agent: "debugger",
      cwd: tempDir,
      lockType: "write",
      paths: [path.join(tempDir, "apps", "web")],
    });
    assert.equal(relativeLock.ok, true);
    assert.equal(absoluteConflict.ok, false);
    await releaseHardLock(relativeLock.lock.id, relativeLock.lock.token, relativeLock.lock.paths, tempDir);

    const canonicalAliasLock = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["src/file.js"],
    });
    assert.equal(canonicalAliasLock.ok, true);
    for (const alias of ["src/./file.js", "src//file.js", "./src/file.js"]) {
      const aliasConflict = await acquireHardLock({
        owner: "codex",
        agent: "debugger",
        cwd: tempDir,
        lockType: "write",
        paths: [alias],
      });
      assert.equal(aliasConflict.ok, false, `Alias ${alias} must not acquire an independent lock.`);
    }
    const traversalAlias = await acquireHardLock({
      owner: "codex",
      agent: "debugger",
      cwd: tempDir,
      lockType: "write",
      paths: ["src/a/../file.js"],
    });
    assert.equal(traversalAlias.ok, false);
    assert.match(traversalAlias.error, /parent traversal/);
    await releaseHardLock(canonicalAliasLock.lock.id, canonicalAliasLock.lock.token, canonicalAliasLock.lock.paths, tempDir);

    const directoryAliasLock = await acquireHardLock({ owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["src"] });
    assert.equal(directoryAliasLock.ok, true);
    const directoryDotConflict = await acquireHardLock({ owner: "codex", agent: "debugger", cwd: tempDir, lockType: "write", paths: ["src/."] });
    assert.equal(directoryDotConflict.ok, false);
    const directoryTraversalAlias = await acquireHardLock({ owner: "codex", agent: "debugger", cwd: tempDir, lockType: "write", paths: ["src/foo/.."] });
    assert.equal(directoryTraversalAlias.ok, false);
    assert.match(directoryTraversalAlias.error, /parent traversal/);
    await releaseHardLock(directoryAliasLock.lock.id, directoryAliasLock.lock.token, directoryAliasLock.lock.paths, tempDir);

    const caseMode = filesystemCaseModeForRoot(tempDir);
    const upperCaseLock = await acquireHardLock({ owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["src/User.ts"] });
    const lowerCaseLock = await acquireHardLock({ owner: "codex", agent: "debugger", cwd: tempDir, lockType: "write", paths: ["src/user.ts"] });
    assert.equal(upperCaseLock.ok, true);
    assert.equal(lowerCaseLock.ok, caseMode === "sensitive", `Case mode ${caseMode} must determine lock identity.`);
    if (lowerCaseLock.ok) await releaseHardLock(lowerCaseLock.lock.id, lowerCaseLock.lock.token, lowerCaseLock.lock.paths, tempDir);
    await releaseHardLock(upperCaseLock.lock.id, upperCaseLock.lock.token, upperCaseLock.lock.paths, tempDir);

    const disjointAliasControlA = await acquireHardLock({ owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["src/a"] });
    const disjointAliasControlB = await acquireHardLock({ owner: "codex", agent: "debugger", cwd: tempDir, lockType: "write", paths: ["src/b"] });
    assert.equal(disjointAliasControlA.ok, true);
    assert.equal(disjointAliasControlB.ok, true);
    await releaseHardLock(disjointAliasControlA.lock.id, disjointAliasControlA.lock.token, disjointAliasControlA.lock.paths, tempDir);
    await releaseHardLock(disjointAliasControlB.lock.id, disjointAliasControlB.lock.token, disjointAliasControlB.lock.paths, tempDir);

    const ordinaryWriter = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/api"],
    });
    const disjointSerialIntegration = await acquireHardLock({
      owner: "codex",
      agent: "merge_manager",
      cwd: tempDir,
      lockType: "serial_integration",
      paths: ["apps/web"],
    });
    assert.equal(ordinaryWriter.ok, true);
    assert.equal(disjointSerialIntegration.ok, false);
    await releaseHardLock(ordinaryWriter.lock.id, ordinaryWriter.lock.token, ordinaryWriter.lock.paths, tempDir);

    const lockB = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockB.ok, true);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await listLocks(tempDir)).length, 1);
    const db = await openLockDb(tempDir);
    try {
      db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ?").run(Date.now() - 1, lockB.lock.id);
    } finally {
      closeDb(db);
    }
    await cleanupExpiredLocks(tempDir);
    assert.equal((await listLocks(tempDir)).length, 0);
    const auditRetentionDb = await openLockDb(tempDir);
    try {
      const expiredRun = auditRetentionDb.prepare("SELECT status, finished_at FROM runs WHERE run_id = ?").get(lockB.lock.id);
      assert.equal(expiredRun.status, "expired");
      assert.equal(Number.isFinite(Number(expiredRun.finished_at)), true);
      auditRetentionDb.prepare("INSERT INTO changed_files (run_id, path, allowed) VALUES (?, ?, ?)")
        .run(lockB.lock.id, "expired-audit-fixture.txt", 1);
      auditRetentionDb.prepare("UPDATE runs SET finished_at = ? WHERE run_id = ?")
        .run(Date.now() - (CONFIG.auditRetentionDays + 1) * 24 * 60 * 60 * 1000, lockB.lock.id);
      const auditDbPath = stateDbPath(tempDir);
      statePruneTimes.delete(auditDbPath);
      prunePersistedState(auditRetentionDb, auditDbPath);
      assert.equal(auditRetentionDb.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(lockB.lock.id), undefined);
      assert.equal(auditRetentionDb.prepare("SELECT 1 FROM changed_files WHERE run_id = ?").get(lockB.lock.id), undefined);
    } finally {
      closeDb(auditRetentionDb);
    }

    const staleQueueDb = await openLockDb(tempDir);
    try {
      const oldCreatedAt = new Date(Date.now() - CONFIG.queueStaleAfterMs - 1000).toISOString();
      const recentCreatedAt = new Date().toISOString();
      const insertQueueRecord = staleQueueDb.prepare(`
        INSERT OR REPLACE INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of [
        { jobId: "stale-self-test", createdAt: oldCreatedAt, status: "pending" },
        { jobId: "recent-self-test", createdAt: recentCreatedAt, status: "running" },
      ]) {
        const snapshot = {
          jobId: record.jobId,
          cwd: tempDir,
          status: record.status,
          agent: "reviewer",
          mode: "read",
          createdAt: record.createdAt,
        };
        insertQueueRecord.run(
          snapshot.jobId,
          snapshot.cwd,
          snapshot.status,
          snapshot.agent,
          snapshot.mode,
          snapshot.createdAt,
          "",
          "",
          JSON.stringify(snapshot)
        );
      }

      assert.deepEqual(reconcileStaleQueueRecords(staleQueueDb), ["stale-self-test"]);
      const staleRow = staleQueueDb.prepare(
        "SELECT status, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get("stale-self-test");
      const recentRow = staleQueueDb.prepare(
        "SELECT status, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get("recent-self-test");
      assert.equal(staleRow.status, "not_resumable");
      assert.equal(JSON.parse(staleRow.record_json).errorType, "queue_job_not_resumable");
      assert.equal(recentRow.status, "running");
      assert.equal(JSON.parse(recentRow.record_json).errorType, undefined);
      const expiredLease = new Date(Date.now() - 1000).toISOString();
      const futureLease = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      const insertLeased = staleQueueDb.prepare(`
        INSERT OR REPLACE INTO opencode_jobs
        (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
         owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const leased of [
        { jobId: "crashed-self-test", lease: expiredLease },
        { jobId: "crashed-live-child-self-test", lease: expiredLease },
        { jobId: "cancelled-orphan-self-test", lease: expiredLease },
        { jobId: "live-lease-self-test", lease: futureLease },
      ]) {
        const snapshot = {
          jobId: leased.jobId,
          cwd: tempDir,
          status: "running",
          agent: "reviewer",
          mode: "read",
          createdAt: oldCreatedAt,
          startedAt: oldCreatedAt,
          ownerInstanceId: "foreign-dead-instance",
          ownerProcessId: leased.jobId === "crashed-self-test" ? process.pid : 999999,
          ownerGeneration: "generation-a",
          heartbeatAt: oldCreatedAt,
          leaseExpiresAt: leased.lease,
        };
        insertLeased.run(
          snapshot.jobId, tempDir, snapshot.status, snapshot.agent, snapshot.mode,
          snapshot.createdAt, snapshot.startedAt, "", JSON.stringify(snapshot),
          snapshot.ownerInstanceId, snapshot.ownerProcessId, snapshot.ownerGeneration,
          snapshot.heartbeatAt, snapshot.heartbeatAt, snapshot.leaseExpiresAt
        );
      }
      staleQueueDb.prepare("UPDATE opencode_jobs SET child_process_id = ?, child_process_started_at = ? WHERE job_id = ?")
        .run(process.pid, oldCreatedAt, "crashed-live-child-self-test");
      staleQueueDb.prepare("UPDATE opencode_jobs SET cancellation_requested_at = ? WHERE job_id = ?")
        .run(oldCreatedAt, "cancelled-orphan-self-test");
      assert.deepEqual(new Set(reconcileStaleQueueRecords(staleQueueDb)), new Set([
        "crashed-self-test",
        "crashed-live-child-self-test",
        "cancelled-orphan-self-test",
      ]));
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("crashed-self-test").status, "interrupted");
      const liveChildOrphan = staleQueueDb.prepare("SELECT status, record_json FROM opencode_jobs WHERE job_id = ?").get("crashed-live-child-self-test");
      assert.equal(liveChildOrphan.status, "interrupted");
      assert.equal(JSON.parse(liveChildOrphan.record_json).orphanChildProcessAlive, true);
      assert.equal(JSON.parse(liveChildOrphan.record_json).orphanChildProcessId, process.pid);
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("cancelled-orphan-self-test").status, "cancelled");
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get("live-lease-self-test").status, "running");

      const terminalRaceRecord = {
        jobId: "terminal-cancel-race-self-test",
        cwd: tempDir,
        status: "running",
        agent: "reviewer",
        mode: "read",
        createdAt: recentCreatedAt,
        startedAt: recentCreatedAt,
        ownerInstanceId: BRIDGE_INSTANCE_ID,
        ownerProcessId: process.pid,
        ownerGeneration: "terminal-race-generation",
        heartbeatAt: recentCreatedAt,
        leaseExpiresAt: futureLease,
        cancellationRequested: false,
        cancellationRequestedAt: "",
        childProcessId: 0,
        childProcessStartedAt: "",
        revision: 0,
      };
      insertLeased.run(
        terminalRaceRecord.jobId, tempDir, terminalRaceRecord.status, terminalRaceRecord.agent, terminalRaceRecord.mode,
        terminalRaceRecord.createdAt, terminalRaceRecord.startedAt, "", JSON.stringify(queueRecordSnapshot(terminalRaceRecord)),
        terminalRaceRecord.ownerInstanceId, terminalRaceRecord.ownerProcessId, terminalRaceRecord.ownerGeneration,
        terminalRaceRecord.heartbeatAt, terminalRaceRecord.heartbeatAt, terminalRaceRecord.leaseExpiresAt
      );
      staleQueueDb.prepare("UPDATE opencode_jobs SET cancellation_requested_at = '' WHERE job_id = ?")
        .run(terminalRaceRecord.jobId);
      const initialCancellation = await cancelPersistedQueueJob(staleQueueDb, terminalRaceRecord.jobId);
      assert.equal(initialCancellation.outcome, "cancellation_requested");
      const repeatedCancellation = await cancelPersistedQueueJob(staleQueueDb, terminalRaceRecord.jobId);
      assert.equal(repeatedCancellation.outcome, "cancellation_requested");
      assert.equal(
        staleQueueDb.prepare("SELECT cancellation_requested_at FROM opencode_jobs WHERE job_id = ?").get(terminalRaceRecord.jobId).cancellation_requested_at,
        initialCancellation.requestedAt
      );
      Object.assign(terminalRaceRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
        resultText: "A completion result that must not outrun durable cancellation.",
      });
      const terminalRace = persistTerminalQueueRecord(staleQueueDb, terminalRaceRecord);
      assert.equal(terminalRace.persisted, true);
      assert.equal(terminalRace.cancellationWon, true);
      assert.equal(terminalRaceRecord.status, "cancelled");
      const terminalRaceRow = staleQueueDb.prepare(
        "SELECT status, cancellation_requested_at, record_json FROM opencode_jobs WHERE job_id = ?"
      ).get(terminalRaceRecord.jobId);
      assert.equal(terminalRaceRow.status, "cancelled");
      assert.equal(terminalRaceRow.cancellation_requested_at, initialCancellation.requestedAt);
      assert.equal(JSON.parse(terminalRaceRow.record_json).status, "cancelled");
      assert.equal(JSON.parse(terminalRaceRow.record_json).cancellationRequestedAt, initialCancellation.requestedAt);
      Object.assign(terminalRaceRecord, { status: "failed", errorType: "late_failure" });
      const terminalReplay = persistTerminalQueueRecord(staleQueueDb, terminalRaceRecord);
      assert.equal(terminalReplay.persisted, false);
      assert.equal(terminalRaceRecord.status, "cancelled");

      const currentOwnerRecord = {
        ...terminalRaceRecord,
        jobId: "terminal-owner-generation-self-test",
        status: "running",
        finishedAt: "",
        cancellationRequested: false,
        cancellationRequestedAt: "",
        errorType: "",
        errorReason: "",
        ownerGeneration: "current-owner-generation",
        heartbeatAt: recentCreatedAt,
        leaseExpiresAt: futureLease,
        revision: 0,
      };
      insertLeased.run(
        currentOwnerRecord.jobId, tempDir, currentOwnerRecord.status, currentOwnerRecord.agent, currentOwnerRecord.mode,
        currentOwnerRecord.createdAt, currentOwnerRecord.startedAt, "", JSON.stringify(queueRecordSnapshot(currentOwnerRecord)),
        currentOwnerRecord.ownerInstanceId, currentOwnerRecord.ownerProcessId, currentOwnerRecord.ownerGeneration,
        currentOwnerRecord.heartbeatAt, currentOwnerRecord.heartbeatAt, currentOwnerRecord.leaseExpiresAt
      );
      const staleOwnerRecord = {
        ...currentOwnerRecord,
        status: "failed",
        finishedAt: new Date().toISOString(),
        ownerGeneration: "stale-owner-generation",
        errorType: "late_failure",
      };
      const staleOwnerTerminal = persistTerminalQueueRecord(staleQueueDb, staleOwnerRecord);
      assert.equal(staleOwnerTerminal.persisted, false);
      assert.equal(staleOwnerRecord.status, "running");
      assert.equal(staleOwnerRecord.ownerGeneration, "current-owner-generation");
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(currentOwnerRecord.jobId).status, "running");
      Object.assign(currentOwnerRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
      });
      const currentOwnerTerminal = persistTerminalQueueRecord(staleQueueDb, currentOwnerRecord);
      assert.equal(currentOwnerTerminal.persisted, true);
      assert.equal(currentOwnerTerminal.cancellationWon, false);
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(currentOwnerRecord.jobId).status, "completed");

      const expiredOwnerRecord = {
        ...currentOwnerRecord,
        jobId: "terminal-expired-lease-self-test",
        status: "running",
        finishedAt: "",
        ownerGeneration: "expired-owner-generation",
        heartbeatAt: oldCreatedAt,
        leaseExpiresAt: expiredLease,
        revision: 0,
      };
      insertLeased.run(
        expiredOwnerRecord.jobId, tempDir, expiredOwnerRecord.status, expiredOwnerRecord.agent, expiredOwnerRecord.mode,
        expiredOwnerRecord.createdAt, expiredOwnerRecord.startedAt, "", JSON.stringify(queueRecordSnapshot(expiredOwnerRecord)),
        expiredOwnerRecord.ownerInstanceId, expiredOwnerRecord.ownerProcessId, expiredOwnerRecord.ownerGeneration,
        expiredOwnerRecord.heartbeatAt, expiredOwnerRecord.heartbeatAt, expiredOwnerRecord.leaseExpiresAt
      );
      Object.assign(expiredOwnerRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
      });
      const expiredOwnerTerminal = persistTerminalQueueRecord(staleQueueDb, expiredOwnerRecord);
      assert.equal(expiredOwnerTerminal.persisted, false);
      assert.equal(expiredOwnerTerminal.ownershipLost, true);
      assert.equal(staleQueueDb.prepare("SELECT status FROM opencode_jobs WHERE job_id = ?").get(expiredOwnerRecord.jobId).status, "running");

      staleQueueDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "stale-self-test",
        "recent-self-test",
        "crashed-self-test",
        "crashed-live-child-self-test",
        "cancelled-orphan-self-test",
        "live-lease-self-test",
        terminalRaceRecord.jobId,
        currentOwnerRecord.jobId,
        expiredOwnerRecord.jobId
      );
    } finally {
      closeDb(staleQueueDb);
    }

    const previousQueuePersistenceMode = selfTestHooks.queueModeOverride;
    selfTestHooks.queueModeOverride = "sqlite";
    const makeQueuePersistenceRecord = (jobId) => ({
      jobId,
      parentJobId: "",
      cwd: tempDir,
      agent: "reviewer",
      task: "Queue persistence self-test",
      mode: "read",
      lockMode: "read",
      lockedPaths: [],
      allowedEdits: [],
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: "",
      finishedAt: "",
      errorType: "",
      errorReason: "",
      resultText: "",
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerProcessId: process.pid,
      ownerGeneration: randomBytes(12).toString("hex"),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      cancellationRequested: false,
      cancellationRequestedAt: "",
      childProcessId: 0,
      childProcessStartedAt: "",
      revision: 0,
    });

    const preExecutionFailureRecord = makeQueuePersistenceRecord("pre-execution-failure-self-test");
    assert.equal((await persistQueueRecord(preExecutionFailureRecord)).persisted, true);
    assert.equal((await updateQueueRecordDurable(preExecutionFailureRecord, { status: "planned" })).persisted, true);
    const preExecutionFailure = await updateQueueRecordDurable(preExecutionFailureRecord, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorType: "write_lock_conflict",
      errorReason: "Deterministic pre-execution conflict rejection.",
    });
    assert.equal(preExecutionFailure.persisted, true);
    assert.equal(preExecutionFailureRecord.status, "failed");
    assert.equal((await readPersistedQueueRecord(preExecutionFailureRecord.jobId, tempDir)).status, "failed");

    const atomicCancellationRecord = makeQueuePersistenceRecord("atomic-cancellation-self-test");
    assert.equal((await persistQueueRecord(atomicCancellationRecord)).persisted, true);
    const cancellationDb = await openLockDb(tempDir);
    try {
      const cancelled = await cancelPersistedQueueJob(cancellationDb, atomicCancellationRecord.jobId);
      assert.equal(cancelled.outcome, "cancelled");
      const cancelledRow = cancellationDb.prepare(`
        SELECT status, cancellation_requested_at, result_encrypted FROM opencode_jobs WHERE job_id = ?
      `).get(atomicCancellationRecord.jobId);
      assert.equal(cancelledRow.status, "cancelled");
      assert.ok(cancelledRow.cancellation_requested_at);
      assert.ok(cancelledRow.result_encrypted);

      const cancellationRaceRecord = makeQueuePersistenceRecord("cancellation-claim-race-self-test");
      assert.equal((await persistQueueRecord(cancellationRaceRecord)).persisted, true);
      selfTestHooks.queueCancellationTestHook = async ({ attempt, row }) => {
        if (attempt !== 0) return;
        const currentSummary = JSON.parse(row.record_json || "{}");
        const newerSummary = queueRecordDurableSummary({
          ...currentSummary,
          status: "running",
          startedAt: new Date().toISOString(),
          worktreePath: path.join(tempDir, "durable-race-worktree"),
          revision: Number(row.revision || 0) + 1,
        });
        cancellationDb.prepare(`
          UPDATE opencode_jobs
          SET status = 'running', started_at = ?, record_json = ?, revision = revision + 1
          WHERE job_id = ? AND status = ? AND revision = ?
        `).run(
          newerSummary.startedAt,
          JSON.stringify(newerSummary),
          cancellationRaceRecord.jobId,
          row.status,
          Number(row.revision || 0)
        );
      };
      const racedCancellation = await cancelPersistedQueueJob(cancellationDb, cancellationRaceRecord.jobId);
      assert.equal(racedCancellation.outcome, "cancellation_requested");
      const racedRow = cancellationDb.prepare(`
        SELECT status, cancellation_requested_at, record_json FROM opencode_jobs WHERE job_id = ?
      `).get(cancellationRaceRecord.jobId);
      assert.equal(racedRow.status, "running");
      assert.ok(racedRow.cancellation_requested_at);
      assert.equal(JSON.parse(racedRow.record_json).worktreePath, path.join(tempDir, "durable-race-worktree"));
    } finally {
      selfTestHooks.queueCancellationTestHook = null;
      cancellationDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?)")
        .run(atomicCancellationRecord.jobId, "cancellation-claim-race-self-test");
      closeDb(cancellationDb);
    }

    const scheduledConflictRecord = makeQueuePersistenceRecord("scheduled-conflict-reject-self-test");
    Object.assign(scheduledConflictRecord, {
      mode: "write",
      lockMode: "write",
      lockedPaths: ["src/conflict.txt"],
      allowedEdits: ["src/conflict.txt"],
    });
    const runningConflictRecord = {
      ...makeQueuePersistenceRecord("scheduled-conflict-running-self-test"),
      mode: "write",
      lockMode: "write",
      lockedPaths: ["src/conflict.txt"],
      allowedEdits: ["src/conflict.txt"],
      status: "running",
    };
    assert.equal((await persistQueueRecord(scheduledConflictRecord)).persisted, true);
    QUEUE_JOBS.set(runningConflictRecord.jobId, runningConflictRecord);
    QUEUE_JOBS.set(scheduledConflictRecord.jobId, scheduledConflictRecord);
    const previousQueueConflictPolicy = selfTestHooks.queueWriteConflictPolicyOverride;
    try {
      selfTestHooks.queueWriteConflictPolicyOverride = "reject";
      scheduleQueue();
      let persistedScheduledConflict = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (scheduledConflictRecord.status === "failed") {
          persistedScheduledConflict = await readPersistedQueueRecord(scheduledConflictRecord.jobId, tempDir);
          if (persistedScheduledConflict?.status === "failed") break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(scheduledConflictRecord.status, "failed");
      assert.equal(scheduledConflictRecord.errorType, "write_lock_conflict");
      assert.equal(persistedScheduledConflict?.status, "failed");
    } finally {
      selfTestHooks.queueWriteConflictPolicyOverride = previousQueueConflictPolicy;
      QUEUE_JOBS.delete(runningConflictRecord.jobId);
      QUEUE_JOBS.delete(scheduledConflictRecord.jobId);
    }

    const staleRevisionRecord = makeQueuePersistenceRecord("stale-revision-self-test");
    assert.equal((await persistQueueRecord(staleRevisionRecord)).persisted, true);
    const staleRevisionClone = structuredClone(staleRevisionRecord);
    assert.equal((await updateQueueRecordDurable(staleRevisionRecord, { status: "planned" })).persisted, true);
    assert.equal((await claimQueueRecord(staleRevisionRecord)).ok, true);
    staleRevisionClone.status = "blocked";
    const staleRevisionPersistence = await persistQueueRecord(staleRevisionClone);
    assert.equal(staleRevisionPersistence.persisted, false);
    assert.equal(staleRevisionClone.status, "running");
    assert.equal((await readPersistedQueueRecord(staleRevisionRecord.jobId, tempDir)).status, "running");
    assert.equal((await updateQueueRecordDurable(staleRevisionRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);

    const heartbeatRevisionRecord = makeQueuePersistenceRecord("heartbeat-revision-self-test");
    assert.equal((await persistQueueRecord(heartbeatRevisionRecord)).persisted, true);
    const heartbeatRevisionBefore = heartbeatRevisionRecord.revision;
    const heartbeatRevisionDb = await openLockDb(tempDir);
    try {
      const heartbeatAt = new Date().toISOString();
      assert.equal(renewPersistedQueueRecordLease(
        heartbeatRevisionDb,
        heartbeatRevisionRecord,
        heartbeatAt,
        new Date(Date.now() + CONFIG.queueLeaseMs).toISOString()
      ), true);
    } finally {
      closeDb(heartbeatRevisionDb);
    }
    const persistedHeartbeatRevision = await readPersistedQueueRecord(heartbeatRevisionRecord.jobId, tempDir);
    assert.ok(heartbeatRevisionRecord.revision > heartbeatRevisionBefore);
    assert.equal(heartbeatRevisionRecord.revision, persistedHeartbeatRevision.revision);
    assert.equal((await updateQueueRecordDurable(heartbeatRevisionRecord, { status: "cancelled", finishedAt: new Date().toISOString() })).persisted, true);

    const staleHeartbeatTransitionRecord = makeQueuePersistenceRecord("stale-heartbeat-transition-self-test");
    assert.equal((await persistQueueRecord(staleHeartbeatTransitionRecord)).persisted, true);
    const staleHeartbeatDb = await openLockDb(tempDir);
    try {
      const heartbeatAt = new Date().toISOString();
      staleHeartbeatDb.prepare(`
        UPDATE opencode_jobs
        SET heartbeat_at = ?, lease_expires_at = ?, revision = revision + 1
        WHERE job_id = ?
      `).run(
        heartbeatAt,
        new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
        staleHeartbeatTransitionRecord.jobId
      );
    } finally {
      closeDb(staleHeartbeatDb);
    }
    const staleHeartbeatTransition = await updateQueueRecordDurable(staleHeartbeatTransitionRecord, { status: "planned" });
    assert.equal(staleHeartbeatTransition.persisted, true);
    assert.equal(staleHeartbeatTransitionRecord.status, "planned");

    const truncatedQueueRecord = makeQueuePersistenceRecord("queue-result-truncation-self-test");
    assert.equal((await persistQueueRecord(truncatedQueueRecord)).persisted, true);
    assert.equal((await claimQueueRecord(truncatedQueueRecord)).ok, true);
    const truncatedQueuePersistence = await updateQueueRecordDurable(truncatedQueueRecord, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      resultText: "x".repeat(CONFIG.queueResultMaxChars + 1),
    });
    assert.equal(truncatedQueuePersistence.persisted, true);
    assert.equal(truncatedQueueRecord.status, "completed");
    assert.equal(truncatedQueueRecord.errorType, "");
    assert.equal(truncatedQueueRecord.completionOutcome, "completed_with_truncated_output");
    const noResultTruncatedQueueSnapshot = queueRecordSnapshot(truncatedQueueRecord, false);
    assert.equal(noResultTruncatedQueueSnapshot.status, "completed");
    assert.equal(noResultTruncatedQueueSnapshot.completionOutcome, "completed_with_truncated_output");
    assert.equal(noResultTruncatedQueueSnapshot.resultText, "");
    const persistedTruncatedQueue = await readPersistedQueueRecord(truncatedQueueRecord.jobId, tempDir);
    assert.equal(persistedTruncatedQueue.status, "completed");
    assert.equal(persistedTruncatedQueue.errorType, "");
    assert.equal(persistedTruncatedQueue.completionOutcome, "completed_with_truncated_output");
    assert.equal(persistedTruncatedQueue.resultTextTruncated, true);
    assert.equal(persistedTruncatedQueue.resultTextChars, CONFIG.queueResultMaxChars + 1);
    assert.equal(persistedTruncatedQueue.resultTextSha256, createHash("sha256").update("x".repeat(CONFIG.queueResultMaxChars + 1)).digest("hex"));
    const listedTruncatedQueue = (await listPersistedQueueRecords(tempDir, "completed"))
      .find((record) => record.jobId === truncatedQueueRecord.jobId);
    assert.ok(listedTruncatedQueue);
    assert.equal(listedTruncatedQueue.status, "completed");
    assert.equal(listedTruncatedQueue.completionOutcome, "completed_with_truncated_output");
    assert.equal(listedTruncatedQueue.resultText, undefined);
    assert.equal(listedTruncatedQueue.resultTextChars, CONFIG.queueResultMaxChars + 1);
    const encryptedQueueResultDb = await openLockDb(tempDir);
    try {
      const encryptedQueueResult = encryptedQueueResultDb.prepare(`
        SELECT record_json, result_encrypted FROM opencode_jobs WHERE job_id = ?
      `).get(truncatedQueueRecord.jobId);
      const publicQueueSummary = JSON.parse(encryptedQueueResult.record_json);
      assert.equal(publicQueueSummary.resultText, undefined);
      assert.equal(publicQueueSummary.errorReason, undefined);
      assert.ok(encryptedQueueResult.result_encrypted);
      assert.doesNotMatch(encryptedQueueResult.result_encrypted, /xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/);
    } finally {
      closeDb(encryptedQueueResultDb);
    }

    const missingFinalQueueRecord = makeQueuePersistenceRecord("queue-missing-final-self-test");
    assert.equal((await persistQueueRecord(missingFinalQueueRecord)).persisted, true);
    assert.equal((await claimQueueRecord(missingFinalQueueRecord)).ok, true);
    assert.equal((await updateQueueRecordDurable(missingFinalQueueRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(missingFinalQueueRecord.status, "failed");
    assert.equal(missingFinalQueueRecord.errorType, "completion_evidence_missing");

    const missingWriteEvidenceRecord = makeQueuePersistenceRecord("queue-missing-write-evidence-self-test");
    Object.assign(missingWriteEvidenceRecord, { mode: "write", resultText: "Finished without durable change evidence." });
    assert.equal((await persistQueueRecord(missingWriteEvidenceRecord)).persisted, true);
    assert.equal((await claimQueueRecord(missingWriteEvidenceRecord)).ok, true);
    assert.equal((await updateQueueRecordDurable(missingWriteEvidenceRecord, { status: "completed", finishedAt: new Date().toISOString() })).persisted, true);
    assert.equal(missingWriteEvidenceRecord.status, "failed");
    assert.equal(missingWriteEvidenceRecord.errorType, "write_completion_evidence_missing");

    const queuePersistenceCleanupDb = await openLockDb(tempDir);
    try {
      queuePersistenceCleanupDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?, ?, ?, ?, ?, ?, ?)").run(
        preExecutionFailureRecord.jobId,
        scheduledConflictRecord.jobId,
        staleRevisionRecord.jobId,
        heartbeatRevisionRecord.jobId,
        staleHeartbeatTransitionRecord.jobId,
        truncatedQueueRecord.jobId,
        missingFinalQueueRecord.jobId,
        missingWriteEvidenceRecord.jobId
      );
    } finally {
      closeDb(queuePersistenceCleanupDb);
    }
    selfTestHooks.queueModeOverride = previousQueuePersistenceMode;

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "allowed\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "api\n", "utf8");
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "clean\n", "utf8");
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "secret\n", "utf8");
    await runCommand("git", ["add", "."], tempDir, 1000 * 15);
    const commit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], tempDir, 1000 * 15);
    assert.equal(commit.exitCode, 0);
    assert.equal(await resolveProjectStateRoot(path.join(tempDir, "src")), path.resolve(tempDir));
    const initialHead = (await runCommand("git", ["rev-parse", "HEAD"], tempDir, 1000 * 15)).stdout.trim();
    const readinessWriterPlan = { lockType: "write", lockedPaths: ["src/allowed.txt"], allowedEdits: ["src/allowed.txt"] };
    const readinessWriterJob = { cwd: tempDir, write: true };
    const cleanReadiness = await verifyJobWorkspaceReadiness(readinessWriterJob, readinessWriterPlan, "write");
    assert.equal(cleanReadiness.ok, true);
    assert.equal(cleanReadiness.head, initialHead);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "unstaged checkpoint test\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "staged checkpoint test\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "untracked-checkpoint.txt"), "untracked checkpoint test\n", "utf8");
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "overlapping checkpoint test\n", "utf8");
    const dirtyStatusBefore = (await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], tempDir, 1000 * 15)).stdout;
    const dirtyIndexBefore = (await runCommand("git", ["diff", "--cached", "--binary"], tempDir, 1000 * 15)).stdout;
    const dirtyIndexFileShaBefore = await sha256File(path.join(tempDir, ".git", "index"));
    const dirtyPreflight = await inspectSourceCheckpointState(tempDir, {
      lockedPaths: ["src/allowed.txt"],
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(dirtyPreflight.ok, false);
    assert.equal(dirtyPreflight.errorType, "dirty_worktree_requires_checkpoint");
    assert.ok(dirtyPreflight.dirtyFiles.includes("src/api.txt"));
    assert.ok(dirtyPreflight.dirtyFiles.includes("src/blocked.txt"));
    assert.ok(dirtyPreflight.dirtyFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyPreflight.overlappingFiles, ["src/allowed.txt"]);
    assert.ok(dirtyPreflight.disjointFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyPreflight.conflictingPaths, ["src/allowed.txt"]);
    const toleratedPreflight = await inspectSourceCheckpointState(tempDir, {
      lockedPaths: ["docs"],
      allowedEdits: ["docs"],
      policy: "unrelated_ok",
    });
    assert.equal(toleratedPreflight.ok, true);
    assert.equal(toleratedPreflight.errorType, null);
    assert.equal(toleratedPreflight.sourceDirtPolicy, "unrelated_ok");
    assert.deepEqual(toleratedPreflight.overlappingFiles, []);
    assert.deepEqual(toleratedPreflight.toleratedDisjointFiles, toleratedPreflight.dirtyFiles);
    assert.ok(toleratedPreflight.toleratedDisjointFiles.includes("untracked-checkpoint.txt"));
    const toleratedButOverlapping = await inspectSourceCheckpointState(tempDir, {
      lockedPaths: ["src/allowed.txt"],
      allowedEdits: ["src/allowed.txt"],
      policy: "unrelated_ok",
    });
    assert.equal(toleratedButOverlapping.ok, false);
    assert.equal(toleratedButOverlapping.errorType, "dirty_worktree_requires_checkpoint");
    assert.match(toleratedButOverlapping.error, /inside this job's locked\/allowed scope \(src\/allowed\.txt\)/);
    assert.deepEqual(toleratedButOverlapping.conflictingPaths, ["src/allowed.txt"]);
    assert.equal((await inspectSourceCheckpointState(tempDir, { policy: "unrelated_ok" })).ok, false, "unscoped checks stay strict");
    assert.equal((await inspectSourceCheckpointState(tempDir, { lockedPaths: ["docs"], allowedEdits: ["docs"], policy: "strict" })).ok, false);
    const dirtyReadiness = await verifyJobWorkspaceReadiness(readinessWriterJob, readinessWriterPlan, "write");
    assert.equal(dirtyReadiness.errorType, "dirty_worktree_requires_checkpoint");
    assert.deepEqual(dirtyReadiness.dirtyFiles, dirtyPreflight.dirtyFiles);
    assert.deepEqual(dirtyReadiness.conflictingPaths, ["src/allowed.txt"]);
    assert.equal((await verifyJobWorkspaceReadiness({ ...readinessReaderJob, cwd: tempDir }, readinessReaderPlan, "write")).ok, true);
    assert.equal((await verifyJobWorkspaceReadiness({ ...readinessReaderJob, cwd: tempDir }, readinessReaderPlan, "all")).errorType, "dirty_worktree_requires_checkpoint");
    assert.equal((await verifyJobWorkspaceReadiness(readinessWriterJob, readinessWriterPlan, "off")).ok, true);
    assert.deepEqual(await verifyJobWorkspaceReadiness({ ...readinessWriterJob, dryRun: true }, readinessWriterPlan, "write"), { ok: true, skipped: "routing_only" });
    const dirtyWorktreeRejected = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "dirty-source-rejected",
      lockedPaths: ["src/allowed.txt"],
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(dirtyWorktreeRejected.ok, false);
    assert.equal(dirtyWorktreeRejected.errorType, "dirty_worktree_requires_checkpoint");
    assert.ok(dirtyWorktreeRejected.dirtyFiles.includes("untracked-checkpoint.txt"));
    assert.deepEqual(dirtyCheckpointDetails(dirtyWorktreeRejected).conflictingPaths, ["src/allowed.txt"]);
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], tempDir, 1000 * 15)).stdout.trim(), initialHead);
    assert.equal((await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], tempDir, 1000 * 15)).stdout, dirtyStatusBefore);
    assert.equal((await runCommand("git", ["diff", "--cached", "--binary"], tempDir, 1000 * 15)).stdout, dirtyIndexBefore);
    assert.equal(await sha256File(path.join(tempDir, ".git", "index")), dirtyIndexFileShaBefore);
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/allowed.txt", "src/api.txt", "src/blocked.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await rm(path.join(tempDir, "untracked-checkpoint.txt"), { force: true });
    assert.deepEqual(await gitChangedFiles(tempDir), []);

    const rollbackSymlinkBaseline = await captureRollbackBaseline(tempDir);
    const externalRollbackSentinel = path.join(outsideLinkTarget, "rollback-sentinel.txt");
    await mkdir(outsideLinkTarget, { recursive: true });
    await writeFile(externalRollbackSentinel, "external sentinel unchanged\n", "utf8");
    const rollbackVictim = path.join(tempDir, "src", "allowed.txt");
    await rm(rollbackVictim, { force: true });
    if (process.platform === "win32") {
      // File symlinks normally require Developer Mode on Windows. A hard link
      // exercises the same critical invariant: rollback must replace the leaf,
      // never write through a link to external bytes.
      await link(externalRollbackSentinel, rollbackVictim);
    } else {
      await symlink(externalRollbackSentinel, rollbackVictim);
    }
    const maliciousLinkSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    const safeSymlinkRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: rollbackSymlinkBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: maliciousLinkSnapshot,
    });
    assert.equal(safeSymlinkRollback.rollback, "success");
    assert.equal(await readFile(externalRollbackSentinel, "utf8"), "external sentinel unchanged\n");
    assert.equal((await lstat(rollbackVictim)).isSymbolicLink(), false);
    assert.equal(await readFile(rollbackVictim, "utf8"), "allowed\n");

    const rollbackModeBaseline = await captureRollbackBaseline(tempDir);
    await chmod(rollbackVictim, 0o755);
    const executableOwnedSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    if (process.platform !== "win32") {
      assert.equal(executableOwnedSnapshot.get("src/allowed.txt").startsWith("file:493:"), true);
    }
    const safeModeRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: rollbackModeBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: executableOwnedSnapshot,
    });
    assert.equal(safeModeRollback.rollback, "success");
    if (process.platform !== "win32") assert.equal((await lstat(rollbackVictim)).mode & 0o111, 0);
    assert.equal(await readFile(rollbackVictim, "utf8"), "allowed\n");

    const basePinnedWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "base-pin-test" });
    assert.equal(basePinnedWorktree.ok, true, JSON.stringify(basePinnedWorktree, null, 2));
    assert.equal(basePinnedWorktree.baseCommit, initialHead);
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], basePinnedWorktree.path, 1000 * 15)).stdout.trim(), initialHead);
    await cleanupWorktree(basePinnedWorktree, "always", true);

    if (effectiveQueueMode() === "sqlite") {
      const crossProcessLock = await acquireHardLock({
        owner: "other-bridge",
        agent: "builder",
        cwd: tempDir,
        lockType: "write",
        paths: ["src/cross-process"],
      });
      assert.equal(crossProcessLock.ok, true);
      const crossProcessDb = await openLockDb(tempDir);
      try {
        const crossProcessRecord = {
          jobId: "cross-process-running",
          cwd: tempDir,
          mode: "write",
          status: "running",
          agent: "builder",
          task: "cross-process test",
          createdAt: new Date().toISOString(),
          lockedPaths: ["src/cross-process"],
          allowedEdits: ["src/cross-process"],
        };
        crossProcessDb.prepare(`
          INSERT OR REPLACE INTO opencode_jobs
          (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crossProcessRecord.jobId,
          tempDir,
          crossProcessRecord.status,
          crossProcessRecord.agent,
          crossProcessRecord.mode,
          crossProcessRecord.createdAt,
          crossProcessRecord.createdAt,
          "",
          JSON.stringify(crossProcessRecord)
        );
      } finally {
        closeDb(crossProcessDb);
      }
      const crossProcessConflict = await findQueueWriteConflict({
        jobId: "cross-process-candidate",
        cwd: tempDir,
        mode: "write",
        lockedPaths: ["src/cross-process"],
        allowedEdits: ["src/cross-process"],
      });
      assert.equal(crossProcessConflict.jobId, "cross-process-running");
      const cleanupCrossProcessDb = await openLockDb(tempDir);
      try {
        cleanupCrossProcessDb.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run("cross-process-running");
      } finally {
        closeDb(cleanupCrossProcessDb);
      }
      await releaseHardLock(crossProcessLock.lock.id, crossProcessLock.lock.token, crossProcessLock.lock.paths, tempDir);
    }

    await writeFile(path.join(tempDir, "src", "api.txt"), "staged api   \n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.ok((await gitChangedFiles(tempDir)).includes("src/api.txt"));
    assert.equal((await runValidationGate({ command: "git diff --check", cwd: tempDir })).status, "failed");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.deepEqual(await gitChangedFiles(tempDir), []);

    selfTestProgress("pipeline persistence");
    const previousPipelinePersistenceMode = selfTestHooks.queueModeOverride;
    selfTestHooks.queueModeOverride = "sqlite";
    const pipelinePersistenceTask = "Persist this full pipeline task only in the encrypted replay request.";
    const pipelinePersistenceIsolationRecord = {
      pipelineId: "pipeline-task-persistence-self-test",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobs: [{ agent: "builder", task: pipelinePersistenceTask }],
      events: [],
      errors: [],
    };
    try {
      await persistPipelineRecord(pipelinePersistenceIsolationRecord);
      assert.equal(pipelinePersistenceIsolationRecord.jobs[0].task, pipelinePersistenceTask);
      const pipelinePersistenceDb = await openLockDb(tempDir);
      let rawPersistedPipeline = null;
      try {
        rawPersistedPipeline = pipelinePersistenceDb.prepare(
          "SELECT record_json, request_encrypted, details_encrypted FROM opencode_pipelines WHERE pipeline_id = ?"
        ).get(pipelinePersistenceIsolationRecord.pipelineId);
      } finally {
        closeDb(pipelinePersistenceDb);
      }
      const rawPipelineRecord = JSON.parse(rawPersistedPipeline.record_json);
      assert.equal(rawPipelineRecord.jobs[0].task, undefined);
      assert.equal(rawPipelineRecord.jobs[0].taskChars, pipelinePersistenceTask.length);
      assert.equal(rawPipelineRecord.jobs[0].taskSha256, createHash("sha256").update(pipelinePersistenceTask).digest("hex"));
      assert.doesNotMatch(rawPersistedPipeline.record_json, new RegExp(pipelinePersistenceTask));
      assert.ok(rawPersistedPipeline.request_encrypted);
      assert.ok(rawPersistedPipeline.details_encrypted);
      assert.doesNotMatch(rawPersistedPipeline.details_encrypted, new RegExp(pipelinePersistenceTask));
      const replayedPipeline = await readPersistedPipelineRecord(pipelinePersistenceIsolationRecord.pipelineId, tempDir);
      assert.equal(replayedPipeline.jobs[0].task, pipelinePersistenceTask);
    } finally {
      const pipelinePersistenceDb = await openLockDb(tempDir);
      try {
        pipelinePersistenceDb.prepare("DELETE FROM opencode_pipelines WHERE pipeline_id = ?").run(pipelinePersistenceIsolationRecord.pipelineId);
      } finally {
        closeDb(pipelinePersistenceDb);
      }
      selfTestHooks.queueModeOverride = previousPipelinePersistenceMode;
    }

    const previousAtomicPipelineMode = selfTestHooks.queueModeOverride;
    selfTestHooks.queueModeOverride = "sqlite";
    const makeAtomicPipelineFixture = async (pipelineId) => {
      const createdAt = new Date().toISOString();
      const fixture = {
        pipelineId,
        cwd: tempDir,
        status: "planned",
        createdAt,
        updatedAt: createdAt,
        jobs: [
          { agent: "reviewer", task: `${pipelineId} child one`, cwd: tempDir, write: false, lockType: "read", lockMode: "off", dryRun: true },
          { agent: "tester", task: `${pipelineId} child two`, cwd: tempDir, write: false, lockType: "read", lockMode: "off", dryRun: true },
        ],
        queueJobIds: [],
        expectedChildCount: 0,
        batchState: "unstarted",
        cleanupState: "none",
        queueMode: "sqlite",
        events: [],
        errors: [],
      };
      await persistPipelineRecord(fixture);
      const prepared = [];
      for (const job of fixture.jobs) {
        const child = await enqueueQueueJob(job, fixture.pipelineId, {
          schedule: false,
          initialStatus: "held",
          persist: false,
        });
        assert.equal(child.ok, true);
        assert.equal(QUEUE_JOBS.has(child.record.jobId), false);
        prepared.push(child.record);
      }
      return { fixture, prepared };
    };
    try {
      const atomic = await makeAtomicPipelineFixture("pipeline-atomic-batch-self-test");
      const activated = await activatePipelineBatch(atomic.fixture, atomic.prepared);
      assert.equal(activated.ok, true, JSON.stringify(activated));
      const atomicDb = await openLockDb(tempDir);
      try {
        const durablePipeline = atomicDb.prepare(`
          SELECT status, expected_child_count, batch_state FROM opencode_pipelines WHERE pipeline_id = ?
        `).get(atomic.fixture.pipelineId);
        assert.equal(durablePipeline.status, "running");
        assert.equal(durablePipeline.expected_child_count, 2);
        assert.equal(durablePipeline.batch_state, "released");
        assert.equal(atomicDb.prepare(
          "SELECT COUNT(*) AS count FROM opencode_pipeline_children WHERE pipeline_id = ?"
        ).get(atomic.fixture.pipelineId).count, 2);
        assert.deepEqual(atomicDb.prepare(`
          SELECT status FROM opencode_jobs WHERE job_id IN (?, ?) ORDER BY job_id
        `).all(...atomic.prepared.map((record) => record.jobId)).map((row) => row.status), ["pending", "pending"]);
      } finally {
        closeDb(atomicDb);
      }
      const missingChildDb = await openLockDb(tempDir);
      try {
        missingChildDb.prepare("DELETE FROM opencode_jobs WHERE job_id = ?").run(atomic.prepared[1].jobId);
      } finally {
        closeDb(missingChildDb);
      }
      await refreshPipelineRecord(atomic.fixture);
      assert.equal(atomic.fixture.status, "failed");
      assert.equal(atomic.fixture.batchState, "incomplete");
      assert.equal(atomic.fixture.errors.at(-1).errorType, "pipeline_child_record_missing");

      const propagation = await makeAtomicPipelineFixture("pipeline-terminal-propagation-self-test");
      assert.equal((await activatePipelineBatch(propagation.fixture, propagation.prepared)).ok, true);
      const failingChild = propagation.prepared[0];
      const siblingChild = propagation.prepared[1];
      assert.equal((await claimQueueRecord(failingChild)).ok, true);
      const failedChild = await updateQueueTerminalRecordDurable(failingChild, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        heartbeatAt: "",
        leaseExpiresAt: "",
        errorType: "pipeline_child_self_test_failure",
        errorReason: "Injected child failure for deterministic sibling cancellation.",
      });
      assert.equal(failedChild.persisted, true);
      await reconcileParentPipelineAfterQueueTerminal(failingChild);
      const propagationDb = await openLockDb(tempDir);
      try {
        assert.equal(propagationDb.prepare(
          "SELECT status FROM opencode_pipelines WHERE pipeline_id = ?"
        ).get(propagation.fixture.pipelineId).status, "failed");
        const siblingRow = propagationDb.prepare(`
          SELECT status, cancellation_requested_at FROM opencode_jobs WHERE job_id = ?
        `).get(siblingChild.jobId);
        assert.equal(siblingRow.status, "cancelled");
        assert.ok(siblingRow.cancellation_requested_at);
      } finally {
        closeDb(propagationDb);
      }
      assert.equal((await claimQueueRecord(siblingChild)).ok, false);
      assert.equal(siblingChild.status, "cancelled");

      const rollback = await makeAtomicPipelineFixture("pipeline-atomic-rollback-self-test");
      const rollbackDb = await openLockDb(tempDir);
      try {
        rollbackDb.exec(`
          CREATE TRIGGER pipeline_atomic_rollback_injected
          BEFORE UPDATE OF status ON opencode_jobs
          WHEN NEW.job_id = '${rollback.prepared[1].jobId.replaceAll("'", "''")}' AND NEW.status = 'pending'
          BEGIN
            SELECT RAISE(ABORT, 'injected pipeline child release failure');
          END;
        `);
      } finally {
        closeDb(rollbackDb);
      }
      const rolledBack = await activatePipelineBatch(rollback.fixture, rollback.prepared);
      assert.equal(rolledBack.ok, false);
      const rollbackVerificationDb = await openLockDb(tempDir);
      try {
        rollbackVerificationDb.exec("DROP TRIGGER pipeline_atomic_rollback_injected");
        assert.equal(rollbackVerificationDb.prepare(
          "SELECT COUNT(*) AS count FROM opencode_jobs WHERE job_id IN (?, ?)"
        ).get(...rollback.prepared.map((record) => record.jobId)).count, 0);
        assert.equal(rollbackVerificationDb.prepare(
          "SELECT COUNT(*) AS count FROM opencode_pipeline_children WHERE pipeline_id = ?"
        ).get(rollback.fixture.pipelineId).count, 0);
        const rolledBackPipeline = rollbackVerificationDb.prepare(`
          SELECT status, expected_child_count, batch_state FROM opencode_pipelines WHERE pipeline_id = ?
        `).get(rollback.fixture.pipelineId);
        assert.equal(rolledBackPipeline.status, "planned");
        assert.equal(rolledBackPipeline.expected_child_count, 0);
        assert.equal(rolledBackPipeline.batch_state, "unstarted");
        rollbackVerificationDb.prepare("DELETE FROM opencode_pipelines WHERE pipeline_id IN (?, ?)")
          .run(atomic.fixture.pipelineId, rollback.fixture.pipelineId);
        rollbackVerificationDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?)")
          .run(...atomic.prepared.map((record) => record.jobId));
        rollbackVerificationDb.prepare("DELETE FROM opencode_pipelines WHERE pipeline_id = ?")
          .run(propagation.fixture.pipelineId);
        rollbackVerificationDb.prepare("DELETE FROM opencode_jobs WHERE job_id IN (?, ?)")
          .run(...propagation.prepared.map((record) => record.jobId));
      } finally {
        closeDb(rollbackVerificationDb);
      }
      for (const child of atomic.prepared) QUEUE_JOBS.delete(child.jobId);
      for (const child of propagation.prepared) QUEUE_JOBS.delete(child.jobId);
      PIPELINE_RUNS.delete(atomic.fixture.pipelineId);
      PIPELINE_RUNS.delete(propagation.fixture.pipelineId);
      PIPELINE_RUNS.delete(rollback.fixture.pipelineId);
    } finally {
      selfTestHooks.queueModeOverride = previousAtomicPipelineMode;
    }

    const persistenceOrderRecord = {
      pipelineId: "pipeline-persistence-order",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      errors: [],
    };
    await persistPipelineRecord(persistenceOrderRecord);
    let releaseFirstPipelineWrite = null;
    let markFirstPipelineWriteStarted = null;
    const firstPipelineWriteStarted = new Promise((resolve) => {
      markFirstPipelineWriteStarted = resolve;
    });
    const firstPipelineWriteRelease = new Promise((resolve) => {
      releaseFirstPipelineWrite = resolve;
    });
    const observedPipelineWrites = [];
    const orderedPipelineWrites = [];
    try {
      selfTestHooks.pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId !== persistenceOrderRecord.pipelineId) return;
        observedPipelineWrites.push(snapshot.status);
        if (snapshot.status === "running") {
          markFirstPipelineWriteStarted();
          await firstPipelineWriteRelease;
        }
      };
      orderedPipelineWrites.push(updatePipelineRecord(persistenceOrderRecord, { status: "running" }));
      await firstPipelineWriteStarted;
      orderedPipelineWrites.push(updatePipelineRecord(persistenceOrderRecord, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(observedPipelineWrites, ["running"]);
      releaseFirstPipelineWrite();
      await Promise.all(orderedPipelineWrites);
      assert.deepEqual(observedPipelineWrites, ["running", "completed"]);
      const orderedPersistedPipeline = await readPersistedPipelineRecord(persistenceOrderRecord.pipelineId, tempDir);
      assert.equal(orderedPersistedPipeline.status, "completed");
    } finally {
      releaseFirstPipelineWrite?.();
      await Promise.allSettled(orderedPipelineWrites);
      selfTestHooks.pipelinePersistenceTestHook = null;
    }

    const crossProcessPipelineRecord = {
      pipelineId: "pipeline-cross-process-cas",
      cwd: tempDir,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      errors: [],
    };
    await persistPipelineRecord(crossProcessPipelineRecord);
    const pipelineWriterA = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    const pipelineWriterB = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    await updatePipelineRecord(pipelineWriterA, { status: "running" });
    await assert.rejects(
      updatePipelineRecord(pipelineWriterB, { status: "completed", finishedAt: new Date().toISOString() }),
      (error) => error?.errorType === "pipeline_concurrent_update"
    );
    assert.equal(pipelineWriterB.status, "running");
    assert.equal(pipelineWriterB.revision, pipelineWriterA.revision);
    const pipelineCasPersisted = await readPersistedPipelineRecord(crossProcessPipelineRecord.pipelineId, tempDir);
    assert.equal(pipelineCasPersisted.status, "running");
    assert.equal(pipelineCasPersisted.revision, 1);

    const persistedPipelinePlan = createPipelinePlan({
      name: "persisted-pipeline",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [
        {
          agent: "builder",
          task: "Edit allowed file.",
          cwd: tempDir,
          write: true,
          lockedPaths: ["src/allowed.txt"],
          allowedEdits: ["src/allowed.txt"],
          scopeContract: writeScope(["src/allowed.txt"]),
        },
        {
          agent: "debugger",
          task: "Edit api file.",
          cwd: tempDir,
          write: true,
          lockedPaths: ["src/api.txt"],
          allowedEdits: ["src/api.txt"],
          scopeContract: writeScope(["src/api.txt"]),
        },
      ],
    });
    assert.equal(persistedPipelinePlan.ok, true, JSON.stringify(persistedPipelinePlan, null, 2));
    await persistPipelineRecord(persistedPipelinePlan.record);
    const restoredPipeline = await readPersistedPipelineRecord(persistedPipelinePlan.record.pipelineId, tempDir);
    assert.equal(restoredPipeline.pipelineId, persistedPipelinePlan.record.pipelineId);
    assert.equal(restoredPipeline.status, "planned");
    const pipelineFinalizationWriter = await acquireHardLock({
      owner: "codex", agent: "builder", cwd: tempDir, lockType: "write", paths: ["src/allowed.txt"],
    });
    assert.equal(pipelineFinalizationWriter.ok, true);
    const blockedPipelineFinalization = await finalizePipelineRecord(persistedPipelinePlan.record, { skipReviewers: true, dryRun: true });
    assert.equal(blockedPipelineFinalization.ok, false);
    assert.equal(blockedPipelineFinalization.errorType, "pipeline_finalization_lock_conflict");
    await releaseHardLock(pipelineFinalizationWriter.lock.id, pipelineFinalizationWriter.lock.token, pipelineFinalizationWriter.lock.paths, tempDir);
    const pendingFinalize = await finalizePipelineRecord(persistedPipelinePlan.record, { skipReviewers: true, dryRun: true });
    assert.equal(pendingFinalize.ok, false);
    assert.equal(pendingFinalize.errorType, "pipeline_pending_integrations");
    await updatePipelineRecord(persistedPipelinePlan.record, {
      status: "awaiting_finalization",
      integrationQueue: persistedPipelinePlan.record.integrationQueue.map((item) => ({ ...item, status: "integrated" })),
    });
    const finalizedPipeline = await finalizePipelineRecord(persistedPipelinePlan.record, { skipReviewers: true });
    assert.equal(finalizedPipeline.ok, true);
    assert.equal(persistedPipelinePlan.record.status, "completed");
    assert.equal(persistedPipelinePlan.record.finalValidationResult.status, "passed");
    const durablyFinalizedPipeline = await readPersistedPipelineRecord(persistedPipelinePlan.record.pipelineId, tempDir);
    assert.equal(durablyFinalizedPipeline.status, "completed");
    assert.ok(durablyFinalizedPipeline.events.some((event) => event.type === "finalization_completed"));

    const finalValidationCleanupCandidate = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-final-validation-mutation",
    });
    assert.equal(finalValidationCleanupCandidate.ok, true, JSON.stringify(finalValidationCleanupCandidate, null, 2));
    const finalValidationCleanupIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: finalValidationCleanupCandidate.path,
      sourceBaseCommit: finalValidationCleanupCandidate.baseCommit,
    });
    assert.equal(finalValidationCleanupIdentity.ok, true);
    const mutationPipelineRecord = {
      ...structuredClone(persistedPipelinePlan.record),
      pipelineId: "pipeline-final-validation-mutation",
      revision: 0,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      status: "awaiting_finalization",
      queueJobIds: [],
      finalValidationCommand: "git status --short",
      finalValidationSource: "caller",
      finalValidationSpec: null,
      finalValidationResult: null,
      reviewerJob: null,
      testerJob: null,
      reviewerResult: null,
      testerResult: null,
      sourceCleanupResults: [],
      events: [],
      errors: [],
      finishedAt: "",
      integrationQueue: [{
        status: "integrated",
        cleanupRequested: true,
        worktreePath: finalValidationCleanupCandidate.path,
        branch: finalValidationCleanupCandidate.branch,
        sourceBaseCommit: finalValidationCleanupIdentity.sourceBaseCommit,
        patchSha256: finalValidationCleanupIdentity.patchSha256,
        sourceStateSha256: finalValidationCleanupIdentity.sourceStateSha256,
      }],
    };
    await persistPipelineRecord(mutationPipelineRecord);
    const mutationPipelineFinalized = await finalizePipelineRecord(mutationPipelineRecord, {
      skipReviewers: true,
      beforeFinalValidationHook: async ({ cwd: validationCwd }) => {
        await writeFile(path.join(validationCwd, "src", "final-validation-extra.txt"), "unreviewed validator output\n", "utf8");
      },
    });
    assert.equal(mutationPipelineFinalized.ok, false);
    assert.equal(mutationPipelineFinalized.errorType, "final_validation_mutated_workspace");
    assert.deepEqual(mutationPipelineRecord.finalValidationResult.mutationFiles, ["src/final-validation-extra.txt"]);
    assert.equal((await lstat(finalValidationCleanupCandidate.path)).isDirectory(), true);
    assert.deepEqual(mutationPipelineRecord.sourceCleanupResults, []);
    await rm(path.join(tempDir, "src", "final-validation-extra.txt"), { force: true });
    assert.equal((await cleanupWorktree(finalValidationCleanupCandidate, "always", true)).cleanup, "success");

    const cleanupFaultRecord = (pipelineId, worktree, identity) => ({
      ...structuredClone(persistedPipelinePlan.record),
      pipelineId,
      revision: 0,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      status: "awaiting_finalization",
      queueJobIds: [],
      finalValidationCommand: "git status --short",
      finalValidationSource: "caller",
      finalValidationSpec: null,
      finalValidationResult: null,
      reviewerJob: null,
      testerJob: null,
      reviewerResult: null,
      testerResult: null,
      sourceCleanupResults: [],
      events: [],
      errors: [],
      finishedAt: "",
      integrationQueue: [{
        status: "integrated",
        cleanupRequested: true,
        worktreePath: worktree.path,
        branch: worktree.branch,
        sourceBaseCommit: identity.sourceBaseCommit,
        patchSha256: identity.patchSha256,
        sourceStateSha256: identity.sourceStateSha256,
      }],
    });

    const authorizationFaultWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-cleanup-authorization-fault",
    });
    assert.equal(authorizationFaultWorktree.ok, true, JSON.stringify(authorizationFaultWorktree, null, 2));
    const authorizationFaultIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: authorizationFaultWorktree.path,
      sourceBaseCommit: authorizationFaultWorktree.baseCommit,
    });
    assert.equal(authorizationFaultIdentity.ok, true);
    const authorizationFaultPipeline = cleanupFaultRecord(
      "pipeline-cleanup-authorization-fault",
      authorizationFaultWorktree,
      authorizationFaultIdentity
    );
    await persistPipelineRecord(authorizationFaultPipeline);
    try {
      selfTestHooks.pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId === authorizationFaultPipeline.pipelineId
          && snapshot.events.some((event) => event.type === "source_cleanup_authorized")) {
          throw new Error("injected cleanup authorization persistence failure");
        }
      };
      await assert.rejects(
        finalizePipelineRecord(authorizationFaultPipeline, { skipReviewers: true }),
        /injected cleanup authorization persistence failure/
      );
    } finally {
      selfTestHooks.pipelinePersistenceTestHook = null;
    }
    assert.equal((await lstat(authorizationFaultWorktree.path)).isDirectory(), true);
    const authorizationFaultPersisted = await readPersistedPipelineRecord(authorizationFaultPipeline.pipelineId, tempDir);
    assert.equal(authorizationFaultPersisted.status, "finalizing");
    assert.equal(authorizationFaultPersisted.events.some((event) => event.type === "source_cleanup_authorized"), false);
    assert.deepEqual(authorizationFaultPersisted.sourceCleanupResults, []);
    assert.equal((await cleanupWorktree(authorizationFaultWorktree, "always", true)).cleanup, "success");

    const terminalFaultWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "pipeline-terminal-persistence-fault",
    });
    assert.equal(terminalFaultWorktree.ok, true, JSON.stringify(terminalFaultWorktree, null, 2));
    const terminalFaultIdentity = await collectIntegrationPatch({
      cwd: tempDir,
      worktreePath: terminalFaultWorktree.path,
      sourceBaseCommit: terminalFaultWorktree.baseCommit,
    });
    assert.equal(terminalFaultIdentity.ok, true);
    const terminalFaultPipeline = cleanupFaultRecord(
      "pipeline-terminal-persistence-fault",
      terminalFaultWorktree,
      terminalFaultIdentity
    );
    await persistPipelineRecord(terminalFaultPipeline);
    try {
      selfTestHooks.pipelinePersistenceTestHook = async (snapshot) => {
        if (snapshot.pipelineId === terminalFaultPipeline.pipelineId && snapshot.status === "completed") {
          throw new Error("injected terminal pipeline persistence failure");
        }
      };
      await assert.rejects(
        finalizePipelineRecord(terminalFaultPipeline, { skipReviewers: true }),
        /injected terminal pipeline persistence failure/
      );
    } finally {
      selfTestHooks.pipelinePersistenceTestHook = null;
    }
    await assert.rejects(lstat(terminalFaultWorktree.path), (error) => error?.code === "ENOENT");
    assert.equal(terminalFaultPipeline.status, "cleanup_pending");
    assert.equal(terminalFaultPipeline.cleanupPending, true);
    assert.equal(terminalFaultPipeline.cleanupState, "authorized");
    const terminalFaultPersisted = await readPersistedPipelineRecord(terminalFaultPipeline.pipelineId, tempDir);
    assert.equal(terminalFaultPersisted.status, "cleanup_pending");
    assert.equal(terminalFaultPersisted.cleanupPending, true);
    assert.equal(terminalFaultPersisted.events.some((event) => event.type === "source_cleanup_authorized"), true);
    assert.equal(terminalFaultPersisted.events.some((event) => event.type === "finalization_completed"), false);
    const recoveredTerminalCleanup = await resumeAuthorizedPipelineCleanup(terminalFaultPipeline);
    assert.equal(recoveredTerminalCleanup.ok, true);
    assert.equal(terminalFaultPipeline.status, "completed");
    assert.equal(terminalFaultPipeline.cleanupPending, false);
    assert.equal(terminalFaultPipeline.sourceCleanupResults[0].reason, "recovered_already_removed");

    await mkdir(path.join(tempDir, ".mcp"), { recursive: true });
    const policyContent = JSON.stringify({
        version: 1,
        owners: {
          "src/allowed.txt": "builder",
          "src/blocked.txt": "debugger",
        },
        sharedFiles: ["src/forbidden.txt"],
        serialOnly: ["README.md"],
        finalValidationCommand: "git status --short",
      });
    await writeFile(path.join(tempDir, ".mcp", "agent-policy.json"), policyContent, "utf8");
    const policySha256 = createHash("sha256").update(policyContent).digest("hex");
    const untrustedPolicy = await loadProjectAgentPolicy(tempDir);
    assert.equal(untrustedPolicy.ok, false);
    assert.equal(untrustedPolicy.errorType, "policy_validation_command_untrusted");
    const callerHashOnlyPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/agent-policy.json", policySha256);
    assert.equal(callerHashOnlyPolicy.ok, false);
    assert.equal(callerHashOnlyPolicy.errorType, "policy_validation_command_untrusted");
    const testGitExecutable = await resolveValidationExecutable("git");
    const loadedPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/agent-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(loadedPolicy.ok, true);
    const copiedPolicyRoot = path.join(tempDir, "copied-policy-root");
    await mkdir(path.join(copiedPolicyRoot, ".mcp"), { recursive: true });
    await writeFile(path.join(copiedPolicyRoot, ".mcp", "agent-policy.json"), policyContent, "utf8");
    const copiedRootPolicy = await loadProjectAgentPolicy(copiedPolicyRoot, ".mcp/agent-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(copiedRootPolicy.ok, false);
    assert.equal(copiedRootPolicy.errorType, "policy_validation_command_untrusted");
    await rm(copiedPolicyRoot, { recursive: true, force: true });
    await writeFile(path.join(tempDir, ".mcp", "copied-policy.json"), policyContent, "utf8");
    const copiedPathPolicy = await loadProjectAgentPolicy(tempDir, ".mcp/copied-policy.json", {
      operatorTrustedPolicySha256: policySha256,
      operatorTrustedPolicyRoot: tempDir,
      operatorTrustedPolicyPath: ".mcp/agent-policy.json",
      operatorExecutableHashes: [testGitExecutable.sha256],
    });
    assert.equal(copiedPathPolicy.ok, false);
    assert.equal(copiedPathPolicy.errorType, "policy_validation_command_untrusted");
    await rm(path.join(tempDir, ".mcp", "copied-policy.json"), { force: true });
    assert.throws(() => normalizeProjectAgentPolicy({ unexpected: true }), z.ZodError);
    const weakPolicyPath = path.join(tempDir, ".mcp", "weak-policy.json");
    const weakPolicyContent = JSON.stringify({ version: 1, requiresWorktrees: false });
    await writeFile(weakPolicyPath, weakPolicyContent, "utf8");
    const weakPolicy = await loadProjectAgentPolicy(
      tempDir,
      ".mcp/weak-policy.json",
      { operatorTrustedPolicySha256: createHash("sha256").update(weakPolicyContent).digest("hex") }
    );
    assert.equal(weakPolicy.ok, false);
    assert.equal(weakPolicy.errorType, "policy_safety_weakening");
    await rm(weakPolicyPath, { force: true });
    assert.ok(loadedPolicy.policy.sharedFiles.includes("src/forbidden.txt"));
    assert.ok(loadedPolicy.policy.forbiddenEdits.includes(".env"));
    const untrustedOwnersOnlyPolicy = normalizeProjectAgentPolicy({
      version: 1,
      owners: { "src/allowed.txt": "builder" },
    });
    const untrustedOwnershipPlan = createPipelinePlan({
      name: "untrusted-policy-cannot-grant-write-scope",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [
        { agent: "builder", task: "Attempt write authority inferred only from untrusted policy.", write: true },
        { agent: "reviewer", task: "Review." },
      ],
      policy: untrustedOwnersOnlyPolicy,
      policyTrustedForAuthority: false,
    });
    assert.equal(untrustedOwnershipPlan.ok, false);
    assert.equal(untrustedOwnershipPlan.errorType, "missing_scope_contract");
    const policyPipeline = createPipelinePlan({
      name: "policy-pipeline",
      cwd: tempDir,
      requiresWorktrees: false,
      jobs: [
        {
          agent: "builder",
          task: "Edit owned file inferred from policy.",
          write: true,
        },
        {
          agent: "debugger",
          task: "Edit debugger-owned file inferred from policy.",
          write: true,
        },
      ],
      policy: loadedPolicy.policy,
      policyPath: ".mcp/agent-policy.json",
      policyTrustedForAuthority: loadedPolicy.trustedForAuthority,
    });
    assert.equal(policyPipeline.ok, true, JSON.stringify(policyPipeline, null, 2));
    assert.deepEqual(policyPipeline.record.jobs[0].allowedEdits, ["src/allowed.txt"]);
    assert.deepEqual(policyPipeline.record.jobs[1].allowedEdits, ["src/blocked.txt"]);
    assert.ok(policyPipeline.record.jobs[0].forbiddenEdits.includes("src/blocked.txt"));
    assert.equal(policyPipeline.record.finalValidationCommand, "git status --short");
    assert.equal(policyPipeline.record.requiresWorktrees, false);

    const policyOwnerViolation = createPipelinePlan({
      name: "policy-owner-violation",
      cwd: tempDir,
      requiresWorktrees: false,
      finalValidationCommand: "git status --short",
      jobs: [{
        agent: "builder",
        task: "Try to edit debugger-owned file.",
        write: true,
        lockedPaths: ["src/blocked.txt"],
        allowedEdits: ["src/blocked.txt"],
        scopeContract: writeScope(["src/blocked.txt"]),
      },
      {
        agent: "reviewer",
        task: "Review the policy violation.",
      }],
      policy: loadedPolicy.policy,
      policyTrustedForAuthority: loadedPolicy.trustedForAuthority,
    });
    assert.equal(policyOwnerViolation.ok, false);
    assert.equal(policyOwnerViolation.errorType, "parallel_plan_rejected");
    assert.equal((await runCommand("git", ["add", "--", ".mcp/agent-policy.json"], tempDir, 1000 * 15)).exitCode, 0);
    const policyCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add agent policy"], tempDir, 1000 * 15);
    assert.equal(policyCommit.exitCode, 0);

    assert.equal((await runCommand(
      "git",
      ["config", "--local", "filter.bridge-unsafe.smudge", "node malicious-filter.cjs"],
      tempDir,
      1000 * 15
    )).exitCode, 0);
    const unsafeGitConfigWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "git-config-isolation-self-test",
    });
    assert.equal(unsafeGitConfigWorktree.ok, false);
    assert.equal(unsafeGitConfigWorktree.errorType, "git_repository_config_unsafe");
    assert.ok(unsafeGitConfigWorktree.unsafeKeys.includes("filter.bridge-unsafe.smudge"));
    assert.equal((await runCommand(
      "git",
      ["config", "--local", "--unset-all", "filter.bridge-unsafe.smudge"],
      tempDir,
      1000 * 15
    )).exitCode, 0);

    const hookMarker = path.join(tempDir, ".git", "bridge-hook-executed");
    const hookPath = path.join(tempDir, ".git", "hooks", "post-checkout");
    const shellHookMarker = hookMarker.replace(/\\/g, "/").replace(/'/g, "'\\''");
    await writeFile(hookPath, [
      "#!/bin/sh",
      `printf '%s' "\${BRIDGE_TEST_SECRET:-missing}" > '${shellHookMarker}'`,
    ].join("\n"), "utf8");
    await chmod(hookPath, 0o755);
    process.env.BRIDGE_TEST_SECRET = "bridge-secret-must-not-reach-git";
    try {
      const hookProtectedWorktree = await createWorktreeForJob({
        cwd: tempDir,
        agent: "builder",
        jobId: "git-hook-isolation-self-test",
      });
      assert.equal(hookProtectedWorktree.ok, true, JSON.stringify(hookProtectedWorktree, null, 2));
      assert.equal(existsSync(hookMarker), false, "Bridge-owned Git must not execute repository hooks.");
      assert.equal((await inspectSourceCheckpointState(hookProtectedWorktree.path)).ok, true);
      assert.equal((await cleanupWorktree(hookProtectedWorktree, "always", true)).cleanup, "success");
    } finally {
      delete process.env.BRIDGE_TEST_SECRET;
      await rm(hookMarker, { force: true });
      await rm(hookPath, { force: true });
    }

    const branchRaceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "branch-cleanup-cas-self-test",
    });
    assert.equal(branchRaceWorktree.ok, true, JSON.stringify(branchRaceWorktree, null, 2));
    const replacementBranchOid = (await runCommand(
      "git",
      ["rev-parse", "--verify", "--end-of-options", "HEAD^"],
      tempDir,
      1000 * 15
    )).stdout.trim();
    try {
      selfTestHooks.worktreeCleanupTestHook = async ({ branchRef, expectedBranchOid }) => {
        const replaced = await runCommand(
          "git",
          ["update-ref", branchRef, replacementBranchOid, expectedBranchOid],
          tempDir,
          1000 * 15
        );
        assert.equal(replaced.exitCode, 0, replaced.stderr);
      };
      const branchRaceCleanup = await cleanupWorktree(branchRaceWorktree, "always", true);
      assert.equal(branchRaceCleanup.cleanup, "partial");
      assert.equal((await runCommand(
        "git",
        ["show-ref", "--hash", "--verify", `refs/heads/${branchRaceWorktree.branch}`],
        tempDir,
        1000 * 15
      )).stdout.trim(), replacementBranchOid);
    } finally {
      selfTestHooks.worktreeCleanupTestHook = null;
      await runCommand(
        "git",
        ["update-ref", "-d", `refs/heads/${branchRaceWorktree.branch}`, replacementBranchOid],
        tempDir,
        1000 * 15
      );
    }

    selfTestProgress("integration/receipts");
    const worktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "self-test",
    });
    assert.equal(worktree.ok, true);
    const registeredWorktreeDb = await openLockDb(tempDir);
    try {
      const registered = registeredWorktreeDb.prepare(`
        SELECT status FROM worktree_artifacts WHERE worktree_path = ? AND cwd = ?
      `).get(path.resolve(worktree.path), path.resolve(tempDir));
      assert.equal(registered?.status, "retained");
    } finally {
      closeDb(registeredWorktreeDb);
    }
    const worktreePreserve = await cleanupWorktree(worktree, "never", false);
    assert.equal(worktreePreserve.cleanup, "skipped");
    await writeFile(path.join(worktree.path, "src", "allowed.txt"), "worktree allowed\n", "utf8");
    let worktreeChangedFiles = await gitChangedFiles(worktree.path);
    const worktreePlan = validateSingleLockPlan({
      agent: "builder",
      task: "Validate worktree allowed file.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    worktreePlan.cwd = tempDir;
    let worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.deepEqual(worktreeValidation.disallowedFiles, []);
    await writeFile(path.join(worktree.path, "src", "forbidden.txt"), "worktree forbidden\n", "utf8");
    worktreeChangedFiles = await gitChangedFiles(worktree.path);
    worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.equal(changedFileValidationErrorType(worktreeValidation), "forbidden_file_changed");
    assert.ok(worktreeValidation.disallowedFiles.includes("src/forbidden.txt"));
    const worktreeDiff = await collectWorktreeDiff(worktree);
    assert.ok(worktreeDiff.changedFiles.includes("src/allowed.txt"));
    const worktreeCleanup = await cleanupWorktree(worktree, "always", true);
    assert.notEqual(worktreeCleanup.cleanup, "failed");
    const cleanedWorktreeDb = await openLockDb(tempDir);
    try {
      const cleaned = cleanedWorktreeDb.prepare(`
        SELECT status FROM worktree_artifacts WHERE worktree_path = ? AND cwd = ?
      `).get(path.resolve(worktree.path), path.resolve(tempDir));
      assert.ok(["cleaned", "cleaned_branch_retained"].includes(cleaned?.status));
    } finally {
      closeDb(cleanedWorktreeDb);
    }

    const ignoredSourceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-ignored-source",
    });
    assert.equal(ignoredSourceWorktree.ok, true, JSON.stringify(ignoredSourceWorktree, null, 2));
    await writeFile(path.join(ignoredSourceWorktree.path, "src", "allowed.txt"), "reviewable tracked output\n", "utf8");
    await writeFile(path.join(ignoredSourceWorktree.path, "ignored.log"), "unique ignored recovery bytes\n", "utf8");
    const ignoredSourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: ignoredSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(ignoredSourcePreview.ok, false);
    assert.equal(ignoredSourcePreview.errorType, "integration_source_unrepresentable");
    assert.deepEqual(ignoredSourcePreview.ignoredFiles, ["ignored.log"]);
    assert.equal(await readFile(path.join(ignoredSourceWorktree.path, "ignored.log"), "utf8"), "unique ignored recovery bytes\n");
    assert.equal((await lstat(ignoredSourceWorktree.path)).isDirectory(), true);
    assert.equal((await cleanupWorktree(ignoredSourceWorktree, "always", true)).cleanup, "success");

    const subdirectorySourceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-subdirectory-source",
    });
    assert.equal(subdirectorySourceWorktree.ok, true, JSON.stringify(subdirectorySourceWorktree, null, 2));
    await writeFile(path.join(subdirectorySourceWorktree.path, "src", "allowed.txt"), "nested-only partial patch attempt\n", "utf8");
    const subdirectorySourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: path.join(subdirectorySourceWorktree.path, "src"),
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(subdirectorySourcePreview.ok, false);
    assert.equal(subdirectorySourcePreview.errorType, "integration_source_invalid");
    assert.match(subdirectorySourcePreview.error, /canonical Git worktree root/i);
    assert.equal((await cleanupWorktree(subdirectorySourceWorktree, "always", true)).cleanup, "success");

    const sourceIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-source-index-identity",
    });
    assert.equal(sourceIndexWorktree.ok, true, JSON.stringify(sourceIndexWorktree, null, 2));
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], sourceIndexWorktree.path, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source worktree B\n", "utf8");
    const sourceIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: sourceIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(sourceIndexPreview.ok, true, JSON.stringify(sourceIndexPreview, null, 2));
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source staged C\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], sourceIndexWorktree.path, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(sourceIndexWorktree.path, "src", "allowed.txt"), "source worktree B\n", "utf8");
    const sourceIndexChanged = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: sourceIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: sourceIndexPreview.previewReceipt,
    });
    assert.equal(sourceIndexChanged.ok, false);
    assert.equal(sourceIndexChanged.errorType, "integration_preview_stale");
    assert.match(sourceIndexChanged.error, /sourceStateSha256/i);
    assert.equal((await cleanupWorktree(sourceIndexWorktree, "always", true)).cleanup, "success");

    const integrationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-pass",
    });
    assert.equal(integrationWorktree.ok, true);
    await writeFile(path.join(integrationWorktree.path, "src", "allowed.txt"), "integrated allowed\n", "utf8");
    const integrationBlocker = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["src/api.txt"],
    });
    assert.equal(integrationBlocker.ok, true);
    const integrationWhileWriterActive = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      reviewed: true,
    });
    assert.equal(integrationWhileWriterActive.ok, false);
    assert.equal(integrationWhileWriterActive.errorType, "integration_lock_conflict");
    await releaseHardLock(
      integrationBlocker.lock.id,
      integrationBlocker.lock.token,
      integrationBlocker.lock.paths,
      tempDir
    );
    const integrationDryRun = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      dryRun: true,
    });
    assert.equal(integrationDryRun.ok, true);
    assert.equal(integrationDryRun.status, "dry_run_passed");
    assert.deepEqual(integrationDryRun.changedFiles, ["src/allowed.txt"]);
    const integrationApplied = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git status --short",
      reviewed: true,
      previewReceipt: integrationDryRun.previewReceipt,
    });
    assert.equal(integrationApplied.ok, true, JSON.stringify(integrationApplied, null, 2));
    assert.equal(integrationApplied.status, "applied");
    assert.match(integrationApplied.operationId || "", /^integration-[0-9]+-[a-f0-9]{16}$/);
    assert.equal((await readIntegrationOperationSummary(tempDir, integrationApplied.operationId))?.status, "committed");
    const committedJournalDb = await openLockDb(tempDir);
    try {
      const committedEvidence = committedJournalDb.prepare(`
        SELECT pre_encrypted, post_encrypted
        FROM integration_operation_files
        WHERE operation_id = ? AND path = ?
      `).get(integrationApplied.operationId, "src/allowed.txt");
      assert.ok(committedEvidence?.pre_encrypted);
      assert.ok(committedEvidence?.post_encrypted);
      assert.doesNotMatch(committedEvidence.pre_encrypted, /integrated allowed/i);
      assert.doesNotMatch(committedEvidence.post_encrypted, /integrated allowed/i);
    } finally {
      closeDb(committedJournalDb);
    }
    assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8")).replace(/\r\n/g, "\n"), "integrated allowed\n");
    assert.deepEqual(
      (await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.split(/\r?\n/).filter((line) => line.trim()),
      [" M src/allowed.txt"]
    );
    const journalRecoveryPath = path.join(tempDir, "src", "journal-recovery.txt");
    const journalRecoveryPreimage = "journal encrypted preimage sentinel\n";
    const journalRecoveryPostimage = "journal simulated crash postimage\n";
    await writeFile(journalRecoveryPath, journalRecoveryPreimage, "utf8");
    const journalRecoveryTargetState = await captureIntegrationTargetState(tempDir);
    assert.equal(journalRecoveryTargetState.ok, true);
    const journalRecoveryMode = (await lstat(journalRecoveryPath)).mode & 0o111;
    const journalRecoveryPrepared = await prepareIntegrationOperation({
      cwd: tempDir,
      targetState: journalRecoveryTargetState,
      patch: {
        changedFiles: ["src/journal-recovery.txt"],
        patchSha256: createHash("sha256").update(journalRecoveryPostimage).digest("hex"),
        sourceBaseCommit: journalRecoveryTargetState.targetHead,
        sourceStateSha256: createHash("sha256").update("journal recovery source").digest("hex"),
      },
      contractSha256: createHash("sha256").update("journal recovery contract").digest("hex"),
      expectedPostSnapshot: new Map([[
        "src/journal-recovery.txt",
        `file:${journalRecoveryMode}:${createHash("sha256").update(journalRecoveryPostimage).digest("hex")}`,
      ]]),
    });
    await transitionIntegrationOperation(tempDir, journalRecoveryPrepared.operationId, "prepared", "applying", {
      outcome: "self_test_simulated_crash",
    });
    await writeFile(journalRecoveryPath, journalRecoveryPostimage, "utf8");
    const blockedByJournal = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["src/journal-recovery.txt"],
    });
    assert.equal(blockedByJournal.ok, false);
    assert.equal(blockedByJournal.errorType, "integration_recovery_pending");
    assert.equal(blockedByJournal.operationId, journalRecoveryPrepared.operationId);
    const readDuringRecovery = await acquireHardLock({
      owner: "codex",
      agent: "reviewer",
      cwd: tempDir,
      lockType: "read",
      paths: ["src/journal-recovery.txt"],
    });
    assert.equal(readDuringRecovery.ok, true);
    await releaseHardLock(readDuringRecovery.lock.id, readDuringRecovery.lock.token, readDuringRecovery.lock.paths, tempDir);
    const journalRecovery = await recoverIntegrationOperationsWhileLocked(tempDir, {
      operationId: journalRecoveryPrepared.operationId,
    });
    assert.equal(journalRecovery.ok, true, JSON.stringify(journalRecovery, null, 2));
    assert.equal(journalRecovery.recovered[0]?.status, "rolled_back");
    assert.equal(await readFile(journalRecoveryPath, "utf8"), journalRecoveryPreimage);
    assert.equal((await readIntegrationOperationSummary(tempDir, journalRecoveryPrepared.operationId))?.status, "rolled_back");
    await rm(journalRecoveryPath, { force: true });
    await writeFile(path.join(tempDir, "src", "api.txt"), "changed between integration and cleanup\n", "utf8");
    assert.match(
      await integrationCleanupTargetStateError(tempDir, integrationApplied.integratedTargetStateSha256),
      /target changed after reviewed integration/i
    );
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal(await integrationCleanupTargetStateError(tempDir, integrationApplied.integratedTargetStateSha256), "");
    assert.equal((await cleanupWorktree(integrationWorktree, "always", true)).cleanup, "success");

    await runCommand("git", ["add", "."], tempDir, 1000 * 15);
    const integrationCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "integrated allowed"], tempDir, 1000 * 15);
    assert.equal(integrationCommit.exitCode, 0);

    const cleanupRaceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-cleanup-race",
    });
    assert.equal(cleanupRaceWorktree.ok, true, JSON.stringify(cleanupRaceWorktree, null, 2));
    await writeFile(path.join(cleanupRaceWorktree.path, "src", "allowed.txt"), "cleanup race integrated bytes\n", "utf8");
    const cleanupRacePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: cleanupRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(cleanupRacePreview.ok, true, JSON.stringify(cleanupRacePreview, null, 2));
    const cleanupRaceResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: cleanupRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: cleanupRacePreview.previewReceipt,
      cleanupAfterSuccess: true,
      beforeCleanupHook: async ({ targetCwd }) => {
        const competingLock = await acquireHardLock({
          owner: "codex",
          agent: "builder",
          cwd: targetCwd,
          lockType: "write",
          paths: ["src/allowed.txt"],
        });
        assert.equal(competingLock.ok, false, "The serial integration lease must remain held through cleanup authorization and deletion.");
        assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).exitCode, 0);
      },
    });
    assert.equal(cleanupRaceResult.ok, true, JSON.stringify(cleanupRaceResult, null, 2));
    assert.equal(cleanupRaceResult.sourceCleanup.cleanup, "retained_for_review");
    assert.equal(cleanupRaceResult.sourceCleanup.reason, "integration_target_changed_before_cleanup");
    assert.equal((await lstat(cleanupRaceWorktree.path)).isDirectory(), true);
    assert.equal((await cleanupWorktree(cleanupRaceWorktree, "always", true)).cleanup, "success");

    const targetIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-target-index-identity",
    });
    assert.equal(targetIndexWorktree.ok, true, JSON.stringify(targetIndexWorktree, null, 2));
    await writeFile(path.join(targetIndexWorktree.path, "src", "allowed.txt"), "target index source patch\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "target staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target worktree B\n", "utf8");
    const targetIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: targetIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      dryRun: true,
    });
    assert.equal(targetIndexPreview.ok, true, JSON.stringify(targetIndexPreview, null, 2));
    await writeFile(path.join(tempDir, "src", "api.txt"), "target staged C\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target worktree B\n", "utf8");
    const targetIndexChanged = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: targetIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      reviewed: true,
      previewReceipt: targetIndexPreview.previewReceipt,
    });
    assert.equal(targetIndexChanged.ok, false);
    assert.equal(targetIndexChanged.errorType, "integration_preview_stale");
    assert.match(targetIndexChanged.error, /targetStateSha256/i);
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(targetIndexWorktree, "always", true)).cleanup, "success");

    const validationIndexWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-index-identity",
    });
    assert.equal(validationIndexWorktree.ok, true, JSON.stringify(validationIndexWorktree, null, 2));
    await writeFile(path.join(validationIndexWorktree.path, "src", "allowed.txt"), "validation index source patch\n", "utf8");
    await writeFile(path.join(tempDir, "src", "api.txt"), "validation staged A\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await writeFile(path.join(tempDir, "src", "api.txt"), "validation worktree B\n", "utf8");
    const validationIndexBefore = await captureGitIndexIdentity(tempDir);
    assert.equal(validationIndexBefore.ok, true);
    const validationIndexPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      dryRun: true,
    });
    assert.equal(validationIndexPreview.ok, true, JSON.stringify(validationIndexPreview, null, 2));
    const validationIndexResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationIndexWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      allowDirtyTarget: true,
      reviewed: true,
      previewReceipt: validationIndexPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "api.txt"), "validation staged C\n", "utf8");
        assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        await writeFile(path.join(targetCwd, "src", "api.txt"), "validation worktree B\n", "utf8");
      },
    });
    assert.equal(validationIndexResult.ok, false);
    assert.equal(validationIndexResult.errorType, "integration_validation_mutated_unapproved_files", JSON.stringify(validationIndexResult, null, 2));
    assert.equal(validationIndexResult.validationIndexChanged, true);
    const validationIndexAfter = await captureGitIndexIdentity(tempDir);
    assert.equal(validationIndexAfter.ok, true);
    assert.notEqual(validationIndexAfter.indexSha256, validationIndexBefore.indexSha256);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal(await readFile(path.join(tempDir, "src", "api.txt"), "utf8"), "validation worktree B\n");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await clearSelfTestIntegrationQuarantine();
    assert.equal((await cleanupWorktree(validationIndexWorktree, "always", true)).cleanup, "success");

    await writeFile(path.join(tempDir, "src", "delete-me.txt"), "delete rollback sentinel\n", "utf8");
    assert.equal((await runCommand("git", ["add", "--", "src/delete-me.txt"], tempDir, 1000 * 15)).exitCode, 0);
    const deletionFixtureCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add deletion fixture"], tempDir, 1000 * 15);
    assert.equal(deletionFixtureCommit.exitCode, 0, deletionFixtureCommit.stderr);

    const deleteSuccessWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-delete-success" });
    assert.equal(deleteSuccessWorktree.ok, true, JSON.stringify(deleteSuccessWorktree, null, 2));
    await rm(path.join(deleteSuccessWorktree.path, "src", "delete-me.txt"));
    const deleteSuccessPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteSuccessWorktree.path,
      allowedEdits: ["src/delete-me.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(deleteSuccessPreview.ok, true, JSON.stringify(deleteSuccessPreview, null, 2));
    const deleteSuccessIndexBefore = await captureGitIndexIdentity(tempDir);
    const deleteSuccessResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteSuccessWorktree.path,
      allowedEdits: ["src/delete-me.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: deleteSuccessPreview.previewReceipt,
    });
    assert.equal(deleteSuccessResult.ok, true, JSON.stringify(deleteSuccessResult, null, 2));
    await assert.rejects(lstat(path.join(tempDir, "src", "delete-me.txt")), (error) => error?.code === "ENOENT");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, deleteSuccessIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(deleteSuccessWorktree, "always", true)).cleanup, "success");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/delete-me.txt"], tempDir, 1000 * 15)).exitCode, 0);

    const deleteRollbackWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-delete-rollback" });
    assert.equal(deleteRollbackWorktree.ok, true, JSON.stringify(deleteRollbackWorktree, null, 2));
    await rm(path.join(deleteRollbackWorktree.path, "src", "delete-me.txt"));
    await writeFile(path.join(deleteRollbackWorktree.path, "src", "allowed.txt"), "delete rollback validation failure \n", "utf8");
    const deleteRollbackPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteRollbackWorktree.path,
      allowedEdits: ["src/delete-me.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(deleteRollbackPreview.ok, true, JSON.stringify(deleteRollbackPreview, null, 2));
    const deleteRollbackIndexBefore = await captureGitIndexIdentity(tempDir);
    const deleteRollbackResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: deleteRollbackWorktree.path,
      allowedEdits: ["src/delete-me.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: deleteRollbackPreview.previewReceipt,
    });
    assert.equal(deleteRollbackResult.ok, false);
    assert.equal(deleteRollbackResult.errorType, "validation_command_failed", JSON.stringify(deleteRollbackResult, null, 2));
    assert.equal(deleteRollbackResult.rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "delete-me.txt"), "utf8"), "delete rollback sentinel\n");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, deleteRollbackIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(deleteRollbackWorktree, "always", true)).cleanup, "success");

    const createRollbackWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-create-rollback" });
    assert.equal(createRollbackWorktree.ok, true, JSON.stringify(createRollbackWorktree, null, 2));
    await writeFile(path.join(createRollbackWorktree.path, "src", "created-rollback.txt"), "new file validation failure \n", "utf8");
    await writeFile(path.join(createRollbackWorktree.path, "src", "allowed.txt"), "tracked validation failure \n", "utf8");
    const createRollbackPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: createRollbackWorktree.path,
      allowedEdits: ["src/created-rollback.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(createRollbackPreview.ok, true, JSON.stringify(createRollbackPreview, null, 2));
    const createRollbackIndexBefore = await captureGitIndexIdentity(tempDir);
    const createRollbackResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: createRollbackWorktree.path,
      allowedEdits: ["src/created-rollback.txt", "src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: createRollbackPreview.previewReceipt,
    });
    assert.equal(createRollbackResult.ok, false);
    assert.equal(createRollbackResult.errorType, "validation_command_failed");
    assert.equal(createRollbackResult.rollback.rollback, "success");
    await assert.rejects(lstat(path.join(tempDir, "src", "created-rollback.txt")), (error) => error?.code === "ENOENT");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await captureGitIndexIdentity(tempDir)).indexSha256, createRollbackIndexBefore.indexSha256);
    assert.equal((await cleanupWorktree(createRollbackWorktree, "always", true)).cleanup, "success");

    const staleSourceWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-source" });
    assert.equal(staleSourceWorktree.ok, true);
    await writeFile(path.join(staleSourceWorktree.path, "src", "allowed.txt"), "previewed source\n", "utf8");
    const staleSourcePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleSourcePreview.ok, true);
    await writeFile(path.join(staleSourceWorktree.path, "src", "allowed.txt"), "changed after preview\n", "utf8");
    const staleSourceApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleSourceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleSourcePreview.previewReceipt,
    });
    assert.equal(staleSourceApply.ok, false);
    assert.equal(staleSourceApply.errorType, "integration_preview_stale");
    assert.equal((await cleanupWorktree(staleSourceWorktree, "always", true)).cleanup, "success");

    const staleTargetWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-target" });
    assert.equal(staleTargetWorktree.ok, true);
    await writeFile(path.join(staleTargetWorktree.path, "src", "allowed.txt"), "target preview\n", "utf8");
    const staleTargetPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleTargetWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleTargetPreview.ok, true);
    await writeFile(path.join(tempDir, "src", "api.txt"), "target changed after preview\n", "utf8");
    const staleTargetApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleTargetWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleTargetPreview.previewReceipt,
    });
    assert.equal(staleTargetApply.ok, false);
    assert.equal(staleTargetApply.errorType, "integration_preview_stale");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/api.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await cleanupWorktree(staleTargetWorktree, "always", true)).cleanup, "success");

    const staleIgnoredWorktree = await createWorktreeForJob({ cwd: tempDir, agent: "builder", jobId: "integration-stale-ignored-target" });
    assert.equal(staleIgnoredWorktree.ok, true);
    await writeFile(path.join(staleIgnoredWorktree.path, "src", "allowed.txt"), "ignored target preview\n", "utf8");
    const staleIgnoredPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleIgnoredWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(staleIgnoredPreview.ok, true, JSON.stringify(staleIgnoredPreview, null, 2));
    await writeFile(path.join(tempDir, "ignored.log"), "changed ignored target after preview\n", "utf8");
    const staleIgnoredApply = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: staleIgnoredWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: staleIgnoredPreview.previewReceipt,
    });
    assert.equal(staleIgnoredApply.ok, false);
    assert.equal(staleIgnoredApply.errorType, "integration_preview_stale");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    await writeFile(path.join(tempDir, "ignored.log"), "second\n", "utf8");
    assert.equal((await cleanupWorktree(staleIgnoredWorktree, "always", true)).cleanup, "success");

    const untrackedIntegrationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-untracked",
    });
    assert.equal(untrackedIntegrationWorktree.ok, true);
    await writeFile(path.join(untrackedIntegrationWorktree.path, "src", "new.txt"), "new file\n", "utf8");
    const untrackedIntegrationPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: untrackedIntegrationWorktree.path,
      allowedEdits: ["src/new.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(untrackedIntegrationPreview.ok, true);
    const untrackedIntegration = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: untrackedIntegrationWorktree.path,
      allowedEdits: ["src/new.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: untrackedIntegrationPreview.previewReceipt,
    });
    assert.equal(untrackedIntegration.ok, true, JSON.stringify(untrackedIntegration, null, 2));
    assert.deepEqual(untrackedIntegration.changedFiles, ["src/new.txt"]);
    assert.equal((await readFile(path.join(tempDir, "src", "new.txt"), "utf8")).replace(/\r\n/g, "\n"), "new file\n");
    assert.equal((await cleanupWorktree(untrackedIntegrationWorktree, "always", true)).cleanup, "success");
    assert.equal((await runCommand("git", ["add", "--", "src/new.txt"], tempDir, 1000 * 15)).exitCode, 0);
    const untrackedIntegrationCommit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "integrate new file"], tempDir, 1000 * 15);
    assert.equal(untrackedIntegrationCommit.exitCode, 0);

    const integrationRejectWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-reject",
    });
    assert.equal(integrationRejectWorktree.ok, true);
    await writeFile(path.join(integrationRejectWorktree.path, "src", "blocked.txt"), "blocked integration\n", "utf8");
    const integrationRejected = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: integrationRejectWorktree.path,
      allowedEdits: ["src/allowed.txt"],
    });
    assert.equal(integrationRejected.ok, false);
    assert.ok(integrationRejected.disallowedFiles.includes("src/blocked.txt"));
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");
    assert.equal((await cleanupWorktree(integrationRejectWorktree, "always", true)).cleanup, "success");

    const validationFailWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-fail",
    });
    assert.equal(validationFailWorktree.ok, true);
    await writeFile(path.join(validationFailWorktree.path, "src", "allowed.txt"), "validation should roll back \n", "utf8");
    const validationFailPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationFailWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(validationFailPreview.ok, true);
    const validationFailed = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationFailWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: validationFailPreview.previewReceipt,
    });
    assert.equal(validationFailed.ok, false);
    assert.equal(validationFailed.errorType, "validation_command_failed");
    assert.equal(validationFailed.rollback.rollback, "success");
    assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8")).replace(/\r\n/g, "\n"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.trim(), "");
    assert.equal((await cleanupWorktree(validationFailWorktree, "always", true)).cleanup, "success");

    const externalOwnershipBaseline = await captureRollbackBaseline(tempDir);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "bridge-owned exact bytes\n", "utf8");
    const bridgeOwnedSnapshot = await exactIntegrationFileSnapshot(tempDir, ["src/allowed.txt"]);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "concurrent external bytes\n", "utf8");
    const ambiguousRollback = await rollbackVerifiedOwnedChanges({
      cwd: tempDir,
      baseline: externalOwnershipBaseline,
      files: ["src/allowed.txt"],
      ownedSnapshot: bridgeOwnedSnapshot,
    });
    assert.equal(ambiguousRollback.rollback, "not_attempted_unattributed_changes");
    assert.deepEqual(ambiguousRollback.unresolvedFiles, ["src/allowed.txt"]);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "concurrent external bytes\n");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    assert.equal((await runCommand("git", ["status", "--short"], tempDir, 1000 * 15)).stdout.trim(), "");

    const validationMutationWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-validation-content-mutation",
    });
    assert.equal(validationMutationWorktree.ok, true, JSON.stringify(validationMutationWorktree, null, 2));
    await writeFile(path.join(validationMutationWorktree.path, "src", "allowed.txt"), "reviewed exact content\n", "utf8");
    const validationMutationCommand = "git diff --check";
    const validationMutationPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationMutationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: validationMutationCommand,
      dryRun: true,
    });
    assert.equal(validationMutationPreview.ok, true);
    const validationMutationResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: validationMutationWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: validationMutationCommand,
      reviewed: true,
      previewReceipt: validationMutationPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "allowed.txt"), "concurrent validation bytes\n", "utf8");
      },
    });
    assert.equal(validationMutationResult.ok, false);
    assert.equal(validationMutationResult.errorType, "integration_validation_mutated_reviewed_files");
    assert.deepEqual(validationMutationResult.contentMismatches, ["src/allowed.txt"]);
    assert.deepEqual(validationMutationResult.rollback.unresolvedFiles, ["src/allowed.txt"]);
    assert.notEqual(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await clearSelfTestIntegrationQuarantine();
    assert.equal((await cleanupWorktree(validationMutationWorktree, "always", true)).cleanup, "success");

    const extraPathWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-extra-allowed-path",
    });
    assert.equal(extraPathWorktree.ok, true, JSON.stringify(extraPathWorktree, null, 2));
    await writeFile(path.join(extraPathWorktree.path, "src", "allowed.txt"), "reviewed path-set content\n", "utf8");
    const extraPathPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: extraPathWorktree.path,
      allowedEdits: ["src"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(extraPathPreview.ok, true);
    const extraPathResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: extraPathWorktree.path,
      allowedEdits: ["src"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: extraPathPreview.previewReceipt,
      beforeApplyHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "external-extra.txt"), "external path\n", "utf8");
      },
    });
    assert.equal(extraPathResult.ok, false);
    assert.equal(extraPathResult.errorType, "integration_preview_stale");
    assert.deepEqual(extraPathResult.unexpectedTargetChanges, ["src/external-extra.txt"]);
    assert.equal(await readFile(path.join(tempDir, "src", "external-extra.txt"), "utf8"), "external path\n");
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    await rm(path.join(tempDir, "src", "external-extra.txt"), { force: true });
    assert.equal((await cleanupWorktree(extraPathWorktree, "always", true)).cleanup, "success");

    const stagedOwnershipWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-index-ownership",
    });
    assert.equal(stagedOwnershipWorktree.ok, true, JSON.stringify(stagedOwnershipWorktree, null, 2));
    await writeFile(path.join(stagedOwnershipWorktree.path, "src", "allowed.txt"), "reviewed index content\n", "utf8");
    const stagedOwnershipPreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: stagedOwnershipWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(stagedOwnershipPreview.ok, true);
    let concurrentCachedDiff = "";
    const stagedOwnershipResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: stagedOwnershipWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: stagedOwnershipPreview.previewReceipt,
      beforeValidationHook: async ({ targetCwd }) => {
        assert.equal((await runCommand("git", ["add", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        concurrentCachedDiff = (await runCommand("git", ["diff", "--cached", "--binary", "--", "src/allowed.txt"], targetCwd, 1000 * 15)).stdout;
      },
    });
    assert.equal(stagedOwnershipResult.ok, false);
    assert.equal(stagedOwnershipResult.errorType, "integration_validation_mutated_unapproved_files");
    assert.equal(stagedOwnershipResult.validationIndexChanged, true);
    assert.deepEqual(stagedOwnershipResult.indexReset.ownershipMismatches, ["src/allowed.txt"]);
    assert.equal((await runCommand("git", ["diff", "--cached", "--binary", "--", "src/allowed.txt"], tempDir, 1000 * 15)).stdout, concurrentCachedDiff);
    assert.equal(await readFile(path.join(tempDir, "src", "allowed.txt"), "utf8"), "integrated allowed\n");
    assert.equal((await runCommand("git", ["restore", "--staged", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
    await clearSelfTestIntegrationQuarantine();
    assert.equal((await cleanupWorktree(stagedOwnershipWorktree, "always", true)).cleanup, "success");

    const headRaceWorktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "integration-head-race",
    });
    assert.equal(headRaceWorktree.ok, true, JSON.stringify(headRaceWorktree, null, 2));
    await writeFile(path.join(headRaceWorktree.path, "src", "allowed.txt"), "reviewed before head race\n", "utf8");
    const headRacePreview = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: headRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      dryRun: true,
    });
    assert.equal(headRacePreview.ok, true);
    const headRaceResult = await integratePatchSerially({
      cwd: tempDir,
      worktreePath: headRaceWorktree.path,
      allowedEdits: ["src/allowed.txt"],
      validationCommand: "git diff --check",
      reviewed: true,
      previewReceipt: headRacePreview.previewReceipt,
      beforeApplyHook: async ({ targetCwd }) => {
        await writeFile(path.join(targetCwd, "src", "api.txt"), "concurrent committed head\n", "utf8");
        assert.equal((await runCommand("git", ["add", "--", "src/api.txt"], targetCwd, 1000 * 15)).exitCode, 0);
        const committed = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "concurrent head"], targetCwd, 1000 * 15);
        assert.equal(committed.exitCode, 0, committed.stderr);
      },
    });
    assert.equal(headRaceResult.ok, false);
    assert.equal(headRaceResult.errorType, "integration_target_head_changed");
    assert.notEqual(headRaceResult.actualTargetHead, headRacePreview.targetHead);
    assert.deepEqual(headRaceResult.unexpectedTargetChanges, ["src/api.txt"]);
    assert.equal(headRaceResult.rollback.rollback, "not_attempted_unattributed_changes");
    const headRaceCleanup = await runCommand("git", ["reset", "--hard", headRacePreview.targetHead], tempDir, 1000 * 30);
    assert.equal(headRaceCleanup.exitCode, 0, headRaceCleanup.stderr);
    assert.equal((await cleanupWorktree(headRaceWorktree, "always", true)).cleanup, "success");

    if (process.platform === "win32") {
      assert.equal((await runCommand("git", ["config", "core.autocrlf", "true"], tempDir, 1000 * 15)).exitCode, 0);
      const crlfIntegrationWorktree = await createWorktreeForJob({
        cwd: tempDir,
        agent: "builder",
        jobId: "integration-crlf-checkout",
      });
      assert.equal(crlfIntegrationWorktree.ok, true, JSON.stringify(crlfIntegrationWorktree, null, 2));
      await writeFile(path.join(crlfIntegrationWorktree.path, "src", "allowed.txt"), "reviewed crlf bytes\r\n", "utf8");
      const crlfIntegrationPreview = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfIntegrationWorktree.path,
        allowedEdits: ["src/allowed.txt"],
        validationCommand: "git diff --check",
        dryRun: true,
      });
      assert.equal(crlfIntegrationPreview.ok, true, JSON.stringify(crlfIntegrationPreview, null, 2));
      const crlfIntegrationResult = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfIntegrationWorktree.path,
        allowedEdits: ["src/allowed.txt"],
        validationCommand: "git diff --check",
        reviewed: true,
        previewReceipt: crlfIntegrationPreview.previewReceipt,
      });
      assert.equal(crlfIntegrationResult.ok, true, JSON.stringify(crlfIntegrationResult, null, 2));
      assert.equal((await readFile(path.join(tempDir, "src", "allowed.txt"))).equals(Buffer.from("reviewed crlf bytes\r\n")), true);
      assert.equal((await cleanupWorktree(crlfIntegrationWorktree, "always", true)).cleanup, "success");
      assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);

      const crlfNewFileWorktree = await createWorktreeForJob({
        cwd: tempDir,
        agent: "builder",
        jobId: "integration-crlf-new-file",
      });
      assert.equal(crlfNewFileWorktree.ok, true, JSON.stringify(crlfNewFileWorktree, null, 2));
      await writeFile(path.join(crlfNewFileWorktree.path, "src", "crlf-new.txt"), "new reviewed file\n", "utf8");
      const crlfNewFilePreview = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfNewFileWorktree.path,
        allowedEdits: ["src/crlf-new.txt"],
        validationCommand: "git diff --check",
        dryRun: true,
      });
      assert.equal(crlfNewFilePreview.ok, true, JSON.stringify(crlfNewFilePreview, null, 2));
      const crlfNewFileResult = await integratePatchSerially({
        cwd: tempDir,
        worktreePath: crlfNewFileWorktree.path,
        allowedEdits: ["src/crlf-new.txt"],
        validationCommand: "git diff --check",
        reviewed: true,
        previewReceipt: crlfNewFilePreview.previewReceipt,
      });
      assert.equal(crlfNewFileResult.ok, true, JSON.stringify(crlfNewFileResult, null, 2));
      assert.equal((await readFile(path.join(tempDir, "src", "crlf-new.txt"))).equals(Buffer.from("new reviewed file\r\n")), true);
      assert.equal((await cleanupWorktree(crlfNewFileWorktree, "always", true)).cleanup, "success");
      await rm(path.join(tempDir, "src", "crlf-new.txt"), { force: true });

      assert.equal((await runCommand("git", ["config", "core.autocrlf", "false"], tempDir, 1000 * 15)).exitCode, 0);
      assert.equal((await runCommand("git", ["restore", "--worktree", "--", "src/allowed.txt"], tempDir, 1000 * 15)).exitCode, 0);
      assert.deepEqual(await gitChangedFiles(tempDir), []);
    }

    const writerPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit allowed only.",
      write: true,
      lockedPaths: ["src"],
      allowedEdits: ["src/allowed.txt"],
    }).lockPlan;
    writerPlan.cwd = tempDir;

    let rollbackBaseline = await captureRollbackBaseline(tempDir);
    let beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent changed\n", "utf8");
    let afterRun = await gitChangedFileSnapshot(tempDir);
    let changedFiles = changedFilesBetween(beforeRun, afterRun);
    let validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/blocked.txt"]);
    let rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    const scopeWriterPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit through Scope Contract.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    scopeWriterPlan.cwd = tempDir;
    assert.deepEqual(scopeWriterPlan.allowedEdits, ["src/allowed.txt"]);

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "outside scope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "changed_file_validation_error");
    assert.deepEqual(validation.scopeViolations.outsideWriteScope, ["src/blocked.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "changed forbidden\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "forbidden_file_changed");
    assert.deepEqual(validation.scopeViolations.forbiddenFiles, ["src/forbidden.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "forbidden.txt"), "utf8"), "secret\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "created.txt"), "nope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/created.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    await assert.rejects(readFile(path.join(tempDir, "src", "created.txt"), "utf8"));

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await rm(path.join(tempDir, "src", "blocked.txt"), { force: true });
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    await writeFile(path.join(tempDir, "src", "blocked.txt"), "user dirty\n", "utf8");
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent overwrote dirty file\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "user dirty\n");

    const readOnlyPlan = validateSingleLockPlan({
      agent: "reviewer",
      task: "Review only.",
    }).lockPlan;
    readOnlyPlan.cwd = tempDir;
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "reviewer edited\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: readOnlyPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/allowed.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
  } finally {
    selfTestProgress("cleanup");
    selfTestHooks.stateDirectoryOverride = initialSelfTestStateDirectoryOverride;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(tempStateDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(earlySelfTestStateDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(outsideLinkTarget, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    await rm(nonGitFixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }

  selfTestProgress("end");
  console.log("Self tests passed.");
}

await verifyReleaseIntegrity();
if (process.argv.includes("--self-test-events")) {
  runEventEvidenceSelfTests();
} else {
  await runSelfTests();
}
