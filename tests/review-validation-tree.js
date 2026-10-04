#!/usr/bin/env node

// Production review (gpt-6.1-sol, 2026-09-30, blocker 1): a validation command ran through
// execFile with a timeout, which ends only the direct child. A test runner's worker kept running
// and could write the checkout after the bridge had rolled it back and released its lock. A
// validation command other than bridge Git now runs under the process-tree supervisor.
//   node tests/review-validation-tree.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { __selfTest } = await import("../server.js");
const { runCommand, runValidationGate } = __selfTest.internals;

const fixture = await mkdtemp(path.join(tmpdir(), "codex-validation-tree-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The parent never exits on its own. Its child is detached with stdio ignored, the way a Python
// runner (pytest workers) or any spawner outside Node's kill-on-close job object leaves it, and
// writes a file after a delay.
async function treeScript(marker) {
  const script = path.join(fixture, `tree-${marker}.js`);
  await writeFile(script, [
    "const { spawn } = require('node:child_process');",
    `const target = ${JSON.stringify(path.join(fixture, `${marker}.late`))};`,
    "spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(target)}, 'late'), 2500)`], { stdio: 'ignore', detached: true }).unref();",
    "setTimeout(() => {}, 60000);",
  ].join("\n"));
  return script;
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

try {
  await check("control: the plain runner's timeout leaves the grandchild running, and it writes", async () => {
    const script = await treeScript("control");
    const result = await runCommand(process.execPath, [script], fixture, 700);
    assert.notEqual(result.exitCode, 0);
    await sleep(4000);
    assert.equal(existsSync(path.join(fixture, "control.late")), true, "the control did not reproduce the orphan, so the next case proves nothing here");
  });

  await check("a timed-out validation ends its whole process tree: nothing writes afterwards", async () => {
    const script = await treeScript("validation");
    const gate = await runValidationGate({ command: `node ${JSON.stringify(script)}`, cwd: fixture, timeoutMs: 700 });
    assert.equal(gate.status, "failed", JSON.stringify(gate));
    assert.ok(["validation_command_failed", "validation_process_tree_unconfirmed"].includes(gate.errorType), JSON.stringify(gate));
    assert.equal(gate.exitCode, "timeout", JSON.stringify(gate));
    await sleep(4000);
    assert.equal(existsSync(path.join(fixture, "validation.late")), false, "a validation process wrote after the gate returned");
  });

  await check("a passing validation still passes, and bridge Git keeps the plain runner", async () => {
    const script = path.join(fixture, "ok.js");
    await writeFile(script, "process.stdout.write('fine');\n");
    const gate = await runValidationGate({ command: `node ${JSON.stringify(script)}`, cwd: fixture });
    assert.equal(gate.status, "passed", JSON.stringify(gate));
    assert.match(gate.stdout, /fine/);
    const git = await runValidationGate({ command: "git --version", cwd: fixture });
    assert.equal(git.status, "passed", JSON.stringify(git));
  });
} finally {
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} validation-tree tests failed.` : `All ${results.length} validation-tree tests passed.`);
process.exit(failed ? 1 : 0);
