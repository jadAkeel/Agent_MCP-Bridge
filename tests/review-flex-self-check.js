#!/usr/bin/env node

// Q-009 (log.md, 2026-10-02): self-check commands for builders. In round 3 a builder could not run
// `node tools/validate.cjs` on the batch it wrote (its bash permission allows git diagnostics only).
// A write job's Scope Contract may now list exact commands; the bridge adds them as exact bash
// allow rules for that one run (OPENCODE_CONFIG_CONTENT, scoped with AsyncLocalStorage) and
// attests them like the profile's own git rules. The last case runs the installed OpenCode's
// `debug agent` (no model call) in a scratch XDG home to prove how it merges the rules.
//   node tests/review-flex-self-check.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node,npm,python";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
// An operator-set inline config must never reach a child (the bridge strips it).
process.env.OPENCODE_CONFIG_CONTENT = "{\"agent\":{\"builder\":{\"permission\":{\"bash\":\"allow\"}}}}";
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture } = await import("./flex-fixture.js");
const { internals } = __selfTest;
const {
  agentMetadataCacheKey,
  assert,
  buildOpenCodeEnv,
  enqueueQueueJob,
  formatScopeContractForPrompt,
  jobPermissionOverlayStorage,
  mkdir,
  normalizeAgentDebugMetadata,
  normalizeScopeContract,
  path,
  runCommand,
  selfCheckCommandsError,
  selfCheckPermissionOverlay,
  validateSingleLockPlan,
  writeFile,
} = internals;
const { copyFile, readFile } = await import("node:fs/promises");
const { fileURLToPath } = await import("node:url");

const fixture = await makeFlexFixture(__selfTest, "review-flex-self-check");
const { repo, writeJob, callTool, textOf } = fixture;
const CHECK = "node tools/validate.cjs out/batch-001.json";
const selfCheckJob = (commands, extra = {}) => writeJob("out/batch-001.json", {
  task: "Write the batch and check it.",
  lockedPaths: ["out"],
  allowedEdits: ["out/batch-001.json"],
  scopeContract: { mode: "write", read: ["tools", "out"], write: ["out/batch-001.json"], allowedEdits: ["out/batch-001.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: commands },
  ...extra,
});
const planError = (job) => validateSingleLockPlan(job);

const tests = [];
const skips = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-009: exact, allowlisted commands are accepted for a builder write job", () => {
  assert.equal(planError(selfCheckJob([CHECK, "node tools/check-links.cjs out/batch-001.json", "git diff --check"])).error, null);
  assert.equal(selfCheckCommandsError({ agent: "builder" }, { lockType: "write", scopeContract: {} }), null, "no commands, no check");
});

test("Q-009: every command that could open the shell further is refused", () => {
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
    [["node -e process.exit(0)"], "self_check_invalid"],
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
  const editsValidator = selfCheckJob([CHECK], { allowedEdits: ["tools", "out/batch-001.json"], lockedPaths: ["tools", "out"], scopeContract: { mode: "write", read: ["tools", "out"], write: ["tools", "out/batch-001.json"], allowedEdits: ["tools", "out/batch-001.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: [CHECK] } });
  assert.equal(planError(editsValidator).errorType, "self_check_script_editable", "a validator inside an editable folder could be rewritten and run");
  const npmJob = writeJob("package.json", { lockedPaths: ["package.json"], allowedEdits: ["package.json"], scopeContract: { mode: "write", read: ["package.json"], write: ["package.json"], allowedEdits: ["package.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: ["npm test"] } });
  assert.equal(planError(npmJob).errorType, "self_check_script_editable", "npm runs package.json scripts the job may edit");
  const reader = { agent: "reviewer", task: "read", cwd: repo, write: false, lockMode: "off", scopeContract: { mode: "read", read: ["tools"], selfCheckCommands: [CHECK] } };
  assert.equal(planError(reader).errorType, "self_check_not_applicable");
});

test("Q-009: enqueue and run_opencode_parallel apply the same rules", async () => {
  const refused = await enqueueQueueJob(selfCheckJob(["node tools/validate.cjs out/*.json"]));
  assert.equal(refused.ok, false);
  assert.equal(refused.errorType, "self_check_invalid");
  const parallel = textOf(await callTool("run_opencode_parallel", { jobs: [selfCheckJob([CHECK], { dryRun: true }), selfCheckJob([CHECK], { dryRun: true, task: "second", lockedPaths: ["out2"], allowedEdits: ["out2/b.json"], scopeContract: { mode: "write", read: ["tools"], write: ["out2/b.json"], allowedEdits: ["out2/b.json"], forbidden: [".env"], validationCommand: "git diff --check", selfCheckCommands: ["node tools/validate.cjs out2/b.json"] } })] }));
  assert.match(parallel, /self_check_unsupported_in_parallel/);
});

test("Q-009: the agent prompt lists the commands", () => {
  const contract = normalizeScopeContract(selfCheckJob([CHECK]));
  const prompt = formatScopeContractForPrompt(contract);
  assert.match(prompt, /Self-check commands you may run with your shell tool \(type each exactly as written, on its own, from the working directory; fix what it reports and run it again before you finish\):\n- node tools\/validate\.cjs out\/batch-001\.json/);
  assert.doesNotMatch(formatScopeContractForPrompt(normalizeScopeContract(writeJob("src/a.txt"))), /Self-check/);
});

test("Q-009: the overlay reaches only the job that has it: env, attestation cache key, metadata check", async () => {
  const overlay = selfCheckPermissionOverlay(selfCheckJob([CHECK]));
  assert.deepEqual(JSON.parse(overlay.configContent), { agent: { builder: { permission: { bash: { [CHECK]: "allow" } } } } });
  assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, undefined, "outside a job nothing is set, and the operator's value is stripped");
  const keyOutside = agentMetadataCacheKey("builder", repo);
  const debugAgent = {
    name: "builder",
    mode: "all",
    model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    variant: "high",
    temperature: 0.1,
    prompt: "x",
    tools: {},
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
  assert.equal(normalizeAgentDebugMetadata(debugAgent, "builder").bashAutomaticAllowSafe, false, "without the job's overlay the extra rule is unsafe");
  await jobPermissionOverlayStorage.run(overlay, async () => {
    assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, overlay.configContent);
    assert.notEqual(agentMetadataCacheKey("builder", repo), keyOutside, "a job with rules never reuses another job's attestation");
    assert.equal(normalizeAgentDebugMetadata(debugAgent, "builder").bashAutomaticAllowSafe, true, "the job's own exact commands are accepted");
    const other = { ...debugAgent, permission: [...debugAgent.permission, { permission: "bash", pattern: "node tools/other.cjs", action: "allow" }] };
    assert.equal(normalizeAgentDebugMetadata(other, "builder").bashAutomaticAllowSafe, false, "any other allow rule is still unsafe");
    await Promise.resolve();
    assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, overlay.configContent, "kept across awaits");
  });
  assert.equal(buildOpenCodeEnv().OPENCODE_CONFIG_CONTENT, undefined);
});

test("Q-009: the installed OpenCode appends the job's rules after the profile's deny-all", async () => {
  const version = await runCommand("opencode", ["--version"], process.cwd(), 30_000).catch(() => ({ exitCode: 1 }));
  if (version.exitCode !== 0) throw new SkipTest("OpenCode is not on PATH; the merge order is checked only with a real OpenCode", { optional: true });
  const home = path.join(fixture.root, "oc-home");
  for (const folder of ["home", "config/opencode/agents", "data", "cache", "state"]) await mkdir(path.join(home, folder), { recursive: true });
  await copyFile(fileURLToPath(new URL("../opencode/agents/builder.md", import.meta.url)), path.join(home, "config", "opencode", "agents", "builder.md"));
  const overlay = selfCheckPermissionOverlay(selfCheckJob([CHECK]));
  const env = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT || "",
    SystemRoot: process.env.SystemRoot || "",
    HOME: path.join(home, "home"),
    USERPROFILE: path.join(home, "home"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_CHANNEL_DB: "true",
    OPENCODE_CONFIG_CONTENT: overlay.configContent,
  };
  const result = await runCommand("opencode", ["--pure", "debug", "agent", "builder"], repo, 60_000, env);
  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const bashRules = parsed.permission.filter((rule) => rule.permission === "bash");
  assert.deepEqual(bashRules[0], { permission: "bash", pattern: "*", action: "deny" }, "the profile's deny-all comes first");
  assert.deepEqual(bashRules.at(-1), { permission: "bash", pattern: CHECK, action: "allow" }, "the job's rule comes last, so it wins for that exact command");
  await jobPermissionOverlayStorage.run(overlay, async () => {
    const metadata = normalizeAgentDebugMetadata(parsed, "builder");
    assert.equal(metadata.bashAutomaticAllowSafe, true);
    assert.ok(metadata.bashAllowedPatterns.includes(CHECK));
    assert.equal(metadata.protectedEditsDenied, true, "the edit rules are untouched");
  });
  assert.equal(normalizeAgentDebugMetadata(parsed, "builder").bashAutomaticAllowSafe, false, "the same profile without the job is refused");
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skips.push({ name, reason: error.message, optional: error.optional });
        process.stdout.write(`skip ${name}: ${error.message}\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  await fixture.cleanup();
}
const skipGateFailed = finishSkips({ file: "tests/review-flex-self-check.js", total: tests.length, skips });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} self-check tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`${tests.length - skips.length} of ${tests.length} self-check tests passed${skips.length ? `, ${skips.length} skipped` : ""}.\n`);
process.exit(0);
