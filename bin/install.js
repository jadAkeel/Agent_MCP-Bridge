#!/usr/bin/env node
// Fresh-checkout bootstrap: built-ins only before lockfile dependencies are ready.
import { spawnSync } from "node:child_process";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";
import { createInterface } from "node:readline/promises";
import { chooseInstallArguments } from "./install-choices.js";
import { resolveNpmCli } from "./npm-cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function runInstall(argv, dependencies = {}) {
  let readline;
  const ask = dependencies.ask || (question => {
    readline ||= createInterface({ input: process.stdin, output: process.stdout });
    return readline.question(question);
  });
  try { return await install(argv, { ...dependencies, ask, hasAsk: Boolean(dependencies.ask) }); }
  finally { readline?.close(); }
}

async function install(argv, dependencies) {
  const log = dependencies.log || console.log;
  const { parseArguments, preflight, runSetup } = await import("./setup.js");
  const explicitInteractive = argv.includes("--interactive");
  if (explicitInteractive && argv.includes("--yes")) throw new Error("--interactive and --yes are alternatives; choose prompts or explicit noninteractive flags.");
  let selected = argv.filter(arg => arg !== "--interactive");
  let options = parseArguments([...selected, "--skills"]);
  if (options.help) {
    log("Usage: node bin/install.js [--interactive | --yes] [--dry-run] [--client auto|codex|claude|both|cursor|all|<client-list>] [--workers opencode,codex,pi] [--pi-safety deny|unsandboxed-worktree] [--delegates opencode,codex,pi|none] [--standalone-delegates all|<keys>|none] [--host-home <home>] [--claude-home <config-dir>] [--cursor-home <dir>] [--cursor-config <file>] [--codex-home <dir>] [--claude-config <file>] [--runtime-dir <dir>] [--state-dir <dir>] [--profile pure|gemini]. List skills: node bin/skill-package.js --list");
    return 0;
  }
  const platform = dependencies.platform || process.platform;
  const osRelease = dependencies.osRelease || release();
  if (!["win32", "linux", "darwin"].includes(platform) || platform === "win32" && (!/^10\.0\.(\d+)/.test(osRelease) || Number(osRelease.split(".")[2]) < 22000)) {
    throw new Error("The public installer targets Windows 11, Linux and macOS; this operating system is unsupported.");
  }
  const terminal = dependencies.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const interactive = explicitInteractive || terminal && !options.yes && !options.dryRun;
  if (interactive) {
    if (!terminal && !dependencies.hasAsk) throw new Error("Interactive installation needs a terminal; use --yes with explicit selection flags for unattended setup.");
    selected = await chooseInstallArguments(selected, { ask: dependencies.ask, log });
    options = parseArguments([...selected, "--skills"]);
  }
  const { verifySkillPackage } = await import("./skill-package.js");
  await verifySkillPackage();
  // Dry-run probes versions, not credentials. This is the one preflight used by apply too.
  const probeOptions = { ...options, dryRun: true };
  const checked = preflight(probeOptions, { ...dependencies, env: dependencies.env || process.env, log });
  if (!checked.ok) return 1;
  log(`Installation plan: lockfile dependencies in ${ROOT}; canonical MCP entry ${options.configPath}; runtime ${options.runtimeDir}; state/manifest ${options.stateDir}; selected ${options.client} host skills under ${options.hostHome} / ${options.claudeHome}; delegates ${options.delegates.join(", ") || "none"}. No global CLI upgrade or provider task.`);
  log(`Orchestrator(s): ${options.client}; worker selections: ${options.workers.join(", ")}; Cursor config: ${checked.clients.cursor ? options.cursorConfigPath : "not selected"}. Pi safety: ${options.piSafety}. Models/auth are not configured by installation.`);
  if (options.standaloneDelegates.length) log(`Independent upstream skills selected: ${options.standaloneDelegates.join(", ")}. Files only; no CLI installation/auth, fleet changes or background-MCP bootstrap. These are not protected bridge runners.`);
  const { installedDependencyMismatches } = await import("./release-gate.js");
  const needsDependencies = (await (dependencies.dependencyMismatches || installedDependencyMismatches)()).length > 0;
  if (needsDependencies) log("Dependencies: npm ci --ignore-scripts --no-audit --no-fund (pinned package-lock.json).");
  if (options.dryRun) {
    if (needsDependencies) { log("Dry-run: dependency installation is pending; exact runtime/config diffs require installed dependencies. No files changed."); return 0; }
    return runSetup(options, { ...dependencies, checked });
  }
  if (!options.yes) {
    // Exact config/runtime/skill diffs are approved by runSetup below. Dependency bootstrap
    // needs explicit approval before it can import any third-party library for that preview.
    if (needsDependencies) {
      if (!interactive) { log("Approval required for the displayed dependency bootstrap: rerun with --yes or use the interactive installer. No client configuration changed."); return 2; }
      if (!/^y(?:es)?$/i.test((await dependencies.ask("Install the displayed pinned dependencies and apply the selected installation? [y/N]: ")).trim())) return 2;
      options.yes = true;
    } else if (!interactive && !terminal && !dependencies.confirm) {
      log("Noninteractive installation requires --yes or --dry-run; no client configuration changed.");
      return 2;
    }
  }
  if (needsDependencies) {
    const npm = resolveNpmCli({ env: dependencies.env || process.env });
    if (!npm && !dependencies.installDependencies) throw new Error("Could not find npm-cli.js in this Node/npm installation; install the Node/npm prerequisite first.");
    const result = (dependencies.installDependencies || (() => spawnSync(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })))();
    if (result.error || result.status !== 0) throw new Error(`Dependency bootstrap failed (exit ${result.status ?? "unknown"}); client configurations were not changed. ${String(result.stderr || "").slice(-1000)}`);
  }
  // Auth checks are deliberately deferred: they can refresh credentials. User signs in normally.
  log("Sign-in status: unknown (not read); use the normal client/provider sign-in before separately authorized inference.");
  return runSetup(options, { ...dependencies,
    ...(interactive && !dependencies.confirm ? { confirm: async () => /^y(?:es)?$/i.test((await dependencies.ask("Apply the displayed installation changes? [y/N]: ")).trim()) } : {}),
    checked: { ...checked, needsAuth: true } });
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = await runInstall(process.argv.slice(2)); }
  catch (error) { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; }
}
