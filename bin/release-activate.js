#!/usr/bin/env node

// One-command release: pass the release gate, build a new immutable release folder, point
// the Codex MCP entry at it with the new server hash, prove a fresh bridge is healthy, and
// roll the config back automatically if the post-activation health check fails.
//
//   npm run release:activate                 full run; runs the release gate (bin/release-gate.js,
//                                            the same as `npm run test:release`) first
//   npm run release:activate -- --check-only build and health-check a candidate, do not activate
//   npm run release:activate -- --skip-tests --gate-receipt <file>
//                                            do not run the gate again; <file> must be the receipt
//                                            of a green `npm run test:release` of exactly this
//                                            source tree, at most 24 h old (--gate-receipt alone
//                                            does the same; --skip-tests alone is refused)
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
// The gate's receipt is stored next to the release folder as <release>.gate-receipt.json, and
// the source tree is digested again after the build: a tree that changed since the gate ran
// is not activated.
//
// Old releases and config backups are only listed unless --prune is passed. Only folders
// named server-* that contain release-manifest.json count as releases. The kept set is
// the new release, the previously active release, every release a running bridge process
// still loads, and the two newest backups. A candidate that fails before it becomes the
// live release is removed again (except with --check-only), but only once a re-read of the
// live config proves it does not point at it.
//
// The release's node_modules is installed fresh from package-lock.json (npm ci --omit=dev
// --ignore-scripts, preferring the npm cache), never copied from the working tree, and the
// source tree is checked again once the release files are staged.
// Claude Code's entry is replaced with remove-then-add. Until the add succeeds, the previous
// entry is kept in <claude config>.opencode-entry-recovery.json, and a run that finds the
// entry missing next to that file restores it first.
// The Codex config is only replaced while it still holds what this run read (and only rolled
// back while it still holds what this run wrote); a concurrent edit is reported, not overwritten.
//
// Exit code 1 whenever something was not done: a failed step, a refused re-pin, or a
// Claude Code entry that was not brought in line with the Codex entry.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildRelease } from "./build-release.js";
import { healthcheckProcessEnvironment, loadMcpEntry, runFreshHealthcheck } from "./fresh-healthcheck.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { RECEIPT_KIND, REQUIRED_STEPS, assertReleaseSourceComplete, readGateReceipt, runReleaseGate, sourceTreeDigest, validateGateReceipt } from "./release-gate.js";
import { recordCliFailure } from "./ops-log.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSelfTestRun(import.meta.url);
const SERVER_NAME = "opencode";
const KEEP_CONFIG_BACKUPS = 2;
const RELEASE_MANIFEST = "release-manifest.json";
// Files a release copies from the source tree (build-release.js LEGACY_PUBLISH_ENTRIES).
const BRIDGE_SOURCE_PATHS = ["server.js", "bin", "opencode", "tests", "package.json", "package-lock.json"];
const RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];
const SKIP_TESTS_NEEDS_RECEIPT = "--skip-tests needs --gate-receipt <file>: the receipt of a green `npm run test:release` of this source tree (written to .release-gate/receipt.json), at most 24 h old. Nothing was built or activated.";

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
    gateReceipt: "",
  };
  const valued = {
    "--config": "configPath",
    "--health-cwd": "healthCwd",
    "--releases-root": "releasesRoot",
    "--claude-config": "claudeConfigPath",
    "--gate-receipt": "gateReceipt",
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
      process.stdout.write("Usage: node bin/release-activate.js [--check-only] [--skip-tests --gate-receipt <receipt.json>] [--prune] [--inspect] [--sync-clients] [--allow-dirty] [--skip-claude-code] [--self-test] [--config <config.toml>] [--releases-root <dir>] [--claude-config <.claude.json>] [--health-cwd <git checkout>]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.skipTests && !options.gateReceipt) throw new Error(SKIP_TESTS_NEEDS_RECEIPT);
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

// G-04: activation needs a green release gate of exactly the tree it builds. By default the
// gate runs here; --skip-tests is accepted only with --gate-receipt naming a green receipt of
// this tree, at most 24 h old (`npm run test:release` writes one).
async function passReleaseGate({ skipTests = false, gateReceipt = "", configPath }, {
  sourceRoot = SOURCE_ROOT,
  runGate = runReleaseGate,
  digest = sourceTreeDigest,
  now = Date.now,
} = {}) {
  if (skipTests && !gateReceipt) throw new Error(SKIP_TESTS_NEEDS_RECEIPT);
  const { receipt, receiptPath } = gateReceipt
    ? { receipt: await readGateReceipt(gateReceipt), receiptPath: gateReceipt }
    : await runGate({ sourceRoot, configPath });
  const { treeSha256 } = await digest(sourceRoot);
  try {
    validateGateReceipt(receipt, { treeSha256, now: now() });
  } catch (error) {
    throw new Error(`${error.message} Nothing was built or activated.`);
  }
  return { receipt, receiptPath, treeSha256 };
}

function gateReceiptPathFor(releaseDirectory) {
  return `${path.resolve(releaseDirectory)}.gate-receipt.json`;
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
  if (!header) return null;
  // Canonicalize simple bare/quoted dotted keys, without interpreting dots
  // inside a quoted key as table separators. Complex keys stay untouched and
  // the document-level validator still refuses an unsafe rewrite.
  const key = header[1].trim();
  if (/^(?:[\w-]+|"[\w-]+"|'[\w-]+')(?:\s*\.\s*(?:[\w-]+|"[\w-]+"|'[\w-]+'))*$/.test(key)) {
    return key.split(/\s*\.\s*/).map((part) => part.replace(/^["']|["']$/g, "")).join(".");
  }
  return key;
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
  // Waiting for a provider slot has its own budget (server.js CONFIG.providerWaitMaxMs) and
  // is no longer taken out of the agent's run timeout, so the client must cover it too.
  CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS: 1000 * 60 * 20,
};
const CLIENT_TIMEOUT_MARGIN_MS = 1000 * 60 * 5;

function clientToolTimeoutSeconds(env = {}) {
  const limit = (key) => Number(env[key]) > 0 ? Number(env[key]) : BRIDGE_TIMEOUT_DEFAULTS_MS[key];
  const longest = Math.max(...Object.keys(BRIDGE_TIMEOUT_DEFAULTS_MS)
    .filter((key) => key.endsWith("AGENT_TIMEOUT_MS") || /_(BUILDER|ORCHESTRATOR|CONTRACTOR)_TIMEOUT_MS$/.test(key))
    .map(limit));
  return Math.ceil((limit("CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS") + longest
    + limit("CODEX_OPENCODE_VALIDATION_TIMEOUT_MS") + CLIENT_TIMEOUT_MARGIN_MS) / 1000);
}

// Setup replaces the whole entry; activation still uses the narrower rewriteConfig.
// Keep the untouched slices verbatim, including CRLFs and tables between the entry
// and its env. Parse both documents with the existing TOML validator before writing.
function rewriteCodexConfig(text, entryText) {
  const spans = [];
  let offset = 0;
  let start = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const header = tomlHeader(line.replace(/\r?\n$/, ""));
    if (header !== null) {
      if (start !== null) spans.push([start, offset]);
      start = /^mcp_servers\.opencode(?:\.|$)/.test(header) ? offset : null;
    }
    offset += line.length;
  }
  if (start !== null) spans.push([start, text.length]);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const replacement = entryText.replace(/\r?\n/g, eol);
  let rewritten = "";
  let cursor = 0;
  for (const [index, [from, to]] of spans.entries()) {
    rewritten += text.slice(cursor, from);
    if (index === 0) rewritten += replacement;
    cursor = to;
  }
  rewritten += text.slice(cursor);
  if (!spans.length) rewritten = text + (text && !text.endsWith("\n") ? eol : "") + replacement;
  const [before, after] = parseTomlDocuments([text, rewritten]);
  delete before.mcp_servers?.opencode;
  const desired = after.mcp_servers?.opencode;
  delete after.mcp_servers?.opencode;
  // A fresh MCP parent is the only permitted addition outside the entry.
  if (!before.mcp_servers && after.mcp_servers && !Object.keys(after.mcp_servers).length) delete after.mcp_servers;
  if (!isDeepStrictEqual(before, after)) throw new Error("Setup would change TOML outside the opencode tables; nothing was written.");
  return { text: rewritten, entry: desired, existed: spans.length > 0 };
}

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
  const neededSec = Math.ceil((limit("CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS") + longestAgentMs + limit("CODEX_OPENCODE_VALIDATION_TIMEOUT_MS") + CLIENT_TIMEOUT_MARGIN_MS) / 1000);
  if (toolTimeoutSec === null) {
    return `WARNING: [mcp_servers.${SERVER_NAME}] has no tool_timeout_sec; Codex defaults to 60 s. Set tool_timeout_sec = ${neededSec}.0`;
  }
  if (toolTimeoutSec < neededSec) {
    return `WARNING: tool_timeout_sec = ${toolTimeoutSec} is shorter than the longest bridge job (provider-slot wait + agent + validation + margin = ${neededSec} s). Codex would abandon long jobs while they still run. Set tool_timeout_sec = ${neededSec}.0`;
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

// The config is replaced by renaming a staged copy over it. Both the activation and the
// rollback re-read the live file immediately before the rename and refuse when it is not
// what this run last read or wrote, so an edit made in between (an editor, Codex itself,
// another release run) is reported instead of silently overwritten. The remaining gap is
// the instant between that read and the rename.
async function assertLiveConfigIs(configPath, expected, when) {
  let live;
  try {
    live = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`The live config could not be re-read ${when} (${error?.code || error?.message || error}); refusing to overwrite it.`);
  }
  if (live !== expected) throw new Error(`The live config changed ${when}; refusing to overwrite a concurrent edit.`);
}

async function replaceConfigAtomically(configPath, text, stamp, expected) {
  const stagedPath = `${configPath}.activating-${stamp}`;
  try {
    await writeFile(stagedPath, text, { encoding: "utf8", mode: 0o600 });
    await assertLiveConfigIs(configPath, expected, "since this run read it");
    await renameWithRetry(stagedPath, configPath);
  } finally {
    await rm(stagedPath, { force: true }).catch(() => {});
  }
}

// expected: the text this run wrote, i.e. what the live config must still hold to be rolled back.
async function restoreConfigFrom(configPath, backupPath, stamp, expected, renameOptions = {}) {
  const stagedPath = `${configPath}.restoring-${stamp}`;
  try {
    await copyFile(backupPath, stagedPath);
    await assertLiveConfigIs(configPath, expected, "after this run wrote it");
    await renameWithRetry(stagedPath, configPath, renameOptions);
  } finally {
    await rm(stagedPath, { force: true }).catch(() => {});
  }
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
  await replaceConfigAtomically(configPath, text, stamp, original);
  const health = smoke(configPath);
  if (!health.ok) {
    try {
      await restoreConfigFrom(configPath, backupPath, stamp, text);
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

// R-163: the clean-tree check runs again once the release files are staged, so the published
// files are the ones checked (npm test or an editor may have changed the tree since the first
// check) and a tree that became dirty fails before anything is published. node_modules is
// git-ignored, so no status check can vouch for it: the release installs it fresh from
// package-lock.json instead of copying the working tree's.
async function buildCheckedRelease({ destination, sourceRoot = SOURCE_ROOT, allowDirty = false, ...buildOptions }) {
  // The re-check and the fresh install come last so no caller option can switch them off.
  return buildRelease({
    ...buildOptions,
    sourceRoot,
    destination,
    installDependencies: true,
    afterStagingHook: async () => { assertCleanSourceTree(sourceRoot, allowDirty); },
  });
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

function rewriteClaudeConfig(text, entry) {
  const document = text === null ? {} : JSON.parse(text);
  if (!document || typeof document !== "object" || Array.isArray(document)
    || (document.mcpServers && (typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers)))) {
    throw new Error("Claude user config must be a JSON object with an object mcpServers.");
  }
  const desired = claudeEntryFor(entry);
  if (sameClaudeEntry(document.mcpServers?.[SERVER_NAME], desired)) return text;
  document.mcpServers = { ...document.mcpServers, [SERVER_NAME]: desired };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function sameClaudeEntry(left, right) {
  return (left?.type || "stdio") === (right?.type || "stdio")
    && left?.command === right?.command
    && isDeepStrictEqual(left?.args || [], right?.args || [])
    && isDeepStrictEqual({ ...(left?.env || {}) }, { ...(right?.env || {}) });
}

// { ok, updated, message }. ok is false for every outcome that leaves Claude Code out of
// line with the Codex entry; an entry that already matches is left alone (ok, not updated).
// `claude mcp add-json` refuses a name that exists, so the replacement is remove-then-add.
// Between the two calls Claude Code has no entry, and a crash there used to leave it that way
// (the next run then refused to proceed for lack of an entry). The previous entry is therefore
// written to a recovery file before the remove and deleted only once an entry exists again; a
// run that finds the entry missing next to a recovery file re-adds it before anything else.
// The file is meaningful only while the entry is missing, so a run that finds the entry
// present deletes it.
async function readSavedClaudeEntry(recoveryPath) {
  try {
    const saved = JSON.parse(await readFile(recoveryPath, "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

async function syncClaudeCodeEntry(configPath, {
  claude = claudeCodeCommand(),
  claudeConfigPath = defaultClaudeConfigPath(),
  env = process.env,
  // Setup accepts an arbitrary user config filename. The CLI only routes to
  // CLAUDE_CONFIG_DIR/.claude.json, so use the same entry builder with guarded
  // atomic file registration for that mode, including first-time registration.
  configOnly = false,
  expectedText,
} = {}) {
  const fail = (message) => ({ ok: false, updated: false, message });
  if (configOnly) {
    try {
      const original = await readFile(claudeConfigPath, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (expectedText !== undefined && original !== expectedText) throw new Error("Claude config changed since setup read it; refusing a concurrent edit.");
      const text = rewriteClaudeConfig(original, await loadMcpEntry(configPath, SERVER_NAME));
      if (text === original) return { ok: true, updated: false, message: "Claude Code entry already matches; nothing to update." };
      await mkdir(path.dirname(claudeConfigPath), { recursive: true });
      const stamp = `${timestamp()}-${process.pid}`;
      if (original !== null) {
        await writeFile(`${claudeConfigPath}.setup-backup-${stamp}`, original, { flag: "wx", mode: 0o600 });
        await replaceConfigAtomically(claudeConfigPath, text, stamp, original);
      } else {
        await writeFile(claudeConfigPath, text, { flag: "wx", mode: 0o600 });
      }
      return { ok: true, updated: true, message: `Claude Code entry registered in ${claudeConfigPath}.` };
    } catch (error) { return fail(error.message); }
  }
  if (!claude) {
    return fail("Claude Code executable not found (probed ~/.local/bin, npm prefixes and PATH); its MCP entry was NOT updated. Pass --skip-claude-code if Claude Code does not use this bridge.");
  }
  let current = await readClaudeUserEntry(claudeConfigPath);
  if (!current.ok) return fail(`Could not read ${claudeConfigPath}: ${current.error}; the Claude Code entry was NOT updated.`);
  const recoveryPath = `${claudeConfigPath}.${SERVER_NAME}-entry-recovery.json`;
  const run = (args) => spawnSync(claude.command, [...claude.args, ...args], { encoding: "utf8", windowsHide: true, env });
  const output = (result) => String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim();
  const addEntry = (entry) => run(["mcp", "add-json", "-s", "user", SERVER_NAME, JSON.stringify(entry)]);
  let recovered = "";
  if (!current.entry) {
    const saved = await readSavedClaudeEntry(recoveryPath);
    if (!saved) {
      return fail(`${claudeConfigPath} has no user-scope "${SERVER_NAME}" MCP entry; nothing was updated. Register it once with claude mcp add-json -s user ${SERVER_NAME} '<json>', or pass --skip-claude-code.`);
    }
    const restored = addEntry(saved);
    if (restored.status !== 0) {
      return fail(`Claude Code has no "${SERVER_NAME}" entry (an earlier update was interrupted) and re-adding the saved one failed (${output(restored)}); saved entry: ${recoveryPath}.`);
    }
    current = await readClaudeUserEntry(claudeConfigPath);
    if (!current.ok || !current.entry || !sameClaudeEntry(current.entry, saved)) {
      return fail(`Re-adding the saved Claude Code entry did not restore it in ${claudeConfigPath}; saved entry: ${recoveryPath}.`);
    }
    recovered = " (an interrupted earlier update had left it missing; the saved entry was restored first)";
  }
  await rm(recoveryPath, { force: true });
  const desired = claudeEntryFor(await loadMcpEntry(configPath, SERVER_NAME));
  if (sameClaudeEntry(current.entry, desired)) {
    return { ok: true, updated: false, message: `Claude Code entry already matches the Codex entry (${desired.args[0]}); nothing to update${recovered}.` };
  }
  try {
    const staged = `${recoveryPath}.staging-${process.pid}`;
    await writeFile(staged, `${JSON.stringify(current.entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(staged, recoveryPath);
  } catch (error) {
    return fail(`Could not save a recovery copy of the Claude Code entry (${error?.message || error}); the entry was NOT changed.`);
  }
  const removed = run(["mcp", "remove", "-s", "user", SERVER_NAME]);
  if (removed.status !== 0) {
    if ((await readClaudeUserEntry(claudeConfigPath)).entry) {
      await rm(recoveryPath, { force: true });
      return fail(`Could not replace the Claude Code entry (remove failed: ${output(removed)}); the previous entry is unchanged.`);
    }
    return fail(`Could not replace the Claude Code entry (remove failed: ${output(removed)}) and it is now missing; re-run this command to restore it from ${recoveryPath}.`);
  }
  const added = addEntry(desired);
  if (added.status !== 0) {
    const restored = addEntry(current.entry);
    if (restored.status === 0) {
      await rm(recoveryPath, { force: true });
      return fail(`Re-adding the Claude Code entry failed (${output(added)}); the previous entry was restored, so Claude Code still runs ${current.entry.args?.[0] || "its old server"}.`);
    }
    return fail(`Re-adding the Claude Code entry failed (${output(added)}) and restoring the previous one failed too (${output(restored)}). Claude Code now has NO ${SERVER_NAME} entry; re-run this command to restore it from ${recoveryPath}.`);
  }
  const after = await readClaudeUserEntry(claudeConfigPath);
  if (after.entry) await rm(recoveryPath, { force: true });
  if (!after.ok || !after.entry || !sameClaudeEntry(after.entry, desired)) {
    return fail(`claude mcp add-json reported success, but ${claudeConfigPath} does not hold the new entry; check it with claude mcp get ${SERVER_NAME}.`);
  }
  return { ok: true, updated: true, message: `Claude Code entry updated to ${desired.args[0]}${recovered}` };
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
  for (const item of staleReleases) {
    await rm(item.full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(gateReceiptPathFor(item.full), { force: true });
  }
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
  // 20 min provider-slot wait + 45 min builder + 15 min validation + 5 min margin = 5100 s.
  assert.match(clientToolTimeoutWarning(withTimeout("3900.0"), raised), /^WARNING: .*provider-slot wait.*5100/, "the slot wait is no longer part of the agent timeout, so the client must cover it");
  assert.match(clientToolTimeoutWarning(withTimeout("5100.0"), raised), /^Client tool timeout covers/);
  assert.match(clientToolTimeoutWarning(withTimeout("3000.0"), {}), /^Client tool timeout covers/, "defaults (wait 20 + contractor 20 + 5 + 5 min) fit in 3000 s");
  assert.match(clientToolTimeoutWarning(withTimeout("1800.0"), {}), /^WARNING: .*3000/, "The contractor timeout and the slot wait count too.");
  assert.match(clientToolTimeoutWarning(withTimeout("1801.0"), { CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS: "1000" }), /^Client tool timeout covers/, "a configured slot-wait budget (1 s) replaces the default");
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
  await restoreConfigFrom(configPath, backupPath, "t1", "candidate\n", { renameFile: flakyRename, delays: [1, 1, 1] });
  assert.equal(calls, 3, "EBUSY is retried");
  assert.equal(await readFile(configPath, "utf8"), "previous\n");
  await assert.rejects(
    restoreConfigFrom(configPath, backupPath, "t2", "previous\n", { renameFile: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }, delays: [1, 1] }),
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

// R-160: a config edited between the read and the rename, or between the activation and the
// rollback, is refused instead of overwritten.
async function selfTestConcurrentConfigEdits(fixture) {
  const configPath = path.join(fixture, "concurrent-config.toml");
  const staged = (stamp) => [`${configPath}.activating-${stamp}`, `${configPath}.restoring-${stamp}`];
  await writeFile(configPath, "edited by someone else\n", "utf8");
  await assert.rejects(replaceConfigAtomically(configPath, "new\n", "c1", "what this run read\n"), /changed since this run read it.*concurrent edit/);
  assert.equal(await readFile(configPath, "utf8"), "edited by someone else\n", "an edit made after the read survives");
  assert.deepEqual(staged("c1").filter(existsSync), [], "the refused replace leaves no staged file");
  await replaceConfigAtomically(configPath, "new\n", "c2", "edited by someone else\n");
  assert.equal(await readFile(configPath, "utf8"), "new\n");
  assert.deepEqual(staged("c2").filter(existsSync), []);

  const backupPath = `${configPath}.rollback-c3`;
  await writeFile(backupPath, "previous\n", "utf8");
  await writeFile(configPath, "edited after activation\n", "utf8");
  await assert.rejects(restoreConfigFrom(configPath, backupPath, "c3", "the activated text\n"), /changed after this run wrote it.*concurrent edit/);
  assert.equal(await readFile(configPath, "utf8"), "edited after activation\n", "a rollback never clobbers a later edit");
  assert.equal(await readFile(backupPath, "utf8"), "previous\n");
  assert.deepEqual(staged("c3").filter(existsSync), []);
  await rm(configPath);
  await assert.rejects(restoreConfigFrom(configPath, backupPath, "c4", "the activated text\n"), /could not be re-read after this run wrote it/);
  assert.equal(existsSync(configPath), false);

  // End to end through --sync-clients' re-pin: the health check fails while someone edits the
  // live config. The rollback must keep that edit; without an edit it restores the backup.
  const workingTree = path.join(fixture, "concurrent-working-tree");
  await mkdir(workingTree, { recursive: true });
  const serverPath = path.join(workingTree, "server.js");
  await writeFile(serverPath, "moving\n", "utf8");
  const pinConfig = path.join(fixture, "concurrent-pin.toml");
  await writeCodexConfig(pinConfig, { serverPath, env: { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64) } });
  const original = await readFile(pinConfig, "utf8");
  const entry = await loadMcpEntry(pinConfig, SERVER_NAME);
  await assert.rejects(
    refreshIntegrityPins(pinConfig, entry, { smoke: () => ({ ok: false, output: "health failed" }) }),
    /previous config was restored/,
  );
  assert.equal(await readFile(pinConfig, "utf8"), original, "without a concurrent edit the failed re-pin is rolled back");
  const concurrentEdit = `${original}# added while the health check ran\n`;
  await assert.rejects(
    refreshIntegrityPins(pinConfig, entry, { smoke: (live) => { writeFileSync(live, concurrentEdit, "utf8"); return { ok: false, output: "health failed" }; } }),
    /restoring the previous config failed.*changed after this run wrote it/s,
  );
  assert.equal(await readFile(pinConfig, "utf8"), concurrentEdit, "the concurrent edit is kept");
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

// R-163 end to end on a committed fixture repo whose node_modules is git-ignored and edited.
async function selfTestCheckedBuild(fixture) {
  const repo = path.join(fixture, "checked-repo");
  const releases = path.join(fixture, "checked-releases");
  const write = async (relative, content) => {
    const file = path.join(repo, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return file;
  };
  await write("server.js", "committed\n");
  await write("package.json", "{}\n");
  await write("package-lock.json", "{}\n");
  await write("bin/tool.js", "committed\n");
  await write("opencode/agents/a.md", "agent\n");
  await write("opencode/skills/s/SKILL.md", "skill\n");
  await write("opencode/.gitignore", "log/\n");
  const configFile = await write("opencode/opencode.jsonc", "{}\n");
  const settingFile = await write("opencode/antigravity.json", "{}\n");
  await write("opencode/plugin-integrity-manifest.json", `${JSON.stringify({
    version: 1,
    plugins: [],
    configs: [{ path: configFile, sha256: await sha256File(configFile), scope: "global", plugins: [] }],
    settings: [{ path: settingFile, sha256: await sha256File(settingFile), requiredValues: {} }],
  })}\n`);
  await write(".gitignore", "node_modules/\n");
  await write("node_modules/dep/index.js", "edited by hand, invisible to git\n");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, "-c", "user.name=release", "-c", "user.email=release@example.com", ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  const publishEntries = ["server.js", "package.json", "package-lock.json", "bin", "opencode/agents", "opencode/skills", "opencode/.gitignore", "opencode/plugin-integrity-manifest.json", "node_modules"];
  const installFromLockfile = async (staging) => {
    assert.equal(existsSync(path.join(staging, "node_modules")), false, "the working tree's node_modules is not copied into the release");
    await mkdir(path.join(staging, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(staging, "node_modules", "dep", "index.js"), "installed from the lockfile\n", "utf8");
  };

  const clean = path.join(releases, "clean");
  await buildCheckedRelease({ destination: clean, sourceRoot: repo, publishEntries, dependencyInstaller: installFromLockfile });
  assert.equal(await readFile(path.join(clean, "node_modules", "dep", "index.js"), "utf8"), "installed from the lockfile\n", "the hand-edited, git-ignored node_modules is not published");

  // The tree becomes dirty after the first check (npm test wrote a file, an editor saved one):
  // nothing is published and no staging folder is left behind.
  const dirtied = path.join(releases, "dirtied");
  await assert.rejects(
    buildCheckedRelease({
      destination: dirtied,
      sourceRoot: repo,
      publishEntries,
      dependencyInstaller: async (staging) => {
        await installFromLockfile(staging);
        await writeFile(path.join(repo, "bin", "tool.js"), "edited while the release was building\n", "utf8");
      },
    }),
    /1 uncommitted bridge file.*bin\/tool\.js/s,
  );
  assert.equal(existsSync(dirtied), false);
  assert.deepEqual((await readdir(releases)).filter((name) => name.includes(".staging-")), []);
  // --allow-dirty (and --check-only) still build from a dirty tree.
  const allowed = path.join(releases, "allowed");
  await buildCheckedRelease({ destination: allowed, sourceRoot: repo, allowDirty: true, publishEntries, dependencyInstaller: installFromLockfile });
  assert.equal(await readFile(path.join(allowed, "bin", "tool.js"), "utf8"), "edited while the release was building\n");
}

const FAKE_CLAUDE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const configPath = process.env.FAKE_CLAUDE_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.mcpServers = config.mcpServers || {};
if (args[0] === "mcp" && args[1] === "remove" && args[2] === "-s" && args[3] === "user") {
  if (process.env.FAKE_CLAUDE_FAIL_REMOVE) {
    process.stderr.write("simulated remove failure\\n");
    process.exit(1);
  }
  if (!config.mcpServers[args[4]]) process.exit(1);
  delete config.mcpServers[args[4]];
} else if (args[0] === "mcp" && args[1] === "add-json" && args[2] === "-s" && args[3] === "user") {
  if (process.env.FAKE_CLAUDE_FAIL_ADD && args[5].includes(process.env.FAKE_CLAUDE_FAIL_ADD)) {
    process.stderr.write("simulated add failure\\n");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_KILL_PARENT_ON_ADD) {
    // A crash between the remove and the add: the calling process dies with no chance to restore.
    process.kill(process.ppid, "SIGKILL");
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

  // R-159: `claude mcp add-json` refuses an existing name, so replacing the entry is remove
  // then add. A crash in between left Claude Code with no entry, and the next run refused to
  // proceed ("register it once ..."). The previous entry is now saved first and the next run
  // restores it.
  const desiredEntry = { type: "stdio", command: process.execPath, args: [newServer], env: codexEnv };
  const sync = (extra) => syncClaudeCodeEntry(codexConfig, { claude, claudeConfigPath, env: env(extra) });
  const recoveryPath = `${claudeConfigPath}.opencode-entry-recovery.json`;
  await writeClaudeConfig(oldEntry);
  assert.equal((await sync()).updated, true);
  assert.equal(existsSync(recoveryPath), false, "a completed replacement leaves no recovery file");

  await writeClaudeConfig(oldEntry);
  const crashScript = [
    `import { syncClaudeCodeEntry } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};`,
    `await syncClaudeCodeEntry(${JSON.stringify(codexConfig)}, { claude: ${JSON.stringify(claude)}, claudeConfigPath: ${JSON.stringify(claudeConfigPath)}, env: process.env });`,
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], { encoding: "utf8", windowsHide: true, env: env({ FAKE_CLAUDE_KILL_PARENT_ON_ADD: "1" }) });
  assert.notEqual(crashed.status, 0, `the simulated crash kills the process between the remove and the add: ${crashed.stderr}`);
  assert.equal(await readEntry(), undefined, "the crash left Claude Code without an entry");
  assert.deepEqual(JSON.parse(await readFile(recoveryPath, "utf8")), oldEntry, "the previous entry was saved before the remove");
  const afterCrash = await sync();
  assert.deepEqual([afterCrash.ok, afterCrash.updated], [true, true], afterCrash.message);
  assert.match(afterCrash.message, /interrupted earlier update/);
  assert.deepEqual(await readEntry(), desiredEntry, "the next run restores the entry and brings it up to date");
  assert.equal(existsSync(recoveryPath), false);

  // The add and the restore both fail: no entry, but the recovery file survives and a later
  // run (first still failing, then working) restores it.
  await writeClaudeConfig(oldEntry);
  const bothFail = await sync({ FAKE_CLAUDE_FAIL_ADD: "server.js" });
  assert.equal(bothFail.ok, false);
  assert.match(bothFail.message, /NO opencode entry.*re-run this command/s);
  assert.equal(await readEntry(), undefined);
  const stillBroken = await sync({ FAKE_CLAUDE_FAIL_ADD: "server.js" });
  assert.equal(stillBroken.ok, false);
  assert.match(stillBroken.message, /earlier update was interrupted/);
  assert.equal(existsSync(recoveryPath), true);
  const healed = await sync();
  assert.deepEqual([healed.ok, healed.updated], [true, true], healed.message);
  assert.deepEqual(await readEntry(), desiredEntry);

  // A remove that fails leaves the entry alone and no recovery file behind.
  await writeClaudeConfig(oldEntry);
  const removeFails = await sync({ FAKE_CLAUDE_FAIL_REMOVE: "1" });
  assert.equal(removeFails.ok, false);
  assert.match(removeFails.message, /previous entry is unchanged/);
  assert.deepEqual(await readEntry(), oldEntry);
  assert.equal(existsSync(recoveryPath), false);

  // A recovery file is only meaningful while the entry is missing: next to a present entry it is
  // deleted, so it can never resurrect an old entry someone removed on purpose.
  await writeClaudeConfig(desiredEntry);
  await writeFile(recoveryPath, `${JSON.stringify(oldEntry)}\n`, "utf8");
  assert.equal((await sync()).updated, false);
  assert.equal(existsSync(recoveryPath), false);
  await writeClaudeConfig(null);
  assert.match((await sync()).message, /no user-scope "opencode" MCP entry/);
  assert.equal(await readEntry(), undefined);

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

// G-04: activation runs the release gate unless a green receipt of this exact tree is given.
async function selfTestReleaseGate(fixture) {
  const treeSha256 = "a".repeat(64);
  const finishedAt = new Date().toISOString();
  const green = {
    kind: RECEIPT_KIND,
    version: 1,
    ok: true,
    sourceTree: { treeSha256 },
    finishedAt,
    steps: REQUIRED_STEPS.map((name) => ({ name, exitCode: 0 })),
    skips: [],
  };
  const digest = async () => ({ treeSha256 });
  let gateRuns = 0;
  const runGate = async () => { gateRuns += 1; return { receipt: green, receiptPath: "(gate run)" }; };
  const writeReceipt = async (name, receipt) => {
    const file = path.join(fixture, name);
    await writeFile(file, JSON.stringify(receipt), "utf8");
    return file;
  };
  const gate = (options, deps = {}) => passReleaseGate({ configPath: "unused", ...options }, { runGate, digest, ...deps });

  // --skip-tests with no receipt is refused before anything runs, already by the argument parser.
  assert.throws(() => parseArguments(["--skip-tests"]), /--skip-tests needs --gate-receipt <file>/);
  assert.equal(parseArguments(["--skip-tests", "--gate-receipt", "receipt.json"]).gateReceipt, path.resolve("receipt.json"));
  await assert.rejects(gate({ skipTests: true }), /--skip-tests needs --gate-receipt <file>.*Nothing was built or activated/s);
  assert.equal(gateRuns, 0);

  // A receipt of another tree, an old one, a failed one: refused, and the gate is not run.
  const otherTree = await writeReceipt("other-tree.json", { ...green, sourceTree: { treeSha256: "b".repeat(64) } });
  await assert.rejects(gate({ skipTests: true, gateReceipt: otherTree }), /another source tree \(receipt bbbbbbbbbbbb, candidate aaaaaaaaaaaa\).*Nothing was built/s);
  const old = await writeReceipt("old.json", { ...green, finishedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
  await assert.rejects(gate({ skipTests: true, gateReceipt: old }), /25 h old \(limit 24 h\)/);
  const failed = await writeReceipt("failed.json", { ...green, ok: false, failure: "test:concurrency failed (exit 1)." });
  await assert.rejects(gate({ gateReceipt: failed }), /failed run: test:concurrency failed/);
  await assert.rejects(gate({ skipTests: true, gateReceipt: path.join(fixture, "no-such-receipt.json") }), /Cannot read the gate receipt/);
  assert.equal(gateRuns, 0);

  // A green receipt of this tree is accepted without running the gate (with or without --skip-tests).
  const good = await writeReceipt("good.json", green);
  assert.equal((await gate({ skipTests: true, gateReceipt: good })).treeSha256, treeSha256);
  assert.equal((await gate({ gateReceipt: good })).receiptPath, good);
  assert.equal(gateRuns, 0);

  // By default the gate runs, and its receipt must still be green and match the tree.
  assert.equal((await gate({})).receiptPath, "(gate run)");
  assert.equal(gateRuns, 1);
  await assert.rejects(gate({}, { runGate: async () => ({ receipt: { ...green, ok: false, failure: "npm test failed (exit 1)." }, receiptPath: "x" }) }), /failed run: npm test failed/);
  await assert.rejects(gate({}, { digest: async () => ({ treeSha256: "c".repeat(64) }) }), /another source tree/);

  // --prune removes a stale release's receipt with it.
  const releasesRoot = path.join(fixture, "gate-releases");
  const stale = path.join(releasesRoot, "server-daily-20000101");
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, RELEASE_MANIFEST), "{}\n", "utf8");
  await writeFile(gateReceiptPathFor(stale), "{}\n", "utf8");
  const pruned = await housekeeping({ releasesRoot, keepReleases: [], configPath: path.join(fixture, "gate-config", "config.toml"), prune: true, inUse: { ok: true, releases: new Set() } });
  assert.deepEqual(pruned.removedReleases, [stale]);
  assert.equal(existsSync(gateReceiptPathFor(stale)), false, "a pruned release's gate receipt is removed with it");
}

async function selfTest() {
  selfTestRewrite();
  const fixture = await mkdtemp(path.join(tmpdir(), "release-activate-self-test-"));
  try {
    await selfTestReleasesRoot(fixture);
    await selfTestRepin(fixture);
    await selfTestRestoreAndCleanup(fixture);
    await selfTestConcurrentConfigEdits(fixture);
    await selfTestCleanTree(fixture);
    await selfTestCheckedBuild(fixture);
    await selfTestClaudeSync(fixture);
    await selfTestReleaseGate(fixture);
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
  // A tree the build would refuse (a missing publish entry, a plugin manifest bound to another
  // checkout) fails here, not after the half-hour gate.
  await assertReleaseSourceComplete(SOURCE_ROOT);
  process.stdout.write("Every publish entry is present and the plugin manifest is bound to this tree.\n");

  step(options.gateReceipt
    ? `Checking the release gate receipt ${options.gateReceipt} (the gate is not run again)`
    : "Running the release gate (npm run test:release)");
  const gate = await passReleaseGate(options);
  process.stdout.write(`Release gate passed ${gate.receipt.finishedAt} for source tree ${short(gate.treeSha256)} (receipt ${gate.receiptPath}; ${gate.receipt.skips?.length || 0} skipped).\n`);

  const destination = await nextReleaseDirectory(releasesRoot);
  step(`Building release ${destination}`);
  const built = await buildCheckedRelease({ destination, allowDirty: options.allowDirty || options.checkOnly });
  const serverPath = path.join(destination, "server.js");
  const serverSha256 = await sha256File(serverPath);
  process.stdout.write(`Files: ${built.fileCount}\nserver.js SHA-256: ${serverSha256}\n`);

  const candidateDir = await mkdtemp(path.join(tmpdir(), "release-activate-"));
  const candidateConfig = path.join(candidateDir, "config.toml");
  const receiptCopy = gateReceiptPathFor(destination);
  let activated = false;
  let liveConfigWritten = false;
  try {
    const { treeSha256: builtTree } = await sourceTreeDigest(SOURCE_ROOT);
    if (builtTree !== gate.treeSha256) {
      throw new Error(`The source tree changed after the release gate ran (${short(gate.treeSha256)} -> ${short(builtTree)}); nothing was activated. Run the gate again.`);
    }
    await writeFile(receiptCopy, `${JSON.stringify(gate.receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Gate receipt: ${receiptCopy}\n`);

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
    await replaceConfigAtomically(options.configPath, candidateText, stamp, originalConfig);
    liveConfigWritten = true;
    process.stdout.write(`Config backup: ${backupPath}\n`);

    step("Verifying the live config");
    const smoke = runHealthSmoke(options.configPath);
    process.stdout.write(`${smoke.output}\n`);
    if (!smoke.ok) {
      try {
        await restoreConfigFrom(options.configPath, backupPath, stamp, candidateText);
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
      if (!existsSync(destination)) await rm(receiptCopy, { force: true }).catch(() => {});
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\nrelease:activate failed: ${error?.message || error}\n`);
    recordCliFailure("release-activate", error);
    process.exitCode = 1;
  });
}

export {
  assertCleanSourceTree,
  assertRewritePreservesConfig,
  claudeCodeCommand,
  clientToolTimeoutSeconds,
  defaultClaudeConfigPath,
  cleanupUnactivatedRelease,
  listReleases,
  // B-075: bin/queue-worker.js --env-from claude reads the entry, never writes it.
  readClaudeUserEntry,
  repinnableServerSha256,
  resolveReleasesRoot,
  rewriteConfig,
  rewriteCodexConfig,
  rewriteClaudeConfig,
  renameWithRetry,
  replaceConfigAtomically,
  syncClaudeCodeEntry,
};
