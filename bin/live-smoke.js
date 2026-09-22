#!/usr/bin/env node

// Live daily smoke: starts the bridge exactly as Codex does (same server entry,
// same environment from ~/.codex/config.toml), checks health, and runs one tiny
// read-only agent job in a throwaway Git repository. It reports the configured
// versus runtime-observed model so the operator can see whether the daily
// profile really works end to end. One small model request is made.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpEntry } from "./fresh-healthcheck.js";

const execFileAsync = promisify(execFile);

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    agent: "planner",
    serverPath: "",
    model: "",
    timeoutMs: 1000 * 60 * 5,
    json: false,
    healthOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" || argument === "--agent" || argument === "--server" || argument === "--model") {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--config") options.configPath = value;
      if (argument === "--agent") options.agent = value;
      if (argument === "--server") options.serverPath = value;
      if (argument === "--model") options.model = value;
      index += 1;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("--timeout-ms must be an integer >= 1000.");
      index += 1;
    } else if (argument === "--json") options.json = true;
    else if (argument === "--health-only") options.healthOnly = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/live-smoke.js [--config <config.toml>] [--server <server.js>] [--agent planner] [--model provider/model[@variant]] [--timeout-ms 300000] [--health-only] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function resultText(result) {
  return (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
}

function field(text, label) {
  const match = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "mi").exec(text);
  return match ? match[1].trim() : "";
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

// The smoke runs against the real state directory (that is the point), so the
// throwaway repository leaves one per-project database behind. Remove it when it
// holds nothing but this run, so the smoke cleans up after itself.
async function removeSmokeProjectDatabase(stateDir, repo) {
  const projectsRoot = path.join(stateDir, "projects");
  let names = [];
  try {
    names = (await readdir(projectsRoot)).filter((name) => name.endsWith(".sqlite"));
  } catch {
    return { removed: false, reason: "no projects directory" };
  }
  const target = path.resolve(repo).toLowerCase();
  for (const name of names) {
    const dbPath = path.join(projectsRoot, name);
    let matches = false;
    let busy = false;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        for (const table of ["opencode_direct_runs", "opencode_jobs", "locks", "worktree_artifacts"]) {
          const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
          if (!exists) continue;
          const hasCwd = db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === "cwd");
          if (!hasCwd) continue;
          const rows = db.prepare(`SELECT DISTINCT cwd FROM ${table} WHERE cwd IS NOT NULL AND cwd <> ''`).all();
          for (const row of rows) {
            const cwd = path.resolve(String(row.cwd)).toLowerCase();
            if (cwd === target) matches = true;
            else busy = true;
          }
        }
        if (matches) {
          const live = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bridge_instances'").get()
            ? db.prepare("SELECT COUNT(*) AS count FROM bridge_instances WHERE lease_expires_at > ?").get(new Date().toISOString())
            : { count: 0 };
          if (Number(live?.count || 0) > 0) busy = true;
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
    if (!matches || busy) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${dbPath}${suffix}`, { force: true, maxRetries: 5, retryDelay: 200 });
    }
    return { removed: !existsSync(dbPath), path: dbPath };
  }
  return { removed: false, reason: "no matching database" };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const entry = await loadMcpEntry(options.configPath);
  const serverPath = path.resolve(options.serverPath || entry.args[0] || "");
  const env = { ...process.env, ...entry.env };
  // A --server override means "test this candidate", so the production hash pins
  // that belong to the active release are dropped; the report says so explicitly.
  const candidateUnpinned = Boolean(options.serverPath)
    && (Boolean(env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256) || Boolean(env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256));
  if (options.serverPath) {
    delete env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256;
    delete env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
  }
  let modelRequirement = null;
  if (options.model) {
    const at = options.model.lastIndexOf("@");
    const spec = at > 0 ? options.model.slice(0, at) : options.model;
    const variant = at > 0 ? options.model.slice(at + 1) : "";
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) throw new Error("--model must look like provider/model or provider/model@variant.");
    modelRequirement = { provider: spec.slice(0, slash), model: spec.slice(slash + 1), ...(variant ? { variant } : {}) };
  }
  const fixture = await mkdtemp(path.join(tmpdir(), "bridge-live-smoke-"));
  const repo = path.join(fixture, "repo");
  const report = {
    serverPath,
    agent: options.agent,
    startedAt: new Date().toISOString(),
    candidateUnpinned,
    health: {},
    run: {},
    ok: false,
  };
  let client = null;
  try {
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# live smoke\n\nSay OK.\n", "utf8");
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "add", "README.md"]);
    await git(repo, ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "init"]);

    client = new Client({ name: "bridge-live-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: entry.command || process.execPath,
      args: [serverPath],
      cwd: repo,
      stderr: "pipe",
      env,
    });
    let serverStderr = "";
    const startedAt = Date.now();
    try {
      const connecting = client.connect(transport);
      transport.stderr?.on("data", (chunk) => {
        serverStderr = `${serverStderr}${String(chunk)}`.slice(-4000);
      });
      await connecting;
    } catch (error) {
      const detail = serverStderr.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
      throw new Error(`The bridge process did not accept the MCP connection (${error?.message || error}).${detail ? `\nBridge stderr (tail):\n${detail}` : "\nBridge stderr was empty."}`);
    }
    report.health.connectMs = Date.now() - startedAt;
    const healthStarted = Date.now();
    const health = resultText(await client.callTool({ name: "get_opencode_bridge_status", arguments: { cwd: repo } }, undefined, { timeout: 1000 * 120 }));
    report.health.durationMs = Date.now() - healthStarted;
    report.health.status = field(health, "OpenCode MCP bridge status") || (/status: healthy/i.test(health) ? "healthy" : "unknown");
    report.health.integrity = field(health, "Integrity");
    report.health.externalPlugins = field(health, "External plugins");
    report.health.missingAgents = field(health, "Missing required agents");
    report.health.text = health;
    if (options.healthOnly) {
      report.ok = /healthy/i.test(report.health.status);
    } else {
      const runStarted = Date.now();
      const run = resultText(await client.callTool({
        name: "run_opencode_agent",
        arguments: {
          agent: options.agent,
          task: "Reply with exactly the single word LIVE_SMOKE_OK and nothing else. Do not use tools.",
          cwd: repo,
          write: false,
          lockMode: "off",
          timeoutMs: options.timeoutMs,
          scopeContract: { mode: "read", read: ["README.md"], ...(modelRequirement ? { modelRequirement } : {}) },
        },
      }, undefined, { timeout: options.timeoutMs + 1000 * 60, maxTotalTimeout: options.timeoutMs + 1000 * 60 }));
      report.run.durationMs = Date.now() - runStarted;
      report.run.errorType = field(run, "Error type") || "none";
      report.run.actualAgent = field(run, "Actual agent used");
      report.run.configuredProvider = field(run, "Configured provider");
      report.run.configuredModel = field(run, "Configured model");
      report.run.configuredVariant = field(run, "Configured variant");
      report.run.runtimeProvider = field(run, "Runtime-observed provider") || field(run, "Actual provider");
      report.run.runtimeModel = field(run, "Runtime-observed model") || field(run, "Actual model");
      report.run.modelEvidence = field(run, "Model evidence") || field(run, "Runtime model evidence");
      report.run.modelSelection = field(run, "Model selection");
      report.run.responded = /LIVE_SMOKE_OK/.test(run);
      report.run.text = run;
      report.ok = /healthy/i.test(report.health.status) && report.run.responded && report.run.errorType.toLowerCase() === "none";
    }
  } finally {
    if (client) await client.close().catch(() => {});
    const stateDir = path.resolve(String(entry.env.CODEX_OPENCODE_STATE_DIR || path.join(homedir(), ".codex", "codex-opencode-mcp")));
    report.cleanup = await removeSmokeProjectDatabase(stateDir, repo).catch((error) => ({ removed: false, reason: String(error?.message || error) }));
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [
      `Live smoke: ${report.ok ? "passed" : "FAILED"}`,
      `Server: ${report.serverPath}`,
      ...(report.candidateUnpinned ? ["Pins: production server/release hash pins removed because --server names a candidate"] : []),
      `Health: ${report.health.status} (connect ${report.health.connectMs} ms, status ${report.health.durationMs} ms)${report.health.integrity ? `; integrity ${report.health.integrity}` : ""}${report.health.externalPlugins ? `; external plugins ${report.health.externalPlugins}` : ""}`,
    ];
    lines.push(`Cleanup: smoke project database ${report.cleanup?.removed ? "removed" : `kept (${report.cleanup?.reason || "unknown"})`}`);
    if (report.health.missingAgents) lines.push(`Missing required agents: ${report.health.missingAgents}`);
    if (!options.healthOnly) {
      lines.push(`Run: agent ${report.run.actualAgent || options.agent}, ${report.run.durationMs} ms, error type ${report.run.errorType}, responded ${report.run.responded ? "yes" : "no"}`);
      lines.push(`Model: configured ${report.run.configuredProvider}/${report.run.configuredModel} (${report.run.configuredVariant || "default variant"}); runtime-observed ${report.run.runtimeProvider || "?"}/${report.run.runtimeModel || "?"}${report.run.modelEvidence ? `; evidence ${report.run.modelEvidence}` : ""}`);
      if (report.run.modelSelection) lines.push(`Model selection: ${report.run.modelSelection}`);
    }
    if (!report.ok) {
      lines.push("");
      lines.push("--- bridge health output ---");
      lines.push(report.health.text || "");
      if (!options.healthOnly) {
        lines.push("--- agent run output ---");
        lines.push(report.run.text || "");
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
