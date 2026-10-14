#!/usr/bin/env node

// D5-R01: interpreter grammar and empty quoted arguments through the real gate.
// Only the bounded, benign Node argv fixture executes; Python is never launched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createValidationRuntime, parseCommandLine } from "../lib/validation-command.js";
import { finishSkips } from "./skip-gate.js";

const tests = [], test = (name, fn) => tests.push({ name, fn });
const digest = value => createHash("sha256").update(value).digest("hex");
const allowlist = ["node", "python", "python3", "py", "bun", "deno", "git", "npm", "pnpm", "yarn", "pytest", "cmd", "powershell", "bash", "npx"];
let resolutionCalls = 0, hashCalls = 0, launches = 0;
const guardRuntime = createValidationRuntime({
  CONFIG: { validationExecutableAllowlist: allowlist, validationExecutableSha256Allowlist: [], validationCommandTimeoutMs: 3000 },
  buildValidationEnv: () => { resolutionCalls++; throw new Error("Refused commands must not resolve executables."); },
  sha256File: async () => { hashCalls++; throw new Error("Refused commands must not hash executables."); },
  runCommand: async () => { launches++; throw new Error("No Git fixture execution is expected."); },
  runSpawnCommand: async () => { launches++; throw new Error("Refused commands must not spawn."); },
  integrationTimed: (_phase, fn) => fn(), nowMs: () => Date.now(), truncateText: (value, size) => value.slice(0, size),
});

const parserCases = [
  ["middle empty double quotes", 'node check.cjs "" marker', ["node", "check.cjs", "", "marker"]],
  ["middle empty single quotes", "node check.cjs '' marker", ["node", "check.cjs", "", "marker"]],
  ["leading empty argument", '"" node check.cjs', ["", "node", "check.cjs"]],
  ["trailing empty argument", 'node check.cjs marker ""', ["node", "check.cjs", "marker", ""]],
  ["repeated mixed empty quotes", `node "" '' "" marker ''`, ["node", "", "", "", "marker", ""]],
  ["concatenated empty quote segments", `node ""''"" marker`, ["node", "", "marker"]],
  ["adjacent empty and nonempty segments", `node pre""'mid'""post ''suffix prefix''`, ["node", "premidpost", "suffix", "prefix"]],
  ["quoted spaces", 'node "a b" \'c d\' " "', ["node", "a b", "c d", " "]],
  ["Windows path escaping", String.raw`node "C:\Program Files\Example\check.js" C:\repo\src`, ["node", String.raw`C:\Program Files\Example\check.js`, String.raw`C:\repo\src`]],
  ["escaped spaces outside quotes", String.raw`node check\ file.cjs marker`, ["node", "check file.cjs", "marker"]],
  ["escaped quote inside quotes", String.raw`node "a\"b" 'c\'d'`, ["node", 'a"b', "c'd"]],
  ["unescaped backslashes stay literal", String.raw`node C:\repo\a.txt "C:\repo\a.txt"`, ["node", String.raw`C:\repo\a.txt`, String.raw`C:\repo\a.txt`]],
  ["trailing backslash", "node path\\", ["node", "path\\"]],
  ["whitespace-only command", " \t\r\n ", []],
  ["empty and absent command", undefined, []],
];
for (const [name, input, expected] of parserCases) test(`parser preserves ${name}`, () => {
  assert.deepEqual(parseCommandLine(input), expected);
});
test("unterminated quotes still fail after an empty token", () => {
  for (const input of ['node "" "unterminated', "node '' 'unterminated", 'node a"']) {
    assert.throws(() => parseCommandLine(input), /unterminated quoted string/);
  }
});

for (const executable of ["python", "python3", "py"]) {
  for (const option of ["-cprint(123)", "-Icprint(123)", "-icprint(123)", "-uOBcprint(123)"]) {
    test(`${executable} ${option} is refused before preparation or gate resolution/spawn`, async () => {
      const command = `${executable} "${option}"`;
      assert.match(guardRuntime.validationCommandTrustError(parseCommandLine(command)), /Inline evaluation/);
      const before = [resolutionCalls, hashCalls, launches];
      const prepared = await guardRuntime.prepareValidationCommand(command);
      assert.equal(prepared.ok, false);
      assert.equal(prepared.errorType, "validation_command_untrusted");
      assert.match(prepared.error, /Inline evaluation/);
      const preflight = await guardRuntime.validationCommandPreflightError(command);
      assert.equal(preflight.errorType, "validation_command_untrusted");
      const gate = await guardRuntime.runValidationGate({ command, cwd: process.cwd() });
      assert.equal(gate.status, "failed");
      assert.equal(gate.exitCode, "not_authorized");
      assert.equal(gate.errorType, "validation_command_untrusted");
      assert.match(gate.stderr, /Inline evaluation/);
      assert.deepEqual([resolutionCalls, hashCalls, launches], before);
    });
  }
}

test("Python separated and bundled code refusals survive option operands and launcher selectors", () => {
  for (const vector of [
    ["python", "-c", "print(123)"], ["python", "-Ic", "print(123)"],
    ["python", "-ic", "print(123)"], ["python", "-W", "ignore", "-cprint(123)"],
    ["python", "-X", "utf8", "-Icprint(123)"], ["python", "-Xutf8", "-cprint(123)"],
    ["python", "--check-hash-based-pycs", "always", "-cprint(123)"],
    ["py", "-3.12", "-Icprint(123)"], ["py", "-V:PythonCore/3.12", "-icprint(123)"],
  ]) assert.match(guardRuntime.validationCommandTrustError(vector), /Inline evaluation/, JSON.stringify(vector));
});

const pythonSafeCases = [
  ["pytest module arguments", ["python", "-m", "pytest", "-p", "no:cacheprovider"]],
  ["attached module name", ["python", "-mpytest", "-p", "no:cacheprovider", "-c", "pytest.ini"]],
  ["bundled module boundary", ["python3", "-Impytest", "-p", "no:cacheprovider"]],
  ["lowercase bundled module boundary", ["py", "-impytest", "-cprint(123)"]],
  ["plain script argument boundary", ["python", "check.py", "-cprint(123)", "--require=fixture"]],
  ["isolated script argument boundary", ["python3", "-I", "check.py", "-c", "data"]],
  ["option separator", ["python", "--", "-cscript.py", "-cprint(123)"]],
  ["stdin argument boundary", ["python", "-", "-cprint(123)"]],
  ["empty script operand", ["python", "", "-cprint(123)"]],
  ["warning operand", ["python", "-W", "-c-is-warning-data", "check.py"]],
  ["bundled warning operand", ["python", "-IWignore", "check.py", "-cprint(123)"]],
  ["extended option operand", ["python", "-X", "-c-is-option-data", "check.py"]],
  ["attached extended option operand", ["python", "-Xutf8", "check.py"]],
  ["long option operand", ["python", "--check-hash-based-pycs", "always", "check.py", "-cprint(123)"]],
];
for (const [name, vector] of pythonSafeCases) test(`Python grammar preserves ${name}`, () => {
  assert.equal(guardRuntime.validationCommandTrustError(vector), "", JSON.stringify(vector));
});

test("existing separated/bundled Node and long inline/preload refusals remain", () => {
  for (const option of ["-e", "-p", "-r", "-pe", "-ep", "--eval", "--eval=payload", "--print=payload",
    "--require=fixture", "--import=fixture", "--loader=fixture", "--experimental-loader=fixture",
    "--experimental-default-type=module", "--env-file=fixture", "--inspect-brk"]) {
    assert.match(guardRuntime.validationCommandTrustError(["node", option, "fixture"]), /Inline evaluation/, option);
  }
  for (const vector of [["python", "--eval=payload"], ["python", "--require=fixture"],
    ["python", "-Xpresite=fixture", "check.py"], ["python", "-X", "presite=fixture", "check.py"]]) {
    assert.match(guardRuntime.validationCommandTrustError(vector), /Inline evaluation/, JSON.stringify(vector));
  }
});

test("safe Node tests, package scripts and bounded Git vectors retain their policy", () => {
  for (const vector of [["node", "check.cjs", "", "marker"], ["node", "--test", "tests/check.test.js"],
    ["npm", "run", "test:unit", "--", "--watch=false"], ["pnpm", "test", "--filter", "x"],
    ["yarn", "test"], ["git", "--version"], ["git", "status", "--short"],
    ["git", "diff", "--check", "--", "src"]]) {
    assert.equal(guardRuntime.validationCommandTrustError(vector), "", JSON.stringify(vector));
  }
  assert.equal(guardRuntime.validationCommandTrustError(["git", "diff", "--check"], { strictProjectPolicy: true }), "");
  assert.match(guardRuntime.validationCommandTrustError(["node", "check.cjs"], { strictProjectPolicy: true }), /hash-pinned Git/);
  assert.match(guardRuntime.validationCommandTrustError(["git", "diff", "--check", "--", "../outside"]), /unsafe/);
});

test("shells, package executors and Deno inline commands stay forbidden", () => {
  for (const vector of [["cmd", "/c", "echo"], ["powershell", "-Command", "echo"], ["bash", "-c", "echo"],
    ["npx", "vitest"], ["npm", "exec", "fixture"], ["pnpm", "dlx", "fixture"], ["yarn", "node", "fixture"],
    ["deno", "eval", "fixture"], ["deno", "repl"]]) assert.ok(guardRuntime.validationCommandTrustError(vector), JSON.stringify(vector));
});

test("parse failures, empty command and dry/sanitized preflight do not resolve or spawn", async () => {
  const before = [resolutionCalls, hashCalls, launches];
  assert.equal((await guardRuntime.prepareValidationCommand('node "" "unterminated')).errorType, "validation_command_parse_error");
  assert.equal((await guardRuntime.prepareValidationCommand(" \t ")).errorType, "validation_command_parse_error");
  assert.match(guardRuntime.validationCommandTrustError(parseCommandLine('"" node')), /not operator-allowlisted/);
  assert.equal(await guardRuntime.validationCommandPreflightError(""), null);
  assert.equal(await guardRuntime.validationCommandPreflightError('python "-cprint(123)"', { dryRun: true }), null);
  assert.equal(await guardRuntime.validationCommandPreflightError('python "-cprint(123)"', { sanitized: true }), null);
  assert.equal((await guardRuntime.runValidationGate({ command: " \t ", cwd: process.cwd() })).status, "skipped");
  assert.equal((await guardRuntime.runValidationGate({ command: 'python "-cprint(123)"', cwd: process.cwd(), dryRun: true })).status, "skipped_dry_run");
  assert.deepEqual([resolutionCalls, hashCalls, launches], before);
});

let scratch = "", scratchParent = "", nativeRuntime, nativeLaunches = 0, argvScript = "";
async function nativeFixture() {
  if (nativeRuntime) return nativeRuntime;
  scratchParent = await realpath(tmpdir());
  scratch = await mkdtemp(path.join(scratchParent, "review-day5-validation-"));
  assert.equal(path.dirname(await realpath(scratch)), scratchParent);
  argvScript = path.join(scratch, "argv.cjs");
  await writeFile(argvScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  nativeRuntime = createValidationRuntime({
    CONFIG: { validationExecutableAllowlist: ["node"], validationExecutableSha256Allowlist: [], validationCommandTimeoutMs: 3000 },
    buildValidationEnv: () => ({ PATH: path.dirname(process.execPath), PATHEXT: ".EXE", SystemRoot: process.env.SystemRoot,
      TEMP: scratch, TMP: scratch, TMPDIR: scratch }),
    sha256File: async file => digest(await readFile(file)),
    integrationTimed: (_phase, fn) => fn(), nowMs: () => Date.now(), truncateText: (value, size) => value.slice(0, size),
    runCommand: async () => { throw new Error("No Git command is part of the native argv fixture."); },
    runSpawnCommand: async (exe, args, cwd, timeoutMs, env) => {
      const canonical = value => process.platform === "win32" ? value.toLowerCase() : value;
      assert.equal(canonical(await realpath(exe)), canonical(await realpath(process.execPath)));
      assert.equal(args[0], argvScript.replace(/\\/g, "/"));
      assert.equal(cwd, scratch);
      assert.equal(timeoutMs, 3000);
      nativeLaunches++;
      return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("Bounded Node argv fixture timed out.")); }, timeoutMs);
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", exitCode => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, payloadProcessId: child.pid }); });
      });
    },
  });
  return nativeRuntime;
}
function nodeCommand(suffix) {
  const quoted = value => `"${value.replace(/\\/g, "/")}"`;
  return `${quoted(process.execPath)} ${quoted(argvScript)} ${suffix}`;
}
for (const [name, suffix, expected] of [
  ["leading/middle/trailing empty args", '"" marker ""', ["", "marker", ""]],
  ["repeated single/double empty args", `'' "" marker '' ""`, ["", "", "marker", "", ""]],
  ["concatenated empty segments and text", `""'' marker pre""post ""`, ["", "marker", "prepost", ""]],
]) test(`native Node receives ${name} through preparation and actual gate`, async () => {
  const runtime = await nativeFixture(), command = nodeCommand(suffix);
  const prepared = await runtime.prepareValidationCommand(command);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.displayCommand, command);
  assert.deepEqual(prepared.args, [argvScript.replace(/\\/g, "/"), ...expected]);
  assert.equal(prepared.commandSha256, digest(JSON.stringify([prepared.executablePath, ...prepared.args, null])));
  assert.equal(await runtime.validationCommandPreflightError(command), null);
  const before = nativeLaunches;
  const gate = await runtime.runValidationGate({ command, cwd: scratch });
  assert.equal(gate.status, "passed", JSON.stringify(gate));
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.errorType, null);
  assert.deepEqual(JSON.parse(gate.stdout), expected);
  assert.equal(nativeLaunches, before + 1);
});

test("array preparation preserves empty args and their distinct command hash", async () => {
  const runtime = await nativeFixture();
  const withEmpty = await runtime.prepareValidationCommand([process.execPath, argvScript, "", "marker", ""]);
  const withoutEmpty = await runtime.prepareValidationCommand([process.execPath, argvScript, "marker"]);
  assert.equal(withEmpty.ok, true, JSON.stringify(withEmpty));
  assert.equal(withoutEmpty.ok, true, JSON.stringify(withoutEmpty));
  assert.deepEqual(withEmpty.args, [argvScript, "", "marker", ""]);
  assert.equal(withEmpty.commandSha256, digest(JSON.stringify([withEmpty.executablePath, ...withEmpty.args, null])));
  assert.notEqual(withEmpty.commandSha256, withoutEmpty.commandSha256);
  assert.equal(launches, 0);
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  if (scratch) {
    assert.equal(path.dirname(await realpath(scratch)), scratchParent);
    assert.ok(path.basename(scratch).startsWith("review-day5-validation-"));
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
const skipGateFailed = finishSkips({ file: "tests/review-day5-validation.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} D5 validation tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
