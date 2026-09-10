#!/usr/bin/env node

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { auditHasFailures, auditStateDirectory } from "./state-audit.js";
import { loadMcpEntry, validateCandidateReleaseEntry } from "./fresh-healthcheck.js";

const execFileAsync = promisify(execFile);

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    cwd: process.cwd(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" || argument === "--cwd") {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires an absolute path.`);
      options[argument === "--config" ? "configPath" : "cwd"] = value;
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/daily-doctor.js [--config <absolute-config.toml>] [--cwd <absolute-git-repository>] [--json]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!path.isAbsolute(options.configPath) || !path.isAbsolute(options.cwd)) {
    throw new Error("--config and --cwd must be absolute paths.");
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

async function runDailyDoctor({ configPath, cwd }) {
  const startedAt = Date.now();
  const entry = await loadMcpEntry(configPath);
  const [release, git] = await Promise.all([
    validateCandidateReleaseEntry(entry),
    gitSnapshot(cwd),
  ]);
  const stateDir = path.resolve(String(entry.env.CODEX_OPENCODE_STATE_DIR || path.join(homedir(), ".codex", "codex-opencode-mcp")));
  const state = await auditStateDirectory(stateDir);
  const stateHealthy = !auditHasFailures(state, true);
  return {
    ok: git.ok && stateHealthy,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    configPath: path.resolve(configPath),
    cwd: path.resolve(cwd),
    bridge: {
      serverPath: entry.args[0] || "",
      integrityMode: release.integrityMode,
      releaseRoot: release.releaseRoot,
    },
    git,
    state: state.summary,
    next: "Use get_opencode_bridge_status for agent discovery and a live profile smoke only when provider readiness must be proven.",
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runDailyDoctor(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Bridge daily doctor: ${report.ok ? "healthy" : "attention required"}.`,
      `Duration: ${report.durationMs} ms`,
      `Integrity: ${report.bridge.integrityMode}`,
      `Server: ${report.bridge.serverPath}`,
      `Git: ${report.git.ok ? (report.git.clean ? "clean" : `dirty (${report.git.changedEntries} entries)`) : "unavailable"}`,
      `State: databases=${report.state.databases}, integrityFailures=${report.state.integrityFailures}, foreignKeys=${report.state.foreignKeyViolations}, expiredJobs=${report.state.expiredActiveJobs}, expiredPipelines=${report.state.expiredActivePipelines}`,
      report.next,
    ].join("\n") + "\n");
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

export { gitSnapshot, parseArguments, runDailyDoctor };
