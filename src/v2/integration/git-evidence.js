import { lstat as lstatFs, realpath as realpathFs } from "node:fs/promises";
import path from "node:path";

export function createGitEvidenceService({
  runCommand,
  buildValidationEnv,
  summarizeStderr,
  normalizeLockPath,
  hasAmbiguousPathPattern,
  isAbsolutePathLike,
  platform = process.platform,
  maxEvidencePaths = 25000,
  lstat = lstatFs,
  realpath = realpathFs,
  resolvePath = path.resolve,
  getCwd = () => process.cwd(),
  resolveGitTopLevel = null,
  nullGitConfigPath = platform === "win32" ? "NUL" : "/dev/null",
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  function transientGitIndexReadError(result) {
    return /(?:\.git[\\/]index|index file open failed|index\.lock).*(?:permission denied|used by another process|file exists)/i
      .test([result?.stderr, result?.stdout].filter(Boolean).join("\n"));
  }

  async function runGitReadOnlyCommand(args, cwd, timeoutMs = 1000 * 15, commandRunner = runCommand) {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const env = buildValidationEnv({
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_CONFIG_GLOBAL: nullGitConfigPath,
        GIT_CONFIG_SYSTEM: nullGitConfigPath,
        GIT_ATTR_NOSYSTEM: "1",
      });
      const configOverrides = [
        ["core.fsmonitor", "false"],
        ["core.untrackedCache", "false"],
        ["core.trustctime", "true"],
        ["core.checkStat", "default"],
        ["core.ignoreStat", "false"],
        ...(platform === "win32" ? [] : [["core.fileMode", "true"]]),
      ];
      let configIndex = Number.parseInt(String(env.GIT_CONFIG_COUNT || "0"), 10);
      if (!Number.isSafeInteger(configIndex) || configIndex < 0) configIndex = 0;
      for (const [key, value] of configOverrides) {
        env[`GIT_CONFIG_KEY_${configIndex}`] = key;
        env[`GIT_CONFIG_VALUE_${configIndex}`] = value;
        configIndex += 1;
      }
      env.GIT_CONFIG_COUNT = String(configIndex);
      result = await commandRunner(
        "git",
        args,
        cwd,
        timeoutMs,
        env
      );
      if (result.exitCode === 0 || !transientGitIndexReadError(result) || attempt === 3) return result;
      await sleep(25 * (2 ** attempt));
    }
    return result;
  }

  function gitPathOutputError(label) {
    const error = new Error(`Git changed-file inspection failed closed (${label}: unsupported or lossy path output).`);
    error.errorType = "git_evidence_failed";
    return error;
  }

  function parseGitPathOutput(output, label) {
    const text = String(output || "");
    if (!text) return [];
    if (!text.endsWith("\0")) throw gitPathOutputError(label);
    const paths = text.slice(0, -1).split("\0");
    for (const file of paths) {
      const segments = file.split("/");
      if (!file
        || /[\x00-\x1f\x7f]/.test(file)
        || file.includes("\ufffd")
        || file.startsWith(":")
        || normalizeLockPath(file) !== file
        || hasAmbiguousPathPattern([file])
        || isAbsolutePathLike(file)
        || /^[A-Za-z]:/.test(file)
        || segments.some((segment) => segment === "." || segment === "..")
        || (platform === "win32" && segments.some((segment) =>
          segment.includes(":")
          || /[. ]$/.test(segment)
          || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(segment)))) {
        throw gitPathOutputError(label);
      }
    }
    return paths;
  }

  function parseGitTopLevelOutput(output) {
    const text = String(output || "");
    const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : "";
    if (!value || /[\x00-\x1f\x7f]/.test(value)) {
      throw gitPathOutputError("working directory validation");
    }
    return value;
  }

  function assertSupportedGitIndexFlags(output) {
    const text = String(output || "");
    if (!text) return;
    if (!text.endsWith("\0")) throw gitPathOutputError("tracked index flags");
    for (const record of text.slice(0, -1).split("\0")) {
      if (record.length < 3 || record[1] !== " ") {
        throw gitPathOutputError("tracked index flags");
      }
      const tag = record[0];
      parseGitPathOutput(`${record.slice(2)}\0`, "tracked index flags");
      if (tag !== "H") {
        throw gitPathOutputError("unsupported tracked index flags");
      }
    }
  }

  function assertSupportedGitIndexModes(output) {
    const text = String(output || "");
    if (!text) return;
    if (!text.endsWith("\0")) throw gitPathOutputError("tracked index modes");
    for (const record of text.slice(0, -1).split("\0")) {
      const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/i.exec(record);
      if (!match) throw gitPathOutputError("tracked index modes");
      parseGitPathOutput(`${match[4]}\0`, "tracked index modes");
      if (match[1] === "160000") throw gitPathOutputError("unsupported submodule entry");
      if (!["100644", "100755", "120000"].includes(match[1])) throw gitPathOutputError("unsupported tracked index mode");
      if (/^0+$/.test(match[2])) throw gitPathOutputError("unsupported intent-to-add index entry");
      if (match[3] !== "0") throw gitPathOutputError("unsupported unmerged index entry");
    }
  }

  function isCanonicalPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === ""
      || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  async function validateGitRoot(cwd) {
    const lexicalRoot = resolvePath(cwd || getCwd());
    try {
      const canonicalRoot = await realpath(lexicalRoot);
      let reportedRoot;
      if (typeof resolveGitTopLevel === "function") {
        reportedRoot = await resolveGitTopLevel(lexicalRoot);
      } else {
        const result = await runGitReadOnlyCommand(["rev-parse", "--show-toplevel"], lexicalRoot, 1000 * 15);
        if (result.exitCode !== 0) throw gitPathOutputError("working directory validation");
        reportedRoot = parseGitTopLevelOutput(result.stdout);
      }
      const canonicalGitRoot = await realpath(resolvePath(reportedRoot));
      if (path.relative(canonicalRoot, canonicalGitRoot) !== "") {
        throw gitPathOutputError("working directory is not Git top-level");
      }
      return { lexicalRoot: canonicalGitRoot, canonicalRoot: canonicalGitRoot };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw gitPathOutputError("working directory validation");
    }
  }

  async function validateGitPathType(root, file) {
    const segments = file.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const parent = resolvePath(root.lexicalRoot, ...segments.slice(0, index + 1));
      try {
        const details = await lstat(parent);
        if (details.isSymbolicLink() || !details.isDirectory()) {
          throw gitPathOutputError("path validation");
        }
        if (!isCanonicalPathInside(root.canonicalRoot, await realpath(parent))) {
          throw gitPathOutputError("path validation");
        }
      } catch (error) {
        if (error?.errorType === "git_evidence_failed") throw error;
        if (error?.code === "ENOENT") return;
        throw gitPathOutputError("path validation");
      }
    }

    const absolutePath = resolvePath(root.lexicalRoot, file);
    try {
      const details = await lstat(absolutePath);
      if (!details.isFile() && !details.isSymbolicLink()) {
        throw gitPathOutputError("path validation");
      }
      if (details.isFile() && !isCanonicalPathInside(root.canonicalRoot, await realpath(absolutePath))) {
        throw gitPathOutputError("path validation");
      }
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      if (error?.code === "ENOENT") return;
      throw gitPathOutputError("path validation");
    }
  }

  async function gitChangedFiles(cwd, { includeIgnored = false } = {}) {
    const root = await validateGitRoot(cwd);
    const [filterConfig, promisorConfig] = await Promise.all([
      runGitReadOnlyCommand(
        ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
        root.lexicalRoot,
        1000 * 15
      ),
      runGitReadOnlyCommand(
        ["config", "--name-only", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"],
        root.lexicalRoot,
        1000 * 15
      ),
    ]);
    if ((filterConfig.exitCode === 0 && String(filterConfig.stdout || "").trim())
      || ![0, 1].includes(filterConfig.exitCode)) {
      throw gitPathOutputError("repository content filter configuration");
    }
    if ((promisorConfig.exitCode === 0 && String(promisorConfig.stdout || "").trim())
      || ![0, 1].includes(promisorConfig.exitCode)) {
      throw gitPathOutputError("partial clone or promisor configuration");
    }
    const [indexFlags, indexModes] = await Promise.all([
      runGitReadOnlyCommand(["ls-files", "-v", "-z"], root.lexicalRoot, 1000 * 30),
      runGitReadOnlyCommand(["ls-files", "--stage", "-z"], root.lexicalRoot, 1000 * 30),
    ]);
    if (indexFlags.exitCode !== 0 || indexModes.exitCode !== 0) {
      throw gitPathOutputError("tracked index inspection");
    }
    assertSupportedGitIndexFlags(indexFlags.stdout);
    assertSupportedGitIndexModes(indexModes.stdout);
    const commands = [
      runGitReadOnlyCommand(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"], root.lexicalRoot, 1000 * 15),
      runGitReadOnlyCommand(["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"], root.lexicalRoot, 1000 * 15),
      runGitReadOnlyCommand(["ls-files", "--others", "--exclude-standard", "-z"], root.lexicalRoot, 1000 * 15),
    ];
    if (includeIgnored) {
      commands.push(runGitReadOnlyCommand(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root.lexicalRoot, 1000 * 30));
    }
    const [workingTreeDiff, stagedDiff, untracked, ignored] = await Promise.all(commands);
    const failedChecks = [
      ["working tree", workingTreeDiff],
      ["staged files", stagedDiff],
      ["untracked files", untracked],
      ...(ignored ? [["ignored files", ignored]] : []),
    ].filter(([, result]) => result.exitCode !== 0);
    if (failedChecks.length) {
      const details = failedChecks
        .map(([label, result]) => `${label}: ${summarizeStderr(result.stderr || result.stdout) || `exit ${result.exitCode}`}`)
        .join("; ");
      const error = new Error(`Git changed-file inspection failed closed (${details}).`);
      error.errorType = "git_evidence_failed";
      throw error;
    }

    const changedFiles = [
      ...new Set(
        [
          ...parseGitPathOutput(workingTreeDiff.stdout, "working tree"),
          ...parseGitPathOutput(stagedDiff.stdout, "staged files"),
          ...parseGitPathOutput(untracked.stdout, "untracked files"),
          ...parseGitPathOutput(ignored?.stdout || "", "ignored files"),
        ]
      ),
    ].sort();
    if (changedFiles.length > maxEvidencePaths) {
      throw gitPathOutputError("path count limit");
    }
    for (const file of changedFiles) {
      await validateGitPathType(root, file);
    }
    return changedFiles;
  }

  return {
    runGitReadOnlyCommand,
    gitChangedFiles,
  };
}
