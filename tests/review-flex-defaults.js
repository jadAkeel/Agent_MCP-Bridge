#!/usr/bin/env node

// B-060 (log.md, 2026-10-02): the idle watchdog and the free-memory floor are on by default, and
// the idle limit can differ per model (CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL). The defaults are
// checked in a child process that imports server.js the way a real start reads its environment
// (no --self-test), with a scratch state directory; the parser and the per-model choice are checked
// in this process.
//   node tests/review-flex-defaults.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS;
delete process.env.CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL;
delete process.env.CODEX_OPENCODE_MIN_FREE_MEMORY_MB;
const { __selfTest } = await import("../server.js");
const { finishSkips } = await import("./skip-gate.js");
const { hooks, internals } = __selfTest;
const { CONFIG, DEFAULT_MIN_FREE_MEMORY_MB, agentIdleTimeoutForModel, agentIdleTimeoutStatusLine, assert, effectiveMinFreeMemoryMb, mkdtemp, path, queueMemoryGate, readModelDurationMapEnv, rm, runCommand, tmpdir } = internals;
const { totalmem } = await import("node:os");
const { fileURLToPath } = await import("node:url");

const serverUrl = new URL("../server.js", import.meta.url).href;
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "review-flex-defaults-"));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Imports server.js in a fresh process with the given variables (and no --self-test) and prints
// what the defaults resolved to.
async function probe(env = {}) {
  const script = [
    `const { __selfTest } = await import(${JSON.stringify(serverUrl)});`,
    "const i = __selfTest.internals;",
    "process.stdout.write(JSON.stringify({",
    "  idle: i.CONFIG.agentIdleTimeoutMs,",
    "  floor: i.CONFIG.minFreeMemoryMb,",
    "  gateFloor: i.queueMemoryGate().floorMb,",
    "  bunny: i.agentIdleTimeoutForModel({ provider: 'opencode', model: 'space-bunny-free' }),",
    "  muse: i.agentIdleTimeoutForModel({ provider: 'opencode', model: 'muse-spark-1.3-contributor-free' }),",
    "  line: i.agentIdleTimeoutStatusLine(),",
    "}));",
    "process.exit(0);",
  ].join("\n");
  const childEnv = { ...process.env, CODEX_OPENCODE_STATE_DIR: path.join(fixtureRoot, "state"), CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off", ...env };
  for (const name of ["CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS", "CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL", "CODEX_OPENCODE_MIN_FREE_MEMORY_MB"]) {
    if (!(name in env)) delete childEnv[name];
  }
  const result = await runCommand(process.execPath, ["--input-type=module", "-e", script], path.dirname(fileURLToPath(serverUrl)), 60_000, childEnv);
  return result;
}

test("B-060: a real start has a 10-minute idle watchdog and a free-memory floor without any variable", async () => {
  const result = await probe();
  assert.equal(result.exitCode, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.equal(values.idle, 600_000);
  const expectedFloor = Math.min(1024, Math.floor(totalmem() / (1024 * 1024) / 8));
  assert.equal(values.floor, expectedFloor);
  assert.equal(values.gateFloor, expectedFloor, "outside a self-test the gate uses the default floor");
  assert.ok(values.floor > 0, "the floor is on on any machine with more than 8 MB");
  assert.equal(values.bunny, 600_000);
  assert.match(values.line, /CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS\): 600000 ms; per model \(CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL\): none$/);
});

test("B-060: 0 still turns both off, and an explicit floor applies", async () => {
  const off = await probe({ CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS: "0", CODEX_OPENCODE_MIN_FREE_MEMORY_MB: "0" });
  assert.equal(off.exitCode, 0, off.stderr);
  const values = JSON.parse(off.stdout);
  assert.equal(values.idle, 0);
  assert.equal(values.floor, 0);
  assert.equal(values.gateFloor, 0);
  assert.match(values.line, /: disabled \(0\);/);
  const explicit = JSON.parse((await probe({ CODEX_OPENCODE_MIN_FREE_MEMORY_MB: "2048" })).stdout);
  assert.equal(explicit.floor, 2048);
  assert.equal(explicit.gateFloor, 2048);
});

test("B-060: a per-model idle limit applies to that model only", async () => {
  const result = await probe({ CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL: "opencode/space-bunny-free=1200000, OpenCode/Nemotron-3-Ultra-Free=1500000" });
  assert.equal(result.exitCode, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.equal(values.bunny, 1_200_000);
  assert.equal(values.muse, 600_000, "other models keep the global limit");
  assert.match(values.line, /opencode\/space-bunny-free=1200000 ms, opencode\/nemotron-3-ultra-free=1500000 ms$/);
});

test("B-060: a malformed per-model entry stops the bridge at startup", async () => {
  for (const bad of ["space-bunny-free=1200000", "opencode/x=", "opencode/x=-5", "opencode/x=10m", "opencode/x=99999999999"]) {
    const result = await probe({ CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL: bad });
    assert.notEqual(result.exitCode, 0, `${bad} must be refused`);
    assert.match(result.stderr, /CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL must be a comma-separated list of provider\/model=milliseconds/);
  }
});

test("B-060: the parser and the per-model choice in this process", () => {
  process.env.REVIEW_FLEX_MAP = "google/antigravity-gemini-3.8-flash=900000,openrouter/anthropic/claude=60000";
  try {
    const map = readModelDurationMapEnv("REVIEW_FLEX_MAP");
    assert.deepEqual([...map.entries()], [["google/antigravity-gemini-3.8-flash", 900_000], ["openrouter/anthropic/claude", 60_000]]);
  } finally {
    delete process.env.REVIEW_FLEX_MAP;
  }
  assert.equal(readModelDurationMapEnv("REVIEW_FLEX_UNSET").size, 0);
  CONFIG.agentIdleTimeoutByModel.set("google/antigravity-gemini-3.8-flash", 900_000);
  try {
    assert.equal(agentIdleTimeoutForModel({ provider: "Google", model: "antigravity-gemini-3.8-flash" }), 900_000, "matched without case");
    assert.equal(agentIdleTimeoutForModel({ provider: "opencode", model: "muse-spark-1.3-contributor-free" }), CONFIG.agentIdleTimeoutMs);
    assert.equal(agentIdleTimeoutForModel(null), CONFIG.agentIdleTimeoutMs);
    assert.match(agentIdleTimeoutStatusLine(), /google\/antigravity-gemini-3\.8-flash=900000 ms/);
  } finally {
    CONFIG.agentIdleTimeoutByModel.clear();
  }
});

test("B-060: in a self-test run without the variable the floor is 0, the test hook still sets one", () => {
  assert.equal(CONFIG.minFreeMemoryMb, DEFAULT_MIN_FREE_MEMORY_MB);
  assert.equal(effectiveMinFreeMemoryMb(), 0);
  assert.equal(queueMemoryGate().blocked, false);
  hooks.minFreeMemoryMbOverride = 4096;
  hooks.freeMemoryBytesTestHook = () => 100 * 1024 * 1024;
  try {
    assert.equal(queueMemoryGate().blocked, true);
  } finally {
    hooks.minFreeMemoryMbOverride = null;
    hooks.freeMemoryBytesTestHook = null;
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
    }
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-flex-defaults.js", total: tests.length, skips: [] });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} default tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} flexible-scheduling default tests passed.\n`);
process.exit(0);
