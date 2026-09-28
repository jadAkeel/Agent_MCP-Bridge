#!/usr/bin/env node

// One-command release: test, build a new immutable release folder, point the Codex
// MCP entry at it with the new server hash, prove a fresh bridge is healthy, and
// roll the config back automatically if the post-activation health check fails.
//
//   npm run release:activate                 full run
//   npm run release:activate -- --check-only build and health-check a candidate, do not activate
//   npm run release:activate -- --skip-tests skip `npm test` (use only right after a green run)
//   npm run release:activate -- --prune      also delete releases/backups beyond the kept set
//   npm run release:activate -- --inspect    show the active release, releases still in use, and
//                                            what --prune would delete; builds nothing
//   npm run release:activate -- --sync-clients  re-pin the plugin manifest and server.js hashes
//                                            from the files themselves and re-register the
//                                            active entry with Claude Code (done automatically
//                                            after every activation)
//
// Old releases and config backups are only listed unless --prune is passed. The kept
// set is the new release, the previously active release, every release a running bridge
// process still loads, and the two newest backups. A candidate that fails before it
// becomes the live release is removed again (except with --check-only).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./build-release.js";
import { loadMcpEntry, runFreshHealthcheck } from "./fresh-healthcheck.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_NAME = "opencode";
const KEEP_CONFIG_BACKUPS = 2;

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    checkOnly: false,
    skipTests: false,
    prune: false,
    inspect: false,
    syncClients: false,
    selfTest: false,
    healthCwd: SOURCE_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" || argument === "--health-cwd") {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--config") options.configPath = path.resolve(value);
      else options.healthCwd = path.resolve(value);
      index += 1;
    } else if (argument === "--check-only") options.checkOnly = true;
    else if (argument === "--skip-tests") options.skipTests = true;
    else if (argument === "--prune") options.prune = true;
    else if (argument === "--inspect") options.inspect = true;
    else if (argument === "--sync-clients") options.syncClients = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/release-activate.js [--check-only] [--skip-tests] [--prune] [--inspect] [--sync-clients] [--self-test] [--config <config.toml>] [--health-cwd <git checkout>]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function step(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "");
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function runNpmTest() {
  // npm is a .cmd shim on Windows, which Node only starts through a shell.
  const result = spawnSync("npm test", { cwd: SOURCE_ROOT, stdio: "inherit", shell: true, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm test failed (exit ${result.status}); nothing was built or activated.`);
}

async function nextReleaseDirectory(releasesRoot) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = path.join(releasesRoot, `server-daily-${date}`);
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Too many releases for ${date} under ${releasesRoot}.`);
}

// Rewrites only the MCP entry's args line (in [mcp_servers.opencode]) and the hash
// lines given (in [mcp_servers.opencode.env]); every other byte of the config is kept.
// The plugin manifest hash is recomputed from the manifest file the config names, never
// copied by hand, so a regenerated manifest (new model, new OpenCode version) cannot
// leave a stale pin behind. A config without that line (pure mode) is left alone.
function rewriteConfig(text, { serverPath = "", serverSha256 = "", pluginManifestSha256 = "" } = {}) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let section = "";
  let argsDone = false;
  let hashDone = false;
  let manifestDone = false;
  const out = lines.map((line) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      return line;
    }
    if (serverPath && section === `mcp_servers.${SERVER_NAME}` && /^\s*args\s*=/.test(line)) {
      argsDone = true;
      return `args = ['${serverPath}']`;
    }
    if (section === `mcp_servers.${SERVER_NAME}.env`) {
      if (serverSha256 && /^\s*CODEX_OPENCODE_EXPECTED_SERVER_SHA256\s*=/.test(line)) {
        hashDone = true;
        return `CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "${serverSha256}"`;
      }
      if (pluginManifestSha256 && /^\s*CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256\s*=/.test(line)) {
        manifestDone = true;
        return `CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = "${pluginManifestSha256}"`;
      }
    }
    return line;
  });
  if (serverPath && !argsDone) throw new Error(`Config has no args line under [mcp_servers.${SERVER_NAME}].`);
  if (serverSha256 && !hashDone) throw new Error(`Config has no CODEX_OPENCODE_EXPECTED_SERVER_SHA256 under [mcp_servers.${SERVER_NAME}.env].`);
  if (serverPath.includes("'")) throw new Error("Release path must not contain a single quote.");
  return { text: out.join(eol), pluginManifestPinned: manifestDone };
}

// Codex cuts an MCP tool call at tool_timeout_sec. If that is shorter than the longest
// job the bridge allows (agent timeout + validation), Codex abandons a job that is still
// running and its result is lost. Defaults mirror server.js CONFIG.
const BRIDGE_TIMEOUT_DEFAULTS_MS = {
  CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS: 1000 * 60 * 3,
  CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS: 1000 * 60 * 10,
  CODEX_OPENCODE_BUILDER_TIMEOUT_MS: 1000 * 60 * 15,
  CODEX_OPENCODE_VALIDATION_TIMEOUT_MS: 1000 * 60 * 5,
  CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS: 1000 * 60 * 6,
  CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS: 1000 * 60 * 20,
};
const CLIENT_TIMEOUT_MARGIN_MS = 1000 * 60 * 5;

function clientToolTimeoutWarning(text, env = {}) {
  let section = "";
  let toolTimeoutSec = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const match = section === `mcp_servers.${SERVER_NAME}` && /^\s*tool_timeout_sec\s*=\s*([0-9.]+)/.exec(line);
    if (match) toolTimeoutSec = Number(match[1]);
  }
  const limit = (key) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : BRIDGE_TIMEOUT_DEFAULTS_MS[key];
  };
  const longestAgentMs = Math.max(
    limit("CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS"),
    limit("CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS"),
    limit("CODEX_OPENCODE_BUILDER_TIMEOUT_MS"),
    limit("CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS"),
    limit("CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS"),
  );
  const neededSec = Math.ceil((longestAgentMs + limit("CODEX_OPENCODE_VALIDATION_TIMEOUT_MS") + CLIENT_TIMEOUT_MARGIN_MS) / 1000);
  if (toolTimeoutSec === null) {
    return `WARNING: [mcp_servers.${SERVER_NAME}] has no tool_timeout_sec; Codex defaults to 60 s. Set tool_timeout_sec = ${neededSec}.0`;
  }
  if (toolTimeoutSec < neededSec) {
    return `WARNING: tool_timeout_sec = ${toolTimeoutSec} is shorter than the longest bridge job (agent + validation + margin = ${neededSec} s). Codex would abandon long jobs while they still run. Set tool_timeout_sec = ${neededSec}.0`;
  }
  return `Client tool timeout covers the longest bridge job (${toolTimeoutSec} s >= ${neededSec} s).`;
}

// The hash of the plugin manifest the entry points at, or "" when the entry runs in
// pure mode and names none.
async function pluginManifestSha256For(entry) {
  const manifestPath = String(entry.env.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH || "").trim();
  return manifestPath ? sha256File(manifestPath) : "";
}

async function replaceConfigAtomically(configPath, text, stamp) {
  const stagedPath = `${configPath}.activating-${stamp}`;
  await writeFile(stagedPath, text, "utf8");
  await rename(stagedPath, configPath);
}

async function restoreConfigFrom(configPath, backupPath, stamp) {
  await copyFile(backupPath, `${configPath}.restoring-${stamp}`);
  await rename(`${configPath}.restoring-${stamp}`, configPath);
}

// Re-pins the integrity hashes in the live config when the files they guard changed
// underneath it: the plugin manifest (a model switch or OpenCode upgrade regenerates it)
// and the server.js the entry runs (only moves while the entry points at a working tree
// instead of an immutable release). Same safety net as an activation: backup, atomic
// replace, fresh health smoke, restore on failure.
async function refreshIntegrityPins(configPath, entry) {
  const drift = [];
  const rewrite = {};
  const short = (hash) => (hash ? `${hash.slice(0, 12)}...` : "(none)");
  const manifestActual = await pluginManifestSha256For(entry);
  if (manifestActual) {
    const pinned = String(entry.env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 || "").trim().toLowerCase();
    if (pinned !== manifestActual) {
      rewrite.pluginManifestSha256 = manifestActual;
      drift.push(`plugin manifest ${short(pinned)} -> ${short(manifestActual)}`);
    }
  }
  const serverPath = String(entry.args?.[0] || "").trim();
  if (serverPath && existsSync(serverPath)) {
    const serverActual = await sha256File(serverPath);
    const pinned = String(entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 || "").trim().toLowerCase();
    if (pinned !== serverActual) {
      rewrite.serverSha256 = serverActual;
      drift.push(`server.js ${short(pinned)} -> ${short(serverActual)}`);
    }
  }
  if (!drift.length) return "Integrity pins are current (plugin manifest, server.js).";
  const original = await readFile(configPath, "utf8");
  const { text, pluginManifestPinned } = rewriteConfig(original, rewrite);
  if (rewrite.pluginManifestSha256 && !pluginManifestPinned) throw new Error(`Config has no CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 under [mcp_servers.${SERVER_NAME}.env].`);
  const stamp = timestamp();
  const backupPath = `${configPath}.rollback-${stamp}`;
  await copyFile(configPath, backupPath);
  await replaceConfigAtomically(configPath, text, stamp);
  const smoke = runHealthSmoke(configPath);
  if (!smoke.ok) {
    await restoreConfigFrom(configPath, backupPath, stamp);
    throw new Error(`Re-pinning failed the health check; the previous config was restored from ${backupPath}.\n${smoke.output}`);
  }
  return [
    `Integrity pins updated: ${drift.join("; ")} (backup: ${backupPath})`,
    ...(rewrite.serverSha256 ? uncommittedBridgeFiles(path.dirname(serverPath)) : []),
  ].join("\n");
}

// Re-pinning trusts whatever is on disk. Naming the uncommitted bridge files makes an edit
// nobody reviewed (an agent writing into this repository) visible at the moment it is pinned.
function uncommittedBridgeFiles(repoDir) {
  const status = spawnSync("git", ["-C", repoDir, "status", "--short", "--", "server.js", "bin", "opencode", "package.json", "package-lock.json"], { encoding: "utf8", windowsHide: true });
  if (status.status !== 0) return ["Could not list uncommitted bridge files; review the working tree before trusting this pin."];
  const lines = String(status.stdout || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return ["The pinned server.js matches a clean working tree."];
  return [
    `Now trusted with uncommitted changes (${lines.length} files); make sure you reviewed them:`,
    ...lines.slice(0, 30).map((line) => `  ${line}`),
    ...(lines.length > 30 ? [`  ... ${lines.length - 30} more`] : []),
  ];
}

function selfTest() {
  const fixture = [
    "[mcp_servers.other]",
    "args = ['C:\\old\\other.js']",
    "",
    "[mcp_servers.opencode]",
    "command = \"node\"",
    "args = ['C:\\old\\server.js']",
    "",
    "[mcp_servers.opencode.env]",
    "CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = \"old-server\"",
    "CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = \"old-manifest\"",
    "CODEX_OPENCODE_LOG_LEVEL = \"warn\"",
    "",
  ].join("\r\n");
  const activation = rewriteConfig(fixture, { serverPath: "C:\\new\\server.js", serverSha256: "new-server", pluginManifestSha256: "new-manifest" });
  assert.equal(activation.pluginManifestPinned, true);
  assert.equal(activation.text, fixture
    .replace("args = ['C:\\old\\server.js']", "args = ['C:\\new\\server.js']")
    .replace("\"old-server\"", "\"new-server\"")
    .replace("\"old-manifest\"", "\"new-manifest\""));
  assert.ok(activation.text.includes("args = ['C:\\old\\other.js']"), "other servers are untouched");

  const pinOnly = rewriteConfig(fixture, { pluginManifestSha256: "new-manifest" });
  assert.equal(pinOnly.text, fixture.replace("\"old-manifest\"", "\"new-manifest\""));

  const pureMode = fixture.replace("CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = \"old-manifest\"\r\n", "");
  const pure = rewriteConfig(pureMode, { serverPath: "C:\\new\\server.js", serverSha256: "new-server", pluginManifestSha256: "new-manifest" });
  assert.equal(pure.pluginManifestPinned, false);
  assert.ok(!pure.text.includes("new-manifest"), "pure mode gains no manifest line");

  assert.throws(() => rewriteConfig("[mcp_servers.opencode]\n", { serverPath: "C:\\x.js", serverSha256: "s" }), /no args line/);
  assert.throws(() => rewriteConfig("[mcp_servers.opencode]\nargs = ['a']\n", { serverPath: "C:\\x.js", serverSha256: "s" }), /no CODEX_OPENCODE_EXPECTED_SERVER_SHA256/);
  assert.throws(() => rewriteConfig(fixture, { serverPath: "C:\\it's.js", serverSha256: "s" }), /single quote/);

  const withTimeout = (seconds) => `[mcp_servers.other]\ntool_timeout_sec = 99999\n[mcp_servers.opencode]\ntool_timeout_sec = ${seconds}\n[mcp_servers.opencode.env]\n`;
  const raised = { CODEX_OPENCODE_BUILDER_TIMEOUT_MS: "2700000", CODEX_OPENCODE_VALIDATION_TIMEOUT_MS: "900000" };
  assert.match(clientToolTimeoutWarning(withTimeout("1500.0"), raised), /^WARNING: .*3900/);
  assert.match(clientToolTimeoutWarning(withTimeout("3900.0"), raised), /^Client tool timeout covers/);
  assert.match(clientToolTimeoutWarning(withTimeout("1800.0"), {}), /^Client tool timeout covers/, "defaults (contractor 20 + 5 + 5 min) fit in 1800 s");
  assert.match(clientToolTimeoutWarning(withTimeout("1500.0"), {}), /^WARNING: .*1800/, "The contractor timeout counts too.");
  assert.match(clientToolTimeoutWarning("[mcp_servers.opencode]\n", {}), /no tool_timeout_sec/);
  process.stdout.write("release-activate self-test passed\n");
}

function runHealthSmoke(configPath) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "bin", "live-smoke.js"), "--health-only", "--config", configPath], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

// Claude Code can use the same bridge (registered once with `claude mcp add-json`).
// Its user config stores the exact release path, so after activation the entry is
// re-registered from the new Codex config. Skipped when Claude Code is not
// installed or has no `opencode` server.
function claudeCodeExecutable() {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "",
    "/usr/local/bin/claude",
    path.join(homedir(), ".local", "bin", "claude"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function syncClaudeCodeEntry(configPath) {
  const claude = claudeCodeExecutable();
  if (!claude) return "Claude Code not found; its MCP entry was not updated.";
  const run = (args) => spawnSync(claude, args, { encoding: "utf8", windowsHide: true });
  const existing = run(["mcp", "get", SERVER_NAME]);
  if (existing.status !== 0) return "Claude Code has no opencode MCP entry; nothing to update.";
  const entry = await loadMcpEntry(configPath, SERVER_NAME);
  const json = JSON.stringify({ type: "stdio", command: entry.command, args: entry.args, env: entry.env });
  const removed = run(["mcp", "remove", "-s", "user", SERVER_NAME]);
  if (removed.status !== 0) return `Could not replace the Claude Code entry: ${(removed.stderr || removed.stdout).trim()}`;
  const added = run(["mcp", "add-json", "-s", "user", SERVER_NAME, json]);
  if (added.status !== 0) return `Claude Code entry was removed but re-adding failed: ${(added.stderr || added.stdout).trim()}\nRe-add it with: claude mcp add-json -s user ${SERVER_NAME} '<json from ~/.codex/config.toml>'`;
  return `Claude Code entry updated to ${entry.args[0]}`;
}

async function listByAge(directory, filter) {
  const entries = [];
  for (const name of await readdir(directory)) {
    if (!filter(name)) continue;
    const full = path.join(directory, name);
    entries.push({ name, full, mtimeMs: (await stat(full)).mtimeMs });
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

// Releases whose files a running node process still loads. A bridge started by an
// earlier Codex session spawns bin/process-supervisor.js from its own release folder
// on every job, so that folder must survive pruning until the session ends.
function releasesInUse(releasesRoot) {
  const listing = process.platform === "win32"
    ? spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }",
    ], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-eo", "args="], { encoding: "utf8" });
  if (listing.error || listing.status !== 0) {
    return { ok: false, releases: new Set(), error: String(listing.error?.message || listing.stderr || `exit ${listing.status}`).trim() };
  }
  const root = comparablePath(releasesRoot);
  const releases = new Set();
  for (const line of String(listing.stdout || "").split(/\r?\n/)) {
    const haystack = process.platform === "win32" ? line.toLowerCase() : line;
    let at = haystack.indexOf(root);
    while (at >= 0) {
      const rest = line.slice(at + root.length).replace(/^[\\/]/, "");
      const segment = rest.split(/[\\/"'\s]/)[0];
      if (segment) releases.add(comparablePath(path.join(releasesRoot, segment)));
      at = haystack.indexOf(root, at + root.length);
    }
  }
  return { ok: true, releases };
}

async function housekeeping({ releasesRoot, keepReleases, configPath, prune }) {
  const releases = await listByAge(releasesRoot, (name) => name.startsWith("server-") && !name.includes(".staging-"));
  const keep = new Set(keepReleases.map(comparablePath));
  const inUse = releasesInUse(releasesRoot);
  if (!inUse.ok) {
    process.stdout.write(`Could not list running bridge processes (${inUse.error}); nothing is pruned.\n`);
    return;
  }
  for (const release of inUse.releases) {
    if (!keep.has(release)) process.stdout.write(`Kept (a running bridge still uses it): ${release}\n`);
    keep.add(release);
  }
  const staleReleases = releases.filter((item) => !keep.has(comparablePath(item.full)));
  const configDir = path.dirname(configPath);
  const backups = await listByAge(configDir, (name) => /^config\.toml\.(rollback|activation-backup|pre-|bak)/.test(name));
  const staleBackups = backups.slice(KEEP_CONFIG_BACKUPS);
  if (!staleReleases.length && !staleBackups.length) {
    process.stdout.write("Nothing to prune.\n");
    return;
  }
  for (const item of staleReleases) process.stdout.write(`${prune ? "Removing" : "Could remove"} release: ${item.full}\n`);
  for (const item of staleBackups) process.stdout.write(`${prune ? "Removing" : "Could remove"} config backup: ${item.full}\n`);
  if (!prune) {
    process.stdout.write("Re-run with --prune to delete these.\n");
    return;
  }
  for (const item of staleReleases) await rm(item.full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const item of staleBackups) await rm(item.full, { force: true });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }
  const activeEntry = await loadMcpEntry(options.configPath, SERVER_NAME);
  const activeServer = path.resolve(activeEntry.args[0] || "");
  const activeRelease = path.dirname(activeServer);
  const releasesRoot = path.dirname(activeRelease);
  process.stdout.write(`Active release: ${activeRelease}\n`);

  if (options.inspect) {
    step("Inspect only: nothing is built or changed");
    await housekeeping({ releasesRoot, keepReleases: [activeRelease], configPath: options.configPath, prune: false });
    return;
  }

  if (options.syncClients) {
    step("Sync only: re-pinning integrity hashes and re-registering the active entry with other MCP clients");
    process.stdout.write(`${await refreshIntegrityPins(options.configPath, activeEntry)}\n`);
    process.stdout.write(`${clientToolTimeoutWarning(await readFile(options.configPath, "utf8"), activeEntry.env)}\n`);
    process.stdout.write(`${await syncClaudeCodeEntry(options.configPath)}\n`);
    return;
  }

  if (options.skipTests) {
    step("Skipping npm test (--skip-tests)");
  } else {
    step("Running npm test");
    runNpmTest();
  }

  const destination = await nextReleaseDirectory(releasesRoot);
  step(`Building release ${destination}`);
  const built = await buildRelease({ destination });
  const serverPath = path.join(destination, "server.js");
  const serverSha256 = await sha256File(serverPath);
  process.stdout.write(`Files: ${built.fileCount}\nserver.js SHA-256: ${serverSha256}\n`);

  const pluginManifestSha256 = await pluginManifestSha256For(activeEntry);
  const originalConfig = await readFile(options.configPath, "utf8");
  const { text: candidateText, pluginManifestPinned } = rewriteConfig(originalConfig, { serverPath, serverSha256, pluginManifestSha256 });
  if (pluginManifestPinned) process.stdout.write(`plugin manifest SHA-256: ${pluginManifestSha256}\n`);
  const candidateDir = await mkdtemp(path.join(tmpdir(), "release-activate-"));
  const candidateConfig = path.join(candidateDir, "config.toml");
  let activated = false;
  try {
    await writeFile(candidateConfig, candidateText, "utf8");
    const candidateEntry = await loadMcpEntry(candidateConfig, SERVER_NAME);
    if (path.resolve(candidateEntry.args[0]) !== path.resolve(serverPath)
      || candidateEntry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 !== serverSha256
      || (pluginManifestPinned && candidateEntry.env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 !== pluginManifestSha256)) {
      throw new Error("Candidate config did not parse back to the new release path and hashes.");
    }

    step("Health-checking the candidate in a fresh bridge process");
    const health = await runFreshHealthcheck({ configPath: candidateConfig, cwd: options.healthCwd, serverName: SERVER_NAME });
    process.stdout.write(`Healthy: ${health.healthy}; tools: ${health.toolCount}; integrity: ${health.integrityMode}\n`);

    if (options.checkOnly) {
      step("Check only: the live config was not changed");
      process.stdout.write(`Candidate release left in place: ${destination}\n`);
      return;
    }

    step("Activating");
    const stamp = timestamp();
    const backupPath = `${options.configPath}.rollback-${stamp}`;
    await copyFile(options.configPath, backupPath);
    if (await readFile(options.configPath, "utf8") !== originalConfig) {
      throw new Error("The live config changed while the release was being built; nothing was activated. Re-run the command.");
    }
    await replaceConfigAtomically(options.configPath, candidateText, stamp);
    process.stdout.write(`Config backup: ${backupPath}\n`);

    step("Verifying the live config");
    const smoke = runHealthSmoke(options.configPath);
    process.stdout.write(`${smoke.output}\n`);
    if (!smoke.ok) {
      await restoreConfigFrom(options.configPath, backupPath, stamp);
      throw new Error(`Post-activation health failed; the previous config was restored from ${backupPath}.`);
    }
    activated = true;

    step("Updating other MCP clients");
    process.stdout.write(`${clientToolTimeoutWarning(await readFile(options.configPath, "utf8"), activeEntry.env)}\n`);
    process.stdout.write(`${await syncClaudeCodeEntry(options.configPath)}\n`);

    step("Housekeeping");
    await housekeeping({ releasesRoot, keepReleases: [destination, activeRelease], configPath: options.configPath, prune: options.prune });

    step("Done");
    process.stdout.write(`Active release: ${destination}\nRollback release: ${activeRelease}\nRestart Codex so new sessions start the new bridge.\n`);
  } finally {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    // A candidate that never became the live release is not worth keeping. --check-only
    // is the one case where leaving it in place is the point.
    if (!activated && !options.checkOnly) {
      await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .then(() => process.stdout.write(`Removed unactivated release: ${destination}\n`))
        .catch((error) => process.stdout.write(`Could not remove unactivated release ${destination}: ${error?.message || error}\n`));
    }
  }
}

main().catch((error) => {
  process.stderr.write(`\nrelease:activate failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
