#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { auditHasFailures, auditStateDirectory } from "./state-audit.js";
import { loadMcpEntry, validateCandidateReleaseEntry } from "./fresh-healthcheck.js";
import { inventory as gcInventory } from "./bridge-gc.js";
import { isMainModule } from "./main-module.js";
import { opencodeDatabaseHealth, readOpsLog, summarizeIncidents } from "./ops-log.js";

const execFileAsync = promisify(execFile);
const SERVER_NAME = "opencode";
const SYNC_HINT = "run npm run release:activate -- --sync-clients";
// G-01: a quarantined integration blocks every writer of its repository until someone resolves
// it; one older than this fails the doctor and names the runbook.
const DEFAULT_QUARANTINE_MAX_AGE_MINUTES = 30;
const QUARANTINE_RUNBOOK = `${path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "docs", "USER_GUIDE.md")}#a-quarantine-that-does-not-clear`;

function quarantineFindings(state, maxAgeMinutes, now = Date.now()) {
  const failures = [];
  const warnings = [];
  for (const database of state.databases || []) {
    for (const item of database.quarantinedIntegrationOperations || []) {
      const ageMinutes = Math.max(0, Math.floor((now - Date.parse(item.updatedAt || "")) / 60_000)) || 0;
      const message = `Integration operation ${item.id}${item.cwd ? ` in ${item.cwd}` : ""} has been quarantined for ${ageMinutes} min (reason ${item.reason || "unknown"}); every writer of that repository is blocked. Resolve it with resolve_integration_quarantine; runbook: ${QUARANTINE_RUNBOOK}`;
      if (ageMinutes >= maxAgeMinutes) failures.push({ check: "integration-quarantine", message });
      else warnings.push(message);
    }
  }
  return { failures, warnings };
}

function defaultClaudeConfigPath(env = process.env) {
  const configDir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return configDir ? path.join(configDir, ".claude.json") : path.join(homedir(), ".claude.json");
}

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    claudeConfigPath: defaultClaudeConfigPath(),
    cwd: process.cwd(),
    json: false,
    quarantineMaxAgeMinutes: DEFAULT_QUARANTINE_MAX_AGE_MINUTES,
  };
  const valued = { "--config": "configPath", "--cwd": "cwd", "--claude-config": "claudeConfigPath" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--quarantine-max-age-min") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--quarantine-max-age-min requires a whole number of minutes (0 or more).");
      options.quarantineMaxAgeMinutes = value;
      index += 1;
    } else if (valued[argument]) {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires an absolute path.`);
      options[valued[argument]] = value;
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/daily-doctor.js [--config <absolute-config.toml>] [--claude-config <absolute .claude.json>] [--cwd <absolute-git-repository>] [--quarantine-max-age-min 30] [--json]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!path.isAbsolute(options.configPath) || !path.isAbsolute(options.cwd) || !path.isAbsolute(options.claudeConfigPath)) {
    throw new Error("--config, --claude-config and --cwd must be absolute paths.");
  }
  return options;
}

async function gitSnapshot(cwd) {
  try {
    const [{ stdout: root }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true }),
      execFileAsync("git", ["status", "--short"], { cwd, windowsHide: true }),
    ]);
    return {
      ok: true,
      root: root.trim(),
      clean: !status.trim(),
      changedEntries: status.trim() ? status.trim().split(/\r?\n/).length : 0,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      root: "",
      clean: false,
      changedEntries: 0,
      error: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function short(hash) {
  return hash ? `${String(hash).slice(0, 12)}...` : "(none)";
}

function errorMessage(error) {
  return String(error?.message || error).split(/\r?\n/)[0];
}

function comparable(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// The pins the running bridge verifies only at startup: server.js and, when the entry names
// one, the plugin manifest. Each mismatch is its own failure line.
async function integrityPinFailures(entry) {
  const failures = [];
  const serverPath = String(entry.args[0] || "").trim();
  const pinnedServer = String(entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 || "").trim().toLowerCase();
  try {
    const actual = await sha256File(serverPath);
    if (actual !== pinnedServer) {
      failures.push({ check: "server-pin", message: `CODEX_OPENCODE_EXPECTED_SERVER_SHA256 is ${short(pinnedServer)} but ${serverPath} hashes to ${short(actual)}; ${SYNC_HINT} after reviewing the change.` });
    }
  } catch (error) {
    failures.push({ check: "server-pin", message: `Cannot hash ${serverPath || "(no server.js in args)"}: ${errorMessage(error)}` });
  }
  const manifestPath = String(entry.env.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH || "").trim();
  const pinnedManifest = String(entry.env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 || "").trim().toLowerCase();
  const externalPlugins = String(entry.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS || "").trim().toLowerCase() === "true";
  if (manifestPath) {
    try {
      const actual = await sha256File(manifestPath);
      if (!pinnedManifest && externalPlugins) {
        failures.push({ check: "plugin-manifest-pin", message: `External plugins are enabled but CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 is empty (${manifestPath} hashes to ${short(actual)}).` });
      } else if (pinnedManifest && actual !== pinnedManifest) {
        failures.push({ check: "plugin-manifest-pin", message: `CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 is ${short(pinnedManifest)} but ${manifestPath} hashes to ${short(actual)}; ${SYNC_HINT}.` });
      }
    } catch (error) {
      failures.push({ check: "plugin-manifest-pin", message: `Cannot hash ${manifestPath}: ${errorMessage(error)}` });
    }
  } else if (externalPlugins) {
    failures.push({ check: "plugin-manifest-pin", message: "External plugins are enabled but CODEX_OPENCODE_PLUGIN_MANIFEST_PATH is empty." });
  }
  return failures;
}

// Claude Code runs the same bridge from its own user-scope entry in ~/.claude.json. The
// entries must agree on command, args and every env value, or the two clients run
// different code (or one fails its pin check at startup). Env values are not printed:
// only the names that differ, and short hashes for the integrity pins.
async function claudeEntryComparison(entry, claudeConfigPath) {
  let text;
  try {
    text = await readFile(claudeConfigPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { failures: [], warnings: [`${claudeConfigPath} does not exist; the Claude Code entry was not checked.`] };
    return { failures: [{ check: "claude-entry", message: `Cannot read ${claudeConfigPath}: ${errorMessage(error)}` }], warnings: [] };
  }
  let claudeEntry;
  try {
    claudeEntry = JSON.parse(text)?.mcpServers?.[SERVER_NAME];
  } catch (error) {
    return { failures: [{ check: "claude-entry", message: `${claudeConfigPath} is not valid JSON: ${errorMessage(error)}` }], warnings: [] };
  }
  if (!claudeEntry || typeof claudeEntry !== "object") {
    return { failures: [], warnings: [`${claudeConfigPath} has no user-scope "${SERVER_NAME}" entry; Claude Code does not use this bridge.`] };
  }
  const failures = [];
  const mismatch = (message) => failures.push({ check: "claude-entry", message: `Claude Code ${message}; ${SYNC_HINT}.` });
  if (comparable(claudeEntry.command) !== comparable(entry.command)) mismatch(`command ${claudeEntry.command || "(none)"} differs from Codex ${entry.command}`);
  if (!isDeepStrictEqual(Array.isArray(claudeEntry.args) ? claudeEntry.args : [], entry.args)) {
    mismatch(`args ${JSON.stringify(claudeEntry.args || [])} differ from Codex ${JSON.stringify(entry.args)}`);
  }
  const claudeEnv = claudeEntry.env && typeof claudeEntry.env === "object" ? claudeEntry.env : {};
  for (const key of [...new Set([...Object.keys(entry.env), ...Object.keys(claudeEnv)])].sort()) {
    const codexValue = entry.env[key];
    const claudeValue = claudeEnv[key];
    if (codexValue === claudeValue) continue;
    if (/_SHA256$/.test(key)) mismatch(`${key} is ${short(claudeValue)} while Codex pins ${short(codexValue)}`);
    else if (claudeValue === undefined) mismatch(`env lacks ${key}, which the Codex entry sets`);
    else if (codexValue === undefined) mismatch(`env sets ${key}, which the Codex entry does not`);
    else mismatch(`env ${key} differs from the Codex entry`);
  }
  return { failures, warnings: [] };
}

async function runDailyDoctor({ configPath, cwd, claudeConfigPath = defaultClaudeConfigPath(), stateDir: stateDirOverride = "", quarantineMaxAgeMinutes = DEFAULT_QUARANTINE_MAX_AGE_MINUTES, skipClaudeCode = false }) {
  const startedAt = Date.now();
  const failures = [];
  const warnings = [];
  const git = await gitSnapshot(cwd);
  let entry = null;
  try {
    entry = await loadMcpEntry(configPath);
  } catch (error) {
    failures.push({ check: "config", message: `Cannot read the ${SERVER_NAME} entry from ${configPath}: ${errorMessage(error)}` });
  }
  let release = { integrityMode: "unverified", releaseRoot: "" };
  if (entry) {
    const pinFailures = await integrityPinFailures(entry);
    failures.push(...pinFailures);
    // The structural release checks run once the pins are known to match, so one stale pin
    // is reported once, as itself.
    if (!pinFailures.length) {
      try {
        release = await validateCandidateReleaseEntry(entry);
      } catch (error) {
        failures.push({ check: "release", message: errorMessage(error) });
      }
    }
    const claude = skipClaudeCode ? { failures: [], warnings: ["Claude Code comparison skipped by setup."] } : await claudeEntryComparison(entry, claudeConfigPath);
    failures.push(...claude.failures);
    warnings.push(...claude.warnings);
  }
  const stateDir = path.resolve(String(stateDirOverride || entry?.env.CODEX_OPENCODE_STATE_DIR || path.join(homedir(), ".codex", "codex-opencode-mcp")));
  const state = await auditStateDirectory(stateDir);
  const stateHealthy = !auditHasFailures(state, true);
  const quarantines = quarantineFindings(state, quarantineMaxAgeMinutes);
  failures.push(...quarantines.failures);
  warnings.push(...quarantines.warnings);
  const housekeeping = await gcInventory(stateDir, { apply: false, includeRetained: false, olderThanDays: 7, pruneDatabases: true, deleteBranches: false });
  if (String(entry?.env.CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE || "").trim().toLowerCase() === "true") {
    warnings.push("CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=true: OpenCode 1.17.13 emits no runtime provider/model identity, so every real agent run ends with opencode_model_evidence_required. Set it to false and use per-job modelRequirement.requireRuntimeEvidence when exact identity matters.");
  }
  if (entry && String(entry.env.CODEX_OPENCODE_SOURCE_DIRT_POLICY || "strict").trim().toLowerCase() === "strict") {
    warnings.push("CODEX_OPENCODE_SOURCE_DIRT_POLICY is strict: any uncommitted change in a target repository blocks writer worktrees. unrelated_ok tolerates changes outside the job scope.");
  }
  if (housekeeping.summary.removableWorktrees || housekeeping.summary.removableDatabases || housekeeping.summary.staleRegistryRows) {
    warnings.push(`Housekeeping: ${housekeeping.summary.removableWorktrees} orphan/stale worktree(s), ${housekeeping.summary.removableDatabases} dead project database(s), ${housekeeping.summary.staleRegistryRows} stale registry row(s) can be removed with npm run gc:apply.`);
  }
  // OpenCode's own database runs every worker; grown too large it failed every run (2026-09-30).
  for (const warning of opencodeDatabaseHealth(entry?.env || process.env).warnings) warnings.push(warning);
  // Recurring problems from the operations log (bin/ops-log.js), last 7 days.
  const recurringIncidents = summarizeIncidents(readOpsLog(stateDir, { days: 7 }).lines).filter((group) => group.recurring);
  if (recurringIncidents.length) {
    warnings.push(`Operations log: ${recurringIncidents.length} recurring problem(s) in the last 7 days (${recurringIncidents.slice(0, 3).map((group) => `${group.event}${group.errorType ? ` [${group.errorType}]` : ""} ${group.count}x`).join("; ")}). Run npm run incidents for details and draft log.md rows.`);
  }
  const retainedForReview = housekeeping.worktrees.filter((item) => item.classification === "retained_for_review").length;
  if (retainedForReview) {
    warnings.push(`${retainedForReview} worktree(s) are retained for review; integrate or abandon them, or run npm run gc -- --include-retained --older-than <days> --apply.`);
  }
  return {
    ok: git.ok && stateHealthy && failures.length === 0,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    configPath: path.resolve(configPath),
    claudeConfigPath: path.resolve(claudeConfigPath),
    cwd: path.resolve(cwd),
    bridge: {
      serverPath: entry?.args[0] || "",
      integrityMode: release.integrityMode,
      releaseRoot: release.releaseRoot,
    },
    failures,
    git,
    state: state.summary,
    housekeeping: housekeeping.summary,
    warnings,
    next: "Use get_opencode_bridge_status for agent discovery and a live profile smoke only when provider readiness must be proven.",
  };
}

function formatReport(report) {
  return [
    `Bridge daily doctor: ${report.ok ? "healthy" : "attention required"}.`,
    `Duration: ${report.durationMs} ms`,
    `Integrity: ${report.bridge.integrityMode}`,
    `Server: ${report.bridge.serverPath}`,
    `Git: ${report.git.ok ? (report.git.clean ? "clean" : `dirty (${report.git.changedEntries} entries)`) : "unavailable"}`,
    `State: databases=${report.state.databases}, integrityFailures=${report.state.integrityFailures}, foreignKeys=${report.state.foreignKeyViolations}, expiredJobs=${report.state.expiredActiveJobs}, expiredPipelines=${report.state.expiredActivePipelines}, unresolvedIntegrations=${report.state.unresolvedIntegrationOperations ?? 0}, leaselessActiveJobs=${report.state.activeJobsWithoutLease ?? 0}`,
    `Housekeeping: worktrees=${report.housekeeping.worktrees}, removableNow=${report.housekeeping.removableWorktrees}, deadDatabases=${report.housekeeping.removableDatabases}, staleRegistryRows=${report.housekeeping.staleRegistryRows}`,
    ...report.failures.map((failure) => `Failure [${failure.check}]: ${failure.message}`),
    ...report.warnings.map((warning) => `Warning: ${warning}`),
    report.next,
  ].join("\n") + "\n";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runDailyDoctor(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Bridge daily doctor failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

export { claudeEntryComparison, formatReport, gitSnapshot, integrityPinFailures, parseArguments, quarantineFindings, runDailyDoctor };
