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
//   --releases-root <dir>   where releases are built and pruned. Default: the parent of the
//                           active release when the entry runs an immutable release (a folder
//                           holding release-manifest.json), otherwise <state dir>/releases.
//                           It is never derived from a working-tree path.
//   --allow-dirty           activate even though the source tree has uncommitted bridge files
//                           (they are then frozen into the release unreviewed)
//   --skip-claude-code      do not re-register the entry with Claude Code
//   --claude-config <file>  Claude Code user config (default $CLAUDE_CONFIG_DIR/.claude.json,
//                           else ~/.claude.json)
//
// Old releases and config backups are only listed unless --prune is passed. Only folders
// named server-* that contain release-manifest.json count as releases. The kept set is
// the new release, the previously active release, every release a running bridge process
// still loads, and the two newest backups. A candidate that fails before it becomes the
// live release is removed again (except with --check-only), but only once a re-read of the
// live config proves it does not point at it.
//
// Exit code 1 whenever something was not done: a failed step, a refused re-pin, or a
// Claude Code entry that was not brought in line with the Codex entry.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildRelease } from "./build-release.js";
import { healthcheckProcessEnvironment, loadMcpEntry, runFreshHealthcheck } from "./fresh-healthcheck.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSelfTestRun(import.meta.url);
const SERVER_NAME = "opencode";
const KEEP_CONFIG_BACKUPS = 2;
const RELEASE_MANIFEST = "release-manifest.json";
// Files a release copies from the source tree (build-release.js LEGACY_PUBLISH_ENTRIES).
const BRIDGE_SOURCE_PATHS = ["server.js", "bin", "opencode", "tests", "package.json", "package-lock.json"];
const RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function defaultClaudeConfigPath(env = process.env) {
  const configDir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return configDir ? path.join(configDir, ".claude.json") : path.join(homedir(), ".claude.json");
}

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    checkOnly: false,
    skipTests: false,
    prune: false,
    inspect: false,
    syncClients: false,
    selfTest: false,
    allowDirty: false,
    skipClaudeCode: false,
    releasesRoot: "",
    claudeConfigPath: defaultClaudeConfigPath(),
    healthCwd: SOURCE_ROOT,
  };
  const valued = {
    "--config": "configPath",
    "--health-cwd": "healthCwd",
    "--releases-root": "releasesRoot",
    "--claude-config": "claudeConfigPath",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued[argument]) {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options[valued[argument]] = path.resolve(value);
      index += 1;
    } else if (argument === "--check-only") options.checkOnly = true;
    else if (argument === "--skip-tests") options.skipTests = true;
    else if (argument === "--prune") options.prune = true;
    else if (argument === "--inspect") options.inspect = true;
    else if (argument === "--sync-clients") options.syncClients = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--skip-claude-code") options.skipClaudeCode = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/release-activate.js [--check-only] [--skip-tests] [--prune] [--inspect] [--sync-clients] [--allow-dirty] [--skip-claude-code] [--self-test] [--config <config.toml>] [--releases-root <dir>] [--claude-config <.claude.json>] [--health-cwd <git checkout>]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function step(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function short(hash) {
  return hash ? `${hash.slice(0, 12)}...` : "(none)";
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "");
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathIsAtOrInside(candidate, directory) {
  const child = comparablePath(candidate);
  const parent = comparablePath(directory);
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function runNpmTest() {
  // npm is a .cmd shim on Windows, which Node only starts through a shell.
  const result = spawnSync("npm test", { cwd: SOURCE_ROOT, stdio: "inherit", shell: true, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm test failed (exit ${result.status}); nothing was built or activated.`);
}

function isReleaseDirectory(directory) {
  return existsSync(path.join(directory, RELEASE_MANIFEST));
}

// The releases root is fixed, never the parent of a working tree: with the entry running
// C:\Users\me\codex-opencode-mcp\server.js that parent is the home directory, where a
// release would be built and --prune would delete every server-* folder.
function resolveReleasesRoot({ explicitRoot = "", activeRelease = "", entryEnv = {} } = {}) {
  if (explicitRoot) return { root: path.resolve(explicitRoot), source: "--releases-root" };
  if (activeRelease && isReleaseDirectory(activeRelease)) {
    return { root: path.dirname(path.resolve(activeRelease)), source: "parent of the active immutable release" };
  }
  const stateDir = String(entryEnv.CODEX_OPENCODE_STATE_DIR || "").trim() || path.join(homedir(), ".codex", "codex-opencode-mcp");
  return { root: path.join(path.resolve(stateDir), "releases"), source: "state directory (the active entry runs a working tree)" };
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

function tomlHeader(line) {
  const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  return header ? header[1].trim() : null;
}

// Rewrites only the MCP entry's args line (in [mcp_servers.opencode]) and the hash
// lines given (in [mcp_servers.opencode.env]); every other byte of the config is kept.
// Headers with trailing comments and [[array.tables]] end a section too, so a later
// server's args line is never mistaken for the opencode one; assertRewritePreservesConfig
// then proves the rewrite by parsing both versions.
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
    const header = tomlHeader(line);
    if (header !== null) {
      section = header;
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

const PYTHON_TOML_DOCUMENTS = [
  "import json, sys, tomllib",
  "texts = json.loads(sys.stdin.read())",
  "print(json.dumps([tomllib.loads(text) for text in texts], default=str))",
].join("\n");

function parseTomlDocuments(texts) {
  const result = spawnSync(process.env.PYTHON || "python", ["-I", "-c", PYTHON_TOML_DOCUMENTS], {
    input: JSON.stringify(texts),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: healthcheckProcessEnvironment(process.env, { PYTHONIOENCODING: "utf-8" }),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not parse the config as TOML: ${String(result.error?.message || result.stderr || `exit ${result.status}`).trim()}`);
  }
  return JSON.parse(result.stdout);
}

function withoutRewrittenFields(document) {
  const copy = structuredClone(document);
  const entry = copy?.mcp_servers?.[SERVER_NAME];
  if (entry && typeof entry === "object") {
    delete entry.args;
    if (entry.env && typeof entry.env === "object") {
      delete entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256;
      delete entry.env.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256;
    }
  }
  return copy;
}

// Parses the config before and after a rewrite and refuses it unless the only differences
// are the opencode args line and its integrity pins. Returns the parsed rewritten config.
function assertRewritePreservesConfig(originalText, rewrittenText) {
  const [before, after] = parseTomlDocuments([originalText, rewrittenText]);
  const names = new Set([...Object.keys(before?.mcp_servers || {}), ...Object.keys(after?.mcp_servers || {})]);
  for (const name of names) {
    if (name !== SERVER_NAME && !isDeepStrictEqual(before?.mcp_servers?.[name], after?.mcp_servers?.[name])) {
      throw new Error(`Rewriting the config would change [mcp_servers.${name}]; nothing was written.`);
    }
  }
  if (!isDeepStrictEqual(withoutRewrittenFields(before), withoutRewrittenFields(after))) {
    throw new Error(`Rewriting the config would change more than the ${SERVER_NAME} args and integrity pins; nothing was written.`);
  }
  return after;
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
    const header = tomlHeader(line);
    if (header !== null) { section = header; continue; }
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

// Windows refuses a rename onto a file another process has open (an editor, an indexer,
// a Codex session reading its config) with EPERM/EBUSY/EACCES for a moment; retry that.
async function renameWithRetry(from, to, { renameFile = rename, delays = RENAME_RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
}

async function replaceConfigAtomically(configPath, text, stamp) {
  const stagedPath = `${configPath}.activating-${stamp}`;
  await writeFile(stagedPath, text, "utf8");
  await renameWithRetry(stagedPath, configPath);
}

async function restoreConfigFrom(configPath, backupPath, stamp, renameOptions = {}) {
  const stagedPath = `${configPath}.restoring-${stamp}`;
  await copyFile(backupPath, stagedPath);
  await renameWithRetry(stagedPath, configPath, renameOptions);
}

// The server.js hash --sync-clients may pin. A working tree may move, so its current hash
// is pinned. An immutable release (its folder holds release-manifest.json) must not: its
// server.js is re-pinned only while it still equals the manifest's digest (and the manifest
// its own pin), so an edit inside a release is refused instead of trusted.
async function repinnableServerSha256(serverPath, env = {}) {
  const actual = await sha256File(serverPath);
  const releaseDir = path.dirname(serverPath);
  if (!isReleaseDirectory(releaseDir)) return actual;
  const manifestPath = path.join(releaseDir, RELEASE_MANIFEST);
  const manifestContent = await readFile(manifestPath);
  const pinnedManifest = String(env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim().toLowerCase();
  if (pinnedManifest && createHash("sha256").update(manifestContent).digest("hex") !== pinnedManifest) {
    throw new Error(`${manifestPath} does not match CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256; the immutable release was modified, so nothing is re-pinned.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString("utf8"));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON (${error.message}); nothing is re-pinned.`);
  }
  const expected = String(manifest?.files?.["server.js"] || "").trim().toLowerCase();
  if (actual !== expected) {
    throw new Error(`${serverPath} belongs to an immutable release, but its SHA-256 ${short(actual)} differs from ${RELEASE_MANIFEST} (${short(expected)}). Refusing to re-pin a modified release; build a new one with npm run release:activate.`);
  }
  return actual;
}

// Re-pins the integrity hashes in the live config when the files they guard changed
// underneath it: the plugin manifest (a model switch or OpenCode upgrade regenerates it)
// and the server.js the entry runs (only moves while the entry points at a working tree
// instead of an immutable release). Same safety net as an activation: backup, atomic
// replace, fresh health smoke, restore on failure.
async function refreshIntegrityPins(configPath, entry, { smoke = runHealthSmoke } = {}) {
  const drift = [];
  const rewrite = {};
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
    const serverActual = await repinnableServerSha256(serverPath, entry.env);
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
  const parsed = assertRewritePreservesConfig(original, text);
  const parsedEnv = parsed?.mcp_servers?.[SERVER_NAME]?.env || {};
  if ((rewrite.serverSha256 && parsedEnv.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 !== rewrite.serverSha256)
    || (rewrite.pluginManifestSha256 && parsedEnv.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 !== rewrite.pluginManifestSha256)) {
    throw new Error("The rewritten config did not parse back to the new pins; nothing was written.");
  }
  const stamp = timestamp();
  const backupPath = `${configPath}.rollback-${stamp}`;
  await copyFile(configPath, backupPath);
  await replaceConfigAtomically(configPath, text, stamp);
  const health = smoke(configPath);
  if (!health.ok) {
    try {
      await restoreConfigFrom(configPath, backupPath, stamp);
    } catch (error) {
      throw new Error(`Re-pinning failed the health check AND restoring the previous config failed (${error?.code || error?.message || error}); copy ${backupPath} over ${configPath} by hand.\n${health.output}`);
    }
    throw new Error(`Re-pinning failed the health check; the previous config was restored from ${backupPath}.\n${health.output}`);
  }
  return [
    `Integrity pins updated: ${drift.join("; ")} (backup: ${backupPath})`,
    ...(rewrite.serverSha256 ? uncommittedBridgeFiles(path.dirname(serverPath)) : []),
  ].join("\n");
}

function bridgeWorkingTreeStatus(repoDir) {
  const status = spawnSync("git", ["-C", repoDir, "status", "--porcelain=v1", "--untracked-files=all", "--", ...BRIDGE_SOURCE_PATHS], { encoding: "utf8", windowsHide: true });
  if (status.error || status.status !== 0) {
    return { ok: false, lines: [], error: String(status.error?.message || status.stderr || `exit ${status.status}`).trim() };
  }
  return { ok: true, lines: String(status.stdout || "").split(/\r?\n/).filter(Boolean), error: "" };
}

function listStatusLines(lines) {
  return [
    ...lines.slice(0, 30).map((line) => `  ${line}`),
    ...(lines.length > 30 ? [`  ... ${lines.length - 30} more`] : []),
  ];
}

// Re-pinning trusts whatever is on disk. Naming the uncommitted bridge files makes an edit
// nobody reviewed (an agent writing into this repository) visible at the moment it is pinned.
function uncommittedBridgeFiles(repoDir) {
  const status = bridgeWorkingTreeStatus(repoDir);
  if (!status.ok) return ["Could not list uncommitted bridge files; review the working tree before trusting this pin."];
  if (!status.lines.length) return ["The pinned server.js matches a clean working tree."];
  return [
    `Now trusted with uncommitted changes (${status.lines.length} files); make sure you reviewed them:`,
    ...listStatusLines(status.lines),
  ];
}

// A release is meant to freeze reviewed, committed code. Building one from a tree with
// uncommitted bridge files would make those edits "immutable" without review.
function assertCleanSourceTree(repoDir, allowDirty = false) {
  const status = bridgeWorkingTreeStatus(repoDir);
  if (!status.ok) {
    if (allowDirty) return [`WARNING (--allow-dirty): could not read the git status of ${repoDir} (${status.error}).`];
    throw new Error(`Could not read the git status of ${repoDir} (${status.error}); refusing to build a release from an unverified tree. Pass --allow-dirty to override.`);
  }
  if (!status.lines.length) return [];
  if (!allowDirty) {
    throw new Error([
      `The source tree has ${status.lines.length} uncommitted bridge file(s); a release would freeze them unreviewed. Commit them first, or pass --allow-dirty:`,
      ...listStatusLines(status.lines),
    ].join("\n"));
  }
  return [`WARNING (--allow-dirty): the release includes ${status.lines.length} uncommitted bridge file(s):`, ...listStatusLines(status.lines)];
}

// true: the live config names the directory; false: a re-read proves it does not;
// null: the config could not be read or parsed, so nothing may be concluded.
async function liveConfigReferences(configPath, directory) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const haystack = fold(text);
  const resolved = path.resolve(directory);
  const spellings = [resolved, resolved.replace(/\\/g, "\\\\"), resolved.replace(/\\/g, "/")];
  if (spellings.some((spelling) => haystack.includes(fold(spelling)))) return true;
  try {
    const entry = await loadMcpEntry(configPath, SERVER_NAME);
    const values = [entry.command, ...entry.args, ...Object.values(entry.env)].filter((value) => typeof value === "string" && value.trim());
    return values.some((value) => path.isAbsolute(value) && pathIsAtOrInside(value, resolved));
  } catch {
    return null;
  }
}

// A candidate that never became the live release is removed, unless the live config may
// still point at it (a restore that failed, or a config that cannot be re-read).
async function cleanupUnactivatedRelease({ configPath, destination, liveConfigWritten = false }) {
  const referenced = await liveConfigReferences(configPath, destination);
  if (referenced !== false) {
    return `Kept unactivated release ${destination}: ${referenced ? "the live config still points at it" : "the live config could not be re-read"}${liveConfigWritten ? " (it was written during activation)" : ""}. Restore ${configPath} from its backup before removing it.`;
  }
  try {
    await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return `Removed unactivated release: ${destination}`;
  } catch (error) {
    return `Could not remove unactivated release ${destination}: ${error?.message || error}`;
  }
}

function runHealthSmoke(configPath) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "bin", "live-smoke.js"), "--health-only", "--config", configPath], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function claudeOnPath() {
  const result = process.platform === "win32"
    ? spawnSync("where", ["claude"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["-a", "claude"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Claude Code can use the same bridge (registered once with `claude mcp add-json`).
// Its user config stores the exact release path, so after activation the entry is
// re-registered from the new Codex config. The executable is found without a shell: a
// native install (~/.local/bin/claude.exe), an .exe on PATH, or an npm prefix, whose
// claude.cmd shim is resolved to the package's own claude.exe or cli.js (Node refuses to
// spawn .cmd files without a shell, and a shell would re-parse the JSON argument).
function claudeCodeCommand({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync, onPath = claudeOnPath } = {}) {
  const candidates = [];
  const direct = (command) => candidates.push({ command, args: [], probe: command });
  if (platform === "win32") {
    direct(path.join(home, ".local", "bin", "claude.exe"));
    const prefixes = [env.APPDATA ? path.join(env.APPDATA, "npm") : ""];
    for (const found of onPath()) {
      if (path.extname(found).toLowerCase() === ".exe") direct(found);
      else prefixes.push(path.dirname(found));
    }
    for (const prefix of prefixes.filter(Boolean)) {
      const packageDir = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
      direct(path.join(packageDir, "bin", "claude.exe"));
      const cli = path.join(packageDir, "cli.js");
      candidates.push({ command: process.execPath, args: [cli], probe: cli });
    }
  } else {
    direct("/usr/local/bin/claude");
    direct(path.join(home, ".local", "bin", "claude"));
    for (const found of onPath()) direct(found);
  }
  return candidates.find((candidate) => exists(candidate.probe)) || null;
}

async function readClaudeUserEntry(claudeConfigPath) {
  let text;
  try {
    text = await readFile(claudeConfigPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { ok: true, entry: null } : { ok: false, error: String(error?.message || error) };
  }
  try {
    const entry = JSON.parse(text)?.mcpServers?.[SERVER_NAME];
    return { ok: true, entry: entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null };
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error.message})` };
  }
}

function claudeEntryFor(codexEntry) {
  return { type: "stdio", command: codexEntry.command, args: codexEntry.args, env: codexEntry.env };
}

function sameClaudeEntry(left, right) {
  return (left?.type || "stdio") === (right?.type || "stdio")
    && left?.command === right?.command
    && isDeepStrictEqual(left?.args || [], right?.args || [])
    && isDeepStrictEqual({ ...(left?.env || {}) }, { ...(right?.env || {}) });
}

// { ok, updated, message }. ok is false for every outcome that leaves Claude Code out of
// line with the Codex entry; an entry that already matches is left alone (ok, not updated).
// The replacement is remove-then-add, so the previous entry is saved first and re-added
// when the add fails.
async function syncClaudeCodeEntry(configPath, {
  claude = claudeCodeCommand(),
  claudeConfigPath = defaultClaudeConfigPath(),
  env = process.env,
} = {}) {
  const fail = (message) => ({ ok: false, updated: false, message });
  if (!claude) {
    return fail("Claude Code executable not found (probed ~/.local/bin, npm prefixes and PATH); its MCP entry was NOT updated. Pass --skip-claude-code if Claude Code does not use this bridge.");
  }
  const current = await readClaudeUserEntry(claudeConfigPath);
  if (!current.ok) return fail(`Could not read ${claudeConfigPath}: ${current.error}; the Claude Code entry was NOT updated.`);
  if (!current.entry) {
    return fail(`${claudeConfigPath} has no user-scope "${SERVER_NAME}" MCP entry; nothing was updated. Register it once with claude mcp add-json -s user ${SERVER_NAME} '<json>', or pass --skip-claude-code.`);
  }
  const desired = claudeEntryFor(await loadMcpEntry(configPath, SERVER_NAME));
  if (sameClaudeEntry(current.entry, desired)) {
    return { ok: true, updated: false, message: `Claude Code entry already matches the Codex entry (${desired.args[0]}); nothing to update.` };
  }
  const run = (args) => spawnSync(claude.command, [...claude.args, ...args], { encoding: "utf8", windowsHide: true, env });
  const output = (result) => String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim();
  const removed = run(["mcp", "remove", "-s", "user", SERVER_NAME]);
  if (removed.status !== 0) return fail(`Could not replace the Claude Code entry (remove failed: ${output(removed)}); the previous entry is unchanged.`);
  const added = run(["mcp", "add-json", "-s", "user", SERVER_NAME, JSON.stringify(desired)]);
  if (added.status !== 0) {
    const restored = run(["mcp", "add-json", "-s", "user", SERVER_NAME, JSON.stringify(current.entry)]);
    if (restored.status === 0) {
      return fail(`Re-adding the Claude Code entry failed (${output(added)}); the previous entry was restored, so Claude Code still runs ${current.entry.args?.[0] || "its old server"}.`);
    }
    const savedPath = `${claudeConfigPath}.${SERVER_NAME}-entry-${timestamp()}.json`;
    await writeFile(savedPath, `${JSON.stringify(current.entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    return fail(`Re-adding the Claude Code entry failed (${output(added)}) and restoring the previous one failed too (${output(restored)}). Claude Code now has NO ${SERVER_NAME} entry; re-add it with claude mcp add-json -s user ${SERVER_NAME} using the JSON saved in ${savedPath}.`);
  }
  const after = await readClaudeUserEntry(claudeConfigPath);
  if (!after.ok || !after.entry || !sameClaudeEntry(after.entry, desired)) {
    return fail(`claude mcp add-json reported success, but ${claudeConfigPath} does not hold the new entry; check it with claude mcp get ${SERVER_NAME}.`);
  }
  return { ok: true, updated: true, message: `Claude Code entry updated to ${desired.args[0]}` };
}

async function syncClaudeCodeForOptions(options) {
  if (options.skipClaudeCode) return { ok: true, updated: false, message: "Claude Code entry not checked (--skip-claude-code)." };
  return await syncClaudeCodeEntry(options.configPath, { claudeConfigPath: options.claudeConfigPath });
}

async function listByAge(directory, filter) {
  const entries = [];
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return entries;
    throw error;
  }
  for (const name of names) {
    if (!filter(name)) continue;
    const full = path.join(directory, name);
    entries.push({ name, full, mtimeMs: (await stat(full)).mtimeMs });
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

// Only real release folders count: named server-*, not a staging folder, not a link, and
// holding release-manifest.json. Anything else under the root is never listed or pruned.
async function listReleases(releasesRoot) {
  const candidates = await listByAge(releasesRoot, (name) => name.startsWith("server-") && !name.includes(".staging-"));
  const releases = [];
  for (const item of candidates) {
    const details = await lstat(item.full);
    if (details.isDirectory() && !details.isSymbolicLink() && isReleaseDirectory(item.full)) releases.push(item);
  }
  return releases;
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

async function housekeeping({ releasesRoot, keepReleases, configPath, prune, inUse = null }) {
  const releases = await listReleases(releasesRoot);
  const keep = new Set(keepReleases.map(comparablePath));
  const running = inUse || releasesInUse(releasesRoot);
  if (!running.ok) {
    process.stdout.write(`Could not list running bridge processes (${running.error}); nothing is pruned.\n`);
    return { removedReleases: [], removedBackups: [] };
  }
  for (const release of running.releases) {
    if (!keep.has(release)) process.stdout.write(`Kept (a running bridge still uses it): ${release}\n`);
    keep.add(release);
  }
  const staleReleases = releases.filter((item) => !keep.has(comparablePath(item.full)));
  const configDir = path.dirname(configPath);
  const backups = await listByAge(configDir, (name) => /^config\.toml\.(rollback|activation-backup|pre-|bak)/.test(name));
  const staleBackups = backups.slice(KEEP_CONFIG_BACKUPS);
  if (!staleReleases.length && !staleBackups.length) {
    process.stdout.write("Nothing to prune.\n");
    return { removedReleases: [], removedBackups: [] };
  }
  for (const item of staleReleases) process.stdout.write(`${prune ? "Removing" : "Could remove"} release: ${item.full}\n`);
  for (const item of staleBackups) process.stdout.write(`${prune ? "Removing" : "Could remove"} config backup: ${item.full}\n`);
  if (!prune) {
    process.stdout.write("Re-run with --prune to delete these.\n");
    return { removedReleases: [], removedBackups: [] };
  }
  for (const item of staleReleases) await rm(item.full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const item of staleBackups) await rm(item.full, { force: true });
  return { removedReleases: staleReleases.map((item) => item.full), removedBackups: staleBackups.map((item) => item.full) };
}

function selfTestRewrite() {
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
  assertRewritePreservesConfig(fixture, activation.text);

  const pinOnly = rewriteConfig(fixture, { pluginManifestSha256: "new-manifest" });
  assert.equal(pinOnly.text, fixture.replace("\"old-manifest\"", "\"new-manifest\""));

  const pureMode = fixture.replace("CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = \"old-manifest\"\r\n", "");
  const pure = rewriteConfig(pureMode, { serverPath: "C:\\new\\server.js", serverSha256: "new-server", pluginManifestSha256: "new-manifest" });
  assert.equal(pure.pluginManifestPinned, false);
  assert.ok(!pure.text.includes("new-manifest"), "pure mode gains no manifest line");

  assert.throws(() => rewriteConfig("[mcp_servers.opencode]\n", { serverPath: "C:\\x.js", serverSha256: "s" }), /no args line/);
  assert.throws(() => rewriteConfig("[mcp_servers.opencode]\nargs = ['a']\n", { serverPath: "C:\\x.js", serverSha256: "s" }), /no CODEX_OPENCODE_EXPECTED_SERVER_SHA256/);
  assert.throws(() => rewriteConfig(fixture, { serverPath: "C:\\it's.js", serverSha256: "s" }), /single quote/);

  // A header with a trailing comment, or an [[array.table]], ends the opencode section: the
  // next server's args line was overwritten before.
  const commented = [
    "[mcp_servers.opencode] # the bridge",
    "command = \"node\"",
    "args = ['C:\\old\\server.js']",
    "",
    "[mcp_servers.other]   # another server",
    "command = \"node\"",
    "args = ['C:\\old\\other.js']",
    "",
    "[[profiles]]",
    "args = ['profile-arg']",
    "",
    "[mcp_servers.opencode.env] # pins",
    "CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = \"old-server\"",
    "",
  ].join("\n");
  const commentedRewrite = rewriteConfig(commented, { serverPath: "C:\\new\\server.js", serverSha256: "new-server" });
  assert.ok(commentedRewrite.text.includes("args = ['C:\\old\\other.js']"), "a commented header ends the opencode section");
  assert.ok(commentedRewrite.text.includes("args = ['profile-arg']"), "an [[array.table]] header ends the opencode section");
  assert.ok(commentedRewrite.text.includes("args = ['C:\\new\\server.js']"));
  assert.ok(commentedRewrite.text.includes("CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = \"new-server\""));
  assertRewritePreservesConfig(commented, commentedRewrite.text);
  assert.throws(
    () => assertRewritePreservesConfig(commented, commented.replace("C:\\old\\other.js", "C:\\new\\server.js")),
    /would change \[mcp_servers\.other\]/,
  );
  assert.throws(
    () => assertRewritePreservesConfig(commented, commented.replace("profile-arg", "changed")),
    /would change more than/,
  );

  const withTimeout = (seconds) => `[mcp_servers.other]\ntool_timeout_sec = 99999\n[mcp_servers.opencode]\ntool_timeout_sec = ${seconds}\n[mcp_servers.opencode.env]\n`;
  const raised = { CODEX_OPENCODE_BUILDER_TIMEOUT_MS: "2700000", CODEX_OPENCODE_VALIDATION_TIMEOUT_MS: "900000" };
  assert.match(clientToolTimeoutWarning(withTimeout("1500.0"), raised), /^WARNING: .*3900/);
  assert.match(clientToolTimeoutWarning(withTimeout("3900.0"), raised), /^Client tool timeout covers/);
  assert.match(clientToolTimeoutWarning(withTimeout("1800.0"), {}), /^Client tool timeout covers/, "defaults (contractor 20 + 5 + 5 min) fit in 1800 s");
  assert.match(clientToolTimeoutWarning(withTimeout("1500.0"), {}), /^WARNING: .*1800/, "The contractor timeout counts too.");
  assert.match(clientToolTimeoutWarning("[mcp_servers.opencode]\n", {}), /no tool_timeout_sec/);
}

async function writeCodexConfig(configPath, { command = process.execPath, serverPath, env = {} }) {
  await writeFile(configPath, [
    "[mcp_servers.opencode]",
    `command = ${JSON.stringify(command)}`,
    `args = [${JSON.stringify(serverPath)}]`,
    "",
    "[mcp_servers.opencode.env]",
    ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    "",
  ].join("\n"), "utf8");
}

async function selfTestReleasesRoot(fixture) {
  // A working-tree entry directly under a "home" directory: the old code used that home as
  // the releases root and --prune removed every server-* folder in it.
  const home = path.join(fixture, "home");
  const workingTree = path.join(home, "codex-opencode-mcp");
  const stateDir = path.join(home, ".codex", "codex-opencode-mcp");
  await mkdir(workingTree, { recursive: true });
  await writeFile(path.join(workingTree, "server.js"), "working tree\n", "utf8");
  const working = resolveReleasesRoot({ activeRelease: workingTree, entryEnv: { CODEX_OPENCODE_STATE_DIR: stateDir } });
  assert.equal(working.root, path.join(stateDir, "releases"));
  assert.notEqual(comparablePath(working.root), comparablePath(home));
  assert.equal(resolveReleasesRoot({ explicitRoot: path.join(fixture, "explicit"), activeRelease: workingTree }).root, path.join(fixture, "explicit"));

  const releasesRoot = path.join(fixture, "releases");
  const releaseA = path.join(releasesRoot, "server-daily-20260101");
  const releaseB = path.join(releasesRoot, "server-daily-20260102");
  const notARelease = path.join(releasesRoot, "server-notes");
  for (const directory of [releaseA, releaseB, notARelease]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(releaseA, RELEASE_MANIFEST), "{\"version\":1,\"files\":{}}\n", "utf8");
  await writeFile(path.join(releaseB, RELEASE_MANIFEST), "{\"version\":1,\"files\":{}}\n", "utf8");
  await writeFile(path.join(notARelease, "keep.txt"), "not a release\n", "utf8");
  assert.equal(resolveReleasesRoot({ activeRelease: releaseB }).root, releasesRoot, "an immutable release keeps its siblings as the releases root");
  assert.deepEqual((await listReleases(releasesRoot)).map((item) => item.name).sort(), ["server-daily-20260101", "server-daily-20260102"]);
  assert.deepEqual(await listReleases(path.join(fixture, "missing-root")), []);

  const configDir = path.join(fixture, "codex");
  await mkdir(configDir, { recursive: true });
  const pruned = await housekeeping({
    releasesRoot,
    keepReleases: [releaseB],
    configPath: path.join(configDir, "config.toml"),
    prune: true,
    inUse: { ok: true, releases: new Set() },
  });
  assert.deepEqual(pruned.removedReleases, [releaseA]);
  assert.equal(existsSync(releaseA), false);
  assert.equal(existsSync(releaseB), true);
  assert.equal(existsSync(path.join(notARelease, "keep.txt")), true, "a folder without release-manifest.json is never pruned");
}

async function selfTestRepin(fixture) {
  const releaseDir = path.join(fixture, "pin-release");
  await mkdir(releaseDir, { recursive: true });
  const serverPath = path.join(releaseDir, "server.js");
  await writeFile(serverPath, "reviewed\n", "utf8");
  const reviewed = await sha256File(serverPath);
  await writeFile(path.join(releaseDir, RELEASE_MANIFEST), `${JSON.stringify({ version: 1, files: { "server.js": reviewed } })}\n`, "utf8");
  const manifestSha256 = await sha256File(path.join(releaseDir, RELEASE_MANIFEST));
  assert.equal(await repinnableServerSha256(serverPath, { CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: manifestSha256 }), reviewed);
  await writeFile(serverPath, "edited inside the release\n", "utf8");
  await assert.rejects(repinnableServerSha256(serverPath, {}), /immutable release.*Refusing to re-pin/s);
  await writeFile(path.join(releaseDir, RELEASE_MANIFEST), `${JSON.stringify({ version: 1, files: { "server.js": await sha256File(serverPath) } })}\n`, "utf8");
  await assert.rejects(
    repinnableServerSha256(serverPath, { CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: manifestSha256 }),
    /does not match CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256/,
  );

  const workingTree = path.join(fixture, "pin-working-tree");
  await mkdir(workingTree, { recursive: true });
  await writeFile(path.join(workingTree, "server.js"), "moving\n", "utf8");
  assert.equal(await repinnableServerSha256(path.join(workingTree, "server.js"), {}), await sha256File(path.join(workingTree, "server.js")));

  // --sync-clients end to end: the refused re-pin leaves the config untouched.
  await writeFile(path.join(releaseDir, RELEASE_MANIFEST), `${JSON.stringify({ version: 1, files: { "server.js": reviewed } })}\n`, "utf8");
  const configPath = path.join(fixture, "pin-config.toml");
  await writeCodexConfig(configPath, { serverPath, env: { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: reviewed } });
  const before = await readFile(configPath, "utf8");
  await assert.rejects(
    refreshIntegrityPins(configPath, await loadMcpEntry(configPath, SERVER_NAME), { smoke: () => ({ ok: true, output: "" }) }),
    /Refusing to re-pin/,
  );
  assert.equal(await readFile(configPath, "utf8"), before);
}

async function selfTestRestoreAndCleanup(fixture) {
  let calls = 0;
  const flakyRename = async (from, to) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    await rename(from, to);
  };
  const configPath = path.join(fixture, "restore-config.toml");
  const backupPath = `${configPath}.rollback-test`;
  await writeFile(configPath, "candidate\n", "utf8");
  await writeFile(backupPath, "previous\n", "utf8");
  await restoreConfigFrom(configPath, backupPath, "t1", { renameFile: flakyRename, delays: [1, 1, 1] });
  assert.equal(calls, 3, "EBUSY is retried");
  assert.equal(await readFile(configPath, "utf8"), "previous\n");
  await assert.rejects(
    restoreConfigFrom(configPath, backupPath, "t2", { renameFile: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }, delays: [1, 1] }),
    /denied/,
  );

  const destination = path.join(fixture, "server-daily-candidate");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "server.js"), "candidate\n", "utf8");
  const liveConfig = path.join(fixture, "live-config.toml");
  await writeCodexConfig(liveConfig, { serverPath: path.join(destination, "server.js"), env: { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64) } });
  assert.match(await cleanupUnactivatedRelease({ configPath: liveConfig, destination, liveConfigWritten: true }), /Kept unactivated release.*still points at it/);
  assert.equal(existsSync(destination), true, "a release the live config points at is never deleted");
  assert.match(await cleanupUnactivatedRelease({ configPath: path.join(fixture, "missing.toml"), destination }), /could not be re-read/);
  assert.equal(existsSync(destination), true);
  await writeCodexConfig(liveConfig, { serverPath: path.join(fixture, "previous", "server.js"), env: { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64) } });
  assert.match(await cleanupUnactivatedRelease({ configPath: liveConfig, destination }), /Removed unactivated release/);
  assert.equal(existsSync(destination), false);
}

async function selfTestCleanTree(fixture) {
  const repo = path.join(fixture, "source-repo");
  await mkdir(path.join(repo, "bin"), { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, "-c", "user.name=release", "-c", "user.email=release@example.com", ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "--quiet");
  await writeFile(path.join(repo, "server.js"), "committed\n", "utf8");
  await writeFile(path.join(repo, "bin", "tool.js"), "committed\n", "utf8");
  await writeFile(path.join(repo, "notes.txt"), "outside the published paths\n", "utf8");
  git("add", "server.js", "bin/tool.js");
  git("commit", "--quiet", "-m", "init");
  assert.deepEqual(assertCleanSourceTree(repo, false), [], "untracked files outside the published paths do not count");
  await writeFile(path.join(repo, "server.js"), "edited, not committed\n", "utf8");
  assert.throws(() => assertCleanSourceTree(repo, false), /1 uncommitted bridge file.*server\.js/s);
  await writeFile(path.join(repo, "bin", "new-tool.js"), "untracked\n", "utf8");
  assert.throws(() => assertCleanSourceTree(repo, false), /2 uncommitted bridge file/);
  assert.match(assertCleanSourceTree(repo, true)[0], /WARNING \(--allow-dirty\)/);
  const notARepo = path.join(fixture, "not-a-repo");
  await mkdir(notARepo, { recursive: true });
  assert.throws(() => assertCleanSourceTree(notARepo, false), /Could not read the git status/);
}

const FAKE_CLAUDE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const configPath = process.env.FAKE_CLAUDE_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.mcpServers = config.mcpServers || {};
if (args[0] === "mcp" && args[1] === "remove" && args[2] === "-s" && args[3] === "user") {
  if (!config.mcpServers[args[4]]) process.exit(1);
  delete config.mcpServers[args[4]];
} else if (args[0] === "mcp" && args[1] === "add-json" && args[2] === "-s" && args[3] === "user") {
  if (process.env.FAKE_CLAUDE_FAIL_ADD && args[5].includes(process.env.FAKE_CLAUDE_FAIL_ADD)) {
    process.stderr.write("simulated add failure\\n");
    process.exit(1);
  }
  if (config.mcpServers[args[4]]) process.exit(1);
  config.mcpServers[args[4]] = JSON.parse(args[5]);
} else {
  process.exit(2);
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
`;

async function selfTestClaudeSync(fixture) {
  const fake = path.join(fixture, "fake-claude.cjs");
  await writeFile(fake, FAKE_CLAUDE, "utf8");
  const claude = { command: process.execPath, args: [fake] };
  const claudeConfigPath = path.join(fixture, ".claude.json");
  const logPath = path.join(fixture, "fake-claude.log");
  const codexConfig = path.join(fixture, "claude-sync-config.toml");
  const newServer = path.join(fixture, "server-daily-new", "server.js");
  const codexEnv = { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "1".repeat(64), CODEX_OPENCODE_LOG_LEVEL: "warn" };
  await writeCodexConfig(codexConfig, { serverPath: newServer, env: codexEnv });
  const oldEntry = { type: "stdio", command: process.execPath, args: [path.join(fixture, "server-daily-old", "server.js")], env: { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "2".repeat(64) } };
  const writeClaudeConfig = async (entry) => {
    await writeFile(claudeConfigPath, JSON.stringify({ numStartups: 3, mcpServers: entry ? { other: { type: "stdio", command: "x" }, opencode: entry } : {} }, null, 2), "utf8");
  };
  const readEntry = async () => JSON.parse(await readFile(claudeConfigPath, "utf8")).mcpServers.opencode;
  const calls = async () => (existsSync(logPath) ? (await readFile(logPath, "utf8")).split("\n").filter(Boolean).length : 0);
  const env = (extra = {}) => ({ ...process.env, FAKE_CLAUDE_CONFIG: claudeConfigPath, FAKE_CLAUDE_LOG: logPath, ...extra });

  await writeClaudeConfig(oldEntry);
  const updated = await syncClaudeCodeEntry(codexConfig, { claude, claudeConfigPath, env: env() });
  assert.deepEqual([updated.ok, updated.updated], [true, true], updated.message);
  assert.deepEqual(await readEntry(), { type: "stdio", command: process.execPath, args: [newServer], env: codexEnv });

  const callsBefore = await calls();
  const identical = await syncClaudeCodeEntry(codexConfig, { claude, claudeConfigPath, env: env() });
  assert.deepEqual([identical.ok, identical.updated], [true, false], identical.message);
  assert.equal(await calls(), callsBefore, "an identical entry is neither removed nor re-added");

  await writeClaudeConfig(oldEntry);
  const failedAdd = await syncClaudeCodeEntry(codexConfig, { claude, claudeConfigPath, env: env({ FAKE_CLAUDE_FAIL_ADD: "server-daily-new" }) });
  assert.equal(failedAdd.ok, false);
  assert.match(failedAdd.message, /previous entry was restored/);
  assert.deepEqual(await readEntry(), oldEntry, "a failed add restores the previous entry instead of leaving none");

  await writeClaudeConfig(null);
  const missingEntry = await syncClaudeCodeEntry(codexConfig, { claude, claudeConfigPath, env: env() });
  assert.equal(missingEntry.ok, false);
  assert.match(missingEntry.message, /no user-scope "opencode" MCP entry/);
  const noClaude = await syncClaudeCodeEntry(codexConfig, { claude: null, claudeConfigPath, env: env() });
  assert.equal(noClaude.ok, false);

  const home = path.join(fixture, "claude-home");
  if (process.platform === "win32") {
    const native = path.join(home, ".local", "bin", "claude.exe");
    assert.deepEqual(claudeCodeCommand({ platform: "win32", env: {}, home, exists: (file) => file === native, onPath: () => [] }), { command: native, args: [], probe: native });
    const prefix = path.join(fixture, "npm-prefix");
    const cli = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const viaShim = claudeCodeCommand({ platform: "win32", env: {}, home, exists: (file) => file === cli, onPath: () => [path.join(prefix, "claude.cmd")] });
    assert.deepEqual(viaShim, { command: process.execPath, args: [cli], probe: cli }, "a claude.cmd shim resolves to its package without a shell");
    const exeOnPath = path.join(fixture, "tools", "claude.exe");
    assert.equal(claudeCodeCommand({ platform: "win32", env: {}, home, exists: (file) => file === exeOnPath, onPath: () => [exeOnPath] }).command, exeOnPath);
  } else {
    const local = path.join(home, ".local", "bin", "claude");
    assert.equal(claudeCodeCommand({ platform: process.platform, env: {}, home, exists: (file) => file === local, onPath: () => [] }).command, local);
  }
  assert.equal(claudeCodeCommand({ platform: process.platform, env: {}, home, exists: () => false, onPath: () => [] }), null);
}

async function selfTest() {
  selfTestRewrite();
  const fixture = await mkdtemp(path.join(tmpdir(), "release-activate-self-test-"));
  try {
    await selfTestReleasesRoot(fixture);
    await selfTestRepin(fixture);
    await selfTestRestoreAndCleanup(fixture);
    await selfTestCleanTree(fixture);
    await selfTestClaudeSync(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  process.stdout.write("release-activate self-test passed\n");
  selfTestPassed("release-activate");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
    return;
  }
  const activeEntry = await loadMcpEntry(options.configPath, SERVER_NAME);
  const activeServer = path.resolve(activeEntry.args[0] || "");
  const activeRelease = path.dirname(activeServer);
  const activeIsRelease = isReleaseDirectory(activeRelease);
  const { root: releasesRoot, source: releasesRootSource } = resolveReleasesRoot({
    explicitRoot: options.releasesRoot,
    activeRelease,
    entryEnv: activeEntry.env,
  });
  process.stdout.write(`Active ${activeIsRelease ? "release" : "working tree (not an immutable release)"}: ${activeRelease}\n`);
  process.stdout.write(`Releases root: ${releasesRoot} (${releasesRootSource})\n`);

  if (options.inspect) {
    step("Inspect only: nothing is built or changed");
    await housekeeping({ releasesRoot, keepReleases: [activeRelease], configPath: options.configPath, prune: false });
    return;
  }

  if (options.syncClients) {
    step("Sync only: re-pinning integrity hashes and re-registering the active entry with other MCP clients");
    process.stdout.write(`${await refreshIntegrityPins(options.configPath, activeEntry)}\n`);
    process.stdout.write(`${clientToolTimeoutWarning(await readFile(options.configPath, "utf8"), activeEntry.env)}\n`);
    const claude = await syncClaudeCodeForOptions(options);
    process.stdout.write(`${claude.message}\n`);
    if (!claude.ok) process.exitCode = 1;
    return;
  }

  step("Checking the source tree");
  // --check-only never activates, so a dirty tree is only reported there.
  const treeWarnings = assertCleanSourceTree(SOURCE_ROOT, options.allowDirty || options.checkOnly);
  process.stdout.write(`${treeWarnings.length ? treeWarnings.join("\n") : "Source tree is clean."}\n`);

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

  const candidateDir = await mkdtemp(path.join(tmpdir(), "release-activate-"));
  const candidateConfig = path.join(candidateDir, "config.toml");
  let activated = false;
  let liveConfigWritten = false;
  try {
    const pluginManifestSha256 = await pluginManifestSha256For(activeEntry);
    const originalConfig = await readFile(options.configPath, "utf8");
    const { text: candidateText, pluginManifestPinned } = rewriteConfig(originalConfig, { serverPath, serverSha256, pluginManifestSha256 });
    if (pluginManifestPinned) process.stdout.write(`plugin manifest SHA-256: ${pluginManifestSha256}\n`);
    assertRewritePreservesConfig(originalConfig, candidateText);
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
    liveConfigWritten = true;
    process.stdout.write(`Config backup: ${backupPath}\n`);

    step("Verifying the live config");
    const smoke = runHealthSmoke(options.configPath);
    process.stdout.write(`${smoke.output}\n`);
    if (!smoke.ok) {
      try {
        await restoreConfigFrom(options.configPath, backupPath, stamp);
      } catch (error) {
        throw new Error(`Post-activation health failed AND restoring ${options.configPath} from ${backupPath} failed (${error?.code || error?.message || error}). The live config still points at ${destination}, which is kept; copy the backup over the config by hand.`);
      }
      throw new Error(`Post-activation health failed; the previous config was restored from ${backupPath}.`);
    }
    activated = true;

    step("Updating other MCP clients");
    process.stdout.write(`${clientToolTimeoutWarning(await readFile(options.configPath, "utf8"), activeEntry.env)}\n`);
    const claude = await syncClaudeCodeForOptions(options);
    process.stdout.write(`${claude.message}\n`);
    if (!claude.ok) process.exitCode = 1;

    step("Housekeeping");
    await housekeeping({ releasesRoot, keepReleases: [destination, activeRelease], configPath: options.configPath, prune: options.prune });

    step("Done");
    process.stdout.write(`Active release: ${destination}\nRollback ${activeIsRelease ? "release" : "entry (working tree)"}: ${activeRelease}\nRestart Codex so new sessions start the new bridge.\n`);
  } finally {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    // A candidate that never became the live release is not worth keeping, unless the live
    // config may still reference it. --check-only is the one case where leaving it in place
    // is the point.
    if (!activated && !options.checkOnly) {
      process.stdout.write(`${await cleanupUnactivatedRelease({ configPath: options.configPath, destination, liveConfigWritten })}\n`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\nrelease:activate failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

export {
  assertCleanSourceTree,
  assertRewritePreservesConfig,
  claudeCodeCommand,
  cleanupUnactivatedRelease,
  listReleases,
  repinnableServerSha256,
  resolveReleasesRoot,
  rewriteConfig,
  syncClaudeCodeEntry,
};
