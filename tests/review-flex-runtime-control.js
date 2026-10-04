#!/usr/bin/env node

// Q-005 (log.md, 2026-10-02): runtime control without a restart. pause_opencode_provider /
// resume_opencode_provider pause a provider or one model in every bridge process (stored with the
// automatic pauses in provider-concurrency.sqlite), and set_opencode_concurrency gains a global
// worker cap over all providers (CODEX_OPENCODE_GLOBAL_WORKER_LIMIT). Slots are real SQLite leases
// in a scratch state directory.
//   node tests/review-flex-runtime-control.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
delete process.env.CODEX_OPENCODE_GLOBAL_WORKER_LIMIT;
// Never the operator's ~/.codex/codex-opencode-mcp, not even from a timer after cleanup.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-flex-runtime-control");
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { hooks, internals } = __selfTest;
const {
  CONFIG,
  ENV_GLOBAL_WORKER_LIMIT,
  MAX_GLOBAL_WORKER_LIMIT,
  RUNTIME_CONCURRENCY,
  acquireProviderLease,
  assert,
  describeConcurrencyLimits,
  mkdir,
  mkdtemp,
  modelPauseKeyForMetadata,
  path,
  providerCapacitySnapshot,
  providerPauseTarget,
  recordRateLimitPause,
  refreshRuntimeConcurrency,
  releaseProviderLease,
  rm,
  runCommand,
  server,
  setRuntimeConcurrency,
  tmpdir,
  writeFile,
} = internals;

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "review-flex-runtime-control-"));
const stateDir = path.join(fixtureRoot, "state");
await mkdir(stateDir, { recursive: true });
hooks.stateDirectoryOverride = stateDir;
const repo = path.join(fixtureRoot, "repo");
await mkdir(repo, { recursive: true });
await runCommand("git", ["init", "-q"], repo, 30_000);
await writeFile(path.join(repo, "a.txt"), "a\n", "utf8");
await runCommand("git", ["add", "."], repo, 30_000);
await runCommand("git", ["-c", "user.name=Review", "-c", "user.email=review@example.invalid", "commit", "-q", "-m", "init"], repo, 30_000);

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const base = CONFIG.providerConcurrencyKey;
const MUSE = "muse-spark-1.3-contributor-free";
const museKey = `${base}:opencode/${MUSE}`;
const opencodeKey = `${base}:opencode`;
const slot = (providerKey, pauseKeys = [], timeoutMs = 2000) => acquireProviderLease({ providerKey, pauseKeys, timeoutMs });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Q-005: the pause target is a provider (its slot key) or one provider/model", () => {
  assert.deepEqual(providerPauseTarget("OpenCode"), { ok: true, key: opencodeKey, provider: "opencode", model: "", modelPrefix: `${base}:opencode/` });
  const model = providerPauseTarget(`opencode/${MUSE}`);
  assert.equal(model.key, museKey);
  assert.equal(model.key, modelPauseKeyForMetadata({ provider: "opencode", model: MUSE }), "the same key the rate-limit pause uses");
  assert.equal(providerPauseTarget("openrouter/anthropic/claude-x").model, "anthropic/claude-x");
  for (const bad of ["", "/x", "opencode/", "-x", "open code", "opencode/--attach"]) assert.equal(providerPauseTarget(bad).ok, false, bad);
});

test("Q-005: pausing one model holds back that model only, and resume ends it early", async () => {
  const paused = await callTool("pause_opencode_provider", { provider: `opencode/${MUSE}`, minutes: 30, reason: "Muse stalls above 4" });
  assert.notEqual(paused.isError, true, textOf(paused));
  assert.match(textOf(paused), new RegExp(`Provider paused: ${museKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(textOf(paused), /Scope: model opencode\/muse-spark-1\.3-contributor-free only/);
  const refused = await slot(opencodeKey, [museKey]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorType, "provider_paused");
  assert.match(refused.error, /paused until .* \(provider_paused: paused by the operator: Muse stalls above 4\)/);
  const otherModel = await slot(opencodeKey, [`${base}:opencode/other-free`]);
  assert.equal(otherModel.ok, true, "another model of the provider runs");
  await releaseProviderLease(otherModel.lease);
  const resumed = await callTool("resume_opencode_provider", { provider: `opencode/${MUSE}` });
  assert.match(textOf(resumed), /Pauses removed: .*muse-spark-1\.3-contributor-free \(was until .*, provider_paused\)/);
  const after = await slot(opencodeKey, [museKey]);
  assert.equal(after.ok, true, after.error);
  await releaseProviderLease(after.lease);
  assert.match(textOf(await callTool("resume_opencode_provider", { provider: `opencode/${MUSE}` })), /Pauses removed: none \(nothing was paused\)/);
});

test("Q-005: a provider pause covers every model; its resume also clears model pauses and the rate-limit backoff", async () => {
  const until = new Date(Date.now() + 20 * 60_000).toISOString();
  const paused = await callTool("pause_opencode_provider", { provider: "opencode", until });
  assert.notEqual(paused.isError, true, textOf(paused));
  assert.match(textOf(paused), /Scope: every model of opencode/);
  const refused = await slot(opencodeKey, [`${base}:opencode/anything`]);
  assert.equal(refused.errorType, "provider_paused");
  assert.equal(refused.cooldownUntil, until);
  // An automatic pause and its strike on one model of the same provider.
  const automatic = await recordRateLimitPause({ pauseKey: museKey, reason: "rate limit: test" });
  assert.equal(automatic.strikes, 1);
  const google = await slot(`${base}:google`, [`${base}:google/antigravity-gemini-3.8-flash`]);
  assert.equal(google.ok, true, "another provider is untouched");
  await releaseProviderLease(google.lease);
  const resumed = await callTool("resume_opencode_provider", { provider: "opencode" });
  const text = textOf(resumed);
  assert.match(text, /opencode \(was until .*, provider_paused\)/);
  assert.match(text, /muse-spark-1\.3-contributor-free \(was until .*, provider_rate_limited\)/);
  const again = await recordRateLimitPause({ pauseKey: museKey, reason: "rate limit: again" });
  assert.equal(again.strikes, 1, "the resume cleared the backoff, so the next pause starts at the first-strike 10 minutes (B-162)");
  assert.equal(again.durationMs, 10 * 60_000);
  await callTool("resume_opencode_provider", { provider: "opencode" });
});

test("Q-005: an operator pause replaces an automatic one, shorter or longer", async () => {
  const automatic = await recordRateLimitPause({ pauseKey: museKey, reason: "rate limit" });
  assert.equal(automatic.durationMs, 10 * 60_000);
  await callTool("pause_opencode_provider", { provider: `opencode/${MUSE}`, minutes: 5 });
  const snapshot = await providerCapacitySnapshot();
  const pause = snapshot.cooldowns.find((item) => item.providerKey === museKey);
  assert.equal(pause.errorType, "provider_paused");
  assert.ok(pause.remainingMs <= 5 * 60_000 && pause.remainingMs > 4 * 60_000, `shortened to 5 minutes, remaining ${pause.remainingMs}`);
  await callTool("resume_opencode_provider", { provider: "opencode" });
});

test("Q-005: invalid pause requests are refused and change nothing", async () => {
  const cases = [
    { provider: "bad provider", minutes: 5 },
    { provider: "opencode" },
    { provider: "opencode", minutes: 5, until: new Date(Date.now() + 60_000).toISOString() },
    { provider: "opencode", until: new Date(Date.now() - 60_000).toISOString() },
    { provider: "opencode", until: "tomorrow" },
    { provider: "opencode", until: new Date(Date.now() + 25 * 60 * 60_000).toISOString() },
    { provider: "opencode", minutes: 0 },
    { provider: "opencode", minutes: 2.5 },
  ];
  for (const args of cases) {
    const response = await callTool("pause_opencode_provider", args);
    assert.equal(response.isError, true, JSON.stringify(args));
    assert.match(textOf(response), /Provider pause rejected\.\s+errorType: provider_pause_invalid/, JSON.stringify(args));
  }
  assert.equal((await callTool("resume_opencode_provider", { provider: "/" })).isError, true);
  assert.equal((await providerCapacitySnapshot()).cooldowns.length, 0);
});

test("Q-005: the global worker cap holds back a slot on any provider once that many agents run", async () => {
  assert.equal(ENV_GLOBAL_WORKER_LIMIT, 0, "no cap unless configured");
  assert.match(describeConcurrencyLimits().global, /^effective 0 \(no cap\) \(env 0\)$/);
  const changed = await callTool("set_opencode_concurrency", { globalWorkerLimit: 2 });
  assert.notEqual(changed.isError, true, textOf(changed));
  assert.match(textOf(changed), /Global worker limit \(all providers and bridge processes\): effective 2 \(env 0, runtime override set .*\); was 0 \(no cap\)/);
  assert.equal(CONFIG.globalWorkerLimit, 2);
  const first = await slot(`${base}:opencode`);
  const second = await slot(`${base}:google`);
  assert.equal(first.ok && second.ok, true);
  const third = await slot(`${base}:openai`, [], 600);
  assert.equal(third.ok, false);
  assert.equal(third.errorType, "provider_slot_wait_timeout");
  assert.match(third.error, /the global worker cap was full \(2 of 2 workers running on all providers, CODEX_OPENCODE_GLOBAL_WORKER_LIMIT\)/);
  assert.equal((await providerCapacitySnapshot()).allLeaseCount, 2);
  await releaseProviderLease(first.lease);
  const afterRelease = await slot(`${base}:openai`);
  assert.equal(afterRelease.ok, true, afterRelease.error);

  // A restart keeps it; 0 removes the cap even though it is an override; reset returns to env.
  RUNTIME_CONCURRENCY.globalWorkerLimit = null;
  assert.equal(CONFIG.globalWorkerLimit, 0);
  await refreshRuntimeConcurrency({ force: true });
  assert.equal(CONFIG.globalWorkerLimit, 2, "persisted across a restart");
  assert.equal((await setRuntimeConcurrency({ globalWorkerLimit: 0 })).ok, true);
  const uncapped = await slot(`${base}:openai`);
  assert.equal(uncapped.ok, true, "0 means no cap");
  for (const lease of [second.lease, afterRelease.lease, uncapped.lease]) await releaseProviderLease(lease);
  assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
  assert.equal(CONFIG.globalWorkerLimit, ENV_GLOBAL_WORKER_LIMIT);
});

test("Q-005: invalid global limits are refused; the old limits keep their messages", async () => {
  for (const value of [-1, MAX_GLOBAL_WORKER_LIMIT + 1, 2.5, "4", true]) {
    const refused = await setRuntimeConcurrency({ globalWorkerLimit: value });
    assert.equal(refused.ok, false, JSON.stringify(value));
    assert.match(refused.error, /globalWorkerLimit must be an integer from 0 \(no cap\) to 64/);
  }
  assert.match((await setRuntimeConcurrency({ globalWorkerLimit: 3, reset: true })).error, /do not combine/);
  assert.match((await setRuntimeConcurrency({})).error, /reset: true/);
  const tool = await callTool("set_opencode_concurrency", { globalWorkerLimit: 99 });
  assert.equal(tool.isError, true);
  assert.match(textOf(tool), /globalWorkerLimit from 0 to 64/);
});

test("Q-005: get_opencode_bridge_status shows the global cap and every pause with how to end it", async () => {
  assert.equal((await setRuntimeConcurrency({ globalWorkerLimit: 3 })).ok, true);
  await callTool("pause_opencode_provider", { provider: `opencode/${MUSE}`, minutes: 10, reason: "status check" });
  try {
    const status = textOf(await callTool("get_opencode_bridge_status", { cwd: repo }));
    assert.match(status, /Global worker limit \(CODEX_OPENCODE_GLOBAL_WORKER_LIMIT, all providers and bridge processes\): effective 3 \(env 0, runtime override set .*\); workers running now: 0/);
    assert.match(status, /Paused providers: \n- .*:opencode\/muse-spark-1\.3-contributor-free: paused until .* \(provider_paused: paused by the operator: status check\); new jobs fail at once instead of starting; resume_opencode_provider ends it early/);
    assert.match(status, /Agent idle timeout \(CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS\): 600000 ms/);
  } finally {
    await callTool("resume_opencode_provider", { provider: "opencode" });
    assert.equal((await setRuntimeConcurrency({ reset: true })).ok, true);
  }
});

// Q-014b: per-provider slot limits at runtime (set_opencode_concurrency providerLimits), persisted
// as provider_limit:<provider> rows, read by a second bridge process through its refresh.
const { execFile: execFileCallback } = await import("node:child_process");
const { promisify } = await import("node:util");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const execFileAsync = promisify(execFileCallback);
const serverUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js")).href;
const secondProcessScript = path.join(fixtureRoot, "second-process.mjs");
await writeFile(secondProcessScript, [
  "process.argv.push('--self-test');",
  "process.env.CODEX_OPENCODE_LOG_LEVEL = 'off';",
  "process.env.CODEX_OPENCODE_OPS_LOG = 'off';",
  `const { __selfTest } = await import(${JSON.stringify(serverUrl)});`,
  "__selfTest.hooks.stateDirectoryOverride = process.argv[2];",
  "const { internals } = __selfTest;",
  "await internals.refreshRuntimeConcurrency({ force: true });",
  "const base = internals.CONFIG.providerConcurrencyKey;",
  "process.stdout.write(JSON.stringify({ codex: internals.providerLimitForKey(`${base}:codex`), agy: internals.providerLimitForKey(`${base}:agy`), google: internals.providerLimitForKey(`${base}:google`), perProvider: internals.describeConcurrencyLimits().perProvider }));",
  "process.exit(0);",
].join("\n"), "utf8");
const secondProcess = async () => {
  const { stdout } = await execFileAsync(process.execPath, [secondProcessScript, stateDir], { env: process.env, timeout: 120_000, windowsHide: true });
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
};

test("Q-014b: providerLimits sets one provider's slots at runtime; a second process reads it; reset clears it", async () => {
  const { providerLimitForKey } = internals;
  const globalLimit = CONFIG.providerConcurrencyLimit;
  assert.equal(describeConcurrencyLimits().perProvider, "", "none configured");
  const changed = await callTool("set_opencode_concurrency", { providerLimits: { codex: 5, Agy: 1 } });
  assert.notEqual(changed.isError, true, textOf(changed));
  assert.match(textOf(changed), /Per-provider slot limits: agy=1 \(runtime\), codex=5 \(runtime\)/);
  assert.equal(providerLimitForKey(`${base}:codex`), 5);
  assert.equal(providerLimitForKey(`${base}:agy`), 1, "the provider name is lower-cased like the env list");
  assert.equal(providerLimitForKey(`${base}:google`), globalLimit, "other providers keep the global limit");
  // The slot request applies it: one agy slot, the second waits.
  const first = await slot(`${base}:agy`);
  assert.equal(first.ok, true, first.error);
  const second = await slot(`${base}:agy`, [], 500);
  assert.equal(second.errorType, "provider_slot_wait_timeout");
  assert.match(second.error, /0 of 1|1 of 1/);
  await releaseProviderLease(first.lease);
  // Another bridge process (the queue worker, the other client) picks it up from the database.
  const other = await secondProcess();
  assert.deepEqual(other, { codex: 5, agy: 1, google: globalLimit, perProvider: "agy=1 (runtime), codex=5 (runtime)" });
  // A restart of this process keeps it.
  RUNTIME_CONCURRENCY.providerLimits = new Map();
  assert.equal(providerLimitForKey(`${base}:codex`), globalLimit);
  await refreshRuntimeConcurrency({ force: true });
  assert.equal(providerLimitForKey(`${base}:codex`), 5, "persisted");
  // L3: a providerLimit change names the providers that keep their own limit.
  const global = await callTool("set_opencode_concurrency", { providerLimit: 3 });
  assert.match(textOf(global), /providerLimit does not apply to agy=1 \(runtime\), codex=5 \(runtime\): they keep their own limit/);
  assert.equal(providerLimitForKey(`${base}:codex`), 5);
  assert.equal(providerLimitForKey(`${base}:google`), 3);
  // null clears one provider; the status shows the rest.
  const cleared = await setRuntimeConcurrency({ providerLimits: { agy: null } });
  assert.equal(cleared.ok, true, cleared.error);
  assert.deepEqual(cleared.current.providerLimits, { codex: 5 });
  assert.deepEqual(cleared.previousProviderLimits, { agy: 1, codex: 5 });
  assert.equal(providerLimitForKey(`${base}:agy`), 3, "back to providerLimit");
  const status = textOf(await callTool("get_opencode_bridge_status", { cwd: repo }));
  assert.match(status, /Per-provider slot limits: codex=5 \(runtime\)/);
  // reset clears the per-provider rows too, in this process and the other one.
  const reset = await callTool("set_opencode_concurrency", { reset: true });
  assert.notEqual(reset.isError, true, textOf(reset));
  assert.equal(providerLimitForKey(`${base}:codex`), CONFIG.providerConcurrencyLimit);
  assert.equal(describeConcurrencyLimits().perProvider, "");
  assert.equal((await secondProcess()).perProvider, "");
});

test("Q-014b: invalid providerLimits are refused and change nothing", async () => {
  const cases = [
    [{ codex: 0 }, /providerLimits\.codex must be an integer from 1 to 32; got 0 \(or null to clear it\)/],
    [{ codex: 33 }, /from 1 to 32/],
    [{ codex: 2.5 }, /from 1 to 32/],
    [{ codex: "4" }, /from 1 to 32/],
    [{ "bad name": 2 }, /is not a provider name/],
    [{ "-x": 2 }, /is not a provider name/],
    [[2], /must be an object of provider: slots/],
    ["codex=2", /must be an object of provider: slots/],
  ];
  for (const [value, pattern] of cases) {
    const refused = await setRuntimeConcurrency({ providerLimits: value });
    assert.equal(refused.ok, false, JSON.stringify(value));
    assert.equal(refused.errorType, "concurrency_invalid");
    assert.match(refused.error, pattern, JSON.stringify(value));
  }
  assert.match((await setRuntimeConcurrency({ providerLimits: { codex: 2 }, reset: true })).error, /do not combine it with .*providerLimits/);
  assert.match((await setRuntimeConcurrency({ providerLimits: {} })).error, /reset: true/, "an empty object changes nothing");
  const tool = await callTool("set_opencode_concurrency", { providerLimits: { codex: 0 } });
  assert.equal(tool.isError, true);
  assert.match(textOf(tool), /providerLimits as \{ "<provider>": 1 to 32 or null \}/);
  assert.equal(describeConcurrencyLimits().perProvider, "");
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
    }
  }
} finally {
  hooks.stateDirectoryOverride = "";
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
removeIsolatedStateDir(isolatedStateDir);
const skipGateFailed = finishSkips({ file: "tests/review-flex-runtime-control.js", total: tests.length, skips: [] });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} runtime control tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} runtime control tests passed.\n`);
process.exit(0);
