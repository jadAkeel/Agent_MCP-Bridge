#!/usr/bin/env node

// Regression tests for the tool-handler, job, parallel and pipeline defects found in the
// 2026-09-29 review (defect numbers in the test names). Imports the bridge as a module like
// tests/server-self-test.js; agent discovery and the OpenCode run are replaced by the
// self-test agentRuntimeTestHook, everything else (Git, locks, SQLite state) is real.
//   node tests/review-tools-pipelines.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
// Read once at import: writer worktrees on, a small snapshot bound for the group-scope fault
// test, and node allowlisted so a validation command can write ignored output.
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_MAX_SNAPSHOT_FILES = "40";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  BRIDGE_INSTANCE_ID,
  CONFIG,
  MCP_SANITIZED_READER_AGENT,
  MCP_SANITIZED_READER_PROFILE,
  MCP_SANITIZED_READER_PROMPT,
  PIPELINE_RUNS,
  QUEUE_JOBS,
  assert,
  assessQueuePlan,
  buildTrustedGitEnv,
  cleanupWorktree,
  closeDb,
  collectIntegrationPatch,
  contractorAuthorizationValid,
  createHash,
  createWorktreeForJob,
  enqueueQueueJob,
  executeOpenCodeJob,
  existsSync,
  finalizePipelineRecord,
  finalizePipelineSourceCleanup,
  hasAmbiguousPathPattern,
  makeInternalQueueContractorProof,
  mergePipelineIntegrationQueue,
  mkdir,
  mkdtemp,
  nextPipelineIntegrationItemStatus,
  openLockDb,
  parallelBatchCapacityError,
  parallelGroupDeadlineMs,
  path,
  persistPipelineRecord,
  pipelineIntegrationItemMatches,
  readOnlyEditsDeniedByAttestation,
  readPersistedPipelineRecord,
  resumeAuthorizedPipelineCleanup,
  rm,
  runCommand,
  runPipelineReadOnlyGate,
  server,
  sha256File,
  shouldUseWorktree,
  tmpdir,
  captureIntegrationTargetState,
  trackedTargetStateSha256,
  updatePipelineRecord,
  validateParallelWritePlan,
  writeFile,
} = __selfTest.internals;

const stateDir = await mkdtemp(path.join(tmpdir(), "review-tools-state-"));
const repo = await mkdtemp(path.join(tmpdir(), "review-tools-repo-"));
const otherRepo = await mkdtemp(path.join(tmpdir(), "review-tools-other-"));
const scratch = await mkdtemp(path.join(tmpdir(), "review-tools-scratch-"));
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";

const WRITE_AGENTS = new Set(["builder", "debugger"]);
const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repo) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
async function gitCommit(message, cwd = repo) {
  await git([...gitIdentity, "commit", "-q", "-m", message], cwd);
}
async function initRepo(root, files) {
  await git(["init", "-q"], root);
  await git(["config", "core.autocrlf", "false"], root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content, "utf8");
  }
  await git(["add", "."], root);
  await gitCommit("init", root);
}
async function resetRepo() {
  await git(["reset", "-q", "--hard", "HEAD"]);
  await git(["clean", "-q", "-fdx"]);
}
const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const flipCase = (value) => (process.platform === "win32" ? value.toUpperCase() : value);
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "" });
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

await initRepo(repo, {
  ".gitignore": "coverage/\n__pycache__/\n",
  "src/a.txt": "a\n",
  "src/b.txt": "b\n",
  "src/dirty.txt": "clean\n",
  "app/[slug]/page.tsx": "export default 1;\n",
  "app/s/page.tsx": "export default 2;\n",
});
await initRepo(otherRepo, { "src/a.txt": "other\n" });

// A validation command that only writes ignored build output into its cwd.
const ignoredOutputScript = path.join(scratch, "write-ignored-output.mjs");
await writeFile(ignoredOutputScript, [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "mkdirSync('__pycache__', { recursive: true });",
  "writeFileSync('__pycache__/validation.pyc', String(Date.now()));",
].join("\n"), "utf8");

function metadataFor(agent, overrides = {}) {
  if (agent === MCP_SANITIZED_READER_AGENT) {
    return { ok: true, metadata: {
      name: agent, mode: "all", provider: MCP_SANITIZED_READER_PROFILE.provider, model: MCP_SANITIZED_READER_PROFILE.model,
      variant: MCP_SANITIZED_READER_PROFILE.variant, temperature: 0, promptSha256: sha(MCP_SANITIZED_READER_PROMPT),
      canEdit: false, canDelegate: false, externalDirectoryDenied: true, externalDirectoryDefaultAction: "deny", externalAllowedPatterns: [],
      bashDenied: true, webDenied: true, skillDenied: true, bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: "sanitized",
    } };
  }
  return { ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: WRITE_AGENTS.has(agent), canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    ...overrides,
  } };
}

// onRun({ agent, cwd, lockPlan, options }) is the agent: it may edit the execution cwd.
function installRuntime({ onRun = async () => {}, onMetadata = async () => {}, providerFor = null, resolveCalls = [] } = {}) {
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy, proxyAgent, orchestratorMode, discovery = {}) => {
      resolveCalls.push({ requestedAgent, allowFallbackToBuild, subagentStrategy, proxyAgent });
      const actualAgent = discovery.routeToSanitizedAgent ? MCP_SANITIZED_READER_AGENT : requestedAgent;
      const mode = actualAgent === MCP_SANITIZED_READER_AGENT ? "all" : "primary";
      return {
        requestedAgent, actualAgent, requestedAgentMode: mode, actualAgentMode: mode,
        fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [actualAgent], discoveryExitCode: 0,
      };
    },
    readAgentDebugMetadata: async (agent, cwd) => {
      await onMetadata({ agent, cwd });
      return metadataFor(agent, providerFor ? { provider: providerFor(agent) } : {});
    },
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan, timeoutMs, options = {}) => {
      if (!dryRun) await onRun({ agent, cwd, lockPlan, options });
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
      };
    },
  };
}

function pipelineRecord(pipelineId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    pipelineId,
    name: pipelineId,
    cwd: repo,
    status: "awaiting_integration",
    createdAt: now,
    updatedAt: now,
    jobs: [],
    queueJobIds: [],
    expectedChildCount: 0,
    integrationQueue: [],
    events: [],
    errors: [],
    finalValidationCommand: "git status --short",
    finalValidationSource: "caller",
    finalValidationSpec: null,
    finalValidationResult: null,
    reviewerJob: null,
    testerJob: null,
    reviewerResult: null,
    testerResult: null,
    sourceCleanupResults: [],
    policy: null,
    finishedAt: "",
    ...overrides,
  };
}

async function writerWorktree(jobId, edits = {}) {
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId, lockedPaths: ["src"], allowedEdits: ["src"] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  for (const [file, content] of Object.entries(edits)) await writeFile(path.join(worktree.path, file), content, "utf8");
  const identity = await collectIntegrationPatch({ cwd: repo, worktreePath: worktree.path, sourceBaseCommit: worktree.baseCommit });
  assert.equal(identity.ok, true, JSON.stringify(identity));
  return { worktree, identity };
}

function pipelineItem(jobId, { worktree, identity }, overrides = {}) {
  return {
    jobId,
    agent: "builder",
    worktreePath: worktree.path,
    branch: worktree.branch,
    sourceBaseCommit: identity.sourceBaseCommit,
    patchSha256: identity.patchSha256,
    sourceStateSha256: identity.sourceStateSha256,
    allowedEdits: ["src"],
    changedFiles: identity.changedFiles || [],
    status: "pending",
    ...overrides,
  };
}

async function insertJournalOperation({ operationId, pipelineId, jobId, status, patchSha256, sourceStateSha256 }) {
  const db = await openLockDb(repo);
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO integration_operations
      (operation_id, cwd, pipeline_id, pipeline_job_id, owner_instance_id, owner_generation, revision, status,
       target_head, target_state_sha256, pre_index_sha256, patch_sha256, source_base_commit, source_state_sha256,
       contract_sha256, affected_paths_json, result_json, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'test', 1, ?, 'head', 'state', 'index', ?, 'base', ?, 'contract', '[]', '{}', ?, ?, ?)
    `).run(operationId, path.resolve(repo), pipelineId, jobId, BRIDGE_INSTANCE_ID, status, patchSha256, sourceStateSha256, now, now, now);
  } finally {
    closeDb(db);
  }
}

async function durableItem(pipelineId, index = 0) {
  return (await readPersistedPipelineRecord(pipelineId, repo)).integrationQueue[index];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
test("1: integration item outcomes are classified, dry runs never change the item", async () => {
  const pending = { status: "pending", operationId: "op-own" };
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: "integration_preview_contains_sensitive_text" }, { dryRun: true }), "pending");
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: "pipeline_source_identity_changed" }, { dryRun: true }), "pending");
  for (const retryable of ["integration_lock_conflict", "integration_dirty_target", "dirty_worktree_requires_checkpoint", "integration_preview_contract_mismatch",
    "integration_preview_stale", "integration_requires_review", "validation_command_failed", "integration_transaction_failed", "integration_target_head_changed"]) {
    assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: retryable }), "pending", retryable);
  }
  for (const definitive of ["pipeline_source_identity_changed", "integration_merge_conflict", "forbidden_file_changed", "changed_file_validation_error"]) {
    assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: definitive }), "rejected", definitive);
  }
  // The same scope type after the apply means another process wrote the checkout.
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: "changed_file_validation_error", appliedFiles: ["src/x"] }), "pending");
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: "integration_recovery_quarantined", operationIds: ["op-other"] }), "pending");
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: false, errorType: "integration_recovery_quarantined", operationIds: ["op-own"] }), "quarantined");
  assert.equal(nextPipelineIntegrationItemStatus(pending, { ok: true, status: "no_changes" }), "integrated");
  const record = { cwd: repo };
  const item = { worktreePath: path.join(repo, "wt"), branch: "b1" };
  assert.equal(pipelineIntegrationItemMatches(record, item, { worktreePath: flipCase(path.join(repo, "wt")) }), true);
  assert.equal(pipelineIntegrationItemMatches(record, item, { worktreePath: path.join(repo, "wt").replace(/\\/g, "/") }), true);
  assert.equal(pipelineIntegrationItemMatches(record, item, { worktreePath: path.join(repo, "other") }), false);
});

test("1+8: a flagged dry run, a retry and an unreviewed apply leave the item pending; the apply integrates it", async () => {
  await resetRepo();
  const source = await writerWorktree("review-secret", { "src/a.txt": "key = AKIAABCDEFGHIJKLMNOP\n" });
  const pipelineId = "review-pipeline-secret";
  const record = pipelineRecord(pipelineId, { integrationQueue: [pipelineItem("job-secret", source)] });
  await persistPipelineRecord(record);
  // Case-insensitive match on win32 (the caller may spell the worktree differently).
  const args = { cwd: repo, pipelineId, worktreePath: flipCase(source.worktree.path), allowedEdits: ["src"] };
  const flagged = textOf(await callTool("integrate_opencode_worktree", { ...args, dryRun: true }));
  assert.match(flagged, /integration_preview_contains_sensitive_text/, flagged);
  assert.equal((await durableItem(pipelineId)).status, "pending", "A dry run must not reject the item.");
  const accepted = textOf(await callTool("integrate_opencode_worktree", { ...args, dryRun: true, acceptFlaggedSecretLines: true }));
  assert.match(accepted, /Serial integration accepted\./, accepted);
  assert.equal((await durableItem(pipelineId)).status, "pending");
  const unreviewed = textOf(await callTool("integrate_opencode_worktree", { ...args }));
  assert.match(unreviewed, /integration_requires_review/, unreviewed);
  const afterUnreviewed = await durableItem(pipelineId);
  assert.equal(afterUnreviewed.status, "pending", "A missing review confirmation is retryable.");
  assert.equal(afterUnreviewed.patchSha256, source.identity.patchSha256, "A failed attempt keeps the attested source identity.");
  const receipt = JSON.parse(/Preview receipt: (\{.*\})/.exec(accepted)[1]);
  const applied = textOf(await callTool("integrate_opencode_worktree", { ...args, reviewed: true, previewReceipt: receipt }));
  assert.match(applied, /Status: applied/, applied);
  const persisted = await readPersistedPipelineRecord(pipelineId, repo);
  assert.equal(persisted.integrationQueue[0].status, "integrated");
  assert.equal(persisted.status, "awaiting_finalization");
  await resetRepo();
  await cleanupWorktree(source.worktree, "always", true);
});

test("2: a pipeline writer that changed nothing gets no integration item; no_changes integrates", async () => {
  const merged = mergePipelineIntegrationQueue([], [
    { jobId: "empty", agent: "builder", worktreePath: "", noChanges: true, changedFiles: [], status: "completed" },
    { jobId: "legacy-empty", agent: "builder", worktreePath: path.join(repo, "gone"), changedFiles: [], status: "completed" },
    { jobId: "real", agent: "builder", worktreePath: path.join(repo, "wt"), changedFiles: ["src/a.txt"], status: "completed" },
  ]);
  assert.deepEqual(merged.map((item) => item.jobId), ["real"]);
  await resetRepo();
  const empty = await writerWorktree("review-empty");
  const pipelineId = "review-pipeline-no-changes";
  await persistPipelineRecord(pipelineRecord(pipelineId, { integrationQueue: [pipelineItem("job-empty", empty)] }));
  const response = textOf(await callTool("integrate_opencode_worktree", { cwd: repo, pipelineId, worktreePath: empty.worktree.path, allowedEdits: ["src"] }));
  assert.match(response, /Status: no_changes/, response);
  const persisted = await readPersistedPipelineRecord(pipelineId, repo);
  assert.equal(persisted.integrationQueue[0].status, "integrated");
  assert.equal(persisted.status, "awaiting_finalization");
  await cleanupWorktree(empty.worktree, "always", true);
});

test("2+9: a writer job that changed nothing reports its removed worktree as gone and releases its lock", async () => {
  await resetRepo();
  installRuntime();
  const execution = await executeOpenCodeJob({
    agent: "builder", task: "Change nothing.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]),
  });
  assert.equal(execution.result.errorType || "", "", textOf(execution.response));
  assert.equal(execution.result.noChanges, true);
  assert.equal(execution.worktree, null, "The removed worktree must not be offered for integration.");
  assert.equal(execution.result.worktree.path, "");
  assert.equal(execution.result.worktree.removed, true);
  assert.equal(existsSync(execution.result.worktree.removedPath), false);
  assert.match(textOf(execution.response), /Temporary lock released: yes/);
  assert.equal(execution.result.lockRelease.released, true);
});

test("3: single-job validation that writes ignored output is not a workspace mutation", async () => {
  await resetRepo();
  installRuntime();
  // Runs in the checkout (a reader): the validation's __pycache__/ is build output, not an edit.
  // (A writer worktree still refuses ignored output at patch collection, by design.)
  const execution = await executeOpenCodeJob({
    agent: "tester", task: "Run the check.", cwd: repo, write: false, lockMode: "off",
    validationCommand: `node ${ignoredOutputScript}`,
  });
  assert.equal(execution.result.errorType || "", "", textOf(execution.response));
  assert.equal(existsSync(path.join(repo, "__pycache__", "validation.pyc")), true, "The validation command ran.");
  assert.equal(execution.result.validationMutationFiles, undefined);
  await resetRepo();
});

test("7: an edit-denied reader keeps its result when another client edits and commits the checkout", async () => {
  await resetRepo();
  await writeFile(path.join(repo, "src", "dirty.txt"), "dirty before the review\n", "utf8");
  installRuntime({ onRun: async ({ cwd }) => {
    await mkdir(path.join(cwd, "coverage"), { recursive: true });
    await writeFile(path.join(cwd, "coverage", "lcov.info"), "TN:\n", "utf8");
    await writeFile(path.join(cwd, "src", "a.txt"), "saved by an editor\n", "utf8");
    await git(["add", "src/dirty.txt"], cwd);
    await gitCommit("user commit during review", cwd);
  } });
  const execution = await executeOpenCodeJob({ agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" });
  const text = textOf(execution.response);
  assert.equal(execution.result.errorType || "", "", text);
  assert.deepEqual(execution.result.changedFiles, []);
  assert.deepEqual(execution.result.readOnlyWorkspaceDrift.files, ["src/a.txt"]);
  assert.deepEqual(execution.result.readOnlyWorkspaceDrift.committedFiles, ["src/dirty.txt"]);
  assert.ok(execution.result.readOnlyHeadMove, "The HEAD move is consulted once the drift is external.");
  assert.match(text, /Checkout changed during this read-only run/);
  assert.equal(readOnlyEditsDeniedByAttestation({ lockType: "read" }, { ok: true, metadata: { canEdit: true } }), false);
  assert.equal(readOnlyEditsDeniedByAttestation({ lockType: "read" }, { ok: true, metadata: {} }), false);
  await git(["reset", "-q", "--hard", "HEAD~1"]);
  await resetRepo();
});

test("7: a parallel read-only batch reports external drift instead of failing", async () => {
  await resetRepo();
  installRuntime({ onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "b.txt"), "saved elsewhere\n", "utf8") });
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [{ agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" }] }));
  assert.match(text, /Parallel group status: completed/, text);
  assert.match(text, /External changes \(another client; the attested readers cannot edit\): src\/b\.txt/);
  await resetRepo();
});

test("2+16+18: parallel writers: an empty worktree is removed, the deadline is reported, rollback text is honest", async () => {
  await resetRepo();
  installRuntime({ onRun: async ({ cwd, lockPlan }) => {
    if (lockPlan.allowedEdits.includes("src/a.txt")) await writeFile(path.join(cwd, "src", "a.txt"), "parallel edit\n", "utf8");
    if (lockPlan.allowedEdits.includes("src/b.txt")) await writeFile(path.join(cwd, "src", "outside.txt"), "outside the lock\n", "utf8");
  } });
  const job = (file) => ({ agent: "builder", task: `Edit ${file}.`, cwd: repo, write: true, lockMode: "strict", lockedPaths: [file], allowedEdits: [file], scopeContract: writeScope([file]) });
  const emptyJob = job("src/dirty.txt");
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [job("src/a.txt"), emptyJob] }));
  assert.match(text, /1 of 2 writer worktrees were retained; writers that changed nothing had their empty worktree removed\./, text);
  const plans = validateParallelWritePlan([job("src/a.txt"), emptyJob]).lockPlans;
  assert.match(text, new RegExp(`Group deadline ms: ${parallelGroupDeadlineMs(plans)} `));
  const retained = /Path: (.+)\nBranch: (.+)\nCleanup: retained_for_review/.exec(text);
  assert.ok(retained, text);
  await cleanupWorktree({ path: retained[1].trim(), branch: retained[2].trim(), repoRoot: repo }, "always", true);

  const rejected = textOf(await callTool("run_opencode_parallel", { jobs: [job("src/b.txt")] }));
  assert.match(rejected, /no rollback was attempted and the changes and worktrees were retained/, rejected);
  assert.doesNotMatch(rejected, /rollback was attempted\./);
  const retainedRejected = /Path: (.+)\nBranch: (.+)\nCleanup: retained_for_review/.exec(rejected);
  if (retainedRejected) await cleanupWorktree({ path: retainedRejected[1].trim(), branch: retainedRejected[2].trim(), repoRoot: repo }, "always", true);
  await resetRepo();
});

test("16: the parallel deadline covers retries and validation", async () => {
  const builder = { agent: "builder", lockType: "write", timeoutMs: 1000 * 60 * 30, validationCommand: "git diff --check" };
  const reader = { agent: "reviewer", lockType: "read", timeoutMs: 1000 * 60 * 3, validationCommand: "" };
  assert.equal(parallelGroupDeadlineMs([builder]), 1000 * 60 * 30 + CONFIG.validationCommandTimeoutMs + 1000 * 60);
  assert.equal(parallelGroupDeadlineMs([reader]), Math.max(CONFIG.readOnlyRetryMaxElapsedMs, 1000 * 60 * 3) + 1000 * 60);
});

test("17: a group-scope snapshot fault keeps every job result and Run id", async () => {
  await resetRepo();
  installRuntime({ onRun: async ({ cwd }) => {
    await mkdir(path.join(cwd, "many"), { recursive: true });
    for (let index = 0; index < CONFIG.maxSnapshotFiles + 5; index += 1) await writeFile(path.join(cwd, "many", `f${index}.txt`), "x", "utf8");
  } });
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [{ agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" }] }));
  assert.match(text, /Group check failed: snapshot_safety_limit_exceeded/, text);
  assert.match(text, /JOB 1\nRun id: /);
  await resetRepo();
});

test("18: a sanitized before_wave failure carries its JOB label and Run id", async () => {
  const root = path.join(scratch, "sanitized");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "allowed.txt"), "sanitized\n", "utf8");
  const manifestPath = path.join(scratch, "sanitized-manifest.json");
  const manifest = `${JSON.stringify({ version: 1, directories: [], files: { "allowed.txt": await sha256File(path.join(root, "allowed.txt")) } }, null, 2)}\n`;
  await writeFile(manifestPath, manifest, "utf8");
  const contract = { root, manifestPath, manifestSha256: sha(manifest), requiredFiles: ["allowed.txt"] };
  let sanitizedMetadataCalls = 0;
  installRuntime({ onMetadata: async ({ agent }) => {
    // The second attestation runs after the locks: change the workspace before the wave.
    if (agent === MCP_SANITIZED_READER_AGENT && ++sanitizedMetadataCalls === 2) await writeFile(path.join(root, "added.txt"), "x", "utf8");
  } });
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [{ agent: "reviewer", task: "Read.", cwd: root, write: false, lockType: "read", lockMode: "off", subagentStrategy: "reject", sanitizedWorkspace: contract }] }));
  assert.match(text, /JOB 1\nRun id: [^\n]+\nExecution rejected|JOB 1\nRun id: [^\n]+\n.*Sanitized workspace changed between preflight and the parallel wave/s, text);
});

test("3: finalization ignores ignored output of the final validation and of the gates", async () => {
  await resetRepo();
  const validationPipeline = pipelineRecord("review-final-ignored-validation", {
    status: "awaiting_finalization",
    finalValidationCommand: `node ${ignoredOutputScript}`,
    integrationQueue: [{ jobId: "done", status: "integrated" }],
  });
  await persistPipelineRecord(validationPipeline);
  const validated = await finalizePipelineRecord(validationPipeline, { skipReviewers: true });
  assert.equal(validated.ok, true, JSON.stringify({ errorType: validated.errorType, errors: validationPipeline.errors }));
  assert.equal(validationPipeline.status, "completed");
  await resetRepo();

  const previousGate = selfTestHooks.pipelineGateExecutorTestHook;
  const gate = (effect, outcome = {}) => async (job) => {
    await effect(job);
    return {
      result: { errorType: null, changedFiles: [], stdout: "Checked.\nGATE_VERDICT: pass", ...outcome },
      validation: { disallowedFiles: [] },
      response: { content: [{ type: "text", text: "Checked." }] },
    };
  };
  try {
    selfTestHooks.pipelineGateExecutorTestHook = gate(async (job) => {
      await mkdir(path.join(job.cwd, "coverage"), { recursive: true });
      await writeFile(path.join(job.cwd, "coverage", `${job.task.length}-${Date.now()}.info`), "TN:\n", "utf8");
    });
    const ignoredGatePipeline = pipelineRecord("review-final-ignored-gate", { status: "awaiting_finalization", reviewerJob: { agent: "reviewer", task: "Review." } });
    await persistPipelineRecord(ignoredGatePipeline);
    const ignoredGate = await finalizePipelineRecord(ignoredGatePipeline);
    assert.equal(ignoredGate.ok, true, JSON.stringify({ errorType: ignoredGate.errorType, errors: ignoredGatePipeline.errors }));
    await resetRepo();

    selfTestHooks.pipelineGateExecutorTestHook = gate(async (job) => writeFile(path.join(job.cwd, "src", "b.txt"), "changed during the gates\n", "utf8"));
    const driftPipeline = pipelineRecord("review-final-tracked-drift", { status: "awaiting_finalization", reviewerJob: { agent: "reviewer", task: "Review." } });
    await persistPipelineRecord(driftPipeline);
    const drift = await finalizePipelineRecord(driftPipeline);
    assert.equal(drift.errorType, "pipeline_target_changed_before_cleanup");
    assert.equal(driftPipeline.status, "awaiting_finalization", "State drift is retryable, not a failed pipeline.");
    assert.equal((await readPersistedPipelineRecord(driftPipeline.pipelineId, repo)).status, "awaiting_finalization");
    await resetRepo();

    selfTestHooks.pipelineGateExecutorTestHook = gate(async () => {}, { errorType: "read_only_agent_unavailable", stdout: "" });
    const unavailablePipeline = pipelineRecord("review-final-gate-unavailable", { status: "awaiting_finalization", reviewerJob: { agent: "reviewer", task: "Review." } });
    await persistPipelineRecord(unavailablePipeline);
    const unavailable = await finalizePipelineRecord(unavailablePipeline);
    assert.equal(unavailable.errorType, "read_only_agent_unavailable");
    assert.equal(unavailablePipeline.status, "awaiting_finalization");
    selfTestHooks.pipelineGateExecutorTestHook = gate(async () => {});
    const retried = await finalizePipelineRecord(unavailablePipeline);
    assert.equal(retried.ok, true, "Finalizing again after the provider recovers completes the pipeline.");

    selfTestHooks.pipelineGateExecutorTestHook = gate(async () => {}, { stdout: "Blocking bug.\nGATE_VERDICT: fail" });
    const failingPipeline = pipelineRecord("review-final-gate-fail", { status: "awaiting_finalization", reviewerJob: { agent: "reviewer", task: "Review." } });
    await persistPipelineRecord(failingPipeline);
    assert.equal((await finalizePipelineRecord(failingPipeline)).errorType, "pipeline_gate_verdict_fail");
    assert.equal(failingPipeline.status, "failed", "GATE_VERDICT: fail stays terminal.");
  } finally {
    selfTestHooks.pipelineGateExecutorTestHook = previousGate;
  }
  const state = await captureIntegrationTargetState(repo);
  assert.match(trackedTargetStateSha256(state), /^[a-f0-9]{64}$/);
});

test("8: concurrent item updates both land; the journal decides a crashed integration at finalize and refresh", async () => {
  const concurrent = pipelineRecord("review-concurrent-items", { integrationQueue: [{ jobId: "a", status: "pending" }, { jobId: "b", status: "pending" }] });
  await persistPipelineRecord(concurrent);
  const markIntegrated = (jobId) => updatePipelineRecord(concurrent, (current) => ({
    integrationQueue: current.integrationQueue.map((item) => item.jobId === jobId ? { ...item, status: "integrated" } : item),
  }));
  await Promise.all([markIntegrated("a"), markIntegrated("b")]);
  assert.deepEqual((await readPersistedPipelineRecord(concurrent.pipelineId, repo)).integrationQueue.map((item) => item.status), ["integrated", "integrated"]);

  await resetRepo();
  const crashed = pipelineRecord("review-crashed-integration", {
    integrationQueue: [{ jobId: "job-c", status: "integrating", operationId: "op-crashed", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) }],
  });
  await persistPipelineRecord(crashed);
  await insertJournalOperation({ operationId: "op-crashed", pipelineId: crashed.pipelineId, jobId: "job-c", status: "committed", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) });
  const finalized = await finalizePipelineRecord(crashed, { skipReviewers: true });
  assert.equal(finalized.ok, true, JSON.stringify({ errorType: finalized.errorType, errors: crashed.errors }));
  assert.equal(crashed.integrationQueue[0].status, "integrated");

  const refreshed = pipelineRecord("review-refresh-journal", {
    integrationQueue: [{ jobId: "job-r", status: "integrating", operationId: "op-refresh", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) }],
  });
  await persistPipelineRecord(refreshed);
  await insertJournalOperation({ operationId: "op-refresh", pipelineId: refreshed.pipelineId, jobId: "job-r", status: "committed", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) });
  const viewed = JSON.parse(textOf(await callTool("get_multi_agent_pipeline", { pipelineId: refreshed.pipelineId, cwd: repo })));
  assert.equal(viewed.integrationQueue[0].status, "integrated");
  assert.equal(viewed.status, "awaiting_finalization");

  const requalified = pipelineRecord("review-requalified-quarantine", {
    integrationQueue: [{ jobId: "job-q", status: "quarantined", operationId: "op-requalified", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) }],
  });
  await persistPipelineRecord(requalified);
  await insertJournalOperation({ operationId: "op-requalified", pipelineId: requalified.pipelineId, jobId: "job-q", status: "recovered_noop", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) });
  const requalifiedView = JSON.parse(textOf(await callTool("get_multi_agent_pipeline", { pipelineId: requalified.pipelineId, cwd: repo })));
  assert.equal(requalifiedView.integrationQueue[0].status, "pending", "A requalified quarantine can be integrated again.");
});

test("20: a finalize dry run takes no repository lease and persists nothing", async () => {
  const dry = pipelineRecord("review-dry-run-finalize", {
    integrationQueue: [{ jobId: "job-d", status: "integrating", operationId: "op-dry", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) }],
  });
  await persistPipelineRecord(dry);
  await insertJournalOperation({ operationId: "op-dry", pipelineId: dry.pipelineId, jobId: "job-d", status: "committed", patchSha256: "p".repeat(64), sourceStateSha256: "s".repeat(64) });
  const countFinalizerRuns = async () => {
    const db = await openLockDb(repo);
    try { return Number(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE agent = 'pipeline_finalizer'").get().count); } finally { closeDb(db); }
  };
  const runsBefore = await countFinalizerRuns();
  const revisionBefore = (await readPersistedPipelineRecord(dry.pipelineId, repo)).revision;
  const result = await finalizePipelineRecord(dry, { skipReviewers: true, dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result.errorType));
  assert.equal(result.dryRun, true);
  assert.equal(await countFinalizerRuns(), runsBefore, "A dry run must not take the repository lease.");
  const durable = await readPersistedPipelineRecord(dry.pipelineId, repo);
  assert.equal(durable.revision, revisionBefore);
  assert.equal(durable.integrationQueue[0].status, "integrating");
  assert.equal(dry.status, "awaiting_integration");
});

test("19: a worktree registered with git but missing on disk is not reported as removed", async () => {
  await resetRepo();
  const source = await writerWorktree("review-registered");
  await rm(source.worktree.path, { recursive: true, force: true });
  await git(["update-ref", "-d", `refs/heads/${source.worktree.branch}`]);
  const results = await finalizePipelineSourceCleanup(pipelineRecord("review-registered", {
    integrationQueue: [pipelineItem("job-reg", source, { status: "integrated", cleanupRequested: true })],
  }));
  assert.equal(results[0].cleanup, "retained_for_review", JSON.stringify(results));
  assert.equal(results[0].reason, "cleanup_identity_ambiguous_after_restart");
  await git(["worktree", "prune"]);
});

test("21: cleanup recovery removes the authorized worktree although another item finalized as retained", async () => {
  await resetRepo();
  const authorized = await writerWorktree("review-resume-a");
  const retained = await writerWorktree("review-resume-b");
  const authorization = {
    worktreePath: authorized.worktree.path,
    branch: authorized.worktree.branch,
    sourceBaseCommit: authorized.identity.sourceBaseCommit,
    patchSha256: authorized.identity.patchSha256,
    sourceStateSha256: authorized.identity.sourceStateSha256,
  };
  const targetState = await captureIntegrationTargetState(repo);
  const record = pipelineRecord("review-resume-cleanup", {
    status: "cleanup_pending",
    cleanupPending: true,
    cleanupState: "authorized",
    integrationQueue: [
      pipelineItem("job-a", authorized, { status: "integrated", cleanupRequested: true }),
      pipelineItem("job-b", retained, { status: "integrated", cleanupRequested: true }),
    ],
    sourceCleanupResults: [
      { ...authorization, cleanup: "authorized" },
      { worktreePath: retained.worktree.path, cleanup: "retained_for_review", reason: "integration_source_changed_after_review" },
    ],
    events: [{
      type: "source_cleanup_authorized",
      at: new Date().toISOString(),
      targetStateSha256: targetState.targetStateSha256,
      ...(trackedTargetStateSha256 ? { trackedTargetStateSha256: trackedTargetStateSha256(targetState) } : {}),
      worktrees: [authorization],
    }],
  });
  await persistPipelineRecord(record);
  const resumed = await resumeAuthorizedPipelineCleanup(record);
  assert.equal(resumed.ok, true);
  assert.equal(existsSync(authorized.worktree.path), false, JSON.stringify(record.sourceCleanupResults));
  assert.equal(existsSync(retained.worktree.path), true);
  assert.equal(record.sourceCleanupResults.find((result) => result.worktreePath === retained.worktree.path).reason, "integration_source_changed_after_review");
  await cleanupWorktree(retained.worktree, "always", true);
});

test("22: pipeline gates read the integrated checkout and use a job id per attempt", async () => {
  const previousGate = selfTestHooks.pipelineGateExecutorTestHook;
  const calls = [];
  selfTestHooks.pipelineGateExecutorTestHook = async (job, options) => {
    calls.push({ job, jobId: options.jobId });
    return { result: { errorType: null, changedFiles: [], stdout: "ok\nGATE_VERDICT: pass" }, validation: { disallowedFiles: [] }, response: { content: [{ type: "text", text: "ok" }] } };
  };
  try {
    const record = pipelineRecord("review-gate-identity");
    await runPipelineReadOnlyGate(record, "reviewer", { agent: "reviewer", task: "Review." });
    await runPipelineReadOnlyGate(record, "reviewer", { agent: "reviewer", task: "Review." });
  } finally {
    selfTestHooks.pipelineGateExecutorTestHook = previousGate;
  }
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].jobId, calls[1].jobId);
  assert.ok(calls.every((call) => call.jobId.endsWith("-reviewer") && call.job.noWorktree === true && call.job.cwd === repo));
  assert.equal(shouldUseWorktree(calls[0].job, { lockType: "read" }, "all"), false);
  assert.equal(shouldUseWorktree({ noWorktree: true }, { lockType: "write" }, "all"), true, "The flag never removes a writer's isolation.");
});

test("4: run_opencode_agent passes allowFallbackToBuild, subagentStrategy and proxyAgent to routing", async () => {
  const resolveCalls = [];
  installRuntime({ resolveCalls });
  await callTool("run_opencode_agent", { agent: "reviewer", task: "Route.", cwd: repo, dryRun: true, allowFallbackToBuild: true, subagentStrategy: "proxy", proxyAgent: "architect" });
  assert.deepEqual(resolveCalls.at(-1), { requestedAgent: "reviewer", allowFallbackToBuild: true, subagentStrategy: "proxy", proxyAgent: "architect" });
});

test("5: queue assessment judges a reader by its read scope and a writer never conflicts with itself", async () => {
  const writerId = "review-running-writer";
  QUEUE_JOBS.set(writerId, { jobId: writerId, status: "running", mode: "write", cwd: repo, agent: "builder", lockedPaths: ["src/b.txt"], allowedEdits: ["src/b.txt"] });
  try {
    const self = await assessQueuePlan([{ jobId: writerId, lockType: "write", cwd: repo, lockedPaths: ["src/b.txt"], allowedEdits: ["src/b.txt"] }]);
    assert.equal(self.status, "can_run_immediately", self.reason);
    installRuntime();
    const text = textOf(await callTool("enqueue_opencode_job", {
      agent: "reviewer", task: "Review a.", cwd: repo, write: false, lockMode: "off", scopeContract: { mode: "read", read: ["src/a.txt"] },
    }));
    assert.match(text, /Queue assessment: can_run_immediately/, text);
    const jobId = /Job ID: (\S+)/.exec(text)[1];
    const deadline = Date.now() + 15000;
    while (!["completed", "failed", "cancelled"].includes(QUEUE_JOBS.get(jobId)?.status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    QUEUE_JOBS.delete(writerId);
  }
});

test("10: get_opencode_job derives the stage and agent time of a running sqlite job", async () => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let spawned;
  const spawnedPromise = new Promise((resolve) => { spawned = resolve; });
  installRuntime({ onRun: async ({ options }) => {
    await options.onSpawn?.({ pid: process.pid, startedAt: new Date().toISOString(), processRole: "agent", containmentIdentity: "" });
    spawned();
    await released;
  } });
  const text = textOf(await callTool("enqueue_opencode_job", { agent: "reviewer", task: "Long review.", cwd: repo, write: false, lockMode: "off" }));
  const jobId = /Job ID: (\S+)/.exec(text)[1];
  try {
    await spawnedPromise;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId, cwd: repo })));
    assert.equal(view.runStage, "agent_running");
    assert.ok(view.agentRunMs >= 1000, JSON.stringify(view));
  } finally {
    release();
  }
  const deadline = Date.now() + 15000;
  while (!["completed", "failed", "cancelled"].includes(QUEUE_JOBS.get(jobId)?.status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
});

test("6: pipeline jobs without a cwd belong to the pipeline repository; foreign children are rejected", async () => {
  const reader = { agent: "reviewer", task: "Review.", write: false, lockType: "read", lockMode: "off" };
  const created = textOf(await callTool("create_multi_agent_pipeline", { name: "review-default-cwd", cwd: flipCase(repo), usePolicy: false, jobs: [reader, { ...reader, cwd: path.join(repo, "src") }] }));
  assert.match(created, /^Multi-agent pipeline created\./, created);
  const foreign = textOf(await callTool("create_multi_agent_pipeline", { name: "review-foreign", cwd: repo, usePolicy: false, jobs: [reader, { ...reader, cwd: otherRepo }] }));
  assert.match(foreign, /pipeline_multi_repository_unsupported/);
});

test("11: provider capacity is per provider key and validate_delegation_plan enforces it", async () => {
  const readJob = (task) => ({ agent: "reviewer", task, write: false, lockMode: "off" });
  assert.equal(parallelBatchCapacityError([readJob("a"), readJob("b"), readJob("c")], ["k:a", "k:a", "k:b"]), null);
  assert.equal(parallelBatchCapacityError([readJob("a"), readJob("b"), readJob("c")], ["k:a", "k:a", "k:a"]).errorType, "parallel_batch_exceeds_provider_capacity");
  installRuntime();
  const jobs = ["reviewer", "tester", "planner"].map((agent) => ({ agent, task: "Read.", cwd: repo, write: false, lockMode: "off" }));
  const rejected = textOf(await callTool("validate_delegation_plan", { jobs }));
  assert.match(rejected, /parallel_batch_exceeds_provider_capacity/, rejected);
  installRuntime({ providerFor: (agent) => (agent === "tester" ? "provider-b" : "provider-a") });
  const accepted = textOf(await callTool("validate_delegation_plan", { jobs }));
  assert.match(accepted, /^Delegation plan accepted\./, accepted);
  await resetRepo();
  const ran = textOf(await callTool("run_opencode_parallel", { jobs }));
  assert.match(ran, /Parallel group status: completed/, ran);
});

test("12: cancelling a pending pipeline child reconciles its parent pipeline", async () => {
  const pipelineId = "review-cancel-parent";
  await persistPipelineRecord(pipelineRecord(pipelineId, { status: "running" }));
  PIPELINE_RUNS.delete(pipelineId);
  const enqueued = await enqueueQueueJob({ agent: "reviewer", task: "Wait.", cwd: repo, write: false, lockMode: "off" }, pipelineId, { schedule: false });
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const text = textOf(await callTool("cancel_opencode_job", { jobId: enqueued.record.jobId, cwd: repo }));
  assert.match(text, /cancelled: .*durable status: cancelled/, text);
  assert.equal(PIPELINE_RUNS.has(pipelineId), true, "The parent pipeline was re-read after the child became terminal.");
});

test("13: parallel writers in different repositories may use the same relative paths", async () => {
  const job = (cwd) => ({ agent: "builder", task: "Edit.", cwd, write: true, lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]) });
  assert.equal(validateParallelWritePlan([job(repo), job(otherRepo)]).error, null);
  assert.equal(validateParallelWritePlan([job(repo), job(repo)]).errorType, "parallel_plan_rejected");
});

test("14: bracketed real paths are not wildcards and git treats bridge paths literally", async () => {
  assert.equal(hasAmbiguousPathPattern(["app/[slug]/page.tsx"], repo), false);
  assert.equal(hasAmbiguousPathPattern(["app/[missing]/page.tsx"], repo), true);
  assert.equal(hasAmbiguousPathPattern(["src/*.txt"], repo), true);
  assert.equal(buildTrustedGitEnv().GIT_LITERAL_PATHSPECS, "1");
  const listed = (await git(["ls-files", "--", "app/[slug]/page.tsx"])).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(listed, ["app/[slug]/page.tsx"], "A glob pathspec would also match app/s/page.tsx.");
});

test("15: rotating the contractor authorization hash revokes queued contractor proofs", async () => {
  const previous = selfTestHooks.selfTestContractorAuthorizationSha256;
  try {
    selfTestHooks.selfTestContractorAuthorizationSha256 = sha("token-one");
    const proof = makeInternalQueueContractorProof("contractor-job");
    const job = { internalQueueJobId: "contractor-job", internalQueueContractorProof: proof };
    assert.equal(contractorAuthorizationValid(job), true);
    selfTestHooks.selfTestContractorAuthorizationSha256 = sha("token-two");
    assert.equal(contractorAuthorizationValid(job), false);
    assert.equal(makeInternalQueueContractorProof("contractor-job", proof), "", "Recovery must not re-authorize under the new hash.");
    selfTestHooks.selfTestContractorAuthorizationSha256 = sha("token-one");
    assert.equal(contractorAuthorizationValid({ ...job, internalQueueContractorProof: makeInternalQueueContractorProof("contractor-job", proof) }), true);
    selfTestHooks.selfTestContractorAuthorizationSha256 = "";
    assert.equal(contractorAuthorizationValid(job), false, "Removing the configured hash revokes every proof.");
  } finally {
    selfTestHooks.selfTestContractorAuthorizationSha256 = previous;
  }
});

// Last job test: it breaks the state directory under a running job.
test("9: a job whose state writes fail still stops its heartbeat, reports the release, and returns", async () => {
  await resetRepo();
  const brokenState = path.join(scratch, "state-is-a-file");
  await writeFile(brokenState, "not a directory", "utf8");
  installRuntime({ onRun: async ({ cwd }) => {
    await writeFile(path.join(cwd, "src", "a.txt"), "edited before the state broke\n", "utf8");
    selfTestHooks.stateDirectoryOverride = brokenState;
  } });
  let execution;
  try {
    execution = await executeOpenCodeJob({
      agent: "builder", task: "Edit a.", cwd: repo, write: true, lockMode: "simple",
      lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]),
    });
  } finally {
    selfTestHooks.stateDirectoryOverride = stateDir;
  }
  assert.equal(execution.result.errorType, "job_infrastructure_failed");
  assert.match(textOf(execution.response), /Temporary lock released: no \(/);
  assert.equal(execution.result.lockRelease.released, false);
  const db = await openLockDb(repo);
  try { db.prepare("DELETE FROM locks WHERE normalized_path = 'src/a.txt'").run(); } finally { closeDb(db); }
  if (execution.result.worktree?.path) await cleanupWorktree({ ...execution.result.worktree, repoRoot: repo }, "always", true);
});

// G-11: an abandoned pipeline never integrates, and abandonment cannot slip past a reservation.
test("G-11: an abandoned pipeline refuses a dry run and a receipt taken before; nothing is applied and it stays cancelled", async () => {
  await resetRepo();
  const source = await writerWorktree("g11-abandoned", { "src/a.txt": "g11 change\n" });
  const pipelineId = "review-pipeline-g11-abandoned";
  await persistPipelineRecord(pipelineRecord(pipelineId, { integrationQueue: [pipelineItem("job-g11", source)] }));
  const args = { cwd: repo, pipelineId, worktreePath: source.worktree.path, allowedEdits: ["src"] };
  const preview = textOf(await callTool("integrate_opencode_worktree", { ...args, dryRun: true }));
  assert.match(preview, /Serial integration accepted./, preview);
  const receipt = JSON.parse(/Preview receipt: ({.*})/.exec(preview)[1]);
  const abandoned = textOf(await callTool("abandon_multi_agent_pipeline", { cwd: repo, pipelineId, confirmation: pipelineId, reason: "G-11 test" }));
  assert.match(abandoned, /^Multi-agent pipeline abandoned./, abandoned);
  const applied = textOf(await callTool("integrate_opencode_worktree", { ...args, reviewed: true, previewReceipt: receipt }));
  assert.match(applied, /pipeline_terminal/, applied);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(path.join(repo, "src", "a.txt"), "utf8"), "a\n", "the abandoned pipeline changed the checkout");
  const again = textOf(await callTool("integrate_opencode_worktree", { ...args, dryRun: true }));
  assert.match(again, /pipeline_terminal/, again);
  const persisted = await readPersistedPipelineRecord(pipelineId, repo);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.integrationQueue[0].status, "pending", "the item is left as it was");
  await cleanupWorktree(source.worktree, "always", true);
});

test("G-11: abandonment that races an integration reservation is refused, and the integration completes", async () => {
  await resetRepo();
  const source = await writerWorktree("g11-race", { "src/a.txt": "g11 race\n" });
  const pipelineId = "review-pipeline-g11-race";
  await persistPipelineRecord(pipelineRecord(pipelineId, { integrationQueue: [pipelineItem("job-g11-race", source)] }));
  const args = { cwd: repo, pipelineId, worktreePath: source.worktree.path, allowedEdits: ["src"] };
  const preview = textOf(await callTool("integrate_opencode_worktree", { ...args, dryRun: true }));
  const receipt = JSON.parse(/Preview receipt: ({.*})/.exec(preview)[1]);
  // Hold the reservation write open; abandonment passes its first check meanwhile and queues its write behind it.
  let reached;
  const reservationReached = new Promise((resolve) => { reached = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const previousHook = selfTestHooks.pipelinePersistenceTestHook;
  selfTestHooks.pipelinePersistenceTestHook = async (candidate) => {
    if (candidate?.pipelineId === pipelineId && candidate.events?.at(-1)?.type === "integration_prepared") {
      reached();
      await gate;
    }
  };
  try {
    const applying = callTool("integrate_opencode_worktree", { ...args, reviewed: true, previewReceipt: receipt });
    await reservationReached;
    const abandoning = callTool("abandon_multi_agent_pipeline", { cwd: repo, pipelineId, confirmation: pipelineId, reason: "G-11 race" });
    await new Promise((resolve) => setTimeout(resolve, 750));
    release();
    const [appliedText, abandonText] = [textOf(await applying), textOf(await abandoning)];
    assert.match(abandonText, /pipeline_integration_in_progress|pipeline_concurrent_update/, abandonText);
    assert.match(appliedText, /Status: applied/, appliedText);
    const persisted = await readPersistedPipelineRecord(pipelineId, repo);
    assert.notEqual(persisted.status, "cancelled", "a refused abandonment must not cancel the pipeline");
    assert.equal(persisted.integrationQueue[0].status, "integrated");
  } finally {
    release();
    selfTestHooks.pipelinePersistenceTestHook = previousHook;
    await resetRepo();
    await cleanupWorktree(source.worktree, "always", true);
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    } finally {
      selfTestHooks.agentRuntimeTestHook = null;
    }
  }
} finally {
  selfTestHooks.stateDirectoryOverride = stateDir;
  for (const directory of [repo, otherRepo, scratch, stateDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} review regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} review regression tests passed.\n`);
process.exit(0);
