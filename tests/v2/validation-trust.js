import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createValidationTrust } from "../../src/v2/security/validation-trust.js";
import { redactSensitiveText } from "../../src/v2/security/redaction.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function truncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

function createFixture({
  validationExecutableAllowlist = ["git", "node", "npm", "npx", "cmd", "python"],
  validationExecutableSha256Allowlist = [],
  validationCommandTimeoutMs = 90000,
  buildValidationEnv = () => ({ PATH: process.env.PATH || "", PATHEXT: process.env.PATHEXT || "" }),
  runCommand = async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  nowMs = () => 0,
  platform = process.platform,
  getCurrentWorkingDirectory = () => process.cwd(),
  lstatPath,
  realpathPath,
  fileHasher = sha256File,
} = {}) {
  return createValidationTrust({
    config: {
      validationExecutableAllowlist,
      validationExecutableSha256Allowlist,
      validationCommandTimeoutMs,
    },
    buildValidationEnv,
    runCommand,
    sha256File: fileHasher,
    nowMs,
    redactSensitiveText,
    truncateText,
    platform,
    getCurrentWorkingDirectory,
    ...(lstatPath ? { lstatPath } : {}),
    ...(realpathPath ? { realpathPath } : {}),
  });
}

{
  const { parseCommandLine } = createFixture();
  assert.deepEqual(parseCommandLine('npm run "test:unit" -- --watch=false'), ["npm", "run", "test:unit", "--", "--watch=false"]);
  assert.deepEqual(
    parseCommandLine('node "C:\\Program Files\\Example\\check.js" C:\\repo\\src'),
    ["node", "C:\\Program Files\\Example\\check.js", "C:\\repo\\src"]
  );
  assert.deepEqual(parseCommandLine("git diff --check -- 'src/a b.js' src\\ c.js"), [
    "git",
    "diff",
    "--check",
    "--",
    "src/a b.js",
    "src c.js",
  ]);
  assert.deepEqual(parseCommandLine('node "a\\\"b" one\\\\two'), ["node", 'a"b', "one\\two"]);
  assert.deepEqual(parseCommandLine("node '' \"\" final"), ["node", "final"], "Empty quoted arguments are intentionally omitted.");
  assert.throws(() => parseCommandLine('git diff "unterminated'), /unterminated quoted string/);
}

{
  const {
    safeValidationPathspec,
    strictProjectGitArgsError,
    validationCommandTrustError,
  } = createFixture();

  for (const candidate of ["src/index.js", "src\\nested\\file.js", ".", "--literal-name"]) {
    assert.equal(safeValidationPathspec(candidate), true, candidate);
  }
  for (const candidate of ["", "../secret", "src/../secret", "C:\\secret", "C:secret", "/absolute", "src\nfile"] ) {
    assert.equal(safeValidationPathspec(candidate), false, JSON.stringify(candidate));
  }

  assert.equal(strictProjectGitArgsError(["--version"]), "");
  assert.match(strictProjectGitArgsError(["--version", "extra"]), /no additional/);
  assert.equal(strictProjectGitArgsError(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]), "");
  assert.match(strictProjectGitArgsError(["status", "--ignored"]), /bounded porcelain/);
  assert.equal(strictProjectGitArgsError(["diff", "--check", "--cached", "--", "src/index.js"]), "");
  assert.match(strictProjectGitArgsError(["diff", "HEAD", "--check"]), /revisions\/operands/);
  assert.match(strictProjectGitArgsError(["diff", "--stat", "--check"]), /option is forbidden/);
  assert.match(strictProjectGitArgsError(["diff", "--", "src/index.js"]), /must use --check/);
  assert.match(strictProjectGitArgsError(["diff", "--check", "--", "../secret"]), /pathspec is unsafe/);
  assert.match(strictProjectGitArgsError(["diff", "--check", "--", "src", "--", "other"]), /at most one/);
  for (const vector of [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--verify", "HEAD"],
    ["rev-parse", "HEAD"],
  ]) {
    assert.equal(strictProjectGitArgsError(vector), "", vector.join(" "));
  }
  assert.match(strictProjectGitArgsError(["rev-parse", "--verify", "main"]), /approved fixed vector/);
  assert.equal(strictProjectGitArgsError(["ls-files", "--cached", "--", "src/index.js"]), "");
  assert.match(strictProjectGitArgsError(["ls-files", "--stage"]), /not bounded/);
  assert.match(strictProjectGitArgsError(["checkout", "main"]), /subcommand is not allowed/);

  assert.equal(validationCommandTrustError([]), "");
  assert.match(validationCommandTrustError(["curl", "https://example.invalid"]), /not operator-allowlisted/);
  assert.match(validationCommandTrustError(["cmd.exe", "/c", "echo"]), /Shell, interpreter/);
  assert.match(validationCommandTrustError(["npx", "package"]), /Shell, interpreter/);
  assert.match(validationCommandTrustError(["node", "--eval", "process.exit()"]), /Inline evaluation/);
  assert.match(validationCommandTrustError(["python", "-c", "pass"]), /Inline evaluation/);
  assert.match(validationCommandTrustError(["npm", "exec", "eslint"]), /Package-executor/);
  assert.match(validationCommandTrustError(["npm", "test"], { strictProjectPolicy: true }), /only a hash-pinned Git/);
  assert.equal(validationCommandTrustError(["npm", "test"]), "");
  assert.match(validationCommandTrustError(["git.exe", "push"]), /subcommand is not allowed/);
  assert.match(validationCommandTrustError(["git", "status", "-c=alias.status=!calc"]), /may not select aliases/);
  assert.match(validationCommandTrustError(["git", "diff", "--ext-diff", "--check"]), /may not select aliases/);
  assert.equal(validationCommandTrustError(["GIT.CMD", "diff", "--check", "--", "src/index.js"], { strictProjectPolicy: true }), "");
}

{
  let envCalls = 0;
  const { validationPathValue } = createFixture({
    buildValidationEnv: () => {
      envCalls += 1;
      return { Path: "from-Path", path: "from-path" };
    },
  });
  assert.equal(validationPathValue(), "from-Path");
  assert.equal(envCalls, 1);
  assert.equal(validationPathValue({ PATH: "upper", Path: "mixed", path: "lower" }), "upper");
  assert.equal(validationPathValue({ PATH: "", path: "lower" }), "lower");
  assert.equal(envCalls, 1, "An explicit environment does not rebuild the validation environment.");
}

const tempRoot = await mkdtemp(path.join(tmpdir(), `codex-v2-validation-trust-${process.pid}-`));
try {
  const extension = process.platform === "win32" ? ".CMD" : "";
  const firstDirectory = path.join(tempRoot, "first");
  const secondDirectory = path.join(tempRoot, "second");
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });
  const firstExecutable = path.join(firstDirectory, `fresh-tool${extension}`);
  const secondExecutable = path.join(secondDirectory, `fresh-tool${extension}`);
  await writeFile(firstExecutable, "first executable");
  await writeFile(secondExecutable, "second executable");

  let activeDirectory = firstDirectory;
  let envCalls = 0;
  const resolver = createFixture({
    validationExecutableAllowlist: [firstExecutable, secondExecutable],
    buildValidationEnv: () => {
      envCalls += 1;
      return { Path: activeDirectory, PATHEXT: extension || ".EXE" };
    },
  });
  const firstResolved = await resolver.resolveValidationExecutable("fresh-tool");
  activeDirectory = secondDirectory;
  const secondResolved = await resolver.resolveValidationExecutable("fresh-tool");
  assert.equal(firstResolved.path, await import("node:fs").then(({ realpathSync }) => realpathSync(firstExecutable)));
  assert.equal(secondResolved.path, await import("node:fs").then(({ realpathSync }) => realpathSync(secondExecutable)));
  assert.notEqual(firstResolved.sha256, secondResolved.sha256);
  assert.equal(envCalls, process.platform === "win32" ? 4 : 2, "PATH and PATHEXT are rebuilt on every resolution.");
  if (process.platform === "win32") {
    activeDirectory = firstDirectory;
    const mixedCase = await resolver.resolveValidationExecutable("FrEsH-ToOl");
    assert.equal(mixedCase.path.toLowerCase(), firstResolved.path.toLowerCase());
  }

  await assert.rejects(
    resolver.resolveValidationExecutable(`relative${path.sep}fresh-tool${extension}`),
    /relative paths are forbidden/
  );
  await assert.rejects(resolver.resolveValidationExecutable(""), /relative paths are forbidden/);

  const symbolicCandidate = path.join(tempRoot, `symbolic${extension}`);
  let canonicalCalls = 0;
  const symbolicResolver = createFixture({
    validationExecutableAllowlist: [symbolicCandidate],
    lstatPath: async () => ({ isSymbolicLink: () => true, isFile: () => true }),
    realpathPath: () => {
      canonicalCalls += 1;
      return symbolicCandidate;
    },
    fileHasher: async () => sha256("symbolic"),
  });
  await assert.rejects(symbolicResolver.resolveValidationExecutable(symbolicCandidate), /could not be resolved/);
  assert.equal(canonicalCalls, 0, "A direct symlink is rejected before canonicalization or hashing.");

  const lexicalCandidate = path.join(tempRoot, `parent-link`, `canonical-tool${extension}`);
  const canonicalCandidate = path.join(tempRoot, `real-parent`, `canonical-tool${extension}`);
  let hashedPath = "";
  const canonicalResolver = createFixture({
    validationExecutableAllowlist: [canonicalCandidate],
    lstatPath: async () => ({ isSymbolicLink: () => false, isFile: () => true }),
    realpathPath: () => canonicalCandidate,
    fileHasher: async (filePath) => {
      hashedPath = filePath;
      return sha256("canonical");
    },
  });
  assert.deepEqual(await canonicalResolver.resolveValidationExecutable(lexicalCandidate), {
    path: canonicalCandidate,
    sha256: sha256("canonical"),
  });
  assert.equal(hashedPath, canonicalCandidate, "The canonical target, not the lexical candidate, is hashed.");

  const allowedDirectory = path.join(tempRoot, "allowed");
  const rogueDirectory = path.join(tempRoot, "rogue");
  await mkdir(allowedDirectory, { recursive: true });
  await mkdir(rogueDirectory, { recursive: true });
  const executableName = `path-tool${extension}`;
  const allowedExecutable = path.join(allowedDirectory, executableName);
  const rogueExecutable = path.join(rogueDirectory, executableName);
  await writeFile(allowedExecutable, "allowed executable");
  await writeFile(rogueExecutable, "rogue executable");
  let searchPath = `${rogueDirectory}${path.delimiter}${allowedDirectory}`;
  const physicalAllowlist = createFixture({
    validationExecutableAllowlist: [allowedExecutable, path.join(tempRoot, `stale${extension}`)],
    buildValidationEnv: () => ({ PATH: searchPath, PATHEXT: extension || ".EXE" }),
  });
  const rejectedRogue = await physicalAllowlist.prepareValidationCommand(["path-tool", "check"]);
  assert.equal(rejectedRogue.ok, false);
  assert.equal(rejectedRogue.errorType, "validation_command_untrusted");
  assert.match(rejectedRogue.error, /not operator-allowlisted/);
  searchPath = allowedDirectory;
  const acceptedPhysical = await physicalAllowlist.prepareValidationCommand(["path-tool", "check"]);
  assert.equal(acceptedPhysical.ok, true);
  assert.equal(acceptedPhysical.executablePath.toLowerCase(), allowedExecutable.toLowerCase());

  const gitExecutable = path.join(tempRoot, `git${process.platform === "win32" ? ".exe" : ""}`);
  await writeFile(gitExecutable, "git fixture v1");
  const firstGitHash = await sha256File(gitExecutable);
  const gitFixture = createFixture({
    validationExecutableAllowlist: [gitExecutable, path.join(tempRoot, "missing-git")],
    validationExecutableSha256Allowlist: [` ${firstGitHash.toUpperCase()} `, "invalid", firstGitHash],
  });
  const preparedGit = await gitFixture.prepareValidationCommand([
    gitExecutable,
    "diff",
    "--check",
    "--no-ext-diff",
    "--",
    "src/index.js",
  ], { requirePinnedExecutable: true });
  assert.equal(preparedGit.ok, true);
  assert.equal(preparedGit.displayCommand, `${gitExecutable} diff --check --no-ext-diff -- src/index.js`);
  assert.deepEqual(preparedGit.args, ["diff", "--no-ext-diff", "--no-textconv", "--check", "--", "src/index.js"]);
  assert.equal(preparedGit.executableSha256, firstGitHash);
  assert.equal(preparedGit.commandSha256, sha256(JSON.stringify([preparedGit.executablePath, ...preparedGit.args])));
  assert.notEqual(preparedGit.commandSha256, preparedGit.executableSha256, "Executable identity and command-vector identity remain distinct.");

  const unpinned = await gitFixture.prepareValidationCommand([gitExecutable, "status", "--short"], {
    requirePinnedExecutable: true,
    operatorExecutableHashes: [],
  });
  assert.equal(unpinned.ok, false);
  assert.match(unpinned.error, /requires the exact executable SHA-256/);

  const rogueGit = path.join(rogueDirectory, path.basename(gitExecutable));
  await writeFile(rogueGit, "rogue git");
  const sameNameWrongPath = await gitFixture.prepareValidationCommand([rogueGit, "status", "--short"]);
  assert.equal(sameNameWrongPath.ok, false);
  assert.match(sameNameWrongPath.error, /not operator-allowlisted/);

  const parseFailure = await gitFixture.prepareValidationCommand('"unterminated');
  assert.deepEqual(parseFailure, {
    ok: false,
    errorType: "validation_command_parse_error",
    error: "Validation command has an unterminated quoted string.",
  });
  assert.deepEqual(await gitFixture.prepareValidationCommand(""), {
    ok: false,
    errorType: "validation_command_parse_error",
    error: "Validation command is empty.",
  });

  const runCalls = [];
  const signalController = new AbortController();
  const times = [100, 125];
  let executionEnvCalls = 0;
  const normalGate = createFixture({
    validationExecutableAllowlist: [gitExecutable],
    validationCommandTimeoutMs: 4321,
    buildValidationEnv: () => {
      executionEnvCalls += 1;
      return { PATH: "trusted-path", MARKER: String(executionEnvCalls) };
    },
    runCommand: async (...args) => {
      runCalls.push(args);
      return {
        stdout: `ok Authorization: Bearer ${"a".repeat(24)}`,
        stderr: "warning password=hunter2",
        exitCode: 0,
      };
    },
    nowMs: () => times.shift(),
    getCurrentWorkingDirectory: () => path.join(tempRoot, "default-cwd"),
  });
  assert.deepEqual(await normalGate.runValidationGate({ command: "" }), {
    status: "skipped",
    command: "",
    exitCode: "not_run",
    durationMs: 0,
    stdout: "",
    stderr: "",
    errorType: null,
  });
  assert.deepEqual(await normalGate.runValidationGate({ command: "definitely-untrusted", dryRun: true }), {
    status: "skipped_dry_run",
    command: "definitely-untrusted",
    exitCode: "not_run",
    durationMs: 0,
    stdout: "",
    stderr: "",
    errorType: null,
  });
  const passed = await normalGate.runValidationGate({
    command: `${gitExecutable} status --short`,
    signal: signalController.signal,
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.durationMs, 25);
  assert.equal(passed.errorType, null);
  assert.doesNotMatch(passed.stdout, /a{24}/);
  assert.match(passed.stdout, /\[redacted\]/);
  assert.doesNotMatch(passed.stderr, /hunter2/);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0][0].toLowerCase(), gitExecutable.toLowerCase());
  assert.deepEqual(runCalls[0][1], ["status", "--short"]);
  assert.equal(runCalls[0][2], path.join(tempRoot, "default-cwd"));
  assert.equal(runCalls[0][3], 4321);
  assert.deepEqual(runCalls[0][4], { PATH: "trusted-path", MARKER: "1" });
  assert.equal(runCalls[0][5].signal, signalController.signal);
  assert.equal(executionEnvCalls, 1);

  let failureRuns = 0;
  const failedGate = createFixture({
    validationExecutableAllowlist: [gitExecutable],
    runCommand: async () => {
      failureRuns += 1;
      return { stdout: "partial", stderr: "timed out", exitCode: 124 };
    },
    nowMs: (() => {
      const values = [200, 250];
      return () => values.shift();
    })(),
  });
  const timedOut = await failedGate.runValidationGate({ command: `${gitExecutable} status --short`, timeoutMs: 99 });
  assert.deepEqual(timedOut, {
    status: "failed",
    command: `${gitExecutable} status --short`,
    exitCode: 124,
    durationMs: 50,
    stdout: "partial",
    stderr: "timed out",
    errorType: "validation_command_failed",
  });
  assert.equal(failureRuns, 1);

  let unauthorizedRuns = 0;
  const unauthorizedGate = createFixture({
    validationExecutableAllowlist: [gitExecutable],
    runCommand: async () => {
      unauthorizedRuns += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.deepEqual(await unauthorizedGate.runValidationGate({ command: '"unterminated' }), {
    status: "failed",
    command: '"unterminated',
    exitCode: "parse_error",
    durationMs: 0,
    stdout: "",
    stderr: "Validation command has an unterminated quoted string.",
    errorType: "validation_command_parse_error",
  });
  assert.equal((await unauthorizedGate.runValidationGate({ command: "curl example.invalid" })).exitCode, "not_authorized");
  assert.equal(unauthorizedRuns, 0);

  const gitRunCalls = [];
  let gitEnvCalls = 0;
  const gitTimes = [1000, 1030, 1060];
  const gitGate = createFixture({
    validationExecutableAllowlist: [gitExecutable],
    buildValidationEnv: () => ({ PATH: "fresh", PASS: String(++gitEnvCalls) }),
    runCommand: async (...args) => {
      gitRunCalls.push(args);
      return gitRunCalls.length === 1
        ? { stdout: "unstaged", stderr: "", exitCode: 0 }
        : { stdout: "staged", stderr: "staged failure", exitCode: 3 };
    },
    nowMs: () => gitTimes.shift(),
  });
  const staged = await gitGate.runValidationGate({
    command: `${gitExecutable} diff --check -- src/index.js`,
    cwd: tempRoot,
    timeoutMs: 1000,
    signal: signalController.signal,
  });
  assert.equal(staged.status, "failed");
  assert.equal(staged.exitCode, 3);
  assert.equal(staged.durationMs, 60);
  assert.equal(staged.stdout, "unstaged\nstaged");
  assert.equal(staged.stderr, "staged failure");
  assert.equal(gitRunCalls.length, 2);
  assert.deepEqual(gitRunCalls[0][1], ["diff", "--no-ext-diff", "--no-textconv", "--check", "--", "src/index.js"]);
  assert.deepEqual(gitRunCalls[1][1], ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--check", "--", "src/index.js"]);
  assert.equal(gitRunCalls[0][3], 1000);
  assert.equal(gitRunCalls[1][3], 970);
  assert.deepEqual(gitRunCalls.map((call) => call[4].PASS), ["1", "2"], "Each Git pass receives a newly built validation environment.");
  assert.equal(gitRunCalls.every((call) => call[5].signal === signalController.signal), true);

  const secondGitHash = sha256("git fixture v2");
  let driftRuns = 0;
  const driftGate = createFixture({
    validationExecutableAllowlist: [gitExecutable],
    validationExecutableSha256Allowlist: [firstGitHash, secondGitHash],
    runCommand: async () => {
      driftRuns += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const trustedSpec = await driftGate.prepareValidationCommand([gitExecutable, "status", "--short"], {
    requirePinnedExecutable: true,
  });
  assert.equal(trustedSpec.ok, true);
  await writeFile(gitExecutable, "git fixture v2");
  const drifted = await driftGate.runValidationGate({
    command: trustedSpec.displayCommand,
    cwd: tempRoot,
    trustedSpec,
  });
  assert.deepEqual(drifted, {
    status: "failed",
    command: trustedSpec.displayCommand,
    exitCode: "not_authorized",
    durationMs: 0,
    stdout: "",
    stderr: "The operator-pinned validation executable or exact argument vector changed after policy approval.",
    errorType: "validation_command_untrusted",
  });
  assert.equal(driftRuns, 0, "Executable content drift is re-hashed and rejected immediately before execution.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("V2 validation trust tests passed.");
