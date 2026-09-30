#!/usr/bin/env node

// Regression tests for the 2026-09-29 review of the spawn/lease/attestation region of
// server.js. Each test names the defect number it covers.
//   node tests/review-spawn.js
// "--self-test" is added to process.argv before the import because server.js keys
// its test-mode guards (background timers, attestation cache TTL) on that flag.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";

const execFileAsync = promisify(execFileCallback);
const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-review-spawn-"));

// Environment the module reads once at import time.
const fakeOpenCodeDir = path.join(scratch, "fake-opencode");
await mkdir(fakeOpenCodeDir, { recursive: true });
const fakeOpenCodeLog = path.join(fakeOpenCodeDir, "argv.log");
const fakeOpenCodeExecutable = path.join(fakeOpenCodeDir, process.platform === "win32" ? "opencode.exe" : "opencode");
const xdgCacheHome = path.join(scratch, "xdg-cache");
process.env.XDG_CACHE_HOME = xdgCacheHome;
process.env.CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS = "2000";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node,python,python3,py,npm,pnpm,yarn,bun,bunx,deno";
process.env.CODEX_OPENCODE_EXECUTABLE = fakeOpenCodeExecutable;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS;

const { __selfTest } = await import("../server.js");
const hooks = __selfTest.hooks;
const internals = __selfTest.internals;
const { CONFIG } = internals;

const stateDir = path.join(scratch, "state");
await mkdir(stateDir, { recursive: true });
hooks.stateDirectoryOverride = stateDir;

const results = [];
// A test that cannot run in this environment says so through skipTest(); it is reported as
// "skip" and counted apart from the passes. notePartialSkip() marks a test whose remaining
// checks could not run after its earlier ones passed.
class SkipTest extends Error {}
const skipTest = (reason) => { throw new SkipTest(reason); };
let partialSkip = "";
const notePartialSkip = (reason) => { partialSkip = reason; };
async function test(name, body) {
  const started = Date.now();
  partialSkip = "";
  try {
    await body();
    results.push({ name, ok: true, partialSkip });
    process.stdout.write(`ok   ${name} (${Date.now() - started} ms)${partialSkip ? ` [partly skipped: ${partialSkip}]` : ""}\n`);
  } catch (error) {
    if (error instanceof SkipTest) {
      results.push({ name, ok: false, skipped: error.message });
      process.stdout.write(`skip ${name}: ${error.message}\n`);
      return;
    }
    results.push({ name, ok: false, error });
    process.stdout.write(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 6).join("\n     ")}\n`);
  }
}
const need = (name) => {
  const value = internals[name];
  assert.ok(value !== undefined, `__selfTest.internals.${name} is not exported`);
  return value;
};

// A fake `opencode` executable. `debug agent <name>` prints fixture metadata; `run`
// appends its argv to a log and prints a minimal successful event stream. A prompt
// containing SLEEP2S makes it wait two seconds first.
const fixtureAgentName = "fixture-agent";
const fixtureAgentDebug = {
  name: fixtureAgentName,
  mode: "primary",
  model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
  variant: "high",
  temperature: 0.1,
  prompt: "fixture prompt",
  permission: [
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "*", action: "deny" },
  ],
  tools: { apply_patch: false, bash: false, edit: false, skill: false, task: false, webfetch: false, websearch: false, write: false },
};
const fakeEvents = [
  { type: "step_start", sessionID: "ses_fixture" },
  { type: "text", sessionID: "ses_fixture", part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_fixture", type: "text", text: "fixture done", time: { start: 1, end: 2 } } },
].map((event) => JSON.stringify(event)).join("\n");
let fakeOpenCodeReady = false;
let fakeOpenCodeSkipReason = "";
async function buildFakeOpenCode() {
  if (process.platform === "win32") {
    const source = path.join(fakeOpenCodeDir, "opencode.c");
    await writeFile(source, [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <windows.h>",
      "int main(int argc, char **argv) {",
      "  if (argc >= 3) { for (int i = 1; i + 1 < argc; i += 1) { if (strcmp(argv[i], \"debug\") == 0 && strcmp(argv[i + 1], \"agent\") == 0) {",
      `    fputs(${JSON.stringify(JSON.stringify(fixtureAgentDebug))}, stdout); return 0; } } }`,
      "  int run = 0; for (int i = 1; i < argc; i += 1) { if (strcmp(argv[i], \"run\") == 0) run = 1; }",
      "  if (!run) { fputs(\"unexpected fake OpenCode arguments\", stderr); return 2; }",
      `  FILE *log = fopen(${JSON.stringify(fakeOpenCodeLog)}, "ab");`,
      "  if (log) { for (int i = 1; i < argc; i += 1) { fputs(argv[i], log); fputc(0x1f, log); } fputc(0x1e, log); fclose(log); }",
      "  if (argc > 1 && strstr(argv[argc - 1], \"SLEEP2S\")) Sleep(2000);",
      `  fputs(${JSON.stringify(`${fakeEvents}\n`)}, stdout); fflush(stdout); return 0;`,
      "}",
    ].join("\n"), "utf8");
    for (const compiler of ["gcc", "C:\\MinGW\\bin\\gcc.exe"]) {
      try {
        await execFileAsync(compiler, [source, "-O2", "-o", fakeOpenCodeExecutable], { cwd: fakeOpenCodeDir, windowsHide: true, timeout: 60_000 });
        return true;
      } catch {
        // try the next compiler
      }
    }
    fakeOpenCodeSkipReason = "no C compiler (gcc) to build the Windows fake opencode";
    return false;
  }
  await writeFile(fakeOpenCodeExecutable, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const argv = process.argv.slice(2);",
    "const debugIndex = argv.indexOf('debug');",
    `if (debugIndex >= 0 && argv[debugIndex + 1] === 'agent') { process.stdout.write(${JSON.stringify(JSON.stringify(fixtureAgentDebug))}); process.exit(0); }`,
    "if (!argv.includes('run')) { process.stderr.write('unexpected fake OpenCode arguments'); process.exit(2); }",
    `fs.appendFileSync(${JSON.stringify(fakeOpenCodeLog)}, argv.map((item) => item + '\\x1f').join('') + '\\x1e');`,
    `const done = () => { process.stdout.write(${JSON.stringify(`${fakeEvents}\n`)}); };`,
    "if (String(argv[argv.length - 1]).includes('SLEEP2S')) setTimeout(done, 2000); else done();",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  return true;
}
fakeOpenCodeReady = await buildFakeOpenCode();
const fixtureMetadata = () => ({ ok: true, metadata: internals.normalizeAgentDebugMetadata(structuredClone(fixtureAgentDebug), fixtureAgentName), pluginPolicy: { ok: true, mode: "pure", plugins: [] } });
async function lastFakeRunArgs() {
  // Records end with 0x1e and arguments with 0x1f: prompts contain newlines.
  const lines = (await readFile(fakeOpenCodeLog, "utf8")).split("\x1e").filter(Boolean);
  return lines.at(-1).split("\x1f").slice(0, -1);
}
async function fillProviderKey(providerKey) {
  const leases = [];
  for (let index = 0; index < CONFIG.providerConcurrencyLimit; index += 1) {
    const lease = await need("acquireProviderLease")({ providerKey, timeoutMs: 5000 });
    assert.equal(lease.ok, true, lease.error);
    leases.push(lease.lease);
  }
  return leases;
}
async function releaseAll(leases) {
  for (const lease of leases) await need("releaseProviderLease")(lease);
}
const workCwd = path.join(scratch, "work");
await mkdir(workCwd, { recursive: true });

// ---------------------------------------------------------------------------
// #1 argument injection through modelRequirement.variant
await test("#1 model/provider/variant values that look like options are rejected", async () => {
  const schema = need("modelRequirementSchema");
  assert.equal(schema.safeParse({ provider: "opencode", model: "gpt-5.3-codex", variant: "--attach=http://127.0.0.1:4096" }).success, false);
  assert.equal(schema.safeParse({ provider: "-f", model: "x" }).success, false);
  assert.equal(schema.safeParse({ provider: "opencode", model: "--agent=build" }).success, false);
  assert.equal(schema.safeParse({ provider: "opencode", model: "gpt-5.3-codex", variant: "high" }).success, true);
  assert.equal(schema.safeParse({ provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" }).success, true);
  const parse = need("parseModelAllowlistEntry");
  assert.equal(parse("opencode/gpt-5.3-codex@--file=x"), null);
  assert.equal(parse("-x/model"), null);
  assert.equal(parse("opencode/-model"), null);
  assert.deepEqual(parse("opencode/gpt-5.3-codex@high"), { provider: "opencode", model: "gpt-5.3-codex", variant: "high" });
});
await test("#1 opencode run receives --model=/--variant= as single tokens and a prompt that is never an option", async () => {
  const args = need("openCodeRunArgs")("planner", "--attach=http://host:4096 do it", { provider: "opencode", model: "gpt-5.3-codex", variant: "--file=/etc/passwd" });
  assert.ok(args.includes("--model=opencode/gpt-5.3-codex"), args.join(" "));
  assert.ok(args.includes("--variant=--file=/etc/passwd"), args.join(" "));
  assert.ok(!args.includes("--variant") && !args.includes("--model"), args.join(" "));
  assert.ok(!String(args.at(-1)).startsWith("-"), `prompt argument starts with a dash: ${args.at(-1)}`);
  assert.ok(String(args.at(-1)).includes("--attach=http://host:4096 do it"), "the prompt text itself is preserved");
});
await test("#1 end to end: the spawned opencode sees the pinned model and variant as single tokens", async () => {
  if (!fakeOpenCodeReady) skipTest(fakeOpenCodeSkipReason);
  const result = await need("runOpenCode")(fixtureAgentName, "-starts with a dash", workCwd, false, 20_000, { agentMetadata: fixtureMetadata() });
  assert.equal(result.errorType, null, `${result.errorType}: ${result.stderr}`);
  const argv = await lastFakeRunArgs();
  assert.ok(argv.includes("--model=opencode/muse-spark-1.3-contributor-free"), argv.join(" "));
  assert.ok(argv.includes("--variant=high"), argv.join(" "));
  assert.ok(!argv.at(-1).startsWith("-"), argv.at(-1));
});

// #2 provider slot taken on the provider the run will actually use
await test("#2 a model override leases the overridden provider's slot", async () => {
  if (!fakeOpenCodeReady) skipTest(fakeOpenCodeSkipReason);
  const requirement = { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" };
  const googleKey = `${CONFIG.providerConcurrencyKey}:google`;
  hooks.selfTestModelOverrideAllowlist = ["google/antigravity-gemini-3.8-flash@high"];
  try {
    const held = await fillProviderKey(googleKey);
    try {
      const blocked = await need("runOpenCode")(fixtureAgentName, "task", workCwd, false, 20_000, {
        agentMetadata: fixtureMetadata(),
        metadataPolicyOptions: { modelRequirement: requirement },
      });
      assert.equal(blocked.errorType, "provider_slot_wait_timeout", `the saturated google slots must block the run; got ${blocked.errorType} (${blocked.stderr})`);
      assert.equal(blocked.providerConcurrencyKey, googleKey);
    } finally {
      await releaseAll(held);
    }
    const result = await need("runOpenCode")(fixtureAgentName, "task", workCwd, false, 20_000, {
      agentMetadata: fixtureMetadata(),
      metadataPolicyOptions: { modelRequirement: requirement },
    });
    assert.equal(result.errorType, null, `${result.errorType}: ${result.stderr}`);
    assert.equal(result.providerConcurrencyKey, googleKey);
    assert.ok((await lastFakeRunArgs()).includes("--model=google/antigravity-gemini-3.8-flash"));
  } finally {
    hooks.selfTestModelOverrideAllowlist = null;
  }
});

// #3 provider error classification
await test("#3 ordinary 429 quota/rate-limit texts are rate limits, explicit billing markers stay billing", async () => {
  const classify = need("providerErrorTypeFromText");
  const gemini = "APIError 429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.";
  const openAiRate = "HTTP 429 Too Many Requests: Rate limit reached. Visit https://platform.openai.com/account/billing to add a payment method to your account";
  assert.equal(classify(gemini), "opencode_rate_limited");
  assert.equal(classify(openAiRate), "opencode_rate_limited");
  assert.equal(classify("HTTP 429 insufficient_quota: You exceeded your current quota, please check your plan and billing details"), "opencode_billing_error");
  assert.equal(classify("CreditsError: no credits left"), "opencode_billing_error");
  assert.equal(classify("HTTP 402 Payment Required"), "opencode_billing_error");
  assert.equal(classify("429 RESOURCE_EXHAUSTED daily quota exceeded"), "opencode_quota_exhausted");
  const structured = need("providerErrorTypeFromStructuredEvent");
  const event = { type: "error", error: { name: "APIError", data: { message: "You exceeded your current quota, please check your plan and billing details.", statusCode: 429, isRetryable: true, providerID: "google" } } };
  assert.equal(structured(event), "opencode_rate_limited");
  const retryableUnknown = { type: "error", error: { name: "APIError", data: { message: "upstream hiccup", isRetryable: true, providerID: "google" } } };
  assert.equal(structured(retryableUnknown), "opencode_transient_provider_error");
  const credits = { type: "error", error: { name: "CreditsError", data: { message: "Insufficient balance", statusCode: 402 } } };
  assert.equal(structured(credits), "opencode_billing_error");
});
await test("#3 a completed run is not failed by a retried transient APIError in stderr", async () => {
  const inspect = need("inspectOpenCodeEventStream");
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "s1" }),
    JSON.stringify({ type: "text", sessionID: "s1", part: { id: "p", messageID: "m", type: "text", text: "final answer", time: { end: 1 } } }),
  ].join("\n");
  const inspection = inspect(stdout, "ERROR 2026-09-29 service=llm APIError: provider returned an error, retrying");
  assert.equal(inspection.providerErrorType, "");
  assert.equal(inspection.recoveredTransientProviderError, true);
});

// #4 forbidden-path globs
await test("#4 glob syntax in forbidden paths matches what it says", async () => {
  const globToRegex = need("globToRegex");
  const isWithinAnyPath = need("isWithinAnyPath");
  assert.ok(isWithinAnyPath("config/prod.json", ["config/{prod,staging}.json"], workCwd));
  assert.ok(isWithinAnyPath("config/staging.json", ["config/{prod,staging}.json"], workCwd));
  assert.ok(!isWithinAnyPath("config/dev.json", ["config/{prod,staging}.json"], workCwd));
  assert.ok(isWithinAnyPath("certs/server.pem", ["**/*.{pem,key}"], workCwd));
  assert.ok(isWithinAnyPath("server.key", ["**/*.{pem,key}"], workCwd));
  assert.ok(isWithinAnyPath("settings.py", ["**/settings.py"], workCwd));
  assert.ok(isWithinAnyPath("app/deep/settings.py", ["**/settings.py"], workCwd));
  assert.ok(!isWithinAnyPath("app/settings.pyc", ["**/settings.py"], workCwd));
  assert.ok(isWithinAnyPath("a1.txt", ["a?.txt"], workCwd));
  assert.ok(!isWithinAnyPath("a/.txt", ["a?.txt"], workCwd), "? never matches a slash");
  assert.ok(isWithinAnyPath("log3.txt", ["log[0-9].txt"], workCwd));
  assert.ok(!isWithinAnyPath("logx.txt", ["log[0-9].txt"], workCwd));
  assert.ok(isWithinAnyPath("logx.txt", ["log[!0-9].txt"], workCwd));
  assert.ok(!isWithinAnyPath("log/.txt", ["log[!0-9].txt"], workCwd), "a negated class never matches a slash");
  assert.ok(globToRegex("src/**/x.ts").test("src/x.ts"));
  assert.ok(globToRegex("src/**/x.ts").test("src/a/b/x.ts"));
  assert.ok(!globToRegex("src/*.ts").test("src/a/x.ts"));
  assert.ok(globToRegex("a{b,c{d,e}}f").test("acef"), "nested braces");
  assert.ok(globToRegex("a+b(c).txt").test("a+b(c).txt"), "regex metacharacters stay literal");
});
await test("#4 DEFAULT_FORBIDDEN_EDIT_PATHS match everything they matched before", async () => {
  const isWithinAnyPath = need("isWithinAnyPath");
  const forbidden = need("DEFAULT_FORBIDDEN_EDIT_PATHS");
  for (const file of [".env", ".env.local", "apps/web/.env", "apps/web/.env.production", "key.pem", "a/b/key.pem", "private.key", "a/private.key", "secrets/x", "secrets/a/b", "a/secrets/x"]) {
    assert.ok(isWithinAnyPath(file, forbidden, workCwd), `${file} must stay forbidden`);
  }
  for (const file of ["src/env.ts", "README.md", "secretsauce/x", "a/keys.txt", "src/pem.ts", ".environment"]) {
    assert.ok(!isWithinAnyPath(file, forbidden, workCwd), `${file} must stay allowed`);
  }
});

// #5 plugin cache root follows XDG_CACHE_HOME
await test("#5 plugin integrity checks the cache tree OpenCode loads when XDG_CACHE_HOME is set", async () => {
  const resolution = need("expectedOpenCodePluginResolution")("@scope/plugin@1.2.3");
  assert.equal(path.resolve(resolution.root), path.resolve(xdgCacheHome, "opencode", "packages", "@scope/plugin@1.2.3"));
});

// #6 waiting for a provider slot does not consume the run timeout
await test("#6 a slot wait past its own budget fails as provider_slot_wait_timeout naming the holders", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review-wait`;
  const held = await fillProviderKey(key);
  try {
    const lease = await need("acquireProviderLease")({ providerKey: key, timeoutMs: 300 });
    assert.equal(lease.ok, false);
    assert.equal(lease.errorType, "provider_slot_wait_timeout");
    assert.equal(lease.holders, CONFIG.providerConcurrencyLimit);
    assert.match(lease.error, new RegExp(`${CONFIG.providerConcurrencyLimit} of ${CONFIG.providerConcurrencyLimit} slots`));
  } finally {
    await releaseAll(held);
  }
});
await test("#6 the run timeout starts when the slot is granted", async () => {
  if (!fakeOpenCodeReady) skipTest(fakeOpenCodeSkipReason);
  const key = `${CONFIG.providerConcurrencyKey}:opencode`;
  const held = await fillProviderKey(key);
  // Free one slot after 1.5 s (inside CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS=2000). The fake run
  // takes 2 s; a 3.2 s run timeout only suffices if the wait is not taken out of it.
  const releaser = new Promise((resolve) => setTimeout(() => need("releaseProviderLease")(held.shift()).then(resolve), 1500));
  try {
    const result = await need("runOpenCode")(fixtureAgentName, "SLEEP2S please", workCwd, false, 3200, { agentMetadata: fixtureMetadata() });
    assert.equal(result.errorType, null, `${result.errorType}: ${result.stderr}`);
    assert.ok(result.providerConcurrencyWaitMs >= 1000, `waited ${result.providerConcurrencyWaitMs} ms`);
  } finally {
    await releaser;
    await releaseAll(held);
  }
});

// #7 multi-byte UTF-8 split across pipe reads
await test("#7 multi-byte characters split across stdout chunks are decoded intact", async () => {
  // 14-byte unit (five 2-byte Arabic letters, one 4-byte emoji): pipe reads of any power-of-two size split characters.
  const unit = String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627, 0x1f600);
  const payload = `process.stdout.write(Buffer.from(${JSON.stringify(unit)}.repeat(40000)))`;
  const result = await need("runSpawnCommand")(process.execPath, ["-e", payload], workCwd, 30_000);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(!result.stdout.includes(String.fromCharCode(0xfffd)), "no replacement characters");
  assert.equal(result.stdout, unit.repeat(40000));
});
await test("#7 a provider diagnostic split across stderr chunks still fails the run fast", async () => {
  const payload = [
    "process.stderr.write('ERROR 2026 service=llm APIError: Credits');",
    "setTimeout(() => process.stderr.write('Error: insufficient balance\\n'), 150);",
    "setTimeout(() => {}, 8000);",
  ].join("");
  const started = Date.now();
  const result = await need("runSpawnCommand")(process.execPath, ["-e", payload], workCwd, 20_000, null, { terminateOnProviderError: true });
  assert.equal(result.providerTerminated, true, `stderr: ${result.stderr}`);
  assert.ok(Date.now() - started < 7000);
});

// #8 stdout written after the control-channel exit event is kept
await test("#8 output that arrives after the supervisor's exit event is not lost", async () => {
  const fakeSupervisor = path.join(scratch, "late-supervisor.cjs");
  await writeFile(fakeSupervisor, [
    "const fs = require('node:fs');",
    "const identity = process.argv[process.argv.indexOf('--identity') + 1];",
    "const emit = (type, extra = {}) => fs.writeSync(3, JSON.stringify({ type, supervisorIdentity: identity, ...extra }) + '\\n');",
    "emit('ready', { protocolVersion: 1, supervisorPid: process.pid });",
    "let buffered = '';",
    "process.stdin.on('data', (chunk) => {",
    "  buffered += chunk;",
    "  if (!buffered.includes('\"launch\"')) return;",
    "  process.stdout.write('first-part\\n');",
    "  emit('exit', { payloadExitCode: 0, reason: 'payload_closed', treeTerminationConfirmed: true, containmentGuarantee: 'posix_process_group' });",
    "  setTimeout(() => { process.stdout.write('LATE-TAIL\\n', () => process.exit(0)); }, 300);",
    "});",
  ].join("\n"), "utf8");
  const result = await need("runSpawnCommand")(process.execPath, ["-e", "0"], workCwd, 20_000, null, { supervisorScriptForTest: fakeSupervisor });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /first-part/);
  assert.match(result.stdout, /LATE-TAIL/, `stdout was: ${JSON.stringify(result.stdout)}`);
});

// #9 binary hunks
await test("#9 binary hunks are rejected unless the extension is a known binary type", async () => {
  const gate = need("binaryTextFilesInPatch");
  const patch = [
    "diff --git a/assets/logo.png b/assets/logo.png", "GIT binary patch", "literal 1", "x",
    "diff --git a/data/model.bin b/data/model.bin", "GIT binary patch", "literal 1", "x",
    "diff --git a/scripts/run b/scripts/run", "Binary files a/scripts/run and b/scripts/run differ",
    "diff --git a/lib/native.dll b/lib/native.dll", "GIT binary patch", "literal 1", "x",
    "diff --git a/fonts/a.woff2 b/fonts/a.woff2", "GIT binary patch", "literal 1", "x",
  ].join("\n");
  assert.deepEqual(gate(patch), ["data/model.bin", "scripts/run", "lib/native.dll"]);
  assert.deepEqual(gate("diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-x\n+y"), []);
});
await test("#9 integrate_opencode_worktree accepts an explicit acceptBinaryHunks flag", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /acceptBinaryHunks: z\.boolean\(\)\.optional\(\)/);
  assert.match(source, /binaryTextFiles\.length && !acceptBinaryHunks/);
});

// #10 .git edits
await test("#10 the default forbidden set covers the Git control surface", async () => {
  const isWithinAnyPath = need("isWithinAnyPath");
  const forbidden = need("DEFAULT_FORBIDDEN_EDIT_PATHS");
  for (const file of [".git", ".git/config", ".git/hooks/pre-commit", "vendor/lib/.git", "vendor/lib/.git/config"]) {
    assert.ok(isWithinAnyPath(file, forbidden, workCwd), `${file} must be forbidden`);
  }
  for (const file of [".github/workflows/ci.yml", ".gitignore", ".gitattributes", "src/git/x.ts"]) {
    assert.ok(!isWithinAnyPath(file, forbidden, workCwd), `${file} must stay allowed`);
  }
});
await test("#10 the managed writer profiles deny exactly DEFAULT_FORBIDDEN_EDIT_PATHS", async () => {
  const forbidden = need("DEFAULT_FORBIDDEN_EDIT_PATHS");
  for (const agent of ["builder", "debugger"]) {
    const source = await readFile(new URL(`../opencode/agents/${agent}.md`, import.meta.url), "utf8");
    const editBlock = /\n  edit:\n((?:    .+\n)+)/.exec(source.replace(/\r\n/g, "\n"))?.[1] || "";
    const denied = [...editBlock.matchAll(/^    "([^"]+)": deny$/gm)].map((match) => match[1]);
    assert.deepEqual([...denied].sort(), [...forbidden].sort(), `${agent}.md edit deny list`);
  }
});
await test("#10 gitControlSurfaceFingerprint detects config and hook edits in a repo and a linked worktree", async () => {
  const fingerprint = need("gitControlSurfaceFingerprint");
  const changes = need("gitControlSurfaceChanges");
  const repo = path.join(scratch, "fingerprint-repo");
  await mkdir(repo, { recursive: true });
  const git = (args, cwd = repo) => execFileAsync("git", args, { cwd, windowsHide: true });
  await git(["init", "-q"]);
  await git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const before = await fingerprint(repo);
  assert.equal(before.ok, true, before.error);
  await writeFile(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho owned\n", "utf8");
  const afterHook = await fingerprint(repo);
  assert.notEqual(afterHook.sha256, before.sha256);
  assert.deepEqual(changes(before, afterHook), ["common/hooks", "common/hooks/post-checkout"]);
  await git(["config", "core.hooksPath", "/tmp/elsewhere"]);
  const afterConfig = await fingerprint(repo);
  assert.deepEqual(changes(afterHook, afterConfig), ["common/config"]);
  const worktree = path.join(scratch, "fingerprint-worktree");
  await git(["worktree", "add", "-q", "--detach", worktree]);
  const linked = await fingerprint(worktree);
  assert.equal(linked.ok, true, linked.error);
  assert.equal(linked.entries["common/config"], afterConfig.entries["common/config"], "a linked worktree shares the common config");
  // Git for Windows marks .git hidden, and Windows refuses to truncate-create a hidden file.
  const pointer = await open(path.join(worktree, ".git"), "r+");
  try {
    await pointer.truncate(0);
    await pointer.write("gitdir: /somewhere/else\n", 0, "utf8");
  } finally {
    await pointer.close();
  }
  const redirected = await fingerprint(worktree);
  assert.ok(changes(linked, redirected).includes(".git"), "a rewritten .git pointer file is detected");
});

// #11 env parsing
await test("#11 blank numeric env values keep the default; unknown choices fail at startup", async () => {
  const readNonNegativeIntEnv = need("readNonNegativeIntEnv");
  const readChoiceEnv = need("readChoiceEnv");
  process.env.REVIEW_SPAWN_NUMBER = "";
  assert.equal(readNonNegativeIntEnv("REVIEW_SPAWN_NUMBER", 30000), 30000);
  process.env.REVIEW_SPAWN_NUMBER = "  ";
  assert.equal(readNonNegativeIntEnv("REVIEW_SPAWN_NUMBER", 30000), 30000);
  process.env.REVIEW_SPAWN_NUMBER = "0";
  assert.equal(readNonNegativeIntEnv("REVIEW_SPAWN_NUMBER", 30000), 0);
  delete process.env.REVIEW_SPAWN_NUMBER;
  assert.equal(readNonNegativeIntEnv("REVIEW_SPAWN_NUMBER", 7), 7);
  process.env.REVIEW_SPAWN_CHOICE = "writes";
  assert.throws(() => readChoiceEnv("REVIEW_SPAWN_CHOICE", ["off", "write", "all"], "off"), /REVIEW_SPAWN_CHOICE must be one of off, write, all/);
  process.env.REVIEW_SPAWN_CHOICE = " Write ";
  assert.equal(readChoiceEnv("REVIEW_SPAWN_CHOICE", ["off", "write", "all"], "off"), "write");
  process.env.REVIEW_SPAWN_CHOICE = "";
  assert.equal(readChoiceEnv("REVIEW_SPAWN_CHOICE", ["off", "write", "all"], "off"), "off");
  delete process.env.REVIEW_SPAWN_CHOICE;
});

// #12 transient renewal errors
await test("#12 a thrown lease-renewal error keeps the confirmed deadline instead of failing", async () => {
  const lease = { id: "review-heartbeat", providerKey: "k", expiresAt: Date.now() + CONFIG.providerLeaseMs };
  let calls = 0;
  const heartbeat = internals.startProviderLeaseHeartbeat(lease, {
    intervalMs: 60_000,
    refreshLease: async () => { calls += 1; throw new Error("database is locked (SQLITE_BUSY)"); },
  });
  try {
    const proof = await heartbeat.pulse();
    assert.equal(calls, 1);
    assert.ok(proof && proof.ok === true, `pulse returned ${JSON.stringify(proof)}`);
    assert.ok(proof.deadlineAt > Date.now() && proof.deadlineAt <= lease.expiresAt);
    assert.equal(heartbeat.signal.aborted, false);
  } finally {
    heartbeat();
  }
  const lost = internals.startProviderLeaseHeartbeat({ id: "review-heartbeat-2", providerKey: "k", expiresAt: Date.now() + CONFIG.providerLeaseMs }, {
    intervalMs: 60_000,
    refreshLease: async () => false,
  });
  try {
    assert.equal(await lost.pulse(), false, "a renewal that changed no row still fails");
    assert.equal(lost.signal.aborted, true);
  } finally {
    lost();
  }
});

// #13 quarantine of an expired lease
await test("#13 quarantining an already-expired lease writes a new quarantine row", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review-quarantine`;
  const acquired = await need("acquireProviderLease")({ providerKey: key, timeoutMs: 5000 });
  assert.equal(acquired.ok, true);
  const db = await need("openProviderLeaseDb")();
  try {
    db.prepare("UPDATE provider_leases SET expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, acquired.lease.id);
  } finally {
    internals.closeDb(db);
  }
  const result = await need("quarantineProviderLease")(acquired.lease, JSON.stringify({ pids: [999999], complete: true, recordedAt: Date.now() }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inserted, true);
  const check = await need("openProviderLeaseDb")();
  try {
    const row = check.prepare("SELECT provider_key, expires_at FROM provider_leases WHERE lease_id = ?").get(result.leaseId);
    assert.equal(row.provider_key, key);
    assert.equal(Number(row.expires_at), Number.MAX_SAFE_INTEGER);
    check.prepare("DELETE FROM provider_leases WHERE lease_id = ?").run(result.leaseId);
  } finally {
    internals.closeDb(check);
  }
});

// #14 PID reuse
await test("#14 containment evidence records creation times and ignores a reused PID", async () => {
  const table = await need("processTable")();
  assert.equal(table.ok, true);
  const self = table.rows.find((row) => row.pid === process.pid);
  assert.ok(self?.createdAt, "the process table reports this process's creation time");
  const record = JSON.parse(await need("containmentRecord")({ supervisorProcessId: process.pid, payloadProcessId: 0 }));
  assert.ok(record.processes.some((item) => item.pid === process.pid && item.createdAt === self.createdAt), JSON.stringify(record));
  const stillPossible = internals.containmentStillPossible;
  const old = Date.now() - 1000 * 60 * 60;
  assert.equal(await stillPossible(JSON.stringify({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: self.createdAt }], complete: true, recordedAt: old })), true, "the same process keeps the quarantine");
  assert.equal(await stillPossible(JSON.stringify({ pids: [process.pid], processes: [{ pid: process.pid, createdAt: "1" }], complete: true, recordedAt: old })), false, "a reused PID does not");
  assert.equal(await stillPossible(JSON.stringify({ pids: [process.pid], complete: true, recordedAt: old })), true, "PID-only evidence stays conservative");
});

// #15 launch gate refusal
await test("#15 an explicit launch-gate refusal stops the payload before launch", async () => {
  const marker = path.join(scratch, "launch-gate-marker.txt");
  const result = await need("runSpawnCommand")(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], workCwd, 20_000, null, {
    onSpawn: async () => ({ ok: false, errorType: "queue_lease_lost" }),
  });
  assert.equal(result.terminationErrorType, "child_identity_persistence_failed");
  assert.equal(existsSync(marker), false, "the payload must not have run");
});

// #16 validation command trust
await test("#16 interpreter and package-executor bypasses are rejected, ordinary arguments are not", async () => {
  const trust = need("validationCommandTrustError");
  for (const command of [
    ["node", "-p", "1"], ["node", "-pe", "1"], ["node", "--eval=1"], ["node", "--import=./x.mjs", "t.js"], ["node", "--require", "./x.js", "t.js"], ["node", "-r", "./x.js", "t.js"],
    ["python", "-Ic", "print(1)"], ["py", "-c", "print(1)"], ["python3", "-c", "1"],
    ["npm", "init", "x"], ["npm", "create", "vite"], ["pnpm", "create", "x"], ["yarn", "create", "x"], ["bunx", "x"], ["npm", "--prefix", "foo", "exec", "x"], ["yarn", "node", "-e", "1"],
    ["npm", "exec", "x"], ["pnpm", "dlx", "x"], ["bun", "x", "y"],
  ]) {
    assert.ok(trust(command), `${command.join(" ")} must be rejected`);
  }
  for (const command of [["pnpm", "test", "--filter", "x"], ["npm", "run", "exec"], ["npm", "test", "--", "x"], ["python", "-m", "pytest", "-p", "no:cacheprovider"], ["node", "--test"], ["node", "tests/review-spawn.js"], ["yarn", "test", "dlx"]]) {
    assert.equal(trust(command), "", `${command.join(" ")} must be allowed`);
  }
});

// #17 validation executable resolution
await test("#17 PATH entries that are files do not break resolution; symlinked binaries resolve to their target", async () => {
  const resolve = need("resolveValidationExecutable");
  const fileEntry = path.join(scratch, "not-a-directory");
  await writeFile(fileEntry, "x", "utf8");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = [fileEntry, path.dirname(process.execPath), originalPath].join(path.delimiter);
    const resolved = await resolve("node");
    assert.ok(resolved.path && resolved.sha256);
  } finally {
    process.env.PATH = originalPath;
  }
  const linkDir = path.join(scratch, "link-bin");
  await mkdir(linkDir, { recursive: true });
  const linkName = path.join(linkDir, process.platform === "win32" ? "node.exe" : "node");
  try {
    await symlink(process.execPath, linkName, "file");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      notePartialSkip("symlink part: no symlink privilege");
      return;
    }
    throw error;
  }
  try {
    process.env.PATH = [linkDir, originalPath].join(path.delimiter);
    const resolved = await resolve("node");
    assert.equal(path.resolve(resolved.path).toLowerCase(), path.resolve(realpathSync(process.execPath)).toLowerCase(), "the link resolves to its target");
  } finally {
    process.env.PATH = originalPath;
  }
});

// #18 provider capacity snapshot per key
await test("#18 the capacity snapshot reports each provider key with its own capacity", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review-snapshot`;
  const lease = await need("acquireProviderLease")({ providerKey: key, timeoutMs: 5000 });
  try {
    const snapshot = await need("providerCapacitySnapshot")();
    assert.equal(snapshot.ok, true, snapshot.error);
    const entry = snapshot.keys.find((item) => item.providerKey === key);
    assert.ok(entry, JSON.stringify(snapshot.keys));
    assert.equal(entry.leases, 1);
    assert.equal(entry.capacity, CONFIG.providerConcurrencyLimit);
  } finally {
    await need("releaseProviderLease")(lease.lease);
  }
  assert.equal(need("providerKeyLikePattern")("a_b%c\\d"), "a\\_b\\%c\\\\d:%");
});

// #18b a stored limit from before a raise binds only while leases taken under it are held
await test("#18b an idle key with an old stored limit reports the configured capacity", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review-stale-capacity`;
  const setStored = async (capacity) => {
    const db = await need("openProviderLeaseDb")({ deadlineAt: Date.now() + 5000 });
    try {
      db.prepare("INSERT INTO provider_capacities (provider_key, capacity, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET capacity = excluded.capacity").run(key, capacity, Date.now());
    } finally {
      need("closeDb")(db);
    }
  };
  const lower = Math.max(1, CONFIG.providerConcurrencyLimit - 1);
  const entryFor = async () => (await need("providerCapacitySnapshot")()).keys.find((item) => item.providerKey === key);
  await setStored(CONFIG.providerConcurrencyLimit + 5);
  assert.equal((await entryFor()).capacity, CONFIG.providerConcurrencyLimit, "an idle key shows the limit its next acquire will use");
  const lease = await need("acquireProviderLease")({ providerKey: key, timeoutMs: 5000 });
  try {
    await setStored(lower);
    const held = await entryFor();
    assert.equal(held.leases, 1);
    assert.equal(held.capacity, Math.min(lower, CONFIG.providerConcurrencyLimit), "while leases are held the stricter stored limit binds");
  } finally {
    await need("releaseProviderLease")(lease.lease);
  }
});

// #19 DEPENDENCY_REQUIRED heading
await test("#19 a bare DEPENDENCY_REQUIRED heading does not capture the next line", async () => {
  const parse = need("parseDependencyRequest");
  const report = "7. DEPENDENCY_REQUIRED\n{\"packages\":[{\"name\":\"numpy\"}],\"reason\":\"needed\"}\n";
  assert.deepEqual(parse("DEPENDENCY_REQUIRED\n{\"packages\":[{\"name\":\"numpy\"}],\"reason\":\"needed\"}"), { request: null, error: "" });
  assert.deepEqual(parse(report), { request: null, error: "" });
  const real = parse("DEPENDENCY_REQUIRED {\"packages\":[{\"name\":\"numpy\"}],\"reason\":\"needed\"}\r\n");
  assert.equal(real.request?.packages?.[0]?.name, "numpy", JSON.stringify(real));
});

// #20 read-only retry accounting
await test("#20 a single timed-out read-only attempt is reported as one attempt and agent_timeout", async () => {
  const exhausted = need("readOnlyRetryBudgetExhaustedResult");
  const timedOut = exhausted({ timedOut: true, exitCode: 124, stderr: "" }, 1, 2);
  assert.equal(timedOut.errorType, "agent_timeout");
  assert.equal(timedOut.retryAttempt, 0);
  assert.equal(timedOut.attemptsMade, 1);
  assert.match(timedOut.stderr, /after 1 bounded attempt\b/);
  const unavailable = exhausted({ timedOut: false, exitCode: 1, errorType: "opencode_rate_limited", stderr: "" }, 2, 2);
  assert.equal(unavailable.errorType, "read_only_agent_unavailable");
  assert.match(unavailable.stderr, /after 2 bounded attempts/);
});

// #21 subagentStrategy "direct"
await test("#21 subagentStrategy direct is no longer advertised by the job schema", async () => {
  const schema = internals.z.object(need("jobInputShape"));
  assert.equal(schema.safeParse({ agent: "explore", task: "t", cwd: workCwd, subagentStrategy: "direct" }).success, false);
  assert.equal(schema.safeParse({ agent: "explore", task: "t", cwd: workCwd, subagentStrategy: "proxy" }).success, true);
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /or "direct" only if you want to test native CLI behavior/);
});

// #22 UTF-8 BOM
await test("#22 JSON policy files with a UTF-8 BOM parse", async () => {
  assert.deepEqual(need("parseJsonText")("\uFEFF{\"a\":1}"), { a: 1 });
  const repo = path.join(scratch, "bom-policy");
  await mkdir(path.join(repo, ".mcp"), { recursive: true });
  await writeFile(path.join(repo, ".mcp", "agent-policy.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ version: 1, sharedFiles: ["shared.json"] }))]));
  const policy = await internals.loadProjectAgentPolicy(repo);
  assert.equal(policy.ok, true, `${policy.errorType}: ${policy.error}`);
});

// #23 dir/* is one level
await test("#23 dir/* stays a one-level glob", async () => {
  assert.equal(internals.normalizeLockPath("src/cli/*"), "src/cli/*");
  assert.equal(internals.normalizeLockPath("src/cli/**"), "src/cli");
  const isWithinAnyPath = need("isWithinAnyPath");
  assert.ok(isWithinAnyPath("src/cli/x.ts", ["src/cli/*"], workCwd));
  assert.ok(!isWithinAnyPath("src/cli/deep/x.ts", ["src/cli/*"], workCwd));
});

// #24 caller spellings for absolute paths
await test("#24 absolute caller spellings map onto repo-relative lock-plan values", async () => {
  const job = { cwd: workCwd, allowedEdits: [path.join(workCwd, "src", "Parser.py")] };
  const spellings = internals.callerPathSpellings(job);
  const spell = need("pathSpeller")(spellings);
  const folded = internals.filesystemCaseModeForRoot(workCwd) === "sensitive" ? "src/Parser.py" : "src/parser.py";
  assert.deepEqual(spell([folded]), ["src/Parser.py"]);
});

// #25 prompt length
await test("#25 an over-long prompt fails with prompt_too_long before any slot or spawn", async () => {
  const lengthError = need("openCodeCommandLineLengthError");
  assert.match(lengthError("opencode", ["run", "x".repeat(40_000)], "win32"), /32767/);
  assert.equal(lengthError("opencode", ["run", "x".repeat(20_000)], "win32"), "");
  assert.match(lengthError("opencode", ["run", "x".repeat(200_000)], "linux"), /131071/);
  const huge = process.platform === "win32" ? "y".repeat(40_000) : "y".repeat(200_000);
  const result = await need("runOpenCode")(fixtureAgentName, huge, workCwd, false, 20_000, { agentMetadata: fixtureMetadata() });
  assert.equal(result.errorType, "prompt_too_long");
});
await test("#25 a supervisor spawn failure surfaces as spawn_failed", async () => {
  const result = await need("runSpawnCommand")(path.join(scratch, "does-not-exist.exe"), [], workCwd, 20_000);
  assert.equal(result.terminationErrorType, "spawn_failed", JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr }));
});

// #26 repository opencode.json
await test("#26 a repository's own opencode.json is not a plugin-policy candidate while project config is disabled", async () => {
  const candidates = need("pluginConfigCandidatePaths");
  const project = path.join(scratch, "project-with-config");
  const listed = candidates([project], []);
  assert.ok(!listed.some((item) => item.startsWith(path.resolve(project))), JSON.stringify(listed));
  const enforced = candidates([project], [], { projectConfigDisabled: false });
  assert.ok(enforced.includes(path.resolve(project, "opencode.json")));
});

// #27 override variant
await test("#27 an override without a variant does not inherit the managed profile's variant", async () => {
  const applied = internals.applyModelOverrideToMetadata({ provider: "opencode", model: "muse", variant: "high" }, { provider: "google", model: "gemini", variant: "" });
  assert.equal(applied.variant, "");
  assert.equal(applied.profileVariant, "high");
});

// #28 timeout ceiling
await test("#28 agent timeouts are bounded below the supervisor timer limit", async () => {
  const max = need("MAX_AGENT_TIMEOUT_MS");
  assert.ok(max < 2 ** 31);
  const schema = internals.z.object(need("jobInputShape"));
  assert.equal(schema.safeParse({ agent: "planner", task: "t", cwd: workCwd, timeoutMs: 3_000_000_000 }).success, false);
  assert.equal(internals.timeoutForAgent("planner", { lockType: "read" }, 3_000_000_000), max);
  assert.equal(internals.timeoutForAgent("planner", { lockType: "read" }, 60_000), 60_000);
});

// ---------------------------------------------------------------------------
hooks.stateDirectoryOverride = "";
await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
const skipped = results.filter((item) => item.skipped);
const failed = results.filter((item) => !item.ok && !item.skipped);
process.stdout.write(`\n${results.length - failed.length - skipped.length}/${results.length} review-spawn tests passed${skipped.length ? `, ${skipped.length} skipped` : ""}.\n`);
if (skipped.length) {
  process.stdout.write(`Skipped (not passed):\n${skipped.map((item) => `- ${item.name}: ${item.skipped}`).join("\n")}\n`);
}
if (failed.length) {
  process.stdout.write(`Failed:\n${failed.map((item) => `- ${item.name}`).join("\n")}\n`);
}
process.exit(failed.length ? 1 : 0);
