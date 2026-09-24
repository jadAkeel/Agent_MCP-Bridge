#!/usr/bin/env node

// One-command release: test, build a new immutable release folder, point the Codex
// MCP entry at it with the new server hash, prove a fresh bridge is healthy, and
// roll the config back automatically if the post-activation health check fails.
//
//   npm run release:activate                 full run
//   npm run release:activate -- --check-only build and health-check a candidate, do not activate
//   npm run release:activate -- --skip-tests skip `npm test` (use only right after a green run)
//   npm run release:activate -- --prune      also delete releases/backups beyond the kept set
//
// Old releases and config backups are only listed unless --prune is passed. The kept
// set is the new release, the previously active release, and the two newest backups.

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
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/release-activate.js [--check-only] [--skip-tests] [--prune] [--config <config.toml>] [--health-cwd <git checkout>]\n");
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

// Rewrites only the MCP entry's args line (in [mcp_servers.opencode]) and the server
// hash line (in [mcp_servers.opencode.env]); every other byte of the config is kept.
function rewriteConfig(text, serverPath, serverSha256) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let section = "";
  let argsDone = false;
  let hashDone = false;
  const out = lines.map((line) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      return line;
    }
    if (section === `mcp_servers.${SERVER_NAME}` && /^\s*args\s*=/.test(line)) {
      argsDone = true;
      return `args = ['${serverPath}']`;
    }
    if (section === `mcp_servers.${SERVER_NAME}.env` && /^\s*CODEX_OPENCODE_EXPECTED_SERVER_SHA256\s*=/.test(line)) {
      hashDone = true;
      return `CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "${serverSha256}"`;
    }
    return line;
  });
  if (!argsDone) throw new Error(`Config has no args line under [mcp_servers.${SERVER_NAME}].`);
  if (!hashDone) throw new Error(`Config has no CODEX_OPENCODE_EXPECTED_SERVER_SHA256 under [mcp_servers.${SERVER_NAME}.env].`);
  if (serverPath.includes("'")) throw new Error("Release path must not contain a single quote.");
  return out.join(eol);
}

function runHealthSmoke(configPath) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "bin", "live-smoke.js"), "--health-only", "--config", configPath], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
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

async function housekeeping({ releasesRoot, keepReleases, configPath, prune }) {
  const releases = await listByAge(releasesRoot, (name) => name.startsWith("server-") && !name.includes(".staging-"));
  const keep = new Set(keepReleases.map((item) => path.resolve(item).toLowerCase()));
  const staleReleases = releases.filter((item) => !keep.has(path.resolve(item.full).toLowerCase()));
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
  const activeEntry = await loadMcpEntry(options.configPath, SERVER_NAME);
  const activeServer = path.resolve(activeEntry.args[0] || "");
  const activeRelease = path.dirname(activeServer);
  const releasesRoot = path.dirname(activeRelease);
  process.stdout.write(`Active release: ${activeRelease}\n`);

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

  const originalConfig = await readFile(options.configPath, "utf8");
  const candidateText = rewriteConfig(originalConfig, serverPath, serverSha256);
  const candidateDir = await mkdtemp(path.join(tmpdir(), "release-activate-"));
  const candidateConfig = path.join(candidateDir, "config.toml");
  try {
    await writeFile(candidateConfig, candidateText, "utf8");
    const candidateEntry = await loadMcpEntry(candidateConfig, SERVER_NAME);
    if (path.resolve(candidateEntry.args[0]) !== path.resolve(serverPath)
      || candidateEntry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 !== serverSha256) {
      throw new Error("Candidate config did not parse back to the new release path and hash.");
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
    const stagedPath = `${options.configPath}.activating-${stamp}`;
    await writeFile(stagedPath, candidateText, "utf8");
    await rename(stagedPath, options.configPath);
    process.stdout.write(`Config backup: ${backupPath}\n`);

    step("Verifying the live config");
    const smoke = runHealthSmoke(options.configPath);
    process.stdout.write(`${smoke.output}\n`);
    if (!smoke.ok) {
      await copyFile(backupPath, `${options.configPath}.restoring-${stamp}`);
      await rename(`${options.configPath}.restoring-${stamp}`, options.configPath);
      throw new Error(`Post-activation health failed; the previous config was restored from ${backupPath}.`);
    }

    step("Housekeeping");
    await housekeeping({ releasesRoot, keepReleases: [destination, activeRelease], configPath: options.configPath, prune: options.prune });

    step("Done");
    process.stdout.write(`Active release: ${destination}\nRollback release: ${activeRelease}\nRestart Codex so new sessions start the new bridge.\n`);
  } finally {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`\nrelease:activate failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
