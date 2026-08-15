export function createGitEvidenceService({
  runCommand,
  buildValidationEnv,
  summarizeStderr,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  function transientGitIndexReadError(result) {
    return /(?:\.git[\\/]index|index file open failed|index\.lock).*(?:permission denied|used by another process|file exists)/i
      .test([result?.stderr, result?.stdout].filter(Boolean).join("\n"));
  }

  async function runGitReadOnlyCommand(args, cwd, timeoutMs = 1000 * 15, commandRunner = runCommand) {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await commandRunner(
        "git",
        args,
        cwd,
        timeoutMs,
        buildValidationEnv({ GIT_OPTIONAL_LOCKS: "0" })
      );
      if (result.exitCode === 0 || !transientGitIndexReadError(result) || attempt === 3) return result;
      await sleep(25 * (2 ** attempt));
    }
    return result;
  }

  async function gitChangedFiles(cwd, { includeIgnored = false } = {}) {
    const commands = [
      runGitReadOnlyCommand(["diff", "--name-only"], cwd, 1000 * 15),
      runGitReadOnlyCommand(["diff", "--cached", "--name-only"], cwd, 1000 * 15),
      runGitReadOnlyCommand(["ls-files", "--others", "--exclude-standard"], cwd, 1000 * 15),
    ];
    if (includeIgnored) {
      commands.push(runGitReadOnlyCommand(["ls-files", "--others", "--ignored", "--exclude-standard"], cwd, 1000 * 30));
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
      throw new Error(`Git changed-file inspection failed closed (${details}).`);
    }

    return [
      ...new Set(
        [workingTreeDiff.stdout, stagedDiff.stdout, untracked.stdout, ignored?.stdout || ""]
          .join("\n")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      ),
    ].sort();
  }

  return {
    runGitReadOnlyCommand,
    gitChangedFiles,
  };
}
