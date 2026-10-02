// Validation command parsing and bounded argument checks.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, lstat, realpath, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { redactSensitiveText } from "./redaction.js";

export function parseCommandLine(commandLine) {
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

function windowsCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }

  const normalized = String(command || "").toLowerCase();
  if (["npm", "npx", "pnpm", "yarn"].includes(normalized)) {
    return `${command}.cmd`;
  }

  return command;
}

function safeValidationPathspec(value) {
  const raw = String(value || "");
  return Boolean(raw)
    && !path.isAbsolute(raw)
    && !/^[A-Za-z]:/.test(raw)
    && !raw.replace(/\\/g, "/").split("/").includes("..")
    && !/[\x00-\x1F\x7F]/.test(raw);
}

export function strictProjectGitArgsError(args) {
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

export function formatValidationGateResult(validationGate) {
  if (!validationGate || validationGate.status === "skipped") {
    return "Validation gate: skipped";
  }

  return [
    `Validation gate: ${validationGate.status}`,
    `Validation command: ${validationGate.command || "not specified"}`,
    `Validation exit code: ${validationGate.exitCode}`,
    `Validation duration ms: ${validationGate.durationMs || 0}`,
    validationGate.stdout ? `Validation stdout:\n${validationGate.stdout}` : null,
    validationGate.stderr ? `Validation stderr:\n${validationGate.stderr}` : null,
  ].filter(Boolean).join("\n");
}

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createValidationRuntime({
  CONFIG,
  buildValidationEnv,
  sha256File,
  runCommand,
  runSpawnCommand,
  integrationTimed,
  nowMs,
  truncateText,
}) {
function validationCommandTrustError(parsed, { strictProjectPolicy = false } = {}) {
  if (!parsed.length) {
    return "";
  }
  const executable = path.basename(parsed[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
  const allowed = new Set(CONFIG.validationExecutableAllowlist.map((item) => path.basename(item).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "")));
  if (!allowed.has(executable)) {
    return `Validation executable is not operator-allowlisted: ${parsed[0]}`;
  }
  if (["cmd", "powershell", "pwsh", "bash", "sh", "wsl", "npx", "pnpx", "bunx"].includes(executable)) {
    return `Shell, interpreter, and package-executor validation commands are forbidden: ${parsed[0]}`;
  }
  // Interpreter options that run inline code or preload modules: -e/-p/-c and bundles such as
  // -pe or -Ic, -r (node --require), and the long forms. Python stops reading interpreter
  // options at "-m <module>", so the module's own arguments (pytest -p ...) are not checked.
  const interpreterCodeOption = /^-(?:[a-z]*[ecpr][a-z]*|-(?:eval|print|import|require|loader|experimental-loader|experimental-default-type|env-file|inspect[a-z-]*))(?:=|$)/i;
  if (["node", "python", "python3", "py", "bun", "deno"].includes(executable)) {
    const pythonLike = ["python", "python3", "py"].includes(executable);
    for (const argument of parsed.slice(1).map(String)) {
      if (pythonLike && argument === "-m") break;
      if (interpreterCodeOption.test(argument)) {
        return `Inline evaluation and module preloading are forbidden in validation commands: ${parsed[0]} ${argument}`;
      }
    }
    if (executable === "deno" && ["eval", "repl"].includes(String(parsed.find((argument, index) => index > 0 && !String(argument).startsWith("-")) || "").toLowerCase())) {
      return `Inline evaluation is forbidden in validation commands: ${parsed.join(" ")}`;
    }
  }
  // Package managers: only the subcommand position selects an executor. Any other argument
  // equal to "x" or "exec" ("pnpm test --filter x") used to be rejected. When options come
  // before the subcommand their values cannot be told apart from it, so every bare word up
  // to "--" is checked then.
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const executorSubcommands = new Set(["exec", "x", "dlx", "create", "init", "explore", "node"]);
    const rest = parsed.slice(1).map(String);
    const separator = rest.indexOf("--");
    const beforeSeparator = separator === -1 ? rest : rest.slice(0, separator);
    const subcommandIndex = beforeSeparator.findIndex((argument) => !argument.startsWith("-"));
    const candidates = subcommandIndex <= 0
      ? beforeSeparator.slice(subcommandIndex === -1 ? 0 : subcommandIndex, subcommandIndex === -1 ? 0 : subcommandIndex + 1)
      : beforeSeparator.filter((argument) => !argument.startsWith("-"));
    const executor = candidates.find((argument) => executorSubcommands.has(argument.toLowerCase()));
    if (executor) {
      return `Package-executor validation subcommands are forbidden: ${parsed.join(" ")}`;
    }
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

// Node refuses to spawn .cmd/.bat files without a shell on Windows (EINVAL), and the
// validation gate never uses a shell. Package managers ship as batch shims that only
// forward to a JavaScript entry, so resolve that entry and run it with node directly.
// Only plain top-level SET assignments are honoured; conditional overrides (such as
// npm's global-prefix lookup) are ignored, so the bundled entry next to the shim runs.
async function resolveWindowsNodeShim(shimPath) {
  const shimDirectory = path.dirname(shimPath);
  const text = await readFile(shimPath, "utf8");
  const lines = text.split(/\r?\n/);
  const variables = new Map();
  for (const line of lines) {
    const match = /^SET "([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"\s*$/i.exec(line);
    if (match && !variables.has(match[1].toUpperCase())) variables.set(match[1].toUpperCase(), match[2]);
  }
  const expand = (value) => value
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => (variables.has(name.toUpperCase()) ? variables.get(name.toUpperCase()) : whole))
    .replace(/%~dp0|%dp0%/gi, () => `${shimDirectory}${path.sep}`);
  const forwardingLine = lines.find((line) => /%\*\s*$/.test(line));
  if (!forwardingLine) throw new Error(`Windows shim has no argument-forwarding line: ${shimPath}`);
  const tokens = [...expand(forwardingLine).matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] || match[2]);
  const script = tokens.find((token) => /\.(?:c|m)?js$/i.test(token));
  if (!script) throw new Error(`Windows shim does not forward to a JavaScript entry: ${shimPath}`);
  const scriptPath = path.resolve(script);
  const details = await lstat(scriptPath);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Windows shim entry is not a regular file: ${scriptPath}`);
  const canonicalScript = realpathSync(scriptPath);
  const canonicalDirectory = realpathSync(shimDirectory);
  const relative = path.relative(canonicalDirectory.toLowerCase(), canonicalScript.toLowerCase());
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Windows shim entry escapes the shim directory: ${canonicalScript}`);
  }
  const bundledNode = path.join(shimDirectory, "node.exe");
  const nodePath = existsSync(bundledNode) ? realpathSync(bundledNode) : process.execPath;
  return {
    nodePath,
    nodeSha256: await sha256File(nodePath),
    scriptPath: canonicalScript,
    scriptSha256: await sha256File(canonicalScript),
  };
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
    const extensions = process.platform === "win32"
      ? (path.extname(raw) ? [""] : String(buildValidationEnv().PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))
      : [""];
    for (const entry of validationPathValue().split(path.delimiter).filter(Boolean)) {
      if (!path.isAbsolute(entry)) continue;
      for (const extension of extensions) candidates.push(path.join(entry, `${raw}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      // Package managers install binaries as symlinks (/usr/bin/python3, Homebrew, nvm):
      // resolve the link and require the target to be a regular file. The allowlist and hash
      // checks compare this canonical target.
      const details = await lstat(candidate);
      const canonicalPath = details.isSymbolicLink() ? await realpath(candidate) : candidate;
      const targetDetails = details.isSymbolicLink() ? await stat(canonicalPath) : details;
      if (!targetDetails.isFile()) continue;
      const resolvedPath = realpathSync(canonicalPath);
      return {
        path: resolvedPath,
        sha256: await sha256File(resolvedPath),
      };
    } catch (error) {
      // A PATH entry that is a file (ENOTDIR), unreadable (EACCES/EPERM) or a dangling link
      // is skipped like a missing one instead of failing every validation command.
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error?.code)) throw error;
    }
  }
  throw new Error(`Validation executable could not be resolved through the trusted process PATH: ${raw}`);
}

async function prepareValidationCommand(command, { requirePinnedExecutable = false, operatorExecutableHashes = CONFIG.validationExecutableSha256Allowlist } = {}) {
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
    for (const allowlisted of CONFIG.validationExecutableAllowlist) {
      try {
        allowedPaths.push((await resolveValidationExecutable(allowlisted)).path);
      } catch {
        // A stale allowlist entry grants nothing.
      }
    }
    const comparePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
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
    let launchPath = executable.path;
    let launchSha256 = executable.sha256;
    let shimEvidence = null;
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable.path)) {
      const shim = await resolveWindowsNodeShim(executable.path);
      launchPath = shim.nodePath;
      launchSha256 = shim.nodeSha256;
      args = [shim.scriptPath, ...args];
      shimEvidence = { shimPath: executable.path, shimSha256: executable.sha256, scriptSha256: shim.scriptSha256 };
    }
    const commandSha256 = createHash("sha256").update(JSON.stringify([launchPath, ...args, shimEvidence])).digest("hex");
    return {
      ok: true,
      displayCommand: Array.isArray(command) ? parsed.join(" ") : String(command).trim(),
      executablePath: launchPath,
      executableSha256: launchSha256,
      args,
      commandSha256,
      ...(shimEvidence ? { windowsShim: shimEvidence } : {}),
    };
  } catch (error) {
    return { ok: false, errorType: "validation_command_untrusted", error: error.message || String(error) };
  }
}

// A validation command that can never run must fail before an agent spends model
// time on the job. The post-run gate still re-verifies the command at execution time.
const VALIDATION_PREFLIGHT_FIX = "Use a validation command whose executable is listed in CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST, with plain arguments (no shell, npx, package executors, or inline evaluation).";

async function validationCommandPreflightError(validationCommand, { dryRun = false, sanitized = false } = {}) {
  const command = String(validationCommand || "").trim();
  if (!command || dryRun || sanitized) return null;
  const prepared = await prepareValidationCommand(command);
  return prepared.ok ? null : { errorType: prepared.errorType, error: prepared.error, command };
}

// A validation command other than bridge Git (npm test, pytest, node scripts) runs under the
// process-tree supervisor: a timeout, a cancellation or the bridge's death ends the whole tree,
// not only the direct child, so no leftover test process keeps writing the checkout after the
// bridge rolled it back and released its lock. Bridge Git (git diff --check) spawns nothing that
// outlives it and stays on the plain runner, which is much cheaper per call.
async function runValidationProcess(executablePath, args, cwd, timeoutMs, env, { signal = null } = {}) {
  const executable = path.basename(executablePath).toLowerCase().replace(/.(exe|cmd|bat|ps1)$/i, "");
  if (executable === "git") return runCommand(executablePath, args, cwd, timeoutMs, env, { signal });
  const supervised = await runSpawnCommand(executablePath, args, cwd, timeoutMs, env, { signal });
  return {
    stdout: supervised.stdout || "",
    stderr: supervised.stderr || "",
    exitCode: supervised.timedOut ? "timeout" : supervised.exitCode,
    // The supervisor could not confirm the tree is gone: something may still write the checkout.
    processTreeUnconfirmed: supervised.terminationErrorType === "process_tree_termination_unconfirmed"
      || supervised.terminationErrorType === "process_supervisor_watchdog_expired",
    terminationErrorType: supervised.terminationErrorType || "",
    // B-113: the PIDs a write job's lock quarantine records as containment evidence.
    supervisorProcessId: Number(supervised.supervisorProcessId || 0),
    payloadProcessId: Number(supervised.payloadProcessId || 0),
  };
}

function runValidationGate(...args) {
  return integrationTimed("validation", () => runValidationGateUntimed(...args));
}

async function runValidationGateUntimed({ command, cwd, dryRun = false, timeoutMs = CONFIG.validationCommandTimeoutMs, trustedSpec = null, signal = null }) {
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
    operatorExecutableHashes: CONFIG.validationExecutableSha256Allowlist,
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
  const executable = path.basename(prepared.executablePath).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
  // Bridge Git now carries the operator's core.autocrlf (see USER_LINE_ENDING_GIT_CONFIG), so
  // with autocrlf=true/input the diff never shows a CR. A repository that sets
  // core.autocrlf=false locally (this one does) still gets CRLF files from agents on Windows,
  // and `git diff --check` would report every such line as trailing whitespace, failing an
  // otherwise clean job. Treat CR at end of line as allowed unless the repository's own
  // core.whitespace says otherwise; real trailing blanks, space-before-tab and conflict
  // markers are still caught.
  let whitespaceConfig = [];
  if (executable === "git" && prepared.args[0] === "diff" && prepared.args.includes("--check")) {
    const configured = await runCommand(prepared.executablePath, ["config", "--get", "core.whitespace"], cwd || process.cwd(), 1000 * 15, buildValidationEnv(), { signal });
    const existing = configured.exitCode === 0 ? String(configured.stdout || "").trim() : "";
    if (!/(^|,)\s*-?cr-at-eol\s*(,|$)/i.test(existing)) {
      whitespaceConfig = ["-c", `core.whitespace=${existing ? `${existing},` : ""}cr-at-eol`];
    }
  }
  let result = await runValidationProcess(prepared.executablePath, [...whitespaceConfig, ...prepared.args], cwd || process.cwd(), timeoutMs, buildValidationEnv(), { signal });
  const isUnstagedDiffCheck = executable === "git"
    && prepared.args[0] === "diff"
    && prepared.args.slice(1).includes("--check")
    && !prepared.args.slice(1).some((argument) => argument === "--cached" || argument === "--staged");
  if (result.exitCode === 0 && isUnstagedDiffCheck) {
    const remainingTimeoutMs = Math.max(1, timeoutMs - (nowMs() - started));
    const stagedResult = await runValidationProcess(prepared.executablePath, [
      ...whitespaceConfig,
      "diff",
      "--cached",
      ...prepared.args.slice(1),
    ], cwd || process.cwd(), remainingTimeoutMs, buildValidationEnv(), { signal });
    result = {
      exitCode: stagedResult.exitCode,
      processTreeUnconfirmed: Boolean(result.processTreeUnconfirmed || stagedResult.processTreeUnconfirmed),
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
    errorType: result.processTreeUnconfirmed
      ? "validation_process_tree_unconfirmed"
      : result.exitCode === 0 ? null : "validation_command_failed",
    ...(result.processTreeUnconfirmed ? { processTreeUnconfirmed: true, supervisorProcessId: Number(result.supervisorProcessId || 0), payloadProcessId: Number(result.payloadProcessId || 0) } : {}),
  };
}

  return { validationCommandTrustError, validationPathValue, resolveWindowsNodeShim, resolveValidationExecutable, prepareValidationCommand, VALIDATION_PREFLIGHT_FIX, validationCommandPreflightError, runValidationProcess, runValidationGate };
}
