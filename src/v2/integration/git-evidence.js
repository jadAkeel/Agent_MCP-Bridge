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

  function parseGitIndexEntries(output) {
    const text = String(output || "");
    if (!text) return new Map();
    if (!text.endsWith("\0")) throw gitPathOutputError("tracked index entries");
    const entries = new Map();
    for (const record of text.slice(0, -1).split("\0")) {
      const match = /^([A-Za-z?]) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/i.exec(record);
      if (!match) throw gitPathOutputError("tracked index entries");
      const [, tag, mode, oid, stage, file] = match;
      parseGitPathOutput(`${file}\0`, "tracked index entries");
      if (tag !== "H") {
        throw gitPathOutputError("unsupported tracked index flags");
      }
      if (mode === "160000") throw gitPathOutputError("unsupported submodule entry");
      if (!["100644", "100755", "120000"].includes(mode)) throw gitPathOutputError("unsupported tracked index mode");
      if (/^0+$/.test(oid)) throw gitPathOutputError("unsupported intent-to-add index entry");
      if (stage !== "0") throw gitPathOutputError("unsupported unmerged index entry");
      if (entries.has(file)) throw gitPathOutputError("duplicate tracked index entries");
      entries.set(file, { tag, mode, oid: oid.toLowerCase(), stage });
    }
    return entries;
  }

  function indexEntriesIdentity(entries) {
    return [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, entry]) => `${file}\0${entry.tag}\0${entry.mode}\0${entry.oid}\0${entry.stage}`)
      .join("\0");
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

  async function inspectGitRepositoryPolicy(root, { includeSymlinkConfig = false } = {}) {
    const [filterConfig, promisorConfig, symlinkConfig] = await Promise.all([
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
      includeSymlinkConfig
        ? runGitReadOnlyCommand(["config", "--bool", "core.symlinks"], root.lexicalRoot, 1000 * 15)
        : null,
    ]);
    if ((filterConfig.exitCode === 0 && String(filterConfig.stdout || "").trim())
      || ![0, 1].includes(filterConfig.exitCode)) {
      throw gitPathOutputError("repository content filter configuration");
    }
    if ((promisorConfig.exitCode === 0 && String(promisorConfig.stdout || "").trim())
      || ![0, 1].includes(promisorConfig.exitCode)) {
      throw gitPathOutputError("partial clone or promisor configuration");
    }
    if (symlinkConfig && ![0, 1].includes(symlinkConfig.exitCode)) {
      throw gitPathOutputError("core.symlinks configuration");
    }
    const symlinkValue = String(symlinkConfig?.stdout || "").trim().toLowerCase();
    if (symlinkConfig?.exitCode === 0 && !["true", "false"].includes(symlinkValue)) {
      throw gitPathOutputError("core.symlinks configuration");
    }
    return { coreSymlinks: symlinkConfig?.exitCode === 0 ? symlinkValue === "true" : true };
  }

  async function readGitIndexEntries(root) {
    const result = await runGitReadOnlyCommand(
      ["ls-files", "-v", "--stage", "-z"],
      root.lexicalRoot,
      1000 * 30
    );
    if (result.exitCode !== 0) {
      throw gitPathOutputError("tracked index inspection");
    }
    return parseGitIndexEntries(result.stdout);
  }

  async function readGitPathInventory(root, { includeDiffs, includeIgnored }) {
    const commands = [
      ...(includeDiffs ? [
        ["working tree", ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"], 1000 * 15],
        ["staged files", ["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"], 1000 * 15],
      ] : []),
      ["untracked files", ["ls-files", "--others", "--exclude-standard", "-z"], 1000 * 15],
      ...(includeIgnored ? [["ignored files", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], 1000 * 30]] : []),
    ];
    const results = await Promise.all(commands.map(async ([label, args, timeoutMs]) => [
      label,
      await runGitReadOnlyCommand(args, root.lexicalRoot, timeoutMs),
    ]));
    const failedChecks = results.filter(([, result]) => result.exitCode !== 0);
    if (failedChecks.length) {
      const details = failedChecks
        .map(([label, result]) => `${label}: ${summarizeStderr(result.stderr || result.stdout) || `exit ${result.exitCode}`}`)
        .join("; ");
      const error = new Error(`Git changed-file inspection failed closed (${details}).`);
      error.errorType = "git_evidence_failed";
      throw error;
    }
    const paths = new Map();
    for (const [label, result] of results) {
      paths.set(label, parseGitPathOutput(result.stdout, label));
    }
    return paths;
  }

  async function validateGitPaths(root, files) {
    for (const file of files) await validateGitPathType(root, file);
  }

  async function gitWorkspaceInventory(cwd, { includeIgnored = true } = {}) {
    const root = await validateGitRoot(cwd);
    const policy = await inspectGitRepositoryPolicy(root, { includeSymlinkConfig: true });
    const indexEntries = await readGitIndexEntries(root);
    const paths = await readGitPathInventory(root, { includeDiffs: false, includeIgnored });
    const indexIdentity = indexEntriesIdentity(indexEntries);
    const untrackedFiles = paths.get("untracked files") || [];
    const ignoredCandidates = paths.get("ignored files") || [];
    const reportedFiles = [...new Set([...untrackedFiles, ...ignoredCandidates])].sort();
    if (reportedFiles.length > maxEvidencePaths) throw gitPathOutputError("path count limit");
    const trackedFiles = [...indexEntries.keys()];
    const ordinaryFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
    const ordinarySet = new Set(ordinaryFiles);
    const ignoredFiles = [...new Set(ignoredCandidates.filter((file) => !ordinarySet.has(file)))].sort();
    await validateGitPaths(root, [...new Set([...ordinaryFiles, ...ignoredFiles])].sort());
    return {
      root: root.canonicalRoot,
      coreSymlinks: policy.coreSymlinks,
      indexEntries,
      indexIdentity,
      trackedFiles,
      ordinaryFiles,
      ignoredFiles,
    };
  }

  async function gitChangedFiles(cwd, { includeIgnored = false } = {}) {
    const root = await validateGitRoot(cwd);
    await inspectGitRepositoryPolicy(root);
    const beforeIndex = await readGitIndexEntries(root);
    const paths = await readGitPathInventory(root, { includeDiffs: true, includeIgnored });
    const afterIndex = await readGitIndexEntries(root);
    if (indexEntriesIdentity(beforeIndex) !== indexEntriesIdentity(afterIndex)) {
      throw gitPathOutputError("tracked index changed during inspection");
    }

    const changedFiles = [
      ...new Set(
        [
          ...(paths.get("working tree") || []),
          ...(paths.get("staged files") || []),
          ...(paths.get("untracked files") || []),
          ...(paths.get("ignored files") || []),
        ]
      ),
    ].sort();
    if (changedFiles.length > maxEvidencePaths) {
      throw gitPathOutputError("path count limit");
    }
    await validateGitPaths(root, changedFiles);
    return changedFiles;
  }

  return {
    runGitReadOnlyCommand,
    gitChangedFiles,
    gitWorkspaceInventory,
  };
}
