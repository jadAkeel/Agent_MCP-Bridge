#!/usr/bin/env node

// Release gate (G-04): runs every check a release must pass and writes a receipt that ties
// the result to the exact source tree. `npm run test:release` is this script;
// `release:activate` runs it by default and accepts `--skip-tests` only together with
// `--gate-receipt <file>` naming a green receipt of the same tree that is at most 24 h old.
//
//   npm run test:release                        every step; receipt in .release-gate/receipt.json
//   node bin/release-gate.js --receipt <file>   write the receipt elsewhere
//   node bin/release-gate.js --config <toml>    MCP config whose profile the health smoke starts
//                                               (default ~/.codex/config.toml)
//   node bin/release-gate.js --self-test
//
// Steps, in order, stopping at the first failure: `npm test`, `npm run test:concurrency`,
// `npm audit --omit=dev`, and `bin/live-smoke.js --health-only` starting this tree's
// server.js with the shipped profile (the config's environment, its hash pins dropped).
// Every "skip <name>: <reason>" line a suite prints, and node --test's skipped count, is
// recorded in the receipt, so a skipped check is visible instead of passing silently.
//
// The source-tree digest covers the files a release copies (build-release.js publish entries
// without node_modules) and is taken before and after the steps: a tree that changed while
// the gate ran gets a failing receipt. A failing run still writes its receipt (ok: false),
// which activation refuses. The receipt is not signed: it guards against activating a tree
// nobody tested, within the same-user trust boundary, not against a forged file.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_PUBLISH_ENTRIES } from "./build-release.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { resolvePluginManifestEntryPath } from "./plugin-manifest-paths.js";
import { digestTree } from "./plugin-tree-digest.js";
import { recordCliFailure } from "./ops-log.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSelfTestRun(import.meta.url);
const RECEIPT_KIND = "codex-opencode-mcp-release-gate";
const RECEIPT_VERSION = 1;
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_RECEIPT_PATH = path.join(SOURCE_ROOT, ".release-gate", "receipt.json");
const SOURCE_TREE_ENTRIES = Object.freeze(LEGACY_PUBLISH_ENTRIES.filter((entry) => entry !== "node_modules"));
const REQUIRED_STEPS = Object.freeze(["installed dependencies", "npm test", "test:concurrency", "npm audit", "live health smoke"]);
const FAILED_OUTPUT_TAIL_LINES = 30;

function defaultConfigPath() {
  return path.join(homedir(), ".codex", "config.toml");
}

// The tests run against node_modules, so what is installed must be what package-lock.json
// pins: for every production package, the hidden lockfile npm wrote at install time
// (node_modules/.package-lock.json) and the package's own package.json must carry the
// locked version, and the hidden lockfile the locked integrity. An optional package that is
// not installed (another platform's binary) is fine; anything else missing, extra or
// different fails. Returns the list of problems (empty when it matches).
async function installedDependencyMismatches(sourceRoot = SOURCE_ROOT) {
  const readJson = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  const locked = (await readJson(path.join(sourceRoot, "package-lock.json"))).packages || {};
  let hidden;
  try {
    hidden = (await readJson(path.join(sourceRoot, "node_modules", ".package-lock.json"))).packages || {};
  } catch (error) {
    return [`node_modules/.package-lock.json cannot be read (${error?.code || error?.message || error}); run npm ci.`];
  }
  const problems = [];
  const production = Object.entries(locked).filter(([key, entry]) => key.startsWith("node_modules/") && !entry.dev);
  for (const [key, entry] of production) {
    const installed = hidden[key];
    if (!installed) {
      if (!entry.optional) problems.push(`${key}: locked ${entry.version}, not installed`);
      continue;
    }
    if (installed.version !== entry.version) problems.push(`${key}: locked ${entry.version}, installed ${installed.version}`);
    if (entry.integrity && installed.integrity !== entry.integrity) problems.push(`${key}: integrity differs from package-lock.json`);
    try {
      const manifest = await readJson(path.join(sourceRoot, ...key.split("/"), "package.json"));
      if (manifest.version !== entry.version) problems.push(`${key}: its package.json says ${manifest.version}, locked ${entry.version}`);
    } catch (error) {
      problems.push(`${key}: package.json cannot be read (${error?.code || error?.message || error})`);
    }
  }
  for (const key of Object.keys(hidden)) {
    if (key.startsWith("node_modules/") && !Object.hasOwn(locked, key)) problems.push(`${key}: installed but not in package-lock.json`);
  }
  return problems;
}

function gateSteps({ sourceRoot = SOURCE_ROOT, configPath = defaultConfigPath() } = {}) {
  // npm is a .cmd shim on Windows, which Node only starts through a shell.
  return [
    {
      name: "installed dependencies",
      command: "(compare node_modules with package-lock.json)",
      run: async () => {
        const problems = await installedDependencyMismatches(sourceRoot);
        return problems.length
          ? { exitCode: 1, output: [`node_modules does not match package-lock.json (${problems.length}); run npm ci:`, ...problems.map((line) => `  ${line}`)].join("\n") }
          : { exitCode: 0, output: "node_modules matches package-lock.json for every production package." };
      },
    },
    { name: "npm test", command: "npm test", shell: true },
    { name: "test:concurrency", command: "npm run test:concurrency", shell: true, requireCheckSummary: true },
    { name: "npm audit", command: "npm audit --omit=dev", shell: true },
    {
      name: "live health smoke",
      command: process.execPath,
      args: [path.join(sourceRoot, "bin", "live-smoke.js"), "--health-only", "--server", path.join(sourceRoot, "server.js"), "--config", configPath],
      shell: false,
    },
  ];
}

async function sourceTreeDigest(sourceRoot = SOURCE_ROOT) {
  const digest = await digestTree(sourceRoot, { include: SOURCE_TREE_ENTRIES, label: "Release source" });
  return { treeSha256: digest.treeSha256, fileCount: digest.fileCount, entries: [...SOURCE_TREE_ENTRIES] };
}

// What a release build needs from the source tree, checked before the gate spends its
// half hour: every publish entry (node_modules is installed fresh, so not that one) exists as a
// real file or directory, and the plugin integrity manifest binds its config and settings
// to this tree's opencode/opencode.jsonc and opencode/antigravity.json (build-release.js
// refuses anything else, but only after the gate). Throws with every problem found.
async function assertReleaseSourceComplete(sourceRoot = SOURCE_ROOT) {
  const problems = [];
  for (const entry of SOURCE_TREE_ENTRIES) {
    try {
      const details = await lstat(path.join(sourceRoot, ...entry.split("/")));
      if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) problems.push(`${entry} is not a real file or directory`);
    } catch (error) {
      problems.push(`${entry} is missing (${error?.code || error?.message || error})`);
    }
  }
  const manifestPath = path.join(sourceRoot, "opencode", "plugin-integrity-manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    if (error?.code !== "ENOENT") problems.push(`opencode/plugin-integrity-manifest.json cannot be read (${error?.message || error})`);
  }
  if (manifest) {
    const fold = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
    for (const [list, basename] of [["configs", "opencode.jsonc"], ["settings", "antigravity.json"]]) {
      const entries = Array.isArray(manifest[list]) ? manifest[list] : [];
      const expected = path.join(sourceRoot, "opencode", basename);
      if (entries.length !== 1) {
        problems.push(`plugin-integrity-manifest.json ${list} must hold exactly one entry (it holds ${entries.length})`);
      } else if (fold(resolvePluginManifestEntryPath(entries[0]?.path, manifestPath) || ".") !== fold(expected)) {
        problems.push(`plugin-integrity-manifest.json ${list}[0].path is ${entries[0]?.path || "(empty)"}, not this tree's ${expected}`);
      }
    }
  }
  if (problems.length) {
    throw new Error([`The source tree ${sourceRoot} cannot become a release; nothing was tested or built:`, ...problems.map((line) => `  ${line}`)].join("\n"));
  }
}

function gitHead(sourceRoot) {
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function outputTail(output, lines = FAILED_OUTPUT_TAIL_LINES) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/ExperimentalWarning|--trace-warnings/.test(line))
    .slice(-lines)
    .map((line) => (line.length > 400 ? `${line.slice(0, 400)}...` : line));
}

// What a step's output says about skipped and counted checks.
function parseStepOutput(output) {
  const skips = [];
  const lines = String(output || "").split(/\r?\n/);
  for (const line of lines) {
    const skip = /^skip\s+(.+?):\s+(.+)$/.exec(line.trim());
    if (skip) skips.push({ name: skip[1], reason: skip[2] });
    const partial = /^ok\s+(.+?)\s+\(\d+ ms\)\s+\[partly skipped:\s*(.+)\]$/.exec(line.trim());
    if (partial) skips.push({ name: partial[1], reason: `partly skipped: ${partial[2]}` });
  }
  let nodeTestSkipped = 0;
  for (const match of String(output || "").matchAll(/^ℹ skipped (\d+)\s*$/gm)) nodeTestSkipped += Number(match[1]);
  if (nodeTestSkipped) skips.push({ name: "node --test", reason: `${nodeTestSkipped} test(s) reported skipped; see the step output` });
  const summary = /^Checks: (\d+) passed, skipped: (\d+)\s*$/m.exec(String(output || ""));
  const checks = summary ? { passed: Number(summary[1]), skipped: Number(summary[2]) } : null;
  return { skips, checks };
}

// Runs one step with its output streamed through to this process and kept for parsing. A step
// with a run() function is checked in this process instead of a child.
async function runStepProcess(step, { cwd }) {
  if (step.run) {
    let result;
    try {
      result = await step.run();
    } catch (error) {
      result = { exitCode: 1, output: String(error?.stack || error) };
    }
    process.stdout.write(`${result.output}\n`);
    return result;
  }
  return await new Promise((resolve) => {
    const child = spawn(step.command, step.args || [], { cwd, shell: step.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk, stream) => {
      stream.write(chunk);
      output += String(chunk);
    };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));
    child.on("error", (error) => resolve({ exitCode: null, output: `${output}\n${error?.message || error}` }));
    child.on("close", (code) => resolve({ exitCode: code, output }));
  });
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function runReleaseGate({
  sourceRoot = SOURCE_ROOT,
  configPath = defaultConfigPath(),
  receiptPath = DEFAULT_RECEIPT_PATH,
  steps = gateSteps({ sourceRoot, configPath }),
  runStep = runStepProcess,
  log = (line) => process.stdout.write(`${line}\n`),
  now = () => Date.now(),
} = {}) {
  const started = now();
  const treeBefore = await sourceTreeDigest(sourceRoot);
  const receipt = {
    kind: RECEIPT_KIND,
    version: RECEIPT_VERSION,
    ok: false,
    failure: "",
    sourceRoot,
    gitHead: gitHead(sourceRoot),
    sourceTree: treeBefore,
    node: process.version,
    platform: process.platform,
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    durationMs: 0,
    steps: [],
    skips: [],
  };
  for (const step of steps) {
    log(`\n==> release gate: ${step.name}`);
    const stepStarted = now();
    const { exitCode, output } = await runStep(step, { cwd: sourceRoot });
    const parsed = parseStepOutput(output);
    const record = {
      name: step.name,
      command: [step.command, ...(step.args || [])].join(" "),
      exitCode,
      durationMs: now() - stepStarted,
      skips: parsed.skips,
      ...(parsed.checks ? { checks: parsed.checks } : {}),
    };
    receipt.steps.push(record);
    receipt.skips.push(...parsed.skips.map((skip) => ({ step: step.name, ...skip })));
    if (exitCode !== 0) receipt.failure = `${step.name} failed (exit ${exitCode}).`;
    else if (step.requireCheckSummary && !parsed.checks) receipt.failure = `${step.name} printed no "Checks: <n> passed, skipped: <n>" line.`;
    if (receipt.failure) {
      // The end of a failed step's output, so the receipt alone says what broke.
      record.outputTail = outputTail(output);
      break;
    }
  }
  if (!receipt.failure) {
    const treeAfter = await sourceTreeDigest(sourceRoot);
    if (treeAfter.treeSha256 !== treeBefore.treeSha256) {
      receipt.failure = `The source tree changed while the gate ran (${treeBefore.treeSha256.slice(0, 12)} -> ${treeAfter.treeSha256.slice(0, 12)}); run it again on a quiet tree.`;
    }
  }
  receipt.ok = !receipt.failure;
  receipt.finishedAt = new Date(now()).toISOString();
  receipt.durationMs = Date.parse(receipt.finishedAt) - started;
  await writeJsonAtomically(receiptPath, receipt);
  log("");
  for (const step of receipt.steps) {
    log(`gate step ${step.exitCode === 0 ? "ok  " : "FAIL"} ${step.name} (${step.durationMs} ms)${step.checks ? `; checks ${step.checks.passed}, skipped: ${step.checks.skipped}` : ""}`);
  }
  log(`skipped: ${receipt.skips.length}${receipt.skips.length ? ` (${receipt.skips.map((skip) => `${skip.step}: ${skip.name}: ${skip.reason}`).join("; ")})` : ""}`);
  log(`Release gate ${receipt.ok ? "passed" : `FAILED: ${receipt.failure}`}`);
  log(`Source tree ${receipt.sourceTree.treeSha256} (${receipt.sourceTree.fileCount} files); receipt ${receiptPath}`);
  return { receipt, receiptPath };
}

async function readGateReceipt(receiptPath) {
  let text;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the gate receipt ${receiptPath} (${error?.code || error?.message || error}).`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`The gate receipt ${receiptPath} is not JSON (${error?.message || error}).`);
  }
}

// Throws unless the receipt is a green gate run of exactly this tree, finished within 24 h.
function validateGateReceipt(receipt, { treeSha256, now = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS } = {}) {
  if (!receipt || receipt.kind !== RECEIPT_KIND || receipt.version !== RECEIPT_VERSION) {
    throw new Error("The gate receipt is not a release-gate receipt of this version; run `npm run test:release` again.");
  }
  if (receipt.ok !== true) {
    throw new Error(`The gate receipt records a failed run: ${receipt.failure || "no reason recorded"}`);
  }
  const steps = Array.isArray(receipt.steps) ? receipt.steps : [];
  for (const name of REQUIRED_STEPS) {
    const step = steps.find((item) => item?.name === name);
    if (!step) throw new Error(`The gate receipt has no "${name}" step.`);
    if (step.exitCode !== 0) throw new Error(`The gate receipt records "${name}" with exit ${step.exitCode}.`);
  }
  const recorded = String(receipt.sourceTree?.treeSha256 || "");
  if (!treeSha256 || recorded !== treeSha256) {
    throw new Error(`The gate receipt is for another source tree (receipt ${recorded.slice(0, 12) || "(none)"}, candidate ${String(treeSha256 || "").slice(0, 12) || "(none)"}); run \`npm run test:release\` on this tree.`);
  }
  const finished = Date.parse(String(receipt.finishedAt || ""));
  if (!Number.isFinite(finished)) throw new Error("The gate receipt has no valid finishedAt time.");
  if (finished > now + RECEIPT_CLOCK_SKEW_MS) throw new Error(`The gate receipt finished in the future (${receipt.finishedAt}).`);
  if (now - finished > maxAgeMs) {
    throw new Error(`The gate receipt is ${Math.round((now - finished) / 3_600_000)} h old (limit ${Math.round(maxAgeMs / 3_600_000)} h); run \`npm run test:release\` again.`);
  }
  return receipt;
}

function parseArguments(argv) {
  const options = { receiptPath: DEFAULT_RECEIPT_PATH, configPath: defaultConfigPath(), selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--receipt" || argument === "--config") {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options[argument === "--receipt" ? "receiptPath" : "configPath"] = path.resolve(value);
      index += 1;
    } else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/release-gate.js [--receipt <file>] [--config <config.toml>] [--self-test]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

// One file or directory per publish entry (build-release.js LEGACY_PUBLISH_ENTRIES without
// node_modules). lib/ is one since the server.js split; a fixture without it failed the
// digest with ENOENT before any assertion ran.
async function writeSourceFixture(root) {
  for (const directory of ["bin", "lib", "tests", "opencode/agents", "opencode/skills"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const [file, text] of Object.entries({
    "server.js": "// server\n",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "bin/tool.js": "// tool\n",
    "lib/module.js": "// module\n",
    "tests/case.js": "// case\n",
    "opencode/agents/builder.md": "builder\n",
    "opencode/.gitignore": "log/\n",
    "opencode/plugin-integrity-manifest.json": "{}\n",
  })) await writeFile(path.join(root, ...file.split("/")), text, "utf8");
}

async function selfTest() {
  const fixture = await mkdtemp(path.join(tmpdir(), "release-gate-self-test-"));
  const quiet = () => {};
  try {
    const source = path.join(fixture, "source");
    await writeSourceFixture(source);
    const steps = gateSteps({ sourceRoot: source, configPath: path.join(fixture, "config.toml") });
    assert.deepEqual(steps.map((step) => step.name), REQUIRED_STEPS);
    const outputs = {
      "installed dependencies": "node_modules matches package-lock.json for every production package.",
      "npm test": "ok   a (1 ms)\nskip b: symlinks need Developer Mode\nok   c (2 ms) [partly skipped: symlink part]\nℹ skipped 0\n",
      "test:concurrency": "check ok   locks (10 ms)\nChecks: 14 passed, skipped: 0\n",
      "npm audit": "found 0 vulnerabilities\n",
      "live health smoke": "Live smoke: passed\n",
    };
    const green = async (step) => ({ exitCode: 0, output: outputs[step.name] });

    // A green run: every step recorded, the skips named, the receipt valid for this tree only.
    const receiptPath = path.join(fixture, "receipt.json");
    const { receipt } = await runReleaseGate({ sourceRoot: source, receiptPath, steps, runStep: green, log: quiet });
    assert.equal(receipt.ok, true, receipt.failure);
    assert.deepEqual(receipt.steps.map((step) => step.exitCode), [0, 0, 0, 0, 0]);
    assert.ok(receipt.steps.every((step) => !Object.hasOwn(step, "outputTail")), "a passing step keeps no output");
    assert.deepEqual(receipt.steps[2].checks, { passed: 14, skipped: 0 });
    assert.deepEqual(receipt.skips.map((skip) => `${skip.step}/${skip.name}`), ["npm test/b", "npm test/c"]);
    const stored = await readGateReceipt(receiptPath);
    const { treeSha256 } = await sourceTreeDigest(source);
    assert.equal(stored.sourceTree.treeSha256, treeSha256);
    validateGateReceipt(stored, { treeSha256 });

    // Another tree, an old receipt, a future receipt, a failed or incomplete run: all refused.
    await writeFile(path.join(source, "bin", "tool.js"), "// changed\n", "utf8");
    const changedTree = (await sourceTreeDigest(source)).treeSha256;
    assert.notEqual(changedTree, treeSha256);
    assert.throws(() => validateGateReceipt(stored, { treeSha256: changedTree }), /another source tree/);
    const finished = Date.parse(stored.finishedAt);
    assert.throws(() => validateGateReceipt(stored, { treeSha256, now: finished + RECEIPT_MAX_AGE_MS + 1000 }), /h old/);
    assert.throws(() => validateGateReceipt(stored, { treeSha256, now: finished - RECEIPT_CLOCK_SKEW_MS - 1000 }), /in the future/);
    assert.throws(() => validateGateReceipt({ ...stored, ok: false, failure: "npm test failed (exit 1)." }, { treeSha256 }), /failed run: npm test failed/);
    assert.throws(() => validateGateReceipt({ ...stored, steps: stored.steps.slice(0, 4) }, { treeSha256 }), /no "live health smoke" step/);
    assert.throws(() => validateGateReceipt({ ...stored, kind: "other" }, { treeSha256 }), /not a release-gate receipt/);
    await writeFile(path.join(fixture, "broken.json"), "{", "utf8");
    await assert.rejects(readGateReceipt(path.join(fixture, "broken.json")), /not JSON/);
    await assert.rejects(readGateReceipt(path.join(fixture, "missing.json")), /Cannot read the gate receipt/);

    // A failing step stops the gate, and its receipt says so.
    const ran = [];
    const failing = await runReleaseGate({
      sourceRoot: source,
      receiptPath,
      steps,
      runStep: async (step) => { ran.push(step.name); return { exitCode: step.name === "test:concurrency" ? 1 : 0, output: outputs[step.name] }; },
      log: quiet,
    });
    assert.deepEqual(ran, ["installed dependencies", "npm test", "test:concurrency"]);
    assert.equal(failing.receipt.ok, false);
    assert.match(failing.receipt.failure, /test:concurrency failed \(exit 1\)/);
    assert.deepEqual(failing.receipt.steps[2].outputTail, ["check ok   locks (10 ms)", "Checks: 14 passed, skipped: 0"], "a failed step keeps the end of its output");
    const longOutput = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    const tail = (await runReleaseGate({
      sourceRoot: source,
      receiptPath,
      steps,
      runStep: async (step) => ({ exitCode: step.name === "npm test" ? 2 : 0, output: step.name === "npm test" ? longOutput : outputs[step.name] }),
      log: quiet,
    })).receipt.steps[1].outputTail;
    assert.equal(tail.length, FAILED_OUTPUT_TAIL_LINES);
    assert.deepEqual([tail[0], tail.at(-1)], ["line 21", "line 50"]);
    assert.equal((await readGateReceipt(receiptPath)).ok, false);

    // A concurrency run that prints no check summary does not pass.
    const noSummary = await runReleaseGate({
      sourceRoot: source,
      receiptPath,
      steps,
      runStep: async (step) => ({ exitCode: 0, output: step.name === "test:concurrency" ? "passed\n" : outputs[step.name] }),
      log: quiet,
    });
    assert.match(noSummary.receipt.failure, /no "Checks: <n> passed, skipped: <n>" line/);

    // A tree that changes while the gate runs gets a failing receipt.
    const drifting = await runReleaseGate({
      sourceRoot: source,
      receiptPath,
      steps,
      runStep: async (step) => {
        if (step.name === "npm audit") await writeFile(path.join(source, "tests", "case.js"), "// written by a test\n", "utf8");
        return { exitCode: 0, output: outputs[step.name] };
      },
      log: quiet,
    });
    assert.match(drifting.receipt.failure, /source tree changed while the gate ran/);

    // Every publish entry must exist, opencode/.gitignore included: it is tracked since B-037
    // (it used to ignore itself, so a fresh worktree lacked it and the digest allowed that).
    await rm(path.join(source, "opencode", ".gitignore"));
    await assert.rejects(sourceTreeDigest(source), /ENOENT/, "a missing opencode/.gitignore is not digested as absent");
    await writeFile(path.join(source, "opencode", ".gitignore"), "log/\n", "utf8");
    await rename(path.join(source, "tests"), path.join(fixture, "tests-away"));
    await assert.rejects(sourceTreeDigest(source), /ENOENT/, "a missing tests/ is not digested as absent");
    await rename(path.join(fixture, "tests-away"), path.join(source, "tests"));
    // lib/ holds most of the bridge since the split, so a tree without it is not a source tree.
    await rename(path.join(source, "lib"), path.join(fixture, "lib-away"));
    await assert.rejects(sourceTreeDigest(source), /ENOENT/, "a missing lib/ is not digested as absent");
    await rename(path.join(fixture, "lib-away"), path.join(source, "lib"));

    // Before the gate: every publish entry must exist and the plugin manifest must bind this
    // tree's opencode.jsonc and antigravity.json; every problem is named at once.
    const bind = (root) => JSON.stringify({ version: 1, configs: [{ path: path.join(root, "opencode", "opencode.jsonc") }], settings: [{ path: path.join(root, "opencode", "antigravity.json") }] });
    await writeFile(path.join(source, "opencode", ".gitignore"), "log/\n", "utf8");
    await writeFile(path.join(source, "opencode", "plugin-integrity-manifest.json"), bind(source), "utf8");
    await assertReleaseSourceComplete(source);
    // B-037: the committed form is repository-relative and binds whichever tree holds it.
    const bindRelative = (configPath = "opencode/opencode.jsonc") => JSON.stringify({ version: 1, configs: [{ path: configPath }], settings: [{ path: "opencode/antigravity.json" }] });
    await writeFile(path.join(source, "opencode", "plugin-integrity-manifest.json"), bindRelative(), "utf8");
    await assertReleaseSourceComplete(source);
    await writeFile(path.join(source, "opencode", "plugin-integrity-manifest.json"), bindRelative("../opencode/opencode.jsonc"), "utf8");
    await assert.rejects(assertReleaseSourceComplete(source), /configs\[0\]\.path is \.\.\/opencode\/opencode\.jsonc, not this tree's/);
    await writeFile(path.join(source, "opencode", "plugin-integrity-manifest.json"), bind(path.join(fixture, "live-tree")), "utf8");
    await rm(path.join(source, "opencode", ".gitignore"));
    await rm(path.join(source, "opencode", "skills"), { recursive: true });
    await assert.rejects(assertReleaseSourceComplete(source), (error) => {
      assert.match(error.message, /cannot become a release; nothing was tested or built/);
      assert.match(error.message, /opencode\/skills is missing/);
      assert.match(error.message, /opencode\/\.gitignore is missing/, "the release build needs it, so it is required here");
      assert.match(error.message, /configs\[0\]\.path is .*live-tree.*not this tree's/);
      assert.match(error.message, /settings\[0\]\.path is .*live-tree.*not this tree's/);
      return true;
    });
    await mkdir(path.join(source, "opencode", "skills"));
    await writeFile(path.join(source, "opencode", ".gitignore"), "log/\n", "utf8");

    // Installed dependencies must be what package-lock.json pins.
    const deps = path.join(fixture, "deps");
    const writeJson = async (file, value) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value), "utf8");
    };
    const lockPackages = {
      "": { name: "fixture" },
      "node_modules/prod": { version: "1.0.0", integrity: "sha512-prod" },
      "node_modules/tool": { version: "2.0.0", integrity: "sha512-tool", dev: true },
      "node_modules/native-other-os": { version: "3.0.0", integrity: "sha512-native", optional: true },
    };
    await writeJson(path.join(deps, "package-lock.json"), { lockfileVersion: 3, packages: lockPackages });
    await writeJson(path.join(deps, "node_modules", "prod", "package.json"), { version: "1.0.0" });
    const writeHidden = (packages) => writeJson(path.join(deps, "node_modules", ".package-lock.json"), { lockfileVersion: 3, packages });
    await writeHidden({ "node_modules/prod": { version: "1.0.0", integrity: "sha512-prod" } });
    assert.deepEqual(await installedDependencyMismatches(deps), [], "dev and absent optional packages are not required");
    await writeHidden({ "node_modules/prod": { version: "1.0.1", integrity: "sha512-other" }, "node_modules/stray": { version: "9.9.9" } });
    assert.deepEqual(await installedDependencyMismatches(deps), [
      "node_modules/prod: locked 1.0.0, installed 1.0.1",
      "node_modules/prod: integrity differs from package-lock.json",
      "node_modules/stray: installed but not in package-lock.json",
    ]);
    await writeHidden({ "node_modules/prod": { version: "1.0.0", integrity: "sha512-prod" } });
    await writeJson(path.join(deps, "node_modules", "prod", "package.json"), { version: "0.9.0" });
    assert.deepEqual(await installedDependencyMismatches(deps), ["node_modules/prod: its package.json says 0.9.0, locked 1.0.0"], "a stale hidden lockfile is caught");
    await writeHidden({});
    assert.deepEqual(await installedDependencyMismatches(deps), ["node_modules/prod: locked 1.0.0, not installed"]);
    await rm(path.join(deps, "node_modules", ".package-lock.json"));
    assert.match((await installedDependencyMismatches(deps))[0], /node_modules\/\.package-lock\.json cannot be read.*run npm ci/);
    const dependencyStep = gateSteps({ sourceRoot: deps }).find((step) => step.name === "installed dependencies");
    const stepResult = await dependencyStep.run();
    assert.equal(stepResult.exitCode, 1);
    assert.match(stepResult.output, /^node_modules does not match package-lock.json \(1\); run npm ci:/);
    assert.equal((await installedDependencyMismatches(SOURCE_ROOT)).length, 0, "this checkout's node_modules matches its lockfile");

    // node --test's skipped count is recorded.
    assert.deepEqual(parseStepOutput("ℹ skipped 2\n").skips, [{ name: "node --test", reason: "2 test(s) reported skipped; see the step output" }]);

    // A link inside the source tree is refused rather than digested through (a junction needs
    // no privilege on Windows), and so is a missing tree.
    const linkTarget = path.join(fixture, "elsewhere");
    await mkdir(linkTarget);
    await symlink(linkTarget, path.join(source, "tests", "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(sourceTreeDigest(source), /Release source contains a link: tests\/linked/);
    await assert.rejects(sourceTreeDigest(path.join(fixture, "missing-source")), /ENOENT/);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  process.stdout.write("release-gate self-test passed\n");
  selfTestPassed("release-gate");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
    return;
  }
  const { receipt } = await runReleaseGate({ receiptPath: options.receiptPath, configPath: options.configPath });
  if (!receipt.ok) {
    // B-058: a failed gate step is not an exception, but it is a failure to find later.
    recordCliFailure("release-gate", { name: "release_gate_failed", message: `Release gate failed: ${receipt.failure || "a step failed"}` });
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\nrelease gate failed: ${error?.message || error}\n`);
    recordCliFailure("release-gate", error);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_RECEIPT_PATH,
  RECEIPT_KIND,
  RECEIPT_MAX_AGE_MS,
  REQUIRED_STEPS,
  assertReleaseSourceComplete,
  installedDependencyMismatches,
  readGateReceipt,
  runReleaseGate,
  sourceTreeDigest,
  validateGateReceipt,
};
