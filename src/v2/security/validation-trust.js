import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

export function createValidationTrust({
  config,
  buildValidationEnv,
  runCommand,
  sha256File,
  nowMs,
  redactSensitiveText,
  truncateText,
  platform = process.platform,
  getCurrentWorkingDirectory = () => process.cwd(),
  lstatPath = lstat,
  realpathPath = realpathSync,
}) {
  function parseCommandLine(commandLine) {
    const input = String(commandLine || "").trim();
    const parts = [];
    let current = "";
    let quote = "";

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const next = input[index + 1] || "";

      if (char === "\\") {
        const canEscape = quote
          ? next === quote || next === "\\"
          : Boolean(next) && (/\s/.test(next) || next === "'" || next === '"' || next === "\\");
        if (canEscape) {
          current += next;
          index += 1;
        } else {
          current += char;
        }
        continue;
      }

      if (quote) {
        if (char === quote) {
          quote = "";
        } else {
          current += char;
        }
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current) {
          parts.push(current);
          current = "";
        }
        continue;
      }

      current += char;
    }

    if (quote) {
      throw new Error("Validation command has an unterminated quoted string.");
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }

  function safeValidationPathspec(value) {
    const raw = String(value || "");
    return Boolean(raw)
      && !path.isAbsolute(raw)
      && !/^[A-Za-z]:/.test(raw)
      && !raw.replace(/\\/g, "/").split("/").includes("..")
      && !/[\x00-\x1F\x7F]/.test(raw);
  }

  function strictProjectGitArgsError(args) {
    const subcommand = String(args[0] || "").toLowerCase();
    const rest = args.slice(1).map(String);
    if (subcommand === "--version") return rest.length ? "git --version accepts no additional project-policy arguments." : "";
    if (subcommand === "status") {
      const allowed = new Set(["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]);
      return rest.every((item) => allowed.has(item)) ? "" : "Project-policy git status accepts only bounded porcelain/status flags and no path arguments.";
    }
    if (subcommand === "diff") {
      const allowedOptions = new Set(["--check", "--cached", "--staged", "--no-ext-diff", "--no-textconv", "--ignore-submodules"]);
      let afterSeparator = false;
      let separatorCount = 0;
      let sawCheck = false;
      for (const item of rest) {
        if (item === "--") { afterSeparator = true; separatorCount += 1; continue; }
        if (!afterSeparator && item.startsWith("-")) {
          if (!allowedOptions.has(item)) return `Project-policy git diff option is forbidden: ${item}`;
          if (item === "--check") sawCheck = true;
          continue;
        }
        if (!afterSeparator) return `Project-policy git diff revisions/operands are forbidden before --: ${item}`;
        if (!safeValidationPathspec(item)) return `Project-policy git diff pathspec is unsafe: ${item}`;
      }
      if (separatorCount > 1) return "Project-policy git diff accepts at most one -- pathspec separator.";
      return sawCheck ? "" : "Project-policy git diff must use --check.";
    }
    if (subcommand === "rev-parse") {
      const allowedVectors = [
        ["--show-toplevel"],
        ["--is-inside-work-tree"],
        ["--verify", "HEAD"],
        ["HEAD"],
      ];
      return allowedVectors.some((vector) => JSON.stringify(vector) === JSON.stringify(rest))
        ? ""
        : "Project-policy git rev-parse arguments are not an approved fixed vector.";
    }
    if (subcommand === "ls-files") {
      const separator = rest.indexOf("--");
      const options = separator === -1 ? rest : rest.slice(0, separator);
      const pathspecs = separator === -1 ? [] : rest.slice(separator + 1);
      const allowed = new Set(["--cached", "--others", "--exclude-standard", "--error-unmatch"]);
      return options.every((item) => allowed.has(item)) && pathspecs.every(safeValidationPathspec)
        ? ""
        : "Project-policy git ls-files arguments are not bounded to safe flags and repo-relative pathspecs.";
    }
    return `Git validation subcommand is not allowed: ${subcommand || "missing"}`;
  }

  function validationCommandTrustError(parsed, { strictProjectPolicy = false } = {}) {
    if (!parsed.length) {
      return "";
    }
    const executable = path.basename(parsed[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
    const allowed = new Set(config.validationExecutableAllowlist.map((item) => path.basename(item).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "")));
    if (!allowed.has(executable)) {
      return `Validation executable is not operator-allowlisted: ${parsed[0]}`;
    }
    if (["cmd", "powershell", "pwsh", "bash", "sh", "wsl", "npx"].includes(executable)) {
      return `Shell, interpreter, and package-executor validation commands are forbidden: ${parsed[0]}`;
    }
    if (["node", "python", "python3", "bun", "deno"].includes(executable)
      && parsed.some((argument) => ["-e", "-c", "--eval", "--print"].includes(String(argument).toLowerCase()))) {
      return `Inline evaluation is forbidden in validation commands: ${parsed[0]}`;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(executable)
      && parsed.some((argument) => ["exec", "x", "dlx"].includes(String(argument).toLowerCase()))) {
      return `Package-executor validation subcommands are forbidden: ${parsed.join(" ")}`;
    }
    if (strictProjectPolicy && executable !== "git") {
      return "Untrusted project policy may execute only a hash-pinned Git read/check vector. Package scripts and repository interpreters require an external sandbox.";
    }
    if (executable === "git") {
      const subcommand = String(parsed[1] || "").toLowerCase();
      if (!["--version", "diff", "status", "rev-parse", "ls-files"].includes(subcommand)) {
        return `Git validation subcommand is not allowed: ${subcommand || "missing"}`;
      }
      if (parsed.slice(1).some((argument) => /^-c(?:$|=)/i.test(String(argument))
        || /^--(?:config-env|exec-path|upload-pack|receive-pack|ext-diff|textconv)(?:$|=)/i.test(String(argument)))) {
        return "Git validation arguments may not select aliases, helpers, alternate executables, or external diff programs.";
      }
      return strictProjectGitArgsError(parsed.slice(1));
    }
    return "";
  }

  function validationPathValue(env = buildValidationEnv()) {
    return String(env.PATH || env.Path || env.path || "");
  }

  async function resolveValidationExecutable(command) {
    const raw = String(command || "").trim();
    if (!raw || (!path.isAbsolute(raw) && /[\\/]/.test(raw))) {
      throw new Error("Validation executable must be an operator-allowlisted name or an absolute path; relative paths are forbidden.");
    }
    const candidates = [];
    if (path.isAbsolute(raw)) {
      candidates.push(path.resolve(raw));
    } else {
      const extensions = platform === "win32"
        ? (path.extname(raw) ? [""] : String(buildValidationEnv().PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))
        : [""];
      for (const entry of validationPathValue().split(path.delimiter).filter(Boolean)) {
        if (!path.isAbsolute(entry)) continue;
        for (const extension of extensions) candidates.push(path.join(entry, `${raw}${extension}`));
      }
    }
    for (const candidate of candidates) {
      try {
        const details = await lstatPath(candidate);
        if (details.isSymbolicLink() || !details.isFile()) continue;
        const canonicalPath = realpathPath(candidate);
        return {
          path: canonicalPath,
          sha256: await sha256File(canonicalPath),
        };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Validation executable could not be resolved through the trusted process PATH: ${raw}`);
  }

  async function prepareValidationCommand(command, { requirePinnedExecutable = false, operatorExecutableHashes = config.validationExecutableSha256Allowlist } = {}) {
    let parsed;
    try {
      parsed = Array.isArray(command) ? command.map(String) : parseCommandLine(command);
    } catch (error) {
      return { ok: false, errorType: "validation_command_parse_error", error: error.message || String(error) };
    }
    if (!parsed.length) return { ok: false, errorType: "validation_command_parse_error", error: "Validation command is empty." };
    const lexicalError = validationCommandTrustError(parsed, { strictProjectPolicy: requirePinnedExecutable });
    if (lexicalError) return { ok: false, errorType: "validation_command_untrusted", error: lexicalError };
    try {
      const executable = await resolveValidationExecutable(parsed[0]);
      const allowedPaths = [];
      for (const allowlisted of config.validationExecutableAllowlist) {
        try {
          allowedPaths.push((await resolveValidationExecutable(allowlisted)).path);
        } catch {
          // A stale allowlist entry grants nothing.
        }
      }
      const comparePath = (value) => platform === "win32" ? value.toLowerCase() : value;
      if (!allowedPaths.some((value) => comparePath(value) === comparePath(executable.path))) {
        return { ok: false, errorType: "validation_command_untrusted", error: `Validation executable is not operator-allowlisted: ${parsed[0]}` };
      }
      const pinnedHashes = [...new Set((operatorExecutableHashes || []).map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-f0-9]{64}$/.test(item)))];
      if (requirePinnedExecutable && !pinnedHashes.includes(executable.sha256)) {
        return { ok: false, errorType: "validation_command_untrusted", error: "Project-policy validation requires the exact executable SHA-256 in CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST." };
      }
      let args = parsed.slice(1);
      const executableName = path.basename(executable.path).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
      if (executableName === "git" && args[0] === "diff") {
        args = ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1).filter((item) => !["--no-ext-diff", "--no-textconv"].includes(item))];
      }
      const commandSha256 = createHash("sha256").update(JSON.stringify([executable.path, ...args])).digest("hex");
      return {
        ok: true,
        displayCommand: Array.isArray(command) ? parsed.join(" ") : String(command).trim(),
        executablePath: executable.path,
        executableSha256: executable.sha256,
        args,
        commandSha256,
      };
    } catch (error) {
      return { ok: false, errorType: "validation_command_untrusted", error: error.message || String(error) };
    }
  }

  async function runValidationGate({ command, cwd, dryRun = false, timeoutMs = config.validationCommandTimeoutMs, trustedSpec = null, signal = null }) {
    const validationCommand = String(command || "").trim();
    if (!validationCommand) {
      return {
        status: "skipped",
        command: "",
        exitCode: "not_run",
        durationMs: 0,
        stdout: "",
        stderr: "",
        errorType: null,
      };
    }

    if (dryRun) {
      return {
        status: "skipped_dry_run",
        command: validationCommand,
        exitCode: "not_run",
        durationMs: 0,
        stdout: "",
        stderr: "",
        errorType: null,
      };
    }

    const prepared = await prepareValidationCommand(validationCommand, {
      requirePinnedExecutable: Boolean(trustedSpec),
      operatorExecutableHashes: config.validationExecutableSha256Allowlist,
    });
    if (!prepared.ok) {
      return {
        status: "failed",
        command: validationCommand,
        exitCode: prepared.errorType === "validation_command_parse_error" ? "parse_error" : "not_authorized",
        durationMs: 0,
        stdout: "",
        stderr: prepared.error,
        errorType: prepared.errorType,
      };
    }
    if (trustedSpec) {
      const same = trustedSpec.displayCommand === prepared.displayCommand
        && trustedSpec.executablePath === prepared.executablePath
        && trustedSpec.executableSha256 === prepared.executableSha256
        && trustedSpec.commandSha256 === prepared.commandSha256
        && JSON.stringify(trustedSpec.args) === JSON.stringify(prepared.args);
      if (!same) {
        return {
          status: "failed",
          command: validationCommand,
          exitCode: "not_authorized",
          durationMs: 0,
          stdout: "",
          stderr: "The operator-pinned validation executable or exact argument vector changed after policy approval.",
          errorType: "validation_command_untrusted",
        };
      }
    }

    if (!prepared.executablePath) {
      return {
        status: "failed",
        command: validationCommand,
        exitCode: "not_authorized",
        durationMs: 0,
        stdout: "",
        stderr: "Validation executable resolution failed closed.",
        errorType: "validation_command_untrusted",
      };
    }

    const started = nowMs();
    let result = await runCommand(prepared.executablePath, prepared.args, cwd || getCurrentWorkingDirectory(), timeoutMs, buildValidationEnv(), { signal });
    const executable = path.basename(prepared.executablePath).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
    const isUnstagedDiffCheck = executable === "git"
      && prepared.args[0] === "diff"
      && prepared.args.slice(1).includes("--check")
      && !prepared.args.slice(1).some((argument) => argument === "--cached" || argument === "--staged");
    if (result.exitCode === 0 && isUnstagedDiffCheck) {
      const remainingTimeoutMs = Math.max(1, timeoutMs - (nowMs() - started));
      const stagedResult = await runCommand(prepared.executablePath, [
        "diff",
        "--cached",
        ...prepared.args.slice(1),
      ], cwd || getCurrentWorkingDirectory(), remainingTimeoutMs, buildValidationEnv(), { signal });
      result = {
        exitCode: stagedResult.exitCode,
        stdout: [result.stdout, stagedResult.stdout].filter(Boolean).join("\n"),
        stderr: [result.stderr, stagedResult.stderr].filter(Boolean).join("\n"),
      };
    }
    return {
      status: result.exitCode === 0 ? "passed" : "failed",
      command: validationCommand,
      exitCode: result.exitCode,
      durationMs: nowMs() - started,
      stdout: truncateText(redactSensitiveText(result.stdout || ""), 6000),
      stderr: truncateText(redactSensitiveText(result.stderr || ""), 6000),
      errorType: result.exitCode === 0 ? null : "validation_command_failed",
    };
  }

  return {
    parseCommandLine,
    safeValidationPathspec,
    strictProjectGitArgsError,
    validationCommandTrustError,
    validationPathValue,
    resolveValidationExecutable,
    prepareValidationCommand,
    runValidationGate,
  };
}
