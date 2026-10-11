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
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createValidationRuntime } from "../lib/validation-command.js";
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
  const bin = path.join(fixture, "bin");
  await mkdir(bin);
  const dailyAllowlist = ["git", "npm", "node", "pnpm", "yarn", "python", "pytest"];
  const native = (name) => path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  for (const name of dailyAllowlist) await writeFile(native(name), `MZ synthetic ${name}`);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const hashes = [];
  const config = { validationExecutableAllowlist: dailyAllowlist, validationExecutableSha256Allowlist: [] };
  let launches = 0;
  const runtime = createValidationRuntime({
    CONFIG: config, buildValidationEnv: () => ({ PATH: bin, PATHEXT: ".CMD;.EXE" }),
    sha256File: async (file) => { hashes.push(file); return digest(await readFile(file)); },
    integrationTimed: (_phase, operation) => operation(),
    runCommand: async () => { launches++; return { exitCode: 0 }; },
  });
  const gitPath = realpathSync(path.join(bin, process.platform === "win32" ? "git.EXE" : "git"));
  const gitSha256 = digest(await readFile(gitPath));
  await check("daily allowlist resolves paths and hashes only the selected native executable", async () => {
    hashes.length = 0;
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--check"];
    const expected = { ok: true, displayCommand: "git diff --check", executablePath: gitPath, executableSha256: gitSha256,
      args, commandSha256: digest(JSON.stringify([gitPath, ...args, null])) };
    assert.equal(JSON.stringify(await runtime.prepareValidationCommand("git diff --check")), JSON.stringify(expected));
    assert.deepEqual(hashes, [gitPath]);
    config.validationExecutableAllowlist = ["git"];
    hashes.length = 0;
    assert.equal(JSON.stringify(await runtime.prepareValidationCommand("git diff --check")), JSON.stringify(expected));
    assert.deepEqual(hashes, [gitPath], "the default allowlist must not hash git twice");
    config.validationExecutableAllowlist = dailyAllowlist;
  });
  await check("preflight preserves parse, unknown-executable and pin refusals before any launch", async () => {
    assert.deepEqual(await runtime.prepareValidationCommand(""), { ok: false, errorType: "validation_command_parse_error", error: "Validation command is empty." });
    assert.deepEqual(await runtime.prepareValidationCommand('git "unterminated'), { ok: false, errorType: "validation_command_parse_error", error: "Validation command has an unterminated quoted string." });
    assert.deepEqual(await runtime.validationCommandPreflightError("unknown --version"), { errorType: "validation_command_untrusted", error: "Validation executable is not operator-allowlisted: unknown", command: "unknown --version" });
    assert.deepEqual(await runtime.prepareValidationCommand("git --version", { requirePinnedExecutable: true }), { ok: false, errorType: "validation_command_untrusted", error: "Project-policy validation requires the exact executable SHA-256 in CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST." });
    assert.equal((await runtime.prepareValidationCommand("git --version", { requirePinnedExecutable: true, operatorExecutableHashes: [gitSha256] })).ok, true);
    const unavailable = path.join(fixture, "missing", path.basename(gitPath));
    const command = `"${unavailable}" --version`;
    assert.deepEqual(await runtime.validationCommandPreflightError(command), { errorType: "validation_command_untrusted", error: `Validation executable could not be resolved through the trusted process PATH: ${unavailable}`, command });
    const other = path.join(fixture, path.basename(gitPath));
    await writeFile(other, await readFile(gitPath));
    assert.deepEqual(await runtime.prepareValidationCommand([other, "--version"]), { ok: false, errorType: "validation_command_untrusted", error: `Validation executable is not operator-allowlisted: ${other}` });
    assert.equal(launches, 0);
  });
  if (process.platform === "win32") await check("a selected Windows shim retains its shim, interpreter and entry hashes", async () => {
    const shim = path.join(bin, "npm.cmd"), entry = path.join(bin, "entry.js");
    await writeFile(shim, '"node.exe" "%~dp0entry.js" %*\r\n');
    await writeFile(entry, "synthetic entry");
    hashes.length = 0;
    const prepared = await runtime.prepareValidationCommand("npm --version");
    const nodePath = realpathSync(native("node")), entryPath = realpathSync(entry), shimPath = realpathSync(path.join(bin, "npm.CMD"));
    const evidence = { shimPath, shimSha256: digest(await readFile(shimPath)), scriptSha256: digest(await readFile(entryPath)) };
    const args = [entryPath, "--version"];
    assert.equal(JSON.stringify(prepared), JSON.stringify({ ok: true, displayCommand: "npm --version", executablePath: nodePath,
      executableSha256: digest(await readFile(nodePath)), args, commandSha256: digest(JSON.stringify([nodePath, ...args, evidence])), windowsShim: evidence }));
    assert.deepEqual(hashes, [shimPath, nodePath, entryPath]);
  });
  await check("the post-run gate re-prepares and refuses executable drift after approval", async () => {
    const approved = await runtime.prepareValidationCommand("git --version");
    await writeFile(gitPath, "MZ changed executable");
    config.validationExecutableSha256Allowlist = [gitSha256, digest(await readFile(gitPath))];
    hashes.length = 0;
    const gate = await runtime.runValidationGate({ command: "git --version", cwd: fixture, trustedSpec: approved });
    assert.equal(gate.errorType, "validation_command_untrusted");
    assert.equal(gate.stderr, "The operator-pinned validation executable or exact argument vector changed after policy approval.");
    assert.deepEqual(hashes, [gitPath]);
    assert.equal(launches, 0);
  });

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
