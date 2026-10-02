#!/usr/bin/env node

// Review 2, area I (R-173): importing server.js must not write into the bridge state
// directory. The line-ending gitconfig the bridge hands to its own Git used to be written
// at import, so every test that imported the module and only afterwards set
// hooks.stateDirectoryOverride wrote a file into the real ~/.codex/codex-opencode-mcp.
//   node tests/review2-i.js
//
// Each scenario runs in a child process whose home directory (HOME/USERPROFILE) is a temp
// directory and which has no CODEX_HOME / CODEX_OPENCODE_STATE_DIR / XDG_* override: that is
// the only way to observe the *default* state directory without touching the real one. The
// child refuses to import server.js unless os.homedir() is the temp home, so a failing run
// can never write into the operator's real ~/.codex.
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SERVER = path.join(path.dirname(SELF), "..", "server.js");
const RESULT_PREFIX = "REVIEW2I_RESULT ";
const NULL_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";

async function listFiles(directory) {
  try {
    return (await readdir(directory, { recursive: true })).map((entry) => String(entry).replace(/\\/g, "/")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

if (process.argv.includes("--child")) {
  // Child: import the module, do what the scenario says, print one JSON result line.
  const scenario = process.argv[process.argv.indexOf("--child") + 1];
  const expectedHome = process.env.REVIEW2I_HOME;
  const emit = (value) => process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`);
  if (!expectedHome || !samePath(homedir(), expectedHome)) {
    emit({ unsafe: `os.homedir() is ${homedir()}, expected ${expectedHome}` });
    process.exit(3);
  }
  const defaultStateDir = path.join(expectedHome, ".codex", "codex-opencode-mcp");
  if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
  const { __selfTest } = await import(pathToFileURL(SERVER).href);
  const { buildTrustedGitEnv } = __selfTest.internals;
  const result = { scenario, defaultStateDir, afterImport: await listFiles(defaultStateDir) };
  if (scenario === "first-use") {
    const first = path.join(expectedHome, "override-a");
    const second = path.join(expectedHome, "override-b");
    __selfTest.hooks.stateDirectoryOverride = first;
    result.overrideBeforeUse = await listFiles(first);
    const envFirst = buildTrustedGitEnv();
    result.firstConfig = envFirst.GIT_CONFIG_GLOBAL;
    result.firstContent = await readFile(envFirst.GIT_CONFIG_GLOBAL, "utf8");
    result.firstStat = (await stat(envFirst.GIT_CONFIG_GLOBAL)).mtimeMs;
    result.firstAgain = buildTrustedGitEnv().GIT_CONFIG_GLOBAL;
    // A wiped state directory gets the file again instead of a path Git would read as empty.
    await rm(first, { recursive: true, force: true });
    const recreated = buildTrustedGitEnv().GIT_CONFIG_GLOBAL;
    result.recreated = recreated === result.firstConfig && await readFile(recreated, "utf8") === result.firstContent;
    __selfTest.hooks.stateDirectoryOverride = second;
    result.secondConfig = buildTrustedGitEnv().GIT_CONFIG_GLOBAL;
    result.firstDir = first;
    result.secondDir = second;
    result.firstFiles = await listFiles(first);
    result.secondFiles = await listFiles(second);
  } else if (scenario === "default-use") {
    const env = buildTrustedGitEnv();
    // B-073: without an override a self-test's state directory is its own temporary folder.
    result.bridgeStateDir = __selfTest.internals.effectiveBridgeStateDirectory();
    result.config = env.GIT_CONFIG_GLOBAL;
    result.content = await readFile(env.GIT_CONFIG_GLOBAL, "utf8");
  } else if (scenario === "no-user-config") {
    const override = path.join(expectedHome, "override-none");
    __selfTest.hooks.stateDirectoryOverride = override;
    result.config = buildTrustedGitEnv().GIT_CONFIG_GLOBAL;
    result.overrideFiles = await listFiles(override);
  }
  result.afterUse = await listFiles(defaultStateDir);
  emit(result);
  process.exit(0);
}

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "review2-i-"));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function runChild(scenario, { userConfig = "[core]\n\tautocrlf = true\n" } = {}) {
  const home = await mkdtemp(path.join(fixtureRoot, "home-"));
  const userGlobalConfig = path.join(fixtureRoot, `user-global-${path.basename(home)}.gitconfig`);
  await writeFile(userGlobalConfig, userConfig);
  const emptySystemConfig = path.join(fixtureRoot, "empty-system.gitconfig");
  await writeFile(emptySystemConfig, "");
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|CODEX_HOME|CODEX_OPENCODE_[A-Z0-9_]*|XDG_[A-Z0-9_]*|GIT_CONFIG_[A-Z0-9_]*)$/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    REVIEW2I_HOME: home,
    // The operator's Git is simulated: an empty system config and a global one from the
    // fixture (GIT_CONFIG_NOSYSTEM alone is not enough: `git config --system` still reads
    // the machine-wide file, e.g. Git for Windows' core.autocrlf=true).
    GIT_CONFIG_GLOBAL: userGlobalConfig,
    GIT_CONFIG_SYSTEM: emptySystemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    CODEX_OPENCODE_LOG_LEVEL: "off",
  });
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, "--child", scenario], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const line = output.stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
  assert.ok(line, `child ${scenario} printed no result (exit ${output.code}): ${output.stdout}\n${output.stderr}`);
  const result = JSON.parse(line.slice(RESULT_PREFIX.length));
  assert.equal(result.unsafe, undefined, `refused to import server.js: ${result.unsafe}`);
  assert.equal(output.code, 0, `child ${scenario} exited ${output.code}: ${output.stderr}`);
  return { ...result, home };
}

test("R-173: a plain import writes nothing into the default state directory", async () => {
  const result = await runChild("import-only");
  assert.ok(samePath(result.defaultStateDir, path.join(result.home, ".codex", "codex-opencode-mcp")));
  assert.deepEqual(result.afterImport ?? [], [], `import wrote ${JSON.stringify(result.afterImport)} into ${result.defaultStateDir}`);
  assert.deepEqual(result.afterUse ?? [], []);
});

test("R-173: the gitconfig is created on first use under stateDirectoryOverride, not the default directory", async () => {
  const result = await runChild("first-use");
  assert.deepEqual(result.afterImport ?? [], [], `import wrote ${JSON.stringify(result.afterImport)} into the default state directory`);
  assert.deepEqual(result.overrideBeforeUse ?? [], [], "setting the override alone creates nothing");
  assert.ok(samePath(path.dirname(result.firstConfig), result.firstDir), `${result.firstConfig} is not in ${result.firstDir}`);
  assert.match(path.basename(result.firstConfig), /^git-line-endings-[0-9a-f]{16}\.gitconfig$/);
  assert.equal(result.firstContent, "[core]\n\tautocrlf = true\n");
  assert.equal(result.firstAgain, result.firstConfig, "the second call resolves to the same file");
  assert.equal(result.recreated, true, "a wiped state directory gets the gitconfig again");
  assert.deepEqual(result.firstFiles, [path.basename(result.firstConfig)], "only the gitconfig is left behind (no temporary file)");
  assert.ok(samePath(path.dirname(result.secondConfig), result.secondDir), "a different override resolves its own directory");
  assert.deepEqual(result.secondFiles, [path.basename(result.secondConfig)]);
  assert.deepEqual(result.afterUse ?? [], [], "the default state directory is still untouched after use");
});

test("R-173: with no override the first use creates the file in the bridge state directory (B-073: a self-test's temporary one)", async () => {
  const result = await runChild("default-use");
  assert.deepEqual(result.afterImport ?? [], []);
  assert.ok(samePath(path.dirname(result.config), result.bridgeStateDir), `${result.config} is not in ${result.bridgeStateDir}`);
  assert.ok(!samePath(result.bridgeStateDir, result.defaultStateDir), "a self-test never uses <home>/.codex/codex-opencode-mcp");
  assert.equal(result.content, "[core]\n\tautocrlf = true\n");
  assert.deepEqual(result.afterUse ?? [], [], "the operator's default state directory stays untouched");
});

test("R-173: without an operator line-ending config bridge Git gets the null config and nothing is written", async () => {
  const result = await runChild("no-user-config", { userConfig: "[user]\n\tname = nobody\n" });
  assert.deepEqual(result.afterImport ?? [], []);
  assert.equal(result.config, NULL_CONFIG);
  assert.deepEqual(result.overrideFiles ?? [], []);
  assert.deepEqual(result.afterUse ?? [], []);
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
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} review2-i tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} review2-i tests passed.\n`);
process.exit(0);
