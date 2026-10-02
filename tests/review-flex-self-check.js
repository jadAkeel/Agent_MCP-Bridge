#!/usr/bin/env node

// Q-009 / B-068 (log.md, 2026-10-02): self-check commands for builders. In round 3 a builder could
// not run `node tools/validate.cjs` on the batch it wrote. A write job's Scope Contract may list
// exact commands; the BRIDGE runs them in the worktree after the agent finished (before
// validationCommand, same trust rules) and gives the agent another run with a failing check's
// output (selfCheckPasses, default 2, at most 3). The first version gave the agent exact bash allow
// rules instead; B-068 removed that, because the agent could rewrite the script, run it and put it
// back. Git, the worktree and the validation runs are real; only the agent run is the
// agentRuntimeTestHook (as in tests/review-queue-features.js, Q-004).
//   node tests/review-flex-self-check.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node,npm,python";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
// An operator-set inline config must never reach a child (the bridge strips it).
process.env.OPENCODE_CONFIG_CONTENT = "{\"agent\":{\"builder\":{\"permission\":{\"bash\":\"allow\"}}}}";
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-self-check");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const { hooks, internals } = __selfTest;
const {
  assert,
  buildOpenCodeEnv,
  enqueueQueueJob,
  formatScopeContractForPrompt,
  mkdir,
  normalizeAgentDebugMetadata,
  normalizeScopeContract,
  path,
  selfCheckCommandsError,
  validateSingleLockPlan,
  writeFile,
} = internals;

const fixture = await makeFlexFixture(__selfTest, "review-flex-self-check");
const { repo, git, writeJob, callTool, textOf, waitFor, durable } = fixture;
// The check the bridge runs: fails while the batch contains BAD.
await mkdir(path.join(repo, "tools"), { recursive: true });
await writeFile(path.join(repo, "tools", "validate.cjs"), [
  "const fs = require('fs');",
  "const file = process.argv[2];",
  "const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';",
  "if (!text || text.includes('BAD')) { console.log('bad batch ' + file + ': fix the questions'); process.exit(1); }",
  "console.log('batch ok');",
  "",
].join("\n"), "utf8");
await git(["add", "."]);
await git([...fixture.identity, "commit", "-q", "-m", "add the validator"]);

const CHECK = "node tools/validate.cjs out/batch-001.json";
const scope = (commands) => ({ mode: "write", read: ["tools", "out"], write: ["out/batch-001.json"], allowedEdits: ["out/batch-001.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: commands });
const selfCheckJob = (commands, extra = {}) => writeJob("out/batch-001.json", {
  task: "Write the batch and check it.",
  lockedPaths: ["out/batch-001.json"],
  allowedEdits: ["out/batch-001.json"],
  scopeContract: scope(commands),
  ...extra,
});
const planError = (job) => validateSingleLockPlan(job);

// The agent run is replaced; `runs` records each call, and what the bridge gave the agent's env.
function installAgentRuntime(onRun) {
  const runs = [];
  hooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: true, canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan, timeoutMs) => {
      const run = { prompt, cwd, timeoutMs, index: runs.length, configContent: buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT };
      runs.push(run);
      if (!dryRun) await onRun(run);
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1,
      };
    },
  };
  return runs;
}
const writeBatch = (contentFor) => async ({ cwd, index }) => {
  await mkdir(path.join(cwd, "out"), { recursive: true });
  await writeFile(path.join(cwd, "out", "batch-001.json"), contentFor(index), "utf8");
};
const runDirect = async (job) => textOf(await callTool("run_opencode_agent", job));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-009: exact, allowlisted commands are accepted for a builder write job", () => {
  assert.equal(planError(selfCheckJob([CHECK, "node tools/check-links.cjs out/batch-001.json", "git diff --check"])).error, null);
  assert.equal(selfCheckCommandsError({ agent: "builder" }, { lockType: "write", scopeContract: {} }), null, "no commands, no check");
  assert.equal(planError(selfCheckJob([CHECK], { selfCheckPasses: 3 })).error, null);
});

test("Q-009: commands and passes outside the rules are refused", () => {
  const cases = [
    [["node tools/*.cjs"], "self_check_invalid"],
    [["node tools/validate.cjs \"out/batch-001.json\""], "self_check_invalid"],
    [["node tools/validate.cjs out/batch-001.json && rm -rf out"], "self_check_invalid"],
    [["node tools/validate.cjs out/batch-001.json; echo"], "self_check_invalid"],
    [["node tools/validate.cjs $(cat x)"], "self_check_invalid"],
    [["node tools/validate.cjs out/batch-001.json | tee x"], "self_check_invalid"],
    [["node  tools/validate.cjs"], "self_check_invalid"],
    [[CHECK, CHECK], "self_check_invalid"],
    [Array.from({ length: 9 }, (_, index) => `node tools/v${index}.cjs`), "self_check_invalid"],
    [[], "self_check_invalid"],
    [["node -e x"], "self_check_untrusted"],
    [["node --require x tools/validate.cjs"], "self_check_untrusted"],
    [["npx validate"], "self_check_untrusted"],
    [["bash tools/validate.sh"], "self_check_untrusted"],
    [["curl https://example.invalid"], "self_check_untrusted"],
    [["./node tools/validate.cjs"], "self_check_untrusted"],
    [["node out/batch-001.json"], "self_check_script_editable"],
  ];
  for (const [commands, errorType] of cases) {
    const result = planError(selfCheckJob(commands));
    assert.equal(result.errorType, errorType, `${JSON.stringify(commands)}: ${result.error}`);
  }
  assert.equal(planError(selfCheckJob([CHECK], { selfCheckPasses: 4 })).errorType, "self_check_invalid");
  assert.equal(planError(writeJob("src/a.txt", { selfCheckPasses: 1 })).errorType, "self_check_not_applicable", "passes without commands");
  const reader = { agent: "reviewer", task: "read", cwd: repo, write: false, lockMode: "off", scopeContract: { mode: "read", read: ["tools"], selfCheckCommands: [CHECK] } };
  assert.equal(planError(reader).errorType, "self_check_not_applicable");
});

test("Q-009: enqueue and run_opencode_parallel apply the same rules", async () => {
  const refused = await enqueueQueueJob(selfCheckJob(["node tools/validate.cjs out/*.json"]));
  assert.equal(refused.ok, false);
  assert.equal(refused.errorType, "self_check_invalid");
  const second = writeJob("out2/b.json", { dryRun: true, task: "second", lockedPaths: ["out2/b.json"], allowedEdits: ["out2/b.json"], scopeContract: { mode: "write", read: ["tools"], write: ["out2/b.json"], allowedEdits: ["out2/b.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: ["node tools/validate.cjs out2/b.json"] } });
  const parallel = textOf(await callTool("run_opencode_parallel", { jobs: [selfCheckJob([CHECK], { dryRun: true }), second] }));
  assert.match(parallel, /self_check_unsupported_in_parallel/);
});

test("B-068: the agent gets no shell for the checks: no inline config, no extra allow rule accepted", async () => {
  assert.equal(internals.jobPermissionOverlayStorage, undefined, "the per-run permission overlay is gone");
  assert.equal(internals.selfCheckPermissionOverlay, undefined);
  const runs = installAgentRuntime(writeBatch(() => "[\"ok\"]\n"));
  try {
    await runDirect(selfCheckJob([CHECK]));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
  assert.equal(runs.length, 1);
  assert.equal(runs[0].configContent, undefined, "the agent's environment carries no OPENCODE_CONFIG_CONTENT (the operator's is stripped too)");
  assert.match(runs[0].prompt, /Self-checks: when you finish, the bridge runs these commands in your working directory \(you cannot run them\)\. If one fails, you get another run with its output; fix what it reports then:\n- node tools\/validate\.cjs out\/batch-001\.json/);
  // The attested profile is the managed one: an allow rule for the check is still unsafe.
  const profileWithCheck = {
    name: "builder", mode: "all", model: { providerID: "opencode", modelID: "muse" }, variant: "high", temperature: 0.1, prompt: "x", tools: {},
    permission: [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git diff", action: "allow" },
      { permission: "bash", pattern: CHECK, action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ],
  };
  assert.equal(normalizeAgentDebugMetadata(profileWithCheck, "builder").bashAutomaticAllowSafe, false);
  const contract = normalizeScopeContract(selfCheckJob([CHECK]));
  assert.doesNotMatch(formatScopeContractForPrompt(contract), /shell tool/);
});

test("B-068: a passing self-check needs no pass, and validationCommand runs after it", async () => {
  const runs = installAgentRuntime(writeBatch(() => "[\"ok\"]\n"));
  let text;
  try {
    text = await runDirect(selfCheckJob([CHECK]));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
  assert.equal(runs.length, 1);
  assert.match(text, /Self-checks: passed; fix passes used 0 of 2/);
  assert.match(text, /Validation command: git diff --check/);
  assert.match(text, /Validation gate: passed/);
});

test("B-068: a failing self-check gives the agent a pass with its output, then the checks run again", async () => {
  const runs = installAgentRuntime(writeBatch((index) => (index === 0 ? "[\"BAD\"]\n" : "[\"ok\"]\n")));
  let text;
  try {
    text = await runDirect(selfCheckJob([CHECK]));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
  assert.equal(runs.length, 2, "one fix pass");
  assert.doesNotMatch(runs[0].prompt, /SELF-CHECK FIX PASS/);
  assert.match(runs[1].prompt, /SELF-CHECK FIX PASS 1 of 2/);
  assert.match(runs[1].prompt, /Self-check command: node tools\/validate\.cjs out\/batch-001\.json/);
  assert.match(runs[1].prompt, /Self-check exit code: 1/);
  assert.match(runs[1].prompt, /bad batch out\/batch-001\.json: fix the questions/);
  assert.ok(runs[1].prompt.includes(runs[0].prompt), "the pass carries the job's own prompt");
  assert.equal(runs[1].cwd, runs[0].cwd, "the same worktree");
  assert.match(text, /Self-checks: passed; fix passes used 1 of 2; first failure: node tools\/validate\.cjs out\/batch-001\.json exit code 1/);
  assert.match(text, /Validation gate: passed/);
  assert.doesNotMatch(text, /Error type: self_check_failed/);
});

test("B-068: a check that keeps failing uses every pass, fails the job, and validationCommand never runs", async () => {
  const runs = installAgentRuntime(writeBatch(() => "[\"BAD\"]\n"));
  let text;
  try {
    text = await runDirect(selfCheckJob([CHECK]));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
  assert.equal(runs.length, 3, "the first run and two passes (the default)");
  assert.match(text, /Error type: self_check_failed/);
  assert.match(text, /Self-checks: failed \(node tools\/validate\.cjs out\/batch-001\.json, exit code 1\); fix passes used 2 of 2/);
  assert.match(text, /Validation command: node tools\/validate\.cjs out\/batch-001\.json/, "the gate shown is the failing self-check");
  assert.doesNotMatch(text, /Validation command: git diff --check/);
  const none = installAgentRuntime(writeBatch(() => "[\"BAD\"]\n"));
  try {
    text = await runDirect(selfCheckJob([CHECK], { selfCheckPasses: 0 }));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
  assert.equal(none.length, 1, "selfCheckPasses 0: no pass");
  assert.match(text, /Self-checks: failed .*fix passes used 0 of 0/);
});

test("B-068: a queued job records its self-checks", async () => {
  installAgentRuntime(writeBatch((index) => (index === 0 ? "[\"BAD\"]\n" : "[\"ok\"]\n")));
  try {
    const enqueued = await enqueueQueueJob(selfCheckJob([CHECK], { task: "Queued batch with a self-check." }));
    assert.equal(enqueued.ok, true, enqueued.error);
    assert.ok(await waitFor(async () => fixture.terminal((await durable(enqueued.record.jobId))?.status), 30_000));
    const record = await durable(enqueued.record.jobId);
    assert.equal(record.status, "completed", record.errorType);
    assert.equal(record.selfCheck.final, "passed");
    assert.equal(record.selfCheck.passesUsed, 1);
    const list = textOf(await callTool("list_opencode_jobs", { cwd: repo, limit: 5 }));
    assert.match(list, new RegExp(`${enqueued.record.jobId} .*selfCheck=passed\\(1/2\\)`));
  } finally {
    hooks.agentRuntimeTestHook = null;
  }
});

await runFlexTests({ isolatedStateDir, file: "tests/review-flex-self-check.js", tests, cleanup: fixture.cleanup, finishSkips, label: "self-check" });
