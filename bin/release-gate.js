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
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_PUBLISH_ENTRIES } from "./build-release.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { digestTree } from "./plugin-tree-digest.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSelfTestRun(import.meta.url);
const RECEIPT_KIND = "codex-opencode-mcp-release-gate";
const RECEIPT_VERSION = 1;
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_RECEIPT_PATH = path.join(SOURCE_ROOT, ".release-gate", "receipt.json");
const SOURCE_TREE_ENTRIES = Object.freeze(LEGACY_PUBLISH_ENTRIES.filter((entry) => entry !== "node_modules"));
const REQUIRED_STEPS = Object.freeze(["npm test", "test:concurrency", "npm audit", "live health smoke"]);

function defaultConfigPath() {
  return path.join(homedir(), ".codex", "config.toml");
}

function gateSteps({ sourceRoot = SOURCE_ROOT, configPath = defaultConfigPath() } = {}) {
  // npm is a .cmd shim on Windows, which Node only starts through a shell.
  return [
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

// opencode/.gitignore is untracked (it ignores itself), so a fresh worktree lacks it; a missing
// entry is digested as absent here, and the release build still refuses it.
async function sourceTreeDigest(sourceRoot = SOURCE_ROOT) {
  const digest = await digestTree(sourceRoot, { include: SOURCE_TREE_ENTRIES, allowMissing: true, label: "Release source" });
  return { treeSha256: digest.treeSha256, fileCount: digest.fileCount, entries: [...SOURCE_TREE_ENTRIES] };
}

function gitHead(sourceRoot) {
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
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

// Runs one step with its output streamed through to this process and kept for parsing.
function runStepProcess(step, { cwd }) {
  return new Promise((resolve) => {
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
    if (exitCode !== 0) {
      receipt.failure = `${step.name} failed (exit ${exitCode}).`;
      break;
    }
    if (step.requireCheckSummary && !parsed.checks) {
      receipt.failure = `${step.name} printed no "Checks: <n> passed, skipped: <n>" line.`;
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

async function writeSourceFixture(root) {
  for (const directory of ["bin", "tests", "opencode/agents", "opencode/skills"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const [file, text] of Object.entries({
    "server.js": "// server\n",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "bin/tool.js": "// tool\n",
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
    assert.deepEqual(receipt.steps.map((step) => step.exitCode), [0, 0, 0, 0]);
    assert.deepEqual(receipt.steps[1].checks, { passed: 14, skipped: 0 });
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
    assert.throws(() => validateGateReceipt({ ...stored, steps: stored.steps.slice(0, 3) }, { treeSha256 }), /no "live health smoke" step/);
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
    assert.deepEqual(ran, ["npm test", "test:concurrency"]);
    assert.equal(failing.receipt.ok, false);
    assert.match(failing.receipt.failure, /test:concurrency failed \(exit 1\)/);
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

    // A missing entry (a worktree without the untracked opencode/.gitignore) is digested as
    // absent: no error, but not the digest of the tree that has it.
    const withIgnore = (await sourceTreeDigest(source)).treeSha256;
    await rm(path.join(source, "opencode", ".gitignore"));
    assert.notEqual((await sourceTreeDigest(source)).treeSha256, withIgnore);

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
  if (!receipt.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\nrelease gate failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_RECEIPT_PATH,
  RECEIPT_KIND,
  RECEIPT_MAX_AGE_MS,
  REQUIRED_STEPS,
  readGateReceipt,
  runReleaseGate,
  sourceTreeDigest,
  validateGateReceipt,
};
