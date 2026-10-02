#!/usr/bin/env node

// Production review of HEAD 0a3a2ee (log.md B-110..B-118): the write-safety and containment gaps
// a read-only review found in the core. Git, worktrees, locks and the validation gates are real;
// only the agent run is the agentRuntimeTestHook, and the validation gate's process-tree verdict
// is the executeJobTestHooks wrapper (the supervisor cannot be made to fail on demand). Everything
// lives in scratch folders, and the bridge state directory is isolated.
//   node tests/review-prod-core.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "4";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_ISSUE_LOG;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-prod-core");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { executeJobTestHooks } = await import("../lib/execute-job.js");
const { filesystemCaseModeForRoot, isWithinAnyPath, unsafeChangedFiles } = await import("../lib/paths.js");
const { redactCliText } = await import("../bin/ops-log.js");
const { hooks, internals } = __selfTest;
const {
  assert,
  captureTargetState,
  enqueueQueueJob,
  listLocks,
  mkdir,
  path,
  redactLikelySecrets,
  redactSensitiveText,
  targetStateChanges,
  validateChangedFilesForPlan,
  validateParallelWritePlan,
  validateSingleLockPlan,
  writeFile,
} = internals;

const fixture = await makeFlexFixture(__selfTest, "review-prod-core");
const { root, repo, git, identity, writeJob, writeScope, callTool, textOf } = fixture;
// A Next.js-style literal path with brackets, and a second commit for the ref tests.
await mkdir(path.join(repo, "app", "[slug]"), { recursive: true });
await writeFile(path.join(repo, "app", "[slug]", "page.tsx"), "export default 1;\n", "utf8");
await mkdir(path.join(repo, "Tools", "Validators"), { recursive: true });
await writeFile(path.join(repo, "Tools", "Validators", "check.cjs"), "process.exit(0);\n", "utf8");
await git(["add", "."]);
await git([...identity, "commit", "-q", "-m", "app and tools"]);

const errorTypeOf = (text) => /^Error type: (\S+)/m.exec(text)?.[1] || /errorType: (\S+)/.exec(text)?.[1] || "";
const plainPlan = (extra = {}) => ({ agent: "builder", cwd: repo, lockType: "write", lockedPaths: ["src"], allowedEdits: ["src/a.txt"], forbiddenEdits: [], sharedFiles: [], serialOnly: [], scopeContract: null, ...extra });

// The agent run: writes `files` into the directory it runs in (the job's worktree).
function installAgentRuntime(files) {
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: agent === "builder" || agent === "debugger", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun) => {
      const childStartedAtMs = Date.now();
      if (!dryRun) {
        for (const [relative, content] of Object.entries(files)) {
          await mkdir(path.dirname(path.join(cwd, ...relative.split("/"))), { recursive: true });
          await writeFile(path.join(cwd, ...relative.split("/")), content, "utf8");
        }
      }
      return {
        exitCode: 0, stdout: "REPORT: done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1,
      };
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------------------------- B-110
test("B-110: an agent job may not request lockType serial_integration (single, parallel, queue, tool)", async () => {
  for (const lockType of ["serial_integration", "serial", "integration"]) {
    const single = validateSingleLockPlan({ agent: "builder", task: "edit", cwd: repo, lockType, lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
    assert.equal(single.errorType, "lock_type_reserved", `${lockType}: ${JSON.stringify(single.error)}`);
    assert.match(single.error, /bridge's own integration lock; use write/);
  }
  const parallel = validateParallelWritePlan([
    writeJob("src/a.txt", { lockedPaths: ["src/a.txt"] }),
    { agent: "builder", task: "edit", cwd: repo, lockType: "serial_integration", lockedPaths: ["src/b.txt"], allowedEdits: ["src/b.txt"] },
  ]);
  assert.equal(parallel.errorType, "lock_type_reserved", parallel.error);
  const queued = await enqueueQueueJob({ agent: "builder", task: "edit", cwd: repo, lockType: "serial_integration", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"] });
  assert.equal(queued.ok, false);
  assert.equal(queued.errorType, "lock_type_reserved");
  const text = textOf(await callTool("run_opencode_agent", { agent: "builder", task: "edit", cwd: repo, lockType: "serial_integration", lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], dryRun: true }));
  assert.match(text, /lock_type_reserved/);
  // A plain write job is unaffected.
  assert.equal(validateSingleLockPlan(writeJob("src/a.txt")).error, null);
});

test("B-110: the changed-file check holds every non-read lock type to allowedEdits", () => {
  for (const lockType of ["write", "serial_integration", "anything_else"]) {
    const validation = validateChangedFilesForPlan({ changedFiles: ["src/a.txt", "src/b.txt"], lockPlan: plainPlan({ lockType }) });
    assert.deepEqual(validation.disallowedFiles, ["src/b.txt"], lockType);
  }
  const reader = validateChangedFilesForPlan({ changedFiles: ["src/a.txt"], lockPlan: plainPlan({ lockType: "read", allowedEdits: [] }) });
  assert.deepEqual(reader.disallowedFiles, ["src/a.txt"], "a reader may change nothing");
});

// ------------------------------------------------------------------------------------- B-111
test("B-111: an allowed path that names an existing bracket path is compared literally", () => {
  const literal = "app/[slug]/page.tsx";
  assert.equal(isWithinAnyPath(literal, [literal], repo), true, "the named file is allowed");
  assert.equal(isWithinAnyPath("app/s/page.tsx", [literal], repo), false, "a file the bracket would match as a glob is not");
  assert.deepEqual(unsafeChangedFiles(["app/s/page.tsx", literal], [literal], repo), ["app/s/page.tsx"]);
  assert.equal(isWithinAnyPath(literal, ["app/[slug]"], repo), true, "a literal directory covers its files");
  assert.equal(isWithinAnyPath("app/s/page.tsx", ["app/[slug]"], repo), false);
  const validation = validateChangedFilesForPlan({ changedFiles: [literal, "app/s/page.tsx"], lockPlan: plainPlan({ lockedPaths: ["app"], allowedEdits: [literal] }) });
  assert.deepEqual(validation.disallowedFiles, ["app/s/page.tsx"]);
});

test("B-111: a bracket entry that names nothing stays a glob, and still matches its own spelling", () => {
  assert.equal(isWithinAnyPath("src/a.txt", ["src/[ab].txt"], repo), true, "no src/[ab].txt exists: a glob");
  assert.equal(isWithinAnyPath("src/c.txt", ["src/[ab].txt"], repo), false);
  assert.equal(isWithinAnyPath("src/[ab].txt", ["src/[ab].txt"], repo), true, "the spelled path itself");
  // Forbidden globs keep matching.
  assert.equal(isWithinAnyPath("src/.env", ["**/.env"], repo), true);
  assert.equal(isWithinAnyPath("deep/dir/secrets/x.txt", ["**/secrets/**"], repo), true);
  // Without a checkout the entry cannot be looked up: glob, as before.
  assert.equal(isWithinAnyPath("app/s/page.tsx", ["app/[slug]/page.tsx"]), true);
});

// ------------------------------------------------------------------------------------- B-112
test("B-112: a self-check script inside allowedEdits is refused whatever its case on a case-insensitive checkout", () => {
  const job = (command) => ({
    agent: "builder", task: "edit", cwd: repo, write: true, lockMode: "simple", lockedPaths: ["Tools"], allowedEdits: ["Tools/Validators"],
    scopeContract: { mode: "write", read: ["Tools"], write: ["Tools/Validators"], allowedEdits: ["Tools/Validators"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: [command] },
  });
  assert.equal(validateSingleLockPlan(job("node Tools/Validators/check.cjs")).errorType, "self_check_script_editable");
  if (filesystemCaseModeForRoot(repo) === "insensitive") {
    assert.equal(validateSingleLockPlan(job("node tools/validators/check.cjs")).errorType, "self_check_script_editable", "the stored allowedEdits are lowercased; the command's spelling must not matter");
    assert.equal(validateSingleLockPlan(job("node TOOLS/VALIDATORS/check.cjs")).errorType, "self_check_script_editable");
  }
  assert.equal(validateSingleLockPlan(job("node src/a.txt")).error, null, "a script outside allowedEdits is accepted");
});

// ------------------------------------------------------------------------------------- B-115
test("B-115: a parallel job's own verdict lists a forbidden file it wrote, not only the group check", async () => {
  // lib2, not src: src overlaps the default serial-only src/routes/** in a parallel plan.
  installAgentRuntime({ "lib2/a.txt": "edited\n", "lib2/.env": "TOKEN=1\n" });
  const job = writeJob("lib2", { lockedPaths: ["lib2"], allowedEdits: ["lib2"], scopeContract: { ...writeScope("lib2"), read: ["lib2"], forbidden: [] } });
  const text = textOf(await callTool("run_opencode_parallel", { jobs: [job] }));
  assert.match(text, /Unsafe changed files: .*lib2\/\.env/, text.slice(0, 4000));
  assert.doesNotMatch(text, /Unsafe changed files: none detected/);
  const runId = /JOB 1\nRun id: (\S+)/.exec(text)?.[1];
  assert.ok(runId, text.slice(0, 2000));
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo })));
  assert.ok(view.errorType, `the stored Run-id record carries an errorType: ${JSON.stringify(view).slice(0, 1500)}`);
  assert.match(view.resultText, /lib2\/\.env/);
  hooks.agentRuntimeTestHook = null;
});

// ------------------------------------------------------------------------------------- B-116
test("B-116: the target guard sees ref changes (tag, branch -f, HEAD) but not the bridge's own worktree branches", async () => {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const parent = (await git(["rev-parse", "HEAD~1"])).trim();
  await git(["branch", "side", head]);
  await git(["branch", "agent/builder/existing", head]);
  const before = await captureTargetState(repo, []);
  assert.equal(before.ok, true, before.error);
  assert.deepEqual(targetStateChanges(before, await captureTargetState(repo, [])), [], "nothing changed");

  await git(["branch", "agent/builder/new-job", head]);
  assert.deepEqual(targetStateChanges(before, await captureTargetState(repo, [])), [], "a new worktree branch of another job is the bridge's");
  await git(["tag", "t-b116"]);
  await git(["branch", "-f", "side", parent]);
  await git(["branch", "-f", "agent/builder/existing", parent]);
  const changed = targetStateChanges(before, await captureTargetState(repo, []));
  assert.deepEqual(changed, ["refs/heads/agent/builder/existing", "refs/heads/side", "refs/tags/t-b116"]);
  await git(["checkout", "-q", "--detach", parent]);
  try {
    assert.ok(targetStateChanges(before, await captureTargetState(repo, [])).includes("HEAD"), "a moved HEAD");
  } finally {
    await git(["checkout", "-q", "-"]);
    await git(["tag", "-d", "t-b116"]);
    await git(["branch", "-D", "side", "agent/builder/existing", "agent/builder/new-job"]);
  }
});

test("B-116: a failed capture is not a clean result", async () => {
  const outside = path.join(root, "not-a-repo");
  await mkdir(outside, { recursive: true });
  const failed = await captureTargetState(outside, []);
  assert.equal(failed.ok, false);
  assert.ok(failed.error, "the git error is kept for the report");
  assert.deepEqual(targetStateChanges(await captureTargetState(repo, []), failed), [], "the caller must look at ok, not at the empty list");
});

// ------------------------------------------------------------------------------------- B-117
test("B-117: the new token shapes are removed by both redactors and the CLI copy", () => {
  const samples = {
    "glpat-G05gitlabTokenValue12345": "G05gitlabTokenValue12345",
    "hf_G05huggingFaceTokenValue1234567890ab": "G05huggingFaceTokenValue1234567890ab",
    "GOCSPX-G05googleClientSecret12345": "G05googleClientSecret12345",
    "xapp-1-A0G05-1234567890-G05slackAppToken": "G05slackAppToken",
    "SG.G05sendgridKeyIdAB.G05sendgridSecretValue12345": "G05sendgridSecretValue12345",
    "pypi-AgEIcHlwaS5vcmcG05pypiTokenValue123456": "G05pypiTokenValue123456",
    "AccountName=g05;AccountKey=G05azureAccountKeyValue0123456789abcdefABCDEFGHIJKLMNOPqrstuv==;EndpointSuffix=core.windows.net": "G05azureAccountKeyValue0123456789abcdefABCDEFGHIJKLMNOPqrstuv",
    "Endpoint=sb://g05.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=G05sasKeyValue0123456789abcdefABCDEFGHIJ=": "G05sasKeyValue0123456789abcdefABCDEFGHIJ",
  };
  for (const [line, secret] of Object.entries(samples)) {
    for (const [name, redact] of [["redactLikelySecrets", redactLikelySecrets], ["redactSensitiveText", redactSensitiveText], ["redactCliText", redactCliText]]) {
      assert.ok(!redact(`value ${line} end`).includes(secret), `${name} kept ${secret}`);
    }
  }
  // Ordinary text with the same prefixes is left alone by the narrow redactor.
  const ordinary = "hf_model = load()\nSG.init()\nxapp-config\nglpat-short\nAccountKey=short";
  assert.equal(redactLikelySecrets(ordinary), ordinary);
});

// ------------------------------------------------------------------------------------- B-118
test("B-118: integrate_opencode_worktrees refuses a batch that lands a caller serial-only path", async () => {
  let count = 0;
  const worktree = async (edits) => {
    count += 1;
    const dir = path.join(root, `batch-wt-${count}`);
    await git(["worktree", "add", "-q", "--detach", dir, "HEAD"]);
    for (const [relative, content] of Object.entries(edits)) {
      await mkdir(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
      await writeFile(path.join(dir, ...relative.split("/")), content, "utf8");
    }
    return dir;
  };
  const one = await worktree({ "out/one.json": "[1]\n" });
  const two = await worktree({ "db/migrations/0001.sql": "create table t (id int);\n" });
  const items = [{ worktreePath: one, allowedEdits: ["out"] }, { worktreePath: two, allowedEdits: ["db"] }];
  const refused = textOf(await callTool("integrate_opencode_worktrees", { cwd: repo, dryRun: true, previewMode: "stat", items, serialOnly: ["db/migrations/**"] }));
  assert.match(refused, /serial_only_parallel_write/, refused.slice(0, 3000));
  assert.match(refused, /db\/migrations\/0001\.sql/);
  const alone = textOf(await callTool("integrate_opencode_worktrees", { cwd: repo, dryRun: true, previewMode: "stat", items: [items[1]], serialOnly: ["db/migrations/**"] }));
  assert.doesNotMatch(alone, /serial_only_parallel_write/, "a batch of one is a serial integration");
  const unnamed = textOf(await callTool("integrate_opencode_worktrees", { cwd: repo, dryRun: true, previewMode: "stat", items }));
  assert.doesNotMatch(unnamed, /serial_only_parallel_write/, "only the paths the caller names");
});

// ------------------------------------------------------------------------------------- B-113
// Last: the quarantined lock stays on q/ until an operator resolves it.
test("B-113: a validation tree that could not be confirmed ended quarantines the job's lock", async () => {
  installAgentRuntime({ "q/x.txt": "x\n" });
  executeJobTestHooks.validationGate = async (real, options) => ({
    ...(await real(options)),
    status: "failed",
    exitCode: "timeout",
    errorType: "validation_process_tree_unconfirmed",
    processTreeUnconfirmed: true,
    supervisorProcessId: 0,
    payloadProcessId: 0,
  });
  try {
    const job = writeJob("q/x.txt", { lockedPaths: ["q"], allowedEdits: ["q/x.txt"], scopeContract: { ...writeScope("q/x.txt"), read: ["q"] } });
    const text = textOf(await callTool("run_opencode_agent", { ...job, detail: true }));
    assert.equal(errorTypeOf(text), "validation_process_tree_unconfirmed", text.slice(0, 3000));
    assert.match(text, /Temporary lock released: no \(containment quarantined/, text.slice(0, 4000));
    const held = (await listLocks(repo)).filter((lock) => (lock.paths || []).some((lockPath) => String(lockPath).startsWith("q")));
    assert.ok(held.length, `the lock on q/ is still held: ${JSON.stringify(await listLocks(repo))}`);
  } finally {
    executeJobTestHooks.validationGate = null;
    hooks.agentRuntimeTestHook = null;
  }
});

await runFlexTests({ isolatedStateDir, file: "tests/review-prod-core.js", tests, cleanup: fixture.cleanup, finishSkips, label: "production-review core" });
