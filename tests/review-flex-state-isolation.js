#!/usr/bin/env node

// B-073 (log.md, 2026-10-02): a self-test run without CODEX_OPENCODE_STATE_DIR uses a per-process
// temporary state directory, never the operator's ~/.codex/codex-opencode-mcp. Older suites set
// only hooks.stateDirectoryOverride, and a timer that fired after their cleanup reset it wrote
// job rows, empty databases and a schema change into the operator's state directory.
//   node tests/review-flex-state-isolation.js
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const server = pathToFileURL(fileURLToPath(new URL("../server.js", import.meta.url))).href;
const scratchHome = mkdtempSync(path.join(tmpdir(), "review-flex-state-isolation-"));
const inside = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// Imports server.js in a fresh process with the given argv flag and no CODEX_OPENCODE_STATE_DIR,
// and prints where its state directory is. CODEX_HOME points at a scratch folder, so even the
// non-self-test case never resolves to the operator's directory.
async function probe({ selfTest }) {
  const script = [
    selfTest ? "process.argv.push('--self-test');" : "",
    `const { __selfTest } = await import(${JSON.stringify(server)});`,
    "const i = __selfTest.internals;",
    "process.stdout.write(JSON.stringify({ dir: i.effectiveBridgeStateDirectory(), temp: i.SELF_TEST_TEMP_STATE_DIR, env: process.env.CODEX_OPENCODE_STATE_DIR || '' }));",
  ].join("\n");
  const env = { ...process.env, CODEX_HOME: path.join(scratchHome, ".codex"), CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off" };
  delete env.CODEX_OPENCODE_STATE_DIR;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env, windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("B-073: a self-test import without the variable uses a temporary state directory, removed at exit", async () => {
  const result = await probe({ selfTest: true });
  assert.ok(inside(result.dir, tmpdir()), `${result.dir} is under ${tmpdir()}`);
  assert.equal(path.resolve(result.dir), path.resolve(result.temp));
  assert.match(path.basename(result.dir), /^codex-opencode-selftest-state-\d+-/);
  assert.equal(path.resolve(result.env), path.resolve(result.dir), "child processes inherit the same folder");
  assert.equal(existsSync(result.dir), false, "removed when the process exits");
  assert.equal(existsSync(path.join(scratchHome, ".codex", "codex-opencode-mcp")), false, "the CODEX_HOME state directory was not touched");
});

test("B-073: a normal start still uses <CODEX_HOME>/codex-opencode-mcp, and an explicit variable wins in a self-test", async () => {
  const result = await probe({ selfTest: false });
  assert.equal(path.resolve(result.dir), path.resolve(scratchHome, ".codex", "codex-opencode-mcp"));
  assert.equal(result.temp, "");
  const explicit = path.join(scratchHome, "explicit-state");
  const script = [
    "process.argv.push('--self-test');",
    `const { __selfTest } = await import(${JSON.stringify(server)});`,
    "process.stdout.write(__selfTest.internals.effectiveBridgeStateDirectory());",
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, CODEX_OPENCODE_STATE_DIR: explicit, CODEX_OPENCODE_LOG_LEVEL: "off" }, windowsHide: true });
  assert.equal(path.resolve(stdout.trim().split(/\r?\n/).pop()), path.resolve(explicit));
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
  rmSync(scratchHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
void readdirSync;
const { finishSkips } = await import("./skip-gate.js");
const skipGateFailed = finishSkips({ file: "tests/review-flex-state-isolation.js", total: tests.length, skips: [] });
if (failed || skipGateFailed) {
  process.stdout.write(`${failed} of ${tests.length} state isolation tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} state isolation tests passed.\n`);
process.exit(0);
