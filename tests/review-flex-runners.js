#!/usr/bin/env node

// Q-012 (log.md, feature 9): codex and agy as external runners. A job whose model requirement names
// `codex/<model>` or `agy/<model>` runs that CLI (with CODEX_OPENCODE_EXTERNAL_RUNNERS listing it)
// inside the bridge's locks, worktree, scope checks and validation. Both CLIs are fakes here: node
// scripts behind npm-style .cmd shims (an executable script elsewhere) in a scratch folder, driven
// by a control file; they record their argv, cwd and environment. The parsers are also fed the
// recorded codex 0.159.3 and agy 1.2.14 output in tests/fixtures/. Git, the worktree, the process
// supervisor, provider slots and pauses are real; only agent discovery and attestation are the
// agentRuntimeTestHook. The state directory, CODEX_HOME and the OpenCode config folder are scratch.
//   node tests/review-flex-runners.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } = await import("node:fs");
const { createHash } = await import("node:crypto");
const { tmpdir: osTmpdir } = await import("node:os");
const nodePath = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");

const scratch = mkdtempSync(nodePath.join(osTmpdir(), "review-flex-runners-"));
const binDir = nodePath.join(scratch, "bin");
const recordDir = nodePath.join(scratch, "records");
const controlFile = nodePath.join(scratch, "control.json");
const codexHome = nodePath.join(scratch, "codex-home");
const xdgConfig = nodePath.join(scratch, "xdg-config");
for (const directory of [binDir, recordDir, codexHome, nodePath.join(xdgConfig, "opencode")]) mkdirSync(directory, { recursive: true });
const writeControl = (value) => writeFileSync(controlFile, JSON.stringify(value), "utf8");
writeControl({});

// One fake per runner. It never reads anything but the control file and never calls a network.
const fakeSource = (runner) => `
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const runner = ${JSON.stringify(runner)};
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(runner === "codex" ? (control.codexVersion || "codex-cli 0.159.3") + "\\n" : "1.2.14\\n");
  process.exit(0);
}
const pick = (...names) => Object.fromEntries(names.map((name) => [name, process.env[name] === undefined ? null : process.env[name]]));
fs.writeFileSync(path.join(${JSON.stringify(recordDir)}, runner + "-" + Date.now() + "-" + process.pid + ".json"), JSON.stringify({
  args, cwd: process.cwd(),
  env: pick("CODEX_HOME", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "FLEX_RUNNER_API_TOKEN", "OPENCODE_CONFIG_CONTENT", "CODEX_OPENCODE_EXTERNAL_RUNNERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0"),
}));
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = control[runner] || "ok";
const writeWork = () => { if (control.writeFile) fs.writeFileSync(path.join(process.cwd(), control.writeFile), control.content || "changed\\n"); };
(async () => {
  if (runner === "codex") {
    const lastMessage = args[args.indexOf("-o") + 1];
    out({ type: "thread.started", thread_id: "t-1" });
    out({ type: "item.completed", item: { id: "item_0", type: "error", message: "Ignoring malformed agent role definition" } });
    out({ type: "turn.started" });
    if (mode === "usage-limit") {
      out({ type: "error", message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes." });
      await sleep(30000);
      process.exit(1);
    }
    writeWork();
    if (mode === "commit") {
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.invalid", "commit", "-q", "-m", "fake commit"], { cwd: process.cwd() });
    }
    out({ type: "item.completed", item: { id: "item_1", type: "file_change", changes: [] } });
    out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "REPORT: done by fake codex" } });
    fs.writeFileSync(lastMessage, "REPORT: done by fake codex (last message)");
    out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 7 } });
    process.exit(0);
  }
  if (mode === "silent") { await sleep(60000); process.exit(0); }
  if (mode === "quota-exit3") { process.stderr.write("RESOURCE_EXHAUSTED: Quota resets in 1h 5m\\n"); process.exit(3); }
  out({ event: "init", conversation_id: "c-1", init: { cwd: process.cwd(), tools: [], permission_mode: "auto" } });
  writeWork();
  if (mode === "write-target") fs.writeFileSync(control.targetFile, "agy wrote here\\n");
  out({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "REPORT" } });
  out({ event: "result", result: { status: "SUCCESS", response: "REPORT: done by fake agy", num_turns: 2, usage: { input_tokens: 900, output_tokens: 40, thinking_tokens: 5, cache_read_tokens: 100 } } });
  process.exit(0);
})();
`;

function installFake(runner) {
  if (process.platform === "win32") {
    const scriptDir = runner === "codex" ? nodePath.join(binDir, "node_modules", "@openai", "codex", "bin") : nodePath.join(binDir, "agy-pkg");
    mkdirSync(scriptDir, { recursive: true });
    const script = nodePath.join(scriptDir, `${runner}.js`);
    writeFileSync(script, fakeSource(runner), "utf8");
    const relative = nodePath.relative(binDir, script);
    // The npm shim's exact shape (resolveWindowsNodeShim reads the forwarding line).
    writeFileSync(nodePath.join(binDir, `${runner}.cmd`), [
      "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
      "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relative}" %*`, "",
    ].join("\r\n"), "utf8");
    return { executable: nodePath.join(binDir, `${runner}.cmd`), script };
  }
  const script = nodePath.join(binDir, runner);
  writeFileSync(script, `#!${process.execPath}\n${fakeSource(runner)}`, "utf8");
  chmodSync(script, 0o755);
  return { executable: script, script };
}
const fakeCodex = installFake("codex");
const fakeAgy = installFake("agy");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
process.env.CODEX_OPENCODE_EXTERNAL_RUNNERS = "codex,agy";
process.env.CODEX_OPENCODE_MODEL_ALLOWLIST = "codex/gpt-test@high,codex/gpt-read,agy/default,agy/claude-test@high";
process.env.CODEX_OPENCODE_CODEX_EXECUTABLE = fakeCodex.executable;
process.env.CODEX_OPENCODE_AGY_EXECUTABLE = fakeAgy.executable;
process.env.CODEX_OPENCODE_RUNNER_SHA256 = `agy=${sha256(fakeAgy.script)}`;
process.env.CODEX_OPENCODE_PROVIDER_LIMITS = "codex=3,agy=2";
process.env.CODEX_OPENCODE_QUOTA_GROUPS = "chatgpt:codex,openai";
// The idle watchdog is short: agy must still run until its job timeout.
process.env.CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS = "1500";
process.env.CODEX_HOME = codexHome;
process.env.XDG_CONFIG_HOME = xdgConfig;
// Must never reach a runner.
process.env.FLEX_RUNNER_API_TOKEN = "secret-value";
process.env.OPENCODE_CONFIG_CONTENT = "{\"agent\":{}}";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_HITS;
delete process.env.CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS;
delete process.env.CODEX_OPENCODE_PASSTHROUGH_ENV;
delete process.env.CODEX_OPENCODE_ALLOW_SENSITIVE_ENV;

// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-runners");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const runners = await import("../lib/external-runners.js");
const { issueMarkdownLine } = await import("../bin/ops-log.js");
const { hooks, internals } = __selfTest;
const {
  CONFIG,
  acquireProviderLease,
  assert,
  buildRunnerEnv,
  describeFailedMcpMessage,
  externalRunnerName,
  externalRunnerSelection,
  externalRunnerStartupProblems,
  externalRunnerStatusLines,
  parseModelAllowlistEntry,
  providerCapacitySnapshot,
  providerKeyForMetadata,
  providerLimitForKey,
  releaseProviderLease,
  resumeProvider,
  verifyRunnerExecutable,
} = internals;

const fixture = await makeFlexFixture(__selfTest, "review-flex-runners");
const { repo, git, writeJob, writeScope, readJob, callTool, textOf } = fixture;
const here = nodePath.dirname(fileURLToPath(import.meta.url));
const codexFixture = readFileSync(nodePath.join(here, "fixtures", "codex-exec-0.159.3.jsonl"), "utf8");
const agyFixture = readFileSync(nodePath.join(here, "fixtures", "agy-stream-1.2.14.jsonl"), "utf8");
const KEY = CONFIG.providerConcurrencyKey;

hooks.agentRuntimeTestHook = {
  resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
    requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
    fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
  }),
  readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
    name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
    canEdit: !["reviewer", "tester"].includes(agent), canDelegate: false, externalDirectoryDenied: true, webDenied: true,
    bashAutomaticAllowSafe: true, bashDenied: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
  } }),
};

const records = (runner) => readdirSync(recordDir).filter((name) => name.startsWith(`${runner}-`)).sort()
  .map((name) => JSON.parse(readFileSync(nodePath.join(recordDir, name), "utf8")));
const clearRecords = () => { for (const name of readdirSync(recordDir)) rmSync(nodePath.join(recordDir, name), { force: true }); };
const requirement = (provider, model, variant) => ({ provider, model, ...(variant ? { variant } : {}) });
const runnerWriteJob = (modelRequirement, file = "src/a.txt", extra = {}) => writeJob(file, { scopeContract: { ...writeScope(file), modelRequirement }, ...extra });
const runnerReadJob = (modelRequirement, extra = {}) => readJob({ scopeContract: { mode: "read", read: ["src/a.txt"], modelRequirement }, ...extra });
const run = async (job) => textOf(await callTool("run_opencode_agent", { ...job, detail: true }));
const errorTypeOf = (text) => /^Error type: (\S+)/m.exec(text)?.[1] || "";
const cooldownKeys = async () => new Set(((await providerCapacitySnapshot()).cooldowns || []).map((item) => item.providerKey));
const resumeAll = async () => { for (const provider of ["codex", "agy", "openai"]) await resumeProvider({ provider }); };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-012: the recorded codex 0.159.3 and agy 1.2.14 output parse into a report and usage", () => {
  const codex = runners.inspectCodexEvents(codexFixture);
  assert.equal(codex.finalText, "OK");
  assert.equal(codex.turnsCompleted, 1);
  assert.deepEqual(codex.usage, { steps: 1, inputCount: 18602 - 7296, outputCount: 5, reasoningCount: 0, cacheReadCount: 7296, cacheWriteCount: 0, cost: 0, rootSteps: 1 });
  assert.equal(codex.itemWarnings.length, 1, "an item of type error is a warning");
  assert.equal(codex.streamErrors.length, 0);
  assert.equal(codex.invalidLines, 0);
  const agy = runners.inspectAgyOutput(agyFixture);
  assert.equal(agy.finalText, "OK\n");
  assert.equal(agy.finalResponseDetected, true);
  assert.equal(agy.resultStatus, "SUCCESS");
  assert.equal(agy.usage.inputCount, 12121);
  assert.equal(agy.usage.reasoningCount, 60);
  assert.equal(agy.steps, 3);
  // The single-object form (--output-format json) is read too.
  assert.equal(runners.inspectAgyOutput(JSON.stringify({ status: "SUCCESS", response: "R" })).finalText, "R");
});

test("Q-012: rate-limit evidence: codex error events at once, agy patterns and an early exit 3 after the exit", () => {
  const limit = runners.codexRateLimitEvidence(JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again in 2 hours 5 minutes." }));
  assert.equal(limit.kind, "quota");
  assert.equal(limit.resetMs, (2 * 60 + 5) * 60_000);
  assert.equal(runners.codexRateLimitEvidence(JSON.stringify({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } })).kind, "rate_limit");
  assert.equal(runners.codexRateLimitEvidence(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the usage limit docs" } })), null, "an agent message never counts");
  assert.equal(runners.codexRateLimitEvidence(JSON.stringify({ type: "item.completed", item: { type: "error", message: "429" } })), null);
  assert.equal(runners.codexRateLimitEvidence("not json 429"), null);
  const ok = runners.inspectAgyOutput(agyFixture);
  assert.equal(runners.agyRateLimitEvidence({ stderr: "status 429", inspection: ok, exitCode: 0 }), null, "a successful run is never a strike");
  const failed = runners.inspectAgyOutput("");
  assert.equal(runners.agyRateLimitEvidence({ stderr: "RESOURCE_EXHAUSTED: Quota resets in 1h 5m", inspection: failed, exitCode: 1 }).resetMs, 65 * 60_000);
  assert.equal(runners.agyRateLimitEvidence({ logTail: "listening on port 4290 pid 429", inspection: failed, exitCode: 1 }), null, "a bare 429 in agy's log does not count");
  assert.equal(runners.agyRateLimitEvidence({ inspection: failed, exitCode: 3, runMs: 40_000 }).source, "exit code");
  assert.equal(runners.agyRateLimitEvidence({ inspection: failed, exitCode: 3, runMs: 10 * 60_000 }), null, "a late exit 3 is not a quota strike");
});

test("Q-012: settings are refused at startup when malformed", () => {
  assert.throws(() => runners.readExternalRunnersEnv({ CODEX_OPENCODE_EXTERNAL_RUNNERS: "codex,claude" }), /may list only codex, agy/);
  assert.deepEqual(runners.readExternalRunnersEnv({}), []);
  assert.deepEqual([...runners.readProviderLimitsEnv({ CODEX_OPENCODE_PROVIDER_LIMITS: "codex=5, Google=8" }).entries()], [["codex", 5], ["google", 8]]);
  assert.throws(() => runners.readProviderLimitsEnv({ CODEX_OPENCODE_PROVIDER_LIMITS: "codex=0" }), /provider=slots/);
  assert.throws(() => runners.readQuotaGroupsEnv({ CODEX_OPENCODE_QUOTA_GROUPS: "chatgpt:codex" }), /name:provider,provider/);
  assert.deepEqual(runners.readQuotaGroupsEnv({ CODEX_OPENCODE_QUOTA_GROUPS: "chatgpt:codex,openai;g:agy,google" }), [{ name: "chatgpt", members: ["codex", "openai"] }, { name: "g", members: ["agy", "google"] }]);
  assert.throws(() => runners.readRunnerSha256Env({ CODEX_OPENCODE_RUNNER_SHA256: "opencode=" + "a".repeat(64) }), /codex=<sha256>/);
});

test("Q-012: allowlist refusals: a runner that is not enabled, and a reserved name the managed config defines", async () => {
  const problems = runners.externalRunnerConfigProblems({ enabled: ["codex"], allowlist: ["agy/default", "codex/gpt-test", "openai/gpt-x"], parseEntry: parseModelAllowlistEntry });
  assert.deepEqual(problems.map((item) => item.errorType), ["external_runner_not_enabled"]);
  assert.match(problems[0].error, /agy\/default names the external runner agy/);
  const conflict = runners.externalRunnerConfigProblems({ enabled: ["codex", "agy"], allowlist: [], parseEntry: parseModelAllowlistEntry, managedConfigTexts: [{ file: "opencode.jsonc", text: "{\n  // the managed config\n  \"provider\": { \"codex\": { \"url\": \"https://example.invalid//x\" }, },\n}" }] });
  assert.deepEqual(conflict.map((item) => item.errorType), ["external_runner_name_conflict"]);
  assert.equal(runners.externalRunnerConfigProblems({ enabled: [], allowlist: ["openai/gpt-x"], parseEntry: parseModelAllowlistEntry }).length, 0, "nothing reserved, nothing refused");
  // This process: both runners enabled, the scratch managed config defines neither, then codex.
  assert.deepEqual(await externalRunnerStartupProblems(), []);
  const configFile = nodePath.join(xdgConfig, "opencode", "opencode.json");
  writeFileSync(configFile, JSON.stringify({ provider: { codex: {} } }), "utf8");
  try {
    assert.deepEqual((await externalRunnerStartupProblems()).map((item) => item.errorType), ["external_runner_name_conflict"]);
  } finally {
    rmSync(configFile, { force: true });
  }
});

test("Q-012: a model requirement selects a runner only when enabled and allowlisted", () => {
  assert.deepEqual(externalRunnerSelection(requirement("codex", "gpt-test"), "builder"), { runner: "codex", model: "gpt-test", variant: "high" });
  assert.deepEqual(externalRunnerSelection(requirement("agy", "default"), "builder"), { runner: "agy", model: "default", variant: "" });
  assert.equal(externalRunnerSelection(requirement("codex", "gpt-other"), "builder"), null, "not allowlisted");
  assert.equal(externalRunnerSelection(requirement("openai", "gpt-test"), "builder"), null, "an OpenCode provider");
  assert.equal(externalRunnerSelection(null, "builder"), null);
  assert.equal(externalRunnerSelection(requirement("codex", "gpt-test"), "mcp-sanitized-reader"), null, "the sanitized reader is never overridable");
  assert.equal(externalRunnerName("codex"), "codex");
  assert.equal(externalRunnerName("openai"), "");
});

test("Q-012: argv: fixed flags, the variant and the read-only sandbox; env keeps the real profile and strips secrets", () => {
  const codex = runners.buildCodexArgs({ model: "gpt-test", variant: "high", cwd: "W", lastMessagePath: "L", prompt: "P", windowsSandbox: "" });
  assert.deepEqual(codex, ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "workspace-write", "-C", "W", "-m", "gpt-test", "-c", "model_reasoning_effort=high", "-o", "L", "--", "P"]);
  // Without a Windows sandbox codex refuses every write; --ignore-user-config drops the user's one.
  const winArgs = runners.buildCodexArgs({ model: "m", cwd: "W", lastMessagePath: "L", prompt: "P", windowsSandbox: "elevated" });
  assert.deepEqual(winArgs.slice(winArgs.indexOf("-c"), winArgs.indexOf("-c") + 2), ["-c", "windows.sandbox=elevated"]);
  assert.equal(runners.defaultCodexWindowsSandbox({}, "win32"), "elevated");
  assert.equal(runners.defaultCodexWindowsSandbox({ CODEX_OPENCODE_CODEX_WINDOWS_SANDBOX: "unelevated" }, "win32"), "unelevated");
  assert.equal(runners.defaultCodexWindowsSandbox({}, "linux"), "");
  assert.equal(runners.buildCodexArgs({ model: "m", readOnly: true, cwd: "W", lastMessagePath: "L", prompt: "P" })[6], "read-only");
  const agy = runners.buildAgyArgs({ model: "claude-test", variant: "high", timeoutMs: 600_000, logPath: "G", prompt: "P" });
  assert.deepEqual(agy, ["-p", "P", "--dangerously-skip-permissions", "--sandbox", "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "540s", "--log-file", "G", "--model", "claude-test", "--effort", "high"]);
  assert.equal(runners.buildAgyArgs({ model: "default", timeoutMs: 10_000, logPath: "G", prompt: "P" }).includes("--model"), false, "agy/default passes no --model");
  assert.equal(runners.buildAgyArgs({ model: "default", timeoutMs: 10_000, logPath: "G", prompt: "P" })[8], "60s");
  assert.equal(runners.runnerFlagsError("codex", codex), "");
  assert.match(runners.runnerFlagsError("codex", codex.filter((item) => item !== "--ignore-user-config")), /--ignore-user-config/);
  assert.equal(runners.runnerFlagsError("agy", agy), "");
  const env = buildRunnerEnv("codex");
  assert.equal(env.CODEX_HOME, codexHome);
  assert.equal(env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(env.FLEX_RUNNER_API_TOKEN, undefined);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase().startsWith("CODEX_OPENCODE_")), false);
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor");
  assert.equal(buildRunnerEnv("agy").CODEX_HOME, undefined, "agy gets no CODEX_HOME");
});

test("Q-012: path, hash pin and version floor are checked before a runner starts", async () => {
  writeControl({ codexVersion: "codex-cli 0.133.0" });
  const old = await verifyRunnerExecutable("codex");
  assert.equal(old.errorType, "external_runner_version_unsupported");
  writeControl({});
  const codex = await verifyRunnerExecutable("codex");
  assert.equal(codex.ok, true, codex.error);
  assert.equal(codex.version, "0.159.3");
  assert.equal(codex.executable.hashedPath, nodePath.resolve(fakeCodex.script), "the .cmd shim runs its JavaScript entry");
  const agy = await verifyRunnerExecutable("agy");
  assert.equal(agy.ok, true, agy.error);
  const original = readFileSync(fakeAgy.script, "utf8");
  writeFileSync(fakeAgy.script, `${original}\n// changed\n`, "utf8");
  try {
    assert.equal((await verifyRunnerExecutable("agy")).errorType, "external_runner_hash_mismatch");
  } finally {
    writeFileSync(fakeAgy.script, original, "utf8");
  }
});

test("Q-012: a codex writer completes in its worktree with changed files, usage and the fixed argv", async () => {
  clearRecords();
  writeControl({ writeFile: "src/a.txt", content: "a by codex\n" });
  const text = await run(runnerWriteJob(requirement("codex", "gpt-test")));
  assert.equal(errorTypeOf(text), "none", text);
  assert.match(text, /^Role enforcement: none \(runner codex\)$/m);
  assert.match(text, /^External runner: codex 0\.159\.3 \(unattested/m);
  assert.match(text, /^Configured provider: codex$/m);
  assert.match(text, /^Model selection: external_runner$/m);
  assert.match(text, /^Token usage: steps=1 input=1000 output=50 reasoning=7 cache_read=200 cache_write=0/m);
  assert.match(text, new RegExp(`^Provider/account concurrency key: ${KEY}:codex$`, "m"));
  assert.match(text, /src\/a\.txt/);
  assert.match(text, /REPORT: done by fake codex \(last message\)/, "the -o file is the report");
  const [record] = records("codex");
  assert.ok(record, "the fake ran once");
  assert.notEqual(nodePath.resolve(record.cwd).toLowerCase(), nodePath.resolve(repo).toLowerCase(), "it ran in the worktree");
  assert.deepEqual(record.args.slice(0, 7), ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "workspace-write"]);
  assert.equal(record.args[record.args.indexOf("-m") + 1], "gpt-test");
  assert.equal(record.args[record.args.indexOf("-c") + 1], "model_reasoning_effort=high");
  assert.equal(nodePath.resolve(record.args[record.args.indexOf("-C") + 1]).toLowerCase(), nodePath.resolve(record.cwd).toLowerCase());
  assert.ok(!nodePath.resolve(record.args[record.args.indexOf("-o") + 1]).toLowerCase().startsWith(nodePath.resolve(record.cwd).toLowerCase()), "the sidecar is outside the worktree");
  assert.match(record.args.at(-1), /Do not commit/);
  assert.equal(record.env.CODEX_HOME, codexHome);
  assert.equal(record.env.FLEX_RUNNER_API_TOKEN, null);
  assert.equal(record.env.OPENCODE_CONFIG_CONTENT, null);
  assert.equal(record.env.CODEX_OPENCODE_EXTERNAL_RUNNERS, null);
  assert.equal(readFileSync(nodePath.join(repo, "src", "a.txt"), "utf8"), "a\n", "the target checkout is untouched until integration");
});

test("Q-012: a codex reader runs in the checkout with the read-only sandbox", async () => {
  clearRecords();
  writeControl({});
  const text = await run(runnerReadJob(requirement("codex", "gpt-read")));
  assert.equal(errorTypeOf(text), "none", text);
  const [record] = records("codex");
  assert.equal(record.args[record.args.indexOf("-s") + 1], "read-only");
  assert.equal(record.args.some((arg) => arg.startsWith("model_reasoning_effort=")), false, "no variant, no effort override");
  assert.equal(nodePath.resolve(record.cwd).toLowerCase(), nodePath.resolve(repo).toLowerCase());
});

test("Q-012: a codex usage limit stops the run at once as provider_rate_limited and pauses the quota group", async () => {
  writeControl({ codex: "usage-limit" });
  const started = Date.now();
  const text = await run(runnerReadJob(requirement("codex", "gpt-read")));
  try {
    assert.equal(errorTypeOf(text), "provider_rate_limited", text);
    assert.ok(Date.now() - started < 20_000, "stopped long before the fake's 30 s sleep");
    assert.match(text, /^Rate limit detected: quota: 1 line\(s\) for codex\/gpt-read/m);
    const keys = await cooldownKeys();
    assert.ok(keys.has(`${KEY}:codex/gpt-read`), "the model is paused");
    assert.ok(keys.has(`${KEY}:openai`), "the quota group's other provider is paused");
    assert.ok(keys.has(`${KEY}:codex`), "and the runner itself (a ChatGPT limit is per account)");
    const snapshot = await providerCapacitySnapshot();
    const modelPause = snapshot.cooldowns.find((item) => item.providerKey === `${KEY}:codex/gpt-read`);
    assert.ok(modelPause.remainingMs > 2 * 60 * 60_000 - 60_000, "the reported reset (2 h 5 min) is longer than the 30 min step and wins");
    writeControl({});
    const refused = await run(runnerReadJob(requirement("codex", "gpt-read")));
    assert.equal(errorTypeOf(refused), "provider_rate_limited", "the next job is refused before it starts");
    assert.match(refused, /is paused until/);
  } finally {
    await resumeAll();
  }
});

test("Q-012: a silent agy writer is stopped only by the job timeout, not the idle watchdog", async () => {
  writeControl({ agy: "silent" });
  const started = Date.now();
  const text = await run(runnerWriteJob(requirement("agy", "default"), "src/a.txt", { timeoutMs: 4000 }));
  assert.equal(errorTypeOf(text), "agent_timeout", text);
  assert.match(text, /^Timed out: yes$/m);
  assert.doesNotMatch(text, /Agent idle timeout:/);
  assert.ok(Date.now() - started >= 3500, "it ran for the whole job timeout although the idle limit is 1.5 s");
});

test("Q-012: agy exit 3 with quota text is provider_rate_limited and pauses that agy model", async () => {
  writeControl({ agy: "quota-exit3" });
  const text = await run(runnerWriteJob(requirement("agy", "claude-test")));
  try {
    assert.equal(errorTypeOf(text), "provider_rate_limited", text);
    const keys = await cooldownKeys();
    assert.ok(keys.has(`${KEY}:agy/claude-test`), "paused by model: agy-gemini and agy-claude have separate quotas");
    assert.ok(!keys.has(`${KEY}:agy/default`));
    assert.ok(!keys.has(`${KEY}:agy`), "agy is in no quota group here");
  } finally {
    await resumeAll();
  }
});

test("Q-012: agy writing into the target checkout fails the job, pauses agy and reverts nothing", async () => {
  const target = nodePath.join(repo, "src", "b.txt");
  writeControl({ agy: "write-target", targetFile: target, writeFile: "src/a.txt", content: "a by agy\n" });
  const text = await run(runnerWriteJob(requirement("agy", "default")));
  try {
    assert.equal(errorTypeOf(text), "external_runner_wrote_outside_worktree", text);
    assert.match(text, /^Target checkout guard: changed \(src\/b\.txt\)$/m);
    assert.equal(readFileSync(target, "utf8"), "agy wrote here\n", "the bridge never reverts the target");
    assert.ok((await cooldownKeys()).has(`${KEY}:agy`), "the runner is paused");
  } finally {
    await git(["checkout", "--", "src/b.txt"]);
    await resumeAll();
  }
});

test("B-116: a target checkout git cannot read after agy ran fails closed, without a pause", async () => {
  // agy leaves the target's index unreadable: the after-capture fails, which proves nothing.
  const index = nodePath.join(repo, ".git", "index");
  const saved = readFileSync(index);
  writeControl({ agy: "write-target", targetFile: index, writeFile: "src/a.txt", content: "a by agy\n" });
  try {
    const text = await run(runnerWriteJob(requirement("agy", "default")));
    assert.equal(errorTypeOf(text), "external_runner_guard_unverifiable", text);
    assert.match(text, /could not be checked after agy ran/);
    assert.ok(!(await cooldownKeys()).has(`${KEY}:agy`), "nothing was seen, so agy is not paused");
  } finally {
    writeFileSync(index, saved);
    await resumeAll();
  }
});

test("Q-012: a runner that commits in its worktree fails as repository_head_changed_during_execution", async () => {
  writeControl({ codex: "commit", writeFile: "src/a.txt", content: "committed by codex\n" });
  const text = await run(runnerWriteJob(requirement("codex", "gpt-test")));
  assert.equal(errorTypeOf(text), "repository_head_changed_during_execution", text);
});

test("Q-012: agy readers and agy without a worktree are refused before anything starts", async () => {
  clearRecords();
  writeControl({});
  const text = await run(runnerReadJob(requirement("agy", "default")));
  assert.equal(errorTypeOf(text), "external_runner_read_unsupported", text);
  assert.equal(records("agy").length, 0, "agy never ran");
});

test("Q-012: per-runner slot keys and CODEX_OPENCODE_PROVIDER_LIMITS", async () => {
  assert.equal(providerKeyForMetadata({ provider: "codex" }), `${KEY}:codex`);
  assert.equal(providerKeyForMetadata({ provider: "agy" }), `${KEY}:agy`);
  assert.equal(providerLimitForKey(`${KEY}:codex`), 3);
  assert.equal(providerLimitForKey(`${KEY}:agy`), 2);
  assert.equal(providerLimitForKey(`${KEY}:opencode`), CONFIG.providerConcurrencyLimit, "an unlisted provider keeps the configured limit");
  assert.equal(providerLimitForKey(KEY), CONFIG.providerConcurrencyLimit);
  const held = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const lease = await acquireProviderLease({ providerKey: `${KEY}:agy`, timeoutMs: 2000 });
      assert.equal(lease.ok, true, lease.error);
      held.push(lease.lease);
    }
    const third = await acquireProviderLease({ providerKey: `${KEY}:agy`, timeoutMs: 600 });
    assert.equal(third.ok, false);
    assert.equal(third.errorType, "provider_slot_wait_timeout");
    assert.equal(third.capacity, 2);
    const snapshot = await providerCapacitySnapshot();
    assert.equal(snapshot.keys.find((item) => item.providerKey === `${KEY}:agy`)?.capacity, 2, "status reports the per-key limit");
  } finally {
    for (const lease of held) await releaseProviderLease(lease);
  }
});

test("Q-012: status lines and the operations log name the runner", async () => {
  const lines = externalRunnerStatusLines();
  assert.match(lines[0], /^External runners: codex, agy \(unattested/);
  assert.ok(lines.some((line) => line.startsWith(`- agy: executable ${fakeAgy.executable}, SHA-256 pinned (1)`)));
  assert.ok(lines.includes("Per-provider slot limits (CODEX_OPENCODE_PROVIDER_LIMITS): codex=3, agy=2"));
  assert.ok(lines.includes("Quota groups (CODEX_OPENCODE_QUOTA_GROUPS): chatgpt=codex+openai"));
  const pending = new Map([[7, { method: "tools/call", tool: "run_opencode_agent", startedAt: Date.now() }]]);
  const answer = (text) => ({ id: 7, result: { content: [{ type: "text", text }] } });
  const withRunner = describeFailedMcpMessage(answer("Agent: builder\nStatus: failed; error type: provider_rate_limited\nRole enforcement: none (runner codex)"), pending);
  assert.equal(withRunner.event, "agent.run_failed");
  assert.equal(withRunner.data.runner, "codex");
  const without = describeFailedMcpMessage(answer("Agent: builder\nStatus: failed; error type: agent_timeout"), pending);
  assert.equal(Object.hasOwn(without.data, "runner"), false, "an OpenCode run's record is unchanged");
  assert.match(issueMarkdownLine({ ts: "2026-10-03T10:00:00Z", event: "queue.job_failed", errorType: "provider_rate_limited", jobId: "j1", agent: "builder", model: "codex/gpt-test", runner: "codex", summary: "x" }), /job j1 builder on codex\/gpt-test \(runner codex\) \|/);
  assert.doesNotMatch(issueMarkdownLine({ ts: "2026-10-03T10:00:00Z", event: "queue.job_failed", errorType: "x", jobId: "j1", agent: "builder", model: "opencode/m", summary: "x" }), /runner/);
});

await runFlexTests({
  file: "tests/review-flex-runners.js",
  tests,
  cleanup: async () => {
    await resumeAll().catch(() => {});
    await fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  },
  finishSkips,
  label: "external-runner",
  isolatedStateDir,
});
