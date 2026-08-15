import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createGitEvidenceService } from "../../src/v2/integration/git-evidence.js";
import {
  hasAmbiguousPathPattern,
  isAbsolutePathLike,
  normalizeLockPath,
} from "../../src/v2/policy/paths.js";

const execFileAsync = promisify(execFile);

async function runProcess(command, args, cwd, timeoutMs = 15000, env = process.env) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
    };
  }
}

const trustedRootOptions = {
  realpath: async (value) => value,
  resolveGitTopLevel: async (value) => value,
};

const idle = createGitEvidenceService({
  runCommand: () => { throw new Error("must remain lazy"); },
  buildValidationEnv: () => { throw new Error("must remain lazy"); },
  summarizeStderr: () => { throw new Error("must remain lazy"); },
  normalizeLockPath: () => { throw new Error("must remain lazy"); },
  hasAmbiguousPathPattern: () => { throw new Error("must remain lazy"); },
  isAbsolutePathLike: () => { throw new Error("must remain lazy"); },
  realpath: () => { throw new Error("must remain lazy"); },
  resolveGitTopLevel: () => { throw new Error("must remain lazy"); },
  sleep: () => { throw new Error("must remain lazy"); },
});
assert.deepEqual(Object.keys(idle), ["runGitReadOnlyCommand", "gitChangedFiles"]);

{
  const calls = [];
  const delays = [];
  let attempts = 0;
  const service = createGitEvidenceService({
    runCommand: async (...args) => {
      calls.push(args);
      attempts += 1;
      return attempts < 3
        ? { exitCode: 1, stdout: "", stderr: "fatal: .git/index: index file open failed: Permission denied" }
        : { exitCode: 0, stdout: "done", stderr: "" };
    },
    buildValidationEnv: (extra) => ({ PATH: "fixture", ...extra }),
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const result = await service.runGitReadOnlyCommand(["diff", "--cached", "--name-only"], "C:/repo", 1234);
  assert.deepEqual(result, { exitCode: 0, stdout: "done", stderr: "" });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [25, 50]);
  for (const [command, args, cwd, timeoutMs, env] of calls) {
    assert.equal(command, "git");
    assert.deepEqual(args, ["diff", "--cached", "--name-only"]);
    assert.equal(cwd, "C:/repo");
    assert.equal(timeoutMs, 1234);
    assert.equal(env.PATH, "fixture");
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, env.GIT_CONFIG_GLOBAL);
    assert.equal(env.GIT_ATTR_NOSYSTEM, "1");
    const config = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]])
    );
    assert.equal(config["core.fsmonitor"], "false");
    assert.equal(config["core.untrackedCache"], "false");
    assert.equal(config["core.trustctime"], "true");
    assert.equal(config["core.checkStat"], "default");
    assert.equal(config["core.ignoreStat"], "false");
    if (process.platform !== "win32") assert.equal(config["core.fileMode"], "true");
  }

  let nonTransientAttempts = 0;
  const nonTransient = await service.runGitReadOnlyCommand(["status"], "C:/repo", 500, async () => {
    nonTransientAttempts += 1;
    return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
  });
  assert.equal(nonTransient.exitCode, 128);
  assert.equal(nonTransientAttempts, 1, "Non-transient Git errors must never be retried.");
}

{
  const calls = [];
  const results = new Map([
    ["config\u0000--name-only\u0000--get-regexp\u0000^filter\\..*\\.(clean|process)$", { exitCode: 1, stdout: "", stderr: "" }],
    ["config\u0000--name-only\u0000--get-regexp\u0000^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$", { exitCode: 1, stdout: "", stderr: "" }],
    ["diff\u0000--name-only\u0000-z\u0000--no-renames\u0000--no-ext-diff\u0000--no-textconv\u0000--ignore-submodules=all", { exitCode: 0, stdout: "z.js\0a.js\0", stderr: "" }],
    ["diff\u0000--cached\u0000--name-only\u0000-z\u0000--no-renames\u0000--no-ext-diff\u0000--no-textconv\u0000--ignore-submodules=none", { exitCode: 0, stdout: "b.js\0a.js\0", stderr: "" }],
    ["ls-files\u0000--others\u0000--exclude-standard\u0000-z", { exitCode: 0, stdout: "untracked.txt\0", stderr: "" }],
    ["ls-files\u0000-v\u0000-z", { exitCode: 0, stdout: "H a.js\0H b.js\0", stderr: "" }],
    ["ls-files\u0000--stage\u0000-z", { exitCode: 0, stdout: `100644 ${"a".repeat(40)} 0\ta.js\0`, stderr: "" }],
    ["ls-files\u0000--others\u0000--ignored\u0000--exclude-standard\u0000-z", { exitCode: 0, stdout: "ignored.log\0", stderr: "" }],
  ]);
  const service = createGitEvidenceService({
    runCommand: async (command, args, cwd, timeoutMs, env) => {
      calls.push({ command, args, cwd, timeoutMs, env });
      return results.get(args.join("\u0000"));
    },
    buildValidationEnv: (extra) => ({ ...extra }),
    summarizeStderr: (value) => `summary:${value}`,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async () => { throw new Error("successful reads must not sleep"); },
  });
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), ["a.js", "b.js", "untracked.txt", "z.js"]);
  assert.equal(calls.length, 7);
  calls.length = 0;
  assert.deepEqual(await service.gitChangedFiles("C:/repo", { includeIgnored: true }), ["a.js", "b.js", "ignored.log", "untracked.txt", "z.js"]);
  assert.equal(calls.length, 8);
  assert.equal(calls.find((call) => call.args.includes("--ignored")).timeoutMs, 30_000);
  assert.equal(calls.filter((call) => call.timeoutMs === 15_000).length, 5);
  assert.equal(calls.every((call) => call.command === "git" && call.cwd === path.resolve("C:/repo") && call.env.GIT_OPTIONAL_LOCKS === "0"), true);
}

{
  const failures = new Map([
    ["config\u0000--name-only\u0000--get-regexp\u0000^filter\\..*\\.(clean|process)$", { exitCode: 1, stdout: "", stderr: "" }],
    ["config\u0000--name-only\u0000--get-regexp\u0000^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$", { exitCode: 1, stdout: "", stderr: "" }],
    ["diff\u0000--name-only\u0000-z\u0000--no-renames\u0000--no-ext-diff\u0000--no-textconv\u0000--ignore-submodules=all", { exitCode: 2, stdout: "", stderr: "working failed" }],
    ["diff\u0000--cached\u0000--name-only\u0000-z\u0000--no-renames\u0000--no-ext-diff\u0000--no-textconv\u0000--ignore-submodules=none", { exitCode: 3, stdout: "staged failed", stderr: "" }],
    ["ls-files\u0000--others\u0000--exclude-standard\u0000-z", { exitCode: 0, stdout: "", stderr: "" }],
    ["ls-files\u0000-v\u0000-z", { exitCode: 0, stdout: "", stderr: "" }],
    ["ls-files\u0000--stage\u0000-z", { exitCode: 0, stdout: "", stderr: "" }],
  ]);
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => failures.get(args.join("\u0000")),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value ? `bounded:${value}` : "",
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /Git changed-file inspection failed closed \(working tree: bounded:working failed; staged files: bounded:staged failed\)\./.test(error.message)
  );
}

{
  const diffOutputs = {
    unstaged: "forbidden/source.txt\0allowed/destination.txt\0",
    staged: "forbidden/staged.txt\0allowed/staged.txt\0",
  };
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => {
      if (args[0] === "diff") {
        assert.equal(args.includes("--no-renames"), true, "Both Git diff evidence commands must disable rename folding.");
        return { exitCode: 0, stdout: args.includes("--cached") ? diffOutputs.staged : diffOutputs.unstaged, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    lstat: async (target) => ({
      isDirectory: () => !String(target).endsWith(".txt"),
      isFile: () => String(target).endsWith(".txt"),
      isSymbolicLink: () => false,
    }),
    sleep: async () => {},
  });
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), [
    "allowed/destination.txt",
    "allowed/staged.txt",
    "forbidden/source.txt",
    "forbidden/staged.txt",
  ]);
}

{
  const baseOptions = {
    runCommand: async (_command, args) => ({ exitCode: 0, stdout: args[0] === "diff" && !args.includes("--cached") ? "submodule\0" : "", stderr: "" }),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async () => {},
  };
  const directoryService = createGitEvidenceService({
    ...baseOptions,
    lstat: async () => ({ isFile: () => false, isSymbolicLink: () => false }),
  });
  await assert.rejects(
    directoryService.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /path validation: unsupported or lossy path output/.test(error.message)
  );
  const unreadableService = createGitEvidenceService({
    ...baseOptions,
    lstat: async () => { throw Object.assign(new Error("secret filesystem detail"), { code: "EACCES" }); },
  });
  await assert.rejects(
    unreadableService.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && !error.message.includes("secret filesystem detail")
  );
  const deletedService = createGitEvidenceService({
    ...baseOptions,
    lstat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.deepEqual(await deletedService.gitChangedFiles("C:/repo"), ["submodule"], "A proven-missing deleted path remains valid evidence.");
}

{
  let indexOutput = "H safe.txt\0";
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => ({
      exitCode: 0,
      stdout: args[0] === "ls-files" && args.includes("-v") ? indexOutput : "",
      stderr: "",
    }),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async () => {},
  });
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), []);
  for (const unsupported of ["h assume.txt\0", "S sparse.txt\0", "s both.txt\0", "M conflicted.txt\0", "Z future.txt\0"]) {
    indexOutput = unsupported;
    await assert.rejects(
      service.gitChangedFiles("C:/repo"),
      (error) => error.errorType === "git_evidence_failed"
        && /unsupported tracked index flags: unsupported or lossy path output/.test(error.message)
    );
  }
  indexOutput = "H unterminated.txt";
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /tracked index flags: unsupported or lossy path output/.test(error.message)
  );
}

{
  let diffCalls = 0;
  let stage = `160000 ${"b".repeat(40)} 0\tsubmodule\0`;
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => {
      if (args[0] === "diff") diffCalls += 1;
      if (args[0] === "ls-files" && args.includes("-v")) return { exitCode: 0, stdout: "H submodule\0", stderr: "" };
      if (args[0] === "ls-files" && args.includes("--stage")) return { exitCode: 0, stdout: stage, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /unsupported submodule entry/.test(error.message)
  );
  assert.equal(diffCalls, 0, "Submodules must be rejected before worktree diff can invoke nested configuration.");
  stage = `100644 ${"c".repeat(40)} 2\tconflicted.txt\0`;
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /unsupported unmerged index entry/.test(error.message)
  );
  assert.equal(diffCalls, 0);
  stage = `040000 ${"d".repeat(40)} 0\tunsupported-tree\0`;
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /unsupported tracked index mode/.test(error.message)
  );
  assert.equal(diffCalls, 0);
  stage = `100644 ${"0".repeat(40)} 0\tintent-to-add.txt\0`;
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /unsupported intent-to-add index entry/.test(error.message)
  );
  assert.equal(diffCalls, 0);
}

{
  let lstatCalls = 0;
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => ({
      exitCode: 0,
      stdout: args[0] === "diff" && !args.includes("--cached") ? "a.txt\0b.txt\0c.txt\0" : "",
      stderr: "",
    }),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    maxEvidencePaths: 2,
    lstat: async () => {
      lstatCalls += 1;
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /path count limit: unsupported or lossy path output/.test(error.message)
  );
  assert.equal(lstatCalls, 0, "The evidence count limit must fail before scheduling path validation I/O.");
}

{
  let commandCalls = 0;
  const service = createGitEvidenceService({
    runCommand: async () => {
      commandCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    realpath: async () => { throw Object.assign(new Error("secret root detail"), { code: "EACCES" }); },
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
      && /working directory validation: unsupported or lossy path output/.test(error.message)
      && !error.message.includes("secret root detail")
  );
  assert.equal(commandCalls, 0, "An untrusted working directory must fail before Git is spawned.");
}

{
  const outputByCommand = new Map();
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => outputByCommand.get(args[0]) || { exitCode: 0, stdout: "", stderr: "" },
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    platform: "win32",
    sleep: async () => {},
  });
  const assertRejectedPath = async (stdout) => {
    outputByCommand.set("diff", { exitCode: 0, stdout, stderr: "" });
    await assert.rejects(
      service.gitChangedFiles("C:/repo"),
      (error) => error.errorType === "git_evidence_failed"
        && /Git changed-file inspection failed closed \(working tree: unsupported or lossy path output\)\./.test(error.message)
    );
  };
  await assertRejectedPath("unterminated.txt");
  await assertRejectedPath(" leading-space.txt\0");
  await assertRejectedPath("line\nbreak.txt\0");
  await assertRejectedPath("back\\slash.txt\0");
  await assertRejectedPath("glob*.txt\0");
  await assertRejectedPath("duplicate//separator.txt\0");
  await assertRejectedPath("../outside.txt\0");
  await assertRejectedPath("nested/../outside.txt\0");
  await assertRejectedPath("nested/./file.txt\0");
  await assertRejectedPath("/absolute.txt\0");
  await assertRejectedPath("C:/absolute.txt\0");
  await assertRejectedPath("C:drive-relative.txt\0");
  await assertRejectedPath(":(top)outside.txt\0");
  await assertRejectedPath(":/outside.txt\0");
  await assertRejectedPath("safe.txt:stream\0");
  await assertRejectedPath("NUL.txt\0");
  await assertRejectedPath("COM0\0");
  await assertRejectedPath("LPT0.log\0");
  await assertRejectedPath("COM\u00b9.txt\0");
  await assertRejectedPath("LPT\u00b3\0");
  await assertRejectedPath("CONIN$\0");
  await assertRejectedPath("CONOUT$.txt\0");
  await assertRejectedPath("trailing-dot.\0");
  await assertRejectedPath("invalid-\ufffd-name.txt\0");
  outputByCommand.set("diff", { exitCode: 0, stdout: "safe/üñîçødé.txt\0", stderr: "" });
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), ["safe/üñîçødé.txt"]);
}

{
  let output = ":(top)outside.txt\0";
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => ({
      exitCode: 0,
      stdout: args[0] === "diff" && !args.includes("--cached") ? output : "",
      stderr: "",
    }),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value,
    normalizeLockPath,
    hasAmbiguousPathPattern,
    isAbsolutePathLike,
    ...trustedRootOptions,
    platform: "linux",
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
  );
  output = "dir/a:b\0";
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), ["dir/a:b"], "POSIX internal colons remain literal filenames.");
}

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-git-evidence-"));
  assert.equal(path.dirname(tempRoot), path.resolve(tmpdir()), "The junction fixture must stay inside the OS temp directory.");
  const realRepo = path.join(tempRoot, "real-repo");
  const repo = path.join(tempRoot, "repo-link");
  const outside = path.join(tempRoot, "outside");
  const linkedParent = path.join(realRepo, "linked-parent");
  const safeFile = path.join(realRepo, "safe.txt");
  const sentinel = path.join(outside, "outside.txt");
  try {
    await mkdir(realRepo);
    await mkdir(outside);
    await writeFile(safeFile, "safe", "utf8");
    await writeFile(sentinel, "outside-safe", "utf8");
    await symlink(realRepo, repo, process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
    let evidence = "safe.txt\0";
    const service = createGitEvidenceService({
      runCommand: async (_command, args) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${repo}\n`, stderr: "" };
        return {
          exitCode: 0,
          stdout: args[0] === "diff" && !args.includes("--cached") ? evidence : "",
          stderr: "",
        };
      },
      buildValidationEnv: (extra) => extra,
      summarizeStderr: (value) => value,
      normalizeLockPath,
      hasAmbiguousPathPattern,
      isAbsolutePathLike,
      sleep: async () => {},
    });
    assert.deepEqual(await service.gitChangedFiles(repo), ["safe.txt"], "A canonicalized working-directory alias remains supported.");
    evidence = "linked-parent/outside.txt\0";
    await assert.rejects(
      service.gitChangedFiles(repo),
      (error) => error.errorType === "git_evidence_failed"
        && /path validation: unsupported or lossy path output/.test(error.message)
    );
    assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
  } finally {
    const linkedRelative = path.relative(tempRoot, linkedParent);
    assert.equal(linkedRelative.startsWith("..") || path.isAbsolute(linkedRelative), false, "Fixture cleanup target escaped its temp root.");
    await unlink(linkedParent).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await unlink(repo).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    assert.equal(await readFile(sentinel, "utf8"), "outside-safe");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-git-real-"));
  assert.equal(path.dirname(tempRoot), path.resolve(tmpdir()), "The real Git fixture must stay inside the OS temp directory.");
  const repo = path.join(tempRoot, "repo");
  const hooks = path.join(tempRoot, "empty-hooks");
  const git = async (...args) => {
    const result = await runProcess("git", args, repo, 30000, process.env);
    assert.equal(result.exitCode, 0, result.stderr || `git ${args.join(" ")} failed`);
    return result;
  };
  try {
    await mkdir(repo);
    await mkdir(hooks);
    await git("init", "--quiet");
    await git("config", "user.name", "V2 Git Evidence Test");
    await git("config", "user.email", "v2-git-evidence@example.invalid");
    await mkdir(path.join(repo, "forbidden"));
    await mkdir(path.join(repo, "allowed"));
    await mkdir(path.join(repo, "subdir"));
    await writeFile(path.join(repo, "forbidden", "source.txt"), "source", "utf8");
    await writeFile(path.join(repo, "forbidden", "staged.txt"), "staged", "utf8");
    await writeFile(path.join(repo, "tracked-assume.txt"), "assume", "utf8");
    await writeFile(path.join(repo, "tracked-skip.txt"), "skip", "utf8");
    await git("add", "--all");
    await git("-c", `core.hooksPath=${hooks}`, "commit", "--quiet", "-m", "fixture");

    await rename(path.join(repo, "forbidden", "source.txt"), path.join(repo, "allowed", "destination.txt"));
    await git("mv", "forbidden/staged.txt", "allowed/staged.txt");

    const service = createGitEvidenceService({
      runCommand: runProcess,
      buildValidationEnv: (extra) => ({ ...process.env, ...extra }),
      summarizeStderr: (value) => value,
      normalizeLockPath,
      hasAmbiguousPathPattern,
      isAbsolutePathLike,
      sleep: async () => {},
    });
    const changed = await service.gitChangedFiles(repo);
    assert.deepEqual(changed, [
      "allowed/destination.txt",
      "allowed/staged.txt",
      "forbidden/source.txt",
      "forbidden/staged.txt",
    ]);
    await assert.rejects(
      service.gitChangedFiles(path.join(repo, "subdir")),
      (error) => error.errorType === "git_evidence_failed"
        && /working directory is not Git top-level/.test(error.message)
    );

    await git("update-index", "--assume-unchanged", "tracked-assume.txt");
    await writeFile(path.join(repo, "tracked-assume.txt"), "hidden", "utf8");
    await assert.rejects(
      service.gitChangedFiles(repo),
      (error) => error.errorType === "git_evidence_failed"
        && /unsupported tracked index flags/.test(error.message)
    );
    await git("update-index", "--no-assume-unchanged", "tracked-assume.txt");

    await git("update-index", "--skip-worktree", "tracked-skip.txt");
    await writeFile(path.join(repo, "tracked-skip.txt"), "changed", "utf8");
    await assert.rejects(
      service.gitChangedFiles(repo),
      (error) => error.errorType === "git_evidence_failed"
        && /unsupported tracked index flags/.test(error.message)
    );
    await git("update-index", "--no-skip-worktree", "tracked-skip.txt");

    await git("config", "filter.untrusted.clean", "untrusted-filter-must-not-run");
    await assert.rejects(
      service.gitChangedFiles(repo),
      (error) => error.errorType === "git_evidence_failed"
        && /repository content filter configuration/.test(error.message)
    );
    await git("config", "--unset-all", "filter.untrusted.clean");
    await git("config", "remote.origin.promisor", "true");
    await assert.rejects(
      service.gitChangedFiles(repo),
      (error) => error.errorType === "git_evidence_failed"
        && /partial clone or promisor configuration/.test(error.message)
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-git-submodule-"));
  assert.equal(path.dirname(tempRoot), path.resolve(tmpdir()), "The submodule fixture must stay inside the OS temp directory.");
  const parent = path.join(tempRoot, "parent");
  const child = path.join(tempRoot, "child");
  const sentinel = path.join(tempRoot, "filter-ran.txt");
  const filterScript = path.join(tempRoot, "filter.cjs");
  const git = async (cwd, ...args) => {
    const result = await runProcess("git", args, cwd, 30000, process.env);
    assert.equal(result.exitCode, 0, result.stderr || `git ${args.join(" ")} failed`);
    return result;
  };
  try {
    await mkdir(parent);
    await mkdir(child);
    await git(child, "init", "--quiet");
    await git(child, "config", "user.name", "V2 Submodule Test");
    await git(child, "config", "user.email", "v2-submodule@example.invalid");
    await writeFile(path.join(child, ".gitattributes"), "*.txt filter=untrusted\n", "utf8");
    await writeFile(path.join(child, "data.txt"), "initial", "utf8");
    await git(child, "add", "--all");
    await git(child, "commit", "--quiet", "-m", "child");

    await git(parent, "init", "--quiet");
    await git(parent, "config", "user.name", "V2 Parent Test");
    await git(parent, "config", "user.email", "v2-parent@example.invalid");
    await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "nested");
    await writeFile(
      filterScript,
      `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(sentinel)}, "ran");\nprocess.stdin.pipe(process.stdout);\n`,
      "utf8"
    );
    const nested = path.join(parent, "nested");
    await git(nested, "config", "filter.untrusted.clean", `node "${filterScript}"`);
    await writeFile(path.join(nested, "data.txt"), "changed", "utf8");

    const service = createGitEvidenceService({
      runCommand: runProcess,
      buildValidationEnv: (extra) => ({ ...process.env, ...extra }),
      summarizeStderr: (value) => value,
      normalizeLockPath,
      hasAmbiguousPathPattern,
      isAbsolutePathLike,
      sleep: async () => {},
    });
    await assert.rejects(
      service.gitChangedFiles(parent),
      (error) => error.errorType === "git_evidence_failed"
        && /unsupported submodule entry/.test(error.message)
    );
    await assert.rejects(
      readFile(sentinel),
      (error) => error?.code === "ENOENT"
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

console.log("V2 Git evidence tests passed.");
